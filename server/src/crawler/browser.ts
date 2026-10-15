import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type HTTPResponse, type Page } from "puppeteer-core";
import { NAME_SHIM, PAGE_SCRIPTS, type PageScriptArgs, type PageScriptName, type PageScriptResult } from "@specharvest/shared/page-scripts";
import { env } from "../config.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { assertPublicUrl, cachedIsPublicHost, strictPolicy, type TargetPolicy } from "../lib/net-guard.ts";
import { withExtensionPage, type WaitOptions } from "../extension/driver.ts";
import { FatalDriverError, type PageDriver, type Runner } from "./driver.ts";
import { createSlotPool, type SlotPriority } from "./slots.ts";
import { createBrowserPool, type BrowserPool, type Lease, type PoolEntry } from "./browser-pool.ts";
import { InFlightRequests } from "./network-idle.ts";
import { isTracker } from "./trackers.ts";
import { addTiming, fmtMs, notePagePhase, notePageUrl, takePagePhases } from "../lib/timing.ts";

const log = createLogger("browser");

// ---------- Browsers (memoized connections, cleared on failure/disconnect) ----------

const CONNECT_TIMEOUT_MS = 15_000;

/** Credentials for a gated remote browser (traefik-apikeys X-Api-Key and/or Basic auth). */
export interface BrowserCredentials {
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
}

const envCredentials = (): BrowserCredentials => ({ apiKey: env.PUPPETEER_WS_API_KEY, username: env.PUPPETEER_WS_USER, password: env.PUPPETEER_WS_PASSWORD });

function wsHeaders(creds: BrowserCredentials): Record<string, string> {
  const headers: Record<string, string> = {};
  if (creds.username) headers.Authorization = `Basic ${Buffer.from(`${creds.username}:${creds.password ?? ""}`).toString("base64")}`;
  if (creds.apiKey) headers["X-Api-Key"] = creds.apiKey;
  return headers;
}

export const connectRemote = (url: string, creds: BrowserCredentials) =>
  puppeteer.connect({ browserWSEndpoint: url, headers: wsHeaders(creds), protocolTimeout: 120_000 });

/** One browser's connection: made on first use, made again after a failure or a disconnect. */
function browserConnection(name: string, start: () => Promise<Browser>, onLost?: () => void) {
  let browserPromise: Promise<Browser> | null = null;
  let closing = false;
  return {
    connect(): Promise<Browser> {
      if (!browserPromise) {
        const attempt = start();
        browserPromise = attempt;
        attempt.then(
          (browser) => {
            log.info(`Browser ${name} ready`);
            browser.on("disconnected", () => {
              if (browserPromise === attempt) browserPromise = null;
              if (closing) return;
              log.warn(`Browser ${name} disconnected`);
              onLost?.();
            });
          },
          (err) => {
            log.error(`Failed to start/connect browser ${name}`, errorMessage(err));
            if (browserPromise === attempt) browserPromise = null;
          },
        );
      }
      const pending = browserPromise;
      // puppeteer.connect() has no timeout of its own; a hung endpoint would wedge every job.
      return Promise.race([
        pending,
        new Promise<Browser>((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out connecting to browser ${name} after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS).unref(),
        ),
      ]);
    },
    async close() {
      closing = true;
      const browser = await browserPromise?.catch(() => null);
      await browser?.disconnect().catch(() => {});
    },
  };
}

