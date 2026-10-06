import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { createLogger } from "../lib/logger.ts";
import { temporaryPassword } from "./crypto.ts";
import { createUser, hasAnyUser } from "./users.ts";

const log = createLogger("auth");

/** Creates the first admin from ADMIN_EMAIL (and ADMIN_PASSWORD, else a generated one) when no user exists yet. */
export async function bootstrapAdmin() {
  if (hasAnyUser()) return;
  if (!env.ADMIN_EMAIL) {
    log.warn("No users yet — run `npm run seed:admin -- --email you@example.com` or set ADMIN_EMAIL to create the first admin");
    return;
  }
  const password = env.ADMIN_PASSWORD ?? temporaryPassword();
  const admin = await createUser(env.ADMIN_EMAIL, password, "admin");
  const assigned = db.assignOrphansTo(admin.id);
  log.info(`Created admin ${admin.email}${assigned ? ` (took over ${assigned} existing collections)` : ""}`);
  if (!env.ADMIN_PASSWORD) log.info(`Generated admin password (shown once — change it under Account): ${password}`);
}
