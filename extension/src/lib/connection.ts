import { EXTENSION_PROTOCOL, type ExtensionClientMessage, type ExtensionServerMessage } from "@specharvest/shared";
import { closeAllCrawlTabs } from "./crawl-tabs.ts";
import { handleCommand, OpError } from "./ops.ts";
import { getSettings, saveSettings } from "./settings.ts";
import { updateState } from "./state.ts";

/**
 * The socket to the SpecHarvest server. The server sends commands, this answers them. The 20 s heartbeat
 * also keeps the MV3 service worker alive while connected (Chrome 116+); an alarm restarts the connection if
 * the worker was stopped anyway.
 */

const PING_MS = 20_000;
/** No message from the server for this long: the socket is half-open (tunnel dropped silently) — drop it. */
const SILENCE_MS = 2 * PING_MS;
/** A handshake still pending after this long is abandoned so the retry path can run. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Matches the 30 s keepalive alarm, so a restarted server is picked up within about that. */
const MAX_BACKOFF_MS = 30_000;
/** `bye` codes a retry with the same token can't fix; the others (timeout) are retried like any drop. */
const FINAL_BYE = new Set(["bad_token", "revoked", "outdated", "replaced"]);

let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let lastHeardAt = 0;
let backoff = 1_000;
/** Set when the server or the user ended the connection for a reason a retry won't fix. */
let stopped = false;

const wsUrl = (serverUrl: string) => serverUrl.replace(/^http/, "ws") + "/api/extension/ws";

function send(msg: ExtensionClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

async function onCommand(id: number, command: Extract<ExtensionServerMessage, { type: "command" }>["command"]) {
  try {
    const result = await handleCommand(command);
    send({ type: "reply", id, ok: true, result: result ?? null });
  } catch (err) {
    if (err instanceof OpError) send({ type: "reply", id, ok: false, code: err.code, message: err.message.slice(0, 2000), origin: err.origin });
    else send({ type: "reply", id, ok: false, code: "script_failed", message: String((err as Error)?.message ?? err).slice(0, 2000) });
  }
}

async function onMessage(raw: string) {
  lastHeardAt = Date.now();
  let msg: ExtensionServerMessage;
  try {
    msg = JSON.parse(raw) as ExtensionServerMessage;
  } catch {
    return;
  }
  switch (msg.type) {
    case "welcome":
      backoff = 1_000;
      await saveSettings({ email: msg.email, deviceName: msg.deviceName });
      await updateState({ status: "online", message: "" });
      return;
    case "command":
      return onCommand(msg.id, msg.command);
    case "bye": {
      // Retrying with the same token can't help after these; a replaced connection stays off until asked.
      // Anything else (a heartbeat timeout after sleep) is retried when the socket closes.
      if (!FINAL_BYE.has(msg.code)) return;
      stopped = true;
      if (msg.code === "bad_token" || msg.code === "revoked") await saveSettings({ token: "", email: "" });
      await updateState({ status: msg.code === "bad_token" || msg.code === "revoked" ? "unconfigured" : "error", message: msg.reason });
      return;
    }
    case "pong":
      return;
  }
}

function clearTimers() {
  if (pingTimer) clearInterval(pingTimer);
  if (retryTimer) clearTimeout(retryTimer);
  if (connectTimer) clearTimeout(connectTimer);
  pingTimer = retryTimer = connectTimer = null;
}

/** Connects if configured and not already (re)connecting. Safe to call often (alarms, startup, settings). */
export async function ensureConnected() {
  if (stopped || retryTimer || (socket && socket.readyState <= WebSocket.OPEN)) return;
  const s = await getSettings();
  if (!s.serverUrl || !s.token) {
    await updateState({ status: "unconfigured", message: "" });
    return;
  }
  await updateState({ status: "connecting", message: "" });
  const ws = new WebSocket(wsUrl(s.serverUrl));
  socket = ws;
  // A handshake that never completes would otherwise block every later ensureConnected() (readyState 0).
  connectTimer = setTimeout(() => {
    connectTimer = null;
    if (socket === ws && ws.readyState === WebSocket.CONNECTING) ws.close();
  }, CONNECT_TIMEOUT_MS);
  ws.onopen = () => {
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
    lastHeardAt = Date.now();
    ws.send(JSON.stringify({ type: "hello", token: s.token, protocol: EXTENSION_PROTOCOL, version: chrome.runtime.getManifest().version, concurrency: s.concurrency, autoVisible: s.autoVisible }));
    pingTimer = setInterval(() => {
      // Half-open socket: still "open" here, long gone on the server. Closing it runs the retry below.
      if (Date.now() - lastHeardAt > SILENCE_MS) return ws.close();
      send({ type: "ping" });
    }, PING_MS);
  };
  // Only the current socket counts: a "bye: replaced" arriving on one we already dropped must not stop the new one.
  ws.onmessage = (e) => {
    if (socket === ws) void onMessage(String(e.data));
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    clearTimers();
    // Pages the server had open are of no use to anyone now.
    void closeAllCrawlTabs();
    if (stopped) return;
    void updateState({ status: "offline", message: `Can't reach ${new URL(s.serverUrl).host} — retrying` });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void ensureConnected();
    }, backoff * (0.8 + Math.random() * 0.4));
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  };
}

/** Drops the connection and connects again (after settings changed, or the user asked). */
export async function reconnect() {
  stopped = false;
  backoff = 1_000;
  disconnectSocket();
  await ensureConnected();
}

function disconnectSocket() {
  clearTimers();
  const ws = socket;
  socket = null;
  ws?.close();
  void closeAllCrawlTabs();
}

/** Signs this browser out: forgets the token and closes the connection. */
export async function disconnect() {
  stopped = true;
  disconnectSocket();
  await saveSettings({ token: "", email: "" });
  await updateState({ status: "unconfigured", message: "" });
}

/** Tells the server about changed settings (tab limit) without reconnecting. */
export async function pushSettings() {
  const s = await getSettings();
  send({ type: "settings", concurrency: s.concurrency, autoVisible: s.autoVisible });
}

export function notifyPermissionGranted(origin: string) {
  send({ type: "permissionGranted", origin });
}