/** The browsers in PUPPETEER_WS_ENDPOINT, named main, main-2, …; they share the PUPPETEER_WS_* credentials. */
export function envBrowserEndpoints(): Array<{ name: string; url: string }> {
  const endpoints = (env.PUPPETEER_WS_ENDPOINT ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  return endpoints.map((url, i) => ({ name: i === 0 ? "main" : `main-${i + 1}`, url }));
}

const staticEntry = (name: string, start: () => Promise<Browser>): PoolEntry<Browser> => ({
  name,
  source: "static",
  tabs: () => env.SCRAPE_MAX_CONCURRENT_PAGES,
  allowProxy: true,
  connect: browserConnection(name, start).connect,
});

function envEntries(): Array<PoolEntry<Browser>> {
  return envBrowserEndpoints().map(({ name, url }) =>
    staticEntry(name, () => {
      log.info(`Connecting to remote browser ${name} (${new URL(url).host})`);
      return connectRemote(url, envCredentials());
    }),
  );
}

/**
 * Local-dev fallback while no remote browser is configured (neither in .env nor in the admin UI): a local Chrome, or
 * an entry that fails with a clear message — it keeps one page slot so pages fail fast instead of waiting forever.
 */
const FALLBACK = "main";
function fallbackEntry(): PoolEntry<Browser> {
  const local = env.PUPPETEER_EXECUTABLE_PATH;
  return staticEntry(FALLBACK, () => {
    if (!local) return Promise.reject(new Error("No browser configured — set PUPPETEER_WS_ENDPOINT, add one in Browser servers, or set PUPPETEER_EXECUTABLE_PATH for local dev"));
    log.info(`Launching local browser ${local}`);
    return puppeteer.launch({ executablePath: local, headless: true, protocolTimeout: 120_000 });
  });
}

// ---------- Global page slots ----------

// Every crawl and page check shares the pages all browsers take together; see slots.ts for who goes first and
// browser-pool.ts for which browser a page runs in.
const slots = createSlotPool(() => pool.capacity());
const pool: BrowserPool<Browser> = createBrowserPool<Browser>({ onCapacityChange: () => slots.pump() });
const hasEnvBrowsers = envBrowserEndpoints().length > 0;
for (const entry of envEntries()) pool.add(entry);

const browserLoad = () =>
  pool
    .stats()
    .map((b) => `${b.name} ${b.active}/${b.tabs}${b.state === "up" ? "" : ` ${b.state}`}`)
    .join(", ");

// While pages queue for a slot, say so every 30 s: a growing backlog means too few slots (or a slow browser).
setInterval(() => {
  if (slots.waiting > 0) log.info(`page slots: ${slots.active}/${pool.capacity()} busy (${browserLoad()}), ${slots.waiting} pages waiting`);
}, 30_000).unref();

/** Connections of browsers added at runtime (admin UI and burst), closed when they leave the pool. */
const connections = new Map<string, ReturnType<typeof browserConnection>>();
/** Admin-UI browsers in the pool. */
const appBrowsers = new Set<string>();

/** The fallback is in the pool only while there is no other configured browser (admin names never take "main"). */
function syncFallback() {
  if (hasEnvBrowsers) return;
  const inPool = !!pool.get(FALLBACK);
  if (appBrowsers.size > 0 && inPool) pool.remove(FALLBACK);
  else if (appBrowsers.size === 0 && !inPool) pool.add(fallbackEntry());
}
syncFallback();

/** Stops sending pages to `name`, waits up to `timeoutMs` for its open pages, then drops it and closes its connection. */
async function removeEntry(name: string, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([pool.drain(name), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
  clearTimeout(timer);
  pool.remove(name);
  await connections.get(name)?.close();
  connections.delete(name);
}

/**
 * For the burst controller (crawler/burst/) and the admin browser list (crawler/browsers.ts): how many pages wait,
 * and adding/removing browsers at runtime. A burst browser never takes proxy pages (see PoolEntry.allowProxy).
 */
export const browserFleet = {
  waiting: () => slots.waiting,
  get: (name: string) => pool.get(name),
  stats: () => pool.stats(),
  defaultTabs: () => env.SCRAPE_MAX_CONCURRENT_PAGES,
  addBurst(name: string, wsEndpoint: string, tabs: number, onLost: () => void) {
    const connection = browserConnection(name, () => puppeteer.connect({ browserWSEndpoint: wsEndpoint, protocolTimeout: 120_000 }), onLost);
    connections.set(name, connection);
    pool.add({ name, source: "burst", tabs: () => tabs, allowProxy: false, connect: connection.connect });
  },
  /** Stops sending pages to `name`, waits up to `timeoutMs` for its open pages, then drops it. */
  removeBurst: removeEntry,
  /** Stops sending new pages to `name` (capacity test); resolves once its open pages are done. */
  pause: (name: string) => pool.drain(name),
  resume: (name: string) => pool.resume(name),
  /** URL and credentials of a .env browser (main, main-2…), or null. */
  envBrowser(name: string): { url: string; creds: BrowserCredentials } | null {
    const found = envBrowserEndpoints().find((b) => b.name === name);
    return found ? { url: found.url, creds: envCredentials() } : null;
  },
  /** A browser added in the admin UI, with its own credentials and page limit (null = SCRAPE_MAX_CONCURRENT_PAGES). */
  addConfigured(name: string, url: string, creds: BrowserCredentials, opts: { tabs: number | null; allowProxy: boolean }) {
    const connection = browserConnection(name, () => {
      log.info(`Connecting to remote browser ${name} (${new URL(url).host})`);
      return connectRemote(url, creds);
    });
    connections.set(name, connection);
    appBrowsers.add(name);
    pool.add({ name, source: "static", tabs: () => opts.tabs ?? env.SCRAPE_MAX_CONCURRENT_PAGES, allowProxy: opts.allowProxy, connect: connection.connect });
    syncFallback();
  },
  async removeConfigured(name: string, timeoutMs: number) {
    await removeEntry(name, timeoutMs);
    appBrowsers.delete(name);
    syncFallback();
  },
};

/** Connects with the given URL and credentials, asks the browser's version and disconnects (admin "Test" button). */
export async function testBrowserConnection(url: string, creds: BrowserCredentials): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const attempt = connectRemote(url, creds);
  try {
    const browser = await Promise.race([
      attempt,
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`Timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS))),
    ]);
    try {
      return await browser.version();
    } finally {
      await browser.disconnect().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    // A connection that arrives after the timeout is closed right away.
    attempt.then((b) => b.disconnect().catch(() => {}), () => {});
  }
}

export const proxyConfigured = () => !!env.PROXY_SERVER;

const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };

export interface PageOptions {
  useProxy?: boolean;
  /** Abort images/fonts/media to save bandwidth (detail pages only need text + image URLs). */
  blockHeavyResources?: boolean;
}

/** `lap` marks the end of creating the context (and connecting) and of opening the page, for the page's timing. */
async function openPage(browser: Browser, opts: PageOptions, lap: (phase: string) => void): Promise<{ page: Page; context: BrowserContext | null }> {
  if (opts.useProxy) {
    if (!env.PROXY_SERVER) throw new Error("Proxy requested but PROXY_SERVER is not configured");
    if ((env.PROXY_USERNAME == null) !== (env.PROXY_PASSWORD == null)) {
      throw new Error("PROXY_USERNAME and PROXY_PASSWORD must both be set, or both blank");
    }
    const context = await browser.createBrowserContext({ proxyServer: env.PROXY_SERVER });
    lap("context");
    const page = await context.newPage();
    // Authentication turns on request handling itself, so it runs before the rest of the setup.
    if (env.PROXY_USERNAME) await page.authenticate({ username: env.PROXY_USERNAME, password: env.PROXY_PASSWORD! });
    lap("newPage");
    return { page, context };
  }
  // A fresh incognito context per page keeps cookies/state isolated between jobs on a shared remote browser.
  const context = await browser.createBrowserContext();
  lap("context");
  const page = await context.newPage();
  lap("newPage");
  return { page, context };
}

const HEAVY_RESOURCES = new Set(["image", "media", "font"]);
/** Schemes a page may load without a network check (inline content). */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);

/**
 * Every request the page makes (navigations, redirects, subresources, XHR): http(s) to a public host only —
 * a crawled page must not get the browser to read the server's network (its text is stored and shown).
 * Ad/analytics hosts (SCRAPE_BLOCK_TRACKERS, crawler/trackers.ts) and the site's link prefetches are aborted: the
 * crawl needs neither, and they keep the network busy. Host verdicts are shared across pages for a few minutes
 * (cachedIsPublicHost), so a known host is answered at once. Chrome resolves names itself, so this can't catch DNS
 * rebinding; network-level isolation of the browser is the full fix (docs/deployment.md).
 */
function requestFilter(policy: TargetPolicy, opts: { blockHeavy: boolean; blockTrackers: boolean }) {
  const stats = { requests: 0, ms: 0, trackers: 0, prefetches: 0 };
  /** The verdict now when it's known without waiting, else a promise of it. */
  const allowed = (req: HTTPRequest, url: URL): boolean | Promise<boolean> => {
    if (opts.blockHeavy && HEAVY_RESOURCES.has(req.resourceType())) return false;
    if (LOCAL_SCHEMES.has(url.protocol)) return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (policy.allowPrivate) return true;
    const verdict = cachedIsPublicHost(url.hostname, policy);
    return verdict.settled ?? verdict.promise;
  };
  /** Ad/analytics request — never the page's own navigation (crawling a tracker's site still works). */
  const ownNavigation = (req: HTTPRequest) => req.isNavigationRequest() && req.frame()?.parentFrame() == null;
  const tracker = (req: HTTPRequest, url: URL) => opts.blockTrackers && isTracker(url) && !ownNavigation(req);
  /** Links the site preloads for a visitor's next click (Sec-Purpose: prefetch); a crawl never follows them. */
  const prefetch = (req: HTTPRequest) => /^prefetch/i.test(req.headers()["sec-purpose"] ?? req.headers()["purpose"] ?? "") && !ownNavigation(req);
  const handle = (req: HTTPRequest) => {
    const t0 = performance.now();
    const answer = (ok: boolean, reason: "failed" | "accessdenied" | "blockedbyclient") => {
      stats.requests++;
      stats.ms += performance.now() - t0;
      void (ok ? req.continue() : req.abort(reason)).catch(() => {});
    };
    const deny = () => (opts.blockHeavy && HEAVY_RESOURCES.has(req.resourceType()) ? "failed" : "accessdenied");
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return answer(false, "accessdenied");
    }
    if (tracker(req, url)) {
      stats.trackers++;
      return answer(false, "blockedbyclient");
    }
    if (prefetch(req)) {
      stats.prefetches++;
      return answer(false, "blockedbyclient");
    }
    let verdict: boolean | Promise<boolean>;
    try {
      verdict = allowed(req, url);
    } catch {
      verdict = false;
    }
    if (typeof verdict === "boolean") answer(verdict, deny());
    else
      void verdict
        .catch(() => false)
        .then((ok) => answer(ok, deny()));
  };
  return { handle, stats };
}

/** Today's runner: a tab in the server's puppeteer Chrome. */
export class PuppeteerDriver implements PageDriver {
  readonly runner = "server" as const;
  /** `requests`: the page's requests from the browser's Network events (trackRequests); without it, puppeteer's count. */
  constructor(
    readonly page: Page,
    private readonly requests: InFlightRequests | null = null,
  ) {}

  async goto(url: string, opts: { timeoutMs: number }) {
    const response: HTTPResponse | null = await this.page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs });
    return { status: response?.status() ?? null };
  }

  run<K extends PageScriptName>(name: K, ...args: PageScriptArgs<K>): Promise<PageScriptResult<K>> {
    const fn = PAGE_SCRIPTS[name] as (...a: unknown[]) => PageScriptResult<K>;
    return this.page.evaluate(fn, ...(args as unknown[])) as Promise<PageScriptResult<K>>;
  }

  async click(selector: string) {
    // A real mouse click (scrolls the element into view first), not a DOM click — some sites check.
    await this.page.click(selector);
  }

  async waitForNetworkIdle(opts: { idleMs: number; timeoutMs: number }) {
    if (this.requests) await this.requests.waitForIdle({ ...opts, longMs: LONG_REQUEST_MS });
    else await this.page.waitForNetworkIdle({ idleTime: opts.idleMs, timeout: opts.timeoutMs }).catch(() => {});
  }
}

/** A request open this long no longer keeps the page "busy" (beacons, long polls, streams). */
const LONG_REQUEST_MS = 2_000;

/**
 * Follows the page's requests on a CDP session of its own, so request interception can't hide finished ones
 * (see network-idle.ts). Cross-site iframes are separate targets and not counted, as with puppeteer's own count.
 */
async function trackRequests(page: Page): Promise<InFlightRequests> {
  const requests = new InFlightRequests();
  const cdp = await page.createCDPSession();
  cdp.on("Network.requestWillBeSent", (e) => requests.started(e.requestId));
  cdp.on("Network.loadingFinished", (e) => requests.finished(e.requestId));
  cdp.on("Network.loadingFailed", (e) => requests.finished(e.requestId));
  cdp.on("Network.requestServedFromCache", (e) => requests.finished(e.requestId));
  await cdp.send("Network.enable");
  return requests;
}

export interface WithPageOptions extends PageOptions, WaitOptions {
  /** "browser" runs in the user's own Chrome via the extension (see extension/driver.ts). Default "server". */
  runner?: Runner;
  /** runner browser: whose extension. */
  userId?: number | null;
  /** Place in the queue for a server page slot (default "detail"). */
  priority?: SlotPriority;
}

/** A page whose load took this long is logged even without DEBUG. */
const SLOW_PAGE_MS = 20_000;

export async function withPage<T>(fn: (page: PageDriver) => Promise<T>, opts: WithPageOptions = {}): Promise<T> {
  // The user's Chrome has its own tab limit (set in the extension) and needs no server browser slot.
  if (opts.runner === "browser") return withExtensionPage(opts.userId ?? null, fn, opts);
  const queuedBehind = slots.waiting;
  const t0 = performance.now();
  // A stopped crawl drops pages still waiting for a slot; pages already open finish.
  await slots.acquire(opts.priority, opts.signal);
  const waited = performance.now() - t0;
  // The slot goes to the next page as soon as this one's work is done; closing the tab doesn't need it.
  let released = false;
  const release = () => {
    if (!released) slots.release();
    released = true;
  };
  const timing: PageTiming = { priority: opts.priority ?? "detail", browser: "", queuedBehind, waited, opened: 0, openPhases: {}, worked: 0, closed: 0, filter: null };
  let driver: PuppeteerDriver | null = null;
  let lease: Lease<Browser> | null = null;
  try {
    let t = performance.now();
    const lap = (phase: string) => {
      const now = performance.now();
      timing.openPhases[phase] = now - t;
      t = now;
    };
    let browser!: Browser;
    // A browser that can't be reached: try the page once more on another one (when there is one).
    const tried = new Set<string>();
    let lastError: unknown = new Error("No browser available");
    for (let attempt = 1; ; attempt++) {
      lease = pool.pick({ useProxy: opts.useProxy, exclude: tried });
      if (!lease) throw lastError;
      timing.browser = lease.entry.name;
      try {
        browser = await lease.entry.connect();
        break;
      } catch (err) {
        lease.release();
        lease = null;
        pool.markDown(timing.browser);
        tried.add(timing.browser);
        lastError = err;
        if (attempt >= 2) throw err;
      }
    }
    const { page, context } = await openPage(browser, opts, lap);
    try {
      // The setup calls don't depend on each other: send them together instead of waiting for each answer
      // (on a busy remote browser every answer is slow). All of them are done before the page navigates.
      const setup: Array<Promise<unknown>> = [
        // tsx/esbuild (keepNames) wraps named functions inside page.evaluate callbacks
        // in __name(...), which doesn't exist in the page — define a no-op.
        page.evaluateOnNewDocument(NAME_SHIM),
        page.setUserAgent(DESKTOP_USER_AGENT),
        page.setViewport(DESKTOP_VIEWPORT),
        page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9,bs;q=0.8" }),
      ];
      let requests: InFlightRequests | null = null;
      setup.push(
        trackRequests(page).then(
          (r) => (requests = r),
          (err) => log.debug("Request tracking unavailable, using puppeteer's network idle", String(err)),
        ),
      );
      const policy = strictPolicy();
      if (!policy.allowPrivate || opts.blockHeavyResources || env.SCRAPE_BLOCK_TRACKERS) {
        const filter = requestFilter(policy, { blockHeavy: !!opts.blockHeavyResources, blockTrackers: env.SCRAPE_BLOCK_TRACKERS });
        timing.filter = filter.stats;
        page.on("request", filter.handle);
        // A service worker's own requests aren't intercepted — make the page go to the network instead.
        setup.push(page.setBypassServiceWorker(true), page.setRequestInterception(true));
      }
      await Promise.all(setup);
      lap("setup");
      timing.opened = performance.now() - t0 - waited;
      driver = new PuppeteerDriver(page, requests);
      const t1 = performance.now();
      try {
        return await fn(driver);
      } finally {
        timing.worked = performance.now() - t1;
        release();
      }
    } finally {
      const t2 = performance.now();
      if (context) await context.close().catch(() => {});
      else await page.close().catch(() => {});
      timing.closed = performance.now() - t2;
    }
  } finally {
    release();
    // The browser's tab count includes closing: the tab is only gone once its context is closed.
    lease?.release();
    if (!timing.opened) timing.opened = performance.now() - t0 - waited - timing.closed;
    logPage(driver, timing);
  }
}

interface PageTiming {
  priority: string;
  /** Which browser the page ran in (browser-pool.ts). */
  browser: string;
  queuedBehind: number;
  waited: number;
  opened: number;
  /** context (incl. connecting), newPage, setup */
  openPhases: Record<string, number>;
  worked: number;
  closed: number;
  /** Requests the filter answered (trackers: aborted as ad/analytics) and the time they waited; null when nothing is intercepted. */
  filter: { requests: number; ms: number; trackers: number; prefetches: number } | null;
}

/** One line per page (DEBUG=1, or always when slow) and the page's share of its job's timing summary. */
function logPage(driver: PuppeteerDriver | null, t: PageTiming) {
  const { url, phases } = driver ? takePagePhases(driver) : { url: null, phases: {} };
  addTiming("page.wait", t.waited);
  addTiming("page.open", t.opened);
  for (const [phase, ms] of Object.entries(t.openPhases)) addTiming(`page.open.${phase}`, ms);
  if (t.filter) {
    addTiming("page.filter", t.filter.ms, t.filter.requests);
    if (t.filter.trackers) addTiming("page.trackers", 0, t.filter.trackers);
    if (t.filter.prefetches) addTiming("page.prefetches", 0, t.filter.prefetches);
  }
  if (driver) addTiming("page.work", t.worked);
  const list = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, ms]) => `${k} ${fmtMs(ms)}`)
      .join(", ");
  const openDetail = list(t.openPhases);
  const workDetail = [list(phases), t.filter ? `${t.filter.requests} requests checked in ${fmtMs(t.filter.ms)}, ${t.filter.trackers} trackers + ${t.filter.prefetches} prefetches blocked` : ""].filter(Boolean).join(", ");
  const line =
    `page ${url ?? "(no navigation)"} [${t.priority}${t.browser ? ` on ${t.browser}` : ""}]: ${fmtMs(t.waited + t.opened + t.worked + t.closed)} — waited ${fmtMs(t.waited)} for a slot ` +
    `(${t.queuedBehind} queued ahead, ${slots.active}/${pool.capacity()} busy now), open ${fmtMs(t.opened)}${openDetail ? ` (${openDetail})` : ""}, ` +
    `work ${fmtMs(t.worked)}${workDetail ? ` (${workDetail})` : ""}, close ${fmtMs(t.closed)}`;
  if (t.worked + t.opened >= SLOW_PAGE_MS) log.info(`slow ${line}`);
  else log.debug(line);
}

// ---------- Navigation (works on any PageDriver) ----------

export class BlockedPageError extends Error {}
/** A bot-protection interstitial (Cloudflare, DataDome…) rather than an HTTP error. */
export class BotWallError extends BlockedPageError {}

const NAVIGATION_TIMEOUT_MS = 60_000;
/**
 * Fixed waits every page pays, tuned against static pages and JS-heavy shops (IKEA, Shopify, OLX): shorter ones
 * captured the same text and images, and save ~1 s per page (docs/crawling.md#where-the-time-goes).
 */
const NETWORK_IDLE_MS = 500;
const SCROLL_STEP_PAUSE_MS = 150;
const AFTER_SCROLL_PAUSE_MS = 250;
const STABLE_TEXT_POLL_MS = 300;

/** Scrolls to the bottom in steps so lazy content (spec tabs, images, cards) renders, then back to top. */
export async function scrollFullPage(page: PageDriver, maxSteps = 40) {
  for (let i = 0; i < maxSteps; i++) {
    const atBottom = await page.run("scrollStep", { step: 900 });
    await new Promise((r) => setTimeout(r, SCROLL_STEP_PAUSE_MS));
    if (atBottom) break;
  }
  await new Promise((r) => setTimeout(r, AFTER_SCROLL_PAUSE_MS));
  await page.run("scrollToTop");
}

/**
 * Navigate with "load" (not networkidle — chat widgets / analytics never go
 * idle), a bounded network-idle wait for SPA data fetches, optional scroll,
 * one retry on transient failure. Throws BlockedPageError on a bot wall or
 * HTTP error status, since such pages render "successfully" but are useless.
 */
export async function gotoAndSettle(page: PageDriver, url: string, opts: { scroll?: boolean } = {}): Promise<number | null> {
  // A clear "private address" error instead of net::ERR_ACCESS_DENIED from the request filter — and never retried (BlockedTargetError).
  await assertPublicUrl(url, strictPolicy());
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      notePageUrl(page, url);
      let t = performance.now();
      const lap = (phase: string) => {
        const now = performance.now();
        notePagePhase(page, phase, now - t);
        t = now;
      };
      const { status } = await page.goto(url, { timeoutMs: NAVIGATION_TIMEOUT_MS });
      lap("goto");
      await page.waitForNetworkIdle({ idleMs: NETWORK_IDLE_MS, timeoutMs: 8_000 });
      lap("idle");
      if (await page.run("isBotChallenge").catch(() => false)) {
        throw new BotWallError(`Bot protection challenge on ${new URL(url).host} — ${page.runner === "server" ? "try running it in your browser, or the proxy" : "open the site in Chrome once and solve the check"}`);
      }
      if (status != null && status >= 400) throw new BlockedPageError(`HTTP ${status} from ${url}`);
      if (opts.scroll !== false) await scrollFullPage(page);
      await page.run("flattenShadowDom").catch(() => {});
      lap("scroll");
      return status;
    } catch (err) {
      lastError = err;
      if (err instanceof BlockedPageError || err instanceof FatalDriverError) throw err;
      log.warn(`Navigation attempt ${attempt} failed: ${url}`, String(err));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Waits until the page's visible text stops growing (SPAs often hydrate spec
 * tables after network idle). Polls the text length and returns once it holds
 * still for two polls in a row, or after `timeoutMs`.
 */
export async function waitForStableText(page: PageDriver, timeoutMs = 6_000, intervalMs = STABLE_TEXT_POLL_MS): Promise<void> {
  const t0 = performance.now();
  try {
    await pollStableText(page, timeoutMs, intervalMs);
  } finally {
    notePagePhase(page, "settle", performance.now() - t0);
  }
}

async function pollStableText(page: PageDriver, timeoutMs: number, intervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let steady = 0;
  while (Date.now() < deadline) {
    const len = await page.run("visibleTextLength").catch(() => -1);
    if (len > 0 && len === last) {
      if (++steady >= 2) return;
    } else steady = 0;
    last = len;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Health probe: connect to the (first) configured browser + open/close a context. */
export async function checkBrowser(): Promise<void> {
  const main = pool.pick({ useProxy: true });
  if (!main) throw new Error("No browser configured");
  main.release();
  const browser = await main.entry.connect();
  const ctx = await browser.createBrowserContext();
  await ctx.close();
}
