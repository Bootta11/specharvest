import type { SQLInputValue } from "node:sqlite";
import type { ApiKeyCreated, ApiKeySummary } from "@specharvest/shared";
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
    .prepare("INSERT INTO api_keys (user_id, label, key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, label, hashToken(key), key.slice(0, KEY_PREFIX.length + 8), Date.now());
  const row = db.getDb().prepare("SELECT * FROM api_keys WHERE id = ?").get(Number(res.lastInsertRowid)) as Row;
  return { ...toSummary(row), key };
}

export function listApiKeys(userId: number): ApiKeySummary[] {
  return (db.getDb().prepare("SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC").all(userId) as Row[]).map(toSummary);
}

/** False when the key doesn't exist, isn't the user's, or was already revoked. */
export function revokeApiKey(userId: number, id: number): boolean {
  return Number(db.getDb().prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(Date.now(), id, userId).changes) > 0;
}

/** The user id for an `X-Api-Key` value; null when unknown, revoked or the user is disabled. */
export function verifyApiKey(raw: string, now = Date.now()): number | null {
  if (!raw.startsWith(KEY_PREFIX)) return null;
  const d = db.getDb();
  const r = d
    .prepare("SELECT k.id, k.user_id, k.revoked_at, u.disabled_at FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?")
    .get(hashToken(raw)) as Row | undefined;
  if (!r || r.revoked_at != null || r.disabled_at != null) return null;
  d.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, Number(r.id));
  return Number(r.user_id);
}
