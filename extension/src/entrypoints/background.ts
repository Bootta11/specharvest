import { onTabRemoved, onWindowRemoved } from "../lib/crawl-tabs.ts";
import { ensureAllConnected, notifyPermissionGranted, pushSettings, reconnect, removeServer } from "../lib/connection.ts";
import { forgetTab, trackNetwork } from "../lib/network.ts";
import { cancelPairing, startPairing } from "../lib/pairing.ts";
import { clearGranted, onNotificationClicked, refreshBadge } from "../lib/permissions.ts";
import { getState, type BackgroundRequest } from "../lib/state.ts";

export default defineBackground(() => {
  // Listeners are registered synchronously at startup, as MV3 requires for events to wake the worker.
  trackNetwork();

  chrome.tabs.onRemoved.addListener((tabId) => {
    onTabRemoved(tabId);
    forgetTab(tabId);
  });
  chrome.windows.onRemoved.addListener(onWindowRemoved);
  chrome.notifications.onClicked.addListener(onNotificationClicked);

  // A site was allowed (popup, grant page or Chrome's own settings): a crawl waiting for it can go on.
  chrome.permissions.onAdded.addListener((p) => {
    const hosts = new Set((p.origins ?? []).map((pattern) => /^[a-z*]+:\/\/(?:\*\.)?([^/]+)\//.exec(pattern)?.[1]));
    // All sites: "*" isn't a site — tell the servers about every site a crawl is waiting for instead.
    const allSites = hosts.delete("*");
    void getState().then(async (s) => {
      if (allSites) for (const { origin } of s.pendingPermissions) notifyPermissionGranted(origin);
      await clearGranted();
    });
    for (const host of hosts) if (host) notifyPermissionGranted(`https://${host}`);
  });

  chrome.runtime.onMessage.addListener((msg: BackgroundRequest, _sender, respond) => {
    const done = (p: Promise<unknown>) => {
      p.then(() => respond({ ok: true }), (err) => respond({ ok: false, error: String(err?.message ?? err) }));
      return true;
    };
    switch (msg.type) {
      case "reconnect":
        return done(reconnect(msg.serverId));
      case "removeServer":
        return done(removeServer(msg.serverId));
      case "startPairing":
        // Polls for minutes — answer right away, the pages watch the shared state.
        void startPairing(msg.serverUrl, msg.deviceName);
        respond({ ok: true });
        return false;
      case "cancelPairing":
        cancelPairing();
        respond({ ok: true });
        return false;
      case "settingsChanged":
        // Tab limits may have changed, and a server added with an API key needs connecting.
        return done(pushSettings().then(ensureAllConnected));
    }
    return false;
  });

  // Revives the connection if Chrome stopped the worker (or the network dropped) while idle.
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "keepalive") void ensureAllConnected();
  });
  chrome.runtime.onStartup.addListener(() => void ensureAllConnected());
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") void chrome.runtime.openOptionsPage();
  });

  void getState().then((s) => refreshBadge(s.pendingPermissions.length));
  void ensureAllConnected();
});
