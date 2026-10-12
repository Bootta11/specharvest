import { onTabRemoved, onWindowRemoved } from "../lib/crawl-tabs.ts";
import { disconnect, ensureConnected, notifyPermissionGranted, pushSettings, reconnect } from "../lib/connection.ts";
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
    void clearGranted();
    const hosts = new Set((p.origins ?? []).map((pattern) => /^[a-z*]+:\/\/(?:\*\.)?([^/]+)\//.exec(pattern)?.[1]));
    for (const host of hosts) if (host) notifyPermissionGranted(`https://${host}`);
  });

  chrome.runtime.onMessage.addListener((msg: BackgroundRequest, _sender, respond) => {
    const done = (p: Promise<unknown>) => {
      p.then(() => respond({ ok: true }), (err) => respond({ ok: false, error: String(err?.message ?? err) }));
      return true;
    };
    switch (msg.type) {
      case "reconnect":
        return done(reconnect());
      case "disconnect":
        return done(disconnect());
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
        return done(pushSettings());
    }
    return false;
  });

  // Revives the connection if Chrome stopped the worker (or the network dropped) while idle.
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "keepalive") void ensureConnected();
  });
  chrome.runtime.onStartup.addListener(() => void ensureConnected());
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") void chrome.runtime.openOptionsPage();
  });

  void getState().then((s) => refreshBadge(s.pendingPermissions.length));
  void ensureConnected();
});
