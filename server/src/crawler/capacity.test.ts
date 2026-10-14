import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CapacityRun } from "@specharvest/shared";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-capacity-"));
process.env.DATA_DIR = dataDir;
vi.mock("./browser.ts", () => ({ browserFleet: {}, connectRemote: vi.fn() }));

const { createCapacityTester, recommend } = await import("./capacity.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A browser with `cores` pages' worth of CPU: beyond that, every page gets slower in proportion. */
function fakeWorld(opts: { cores?: number; failFrom?: number; pauseMs?: number } = {}) {
  const cores = opts.cores ?? 3;
  let active = 0;
  let busy = 0;
  const waiting: Array<() => void> = [];
  let connected = true;
  const calls: string[] = [];
  const saved: CapacityRun[] = [];
  const deps = {
    fleet: {
      pause: vi.fn(async (name: string) => {
        calls.push(`pause ${name}`);
        await sleep(opts.pauseMs ?? 0);
      }),
      resume: vi.fn((name: string) => void calls.push(`resume ${name}`)),
      active: () => 0,
    },
    connect: vi.fn(async () => ({ browser: {}, connected: () => connected, close: async () => void (connected = false) })),
    loadPage: vi.fn(async () => {
      active++;
      try {
        if (opts.failFrom && active >= opts.failFrom) {
          await sleep(5);
          throw new Error("Target closed");
        }
        // `cores` pages run at a time; the others queue for a free one, like a browser host short of CPU.
        while (busy >= cores) await new Promise<void>((r) => waiting.push(r));
        busy++;
        try {
          await sleep(25);
        } finally {
          busy--;
          waiting.shift()?.();
        }
        if (!connected) throw new Error("Connection closed");
        return { openMs: 5, totalMs: 20 };
      } finally {
        active--;
      }
    }),
    collectUrls: async () => Array.from({ length: 20 }, (_, i) => `https://books.example/${i}`),
    save: (r: CapacityRun) => void saved.push(r),
    stepMs: 600,
    gapMs: 0,
  };
  return { deps, calls, saved };
}

const target = { name: "b1", id: 7, url: "wss://b1.example.com", creds: {} };

describe("capacity test", () => {
  it("stops once more pages stop helping and recommends the knee", async () => {
    const w = fakeWorld({ cores: 3 });
    const tester = createCapacityTester(w.deps);
    expect(tester.start(target)).toMatchObject({ browser: "b1", running: true });
    expect(() => tester.start(target)).toThrow(/already running/);
    expect(tester.busyWith()).toBe("b1");
    await tester.finished();

    const run = tester.state()!;
    expect(run).toMatchObject({ phase: "done", running: false, note: expect.stringMatching(/stopped helping/) });
    // 1, 2, 3 help; past 3 nothing does → it stops a couple of steps later instead of going on to 16.
    expect(run.steps.slice(0, 3).map((s) => s.tabs)).toEqual([1, 2, 3]);
    expect(run.steps.length).toBeLessThan(8);
    expect([3, 4]).toContain(run.recommended);
    expect(w.calls).toEqual(["pause b1", "resume b1"]);
    expect(w.saved).toHaveLength(1);
    expect(tester.busyWith()).toBeNull();
  });

  it("stops on errors, and resumes the browser", async () => {
    const w = fakeWorld({ failFrom: 2 });
    const tester = createCapacityTester(w.deps);
    tester.start(target);
    await tester.finished();
    const run = tester.state()!;
    expect(run.steps.at(-1)).toMatchObject({ tabs: 2 });
    expect(run.note).toMatch(/too many pages failed/);
    expect(run.recommended).toBe(1);
    expect(w.calls).toEqual(["pause b1", "resume b1"]);
  });

  it("can be stopped while it waits or while it tests, and shows progress meanwhile", async () => {
    const w = fakeWorld({ pauseMs: 200 });
    const tester = createCapacityTester(w.deps);
    tester.start(target);
    await sleep(50);
    expect(tester.state()).toMatchObject({ phase: "pausing", running: true });
    tester.stop();
    await tester.finished();
    expect(tester.state()).toMatchObject({ phase: "stopped", running: false, steps: [] });
    expect(w.calls).toEqual(["pause b1", "resume b1"]);

    const w2 = fakeWorld();
    const tester2 = createCapacityTester({ ...w2.deps, gapMs: 300 });
    tester2.start(target);
    await sleep(200);
    const mid = tester2.state()!;
    expect(mid).toMatchObject({ phase: "testing", progress: { stepIndex: 0, stepTabs: 1, stepCount: 9 } });
    expect(mid.progress.current!.pages).toBeGreaterThan(0);
    expect(mid.progress.maxRemainingMs).toBeGreaterThan(0);
    // In the gap after step 1, "time left" is the 8 steps still to come, each after its gap — not the full run again.
    await sleep(550);
    const between = tester2.state()!;
    expect(between.progress.stepStartedAt).toBeNull();
    expect(between.steps).toHaveLength(1);
    expect(between.progress.maxRemainingMs).toBe(8 * 900);
    tester2.stop();
    await tester2.finished();
    expect(tester2.state()!.phase).toBe("stopped");
    expect(w2.calls).toEqual(["pause b1", "resume b1"]);
  });

  it("fails cleanly when it can't connect", async () => {
    const w = fakeWorld();
    w.deps.connect.mockRejectedValueOnce(new Error("401"));
    const tester = createCapacityTester(w.deps);
    tester.start(target);
    await tester.finished();
    expect(tester.state()).toMatchObject({ phase: "failed", error: "401" });
    expect(w.calls).toEqual(["pause b1", "resume b1"]);
    expect(w.saved).toHaveLength(0);
  });

  it("recommends the smallest error-free step close to the best", () => {
    const step = (tabs: number, pagesPerMin: number, errors = 0) => ({ tabs, pages: 1, pagesPerMin, openP50Ms: 1, totalP50Ms: 1, totalP95Ms: 1, errors, errorSamples: [] });
    expect(recommend([step(1, 17), step(2, 19.5), step(3, 20.9), step(4, 20.9), step(8, 22.6)])).toBe(8);
    expect(recommend([step(1, 17), step(2, 19.5), step(3, 21.8), step(4, 20.9), step(6, 22)])).toBe(3);
    expect(recommend([step(1, 10), step(2, 20, 1), step(3, 20)])).toBe(3);
    expect(recommend([])).toBeNull();
  });
});
