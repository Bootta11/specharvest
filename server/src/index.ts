import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  CRAWL_MAX_ITEMS,
  CRAWL_MAX_PAGES,
  crawlRequestSchema,
  enrichRequestSchema,
  groupInputSchema,
  groupingModes,
  importRequestSchema,
  isActiveJob,
  notificationChannels,
  searchRequestSchema,
  type CollectionProducts,
  type ItemDetail,
} from "@specharvest/shared";
import { env } from "./config.ts";
import * as db from "./db/sqlite.ts";
import { deleteVectors, upsertVector } from "./db/lance.ts";
import { embed } from "./embedding.ts";
import { proxyConfigured } from "./crawler/browser.ts";
import { embeddingText, emitJob, jobChannel, JOBS_CHANNEL, ResumeError, resumeCrawl, startCrawl, stopCrawl } from "./crawler/job.ts";
import { getNotificationSettings, maskSettings, saveNotificationSettings, sendTest } from "./notify/index.ts";
import { vapidKeys } from "./notify/push.ts";
import { startEnrichment } from "./enrich/web.ts";
import { autoConfirmMatches, groupForCollection, lookupIdentity, matchSuggestions, productGroups, sameProductOf, ungroupedCount } from "./enrich/group.ts";
import { search } from "./search/hybrid.ts";
import { proposeKeyMerges } from "./llm/consolidate.ts";
import { withLlmContext } from "./llm/usage.ts";
import { getProviderCredits } from "./llm/credits.ts";
import { llmReady, llmStatus, requireLlm } from "./llm/resolve.ts";
import { registerLlmRoutes } from "./llm/routes.ts";
import { startPriceRefresh } from "./llm/pricing.ts";
import { subscribe } from "./sse/hub.ts";
import { createLogger, errorMessage } from "./lib/logger.ts";
import { errorHandler, httpError } from "./lib/http-error.ts";
import { assertPublicUrl, strictPolicy } from "./lib/net-guard.ts";
import { registerSecurityHeaders } from "./lib/security-headers.ts";
import { bootstrapAdmin } from "./auth/bootstrap.ts";
import { requireCollection, requireGroup, requireJob } from "./auth/ownership.ts";
import { currentUser, registerAuth, requireAdmin, searchLimit, userLimit } from "./auth/plugin.ts";
import type { AuthUser } from "./auth/ownership.ts";
import { registerAuthRoutes } from "./auth/routes.ts";
import { pruneSessions } from "./auth/sessions.ts";

const log = createLogger("server");

// A stray rejected promise in background work (a crawl, an embedding) must not take every running crawl down with it.
process.on("unhandledRejection", (err) => log.error("Unhandled promise rejection", err instanceof Error ? (err.stack ?? err.message) : String(err)));
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception — exiting", err.stack ?? err.message);
  process.exit(1);
});

db.getDb();
await bootstrapAdmin();
pruneSessions();
startPriceRefresh();

const app = Fastify({
  logger: false,
  bodyLimit: 1_000_000,
  // Rate limits key on the client IP: only proxies matching TRUST_PROXY may set X-Forwarded-For (config.ts).
  trustProxy: env.TRUST_PROXY,
  // Fastify's default (0) turns off Node's guard against clients that send a body very slowly.
  requestTimeout: 300_000,
  // Open SSE streams would otherwise keep app.close() waiting on shutdown.
  forceCloseConnections: true,
});
await registerAuth(app);
registerSecurityHeaders(app);
app.setErrorHandler(errorHandler);

