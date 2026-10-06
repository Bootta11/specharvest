import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createUserSchema, loginSchema, signupSchema, updateAccountSchema, type AdminSettings, type AuthStatus, type UserCreated } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { httpError } from "../lib/http-error.ts";
import { createApiKey, listApiKeys, revokeApiKey } from "./api-keys.ts";
import { hashToken, temporaryPassword } from "./crypto.ts";
import { currentUser, requireAdmin, SESSION_COOKIE, sessionCookieOptions } from "./plugin.ts";
import { createSession, revokeSession } from "./sessions.ts";
import { createUser, getUser, listUsers, setUserDisabled, toSummary, updateOwnAccount, verifyLogin } from "./users.ts";

const SIGNUP_KEY = "auth.signupEnabled";
const signupEnabled = () => db.getSetting<boolean>(SIGNUP_KEY) === true;

const idParam = (p: unknown) => z.coerce.number().int().positive().parse((p as { id?: string }).id);

/** Brute-force guard for the credential endpoints (per IP). */
const credentialLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

export function registerAuthRoutes(app: FastifyInstance) {
  // ---------- Public ----------

  app.get("/api/auth/status", async (): Promise<AuthStatus> => ({ signupEnabled: signupEnabled() }));

  app.post("/api/auth/login", credentialLimit, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await verifyLogin(body.email, body.password);
    if (!user) return reply.status(401).send({ error: "Invalid email or password" });
    reply.setCookie(SESSION_COOKIE, createSession(user.id).rawToken, sessionCookieOptions());
    return toSummary(user);
  });

  app.post("/api/auth/signup", credentialLimit, async (req, reply) => {
    if (!signupEnabled()) return reply.status(403).send({ error: "Sign-up is disabled — ask an admin for an account" });
    const body = signupSchema.parse(req.body);
    const user = await createUser(body.email, body.password, "user");
    reply.setCookie(SESSION_COOKIE, createSession(user.id).rawToken, sessionCookieOptions());
    return user;
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) revokeSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  // ---------- Signed in ----------

  app.get("/api/auth/me", async (req) => toSummary(getUser(currentUser(req).id)!));

  app.patch("/api/auth/me", async (req) => {
    const body = updateAccountSchema.parse(req.body);
    if (!body.email && !body.newPassword) throw httpError(400, "Nothing to change");
    return updateOwnAccount(currentUser(req).id, body, req.sessionToken ? hashToken(req.sessionToken) : undefined);
  });

  app.get("/api/api-keys", async (req) => listApiKeys(currentUser(req).id));

  app.post("/api/api-keys", async (req, reply) => {
    const { label } = z.object({ label: z.string().trim().min(1).max(100) }).parse(req.body);
    return reply.status(201).send(createApiKey(currentUser(req).id, label));
  });

  app.delete("/api/api-keys/:id", async (req, reply) => {
    if (!revokeApiKey(currentUser(req).id, idParam(req.params))) return reply.status(404).send({ error: "Not found" });
    return { ok: true };
  });

  // ---------- Admin ----------

  app.get("/api/users", async (req) => {
    requireAdmin(req);
    return listUsers();
  });

  // No email sending exists — the admin passes the temporary password on.
  app.post("/api/users", async (req, reply) => {
    requireAdmin(req);
    const body = createUserSchema.parse(req.body);
    const password = temporaryPassword();
    const user = await createUser(body.email, password, body.role);
    return reply.status(201).send({ ...user, temporaryPassword: password } satisfies UserCreated);
  });

  app.patch("/api/users/:id", async (req, reply) => {
    const admin = requireAdmin(req);
    const id = idParam(req.params);
    const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
    if (id === admin.id && disabled) throw httpError(400, "You can't disable your own account");
    const user = setUserDisabled(id, disabled);
    return user ?? reply.status(404).send({ error: "Not found" });
  });

  app.get("/api/settings/admin", async (req): Promise<AdminSettings> => {
    requireAdmin(req);
    return { signupEnabled: signupEnabled() };
  });

  app.put("/api/settings/admin", async (req): Promise<AdminSettings> => {
    requireAdmin(req);
    const body = z.object({ signupEnabled: z.boolean() }).parse(req.body);
    db.setSetting(SIGNUP_KEY, body.signupEnabled);
    return { signupEnabled: signupEnabled() };
  });
}
