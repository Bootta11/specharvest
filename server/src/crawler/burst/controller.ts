import { randomBytes } from "node:crypto";
import * as db from "../../db/sqlite.ts";
import { createLogger, errorMessage } from "../../lib/logger.ts";
import type { EntryStats } from "../browser-pool.ts";
import { BURST_PORT, burstUserData, IMAGE_BUILD_MAX_MS, IMAGE_BUILD_SUFFIX, type BurstProvider } from "./provider.ts";

const log = createLogger("burst");

/**
 * Rents extra browser servers while pages queue up, and deletes them once the queue is gone
 * (docs/deployment.md#extra-browser-servers-on-demand). Spending is bounded by the number of servers at once, each
 * server's lifetime and the server-hours per day; servers carrying our tag that we don't track (after a crash or
 * restart) are deleted.
 */

/** What the controller needs from the browser side (crawler/browser.ts browserFleet). */
export interface Fleet {
  waiting(): number;
  get(name: string): EntryStats | null;
  addBurst(name: string, wsEndpoint: string, tabs: number, onLost: () => void): void;
  removeBurst(name: string, timeoutMs: number): Promise<void>;
}

export interface BurstConfig {
  /** Tag (and name prefix) of this instance's servers. */
  tag: string;
  allowedIp: string;
  maxServers: number;
  tabs: number;
  minWaiting: number;
  afterMs: number;
  idleMs: number;
  maxLifetimeMs: number;
  maxHoursPerDay: number;
  enabled?: boolean;
  image?: string;
}

const TICK_MS = 10_000;
const READY_POLL_MS = 3_000;
const READY_TIMEOUT_MS = 4 * 60_000;
const FAILURE_BACKOFF_MS = 10 * 60_000;
const REAP_EVERY_MS = 10 * 60_000;
const DRAIN_TIMEOUT_MS = 2 * 60_000;
/** Per-second billing with a one-minute minimum (DigitalOcean); only used for the cost estimate in the log. */
const MIN_BILLED_MS = 60_000;

interface Server {
  /** Pool name, e.g. burst-1. */
  name: string;
  id: string | null;
  createdAt: number;
  state: "starting" | "up" | "stopping";
  readyAt: number | null;
  historyId: number;
  image: string;
  provider: BurstProvider;
}

/** Reads Chrome's /json/version through the token path; the WebSocket URL to connect to, or null when not up yet. */
export async function probeBrowser(ip: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`http://${ip}:${BURST_PORT}/${token}/json/version`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string };
    const path = webSocketDebuggerUrl && new URL(webSocketDebuggerUrl).pathname;
    return path?.startsWith("/devtools/browser/") ? `ws://${ip}:${BURST_PORT}/${token}${path}` : null;
  } catch {
    return null;
  }
}

