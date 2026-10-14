import type { Browser } from "puppeteer-core";
import type { CapacityRun, CapacityStep } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { browserFleet, connectRemote, type BrowserCredentials } from "./browser.ts";

/**
 * Browser capacity test (admin → Browser servers → Test capacity): loads more and more pages at once in one browser
 * and measures pages/min, to find the page limit after which more pages only make each one slower. The browser takes
 * no crawl pages meanwhile (paused in the pool, browser-pool.ts) and the test uses its own connection. Workload:
 * books.toscrape.com product pages, the public scraping sandbox of docs/load-testing.md.
 */

const log = createLogger("capacity");

export const LEVELS = [1, 2, 3, 4, 6, 8, 10, 12, 16];
const STEP_MS = 30_000;
const GAP_MS = 3_000;
const PAUSE_TIMEOUT_MS = 120_000;
/** A step "helps" when it beats the best pages/min so far by more than this. */
const GAIN = 0.05;
const SLOW_P50_MS = 30_000;

export interface PageTiming {
  openMs: number;
  totalMs: number;
}

/** What the tester needs from the outside world; replaced in tests. */
export interface CapacityDeps {
  fleet: { pause(name: string): Promise<void>; resume(name: string): void; active(name: string): number };
  connect(url: string, creds: BrowserCredentials): Promise<{ browser: unknown; close(): Promise<void>; connected(): boolean }>;
  loadPage(browser: unknown, url: string): Promise<PageTiming>;
  collectUrls(): Promise<string[]>;
  save(run: CapacityRun): void;
  levels?: number[];
  stepMs?: number;
  gapMs?: number;
  pauseTimeoutMs?: number;
  now?: () => number;
}

export interface CapacityTarget {
  name: string;
  id: number | null;
  url: string;
  creds: BrowserCredentials;
}

const pct = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

/** The smallest step within GAIN of the best pages/min, without errors. */
export function recommend(steps: CapacityStep[]): number | null {
  const best = Math.max(0, ...steps.map((s) => s.pagesPerMin));
  if (best <= 0) return null;
  return steps.find((s) => s.errors === 0 && s.pagesPerMin >= best * (1 - GAIN))?.tabs ?? null;
}

