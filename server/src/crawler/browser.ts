import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type HTTPResponse, type Page } from "puppeteer-core";
import { NAME_SHIM, PAGE_SCRIPTS, type PageScriptArgs, type PageScriptName, type PageScriptResult } from "@specharvest/shared/page-scripts";
import { env } from "../config.ts";
import { createLogger } from "../lib/logger.ts";
import { assertPublicUrl, isPublicHost, strictPolicy, type TargetPolicy } from "../lib/net-guard.ts";
import { withExtensionPage, type WaitOptions } from "../extension/driver.ts";
import { FatalDriverError, type PageDriver, type Runner } from "./driver.ts";
import { createSlotPool, type SlotPriority } from "./slots.ts";

const log = createLogger("browser");

// ---------- Connection (memoized, cleared on failure/disconnect) ----------

let browserPromise: Promise<Browser> | null = null;
const CONNECT_TIMEOUT_MS = 15_000;

function wsHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (env.PUPPETEER_WS_USER) {
    headers.Authorization = `Basic ${Buffer.from(`${env.PUPPETEER_WS_USER}:${env.PUPPETEER_WS_PASSWORD ?? ""}`).toString("base64")}`;
  }
  if (env.PUPPETEER_WS_API_KEY) headers["X-Api-Key"] = env.PUPPETEER_WS_API_KEY;
  return headers;
}

function startBrowser(): Promise<Browser> {
  if (env.PUPPETEER_WS_ENDPOINT) {
    log.info(`Connecting to remote browser ${new URL(env.PUPPETEER_WS_ENDPOINT).host}`);
    return puppeteer.connect({ browserWSEndpoint: env.PUPPETEER_WS_ENDPOINT, headers: wsHeaders(), protocolTimeout: 120_000 });
  }
  if (env.PUPPETEER_EXECUTABLE_PATH) {
    log.info(`Launching local browser ${env.PUPPETEER_EXECUTABLE_PATH}`);
    return puppeteer.launch({ executablePath: env.PUPPETEER_EXECUTABLE_PATH, headless: true, protocolTimeout: 120_000 });
  }
  return Promise.reject(new Error("No browser configured — set PUPPETEER_WS_ENDPOINT (or PUPPETEER_EXECUTABLE_PATH for local dev)"));
}

export function connect(): Promise<Browser> {
  if (!browserPromise) {
    const attempt = startBrowser();
    browserPromise = attempt;
    attempt.then(
      (browser) => {
        log.info("Browser ready");
        browser.on("disconnected", () => {
          log.warn("Browser disconnected");
          if (browserPromise === attempt) browserPromise = null;
        });
      },
      (err) => {
        log.error("Failed to start/connect browser", String(err));
        if (browserPromise === attempt) browserPromise = null;
      },
    );
  }
  const pending = browserPromise;
  // puppeteer.connect() has no timeout of its own; a hung endpoint would wedge every job.
  return Promise.race([
    pending,
    new Promise<Browser>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out connecting to remote browser after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS).unref(),
    ),
  ]);
}

// ---------- Global page slots ----------

// Every crawl and page check shares SCRAPE_MAX_CONCURRENT_PAGES pages; see slots.ts for who goes first.
const slots = createSlotPool(() => env.SCRAPE_MAX_CONCURRENT_PAGES);

export const proxyConfigured = () => !!env.PROXY_SERVER;

const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };

export interface PageOptions {
  useProxy?: boolean;
  /** Abort images/fonts/media to save bandwidth (detail pages only need text + image URLs). */
  blockHeavyResources?: boolean;
}

async function openPage(browser: Browser, opts: PageOptions): Promise<{ page: Page; context: BrowserContext | null }> {
  if (opts.useProxy) {
    if (!env.PROXY_SERVER) throw new Error("Proxy requested but PROXY_SERVER is not configured");
    if ((env.PROXY_USERNAME == null) !== (env.PROXY_PASSWORD == null)) {
      throw new Error("PROXY_USERNAME and PROXY_PASSWORD must both be set, or both blank");
    }
    const context = await browser.createBrowserContext({ proxyServer: env.PROXY_SERVER });
    const page = await context.newPage();
    if (env.PROXY_USERNAME) await page.authenticate({ username: env.PROXY_USERNAME, password: env.PROXY_PASSWORD! });
    return { page, context };
  }
  // A fresh incognito context per page keeps cookies/state isolated between jobs on a shared remote browser.
  const context = await browser.createBrowserContext();
  return { page: await context.newPage(), context };
}

const HEAVY_RESOURCES = new Set(["image", "media", "font"]);
/** Schemes a page may load without a network check (inline content). */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);

/**
 * Every request the page makes (navigations, redirects, subresources, XHR): http(s) to a public host only —
 * a crawled page must not get the browser to read the server's network (its text is stored and shown).
 * Hosts are resolved once per page. Chrome resolves names itself, so this can't catch DNS rebinding;
 * network-level isolation of the browser is the full fix (docs/deployment.md).
 */
