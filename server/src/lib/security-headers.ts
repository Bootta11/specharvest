import type { FastifyInstance } from "fastify";
import { env } from "../config.ts";

/**
 * Browser hardening on every response. The built client is plain same-origin files: no inline script, no
 * external fonts or API calls; React's style props go through CSSOM, which CSP doesn't restrict. Listing
 * images come from any shop, so img-src stays open (images can't run code). A reverse proxy in front must
 * not replace these. Hijacked replies (SSE streams) skip onSend — they're not documents.
 */
export function registerSecurityHeaders(app: FastifyInstance) {
  const https = !!env.PUBLIC_URL?.startsWith("https://");
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob: https: http:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("Content-Security-Policy", csp);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (https) reply.header("Strict-Transport-Security", "max-age=15552000");
    // Signed-in data must not land in shared or browser caches.
    if (req.url.startsWith("/api/") && !reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
    return payload;
  });
}
