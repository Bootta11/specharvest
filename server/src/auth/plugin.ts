import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyCookie, { type CookieSerializeOptions } from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
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
    /** Raw session token the request was authenticated with — cookie or app bearer token (null for API keys). */
    sessionToken: string | null;
  }
}

export const SESSION_COOKIE = "specharvest_session";

/** Sent by the Android app: login/signup then return a bearer token instead of setting the cookie. */
export const APP_CLIENT_HEADER = "x-specharvest-client";
export const isAppClient = (req: FastifyRequest) => req.headers[APP_CLIENT_HEADER] === "app";

/** `Authorization: Bearer <session token>` (the app's sign-in), else null. */
function bearerToken(req: FastifyRequest): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return m ? m[1] : null;
}

/** API routes reachable without signing in. */
const PUBLIC_ROUTES = new Set(["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/signup", "/api/auth/logout"]);

/** These set or clear the session cookie, so they get the same cross-site check as signed-in writes. */
const COOKIE_ROUTES = new Set(["/api/auth/login", "/api/auth/signup", "/api/auth/logout"]);
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const publicOrigin = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : null;

/**
 * CSRF guard for cookie-authenticated writes: the browser says where the request came from (Sec-Fetch-Site,
 * else Origin). SameSite=Lax alone doesn't stop a sibling subdomain (same site) from posting. Requests
 * without either header aren't from a browser page, so they carry no ambient cookie to abuse.
 */
function crossSite(req: FastifyRequest): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string") return site !== "same-origin" && site !== "none";
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  return origin !== `${req.protocol}://${req.host}` && origin !== publicOrigin;
}

/**
 * Same-origin app (Vite proxy in dev, static files from this server in prod) → SameSite=Lax.
 * maxAge mirrors the sliding session TTL so closing the browser doesn't log the user out.
 */
export function sessionCookieOptions(): CookieSerializeOptions {
  return { httpOnly: true, sameSite: "lax", secure: env.SESSION_COOKIE_SECURE, path: "/", maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

/** Accepts a session cookie, the app's bearer session token, or an `X-Api-Key` header; all resolve to the same `req.user`. */
async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const path = req.url.split("?")[0];
  if (!path.startsWith("/api/") || req.method === "OPTIONS") return;
  // The app's token login and bearer-token requests set and use no cookie, so a cross-site page gains nothing.
  const cookieAuthWrite = (COOKIE_ROUTES.has(path) && !isAppClient(req) && !bearerToken(req)) || req.cookies[SESSION_COOKIE];
  if (UNSAFE_METHODS.has(req.method) && cookieAuthWrite && crossSite(req)) {
    return reply.status(403).send({ error: "Cross-site request refused" });
  }
  if (PUBLIC_ROUTES.has(path)) return;

  const token = req.cookies[SESSION_COOKIE];
  const bearer = bearerToken(req);
  let userId = token ? verifySession(token) : null;
  if (userId !== null) {
    req.sessionToken = token!;
    // Slide the cookie with the server-side expiry.
    reply.setCookie(SESSION_COOKIE, token!, sessionCookieOptions());
  } else if (bearer && (userId = verifySession(bearer)) !== null) {
    req.sessionToken = bearer;
  } else {
    const key = req.headers["x-api-key"];
    userId = typeof key === "string" ? verifyApiKey(key) : null;
  }
  const user = userId !== null ? getUser(userId) : null;
  if (!user) return reply.status(401).send({ error: "Sign in, or pass a valid X-Api-Key header" });
  req.user = { id: user.id, role: user.role, email: user.email };
}

export async function registerAuth(app: FastifyInstance) {
  // Only the Android app's origins, and only with bearer tokens — cookies never go cross-origin.
  await app.register(fastifyCors, {
    origin: (origin, cb) => cb(null, !!origin && env.APP_ORIGINS.includes(origin)),
    credentials: false,
    allowedHeaders: ["Authorization", "Content-Type", "X-SpecHarvest-Client", "Last-Event-ID"],
    exposedHeaders: ["Content-Disposition"],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    maxAge: 600,
  });
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

/**
 * Route option: at most `max` requests a minute per signed-in user (per IP before sign-in) — for routes that
 * spend LLM money or start heavy work. @fastify/rate-limit adds it as a route hook, so it runs after the auth hook.
 */
export function userLimit(max: number) {
  return { config: { rateLimit: { max, timeWindow: "1 minute", keyGenerator: limitKey } } };
}

const limitKey = (req: FastifyRequest) => (req.user ? `user:${req.user.id}` : req.ip);

/** A search with a typed request — it may call the LLM to parse it. */
const typedSearch = (req: FastifyRequest) => {
  const query = (req.body as { query?: unknown } | null | undefined)?.query;
  return typeof query === "string" && query.trim() !== "";
};

/**
 * Route option for search: typed requests (may spend LLM money) and filter-only searches (no LLM call, e.g. every
 * filter-panel change) are limited separately, per user per minute. Runs once the body is parsed.
 */
export function searchLimit(limits: { typed: number; filterOnly: number }) {
  return {
    config: {
      rateLimit: {
        hook: "preHandler" as const,
        timeWindow: "1 minute",
        keyGenerator: (req: FastifyRequest) => `${limitKey(req)}:${typedSearch(req) ? "typed" : "filter"}`,
        max: (_req: FastifyRequest, key: string) => (key.endsWith(":typed") ? limits.typed : limits.filterOnly),
      },
    },
  };
}

export function requireAdmin(req: FastifyRequest): AuthUser {
  const user = currentUser(req);
  if (user.role !== "admin") throw httpError(403, "Admin access required");
  return user;
}
