import { EXTENSION_PROTOCOL, type ExtensionClientMessage, type ExtensionServerMessage } from "@specharvest/shared";
import { closeAllCrawlTabs } from "./crawl-tabs.ts";
import { handleCommand, OpError } from "./ops.ts";
import { findServer, getSettings, patchServer, tabShares, updateServers, type ServerEntry } from "./settings.ts";
import { forgetServerStatus, setServerStatus } from "./state.ts";

/**
 * One socket per paired SpecHarvest server. Each server sends commands, this answers them. The 20 s
 * heartbeat also keeps the MV3 service worker alive while connected (Chrome 116+); an alarm restarts the
 * connections if the worker was stopped anyway. The browser-wide tab limit is split between the servers
 * that are online (tabShares), and each is told its share.
 */

const PING_MS = 20_000;
/** No message from the server for this long: the socket is half-open (tunnel dropped silently) — drop it. */
const SILENCE_MS = 2 * PING_MS;
/** A handshake still pending after this long is abandoned so the retry path can run. */
const CONNECT_TIMEOUT_MS = 10_000;
/** The health check before each connect: a server that doesn't answer in this long counts as down. */
const PROBE_TIMEOUT_MS = 5_000;
/** Matches the 30 s keepalive alarm, so a restarted server is picked up within about that. */
const MAX_BACKOFF_MS = 30_000;
/** `bye` codes a retry with the same token can't fix; the others (timeout) are retried like any drop. */
const FINAL_BYE = new Set(["bad_token", "revoked", "outdated", "replaced"]);

const wsUrl = (serverUrl: string) => serverUrl.replace(/^http/, "ws") + "/api/extension/ws";

/**
 * Is the server up? Checked before each socket attempt: Chrome logs every failed WebSocket handshake as an
 * extension error (uncatchable), so while the server or tunnel is down a quiet fetch fails instead.
 */
