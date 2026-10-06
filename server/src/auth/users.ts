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
