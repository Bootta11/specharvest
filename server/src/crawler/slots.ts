/**
 * Who waits for a free browser page first. A page check has a user watching the form, and a crawl's listing walk
 * is what produces its first results, so both go ahead of the item pages older crawls have queued.
 */
export const slotPriorities = ["interactive", "listing", "detail"] as const;
export type SlotPriority = (typeof slotPriorities)[number];

export interface SlotPool {
  /** Rejects with `signal.reason` when the signal aborts while it waits (the page is no longer wanted). */
  acquire(priority?: SlotPriority, signal?: AbortSignal): Promise<void>;
  release(): void;
  /** Lets waiters in after the size grew (a browser joined). */
  pump(): void;
  readonly active: number;
  readonly waiting: number;
}

/**
 * At most `size()` holders at once; waiters are served by priority, first come first served within one. The size
 * may change at runtime: call pump() after it grows; when it shrinks, releases stop handing slots over until the
 * holders fit again.
 */
export function createSlotPool(size: () => number): SlotPool {
  let active = 0;
  const queues: Record<SlotPriority, Array<() => void>> = { interactive: [], listing: [], detail: [] };

  const next = () => {
    for (const p of slotPriorities) {
      const waiter = queues[p].shift();
      if (waiter) return waiter;
    }
    return null;
  };

  return {
    async acquire(priority = "detail", signal) {
      signal?.throwIfAborted();
      if (active < size()) {
        active++;
        return;
      }
      // The releasing holder hands its slot over directly, so `active` stays the same.
      await new Promise<void>((resolve, reject) => {
        const queue = queues[priority];
        const onAbort = () => {
          const i = queue.indexOf(waiter);
          if (i >= 0) queue.splice(i, 1);
          reject(signal!.reason);
        };
        const waiter = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        queue.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    release() {
      const waiter = active <= size() ? next() : null;
      if (waiter) return waiter();
      active--;
    },
    pump() {
      while (active < size()) {
        const waiter = next();
        if (!waiter) return;
        active++;
        waiter();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return slotPriorities.reduce((n, p) => n + queues[p].length, 0);
    },
  };
}
