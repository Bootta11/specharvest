import { originPatterns, siteOf } from "./url-guard.ts";
import { getState, updateState } from "./state.ts";

/**
 * Site access is asked for per site, when a crawl first needs it (optional host permissions). Chrome only
 * shows its permission prompt in answer to a click, so a crawl that needs a new site queues the request,
 * shows a notification and a badge, and the user allows it from the notification's page or the popup.
 */

export const hasSitePermission = (url: string) => chrome.permissions.contains({ origins: originPatterns(url, "own") });

/** Asks Chrome for access to `url`'s site. Must run in a click handler (popup / extension page). */
export const requestSitePermission = (url: string) => chrome.permissions.request({ origins: originPatterns(url) });

const NOTIFICATION_PREFIX = "permission:";

/** A crawl needs `origin`: remember it, badge the icon, and notify (once per site until it's answered). */
export async function askForSite(origin: string) {
  const site = siteOf(new URL(origin).hostname);
  const state = await updateState((s) => ({
    pendingPermissions: s.pendingPermissions.some((p) => p.origin === origin) ? s.pendingPermissions : [...s.pendingPermissions, { origin, at: Date.now() }],
  }));
  await refreshBadge(state.pendingPermissions.length);
  chrome.notifications.create(NOTIFICATION_PREFIX + origin, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("/icon/128.png"),
    title: `Allow SpecHarvest on ${site}?`,
    message: "A crawl you started wants to open this site in your browser. Click to allow it.",
    requireInteraction: true,
    priority: 2,
  });
}

/** Opens the small "Allow on <site>" page for a notification the user clicked. */
export function onNotificationClicked(id: string) {
  if (!id.startsWith(NOTIFICATION_PREFIX)) return;
  const origin = id.slice(NOTIFICATION_PREFIX.length);
  chrome.notifications.clear(id);
  void chrome.windows.create({ url: chrome.runtime.getURL(`/grant.html?origin=${encodeURIComponent(origin)}`), type: "popup", width: 420, height: 320, focused: true });
}

/** After a grant (from any page): drop the sites it covers from the pending list. */
export async function clearGranted() {
  const state = await getState();
  const still: typeof state.pendingPermissions = [];
  for (const p of state.pendingPermissions) {
    if (!(await hasSitePermission(p.origin))) still.push(p);
    else chrome.notifications.clear(NOTIFICATION_PREFIX + p.origin);
  }
  await updateState({ pendingPermissions: still });
  await refreshBadge(still.length);
}

export async function refreshBadge(pending?: number) {
  const n = pending ?? 0;
  await chrome.action.setBadgeBackgroundColor({ color: n ? "#b45309" : "#0f766e" });
  await chrome.action.setBadgeText({ text: n ? "!" : "" });
}
