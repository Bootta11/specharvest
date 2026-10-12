import type { SQLInputValue } from "node:sqlite";
import type { UserRole, UserSummary } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { httpError } from "../lib/http-error.ts";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./crypto.ts";
import { revokeAllSessions } from "./sessions.ts";

type Row = Record<string, SQLInputValue>;

export interface UserRow extends UserSummary {
  passwordHash: string;
}

function toUser(r: Row): UserRow {
  return {
    id: Number(r.id),
    email: String(r.email),
    role: String(r.role) as UserRole,
    disabledAt: r.disabled_at == null ? null : Number(r.disabled_at),
    createdAt: Number(r.created_at),
    passwordHash: String(r.password_hash),
  };
}

export function toSummary({ passwordHash: _, ...user }: UserRow): UserSummary {
  return user;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function getUser(id: number): UserRow | null {
  const r = db.getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
  return r ? toUser(r) : null;
}

export function getUserByEmail(email: string): UserRow | null {
  const r = db.getDb().prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)) as Row | undefined;
  return r ? toUser(r) : null;
}

export function listUsers(): UserSummary[] {
  return (db.getDb().prepare("SELECT * FROM users ORDER BY id").all() as Row[]).map((r) => toSummary(toUser(r)));
}

export function hasAnyUser(): boolean {
  return !!db.getDb().prepare("SELECT 1 FROM users LIMIT 1").get();
}

export async function createUser(email: string, password: string, role: UserRole = "user"): Promise<UserSummary> {
  const e = normalizeEmail(email);
  if (getUserByEmail(e)) throw httpError(409, "A user with that email already exists");
  const passwordHash = await hashPassword(password);
  const res = db.getDb().prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)").run(e, passwordHash, role, Date.now());
  return toSummary(getUser(Number(res.lastInsertRowid))!);
}

/** The user for an email + password, or null (unknown, wrong password, or disabled). */
export async function verifyLogin(email: string, password: string): Promise<UserRow | null> {
  const user = getUserByEmail(email);
  // Hash anyway for unknown emails so timing doesn't reveal which accounts exist.
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyPasswordHash()));
  return user && ok && user.disabledAt === null ? user : null;
}

/** Soft-disable: keeps the user's data, ends their sessions; API keys stop working while disabled. */
export function setUserDisabled(id: number, disabled: boolean): UserSummary | null {
  db.getDb().prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(disabled ? Date.now() : null, id);
  if (disabled) revokeAllSessions(id);
  const user = getUser(id);
  return user ? toSummary(user) : null;
}

export interface UpdateOwnAccountInput {
  currentPassword: string;
  email?: string;
  newPassword?: string;
}

/**
 * Self-service email/password change. Re-checks the current password even with a valid
 * session, so a hijacked session can't be turned into an account takeover. A new password
 * signs out every other session (`keepTokenHash` is the caller's own).
 */
export async function updateOwnAccount(userId: number, input: UpdateOwnAccountInput, keepTokenHash?: string): Promise<UserSummary> {
  const user = getUser(userId);
  if (!user) throw httpError(404, "User not found");
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) throw httpError(401, "Current password is incorrect");
  const email = input.email ? normalizeEmail(input.email) : undefined;
  if (email && email !== user.email && getUserByEmail(email)) throw httpError(409, "A user with that email already exists");
  if (email) db.getDb().prepare("UPDATE users SET email = ? WHERE id = ?").run(email, userId);
  if (input.newPassword) {
    db.getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(input.newPassword), userId);
    revokeAllSessions(userId, keepTokenHash);
  }
  return toSummary(getUser(userId)!);
}

/**
 * Checks that the signed-in user may delete their own account: the right current password, and not the last
 * active admin (the server would be left with nobody to manage it).
 */
export async function assertCanDeleteOwnAccount(userId: number, currentPassword: string): Promise<UserRow> {
  const user = getUser(userId);
  if (!user) throw httpError(404, "User not found");
  if (!(await verifyPassword(currentPassword, user.passwordHash))) throw httpError(401, "Current password is incorrect");
  if (user.role === "admin") {
    const others = db.getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id != ?").get(userId) as Row;
    if (Number(others.n) === 0) throw httpError(409, "You're the only admin — make another user an admin first");
  }
  return user;
}

/** Owner id left on a deleted user's jobs and spend history (real ids start at 1). */
export const DELETED_USER_ID = 0;

/** The user's queued/running jobs, to stop before their account goes. */
export function activeJobsOf(userId: number): { id: number; kind: string }[] {
  return (db.getDb().prepare("SELECT id, kind FROM jobs WHERE user_id = ? AND status IN ('queued','running')").all(userId) as Row[]).map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
  }));
}

/**
 * Removes a user and everything they own: their collections (with items, jobs and caches), per-user settings
 * and push subscriptions. Sessions, API keys, LLM keys, groups and search history go by ON DELETE CASCADE.
 * Spend history (llm_usage) and jobs on other users' collections stay under DELETED_USER_ID — not NULL, which
 * getDb() would hand to the first admin (assignOrphansTo) and count against their daily server-key limit.
 * Returns the deleted item ids, whose vectors the caller removes from LanceDB.
 */
export function deleteUser(userId: number): number[] {
  const d = db.getDb();
  const itemIds: number[] = [];
  d.exec("BEGIN");
  try {
    for (const r of d.prepare("SELECT id FROM collections WHERE user_id = ?").all(userId) as Row[]) itemIds.push(...db.deleteCollection(Number(r.id)));
    db.deleteSetting(`notifications:${userId}`);
    db.deleteSetting(`llm-models:${userId}`);
    d.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").run(userId);
    d.prepare("UPDATE jobs SET user_id = ? WHERE user_id = ?").run(DELETED_USER_ID, userId);
    d.prepare("UPDATE llm_usage SET user_id = ? WHERE user_id = ?").run(DELETED_USER_ID, userId);
    d.prepare("DELETE FROM users WHERE id = ?").run(userId);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  return itemIds;
}
