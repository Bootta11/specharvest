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
});
