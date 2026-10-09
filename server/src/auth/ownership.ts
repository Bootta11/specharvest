import type { Collection } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { httpError } from "../lib/http-error.ts";

/** The signed-in user on a request. */
export interface AuthUser extends db.Viewer {
  email: string;
}

type Owned = Pick<Collection, "ownerId" | "isShared">;

// 404, not 403: someone else's private collection should look exactly like one that doesn't exist.
export function assertReadable(c: Owned, user: db.Viewer): void {
  if (user.role === "admin" || c.ownerId === user.id || c.isShared) return;
  throw httpError(404, "Not found");
}

export function assertWritable(c: Owned, user: db.Viewer): void {
  if (user.role === "admin" || c.ownerId === user.id) return;
  // A shared collection is visible, so say why instead of pretending it's missing.
  if (c.isShared) throw httpError(403, "Only the owner can change a shared collection");
  throw httpError(404, "Not found");
}

/** Loads a collection the user may read (or write); 404/403 otherwise. */
export function requireCollection(id: number, user: db.Viewer, mode: "read" | "write") {
  const c = db.getCollection(id, user);
  if (!c) throw httpError(404, "Not found");
  if (mode === "read") assertReadable(c, user);
  else assertWritable(c, user);
  return c;
}

/** Loads a group of the user's own — groups are private, even to admins. */
export function requireGroup(id: number, user: db.Viewer) {
  const g = db.getGroup(id, user);
  if (!g || g.ownerId !== user.id) throw httpError(404, "Not found");
  return g;
}

/** Loads a job the user may see — jobs are private to whoever started them (and admins). */
export function requireJob(id: number, user: db.Viewer) {
  const job = db.getJob(id);
  if (!job || !db.canSeeJob(job, user)) throw httpError(404, "Not found");
  return job;
}
