import { parseArgs } from "node:util";
import * as db from "../db/sqlite.ts";
import { temporaryPassword } from "../auth/crypto.ts";
import { createUser, hasAnyUser } from "../auth/users.ts";

// Usage: npm run seed:admin -- --email you@example.com [--password secret]
const { values } = parseArgs({ options: { email: { type: "string" }, password: { type: "string" } } });

if (hasAnyUser()) {
  console.error("A user already exists — refusing to seed another admin. Add users from the app (Users & settings).");
  process.exit(1);
}
if (!values.email) {
  console.error("Usage: npm run seed:admin -- --email you@example.com [--password secret]");
  process.exit(1);
}
if (values.password !== undefined && values.password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const password = values.password ?? temporaryPassword();
const admin = await createUser(values.email, password, "admin");
const assigned = db.assignOrphansTo(admin.id);
console.log(`Created admin "${admin.email}" (id ${admin.id}).`);
if (assigned) console.log(`Existing data (${assigned} collections, their jobs, spend and notification settings) now belongs to this admin.`);
if (!values.password) console.log(`Password (shown once — save it, then change it under Account):\n\n  ${password}\n`);