export function createCapacityTester(deps: CapacityDeps) {
  const levels = deps.levels ?? LEVELS;
  const stepMs = deps.stepMs ?? STEP_MS;
  const gapMs = deps.gapMs ?? GAP_MS;
  const pauseTimeoutMs = deps.pauseTimeoutMs ?? PAUSE_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  let run: CapacityRun | null = null;
  let stopRequested = false;
  let stopSignal: () => void = () => {};
  let finished: Promise<void> = Promise.resolve();

  const remainingAfter = (stepIndex: number) => (levels.length - stepIndex - 1) * (stepMs + gapMs);

  /** Fills the time-dependent progress fields (called on every read). */
  function snapshot(): CapacityRun | null {
    if (!run) return null;
    if (!run.running) return structuredClone(run);
    const p = run.progress;
    const t = now();
    p.elapsedMs = t - run.startedAt;
    if (p.stepStartedAt != null) {
      const left = Math.max(0, stepMs - (t - p.stepStartedAt));
      p.maxRemainingMs = left + remainingAfter(p.stepIndex);
      if (p.current) p.current.pagesPerMin = p.current.pages / (Math.max(1, t - p.stepStartedAt) / 60_000);
    } else if (run.steps.length > 0) {
      // Between steps: the steps after the one that just ended, each after its gap.
      p.maxRemainingMs = remainingAfter(p.stepIndex);
    } else {
      p.maxRemainingMs = levels.length * (stepMs + gapMs);
    }
    if (run.phase === "pausing") p.waitingPages = deps.fleet.active(run.browser);
    return structuredClone(run);
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      const prev = stopSignal;
      stopSignal = () => {
        clearTimeout(timer);
        resolve();
        prev();
      };
    });

  async function execute(target: CapacityTarget) {
    const r = run!;
    let conn: Awaited<ReturnType<CapacityDeps["connect"]>> | null = null;
    let paused = false;
    try {
      r.phase = "collecting";
      const urls = await deps.collectUrls();
      if (urls.length < 10) throw new Error("Could not collect test pages from books.toscrape.com");

      r.phase = "pausing";
      paused = true;
      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        deps.fleet.pause(target.name).then(() => true),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), pauseTimeoutMs))),
        new Promise<boolean>((resolve) => {
          const prev = stopSignal;
          stopSignal = () => (resolve(true), prev());
        }),
      ]);
      clearTimeout(timer);
      if (stopRequested) return;
      if (!drained) r.note = "Some crawl pages were still open when the test started; the first step may read low.";

      r.phase = "connecting";
      conn = await deps.connect(target.url, target.creds);
      if (stopRequested) return;
      // Stop: closing the connection ends the pages in flight at once.
      const openConn = conn;
      const prevStop = stopSignal;
      stopSignal = () => {
        void openConn.close().catch(() => {});
        prevStop();
      };

      r.phase = "testing";
      let urlIdx = 0;
      let best = 0;
      let flat = 0;
      for (let i = 0; i < levels.length && !stopRequested; i++) {
        const tabs = levels[i]!;
        const startedAt = now();
        Object.assign(r.progress, { stepIndex: i, stepTabs: tabs, stepStartedAt: startedAt, current: { pages: 0, errors: 0, pagesPerMin: 0 } });
        const timings: PageTiming[] = [];
        const errors: string[] = [];
        const end = startedAt + stepMs;
        await Promise.all(
          Array.from({ length: tabs }, async () => {
            while (!stopRequested && now() < end && conn!.connected()) {
              try {
                timings.push(await deps.loadPage(conn!.browser, urls[urlIdx++ % urls.length]!));
                r.progress.current!.pages++;
              } catch (err) {
                if (stopRequested) return;
                errors.push(errorMessage(err).slice(0, 120));
                r.progress.current!.errors++;
              }
            }
          }),
        );
        if (stopRequested) break;
        const elapsed = Math.max(1, now() - startedAt);
        const totals = timings.map((t) => t.totalMs);
        const step: CapacityStep = {
          tabs,
          pages: timings.length,
          pagesPerMin: timings.length / (elapsed / 60_000),
          openP50Ms: pct(timings.map((t) => t.openMs), 50),
          totalP50Ms: pct(totals, 50),
          totalP95Ms: pct(totals, 95),
          errors: errors.length,
          errorSamples: [...new Set(errors)].slice(0, 3),
        };
        r.steps.push(step);
        r.progress.current = null;
        r.progress.stepStartedAt = null;
        r.recommended = recommend(r.steps);

        if (!conn.connected()) {
          r.note = "The browser disconnected — it may have run out of memory.";
          break;
        }
        if (step.errors >= 3 && step.errors > step.pages * 0.2) {
          r.note = `Stopped at ${tabs} pages at once: too many pages failed.`;
          break;
        }
        if ((step.totalP50Ms ?? 0) > SLOW_P50_MS) {
          r.note = `Stopped at ${tabs} pages at once: a typical page took over ${SLOW_P50_MS / 1000} s.`;
          break;
        }
        if (step.pagesPerMin > best * (1 + GAIN)) {
          best = step.pagesPerMin;
          flat = 0;
        } else if (++flat >= 2) {
          r.note = "Done — more pages at once stopped helping.";
          break;
        }
        if (i < levels.length - 1) await sleep(gapMs);
      }
      if (!r.note && !stopRequested) r.note = "Done — tested every step.";
    } catch (err) {
      r.error = errorMessage(err);
      log.warn(`Capacity test on ${target.name} failed`, r.error);
    } finally {
      await conn?.close().catch(() => {});
      if (paused) deps.fleet.resume(target.name);
      r.running = false;
      r.finishedAt = now();
      r.phase = r.error ? "failed" : stopRequested ? "stopped" : "done";
      r.progress.current = null;
      r.progress.stepStartedAt = null;
      r.progress.maxRemainingMs = 0;
      r.progress.elapsedMs = r.finishedAt - r.startedAt;
      if (r.phase === "done") r.progress.stepIndex = levels.length - 1;
      if (r.phase !== "failed") deps.save(structuredClone(r));
      log.info(`Capacity test on ${target.name} ${r.phase}: ${r.steps.map((s) => `${s.tabs}→${s.pagesPerMin.toFixed(1)}/min`).join(", ")}; recommended ${r.recommended ?? "—"}`);
    }
  }

  return {
    state: snapshot,
    /** The browser a test is running on, if any. */
    busyWith: () => (run?.running ? run.browser : null),
    start(target: CapacityTarget): CapacityRun {
      if (run?.running) throw Object.assign(new Error(`A capacity test is already running on ${run.browser}`), { statusCode: 409 });
      stopRequested = false;
      stopSignal = () => {};
      run = {
        browser: target.name,
        browserId: target.id,
        phase: "collecting",
        running: true,
        startedAt: now(),
        finishedAt: null,
        steps: [],
        recommended: null,
        note: null,
        error: null,
        progress: { stepIndex: 0, stepCount: levels.length, stepTabs: null, stepStartedAt: null, stepMs, current: null, waitingPages: 0, elapsedMs: 0, maxRemainingMs: 0 },
      };
      finished = execute(target);
      return snapshot()!;
    },
    stop() {
      if (!run?.running) return;
      stopRequested = true;
      stopSignal();
    },
    /** Test hook: resolves when the running test has ended. */
    finished: () => finished,
  };
}

