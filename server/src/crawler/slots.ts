/**
 * Who waits for a free browser page first. A page check has a user watching the form, and a crawl's listing walk
 * is what produces its first results, so both go ahead of the item pages older crawls have queued.
 */
export const slotPriorities = ["interactive", "listing", "detail"] as const;
export type SlotPriority = (typeof slotPriorities)[number];

export interface SlotPool {
  acquire(priority?: SlotPriority): Promise<void>;
  release(): void;
  readonly active: number;
  readonly waiting: number;
}

/** At most `size()` holders at once; waiters are served by priority, first come first served within one. */
export function createSlotPool(size: () => number): SlotPool {
  let active = 0;
  const queues: Record<SlotPriority, Array<() => void>> = { interactive: [], listing: [], detail: [] };

  return {
    async acquire(priority = "detail") {
      if (active < size()) {
        active++;
        return;
      }
      // The releasing holder hands its slot over directly, so `active` stays the same.
      await new Promise<void>((resolve) => queues[priority].push(resolve));
    },
    release() {
      for (const p of slotPriorities) {
        const next = queues[p].shift();
        if (next) return next();
      }
      active--;
    },
    get active() {
      return active;
    },
    get waiting() {
      return slotPriorities.reduce((n, p) => n + queues[p].length, 0);
    },
  };
}
