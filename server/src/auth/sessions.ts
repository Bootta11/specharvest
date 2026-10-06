import type { SQLInputValue } from "node:sqlite";
import * as db from "../db/sqlite.ts";
import { hashToken, randomToken } from "./crypto.ts";

type Row = Record<string, SQLInputValue>;

const SESSION_PREFIX = "shs_";
/** Sliding: every use pushes the expiry this far out again. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Don't rewrite the row on every request (SSE, polling) — once a minute is plenty for a 30-day window. */
const TOUCH_EVERY_MS = 60_000;

export function createSession(userId: number): { rawToken: string; expiresAt: number } {
  const rawToken = randomToken(SESSION_PREFIX);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.getDb()
    .prepare("INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, hashToken(rawToken), now, expiresAt, now);
  return { rawToken, expiresAt };
}

/** The user id a session cookie belongs to, sliding its expiry; null when unknown, expired, revoked or the user is disabled. */
export function verifySession(rawToken: string, now = Date.now()): number | null {
  if (!rawToken.startsWith(SESSION_PREFIX)) return null;
  const d = db.getDb();
  const r = d
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.last_used_at, u.disabled_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(hashToken(rawToken)) as Row | undefined;
  if (!r || r.revoked_at != null || r.disabled_at != null || Number(r.expires_at) < now) return null;
  if (now - Number(r.last_used_at ?? 0) > TOUCH_EVERY_MS) {
    d.prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?").run(now, now + SESSION_TTL_MS, Number(r.id));
  }
  return Number(r.user_id);
}

export function revokeSession(rawToken: string) {
  db.getDb().prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(Date.now(), hashToken(rawToken));
}

/** Signs a user out everywhere, optionally keeping one session (by token hash). */
export function revokeAllSessions(userId: number, exceptTokenHash?: string) {
  db.getDb()
    .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND token_hash IS NOT ?")
    .run(Date.now(), userId, exceptTokenHash ?? null);
}

/** Drops sessions that can never be used again (expired or revoked over a day ago). */
export function pruneSessions(now = Date.now()) {
  db.getDb().prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?").run(now, now - 86_400_000);
}