export type CapacityTester = ReturnType<typeof createCapacityTester>;

// ---------- Saved results ----------

const RESULT_PREFIX = "browser_capacity:";

export const savedCapacity = (name: string) => db.getSetting<CapacityRun>(RESULT_PREFIX + name);
export const deleteSavedCapacity = (name: string) => db.deleteSetting(RESULT_PREFIX + name);
export function renameSavedCapacity(from: string, to: string) {
  const saved = savedCapacity(from);
  if (!saved) return;
  db.setSetting(RESULT_PREFIX + to, { ...saved, browser: to });
  deleteSavedCapacity(from);
}

// ---------- The real thing ----------

const BOOKS = "https://books.toscrape.com/catalogue/";
let cachedUrls: string[] | null = null;

async function collectBookUrls(): Promise<string[]> {
  if (cachedUrls) return cachedUrls;
  const urls = new Set<string>();
  for (let page = 1; urls.size < 200 && page <= 12; page++) {
    const res = await fetch(`${BOOKS}page-${page}.html`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) break;
    for (const m of (await res.text()).matchAll(/href="([\w-]+_\d+\/index\.html)"/g)) urls.add(BOOKS + m[1]);
  }
  return (cachedUrls = [...urls]);
}

const HEAVY = new Set(["image", "media", "font"]);

/** Like a crawl's detail page (browser.ts openPage + blockHeavyResources): fresh context, heavy resources aborted. */
async function loadBookPage(b: unknown, url: string): Promise<PageTiming> {
  const browser = b as Browser;
  const t0 = performance.now();
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setRequestInterception(true);
    page.on("request", (req) => void (HEAVY.has(req.resourceType()) ? req.abort() : req.continue()).catch(() => {}));
    const opened = performance.now();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
    const textLength = await page.evaluate(() => document.body?.innerText.length ?? 0);
    if (textLength < 200) throw new Error("Page came back empty");
    return { openMs: opened - t0, totalMs: performance.now() - t0 };
  } finally {
    await context.close().catch(() => {});
  }
}

let tester: CapacityTester | null = null;

export function capacityTester(): CapacityTester {
  return (tester ??= createCapacityTester({
    fleet: { pause: browserFleet.pause, resume: browserFleet.resume, active: (name) => browserFleet.get(name)?.active ?? 0 },
    async connect(url, creds) {
      const browser = await Promise.race([
        connectRemote(url, creds),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out connecting to the browser")), 15_000).unref()),
      ]);
      return { browser, connected: () => browser.connected, close: () => browser.disconnect() };
    },
    loadPage: loadBookPage,
    collectUrls: collectBookUrls,
    save: (r) => db.setSetting(RESULT_PREFIX + r.browser, r),
  }));
}
