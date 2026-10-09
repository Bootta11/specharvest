import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserSchema, loginSchema, serverLlmAccessModes, signupSchema, updateAccountSchema, type AdminSettings, type AuthStatus, type UserCreated, type UserSummary } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { httpError } from "../lib/http-error.ts";
import { serverDailyLimitUsd, serverLlmAccess, setServerDailyLimitUsd, setServerLlmAccess } from "../llm/resolve.ts";
import { createApiKey, listApiKeys, revokeApiKey } from "./api-keys.ts";
import { hashToken, temporaryPassword } from "./crypto.ts";
import { currentUser, isAppClient, requireAdmin, SESSION_COOKIE, sessionCookieOptions } from "./plugin.ts";
import { createSession, revokeSession } from "./sessions.ts";
import { createUser, getUser, listUsers, setUserDisabled, toSummary, updateOwnAccount, verifyLogin } from "./users.ts";

const SIGNUP_KEY = "auth.signupEnabled";
const signupEnabled = () => db.getSetting<boolean>(SIGNUP_KEY) === true;

const adminSettings = (): AdminSettings => ({
  signupEnabled: signupEnabled(),
  serverLlmAccess: serverLlmAccess(),
  serverLlmDailyLimitUsd: serverDailyLimitUsd(),
  serverLlmConfigured: !!env.OPENROUTER_API_KEY,
});
const adminSettingsSchema = z.object({
  signupEnabled: z.boolean().optional(),
  serverLlmAccess: z.enum(serverLlmAccessModes).optional(),
  serverLlmDailyLimitUsd: z.number().min(0).max(1000).optional(),
});

const idParam = (p: unknown) => z.coerce.number().int().positive().parse((p as { id?: string }).id);

/** Brute-force guard for the credential endpoints (per IP). */
const credentialLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

/**
 * Starts a session: the browser gets the httpOnly cookie; the Android app (X-SpecHarvest-Client: app) gets the
 * token in the body and sends it back as `Authorization: Bearer` — no cookie crosses origins.
 */
function signIn(req: FastifyRequest, reply: FastifyReply, user: UserSummary) {
  const { rawToken } = createSession(user.id);
  if (isAppClient(req)) return { user, token: rawToken };
  reply.setCookie(SESSION_COOKIE, rawToken, sessionCookieOptions());
  return user;
}

export function registerAuthRoutes(app: FastifyInstance) {
  // ---------- Public ----------

  app.get("/api/auth/status", async (): Promise<AuthStatus> => ({ signupEnabled: signupEnabled() }));

  app.post("/api/auth/login", credentialLimit, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await verifyLogin(body.email, body.password);
    if (!user) return reply.status(401).send({ error: "Invalid email or password" });
    return signIn(req, reply, toSummary(user));
  });

  app.post("/api/auth/signup", credentialLimit, async (req, reply) => {
    if (!signupEnabled()) return reply.status(403).send({ error: "Sign-up is disabled — ask an admin for an account" });
    const body = signupSchema.parse(req.body);
    const user = await createUser(body.email, body.password, "user");
    return signIn(req, reply, user);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE] ?? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (token) revokeSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  // ---------- Signed in ----------

  app.get("/api/auth/me", async (req) => toSummary(getUser(currentUser(req).id)!));

  // Checks the current password, so it's rate limited like login.
  app.patch("/api/auth/me", credentialLimit, async (req) => {
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
    return adminSettings();
  });

  app.put("/api/settings/admin", async (req): Promise<AdminSettings> => {
    requireAdmin(req);
    const body = adminSettingsSchema.parse(req.body);
    if (body.signupEnabled !== undefined) db.setSetting(SIGNUP_KEY, body.signupEnabled);
    // Who may use the server's LLM key when they have no key of their own, and how much a day (llm/resolve.ts).
    if (body.serverLlmAccess !== undefined) setServerLlmAccess(body.serverLlmAccess);
    if (body.serverLlmDailyLimitUsd !== undefined) setServerDailyLimitUsd(body.serverLlmDailyLimitUsd);
    return adminSettings();
  });
}