function requestFilter(policy: TargetPolicy, blockHeavy: boolean) {
  const hosts = new Map<string, Promise<boolean>>();
  const allowed = async (req: HTTPRequest): Promise<boolean> => {
    if (blockHeavy && HEAVY_RESOURCES.has(req.resourceType())) return false;
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return false;
    }
    if (LOCAL_SCHEMES.has(url.protocol)) return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (policy.allowPrivate) return true;
    let ok = hosts.get(url.hostname);
    if (!ok) hosts.set(url.hostname, (ok = isPublicHost(url.hostname, policy)));
    return ok;
  };
  return (req: HTTPRequest) => {
    void allowed(req)
      .catch(() => false)
      .then((ok) => (ok ? req.continue() : req.abort(blockHeavy && HEAVY_RESOURCES.has(req.resourceType()) ? "failed" : "accessdenied")))
      .catch(() => {});
  };
}

/** Today's runner: a tab in the server's puppeteer Chrome. */
export class PuppeteerDriver implements PageDriver {
  readonly runner = "server" as const;
  constructor(readonly page: Page) {}

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
    await this.page.waitForNetworkIdle({ idleTime: opts.idleMs, timeout: opts.timeoutMs }).catch(() => {});
  }
}

export interface WithPageOptions extends PageOptions, WaitOptions {
  /** "browser" runs in the user's own Chrome via the extension (see extension/driver.ts). Default "server". */
  runner?: Runner;
  /** runner browser: whose extension. */
  userId?: number | null;
  /** Place in the queue for a server page slot (default "detail"). */
  priority?: SlotPriority;
}

export async function withPage<T>(fn: (page: PageDriver) => Promise<T>, opts: WithPageOptions = {}): Promise<T> {
  // The user's Chrome has its own tab limit (set in the extension) and needs no server browser slot.
  if (opts.runner === "browser") return withExtensionPage(opts.userId ?? null, fn, opts);
  await slots.acquire(opts.priority);
  try {
    const browser = await connect();
    const { page, context } = await openPage(browser, opts);
    try {
      // tsx/esbuild (keepNames) wraps named functions inside page.evaluate callbacks
      // in __name(...), which doesn't exist in the page — define a no-op.
      await page.evaluateOnNewDocument(NAME_SHIM);
      await page.setUserAgent(DESKTOP_USER_AGENT);
      await page.setViewport(DESKTOP_VIEWPORT);
      await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9,bs;q=0.8" });
      const policy = strictPolicy();
      if (!policy.allowPrivate || opts.blockHeavyResources) {
        // A service worker's own requests aren't intercepted — make the page go to the network instead.
        await page.setBypassServiceWorker(true);
        await page.setRequestInterception(true);
        page.on("request", requestFilter(policy, !!opts.blockHeavyResources));
      }
      return await fn(new PuppeteerDriver(page));
    } finally {
      if (context) await context.close().catch(() => {});
      else await page.close().catch(() => {});
    }
  } finally {
    slots.release();
  }
}

// ---------- Navigation (works on any PageDriver) ----------

export class BlockedPageError extends Error {}
/** A bot-protection interstitial (Cloudflare, DataDome…) rather than an HTTP error. */
export class BotWallError extends BlockedPageError {}

const NAVIGATION_TIMEOUT_MS = 60_000;

/** Scrolls to the bottom in steps so lazy content (spec tabs, images, cards) renders, then back to top. */
export async function scrollFullPage(page: PageDriver, maxSteps = 40) {
  for (let i = 0; i < maxSteps; i++) {
    const atBottom = await page.run("scrollStep", { step: 900 });
    await new Promise((r) => setTimeout(r, 150));
    if (atBottom) break;
  }
  await new Promise((r) => setTimeout(r, 400));
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
      const { status } = await page.goto(url, { timeoutMs: NAVIGATION_TIMEOUT_MS });
      await page.waitForNetworkIdle({ idleMs: 700, timeoutMs: 8_000 });
      if (await page.run("isBotChallenge").catch(() => false)) {
        throw new BotWallError(`Bot protection challenge on ${new URL(url).host} — ${page.runner === "server" ? "try running it in your browser, or the proxy" : "open the site in Chrome once and solve the check"}`);
      }
      if (status != null && status >= 400) throw new BlockedPageError(`HTTP ${status} from ${url}`);
      if (opts.scroll !== false) await scrollFullPage(page);
      await page.run("flattenShadowDom").catch(() => {});
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
export async function waitForStableText(page: PageDriver, timeoutMs = 6_000, intervalMs = 500): Promise<void> {
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

/** Health probe: connect + open/close a context. */
export async function checkBrowser(): Promise<void> {
  const browser = await connect();
  const ctx = await browser.createBrowserContext();
  await ctx.close();
}
