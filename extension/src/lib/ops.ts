import type { ExtensionCommand, ExtensionErrorCode } from "@specharvest/shared";
import { PAGE_SCRIPTS, type PageScriptName } from "@specharvest/shared/page-scripts";
import { bringForward, closeCrawlTab, isCrawlTab, moveToVisible, openCrawlTab, pagesRender, rememberSite, returnTab, showTab, siteNeedsVisible } from "./crawl-tabs.ts";
import { getSettings } from "./settings.ts";
import { forgetTab, mainStatus, resetTab, waitForIdle } from "./network.ts";
import { askForSite, hasSitePermission } from "./permissions.ts";
import { blockedReason } from "./url-guard.ts";

/** A command that failed in a way the server should know about (see extensionErrorCodes). */
export class OpError extends Error {
  constructor(
    readonly code: ExtensionErrorCode,
    message: string,
    readonly origin?: string,
  ) {
    super(message);
  }
}

const originOf = (url: string) => new URL(url).origin;

/** No access to `url`'s site yet: ask the user (notification + badge) and tell the server to wait. */
async function needPermission(url: string): Promise<never> {
  const origin = originOf(url);
  await askForSite(origin);
  throw new OpError("needs_permission", `Not allowed on ${new URL(url).hostname} yet`, origin);
}

/** Only tabs this extension opened for that server can be driven — never the user's own tabs, nor another server's. */
function requireCrawlTab(serverId: string, tabId: number) {
  if (!isCrawlTab(tabId, serverId)) throw new OpError("tab_closed", "That crawl tab is gone");
}