async function serverUp(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(serverUrl + "/api/health", { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

const connections = new Map<string, ServerConnection>();
/** Servers that said welcome on their current socket. */
const online = new Set<string>();

class ServerConnection {
  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHeardAt = 0;
  /** A health check is running: a second ensure() (alarm, startup) waits for it instead of starting another. */
  private probing = false;
  /** Bumped on every disconnect, so a health check that finishes after one doesn't reconnect anyway. */
  private generation = 0;
  private backoff = 1_000;
  /** The tab limit last told to the server. */
  private sentShare: number | null = null;
  /** Set when the server or the user ended the connection for a reason a retry won't fix. */
  stopped = false;

  constructor(readonly id: string) {}

  send(msg: ExtensionClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  /** Tells the server its tab limit (and the visible-window setting) when either changed. */
  async pushSettings(share: number, autoVisible: boolean, force = false) {
    if (!online.has(this.id) || (!force && share === this.sentShare)) return;
    this.sentShare = share;
    this.send({ type: "settings", concurrency: share, autoVisible });
  }

  private async onCommand(id: number, command: Extract<ExtensionServerMessage, { type: "command" }>["command"]) {
    try {
      const result = await handleCommand(this.id, command);
      this.send({ type: "reply", id, ok: true, result: result ?? null });
    } catch (err) {
      if (err instanceof OpError) this.send({ type: "reply", id, ok: false, code: err.code, message: err.message.slice(0, 2000), origin: err.origin });
      else this.send({ type: "reply", id, ok: false, code: "script_failed", message: String((err as Error)?.message ?? err).slice(0, 2000) });
    }
  }

  private async onMessage(raw: string) {
    this.lastHeardAt = Date.now();
    let msg: ExtensionServerMessage;
    try {
      msg = JSON.parse(raw) as ExtensionServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        this.backoff = 1_000;
        online.add(this.id);
        await patchServer(this.id, { email: msg.email, deviceName: msg.deviceName });
        await setServerStatus(this.id, "online");
        // One more server online: the automatic shares of the others shrink.
        await pushShares();
        return;
      case "command":
        return this.onCommand(msg.id, msg.command);
      case "bye": {
        // Retrying with the same token can't help after these; a replaced connection stays off until asked.
        // Anything else (a heartbeat timeout after sleep) is retried when the socket closes.
        if (!FINAL_BYE.has(msg.code)) return;
        this.stopped = true;
        const signedOut = msg.code === "bad_token" || msg.code === "revoked";
        if (signedOut) await patchServer(this.id, { token: "", email: "" });
        await setServerStatus(this.id, signedOut ? "unconfigured" : "error", msg.reason);
        return;
      }
      case "pong":
        return;
    }
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.pingTimer = this.retryTimer = this.connectTimer = null;
  }

  private scheduleRetry(serverUrl: string) {
    void setServerStatus(this.id, "offline", `Can't reach ${new URL(serverUrl).host} — retrying`);
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        void this.ensure();
      },
      this.backoff * (0.8 + Math.random() * 0.4),
    );
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
  }

  /** Connects if signed in and not already (re)connecting. Safe to call often (alarms, startup, settings). */
  async ensure(): Promise<void> {
    if (this.stopped || this.probing || this.retryTimer || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
    const server = await findServer(this.id);
    if (!server) return;
    if (!server.token) {
      await setServerStatus(this.id, "unconfigured");
      return;
    }
    await setServerStatus(this.id, "connecting");
    const gen = this.generation;
    this.probing = true;
    const up = await serverUp(server.serverUrl).finally(() => (this.probing = false));
    if (this.stopped) return;
    // A reconnect() came in meanwhile (and returned early, since this check was running): start over with its settings.
    if (gen !== this.generation) return this.ensure();
    if (this.retryTimer || this.socket) return;
    if (!up) return this.scheduleRetry(server.serverUrl);
    this.open(server, await shareFor(this.id));
  }

  private open(server: ServerEntry, share: { concurrency: number; autoVisible: boolean }) {
    const ws = new WebSocket(wsUrl(server.serverUrl));
    this.socket = ws;
    // A handshake that never completes would otherwise block every later ensure() (readyState 0).
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.socket === ws && ws.readyState === WebSocket.CONNECTING) ws.close();
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.lastHeardAt = Date.now();
      this.sentShare = share.concurrency;
      ws.send(JSON.stringify({ type: "hello", token: server.token, protocol: EXTENSION_PROTOCOL, version: chrome.runtime.getManifest().version, ...share }));
      this.pingTimer = setInterval(() => {
        // Half-open socket: still "open" here, long gone on the server. Closing it runs the retry below.
        if (Date.now() - this.lastHeardAt > SILENCE_MS) return ws.close();
        this.send({ type: "ping" });
      }, PING_MS);
    };
    // Only the current socket counts: a "bye: replaced" arriving on one we already dropped must not stop the new one.
    ws.onmessage = (e) => {
      if (this.socket === ws) void this.onMessage(String(e.data));
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.clearTimers();
      this.wentOffline();
      if (!this.stopped) this.scheduleRetry(server.serverUrl);
    };
  }

  /** Pages this server had open are of no use to anyone now; its tab share goes back to the others. */
  private wentOffline() {
    void closeAllCrawlTabs(this.id);
    if (online.delete(this.id)) void pushShares();
  }

  /** Drops the socket (and this server's tabs). */
  disconnect() {
    this.generation++;
    this.clearTimers();
    const ws = this.socket;
    this.socket = null;
    ws?.close();
    this.wentOffline();
  }
}

/** The tab limit a server gets once it's online (it's counted as online already). */
async function shareFor(id: string) {
  const s = await getSettings();
  return { concurrency: tabShares(s, [...online, id]).get(id) ?? 1, autoVisible: s.autoVisible };
}

/** Tells every online server its current share (after one came or went, or the limits changed). */
async function pushShares(force = false) {
  const s = await getSettings();
  const shares = tabShares(s, online);
  for (const [id, conn] of connections) await conn.pushSettings(shares.get(id) ?? 1, s.autoVisible, force);
}

function connectionFor(id: string) {
  let conn = connections.get(id);
  if (!conn) connections.set(id, (conn = new ServerConnection(id)));
  return conn;
}

/** Connects every paired server that isn't connected yet. Safe to call often (alarms, startup). */
export async function ensureAllConnected() {
  const { servers } = await getSettings();
  const ids = new Set(servers.map((x) => x.id));
  for (const [id, conn] of connections) {
    if (ids.has(id)) continue;
    conn.stopped = true;
    conn.disconnect();
    connections.delete(id);
  }
  await Promise.all(servers.map((x) => connectionFor(x.id).ensure()));
}

/** Drops a server's connection and connects again (after pairing, or the user asked). */
export async function reconnect(id: string) {
  const conn = connectionFor(id);
  conn.stopped = false;
  conn.disconnect();
  await conn.ensure();
}

/** Forgets a server: closes its connection and its tabs, and removes it from the list. */
export async function removeServer(id: string) {
  const conn = connections.get(id);
  if (conn) {
    conn.stopped = true;
    conn.disconnect();
    connections.delete(id);
  }
  await updateServers((list) => list.filter((x) => x.id !== id));
  await forgetServerStatus(id);
  await pushShares();
}

/** The tab limits or the visible-window setting changed: tell the servers without reconnecting. */
export async function pushSettings() {
  await pushShares(true);
}

/** A site was allowed: every server with a crawl waiting for it can go on. */
export function notifyPermissionGranted(origin: string) {
  for (const conn of connections.values()) conn.send({ type: "permissionGranted", origin });
}
