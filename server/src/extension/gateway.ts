import type { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  EXTENSION_PROTOCOL,
  extensionClientMessageSchema,
  extensionHelloSchema,
  type ExtensionCommand,
  type ExtensionErrorCode,
  type ExtensionServerMessage,
  type ExtensionStatus,
} from "@specharvest/shared";
import { extensionDeviceName, verifyKey } from "../auth/api-keys.ts";
import { getUser } from "../auth/users.ts";
import { FatalDriverError } from "../crawler/driver.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { publish } from "../sse/hub.ts";

/**
 * The user's browser extension connects here and the crawler drives it (extension/driver.ts). One
 * connection per user: a newer one replaces the older. The socket authenticates with its first message
 * (browsers can't set headers on a WebSocket), and the token is checked again on every heartbeat, so a
 * revoked token or a disabled user is cut off within a minute.
 */

const log = createLogger("extension");

/** Emitted on the jobs feed channel; the hub filter shows each user only their own. */
export const EXTENSION_FEED_CHANNEL = "jobs";

const HELLO_TIMEOUT_MS = 5_000;
/** The extension pings every 20 s; silence for this long means the browser is gone. */
const IDLE_TIMEOUT_MS = 60_000;

export class ExtensionOfflineError extends FatalDriverError {}

/** A command the extension answered with an error. */
export class ExtensionCommandError extends Error {
  constructor(
    readonly code: ExtensionErrorCode,
    message: string,
    readonly origin?: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface Connection {
  userId: number;
  keyId: number;
  deviceName: string;
  version: string;
  concurrency: number;
  /** The user lets crawl tabs move to a visible window when a site needs it (extension setting). */
  autoVisible: boolean;
  socket: WebSocket;
  pending: Map<number, Pending>;
  nextId: number;
  /** Tabs in use / callers waiting for one. */
  active: number;
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  /** Woken when the user grants a site permission. */
  permissionWaiters: Set<() => void>;
  closed: boolean;
}

const connections = new Map<number, Connection>();

const connectListeners = new Set<(userId: number) => void>();
/** Called each time a user's extension connects (after a restart: their held crawls continue, index.ts). */
export function onExtensionConnected(fn: (userId: number) => void) {
  connectListeners.add(fn);
}

export const connectionFor = (userId: number | null): Connection | null => (userId === null ? null : (connections.get(userId) ?? null));

export function extensionStatus(userId: number): ExtensionStatus {
  const c = connections.get(userId);
  return c ? { online: true, deviceName: c.deviceName, version: c.version, concurrency: c.concurrency } : { online: false, deviceName: null, version: null, concurrency: null };
}

export const isKeyOnline = (keyId: number) => [...connections.values()].some((c) => c.keyId === keyId);

function publishStatus(userId: number) {
  publish(EXTENSION_FEED_CHANNEL, { type: "extension", userId, status: extensionStatus(userId) });
}

function sendMessage(socket: WebSocket, msg: ExtensionServerMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function close(c: Connection, reason?: { code: Extract<ExtensionServerMessage, { type: "bye" }>["code"]; text: string }) {
  if (c.closed) return;
  c.closed = true;
  if (reason) sendMessage(c.socket, { type: "bye", code: reason.code, reason: reason.text });
  c.socket.close();
  const gone = new ExtensionOfflineError("Your browser disconnected (Chrome closed, or the SpecHarvest extension stopped)");
  for (const p of c.pending.values()) {
    clearTimeout(p.timer);
    p.reject(gone);
  }
  c.pending.clear();
  for (const w of c.waiters.splice(0)) w.reject(gone);
  for (const wake of c.permissionWaiters) wake();
  if (connections.get(c.userId) === c) {
    connections.delete(c.userId);
    publishStatus(c.userId);
  }
  log.info(`user ${c.userId}: extension disconnected${reason ? ` (${reason.code})` : ""}`);
}

/** Cuts off the browser using this token (it was revoked). */
export function disconnectKey(keyId: number) {
  for (const c of connections.values()) if (c.keyId === keyId) close(c, { code: "revoked", text: "This browser was disconnected from your account" });
}

/** Sends one command and resolves with the extension's result. */
export function sendCommand(c: Connection, command: ExtensionCommand, timeoutMs: number): Promise<unknown> {
  if (c.closed) return Promise.reject(new ExtensionOfflineError("Your browser isn't connected"));
  const id = c.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(new ExtensionCommandError("timeout", `Your browser didn't answer "${command.op}" within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    c.pending.set(id, { resolve, reject, timer });
    sendMessage(c.socket, { type: "command", id, command });
  });
}

export async function acquireTab(c: Connection) {
  if (c.closed) throw new ExtensionOfflineError("Your browser isn't connected");
  if (c.active < c.concurrency) {
    c.active++;
    return;
  }
  await new Promise<void>((resolve, reject) => c.waiters.push({ resolve, reject }));
  c.active++;
}

export function releaseTab(c: Connection) {
  c.active--;
  if (c.active < c.concurrency) c.waiters.shift()?.resolve();
}

/**
 * Resolves true when the user grants a site permission (any — the caller re-checks); false after `timeoutMs`,
 * when `signal` aborts, or when the browser disconnects.
 */
export function waitForPermissionGrant(c: Connection, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (granted: boolean) => {
      clearTimeout(timer);
      c.permissionWaiters.delete(wake);
      signal?.removeEventListener("abort", abort);
      resolve(granted && !c.closed && !signal?.aborted);
    };
    const wake = () => done(true);
    const abort = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    if (signal?.aborted) return done(false);
    signal?.addEventListener("abort", abort, { once: true });
    c.permissionWaiters.add(wake);
  });
}

function onMessage(c: Connection, raw: string) {
  let msg;
  try {
    msg = extensionClientMessageSchema.parse(JSON.parse(raw));
  } catch {
    log.warn(`user ${c.userId}: unreadable extension message`);
    return;
  }
  switch (msg.type) {
    case "ping": {
      // Re-check the token: revoked keys and disabled users lose the connection.
      const key = verifyKey(tokenOf.get(c) ?? "");
      if (!key || key.userId !== c.userId) return close(c, { code: "revoked", text: "This browser was disconnected from your account" });
      sendMessage(c.socket, { type: "pong" });
      return;
    }
    case "settings": {
      c.concurrency = msg.concurrency;
      c.autoVisible = msg.autoVisible;
      while (c.active < c.concurrency && c.waiters.length) c.waiters.shift()!.resolve();
      publishStatus(c.userId);
      return;
    }
    case "permissionGranted": {
      log.info(`user ${c.userId}: site permission granted for ${msg.origin}`);
      for (const wake of [...c.permissionWaiters]) wake();
      return;
    }
    case "reply": {
      const p = c.pending.get(msg.id);
      if (!p) return;
      c.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new ExtensionCommandError(msg.code, msg.message, msg.origin));
    }
  }
}

/** The token each connection authenticated with (kept off the Connection so it is never logged by accident). */
const tokenOf = new WeakMap<Connection, string>();

export async function registerExtensionGateway(app: FastifyInstance) {
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  app.get("/api/extension/ws", { websocket: true }, (socket) => {
    let conn: Connection | null = null;
    let idle: NodeJS.Timeout | null = null;
    const bumpIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        if (conn) close(conn, { code: "timeout", text: "No heartbeat from the extension" });
        else socket.close();
      }, IDLE_TIMEOUT_MS);
    };
    const helloTimer = setTimeout(() => {
      if (!conn) {
        sendMessage(socket, { type: "bye", code: "timeout", reason: "No hello" });
        socket.close();
      }
    }, HELLO_TIMEOUT_MS);
    bumpIdle();

    socket.on("message", (data) => {
      bumpIdle();
      const raw = data.toString();
      if (conn) return onMessage(conn, raw);
      // First message: hello with the token.
      let hello;
      try {
        hello = extensionHelloSchema.parse(JSON.parse(raw));
      } catch {
        sendMessage(socket, { type: "bye", code: "bad_token", reason: "Expected a hello message" });
        return socket.close();
      }
      clearTimeout(helloTimer);
      if (hello.protocol !== EXTENSION_PROTOCOL) {
        sendMessage(socket, { type: "bye", code: "outdated", reason: "Update the SpecHarvest extension — this server speaks a different version" });
        return socket.close();
      }
      const key = verifyKey(hello.token);
      const user = key ? getUser(key.userId) : null;
      if (!key || !user) {
        sendMessage(socket, { type: "bye", code: "bad_token", reason: "This token isn't valid any more — connect the extension again" });
        return socket.close();
      }
      const previous = connections.get(user.id);
      if (previous) close(previous, { code: "replaced", text: "Another browser connected to your account" });
      conn = {
        userId: user.id,
        keyId: key.keyId,
        deviceName: extensionDeviceName(key.keyId) ?? "Chrome (API key)",
        version: hello.version,
        concurrency: hello.concurrency,
        autoVisible: hello.autoVisible,
        socket,
        pending: new Map(),
        nextId: 1,
        active: 0,
        waiters: [],
        permissionWaiters: new Set(),
        closed: false,
      };
      tokenOf.set(conn, hello.token);
      connections.set(user.id, conn);
      sendMessage(socket, { type: "welcome", email: user.email, deviceName: conn.deviceName });
      publishStatus(user.id);
      log.info(`user ${user.id}: extension ${hello.version} connected (${conn.deviceName}, ${hello.concurrency} tabs)`);
      for (const fn of connectListeners) {
        try {
          fn(user.id);
        } catch (err) {
          log.warn("extension connect listener failed", errorMessage(err));
        }
      }
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (idle) clearTimeout(idle);
      if (conn) close(conn);
    });
    socket.on("error", (err) => log.warn("extension socket error", String(err)));
  });
}
