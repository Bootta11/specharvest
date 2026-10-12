import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createDeviceTokenSchema, pairApproveSchema, pairClaimSchema, type ExtensionWhoami, type PairClaimResult } from "@specharvest/shared";
import { createExtensionToken, extensionDeviceName, listExtensionTokens, revokeExtensionToken } from "../auth/api-keys.ts";
import { currentUser } from "../auth/plugin.ts";
import { getUser } from "../auth/users.ts";
import { httpError } from "../lib/http-error.ts";
import { disconnectKey, extensionStatus, isKeyOnline } from "./gateway.ts";

/**
 * Connecting the extension to an account, two ways (docs/extension.md):
 * - approve: the extension opens /connect-extension?challenge=… in the web app, the signed-in user approves,
 *   and the extension claims the token with the secret behind the challenge (like OAuth's device flow + PKCE —
 *   the token never appears in a URL or the web page);
 * - token: the user creates a token under Account → Connected browsers and pastes it into the extension.
 */

const PAIRING_TTL_MS = 5 * 60_000;

/** Approved pairings waiting for the extension to claim them, by challenge. */
const approved = new Map<string, { userId: number; deviceName: string; at: number }>();

function prune(now = Date.now()) {
  for (const [k, v] of approved) if (now - v.at > PAIRING_TTL_MS) approved.delete(k);
}

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

const idParam = (p: unknown) => z.coerce.number().int().positive().parse((p as { id?: string }).id);

export function registerExtensionRoutes(app: FastifyInstance) {
  // The web app's Approve button. A session only: it's the user's consent, not something a script decides.
  app.post("/api/extension/pair/approve", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const user = currentUser(req);
    if (!req.sessionToken) throw httpError(403, "Approve the browser while signed in to SpecHarvest");
    const body = pairApproveSchema.parse(req.body);
    prune();
    approved.set(body.challenge, { userId: user.id, deviceName: body.deviceName, at: Date.now() });
    return { ok: true };
  });

  // The extension polls this until the user approved. Unknown and not-yet-approved look the same.
  app.post("/api/extension/pair/claim", { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { verifier } = pairClaimSchema.parse(req.body);
    prune();
    const challenge = challengeOf(verifier);
    const pairing = approved.get(challenge);
    if (!pairing) return reply.status(202).send({ status: "pending" });
    approved.delete(challenge);
    const user = getUser(pairing.userId);
    if (!user) return reply.status(202).send({ status: "pending" });
    const { token } = createExtensionToken(user.id, pairing.deviceName, "approve");
    return { token, email: user.email, deviceName: pairing.deviceName } satisfies PairClaimResult;
  });

  // Checks a pasted token (or a plain API key) before the extension saves it.
  app.get("/api/extension/whoami", async (req) => {
    const user = currentUser(req);
    if (!req.apiKey) throw httpError(400, "Call this with the token in X-Api-Key");
    return { email: user.email, deviceName: extensionDeviceName(req.apiKey.keyId) } satisfies ExtensionWhoami;
  });

  app.get("/api/extension/status", async (req) => extensionStatus(currentUser(req).id));

  app.get("/api/extension/devices", async (req) => listExtensionTokens(currentUser(req).id, isKeyOnline));

  // A token to paste into the extension (shown once).
  app.post("/api/extension/devices", async (req, reply) => {
    const { name } = createDeviceTokenSchema.parse(req.body);
    return reply.status(201).send(createExtensionToken(currentUser(req).id, name, "token"));
  });

  app.delete("/api/extension/devices/:id", async (req, reply) => {
    const id = idParam(req.params);
    if (!revokeExtensionToken(currentUser(req).id, id)) return reply.status(404).send({ error: "Not found" });
    disconnectKey(id);
    return { ok: true };
  });
}