export function createBurstController(
  providerOrGetter: BurstProvider | (() => BurstProvider),
  fleet: Fleet,
  cfgOrGetter: BurstConfig | (() => BurstConfig),
  deps: {
    now?: () => number;
    probe?: typeof probeBrowser;
    sleep?: (ms: number) => Promise<void>;
    history?: {
      create(name: string, image: string, startedAt: number): number;
      update(id: number, patch: Parameters<typeof db.updateBurstServer>[1]): void;
      usage(since: number, now: number): { ms: number; costUsd: number };
      open(): db.BurstServerRow[];
    };
  } = {},
) {
  const getProvider = typeof providerOrGetter === "function" ? providerOrGetter : () => providerOrGetter;
  const getConfig = typeof cfgOrGetter === "function" ? cfgOrGetter : () => cfgOrGetter;
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? probeBrowser;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const servers = new Map<string, Server>();
  let counter = 0;
  let waitingSince: number | null = null;
  let lastFailure = -Infinity;
  let preparedFor = "";
  let budgetWarned = "";
  let lastReap = -Infinity;
  let creating = 0;
  let ticking = false;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const memoryRows: Array<db.BurstServerRow> = [];
  const history =
    deps.history ??
    (deps.now
      ? {
          create(name: string, image: string, startedAt: number) {
            const id = memoryRows.length + 1;
            memoryRows.push({ id, name, dropletId: null, image, startedAt, readyAt: null, endedAt: null, endReason: null, pages: 0, costUsd: null });
            return id;
          },
          update(id: number, patch: Parameters<typeof db.updateBurstServer>[1]) {
            Object.assign(memoryRows.find((row) => row.id === id)!, patch);
          },
          usage(since: number, at: number) {
            return {
              ms: memoryRows.reduce((sum, row) => sum + Math.max(0, Math.min(row.endedAt ?? at, at) - Math.max(row.startedAt, since)), 0),
              costUsd: memoryRows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
            };
          },
          open: () => memoryRows.filter((row) => row.endedAt === null),
        }
      : { create: db.createBurstServer, update: db.updateBurstServer, usage: db.burstUsageSince, open: db.listOpenBurstServers });
  const background = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    background.add(p);
    void p.finally(() => background.delete(p));
  };

  const fmtMin = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

  async function start() {
    const cfg = getConfig();
    const provider = getProvider();
    const name = `burst-${++counter}`;
    const image = cfg.image ?? "debian-13-x64";
    const createdAt = now();
    const server: Server = { name, id: null, createdAt, state: "starting", readyAt: null, historyId: history.create(name, image, createdAt), image, provider };
    servers.set(name, server);
    const token = randomBytes(24).toString("hex");
    creating++;
    try {
      const prepareKey = `${provider.name}:${cfg.allowedIp}`;
      if (preparedFor !== prepareKey) {
        await provider.prepare({ tag: cfg.tag, allowedIp: cfg.allowedIp, port: BURST_PORT });
        preparedFor = prepareKey;
      }
      const created = await provider.create({ name: `${cfg.tag}-${counter}`, tag: cfg.tag, userData: burstUserData(token), image });
      server.id = created.id;
      history.update(server.historyId, { dropletId: created.id });
      // Shut down while the server was being created.
      if (server.state !== "starting") await deleteServer(provider, created.id, name);
    } catch (err) {
      servers.delete(name);
      history.update(server.historyId, { endedAt: now(), endReason: "create failed" });
      lastFailure = now();
      log.error(`Couldn't create a ${provider.name} server — trying again in ${FAILURE_BACKOFF_MS / 60_000} min`, errorMessage(err));
      return;
    } finally {
      creating--;
    }
    log.info(`Started ${provider.name} server ${name} (${server.id}): ${fleet.waiting()} pages waiting`);

    const deadline = now() + READY_TIMEOUT_MS;
    while (!closed && server.state === "starting" && now() < deadline) {
      await sleep(READY_POLL_MS);
      try {
        const info = await provider.get(server.id!);
        if (!info) throw new Error("server disappeared");
        const ws = info.ip && info.active ? await probe(info.ip, token) : null;
        if (!ws || server.state !== "starting") continue;
        fleet.addBurst(name, ws, cfg.tabs, () => track(stop(server, "browser disconnected")));
        server.state = "up";
        server.readyAt = now();
        history.update(server.historyId, { readyAt: server.readyAt });
        log.info(`Browser ${name} ready after ${fmtMin(now() - server.createdAt)}, taking ${cfg.tabs} pages`);
        return;
      } catch (err) {
        log.warn(`Waiting for ${name}`, errorMessage(err));
      }
    }
    if (server.state === "starting") {
      lastFailure = now();
      log.error(`Browser ${name} didn't come up within ${fmtMin(READY_TIMEOUT_MS)} — deleting it`);
      await stop(server, "never came up");
    }
  }

  async function stop(server: Server, reason: string) {
    if (server.state === "stopping") return;
    const wasUp = server.state === "up";
    server.state = "stopping";
    const pages = fleet.get(server.name)?.pages;
    if (wasUp) await fleet.removeBurst(server.name, closed ? 0 : DRAIN_TIMEOUT_MS);
    if (server.id) await deleteServer(server.provider, server.id, server.name);
    servers.delete(server.name);
    const lifetime = now() - server.createdAt;
    const price = await server.provider.hourlyPrice().catch(() => null);
    const costUsd = price == null ? undefined : (Math.max(lifetime, MIN_BILLED_MS) / 3_600_000) * price;
    history.update(server.historyId, { endedAt: now(), endReason: reason, pages: pages ?? 0, ...(costUsd === undefined ? {} : { costUsd }) });
    log.info(
      `Deleted ${server.provider.name} server ${server.name} (${reason}) after ${fmtMin(lifetime)}${pages !== undefined ? `, ${pages} pages` : ""}` +
        (price != null ? `, about $${((Math.max(lifetime, MIN_BILLED_MS) / 3_600_000) * price).toFixed(3)}` : ""),
    );
  }

  async function deleteServer(provider: BurstProvider, id: string, name: string) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await provider.delete(id);
        return;
      } catch (err) {
        log.error(`Deleting server ${name} (${id}) failed (attempt ${attempt}/3)`, errorMessage(err));
        if (attempt < 3) await sleep(5_000);
      }
    }
    // The leftover check deletes it later (it keeps the tag).
  }

  /** Deletes tagged servers we don't track: leftovers of a crash or restart. */
  async function reap() {
    if (creating > 0) return;
    lastReap = now();
    try {
      const cfg = getConfig();
      const provider = getProvider();
      const known = new Set([...servers.values()].map((s) => s.id));
      const listed = await provider.list(cfg.tag);
      const listedIds = new Set(listed.map((server) => server.id));
      for (const row of history.open()) {
        if (!servers.has(row.name) && row.dropletId && !listedIds.has(row.dropletId)) history.update(row.id, { endedAt: now(), endReason: "leftover disappeared" });
      }
      for (const s of listed) {
        if (known.has(s.id) || creating > 0) continue;
        // An image being built (scripts/burst-image.ts) — unless it's been at it far too long.
        if (s.name.endsWith(IMAGE_BUILD_SUFFIX) && now() - (s.createdAt ?? now()) < IMAGE_BUILD_MAX_MS) continue;
        log.warn(`Deleting leftover ${provider.name} server ${s.name} (${s.id})`);
        await deleteServer(provider, s.id, s.name);
        const row = history.open().find((candidate) => candidate.dropletId === s.id);
        if (row) history.update(row.id, { endedAt: now(), endReason: "leftover" });
      }
    } catch (err) {
      log.error("Checking for leftover servers failed", errorMessage(err));
    }
  }

  async function tick() {
    if (ticking || closed) return;
    ticking = true;
    try {
      const t = now();
      const cfg = getConfig();
      const day = new Date(t).toISOString().slice(0, 10);
      const since = Date.parse(`${day}T00:00:00.000Z`);
      const usedMsToday = history.usage(since, t).ms;
      const waiting = fleet.waiting();
      waitingSince = waiting >= cfg.minWaiting ? (waitingSince ?? t) : null;

      const budgetLeft = usedMsToday < cfg.maxHoursPerDay * 3_600_000;
      if (cfg.enabled === false) {
        waitingSince = null;
        for (const server of [...servers.values()]) track(stop(server, "switched off"));
      } else if (waitingSince !== null && t - waitingSince >= cfg.afterMs && servers.size < cfg.maxServers && t - lastFailure >= FAILURE_BACKOFF_MS) {
        if (budgetLeft) {
          waitingSince = null;
          track(start());
        } else if (budgetWarned !== day) {
          budgetWarned = day;
          log.warn(`${waiting} pages waiting, but today's ${cfg.maxHoursPerDay} server-hours (BURST_MAX_HOURS_PER_DAY) are used up`);
        }
      }

      for (const server of servers.values()) {
        if (server.state !== "up") continue;
        const stats = fleet.get(server.name);
        const idle = !!stats && stats.idleSince !== null && t - stats.idleSince >= cfg.idleMs && waiting === 0;
        if (idle) track(stop(server, `idle ${fmtMin(t - stats!.idleSince!)}`));
        else if (t - server.createdAt >= cfg.maxLifetimeMs) track(stop(server, "reached BURST_MAX_MINUTES"));
        else if (!budgetLeft) track(stop(server, "BURST_MAX_HOURS_PER_DAY used up"));
      }

      if (t - lastReap >= REAP_EVERY_MS) await reap();
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      const cfg = getConfig();
      const provider = getProvider();
      log.info(
        `On-demand browser servers on ${provider.name}: up to ${cfg.maxServers} × ${cfg.tabs} pages when ≥ ${cfg.minWaiting} pages wait ` +
          `${cfg.afterMs / 1000}s; deleted after ${fmtMin(cfg.idleMs)} idle`,
      );
      timer = setInterval(() => void tick(), TICK_MS);
      timer.unref();
      void tick();
    },
    tick,
    /** Deletes every server (shutdown); no draining, pages still running there fail. */
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await Promise.all([...servers.values()].map((s) => stop(s, "shutting down")));
      await Promise.allSettled([...background]);
    },
    servers: () => [...servers.values()].map(({ provider: _provider, ...server }) => server),
    fleetStats: (name: string) => fleet.get(name),
    usedMsToday: () => {
      const t = now();
      return history.usage(Date.parse(`${new Date(t).toISOString().slice(0, 10)}T00:00:00.000Z`), t).ms;
    },
  };
}
