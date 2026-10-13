import { randomBytes } from "node:crypto";
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
  provider: BurstProvider,
  fleet: Fleet,
  cfg: BurstConfig,
  deps: { now?: () => number; probe?: typeof probeBrowser; sleep?: (ms: number) => Promise<void> } = {},
) {
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? probeBrowser;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const servers = new Map<string, Server>();
  let counter = 0;
  let waitingSince: number | null = null;
  let lastFailure = -Infinity;
  let prepared = false;
  let day = "";
  let usedMsToday = 0;
  let budgetWarned = "";
  let lastTick = now();
  let lastReap = -Infinity;
  let creating = 0;
  let ticking = false;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const background = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    background.add(p);
    void p.finally(() => background.delete(p));
  };

  const fmtMin = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

  async function start() {
    const name = `burst-${++counter}`;
    const server: Server = { name, id: null, createdAt: now(), state: "starting" };
    servers.set(name, server);
    const token = randomBytes(24).toString("hex");
    creating++;
    try {
      if (!prepared) {
        await provider.prepare({ tag: cfg.tag, allowedIp: cfg.allowedIp, port: BURST_PORT });
        prepared = true;
      }
      const created = await provider.create({ name: `${cfg.tag}-${counter}`, tag: cfg.tag, userData: burstUserData(token) });
      server.id = created.id;
      // Shut down while the server was being created.
      if (server.state !== "starting") await deleteServer(created.id, name);
    } catch (err) {
      servers.delete(name);
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
    if (server.id) await deleteServer(server.id, server.name);
    servers.delete(server.name);
    const lifetime = now() - server.createdAt;
    const price = await provider.hourlyPrice().catch(() => null);
    log.info(
      `Deleted ${provider.name} server ${server.name} (${reason}) after ${fmtMin(lifetime)}${pages !== undefined ? `, ${pages} pages` : ""}` +
        (price != null ? `, about $${((Math.max(lifetime, MIN_BILLED_MS) / 3_600_000) * price).toFixed(3)}` : ""),
    );
  }

  async function deleteServer(id: string, name: string) {
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
      const known = new Set([...servers.values()].map((s) => s.id));
      for (const s of await provider.list(cfg.tag)) {
        if (known.has(s.id) || creating > 0) continue;
        // An image being built (scripts/burst-image.ts) — unless it's been at it far too long.
        if (s.name.endsWith(IMAGE_BUILD_SUFFIX) && now() - (s.createdAt ?? now()) < IMAGE_BUILD_MAX_MS) continue;
        log.warn(`Deleting leftover ${provider.name} server ${s.name} (${s.id})`);
        await deleteServer(s.id, s.name);
      }
    } catch (err) {
      log.error("Checking for leftover servers failed", errorMessage(err));
    }
  }

  /** Server-hours used today (UTC), counted in memory: running servers add up every tick. */
  function countUsage(t: number) {
    const today = new Date(t).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      usedMsToday = 0;
    }
    usedMsToday += (t - lastTick) * servers.size;
    lastTick = t;
  }

  async function tick() {
    if (ticking || closed) return;
    ticking = true;
    try {
      const t = now();
      countUsage(t);
      const waiting = fleet.waiting();
      waitingSince = waiting >= cfg.minWaiting ? (waitingSince ?? t) : null;

      const budgetLeft = usedMsToday < cfg.maxHoursPerDay * 3_600_000;
      if (waitingSince !== null && t - waitingSince >= cfg.afterMs && servers.size < cfg.maxServers && t - lastFailure >= FAILURE_BACKOFF_MS) {
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
    servers: () => [...servers.values()].map((s) => ({ ...s })),
    usedMsToday: () => usedMsToday,
  };
}
