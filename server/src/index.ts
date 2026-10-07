import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { crawlRequestSchema, enrichRequestSchema, isActiveJob, notificationChannels, searchRequestSchema, type CollectionProducts, type ItemDetail } from "@specharvest/shared";
import { env } from "./config.ts";
import * as db from "./db/sqlite.ts";
import { deleteVectors } from "./db/lance.ts";
import { checkBrowser, proxyConfigured } from "./crawler/browser.ts";
import { emitJob, jobChannel, JOBS_CHANNEL, ResumeError, resumeCrawl, startCrawl, stopCrawl } from "./crawler/job.ts";
import { getNotificationSettings, maskSettings, saveNotificationSettings, sendTest } from "./notify/index.ts";
import { vapidKeys } from "./notify/push.ts";
import { startEnrichment } from "./enrich/web.ts";
import { canonicalizeIdentities, lookupIdentity, matchSuggestions, productGroups, regroup, sameProductOf, ungroupedCount } from "./enrich/group.ts";
import { search } from "./search/hybrid.ts";
import { proposeKeyMerges } from "./llm/consolidate.ts";
import { withLlmContext } from "./llm/usage.ts";
import { getProviderCredits } from "./llm/credits.ts";
import { subscribe } from "./sse/hub.ts";
import { createLogger, errorMessage } from "./lib/logger.ts";
import { httpError } from "./lib/http-error.ts";
import { bootstrapAdmin } from "./auth/bootstrap.ts";
import { requireCollection, requireJob } from "./auth/ownership.ts";
import { currentUser, registerAuth, requireAdmin } from "./auth/plugin.ts";
import { registerAuthRoutes } from "./auth/routes.ts";
import { pruneSessions } from "./auth/sessions.ts";

const log = createLogger("server");

db.getDb();
await bootstrapAdmin();
pruneSessions();

// trustProxy: rate limiting keys on the client IP behind the tunnel / reverse proxy.
const app = Fastify({ logger: false, bodyLimit: 1_000_000, trustProxy: true });
await registerAuth(app);

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) return reply.status(400).send({ error: "Invalid request", issues: err.issues });
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) log.error("Request failed", errorMessage(err));
  return reply.status(status).send({ error: errorMessage(err) });
});

