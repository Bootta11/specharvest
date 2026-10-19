import { getSettings, saveSettings, type TabMode } from "./settings.ts";
import { updateState } from "./state.ts";
import { siteOf } from "./url-guard.ts";

/**
 * Where the server's crawl tabs live. Depending on the user's setting:
 * - minimized: one minimized window just for crawling (default);
 * - background: one normal, unfocused window (pages render fully, for sites that need it);
 * - group: a collapsed "SpecHarvest" tab group in the window the user is in.
 * The window/group is reused while crawls run and closed after a quiet minute.
 *
 * Pages in a minimized window or a background tab are hidden: Chrome doesn't lay them out, so they don't
 * scroll and "load more on scroll" never fires. A site that needs that gets its tabs moved to a second,
 * visible place — a normal window behind the user's own (showTab) — and is remembered, so later crawls of
 * it open there right away.
 *
 * Several servers share the window, but each tab belongs to the server that opened it: one server can't
 * drive (or close) another's tabs.
 */

const CLOSE_WHEN_IDLE_MS = 60_000;
/** The page the crawl window opens with — explains what the window is. */
const PLACEHOLDER = "/crawling.html";

interface Place {
  mode: TabMode;
  windowId: number;
  /** group mode: the tab group. */
  groupId?: number;
}

let place: Place | null = null;
/** The visible window for sites that need rendering, when the user's mode hides pages. */
let visible: Place | null = null;
/** Crawl tab → the server (ServerEntry id) that opened it. */
const tabs = new Map<number, string>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function windowExists(id: number) {
  return chrome.windows.get(id).then(
    () => true,
    () => false,
  );
}

async function ensurePlace(mode: TabMode): Promise<Place> {
  if (place && place.mode === mode && (await windowExists(place.windowId))) return place;
  place = await createPlace(mode);
  return place;
}

async function ensureVisiblePlace(): Promise<Place> {
  if (place?.mode === "background" && (await windowExists(place.windowId))) return place;
  if (visible && (await windowExists(visible.windowId))) return visible;
  visible = await createPlace("background");
  return visible;
}

async function createPlace(mode: TabMode): Promise<Place> {
  if (mode === "group") {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    const windowId = win?.id ?? (await chrome.windows.create({ focused: false, url: chrome.runtime.getURL(PLACEHOLDER) }))?.id;
    if (windowId == null) throw new Error("Couldn't open a window for crawling");
    return { mode, windowId };
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(PLACEHOLDER),
    focused: false,
    ...(mode === "minimized" ? { state: "minimized" as const } : { width: 1280, height: 900, state: "normal" as const }),
  });
  if (win?.id == null) throw new Error("Couldn't open a window for crawling");
  // Some Chrome builds open it normal despite `state` — minimize explicitly.
  if (mode === "minimized" && win.state !== "minimized") await chrome.windows.update(win.id, { state: "minimized" });
  return { mode, windowId: win.id };
}

/** Pages render (and scroll) in this mode: a normal window's active tab. */
const renders = (mode: TabMode) => mode === "background";

const needsVisible = async (origin: string | undefined) => {
  if (!origin) return false;
  const { autoVisible, visibleSites } = await getSettings();
  return autoVisible && visibleSites.includes(siteOf(new URL(origin).hostname));
};

async function publishCount() {
  await updateState({ openTabs: tabs.size });
}

export async function openCrawlTab(serverId: string, origin?: string): Promise<number> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const { tabMode } = await getSettings();
  const p = !renders(tabMode) && (await needsVisible(origin)) ? await ensureVisiblePlace() : await ensurePlace(tabMode);
  const tab = await chrome.tabs.create({ windowId: p.windowId, url: "about:blank", active: false });
  const tabId = tab.id!;
  if (p.mode === "group") {
    const groupStillThere = p.groupId != null && (await chrome.tabGroups.get(p.groupId).then(() => true, () => false));
    p.groupId = await chrome.tabs.group({ tabIds: [tabId], ...(groupStillThere ? { groupId: p.groupId } : { createProperties: { windowId: p.windowId } }) });
    if (!groupStillThere) await chrome.tabGroups.update(p.groupId, { title: "SpecHarvest", color: "cyan", collapsed: true });
  }
  tabs.set(tabId, serverId);
  await publishCount();
  return tabId;
}