const idParam = (p: unknown) => {
  const id = Number((p as { id?: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error("Invalid id"), { statusCode: 400 });
  return id;
};
const notFound = (reply: FastifyReply) => reply.status(404).send({ error: "Not found" });

registerAuthRoutes(app);
registerLlmRoutes(app);

// ---------- Health / config ----------

/** Liveness + DB readiness, same shape across projects. Errors are logged only, never returned. HEAD is auto-routed. */
app.get("/api/health", async (_req, reply) => {
  const start = Date.now();
  let dbOk = true;
  try {
    db.getDb().prepare("SELECT 1").get();
  } catch (err) {
    dbOk = false;
    log.error("health: database check failed", errorMessage(err));
  }
  const checks = { database: { ok: dbOk, latencyMs: Date.now() - start } };
  const ok = Object.values(checks).every((c) => c.ok);
  return reply
    .status(ok ? 200 : 503)
    .header("Cache-Control", "no-store")
    .send({ ok, status: ok ? "ok" : "error", checks, uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
});

/** Most one crawl may ask for: admins up to the hard ceiling, everyone else MAX_PAGES_CAP / MAX_ITEMS_CAP. */
function crawlLimits(user: AuthUser) {
  return user.role === "admin"
    ? { maxPages: CRAWL_MAX_PAGES, maxItems: CRAWL_MAX_ITEMS }
    : { maxPages: Math.min(env.MAX_PAGES_CAP, CRAWL_MAX_PAGES), maxItems: Math.min(env.MAX_ITEMS_CAP, CRAWL_MAX_ITEMS) };
}

// Per user: which LLM provider/model each tier runs on for them (own key or server key), see llm/resolve.ts.
app.get("/api/config", async (req) => {
  const user = currentUser(req);
  const llm = llmStatus(user.id);
  const limits = crawlLimits(user);
  return {
    version: env.APP_GIT_SHA ?? "dev",
    proxyConfigured: proxyConfigured(),
    webSearchEnabled: env.WEB_SEARCH_ENABLED && !!llm.effective.web,
    llmConfigured: !!llm.effective.fast,
    defaults: { maxPages: Math.min(env.MAX_PAGES, limits.maxPages), maxItems: Math.min(env.MAX_ITEMS, limits.maxItems) },
    limits,
    llm,
  };
});

// ---------- Collections & items ----------

/** One readable collection, the readable members of one of the user's groups, or everything the user may read. */
function readScope(req: FastifyRequest, collectionId: number | null | undefined, groupId?: number | null): db.CollectionScope {
  const user = currentUser(req);
  if (collectionId && groupId) throw httpError(400, "Pass collectionId or groupId, not both");
  if (collectionId) return requireCollection(collectionId, user, "read").id;
  if (groupId) return requireGroup(groupId, user).collectionIds;
  return db.readableScope(user);
}

app.get("/api/collections", async (req) => db.listCollections(currentUser(req)));

app.get("/api/collections/:id/keys", async (req) => db.listSpecKeys(readScope(req, idParam(req.params))));
app.get("/api/keys", async (req) => db.listSpecKeys(readScope(req, null)));

const collectionPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isShared: z.boolean().optional(),
  grouping: z.enum(groupingModes).optional(),
});

app.patch("/api/collections/:id", async (req) => {
  const user = currentUser(req);
  const id = requireCollection(idParam(req.params), user, "write").id;
  const body = collectionPatchSchema.parse(req.body);
  if (body.name === undefined && body.isShared === undefined && body.grouping === undefined) throw httpError(400, "Nothing to change");
  if (body.name !== undefined) db.renameCollection(id, body.name);
  if (body.isShared !== undefined) db.setCollectionShared(id, body.isShared);
  if (body.grouping !== undefined) {
    db.setCollectionGrouping(id, body.grouping);
    // Switching to loose groups the waiting single-candidate matches right away (free, no LLM).
    if (body.grouping === "loose") autoConfirmMatches(db.listItems(id, 5000, 0, true));
  }
  return db.getCollection(id, user);
});

app.delete("/api/collections/:id", async (req) => {
  const id = requireCollection(idParam(req.params), currentUser(req), "write").id;
  await deleteVectors(db.deleteCollection(id));
  return { ok: true };
});

const downloadName = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "collection"}-${new Date().toISOString().slice(0, 10)}.json`;

app.get("/api/collections/:id/export", async (req, reply) => {
  const id = requireCollection(idParam(req.params), currentUser(req), "read").id;
  const data = db.exportCollection(id);
  reply.header("Content-Disposition", `attachment; filename="${downloadName(data.collection.name)}"`);
  return data;
});

// Every collection the caller can read, in one file.
app.get("/api/collections/export", async (req, reply) => {
  const data = db.exportCollections(currentUser(req));
  reply.header("Content-Disposition", `attachment; filename="${downloadName("specharvest-all")}"`);
  return data;
});

// Always new private collections for the importer (one, or all from an "Export all" file, atomically).
// Vectors are rebuilt in the background (local model, no LLM cost).
// ---------- Groups (private sets of collections searched together) ----------

app.get("/api/groups", async (req) => db.listGroups(currentUser(req)));

app.post("/api/groups", async (req, reply) => {
  const user = currentUser(req);
  const body = groupInputSchema.parse(req.body);
  for (const id of body.collectionIds) requireCollection(id, user, "read");
  return reply.status(201).send(db.getGroup(db.createGroup(user.id, body.name, body.collectionIds), user));
});

app.patch("/api/groups/:id", async (req) => {
  const user = currentUser(req);
  const id = requireGroup(idParam(req.params), user).id;
  const body = groupInputSchema.partial().parse(req.body);
  for (const cid of body.collectionIds ?? []) requireCollection(cid, user, "read");
  db.updateGroup(id, body);
  return db.getGroup(id, user);
});

app.delete("/api/groups/:id", async (req) => {
  db.deleteGroup(requireGroup(idParam(req.params), currentUser(req)).id);
  return { ok: true };
});

app.post("/api/collections/import", { bodyLimit: env.IMPORT_MAX_MB * 1024 * 1024, ...userLimit(5) }, async (req, reply) => {
  const user = currentUser(req);
  const body = importRequestSchema.parse(req.body);
  const imported = db.importCollections("collections" in body ? body.collections : [body], user);
  void (async () => {
    for (const { collectionId, itemIds } of imported) {
      for (const item of db.getItemsByIds(itemIds)) {
        try {
          await upsertVector(item.id, collectionId, await embed(embeddingText(item)));
        } catch (err) {
          log.warn("import embed failed", errorMessage(err));
        }
      }
      log.info(`Imported collection ${collectionId}: embedded ${itemIds.length} items`);
    }
  })().catch((err) => log.error("Embedding imported items failed", errorMessage(err)));
  const collections = imported.map(({ collectionId }) => db.getCollection(collectionId, user));
  return reply.status(201).send("collections" in body ? collections : collections[0]);
});

// Products (name variants grouped). For the owner, names never seen before are grouped first (one cheap LLM
// call) and the rule-based regroup runs (free); possible matches come back as suggestions to confirm.
app.get("/api/collections/:id/products", userLimit(20), async (req): Promise<CollectionProducts> => {
  const user = currentUser(req);
  const collection = requireCollection(idParam(req.params), user, "read");
  const items = db.listItems(collection.id, 5000);
  if (collection.canEdit) {
    await withLlmContext({ collectionId: collection.id, userId: user.id }, () => groupForCollection(collection.id, items, { llm: llmReady(user.id, "smart") }));
  }
  return {
    products: productGroups(items),
    suggestions: collection.canEdit ? matchSuggestions(items) : [],
    listings: items.length,
    grouped: ungroupedCount(items) === 0,
  };
});

const matchDecisionSchema = z.object({ identity: z.string().min(1), to: z.string().min(1).nullable() });

// Answer a suggestion: `to` = same product as that candidate; null = different from every candidate.
app.post("/api/collections/:id/matches", async (req) => {
  const collection = requireCollection(idParam(req.params), currentUser(req), "write");
  const body = matchDecisionSchema.parse(req.body);
  const items = db.listItems(collection.id, 5000);
  const suggestion = matchSuggestions(items).find((s) => s.identity === body.identity);
  if (!suggestion) throw httpError(404, "No such suggestion — reload the products");
  if (body.to === null) for (const c of suggestion.candidates) db.rejectPair(suggestion.identity, c.canonical);
  else {
    if (!suggestion.candidates.some((c) => c.canonical === body.to)) throw httpError(400, "Not one of the suggested products");
    db.mergeCanonical(suggestion.identity, body.to);
  }
  return { ok: true };
});

const splitSchema = z.object({ identity: z.string().min(1) });

// "Not the same product": take one name out of its group for good.
app.post("/api/collections/:id/split", async (req) => {
  const collection = requireCollection(idParam(req.params), currentUser(req), "write");
  const { identity } = splitSchema.parse(req.body);
  const canonical = db.getCanonicalIdentity(identity);
  if (canonical === identity) throw httpError(400, "That name isn't grouped into another product");
  if (!db.listItems(collection.id, 5000).some((i) => lookupIdentity(i) === identity)) throw httpError(404, "No listing in this collection has that name");
  db.rejectPair(identity, canonical);
  db.splitIdentity(identity);
  return { ok: true };
});

app.post("/api/collections/:id/consolidate", userLimit(5), async (req) => {
  const user = currentUser(req);
  const id = requireCollection(idParam(req.params), user, "write").id;
  requireLlm(user.id, "smart");
  const merges = await withLlmContext({ collectionId: id, userId: user.id }, () => proposeKeyMerges(db.listSpecKeys(id)));
  const moved = db.applyKeyMerges(id, merges);
  return { merges, moved };
});

app.get("/api/items", async (req) => {
  const q = req.query as { collectionId?: string; limit?: string; offset?: string; includeGone?: string };
  const includeGone = q.includeGone === "1" || q.includeGone === "true";
  const scope = readScope(req, q.collectionId ? Number(q.collectionId) : null);
  return db.listItems(scope, Math.min(Number(q.limit) || 60, 200), Number(q.offset) || 0, includeGone);
});

app.get("/api/items/:id", async (req, reply) => {
  const item = db.getItem(idParam(req.params));
  if (!item) return notFound(reply);
  const user = currentUser(req);
  requireCollection(item.collectionId, user, "read");
  return { ...item, sameProduct: sameProductOf(item, db.readableScope(user)) } satisfies ItemDetail;
});

// ---------- Jobs ----------

app.post("/api/crawl", userLimit(10), async (req, reply) => {
  const user = currentUser(req);
  requireLlm(user.id, "fast");
  const body = crawlRequestSchema.parse(req.body);
  if (body.useProxy && !proxyConfigured()) return reply.status(400).send({ error: "PROXY_SERVER is not configured" });
  if (body.collectionId) requireCollection(body.collectionId, user, "write");
  const limits = crawlLimits(user);
  if (body.maxPages !== undefined && body.maxPages > limits.maxPages) throw httpError(400, `At most ${limits.maxPages} listing pages per crawl`);
  if (body.maxItems !== undefined && body.maxItems > limits.maxItems) throw httpError(400, `At most ${limits.maxItems} items per crawl`);
  // Shops are public sites: the crawler never opens loopback/LAN/metadata addresses (lib/net-guard.ts).
  await assertPublicUrl(body.url, strictPolicy());
  const params = {
    ...body,
    // The configured defaults may be above this user's cap.
    maxPages: body.maxPages ?? (env.MAX_PAGES > limits.maxPages ? limits.maxPages : undefined),
    maxItems: body.maxItems ?? (env.MAX_ITEMS > limits.maxItems ? limits.maxItems : undefined),
  };
  return reply.status(202).send(startCrawl(params, user.id, body.collectionId));
});

app.post("/api/enrich", userLimit(10), async (req, reply) => {
  const body = enrichRequestSchema.parse(req.body);
  if (!env.WEB_SEARCH_ENABLED) return reply.status(400).send({ error: "Web lookups are disabled (WEB_SEARCH_ENABLED=false)" });
  requireLlm(currentUser(req).id, "web");
  // Shared collections can be enriched by readers too — the lookups are billed to them.
  const scope = readScope(req, body.collectionId, body.groupId);
  const readable = new Set(db.listItems(scope, 5000).map((i) => i.id));
  const itemIds = body.itemIds
    ? body.itemIds.filter((id) => readable.has(id))
    : db
        .listItems(scope, 5000)
        .filter((i) => body.attributes.some((a) => i.specs[a.key] === undefined))
        .map((i) => i.id);
  if (itemIds.length === 0) return reply.status(200).send({ job: null, note: "Every item already has these values" });
  const job = startEnrichment({ collectionId: body.collectionId ?? null, groupId: body.groupId, userId: currentUser(req).id, attributes: body.attributes, itemIds });
  return reply.status(202).send({ job });
});

// Your own spend; admins can ask for everyone's with ?scope=all.
app.get("/api/usage", async (req) => {
  const user = currentUser(req);
  const all = user.role === "admin" && (req.query as { scope?: string }).scope === "all";
  return db.usageSummary(Date.now(), all ? null : user.id);
});

// Remaining OpenRouter balance — the shared server account, so admins only.
app.get("/api/usage/credits", async (req) => {
  requireAdmin(req);
  return getProviderCredits();
});

app.get("/api/jobs", async (req) => db.listJobs(30, currentUser(req)));

/** Takes over the response for an SSE stream, keeping headers already set on it (CORS for the Android app). */
function hijackForStream(reply: FastifyReply) {
  for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
  reply.hijack();
}

// The user's job snapshots (admins: everyone's): active jobs first, then live updates (no replayed history).
app.get("/api/jobs/events", async (req, reply) => {
  const user = currentUser(req);
  hijackForStream(reply);
  subscribe(JOBS_CHANNEL, reply.raw, undefined, {
    replay: false,
    initial: [{ type: "jobs", jobs: db.listActiveJobs(user) }],
    filter: (e) => e.type !== "job" || db.canSeeJob(e.job, user),
  });
});

app.post("/api/jobs/:id/stop", async (req, reply) => {
  const id = requireJob(idParam(req.params), currentUser(req)).id;
  const job = stopCrawl(id);
  if (!job) return reply.status(409).send({ error: "This job isn't a running crawl" });
  return reply.status(202).send(job);
});

app.post("/api/jobs/:id/resume", async (req, reply) => {
  const job = requireJob(idParam(req.params), currentUser(req));
  if (job.collectionId) requireCollection(job.collectionId, currentUser(req), "write");
  const id = job.id;
  // The crawl keeps running on its starter's keys.
  requireLlm(job.userId ?? currentUser(req).id, "fast");
  try {
    return reply.status(202).send(resumeCrawl(id));
  } catch (err) {
    if (err instanceof ResumeError) return reply.status(409).send({ error: err.message });
    throw err;
  }
});

app.get("/api/jobs/:id", async (req) => requireJob(idParam(req.params), currentUser(req)));

app.get("/api/jobs/:id/events", async (req, reply) => {
  const job = requireJob(idParam(req.params), currentUser(req));
  const id = job.id;
  hijackForStream(reply);
  subscribe(jobChannel(id), reply.raw, req.headers["last-event-id"] as string | undefined);
  // A finished job's channel may already be retired — always end with a fresh snapshot.
  if (!isActiveJob(job)) emitJob(job);
});

// ---------- Notifications ----------

// Each user configures (and tests) their own channels.
app.get("/api/settings/notifications", async (req) => maskSettings(getNotificationSettings(currentUser(req).id)));
app.put("/api/settings/notifications", async (req) => maskSettings(await saveNotificationSettings(currentUser(req), req.body)));

app.post("/api/notifications/test", userLimit(10), async (req) => {
  const { channel } = z.object({ channel: z.enum(notificationChannels) }).parse(req.body);
  return sendTest(currentUser(req).id, channel);
});

const pushSubscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
});

app.get("/api/push/key", async () => ({ publicKey: vapidKeys().publicKey }));
app.post("/api/push/subscribe", async (req) => {
  const sub = pushSubscriptionSchema.parse(req.body);
  // Push services are public; anything else would make the server POST into its own network.
  await assertPublicUrl(sub.endpoint, strictPolicy());
  db.savePushSub(sub, req.headers["user-agent"]?.slice(0, 300) ?? null, currentUser(req).id);
  return { ok: true };
});
app.delete("/api/push/subscribe", async (req) => {
  db.deletePushSub(z.object({ endpoint: z.string() }).parse(req.body).endpoint, currentUser(req).id);
  return { ok: true };
});

// ---------- Search ----------

app.post("/api/search", searchLimit({ typed: 30, filterOnly: 240 }), async (req) => {
  const body = searchRequestSchema.parse(req.body);
  const user = currentUser(req);
  return search(body, user, readScope(req, body.collectionId, body.groupId));
});

app.get("/api/searches", async (req) => {
  const q = req.query as { collectionId?: string; groupId?: string; limit?: string };
  const user = currentUser(req);
  if (q.groupId) requireGroup(Number(q.groupId), user);
  return db.listRecentQueries(user.id, db.historySlot(q.collectionId ? Number(q.collectionId) : null, q.groupId ? Number(q.groupId) : null), Math.min(Number(q.limit) || 8, 50));
});

// ---------- Client (production build) ----------

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (fs.existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

await app.listen({ port: env.PORT, host: "0.0.0.0" });
log.info(`SpecHarvest API listening on :${env.PORT} (data: ${env.DATA_DIR})`);

const shutdown = async () => {
  // Don't outlive Docker's stop timeout if something still holds the server open.
  setTimeout(() => process.exit(0), 10_000).unref();
  await app.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
