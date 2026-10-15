import { describe, expect, it } from "vitest";
import { createSlotPool, type SlotPriority } from "./slots.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createSlotPool", () => {
  it("hands out free slots at once, up to the size", async () => {
    const pool = createSlotPool(() => 2);
    await pool.acquire();
    await pool.acquire("interactive");
    expect(pool.active).toBe(2);
    expect(pool.waiting).toBe(0);
  });

  it("serves waiters by priority, first come first served within one", async () => {
    const pool = createSlotPool(() => 1);
    await pool.acquire();
    const order: string[] = [];
    const wait = (p: SlotPriority, name: string) => pool.acquire(p).then(() => order.push(name));
    const all = [wait("detail", "detail-1"), wait("listing", "listing-1"), wait("detail", "detail-2"), wait("interactive", "check"), wait("listing", "listing-2")];
    await tick();
    expect(pool.waiting).toBe(5);

    for (let i = 0; i < 5; i++) {
      pool.release();
      await tick();
    }
    await Promise.all(all);
    expect(order).toEqual(["check", "listing-1", "listing-2", "detail-1", "detail-2"]);
    // Each release handed its slot to the next waiter; the last holder still has it.
    expect(pool.active).toBe(1);
    pool.release();
    expect(pool.active).toBe(0);
  });

  it("never runs more holders than the size", async () => {
    const pool = createSlotPool(() => 3);
    let running = 0;
    let peak = 0;
    const job = async (p: SlotPriority) => {
      await pool.acquire(p);
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      pool.release();
    };
    const priorities: SlotPriority[] = ["detail", "listing", "interactive"];
    await Promise.all(Array.from({ length: 30 }, (_, i) => job(priorities[i % 3])));
    expect(peak).toBe(3);
    expect(pool.active).toBe(0);
    expect(pool.waiting).toBe(0);
  });

  it("follows a size that changes at runtime", async () => {
    let size = 1;
    const pool = createSlotPool(() => size);
    await pool.acquire();
    let got = 0;
    const waiters = [pool.acquire().then(() => got++), pool.acquire().then(() => got++), pool.acquire().then(() => got++)];
    await tick();
    expect(got).toBe(0);

    // A browser joined: two more slots, handed to waiters at once.
    size = 3;
    pool.pump();
    await tick();
    expect(got).toBe(2);
    expect(pool.active).toBe(3);

    // It left again: releases don't hand over until the holders fit in the smaller size.
    size = 1;
    pool.release();
    pool.release();
    await tick();
    expect(got).toBe(2);
    expect(pool.active).toBe(1);
    pool.release();
    await Promise.all(waiters);
    expect(got).toBe(3);
    expect(pool.active).toBe(1);
  });
});

describe("aborting a waiter", () => {
  it("leaves the queue, rejects, and the freed slot goes to the next waiter", async () => {
    const pool = createSlotPool(() => 1);
    await pool.acquire();
    const stop = new AbortController();
    const dropped = pool.acquire("detail", stop.signal);
    const next = pool.acquire("detail");
    await tick();
    expect(pool.waiting).toBe(2);

    stop.abort(new Error("stopped"));
    await expect(dropped).rejects.toThrow("stopped");
    expect(pool.waiting).toBe(1);

    pool.release();
    await next;
    expect(pool.active).toBe(1);
    expect(pool.waiting).toBe(0);
  });

  it("rejects at once when already aborted", async () => {
    const pool = createSlotPool(() => 1);
    await expect(pool.acquire("detail", AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");
    expect(pool.active).toBe(0);
  });
});
