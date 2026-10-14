/**
 * The browsers crawl pages run in, and which one gets the next page. A remote browser is one long CDP connection,
 * so a load balancer in front of several can't spread pages; SpecHarvest picks the browser per page instead.
 *
 * - "static": the configured browsers (PUPPETEER_WS_ENDPOINT, a comma-separated list, or a local Chrome).
 * - "burst": servers rented while pages queue up (crawler/burst/), added and drained at runtime.
 *
 * The global slot pool (slots.ts) decides *when* a page may start (its size is capacity()); this decides *where*.
 */

export interface PoolEntry<B> {
  name: string;
  source: "static" | "burst";
  /** Tabs this browser takes at once (a function, so a static browser follows SCRAPE_MAX_CONCURRENT_PAGES). */
  tabs: () => number;
  /**
   * Pages through the proxy may run here. Burst browsers are reached without TLS and proxy credentials travel over
   * CDP, so only static browsers take them.
   */
  allowProxy: boolean;
  connect: () => Promise<B>;
}

export interface EntryStats {
  name: string;
  source: "static" | "burst";
  active: number;
  tabs: number;
  state: "up" | "down" | "draining";
  /** When the last page here finished (or the entry was added); null while pages run. */
  idleSince: number | null;
  /** Pages this browser has run. */
  pages: number;
}

export interface Lease<B> {
  entry: PoolEntry<B>;
  release(): void;
}

interface State<B> {
  entry: PoolEntry<B>;
  active: number;
  pages: number;
  downUntil: number;
  draining: boolean;
  idleSince: number | null;
  drained: Array<() => void>;
}

/** A browser that failed to connect gets no pages for this long while another one is up. */
export const DOWN_MS = 30_000;

export function createBrowserPool<B>(opts: { onCapacityChange?: () => void; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const states = new Map<string, State<B>>();
  const changed = () => opts.onCapacityChange?.();
  const isDown = (s: State<B>) => s.downUntil > now();
  const free = (s: State<B>) => s.entry.tabs() - s.active;

  return {
    add(entry: PoolEntry<B>) {
      if (states.has(entry.name)) throw new Error(`Browser ${entry.name} is already in the pool`);
      states.set(entry.name, { entry, active: 0, pages: 0, downUntil: 0, draining: false, idleSince: now(), drained: [] });
      changed();
    },

    /** Stops sending pages to `name`; resolves once its open pages are done (or at once when it has none). */
    drain(name: string): Promise<void> {
      const s = states.get(name);
      if (!s) return Promise.resolve();
      if (!s.draining) {
        s.draining = true;
        changed();
      }
      if (s.active === 0) return Promise.resolve();
      return new Promise((resolve) => s.drained.push(resolve));
    },

    /** Undoes drain(): `name` takes pages again (e.g. after a capacity test). */
    resume(name: string) {
      const s = states.get(name);
      if (!s?.draining) return;
      s.draining = false;
      changed();
    },

    remove(name: string) {
      const s = states.get(name);
      if (!s) return;
      states.delete(name);
      for (const resolve of s.drained.splice(0)) resolve();
      if (!s.draining) changed();
    },

    markDown(name: string) {
      const s = states.get(name);
      if (s) s.downUntil = now() + DOWN_MS;
    },

    /** Pages all browsers take at once (draining ones don't count; a down one still does, it may be back soon). */
    capacity(): number {
      let n = 0;
      for (const s of states.values()) if (!s.draining) n += s.entry.tabs();
      return n;
    },

    /**
     * The browser for the next page: the one with the most free tabs, the configured ones first on a tie. A browser
     * marked down is used only when no other one can take the page. `exclude`: browsers this page already failed on.
     */
    pick(opts: { useProxy?: boolean; exclude?: ReadonlySet<string> } = {}): Lease<B> | null {
      const candidates = [...states.values()].filter((s) => !s.draining && !opts.exclude?.has(s.entry.name) && (!opts.useProxy || s.entry.allowProxy));
      const rank = (s: State<B>) => [isDown(s) ? 1 : 0, -free(s), s.entry.source === "static" ? 0 : 1];
      candidates.sort((a, b) => {
        const [ra, rb] = [rank(a), rank(b)];
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
        return 0;
      });
      const s = candidates[0];
      if (!s) return null;
      s.active++;
      s.pages++;
      s.idleSince = null;
      let released = false;
      return {
        entry: s.entry,
        release() {
          if (released) return;
          released = true;
          s.active--;
          if (s.active === 0) {
            s.idleSince = now();
            for (const resolve of s.drained.splice(0)) resolve();
          }
        },
      };
    },

    get(name: string): EntryStats | null {
      const s = states.get(name);
      return s ? toStats(s) : null;
    },

    stats(): EntryStats[] {
      return [...states.values()].map(toStats);
    },
  };

  function toStats(s: State<B>): EntryStats {
    return {
      name: s.entry.name,
      source: s.entry.source,
      active: s.active,
      tabs: s.entry.tabs(),
      state: s.draining ? "draining" : isDown(s) ? "down" : "up",
      idleSince: s.idleSince,
      pages: s.pages,
    };
  }
}

export type BrowserPool<B> = ReturnType<typeof createBrowserPool<B>>;
