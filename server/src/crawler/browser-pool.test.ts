import { describe, expect, it, vi } from "vitest";
import { createBrowserPool, DOWN_MS, type PoolEntry } from "./browser-pool.ts";

const entry = (name: string, tabs: number, source: "static" | "burst" = "static"): PoolEntry<string> => ({
  name,
  source,
  tabs: () => tabs,
  allowProxy: source === "static",
  connect: async () => name,
});

describe("browser pool", () => {
  it("sends each page to the browser with the most free tabs, the configured one on a tie", () => {
    const pool = createBrowserPool<string>();
    pool.add(entry("burst-1", 4, "burst"));
    pool.add(entry("main", 4));
    const picks = Array.from({ length: 6 }, () => pool.pick()!.entry.name);
    expect(picks).toEqual(["main", "burst-1", "main", "burst-1", "main", "burst-1"]);
    expect(pool.capacity()).toBe(8);
  });

  it("keeps proxy pages on configured browsers, even when they're full", () => {
    const pool = createBrowserPool<string>();
    pool.add(entry("main", 1));
    pool.add(entry("burst-1", 6, "burst"));
    expect(pool.pick({ useProxy: true })!.entry.name).toBe("main");
    expect(pool.pick({ useProxy: true })!.entry.name).toBe("main");
    expect(pool.pick()!.entry.name).toBe("burst-1");
  });

  it("uses a browser marked down only when no other can take the page", () => {
    let now = 0;
    const pool = createBrowserPool<string>({ now: () => now });
    pool.add(entry("main", 4));
    pool.add(entry("main-2", 4));
    pool.markDown("main");
    expect(pool.pick()!.entry.name).toBe("main-2");
    expect(pool.pick({ exclude: new Set(["main-2"]) })!.entry.name).toBe("main");
    expect(pool.get("main")!.state).toBe("down");
    now += DOWN_MS + 1;
    expect(pool.get("main")!.state).toBe("up");
  });

  it("drains a browser: no new pages, done once its pages finish, capacity follows", async () => {
    const onCapacityChange = vi.fn();
    const pool = createBrowserPool<string>({ onCapacityChange });
    pool.add(entry("main", 2));
    pool.add(entry("burst-1", 6, "burst"));
    expect(onCapacityChange).toHaveBeenCalledTimes(2);
    const lease = pool.pick()!;
    expect(lease.entry.name).toBe("burst-1");

    let drained = false;
    const done = pool.drain("burst-1").then(() => (drained = true));
    expect(pool.capacity()).toBe(2);
    expect(onCapacityChange).toHaveBeenCalledTimes(3);
    expect(pool.pick()!.entry.name).toBe("main");
    await Promise.resolve();
    expect(drained).toBe(false);

    lease.release();
    lease.release(); // twice is harmless
    await done;
    expect(pool.get("burst-1")).toMatchObject({ active: 0, state: "draining", pages: 1 });
    pool.remove("burst-1");
    expect(pool.get("burst-1")).toBeNull();
    expect(pool.capacity()).toBe(2);
  });

  it("knows since when a browser is idle", () => {
    let now = 1000;
    const pool = createBrowserPool<string>({ now: () => now });
    pool.add(entry("main", 2));
    expect(pool.get("main")!.idleSince).toBe(1000);
    const lease = pool.pick()!;
    expect(pool.get("main")!.idleSince).toBeNull();
    now = 5000;
    lease.release();
    expect(pool.get("main")!.idleSince).toBe(5000);
  });

  it("has nothing to offer when every browser is draining", () => {
    const pool = createBrowserPool<string>();
    pool.add(entry("burst-1", 2, "burst"));
    void pool.drain("burst-1");
    expect(pool.pick()).toBeNull();
    expect(pool.capacity()).toBe(0);
  });

  it("resumes a drained browser: it takes pages again and counts for capacity", async () => {
    const pool = createBrowserPool<string>();
    pool.add(entry("main", 2));
    pool.add(entry("other", 2));
    await pool.drain("main");
    expect(pool.capacity()).toBe(2);
    expect(pool.pick()!.entry.name).toBe("other");
    pool.resume("main");
    expect(pool.capacity()).toBe(4);
    expect(pool.get("main")!.state).toBe("up");
    expect(pool.pick()!.entry.name).toBe("main");
    pool.resume("missing");
  });
});
