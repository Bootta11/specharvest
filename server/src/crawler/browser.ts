import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type HTTPResponse, type Page } from "puppeteer-core";
import { env } from "../config.ts";
import { createLogger } from "../lib/logger.ts";
import { assertPublicUrl, isPublicHost, strictPolicy, type TargetPolicy } from "../lib/net-guard.ts";

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

let active = 0;
const waiters: Array<() => void> = [];

async function acquireSlot() {
  if (active < env.SCRAPE_MAX_CONCURRENT_PAGES) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function releaseSlot() {
  active--;
  waiters.shift()?.();
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

export async function withPage<T>(fn: (page: Page) => Promise<T>, opts: PageOptions = {}): Promise<T> {
  await acquireSlot();
  try {
    const browser = await connect();
    const { page, context } = await openPage(browser, opts);
    try {
      // tsx/esbuild (keepNames) wraps named functions inside page.evaluate callbacks
      // in __name(...), which doesn't exist in the page — define a no-op.
      await page.evaluateOnNewDocument("globalThis.__name = globalThis.__name || ((f) => f);");
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
      return await fn(page);
    } finally {
      if (context) await context.close().catch(() => {});
      else await page.close().catch(() => {});
    }
  } finally {
    releaseSlot();
  }
}

// ---------- Navigation ----------

export class BlockedPageError extends Error {}

const NAVIGATION_TIMEOUT_MS = 60_000;

/**
 * Cloudflare-style interstitial check: page.title() is one cheap round-trip,
 * only a suspicious title pays for page.content().
 */
async function detectChallenge(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => "");
  if (!/just a moment|attention required|access denied|verify you are human/i.test(title)) return false;
  const html = await page.content();
  return /challenges\.cloudflare\.com|cf-chl-|cf-turnstile|captcha|perimeterx|datadome/i.test(html);
}

/** Scrolls to the bottom in steps so lazy content (spec tabs, images, cards) renders, then back to top. */
export async function scrollFullPage(page: Page, maxSteps = 40) {
  for (let i = 0; i < maxSteps; i++) {
    const atBottom = await page.evaluate((step) => {
      window.scrollBy(0, step);
      return window.scrollY + window.innerHeight >= document.body.scrollHeight - 2;
    }, 900);
    await new Promise((r) => setTimeout(r, 150));
    if (atBottom) break;
  }
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Clones open shadow roots into light DOM so page.content() / selectors see their content. */
async function flattenShadowDom(page: Page) {
  await page
    .evaluate(() => {
      function flatten(root: Document | ShadowRoot) {
        for (const el of Array.from(root.querySelectorAll("*"))) {
          const shadow = (el as HTMLElement).shadowRoot;
          if (shadow) {
            const clone = document.createElement("div");
            clone.setAttribute("data-shadow-flattened", "true");
            clone.innerHTML = shadow.innerHTML;
            el.appendChild(clone);
            flatten(shadow);
          }
        }
      }
      flatten(document);
    })
    .catch(() => {});
}

/**
 * Navigate with "load" (not networkidle — chat widgets / analytics never go
 * idle), a bounded network-idle wait for SPA data fetches, optional scroll,
 * one retry on transient failure. Throws BlockedPageError on a bot wall or
 * HTTP error status, since such pages render "successfully" but are useless.
 */
export async function gotoAndSettle(page: Page, url: string, opts: { scroll?: boolean } = {}): Promise<number | null> {
  // A clear "private address" error instead of net::ERR_ACCESS_DENIED from the request filter — and never retried (BlockedTargetError).
  await assertPublicUrl(url, strictPolicy());
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response: HTTPResponse | null = await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForNetworkIdle({ idleTime: 700, timeout: 8_000 }).catch(() => {});
      const status = response?.status() ?? null;
      if (await detectChallenge(page)) throw new BlockedPageError(`Bot protection challenge on ${new URL(url).host} — try enabling the proxy`);
      if (status != null && status >= 400) throw new BlockedPageError(`HTTP ${status} from ${url}`);
      if (opts.scroll !== false) await scrollFullPage(page);
      await flattenShadowDom(page);
      return status;
    } catch (err) {
      lastError = err;
      if (err instanceof BlockedPageError) throw err;
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
export async function waitForStableText(page: Page, timeoutMs = 6_000, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let steady = 0;
  while (Date.now() < deadline) {
    const len = await page.evaluate(() => (document.querySelector("main") ?? document.body)?.innerText.length ?? 0).catch(() => -1);
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
