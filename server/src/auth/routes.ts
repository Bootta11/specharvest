import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { deleteAccountSchema, loginSchema, signupSchema, updateAccountSchema, type AuthStatus, type UserSummary } from "@specharvest/shared";
import { stopCrawl } from "../crawler/job.ts";
import { deleteVectors } from "../db/lance.ts";
import * as db from "../db/sqlite.ts";
import { stopEnrichment } from "../enrich/web.ts";
import { disconnectKey } from "../extension/gateway.ts";
import { httpError } from "../lib/http-error.ts";
import { createApiKey, listApiKeys, listExtensionTokens, revokeApiKey } from "./api-keys.ts";
import { hashToken } from "./crypto.ts";
import { currentUser, isAppClient, SESSION_COOKIE, sessionCookieOptions } from "./plugin.ts";
import { createSession, revokeSession } from "./sessions.ts";
import { activeJobsOf, assertCanDeleteOwnAccount, createUser, deleteUser, getUser, toSummary, updateOwnAccount, verifyLogin } from "./users.ts";

const SIGNUP_KEY = "auth.signupEnabled";
/** Whether anyone may create an account (set from the admin dashboard, admin/users-routes.ts). */
export const signupEnabled = () => db.getSetting<boolean>(SIGNUP_KEY) === true;
export const setSignupEnabled = (enabled: boolean) => db.setSetting(SIGNUP_KEY, enabled);

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

  // Deletes the account and everything it owns (Google Play requires this in the app; see docs/auth.md).
  app.delete("/api/auth/me", credentialLimit, async (req, reply) => {
    const { currentPassword } = deleteAccountSchema.parse(req.body);
    const user = await assertCanDeleteOwnAccount(currentUser(req).id, currentPassword);
    for (const job of activeJobsOf(user.id)) (job.kind === "enrich" ? stopEnrichment : stopCrawl)(job.id);
    for (const device of listExtensionTokens(user.id)) disconnectKey(device.id);
    await deleteVectors(deleteUser(user.id));
    req.log.info(`user ${user.id} deleted their account`);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
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
}