const idParam = (p: unknown) => {
  const id = Number((p as { id?: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error("Invalid id"), { statusCode: 400 });
  return id;
};
const notFound = (reply: FastifyReply) => reply.status(404).send({ error: "Not found" });

registerAuthRoutes(app);

// ---------- Health / config ----------

app.get("/api/health", async (req, reply) => {
  const checks: Record<string, string> = { db: "ok" };
  try {
    db.getDb().prepare("SELECT 1").get();
  } catch (err) {
    checks.db = errorMessage(err);
  }
  checks.openrouter = env.OPENROUTER_API_KEY ? "configured" : "missing OPENROUTER_API_KEY";
  if ((req.query as { deep?: string }).deep) {
    try {
      await checkBrowser();
      checks.browser = "ok";
    } catch (err) {
      checks.browser = errorMessage(err);
    }
  }
  const ok = checks.db === "ok";
  return reply.status(ok ? 200 : 503).send({ status: ok ? "ok" : "error", version: env.APP_GIT_SHA ?? "dev", checks });
});

app.get("/api/config", async () => ({
  proxyConfigured: proxyConfigured(),
  webSearchEnabled: env.WEB_SEARCH_ENABLED && !!env.OPENROUTER_API_KEY,
  llmConfigured: !!env.OPENROUTER_API_KEY,
  defaults: { maxPages: env.MAX_PAGES, maxItems: env.MAX_ITEMS },
  models: { main: env.OPENROUTER_MODEL, extraction: env.OPENROUTER_EXTRACTION_MODEL, web: env.OPENROUTER_WEB_MODEL },
}));

// ---------- Collections & items ----------

/** One readable collection when `collectionId` is given, else everything the user may read. */
function readScope(req: FastifyRequest, collectionId: number | null | undefined): db.CollectionScope {
  const user = currentUser(req);
  if (collectionId) return requireCollection(collectionId, user, "read").id;
  return db.readableScope(user);
}

app.get("/api/collections", async (req) => db.listCollections(currentUser(req)));

app.get("/api/collections/:id/keys", async (req) => db.listSpecKeys(readScope(req, idParam(req.params))));
app.get("/api/keys", async (req) => db.listSpecKeys(readScope(req, null)));

const collectionPatchSchema = z.object({ name: z.string().trim().min(1).max(200).optional(), isShared: z.boolean().optional() });

app.patch("/api/collections/:id", async (req) => {
  const user = currentUser(req);
  const id = requireCollection(idParam(req.params), user, "write").id;
  const body = collectionPatchSchema.parse(req.body);
  if (body.name === undefined && body.isShared === undefined) throw httpError(400, "Nothing to change");
  if (body.name !== undefined) db.renameCollection(id, body.name);
  if (body.isShared !== undefined) db.setCollectionShared(id, body.isShared);
  return db.getCollection(id, user);
});

app.delete("/api/collections/:id", async (req) => {
  const id = requireCollection(idParam(req.params), currentUser(req), "write").id;
  await deleteVectors(db.deleteCollection(id));
  return { ok: true };
});

// Products (name variants grouped). For the owner, names never seen before are grouped first (one cheap LLM
// call) and the rule-based regroup runs (free); possible matches come back as suggestions to confirm.
app.get("/api/collections/:id/products", async (req): Promise<CollectionProducts> => {
  const user = currentUser(req);
  const collection = requireCollection(idParam(req.params), user, "read");
  const items = db.listItems(collection.id, 5000);
  if (collection.canEdit) {
    if (env.OPENROUTER_API_KEY && ungroupedCount(items) > 0) {
      await withLlmContext({ collectionId: collection.id, userId: user.id }, () => canonicalizeIdentities(items));
    } else regroup(items.map(lookupIdentity));
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

app.post("/api/collections/:id/consolidate", async (req) => {
  const user = currentUser(req);
  const id = requireCollection(idParam(req.params), user, "write").id;
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

app.post("/api/crawl", async (req, reply) => {
  if (!env.OPENROUTER_API_KEY) return reply.status(400).send({ error: "OPENROUTER_API_KEY is not configured" });
  const body = crawlRequestSchema.parse(req.body);
  if (body.useProxy && !proxyConfigured()) return reply.status(400).send({ error: "PROXY_SERVER is not configured" });
  const user = currentUser(req);
  if (body.collectionId) requireCollection(body.collectionId, user, "write");
  return reply.status(202).send(startCrawl(body, user.id, body.collectionId));
});

app.post("/api/enrich", async (req, reply) => {
  const body = enrichRequestSchema.parse(req.body);
  if (!env.WEB_SEARCH_ENABLED || !env.OPENROUTER_API_KEY) return reply.status(400).send({ error: "Web lookups are not enabled" });
  // Shared collections can be enriched by readers too — the lookups are billed to them.
  const scope = readScope(req, body.collectionId);
  const readable = new Set(db.listItems(scope, 5000).map((i) => i.id));
  const itemIds = body.itemIds
    ? body.itemIds.filter((id) => readable.has(id))
    : db
        .listItems(scope, 5000)
        .filter((i) => body.attributes.some((a) => i.specs[a.key] === undefined))
        .map((i) => i.id);
  if (itemIds.length === 0) return reply.status(200).send({ job: null, note: "Every item already has these values" });
  const job = startEnrichment({ collectionId: body.collectionId ?? null, userId: currentUser(req).id, attributes: body.attributes, itemIds });
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

// The user's job snapshots (admins: everyone's): active jobs first, then live updates (no replayed history).
app.get("/api/jobs/events", async (req, reply) => {
  const user = currentUser(req);
  reply.hijack();
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
  if (!env.OPENROUTER_API_KEY) return reply.status(400).send({ error: "OPENROUTER_API_KEY is not configured" });
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
  reply.hijack();
  subscribe(jobChannel(id), reply.raw, req.headers["last-event-id"] as string | undefined);
  // A finished job's channel may already be retired — always end with a fresh snapshot.
  if (!isActiveJob(job)) emitJob(job);
});

// ---------- Notifications ----------

// Each user configures (and tests) their own channels.
app.get("/api/settings/notifications", async (req) => maskSettings(getNotificationSettings(currentUser(req).id)));
app.put("/api/settings/notifications", async (req) => maskSettings(saveNotificationSettings(currentUser(req).id, req.body)));

app.post("/api/notifications/test", async (req) => {
  const { channel } = z.object({ channel: z.enum(notificationChannels) }).parse(req.body);
  return sendTest(currentUser(req).id, channel);
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

app.get("/api/push/key", async () => ({ publicKey: vapidKeys().publicKey }));
app.post("/api/push/subscribe", async (req) => {
  const sub = pushSubscriptionSchema.parse(req.body);
  db.savePushSub(sub, req.headers["user-agent"]?.slice(0, 300) ?? null, currentUser(req).id);
  return { ok: true };
});
app.delete("/api/push/subscribe", async (req) => {
  db.deletePushSub(z.object({ endpoint: z.string() }).parse(req.body).endpoint, currentUser(req).id);
  return { ok: true };
});

// ---------- Search ----------

app.post("/api/search", async (req) => {
  const body = searchRequestSchema.parse(req.body);
  const user = currentUser(req);
  if (body.collectionId) requireCollection(body.collectionId, user, "read");
  return search(body, user);
});

app.get("/api/searches", async (req) => {
  const q = req.query as { collectionId?: string; limit?: string };
  return db.listRecentQueries(currentUser(req).id, q.collectionId ? Number(q.collectionId) : null, Math.min(Number(q.limit) || 8, 50));
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
  await app.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
