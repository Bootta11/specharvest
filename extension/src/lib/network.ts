/**
 * Network activity of crawl tabs, from chrome.webRequest (observe only — nothing is blocked or changed).
 * Chrome reports requests only for sites the extension may access, which are the crawled site's own; a
 * third-party CDN's requests aren't seen. That is enough for "has the page's data arrived", which is what
 * the crawler waits for.
 */

interface TabTraffic {
  /** Request id → when it started. */
  inFlight: Map<string, number>;
  lastChange: number;
  /** HTTP status of the latest main-document response. */
  mainStatus: number | null;
}

const traffic = new Map<number, TabTraffic>();

function of(tabId: number): TabTraffic {
  let t = traffic.get(tabId);
  if (!t) traffic.set(tabId, (t = { inFlight: new Map(), lastChange: Date.now(), mainStatus: null }));
  return t;
}

export function trackNetwork() {
  const filter: chrome.webRequest.RequestFilter = { urls: ["http://*/*", "https://*/*"] };
  chrome.webRequest.onBeforeRequest.addListener((d) => {
    if (d.tabId < 0) return;
    const t = of(d.tabId);
    // A redirect reuses the request id: keep its start time.
    if (!t.inFlight.has(d.requestId)) t.inFlight.set(d.requestId, Date.now());
    t.lastChange = Date.now();
    return undefined;
  }, filter);
  const done = (d: { tabId: number; requestId: string }) => {
    const t = traffic.get(d.tabId);
    if (!t) return;
    t.inFlight.delete(d.requestId);
    t.lastChange = Date.now();
  };
  chrome.webRequest.onCompleted.addListener((d) => {
    if (d.type === "main_frame" && d.tabId >= 0) of(d.tabId).mainStatus = d.statusCode;
    done(d);
  }, filter);
  chrome.webRequest.onErrorOccurred.addListener(done, filter);
}

export function resetTab(tabId: number) {
  traffic.set(tabId, { inFlight: new Map(), lastChange: Date.now(), mainStatus: null });
}

export const mainStatus = (tabId: number) => traffic.get(tabId)?.mainStatus ?? null;

export function forgetTab(tabId: number) {
  traffic.delete(tabId);
}

/** A request open this long no longer keeps the tab "busy" (beacons, long polls, streams — some never finish). */
const LONG_REQUEST_MS = 2_000;

/** Resolves once the tab has had no (recent) request in flight for `idleMs`, or after `timeoutMs`. */
export async function waitForIdle(tabId: number, idleMs: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = of(tabId);
    const now = Date.now();
    const busy = [...t.inFlight.values()].some((at) => now - at < LONG_REQUEST_MS);
    if (!busy && now - t.lastChange >= idleMs) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