/** Navigates and waits for the page's load event (like puppeteer's waitUntil: "load"). */
async function goto(serverId: string, tabId: number, url: string, timeoutMs: number) {
  requireCrawlTab(serverId, tabId);
  const blocked = blockedReason(url);
  if (blocked) throw new OpError("blocked_url", blocked);
  if (!(await hasSitePermission(url))) await needPermission(url);
  resetTab(tabId);
  await bringForward(tabId);

  let cleanup = () => {};
  const loaded = new Promise<void>((resolve, reject) => {
    const onCompleted = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (d.tabId === tabId && d.frameId === 0 && /^https?:/.test(d.url)) finish();
    };
    const onError = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
      // ERR_ABORTED: replaced by another navigation (a redirect) — keep waiting for that one.
      if (d.tabId === tabId && d.frameId === 0 && !/ERR_ABORTED/.test(d.error)) finish(new OpError("navigation_failed", `${d.error} loading ${url}`));
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(new OpError("tab_closed", "The crawl tab was closed"));
    };
    const timer = setTimeout(() => finish(new OpError("timeout", `${url} didn't finish loading in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    function finish(err?: Error) {
      cleanup();
      if (err) reject(err);
      else resolve();
    }
    cleanup = () => {
      clearTimeout(timer);
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
      chrome.webNavigation.onErrorOccurred.removeListener(onError);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    chrome.webNavigation.onCompleted.addListener(onCompleted);
    chrome.webNavigation.onErrorOccurred.addListener(onError);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (err) {
    cleanup();
    throw new OpError("tab_closed", String((err as Error).message ?? err));
  }
  await loaded;

  // Redirects can end somewhere else: on the LAN (refused), or on a site the user hasn't allowed yet.
  const finalUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url ?? url;
  const finalBlocked = blockedReason(finalUrl);
  if (finalBlocked) throw new OpError("blocked_url", `${url} redirected to a local address`);
  if (!(await hasSitePermission(finalUrl))) await needPermission(finalUrl);
  return { status: mainStatus(tabId) };
}

/** Below the server's own 60 s limit, so the server gets this answer (with what the tab was doing) instead of a bare timeout. */
const SCRIPT_STALL_MS = 40_000;

/** What a tab is doing, for an error message: a stalled page script is otherwise impossible to tell apart. */
async function describeTab(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return "the tab is gone";
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  const t = tab as chrome.tabs.Tab & { frozen?: boolean };
  const facts = [`tab ${tab.status ?? "?"}`, `window ${win?.state ?? "?"}`, tab.discarded && "discarded", t.frozen && "frozen", tab.url && `at ${tab.url.slice(0, 120)}`];
  return facts.filter(Boolean).join(", ");
}

/** Runs one of the bundled page scripts in the tab (the extension's isolated world — the page can't see it). */
async function run(serverId: string, tabId: number, script: string, args: unknown[]) {
  requireCrawlTab(serverId, tabId);
  if (!Object.hasOwn(PAGE_SCRIPTS, script)) throw new OpError("bad_command", `Unknown page script ${script}`);
  const func = PAGE_SCRIPTS[script as PageScriptName] as (...a: unknown[]) => unknown;
  let results: chrome.scripting.InjectionResult<unknown>[];
  try {
    // injectImmediately: don't wait for the document to go "idle" again — after goto it has loaded, and a page
    // that keeps (re)loading in a hidden tab would otherwise hold the script back indefinitely.
    const injected = chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func, args, injectImmediately: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => void describeTab(tabId).then((d) => reject(new OpError("timeout", `${script} got no answer from the page in ${SCRIPT_STALL_MS / 1000} s (${d})`))), SCRIPT_STALL_MS);
    });
    results = await Promise.race([injected, stalled]).finally(() => clearTimeout(timer));
  } catch (err) {
    if (err instanceof OpError) throw err;
    const msg = String((err as Error).message ?? err);
    if (/no tab with id/i.test(msg)) throw new OpError("tab_closed", "The crawl tab was closed");
    if (/cannot access|permission|host/i.test(msg)) {
      const tabUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url;
      if (tabUrl && /^https?:/.test(tabUrl) && !blockedReason(tabUrl)) await needPermission(tabUrl);
    }
    throw new OpError("script_failed", `${script}: ${msg}`);
  }
  const first = results[0] as (chrome.scripting.InjectionResult<unknown> & { error?: unknown }) | undefined;
  if (first?.error) throw new OpError("script_failed", `${script}: ${String((first.error as Error)?.message ?? first.error)}`);
  return first?.result ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** New links after scrolling that mean "this page loads more items as you scroll". */
const MIN_NEW_LINKS = 3;

/**
 * Once per site: does this listing load more as you scroll? Hidden pages can't tell (they don't scroll), so
 * the tab is shown in the visible window, scrolled a few times, and the links counted. It stays there when
 * more appeared; otherwise it goes back. The answer is remembered for the site.
 */
async function probeScroll(serverId: string, tabId: number, url: string, timeoutMs: number) {
  requireCrawlTab(serverId, tabId);
  if ((await pagesRender()) || !(await getSettings()).autoVisible) return { checked: false, needsVisible: false };
  const known = await siteNeedsVisible(url);
  if (known !== null) {
    if (known) await moveToVisible(tabId);
    return { checked: false, needsVisible: known };
  }
  await goto(serverId, tabId, url, timeoutMs);
  const moved = await moveToVisible(tabId);
  await sleep(800);
  const before = (await run(serverId, tabId, "scrollMetrics", [])) as { links: number };
  let after = before;
  for (let i = 0; i < 3; i++) {
    await run(serverId, tabId, "scrollToBottom", []);
    await sleep(1_500);
    after = (await run(serverId, tabId, "scrollMetrics", [])) as { links: number };
  }
  const needsVisible = after.links - before.links >= MIN_NEW_LINKS;
  await rememberSite(url, needsVisible);
  if (!needsVisible && moved) await returnTab(tabId);
  return { checked: true, needsVisible };
}

/** A command from the server `serverId` (a ServerEntry id). */
export async function handleCommand(serverId: string, command: ExtensionCommand): Promise<unknown> {
  switch (command.op) {
    case "openTab":
      return { tabId: await openCrawlTab(serverId, command.origin) };
    case "showTab":
      requireCrawlTab(serverId, command.tabId);
      return showTab(command.tabId);
    case "probeScroll":
      return probeScroll(serverId, command.tabId, command.url, command.timeoutMs);
    case "closeTab":
      forgetTab(command.tabId);
      if (isCrawlTab(command.tabId, serverId)) await closeCrawlTab(command.tabId);
      return null;
    case "goto":
      return goto(serverId, command.tabId, command.url, command.timeoutMs);
    case "run":
      return run(serverId, command.tabId, command.script, command.args);
    case "click":
      if (!(await run(serverId, command.tabId, "clickSelector", [{ selector: command.selector }]))) throw new OpError("script_failed", `No element matches ${command.selector}`);
      return null;
    case "waitIdle":
      requireCrawlTab(serverId, command.tabId);
      await waitForIdle(command.tabId, command.idleMs, command.timeoutMs);
      return null;
    case "ensurePermission": {
      const blocked = blockedReason(command.origin);
      if (blocked) throw new OpError("blocked_url", blocked);
      if (await hasSitePermission(command.origin)) return { granted: true };
      await askForSite(command.origin);
      return { granted: false };
    }
    default:
      throw new OpError("bad_command", `Unknown command ${(command as { op?: string }).op}`);
  }
}
