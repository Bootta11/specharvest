import { describe, expect, it, vi } from "vitest";
import type { EntryStats } from "../browser-pool.ts";
import { createBurstController, type BurstConfig, type Fleet } from "./controller.ts";
import type { BurstProvider, BurstServer } from "./provider.ts";

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const cfg: BurstConfig = {
  tag: "test-burst",
  allowedIp: "198.51.100.1",
  maxServers: 1,
  tabs: 6,
  minWaiting: 4,
  afterMs: 60_000,
  idleMs: 5 * 60_000,
  maxLifetimeMs: 180 * 60_000,
  maxHoursPerDay: 12,
};

function world(opts: { readyAfterPolls?: number; failCreate?: boolean } = {}) {
  let clock = Date.UTC(2026, 9, 13, 12);
  const droplets = new Map<string, BurstServer & { polls: number }>();
  let nextId = 100;
  const provider: BurstProvider = {
    name: "fake",
    prepare: vi.fn(async () => {}),
    create: vi.fn(async ({ name }) => {
      if (opts.failCreate) throw new Error("quota exceeded");
      const d = { id: String(nextId++), name, ip: null, active: false, polls: 0 };
      droplets.set(d.id, d);
      return { ...d };
    }),
    get: vi.fn(async (id) => {
      const d = droplets.get(id);
      if (!d) return null;
      d.polls++;
      if (d.polls >= 2) Object.assign(d, { ip: "203.0.113.7", active: true });
      return { ...d };
    }),
    delete: vi.fn(async (id) => void droplets.delete(id)),
    list: vi.fn(async () => [...droplets.values()].map((d) => ({ ...d }))),
    hourlyPrice: vi.fn(async () => 0.07),
  };

  let waiting = 0;
  const pool = new Map<string, EntryStats & { onLost: () => void }>();
  const fleet: Fleet = {
    waiting: () => waiting,
    get: (name) => pool.get(name) ?? null,
    addBurst: vi.fn((name, _ws, tabs, onLost) => {
      pool.set(name, { name, source: "burst", active: 0, tabs, state: "up", idleSince: clock, pages: 0, onLost });
    }),
    removeBurst: vi.fn(async (name) => void pool.delete(name)),
  };

  const readyAfter = opts.readyAfterPolls ?? 1;
  let probes = 0;
  const controller = createBurstController(provider, fleet, cfg, {
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    probe: async (ip, token) => (++probes >= readyAfter ? `ws://${ip}:9223/${token}/devtools/browser/abc` : null),
  });
  return {
    controller,
    provider,
    fleet,
    droplets,
    pool,
    setWaiting: (n: number) => (waiting = n),
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

describe("burst controller", () => {
  it("starts a server only after pages have waited long enough, and adds its browser", async () => {
    const w = world();
    w.setWaiting(5);
    await w.controller.tick();
    w.advance(30_000);
    await w.controller.tick();
    await settle();
    expect(w.provider.create).not.toHaveBeenCalled();

    w.advance(30_000);
    await w.controller.tick();
    await settle();
    expect(w.provider.prepare).toHaveBeenCalledWith({ tag: "test-burst", allowedIp: "198.51.100.1", port: 9223 });
    expect(w.provider.create).toHaveBeenCalledTimes(1);
    const [name, ws, tabs] = vi.mocked(w.fleet.addBurst).mock.calls[0]!;
    expect(name).toBe("burst-1");
    expect(ws).toMatch(/^ws:\/\/203\.0\.113\.7:9223\/[a-f0-9]{48}\/devtools\/browser\/abc$/);
    expect(tabs).toBe(6);
    expect(w.controller.servers()).toMatchObject([{ name: "burst-1", state: "up" }]);

    // Still busy, but the limit is one server.
    w.advance(120_000);
    await w.controller.tick();
    await settle();
    expect(w.provider.create).toHaveBeenCalledTimes(1);
  });

  it("ignores a short queue, and one that empties before the wait is over", async () => {
    const w = world();
    w.setWaiting(3);
    await w.controller.tick();
    w.advance(120_000);
    await w.controller.tick();
    w.setWaiting(10);
    await w.controller.tick();
    w.advance(30_000);
    w.setWaiting(0);
    await w.controller.tick();
    w.advance(60_000);
    await w.controller.tick();
    await settle();
    expect(w.provider.create).not.toHaveBeenCalled();
  });

  it("deletes the server once it has been idle with nothing queued", async () => {
    const w = world();
    w.setWaiting(5);
    await w.controller.tick();
    w.advance(60_000);
    await w.controller.tick();
    await settle();
    w.setWaiting(0);
    const entry = w.pool.get("burst-1")!;
    entry.idleSince = w.now();
    w.advance(4 * 60_000);
    await w.controller.tick();
    await settle();
    expect(w.provider.delete).not.toHaveBeenCalled();

    w.advance(60_000);
    await w.controller.tick();
    await settle();
    expect(w.fleet.removeBurst).toHaveBeenCalledWith("burst-1", 120_000);
    expect(w.provider.delete).toHaveBeenCalledWith("100");
    expect(w.droplets.size).toBe(0);
    expect(w.controller.servers()).toEqual([]);
  });

  it("deletes a busy server at its maximum lifetime", async () => {
    const w = world();
    w.setWaiting(5);
    await w.controller.tick();
    w.advance(60_000);
    await w.controller.tick();
    await settle();
    w.pool.get("burst-1")!.idleSince = null;
    w.advance(cfg.maxLifetimeMs);
    await w.controller.tick();
    await settle();
    expect(w.provider.delete).toHaveBeenCalledWith("100");
  });

  it("deletes the server when its browser disconnects", async () => {
    const w = world();
    w.setWaiting(5);
    await w.controller.tick();
    w.advance(60_000);
    await w.controller.tick();
    await settle();
    w.pool.get("burst-1")!.onLost();
    await settle();
    expect(w.provider.delete).toHaveBeenCalledWith("100");
  });

  it("deletes a server whose browser never answers, then waits before trying again", async () => {
    const w = world({ readyAfterPolls: Infinity });
    w.setWaiting(5);
    await w.controller.tick();
    w.advance(60_000);
    await w.controller.tick();
    await settle();
    expect(w.provider.delete).toHaveBeenCalledWith("100");
    expect(w.fleet.addBurst).not.toHaveBeenCalled();

    w.advance(60_000);
    await w.controller.tick();
    await settle();
    expect(w.provider.create).toHaveBeenCalledTimes(1);
    w.advance(10 * 60_000);
    await w.controller.tick();
    await settle();
    expect(w.provider.create).toHaveBeenCalledTimes(2);
  });

  it("stops renting once today's server-hours are used up", async () => {
    const w = world();
    const small = createBurstController(w.provider, w.fleet, { ...cfg, maxHoursPerDay: 0 }, { now: w.now, sleep: async () => {}, probe: async () => null });
    w.setWaiting(5);
    await small.tick();
    w.advance(120_000);
    await small.tick();
    await settle();
    expect(w.provider.create).not.toHaveBeenCalled();
  });

  it("deletes tagged servers it doesn't know (leftovers), and all of its own on close", async () => {
    const w = world();
    w.droplets.set("7", { id: "7", name: "test-burst-old", ip: "203.0.113.9", active: true, polls: 5 });
    w.setWaiting(5);
    await w.controller.tick();
    expect(w.provider.delete).toHaveBeenCalledWith("7");

    w.advance(60_000);
    await w.controller.tick();
    await settle();
    expect(w.droplets.size).toBe(1);
    await w.controller.close();
    expect(w.droplets.size).toBe(0);
    expect(w.fleet.removeBurst).toHaveBeenCalledWith("burst-1", 0);
  });

  it("waits after a failed create", async () => {
    const w = world({ failCreate: true });
    w.setWaiting(5);
    await w.controller.tick();
    w.advance(60_000);
    await w.controller.tick();
    await settle();
    w.advance(60_000);
    await w.controller.tick();
    await settle();
    expect(w.provider.create).toHaveBeenCalledTimes(1);
    expect(w.controller.servers()).toEqual([]);
  });

  it("reads config on every tick and drains a running server when switched off", async () => {
    const w = world();
    const original = cfg.enabled;
    cfg.enabled = true;
    try {
      w.setWaiting(5);
      await w.controller.tick();
      w.advance(60_000);
      await w.controller.tick();
      await settle();
      expect(w.controller.servers()).toHaveLength(1);
      cfg.enabled = false;
      await w.controller.tick();
      await settle();
      expect(w.controller.servers()).toHaveLength(0);
    } finally {
      cfg.enabled = original;
    }
  });
});
