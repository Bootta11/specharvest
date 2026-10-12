/**
 * Network activity of crawl tabs, from chrome.webRequest (observe only — nothing is blocked or changed).
 * Chrome reports requests only for sites the extension may access, which are the crawled site's own; a
 * third-party CDN's requests aren't seen. That is enough for "has the page's data arrived", which is what
 * the crawler waits for.
 */

interface TabTraffic {
  inFlight: Set<string>;
  lastChange: number;
  /** HTTP status of the latest main-document response. */
  mainStatus: number | null;
}

const traffic = new Map<number, TabTraffic>();

function of(tabId: number): TabTraffic {
  let t = traffic.get(tabId);
  if (!t) traffic.set(tabId, (t = { inFlight: new Set(), lastChange: Date.now(), mainStatus: null }));
  return t;
}

export function trackNetwork() {
  const filter: chrome.webRequest.RequestFilter = { urls: ["http://*/*", "https://*/*"] };
  chrome.webRequest.onBeforeRequest.addListener((d) => {
    if (d.tabId < 0) return;
    const t = of(d.tabId);
    t.inFlight.add(d.requestId);
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
  traffic.set(tabId, { inFlight: new Set(), lastChange: Date.now(), mainStatus: null });
}

export const mainStatus = (tabId: number) => traffic.get(tabId)?.mainStatus ?? null;

export function forgetTab(tabId: number) {
  traffic.delete(tabId);
}

/** Resolves once the tab has had no request in flight for `idleMs`, or after `timeoutMs`. */
export async function waitForIdle(tabId: number, idleMs: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = of(tabId);
    if (t.inFlight.size === 0 && Date.now() - t.lastChange >= idleMs) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
