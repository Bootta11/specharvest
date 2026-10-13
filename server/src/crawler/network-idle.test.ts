import { afterEach, describe, expect, it, vi } from "vitest";
import { InFlightRequests } from "./network-idle.ts";

const opts = { idleMs: 500, timeoutMs: 8_000, longMs: 2_000 };

describe("InFlightRequests", () => {
  afterEach(() => vi.useRealTimers());

  /** Runs waitForIdle under fake timers, applying `events` at their times; returns when it resolved (ms). */
  async function idleAfter(events: Array<[ms: number, (r: InFlightRequests) => void]>) {
    vi.useFakeTimers();
    const r = new InFlightRequests(() => Date.now());
    const start = Date.now();
    let resolvedAt = -1;
    void r.waitForIdle(opts).then(() => (resolvedAt = Date.now() - start));
    for (const [at, fn] of events.sort((a, b) => a[0] - b[0])) {
      await vi.advanceTimersByTimeAsync(at - (Date.now() - start));
      fn(r);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    return resolvedAt;
  }

  it("is idle after idleMs with nothing open", async () => {
    expect(await idleAfter([])).toBe(500);
  });

  it("waits for open requests to finish, then idleMs more", async () => {
    const t = await idleAfter([
      [0, (r) => r.started("a")],
      [1000, (r) => r.finished("a")],
    ]);
    expect(t).toBeGreaterThanOrEqual(1500);
    expect(t).toBeLessThan(1600);
  });

  it("stops counting a request that stays open past longMs (beacons)", async () => {
    const t = await idleAfter([[0, (r) => r.started("beacon")]]);
    // Busy until the beacon is 2 s old (to within one 50 ms poll), then 500 ms of quiet.
    expect(t).toBeGreaterThanOrEqual(2450);
    expect(t).toBeLessThan(2600);
  });

  it("keeps a redirected request's start time", async () => {
    const t = await idleAfter([
      [0, (r) => r.started("a")],
      [1500, (r) => r.started("a")],
    ]);
    expect(t).toBeLessThan(2600);
  });

  it("gives up at timeoutMs when requests keep starting", async () => {
    const events: Array<[number, (r: InFlightRequests) => void]> = [];
    for (let ms = 0; ms < 9_000; ms += 300) events.push([ms, (r) => r.started(`r${ms}`)]);
    const t = await idleAfter(events);
    expect(t).toBeGreaterThanOrEqual(8_000);
    expect(t).toBeLessThan(8_100);
  });
});