/**
 * In a crawl window, the tab being worked on is made the window's visible tab: Chrome throttles hidden tabs
 * (timers, lazy-loading observers), which would leave lazy content unrendered. Never done in group mode —
 * that would switch the user's own tabs.
 */
export async function bringForward(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.windowId !== (place?.mode === "group" ? place.windowId : -1)) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
}

/**
 * The page has to render (a listing that loads items on scroll): move its tab to the visible window, make it
 * the tab shown there, and remember the site. Nothing to do when the user's mode already renders pages.
 */
export async function showTab(tabId: number): Promise<{ moved: boolean; visible: boolean }> {
  const tab = await chrome.tabs.get(tabId);
  if (renders((await getSettings()).tabMode)) return { moved: false, visible: true };
  if (tab.url && /^https?:/.test(tab.url)) await rememberSite(tab.url, true);
  return { moved: await moveToVisible(tabId), visible: true };
}

/** Moves a crawl tab into the visible window and shows it there; false when it already was. */
export async function moveToVisible(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId);
  const target = await ensureVisiblePlace();
  if (tab.windowId === target.windowId) return false;
  if (tab.groupId != null && tab.groupId >= 0) await chrome.tabs.ungroup(tabId).catch(() => {});
  await chrome.tabs.move(tabId, { windowId: target.windowId, index: -1 });
  await chrome.tabs.update(tabId, { active: true });
  return true;
}

/** Puts a tab moved by moveToVisible back where the user's mode keeps crawl tabs. */
export async function returnTab(tabId: number) {
  const { tabMode } = await getSettings();
  const p = await ensurePlace(tabMode);
  await chrome.tabs.move(tabId, { windowId: p.windowId, index: -1 });
  if (p.mode === "group" && p.groupId != null) await chrome.tabs.group({ tabIds: [tabId], groupId: p.groupId }).catch(() => {});
  else if (p.mode !== "group") await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  // The visible window was only there for this check: close it if no crawl tab is left in it.
  if (visible && visible !== place) {
    const left = await chrome.tabs.query({ windowId: visible.windowId });
    if (!left.some((t) => t.id != null && tabs.has(t.id))) {
      await chrome.windows.remove(visible.windowId).catch(() => {});
      visible = null;
    }
  }
}

/** Whether pages of `url`'s site need a visible window (true), don't (false), or haven't been checked (null). */
export async function siteNeedsVisible(url: string): Promise<boolean | null> {
  const site = siteOf(new URL(url).hostname);
  const { visibleSites, hiddenOkSites } = await getSettings();
  return visibleSites.includes(site) ? true : hiddenOkSites.includes(site) ? false : null;
}

export async function rememberSite(url: string, needsVisible: boolean) {
  const site = siteOf(new URL(url).hostname);
  const { visibleSites, hiddenOkSites } = await getSettings();
  await saveSettings({
    visibleSites: needsVisible ? [...new Set([...visibleSites, site])] : visibleSites.filter((s) => s !== site),
    hiddenOkSites: needsVisible ? hiddenOkSites.filter((s) => s !== site) : [...new Set([...hiddenOkSites, site])],
  });
}

export const pagesRender = async () => renders((await getSettings()).tabMode);

/** Whether `tabId` is a crawl tab `serverId` opened. */
export const isCrawlTab = (tabId: number, serverId: string) => tabs.get(tabId) === serverId;

export async function closeCrawlTab(tabId: number) {
  tabs.delete(tabId);
  await chrome.tabs.remove(tabId).catch(() => {});
  await publishCount();
  if (tabs.size === 0) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closePlaceIfIdle, CLOSE_WHEN_IDLE_MS);
  }
}

async function closePlaceIfIdle() {
  idleTimer = null;
  if (tabs.size > 0) return;
  for (const p of [place, visible]) if (p && p.mode !== "group") await chrome.windows.remove(p.windowId).catch(() => {});
  place = visible = null;
}

/** A server went away: its tabs close, and the crawl window too once no other server has tabs there. */
export async function closeAllCrawlTabs(serverId: string) {
  for (const [id, owner] of [...tabs]) if (owner === serverId) await closeCrawlTab(id);
  if (tabs.size === 0) await closePlaceIfIdle();
}

/** The user closed a crawl tab or the window: forget it. */
export function onTabRemoved(tabId: number) {
  if (tabs.delete(tabId)) void publishCount();
}

export function onWindowRemoved(windowId: number) {
  if (place?.windowId === windowId) place = null;
  if (visible?.windowId === windowId) visible = null;
}
