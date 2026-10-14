import type { BurstBuildStatus } from "@specharvest/shared";
import * as db from "../../db/sqlite.ts";
import { errorMessage } from "../../lib/logger.ts";
import type { DigitalOceanProvider, Snapshot } from "./digitalocean.ts";
import { BURST_PORT, IMAGE_BUILD_MAX_MS, IMAGE_BUILD_SUFFIX, IMAGE_READY_PATH, imageUserData } from "./provider.ts";
import { getBurstImage, saveBurstImage } from "./settings.ts";

const BASE_IMAGE = "debian-13-x64";
const READY_TIMEOUT_MS = 15 * 60_000;
const RETRY_MS = 24 * 60 * 60_000;
const LAST_FAILURE_KEY = "burst_image_last_failure";

export async function buildImage(
  provider: DigitalOceanProvider,
  options: { tag: string; prefix: string; allowedIp: string; keep: number; base?: string; existing?: { id: string; createdAt?: number | null; historyId?: number } },
  onStep: (line: string) => void,
  onDroplet?: (id: string, historyId: number) => void,
): Promise<Snapshot> {
  const startedAt = Date.now();
  const step = (message: string) => onStep(`[${((Date.now() - startedAt) / 60_000).toFixed(1)} min] ${message}`);
  let dropletId = options.existing?.id ?? null;
  const base = options.base ?? BASE_IMAGE;
  const historyId = options.existing?.historyId ?? db.createBurstServer(`${options.tag}${IMAGE_BUILD_SUFFIX}`, base, options.existing?.createdAt ?? startedAt);
  try {
    await provider.prepare({ tag: options.tag, allowedIp: options.allowedIp, port: BURST_PORT });
    if (!dropletId) {
      step("Creating the image-build droplet");
      const droplet = await provider.create({ name: `${options.tag}${IMAGE_BUILD_SUFFIX}`, tag: options.tag, userData: imageUserData(), image: base });
      dropletId = droplet.id;
    } else {
      step("Resuming an image build found after restart");
    }
    db.updateBurstServer(historyId, { dropletId });
    onDroplet?.(dropletId, historyId);

    step("Waiting for updates, Chromium and Caddy");
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`The image-build droplet was not ready within ${READY_TIMEOUT_MS / 60_000} min`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const info = await provider.get(dropletId);
      if (!info) throw new Error("The image-build droplet disappeared");
      if (!info.ip || !info.active) continue;
      const ready = await fetch(`http://${info.ip}:${BURST_PORT}${IMAGE_READY_PATH}`, { signal: AbortSignal.timeout(5_000) })
        .then((response) => response.ok)
        .catch(() => false);
      if (ready) break;
    }

    db.updateBurstServer(historyId, { readyAt: Date.now() });
    step("Set up; powering off");
    await provider.powerOff(dropletId);
    const name = `${options.prefix}${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    step(`Saving snapshot ${name}`);
    const snapshot = await provider.snapshot(dropletId, name);
    step(`Saved ${snapshot.id} (${snapshot.sizeGb} GB)`);
    const ours = (await provider.listSnapshots()).filter((item) => item.name.startsWith(options.prefix)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const old of ours.slice(options.keep)) {
      step(`Deleting old image ${old.name}`);
      await provider.deleteSnapshot(old.id);
    }
    return snapshot;
  } finally {
    if (dropletId) {
      step("Deleting the image-build droplet");
      await provider.delete(dropletId).catch(() => {});
    }
    const endedAt = Date.now();
    const price = await provider.hourlyPrice().catch(() => null);
    const costUsd = price == null ? undefined : (Math.max(60_000, endedAt - (options.existing?.createdAt ?? startedAt)) / 3_600_000) * price;
    db.updateBurstServer(historyId, { endedAt, endReason: "image-build", ...(costUsd === undefined ? {} : { costUsd }) });
  }
}

export function createImageBuilds(getProvider: () => DigitalOceanProvider | null, getConfig: () => { tag: string; prefix: string; allowedIp: string; autoRebuildDays: number }) {
  const state: BurstBuildStatus = { running: false, startedAt: null, steps: [], lastError: null, lastFinishedAt: null };
  let task: Promise<void> | null = null;
  let dropletId: string | null = null;

  const start = (existing?: { id: string; createdAt?: number | null; historyId?: number }) => {
    if (task || !getProvider()) return false;
    const provider = getProvider()!;
    const config = getConfig();
    state.running = true;
    state.startedAt = Date.now();
    state.steps = [];
    state.lastError = null;
    task = buildImage(provider, { ...config, keep: 2, existing }, (line) => state.steps.push(line), (id) => (dropletId = id))
      .then((snapshot) => {
        saveBurstImage({ id: snapshot.id, name: snapshot.name, createdAt: snapshot.createdAt });
        db.deleteSetting(LAST_FAILURE_KEY);
      })
      .catch((error) => {
        state.lastError = errorMessage(error);
        db.setSetting(LAST_FAILURE_KEY, Date.now());
      })
      .finally(() => {
        state.running = false;
        state.lastFinishedAt = Date.now();
        task = null;
        dropletId = null;
      });
    return true;
  };

  return {
    state: () => ({ ...state, steps: [...state.steps] }),
    start,
    async recover() {
      const provider = getProvider();
      if (!provider || task) return;
      const config = getConfig();
      const existing = (await provider.list(config.tag)).find((server) => server.name.endsWith(IMAGE_BUILD_SUFFIX));
      if (!existing) return;
      if (Date.now() - (existing.createdAt ?? Date.now()) >= IMAGE_BUILD_MAX_MS) {
        await provider.delete(existing.id);
        return;
      }
      const row = db.listOpenBurstServers().find((candidate) => candidate.dropletId === existing.id);
      start({ id: existing.id, createdAt: existing.createdAt, historyId: row?.id });
    },
    check() {
      const config = getConfig();
      if (!getProvider() || task || config.autoRebuildDays <= 0) return false;
      const lastFailure = db.getSetting<number>(LAST_FAILURE_KEY) ?? 0;
      if (Date.now() - lastFailure < RETRY_MS) return false;
      const image = getBurstImage();
      if (!image || Date.now() - Date.parse(image.createdAt) >= config.autoRebuildDays * 86_400_000) return start();
      return false;
    },
    async close() {
      if (dropletId) await getProvider()?.delete(dropletId).catch(() => {});
    },
  };
}

