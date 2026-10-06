import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyCookie, { type CookieSerializeOptions } from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import { env } from "../config.ts";
import { httpError } from "../lib/http-error.ts";
import { verifyApiKey } from "./api-keys.ts";
import type { AuthUser } from "./ownership.ts";
import { SESSION_TTL_MS, verifySession } from "./sessions.ts";
import { getUser } from "./users.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook on every non-public /api route. */
    user: AuthUser | null;
    /** Raw session cookie the request was authenticated with (null for API keys). */
    sessionToken: string | null;
  }
}

export const SESSION_COOKIE = "specharvest_session";

/** API routes reachable without signing in. */
const PUBLIC_ROUTES = new Set(["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/signup", "/api/auth/logout"]);

/**
 * Same-origin app (Vite proxy in dev, static files from this server in prod) → SameSite=Lax.
 * maxAge mirrors the sliding session TTL so closing the browser doesn't log the user out.
 */
export function sessionCookieOptions(): CookieSerializeOptions {
  return { httpOnly: true, sameSite: "lax", secure: env.SESSION_COOKIE_SECURE, path: "/", maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

/** Accepts a session cookie or an `X-Api-Key` header; both resolve to the same `req.user`. */
async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const path = req.url.split("?")[0];
  if (!path.startsWith("/api/") || PUBLIC_ROUTES.has(path)) return;

  const token = req.cookies[SESSION_COOKIE];
  let userId = token ? verifySession(token) : null;
  if (userId !== null) {
    req.sessionToken = token!;
    // Slide the cookie with the server-side expiry.
    reply.setCookie(SESSION_COOKIE, token!, sessionCookieOptions());
  } else {
    const key = req.headers["x-api-key"];
    userId = typeof key === "string" ? verifyApiKey(key) : null;
  }
  const user = userId !== null ? getUser(userId) : null;
  if (!user) return reply.status(401).send({ error: "Sign in, or pass a valid X-Api-Key header" });
  req.user = { id: user.id, role: user.role, email: user.email };
}

export async function registerAuth(app: FastifyInstance) {
  await app.register(fastifyCookie);
  // Only routes that opt in (login/signup) are limited.
  await app.register(fastifyRateLimit, { global: false });
  app.decorateRequest("user", null);
  app.decorateRequest("sessionToken", null);
  app.addHook("onRequest", authenticate);
}

/** The signed-in user; the auth hook guarantees one on non-public routes. */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw httpError(401, "Not signed in");
  return req.user;
}

export function requireAdmin(req: FastifyRequest): AuthUser {
  const user = currentUser(req);
  if (user.role !== "admin") throw httpError(403, "Admin access required");
  return user;
}
