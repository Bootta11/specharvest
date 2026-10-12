import type { SQLInputValue } from "node:sqlite";
import { EXTENSION_TOKEN_PREFIX, type ApiKeyCreated, type ApiKeySummary, type ExtensionDevice } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { hashToken, randomToken } from "./crypto.ts";

type Row = Record<string, SQLInputValue>;

const KEY_PREFIX = "shk_";

function toSummary(r: Row): ApiKeySummary {
  return {
    id: Number(r.id),
    label: String(r.label),
    keyPrefix: String(r.key_prefix),
    createdAt: Number(r.created_at),
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
  };
}

/** The full key is only in this return value — only its hash is stored. */
export function createApiKey(userId: number, label: string): ApiKeyCreated {
  const key = randomToken(KEY_PREFIX);
  const res = db
    .getDb()
    .prepare("INSERT INTO api_keys (user_id, label, key_hash, key_prefix, created_at, kind) VALUES (?, ?, ?, ?, ?, 'api')")
    .run(userId, label, hashToken(key), key.slice(0, KEY_PREFIX.length + 8), Date.now());
  const row = db.getDb().prepare("SELECT * FROM api_keys WHERE id = ?").get(Number(res.lastInsertRowid)) as Row;
  return { ...toSummary(row), key };
}

export function listApiKeys(userId: number): ApiKeySummary[] {
  return (db.getDb().prepare("SELECT * FROM api_keys WHERE user_id = ? AND kind = 'api' AND revoked_at IS NULL ORDER BY id DESC").all(userId) as Row[]).map(toSummary);
}

/** False when the key doesn't exist, isn't the user's, or was already revoked. */
export function revokeApiKey(userId: number, id: number): boolean {
  return Number(db.getDb().prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND kind = 'api' AND revoked_at IS NULL").run(Date.now(), id, userId).changes) > 0;
}

export type KeyKind = "api" | "extension";

export interface VerifiedKey {
  userId: number;
  keyId: number;
  kind: KeyKind;
}

/** An `X-Api-Key` value (API key or extension token); null when unknown, revoked or the user is disabled. */
export function verifyKey(raw: string, now = Date.now()): VerifiedKey | null {
  if (!raw.startsWith(KEY_PREFIX) && !raw.startsWith(EXTENSION_TOKEN_PREFIX)) return null;
  const d = db.getDb();
  const r = d
    .prepare("SELECT k.id, k.user_id, k.kind, k.revoked_at, u.disabled_at FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?")
    .get(hashToken(raw)) as Row | undefined;
  if (!r || r.revoked_at != null || r.disabled_at != null) return null;
  d.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, Number(r.id));
  return { userId: Number(r.user_id), keyId: Number(r.id), kind: r.kind === "extension" ? "extension" : "api" };
}

/** The user id for an `X-Api-Key` value; null when unknown, revoked or the user is disabled. */
export function verifyApiKey(raw: string, now = Date.now()): number | null {
  return verifyKey(raw, now)?.userId ?? null;
}

// ---------- Extension tokens (connected browsers) ----------

export type DeviceVia = ExtensionDevice["via"];

function toDevice(r: Row, online: (keyId: number) => boolean): ExtensionDevice {
  return {
    id: Number(r.id),
    name: String(r.device_name ?? r.label),
    via: r.via === "approve" ? "approve" : "token",
    keyPrefix: String(r.key_prefix),
    createdAt: Number(r.created_at),
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    online: online(Number(r.id)),
  };
}

/** A token for one browser's extension. The full token is only in this return value. */
export function createExtensionToken(userId: number, deviceName: string, via: DeviceVia): { token: string; device: ExtensionDevice } {
  const token = randomToken(EXTENSION_TOKEN_PREFIX);
  const res = db
    .getDb()
    .prepare("INSERT INTO api_keys (user_id, label, key_hash, key_prefix, created_at, kind, device_name, via) VALUES (?, ?, ?, ?, ?, 'extension', ?, ?)")
    .run(userId, `Browser: ${deviceName}`, hashToken(token), token.slice(0, EXTENSION_TOKEN_PREFIX.length + 8), Date.now(), deviceName, via);
  const row = db.getDb().prepare("SELECT * FROM api_keys WHERE id = ?").get(Number(res.lastInsertRowid)) as Row;
  return { token, device: toDevice(row, () => false) };
}

export function listExtensionTokens(userId: number, online: (keyId: number) => boolean = () => false): ExtensionDevice[] {
  return (
    db.getDb().prepare("SELECT * FROM api_keys WHERE user_id = ? AND kind = 'extension' AND revoked_at IS NULL ORDER BY id DESC").all(userId) as Row[]
  ).map((r) => toDevice(r, online));
}

/** The browser name of an extension token (null for an API key or unknown id). */
export function extensionDeviceName(keyId: number): string | null {
  const r = db.getDb().prepare("SELECT device_name FROM api_keys WHERE id = ? AND kind = 'extension'").get(keyId) as Row | undefined;
  return r?.device_name == null ? null : String(r.device_name);
}

/** False when the token doesn't exist, isn't the user's, or was already revoked. */
export function revokeExtensionToken(userId: number, id: number): boolean {
  return (
    Number(
      db.getDb().prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND kind = 'extension' AND revoked_at IS NULL").run(Date.now(), id, userId).changes,
    ) > 0
  );
}
