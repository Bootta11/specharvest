import PQueue from "p-queue";
import { z } from "zod";
import type { Item, Job, LookupStats, MissingAttribute, SpecKey, SpecValue } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { upsertVector } from "../db/lance.ts";
import { embed } from "../embedding.ts";
import { askForJson } from "../llm/client.ts";
import { withLlmContext } from "../llm/usage.ts";
import { coerceToType } from "../llm/extract.ts";
import { proposeKeyMerges } from "../llm/consolidate.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { retireChannel } from "../sse/hub.ts";
import { embeddingText, emitJob, jobChannel, jobLog, patchJob } from "../crawler/job.ts";
import { canonicalizeIdentities, lookupIdentity, resolvedIdentity } from "./group.ts";
import { candidateAttributes } from "./predict.ts";

export { lookupIdentity };

const log = createLogger("enrich");

const answerSchema = z.object({
  results: z
    .array(
      z.object({
        key: z.string(),
        value: z.union([z.number(), z.boolean(), z.string()]).nullable(),
        unit: z.string().nullable().optional(),
        confidence: z.coerce.number().min(0).max(1).nullable().optional(),
        source_url: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

const SYSTEM = `You research product specifications on the web. Use web search to find the requested attributes for the exact product described (match brand, model, variant/engine and year as closely as possible; manufacturer pages and reputable spec databases are best).

Return ONLY one JSON object:
{ "results": [ { "key": string, "value": number | boolean | string | null, "unit": string | null, "confidence": number, "source_url": string | null } ] }

- One result per requested key, using the key exactly as given.
- value in the requested unit and type (convert if the source uses another unit, e.g. hp -> kW: kW = hp × 0.7355). null if you could not find it.
- confidence 0..1: how sure you are this value applies to this exact variant (lower it when only a different engine/trim/year was found).
- source_url: the page the value came from.
- If sources disagree, pick the value for the standard configuration (e.g. boot volume with rear seats up, base engine of the named variant) and lower the confidence a little.
- Your final message must be the JSON object only — no explanations before or after it.`;

function contextSpecs(item: Item): string {
  return Object.entries(item.specs)
    .filter(([, v]) => typeof v !== "boolean")
    .slice(0, 15)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

interface LookupResult {
  key: string;
  value: SpecValue | null;
  unit: string | null;
  confidence: number | null;
  sourceUrl: string | null;
}

const attrLines = (attrs: MissingAttribute[]) => attrs.map((a) => `- ${a.key}: ${a.label} (${a.type}${a.unit ? `, unit: ${a.unit}` : ""})`).join("\n");

/**
 * One paid web search for `attrs`. `extras` (predicted attributes nobody asked for yet) ride along in the
 * same search for the price of a few output tokens; the model fills them only from pages it already found.
 */
async function lookup(item: Item, attrs: MissingAttribute[], extras: MissingAttribute[] = []): Promise<{ results: LookupResult[]; webSearches: number }> {
  const also = extras.length
    ? `\n\nAlso fill these if the pages you found state them for this exact product — don't search specifically for them; null otherwise:\n${attrLines(extras)}`
    : "";
  const user = `Product: ${item.title}\nIdentity: ${lookupIdentity(item)}\nKnown specs: ${contextSpecs(item) || "(none)"}\n\nFind:\n${attrLines(attrs)}${also}`;
  const res = await askForJson(answerSchema, SYSTEM, user, {
    purpose: "web-lookup",
    model: env.OPENROUTER_WEB_MODEL,
    maxTokens: 1500 + 60 * extras.length,
    extra: {
      tools: [
        {
          type: "openrouter:web_search",
          parameters: { engine: env.WEB_SEARCH_ENGINE, max_results: 5, max_uses: env.WEB_SEARCH_MAX_USES, search_context_size: "medium" },
        },
      ],
    },
  });
  const byKey = new Map(res.data.results.map((r) => [r.key, r]));
  const results = [...attrs, ...extras].map((a) => {
    const r = byKey.get(a.key);
    const value = r?.value == null ? null : coerceToType(r.value, a.type);
    return {
      key: a.key,
      value,
      unit: r?.unit ?? a.unit ?? null,
      confidence: r?.confidence ?? null,
      sourceUrl: (r?.source_url && /^https?:/.test(r.source_url) ? r.source_url : null) ?? res.citations[0]?.url ?? null,
    };
  });
  return { results, webSearches: res.webSearches };
}

/**
 * Cached fact for a product: under its canonical identity or any spelling it was grouped from, and under
 * the key or any synonym of it (key_aliases). A found value anywhere beats a "not found".
 */
function cachedFact(canonical: string, key: string): db.WebFact | null {
  const identities = db.aliasesOf(canonical);
  let notFound: db.WebFact | null = null;
  for (const k of [key, ...db.keyAliasesOf(key).filter((x) => x !== key)]) {
    for (const identity of identities) {
      const fact = db.getWebFact(identity, k);
      if (fact?.found) return fact;
      notFound ??= fact;
    }
  }
  return notFound;
}

/** A value another listing of the same product states on its own page, under the key or a synonym. */
function siblingValue(identity: string, key: string): { value: SpecValue; url: string } | null {
  const identities = db.aliasesOf(identity);
  for (const k of db.keyAliasesOf(key)) {
    const found = db.findPageValue(identities, k);
    if (found) return found;
  }
  return null;
}

function applyFact(item: Item, attr: MissingAttribute, fact: db.WebFact): boolean {
  if (!fact.found || fact.value === null || item.specs[attr.key] !== undefined) return false;
  db.setItemSpec(item.id, attr.key, fact.value, { origin: "web", sourceUrl: fact.sourceUrl, confidence: fact.confidence });
  db.upsertSpecKey(item.collectionId, { key: attr.key, type: attr.type, unit: attr.unit ?? fact.unit, label: attr.label, example: String(fact.value), origin: "web" }, 0);
  item.specs[attr.key] = fact.value;
  return true;
}

/**
 * Applies already-cached web facts to items synchronously (no web calls) and
 * returns the items that still need a lookup for at least one attribute.
 */
export function applyCachedFacts(items: Item[], attrs: MissingAttribute[]): { applied: number; needLookup: Item[] } {
  let applied = 0;
  const needLookup: Item[] = [];
  const touched = new Set<Item>();
  for (const item of items) {
    let needs = false;
    for (const attr of attrs) {
      if (item.specs[attr.key] !== undefined) continue;
      const fact = cachedFact(resolvedIdentity(item), attr.key);
      if (!fact) needs = true;
      else if (applyFact(item, attr, fact)) (applied++, touched.add(item));
    }
    if (needs) needLookup.push(item);
  }
  for (const item of touched) {
    embed(embeddingText(item))
      .then((v) => upsertVector(item.id, item.collectionId, v))
      .catch((err) => log.warn("re-embed failed", errorMessage(err)));
  }
  if (applied) for (const cid of new Set([...touched].map((i) => i.collectionId))) db.recountSpecKeys(cid);
  return { applied, needLookup };
}

export interface EnrichInput {
  collectionId: number | null;
  /** Set when started for a group search — keeps its job apart from an "all collections" one. */
  groupId?: number | null;
  /** Who asked — owns the job and pays for the lookups. */
  userId: number | null;
  attributes: MissingAttribute[];
  itemIds: number[];
}

const activeByScope = new Map<string, number>();

/** Paid lookups running right now, by product + key — shared by every user's jobs so nobody pays twice. */
const inflight = new Map<string, Promise<void>>();
const flightKey = (identity: string, key: string) => `${identity}\u0000${db.canonicalKey(key)}`;

/**
 * Checks newly seen web keys for synonyms of known ones ("trunk_volume_liters" = "boot_capacity_liters")
 * and records them as global key aliases, so facts cached under either name are found. One LLM call,
 * only when there are keys never reviewed before. Non-fatal.
 */
async function reviewWebKeys(jobId: number, attrs: MissingAttribute[]) {
  const stats = db.webFactKeyStats();
  const all: SpecKey[] = [
    ...stats,
    ...attrs.filter((a) => !stats.some((s) => s.key === a.key)).map((a) => ({ key: a.key, type: a.type, unit: a.unit ?? null, label: a.label, example: null, count: 0, origin: "web" as const })),
  ];
  const reviewed = db.reviewedKeys(all.map((k) => k.key));
  if (all.every((k) => reviewed.has(k.key))) return;
  try {
    const merges = all.length >= 2 ? await proposeKeyMerges(all) : [];
    const saved = merges.filter((m) => m.factor === 1 && db.saveKeyAlias(m.from, m.to));
    for (const k of all) db.saveKeyAlias(k.key, k.key);
    if (saved.length) jobLog(jobId, `Same attribute, different names: ${saved.map((m) => `${m.from} → ${m.to}`).join(", ")}`);
  } catch (err) {
    jobLog(jobId, `Key synonym check skipped: ${errorMessage(err)}`, "warn");
  }
}

/** Starts a background enrichment job (or returns the running one for the same scope + keys). */
export function startEnrichment(input: EnrichInput): Job {
  const scope = `${input.userId ?? "-"}:${input.groupId ? `g${input.groupId}` : (input.collectionId ?? "all")}:${input.attributes.map((a) => a.key).sort().join(",")}`;
  const running = activeByScope.get(scope);
  if (running) {
    const job = db.getJob(running);
    if (job && (job.status === "queued" || job.status === "running")) return job;
  }
  const job = db.createJob("enrich", input.collectionId, undefined, input.userId);
  activeByScope.set(scope, job.id);
  emitJob(job);
  withLlmContext({ jobId: job.id, collectionId: input.collectionId, userId: input.userId }, () => runEnrichment(job.id, input))
    .catch((err) => {
      patchJob(job.id, { status: "failed", error: errorMessage(err), finishedAt: Date.now() });
      jobLog(job.id, `Enrichment failed: ${errorMessage(err)}`, "error");
    })
    .finally(() => {
      activeByScope.delete(scope);
      retireChannel(jobChannel(job.id));
    });
  return job;
}

async function runEnrichment(jobId: number, input: EnrichInput) {
  const items = db.getItemsByIds(input.itemIds);
  const labels = input.attributes.map((a) => a.label).join(", ");
  patchJob(jobId, { status: "running", message: `Looking up ${labels}` });
  await reviewWebKeys(jobId, input.attributes);

  // Spelling variants of the same product share one lookup (one LLM call for identities never grouped before).
  const needing = items.filter((item) => input.attributes.some((a) => item.specs[a.key] === undefined));
  const grouping = await canonicalizeIdentities(needing);
  if (grouping.calls) jobLog(jobId, `Grouped product names: ${grouping.merged} variant${grouping.merged === 1 ? "" : "s"} merged into the same product`);
  for (const m of grouping.merges) jobLog(jobId, `Same product: "${m.from}" → "${m.to}"`);

  // Group items needing any attribute by canonical product identity → one web call per product.
  const groups = new Map<string, { items: Item[]; attrs: Map<string, MissingAttribute> }>();
  for (const item of needing) {
    const need = input.attributes.filter((a) => item.specs[a.key] === undefined);
    const id = resolvedIdentity(item);
    const g = groups.get(id) ?? { items: [] as Item[], attrs: new Map<string, MissingAttribute>() };
    g.items.push(item);
    for (const a of need) g.attrs.set(a.key, a);
    groups.set(id, g);
  }

  let applied = 0;
  let webSearches = 0;
  let lookups = 0;
  let siblingFills = 0;
  const changed = new Set<Item>();
  const toFetch: Array<[string, { items: Item[]; attrs: MissingAttribute[] }]> = [];

  // Cache first, then another listing of the same product that states the value on its own page (both free).
  for (const [identity, g] of groups) {
    const uncached: MissingAttribute[] = [];
    for (const attr of g.attrs.values()) {
      let fact = cachedFact(identity, attr.key);
      if (!fact) {
        const sibling = siblingValue(identity, attr.key);
        const value = sibling ? coerceToType(sibling.value, attr.type) : null;
        if (sibling && value !== null) {
          const key = db.canonicalKey(attr.key);
          db.saveWebFact({ identity, key, value, unit: attr.unit ?? null, sourceUrl: sibling.url, confidence: 0.95, found: true });
          fact = db.getWebFact(identity, key);
          siblingFills++;
          jobLog(jobId, `${identity}: ${attr.key} = ${value} (from another listing of the same product)`);
        }
      }
      if (!fact) {
        uncached.push(attr);
        continue;
      }
      for (const item of g.items) if (applyFact(item, attr, fact)) (applied++, changed.add(item));
    }
    if (uncached.length) toFetch.push([identity, { items: g.items, attrs: uncached }]);
  }

  // Name variants inside this job's products (grouped now or by an earlier job).
  const merges: Array<{ from: string; to: string }> = [];
  for (const [identity, g] of groups) {
    for (const from of new Set(g.items.map(lookupIdentity))) if (from !== identity) merges.push({ from, to: identity });
  }

  // Products with the most listings first: each paid lookup then fills the most items.
  toFetch.sort((a, b) => b[1].items.length - a[1].items.length);
  const capped = toFetch.slice(0, env.ENRICH_MAX_LOOKUPS);
  const lookupStats: LookupStats = {
    attributes: input.attributes.map((a) => a.label),
    listings: needing.length,
    products: groups.size,
    merged: merges.length,
    merges: merges.slice(0, 100),
    cached: groups.size - toFetch.length,
    fromSiblings: siblingFills,
    toLookUp: capped.length,
    remaining: toFetch.length - capped.length,
  };
  patchJob(jobId, {
    itemsFound: groups.size,
    itemsIndexed: groups.size - toFetch.length,
    itemsRemaining: toFetch.length - capped.length,
    lookup: lookupStats,
    message: `${groups.size} products, ${groups.size - toFetch.length} cached, ${capped.length} to look up${toFetch.length > capped.length ? ` (capped at ${env.ENRICH_MAX_LOOKUPS})` : ""}`,
  });
  jobLog(jobId, `Need ${labels} for ${groups.size} distinct products (${needing.length} listings); ${toFetch.length} not cached${siblingFills ? `, ${siblingFills} values copied from sibling listings` : ""}`);
  if (toFetch.length > capped.length)
    jobLog(jobId, `Only the ${capped.length} products with the most listings are looked up now (ENRICH_MAX_LOOKUPS); ${toFetch.length - capped.length} left for the next run`, "warn");

  // Likely-wanted extra attributes, asked for in the same paid searches (no LLM call when the profile is stored).
  const profileCollection = input.collectionId ?? mostCommon(capped.flatMap(([, g]) => g.items.map((i) => i.collectionId)));
  const candidates = env.ENRICH_PREFETCH_MAX > 0 && capped.length > 0 && profileCollection != null ? await candidateAttributes(profileCollection, needing) : [];

  /** Applies whatever is cached now for these attributes; returns the ones still unanswered. */
  const settle = (identity: string, g: { items: Item[] }, attrs: MissingAttribute[]) =>
    attrs.filter((attr) => {
      const fact = cachedFact(identity, attr.key);
      if (!fact) return true;
      for (const item of g.items) if (applyFact(item, attr, fact)) (applied++, changed.add(item));
      return false;
    });

  let done = groups.size - toFetch.length;
  let failed = 0;
  let prefetched = 0;
  const queue = new PQueue({ concurrency: 3 });
  for (const [identity, g] of capped) {
    queue.add(async () => {
      let release = () => {};
      const claimed: string[] = [];
      try {
        // Another job (any user's) is looking this product up right now: wait for it instead of paying again.
        let attrs = g.attrs;
        const running = [...new Set(attrs.map((a) => inflight.get(flightKey(identity, a.key))).filter((p) => !!p))];
        if (running.length) {
          await Promise.allSettled(running);
          attrs = settle(identity, g, attrs);
          if (attrs.length === 0) {
            jobLog(jobId, `${identity}: answered by a lookup that was already running`);
            return;
          }
        }
        const extras = pickExtras(identity, g.items, attrs, candidates);
        const flight = new Promise<void>((r) => (release = r));
        for (const a of [...attrs, ...extras]) {
          const k = flightKey(identity, a.key);
          if (!inflight.has(k)) (inflight.set(k, flight), claimed.push(k));
        }

        const res = await lookup(g.items[0], attrs, extras);
        lookups++;
        webSearches += res.webSearches;
        const extraFound: string[] = [];
        for (const r of res.results) {
          const attr = attrs.find((a) => a.key === r.key);
          const found = r.value !== null && (r.confidence ?? 0) >= env.ENRICH_MIN_CONFIDENCE;
          const key = db.canonicalKey(r.key);
          if (!attr) {
            // A predicted extra: cache only what was found — one search not covering it doesn't mean it can't be found.
            if (!found) continue;
            db.saveWebFact({ identity, key, value: r.value, unit: r.unit, sourceUrl: r.sourceUrl, confidence: r.confidence, found });
            extraFound.push(`${r.key} = ${r.value}${r.unit ? " " + r.unit : ""}`);
            prefetched++;
            continue;
          }
          db.saveWebFact({ identity, key, value: found ? r.value : null, unit: r.unit, sourceUrl: r.sourceUrl, confidence: r.confidence, found });
          const fact = db.getWebFact(identity, key)!;
          for (const item of g.items) if (applyFact(item, attr, fact)) (applied++, changed.add(item));
          jobLog(jobId, found ? `${identity}: ${r.key} = ${r.value}${r.unit ? " " + r.unit : ""} (${Math.round((r.confidence ?? 0) * 100)}%)` : `${identity}: ${r.key} not found${r.value !== null ? ` (low confidence ${r.confidence})` : ""}`);
        }
        if (extraFound.length) jobLog(jobId, `${identity}: +${extraFound.length} extra specs cached for later searches (${extraFound.join(", ")})`);
      } catch (err) {
        failed++;
        jobLog(jobId, `Lookup failed for ${identity}: ${errorMessage(err)}`, "warn");
      } finally {
        for (const k of claimed) inflight.delete(k);
        release();
        done++;
        patchJob(jobId, { itemsIndexed: done, itemsFailed: failed, webSearches, ...(prefetched ? { lookup: { ...lookupStats, prefetched } } : {}) });
      }
    });
  }
  await queue.onIdle();

  for (const item of changed) {
    await upsertVector(item.id, item.collectionId, await embed(embeddingText(item))).catch((err) => log.warn("re-embed failed", errorMessage(err)));
  }
  for (const cid of new Set(items.map((i) => i.collectionId))) db.recountSpecKeys(cid);

  patchJob(jobId, {
    status: "done",
    message: `Filled ${applied} values from ${lookups} web lookups (${webSearches} searches)${prefetched ? `, ${prefetched} extra specs cached` : ""}${toFetch.length > capped.length ? ` — ${toFetch.length - capped.length} products not looked up yet` : ""}`,
    finishedAt: Date.now(),
  });
  jobLog(jobId, `Done: ${applied} values filled, ${lookups} lookups, ${webSearches} web searches, ${prefetched} extra specs cached, ${failed} failed`);
}

function mostCommon(ids: number[]): number | null {
  const counts = new Map<number, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Up to ENRICH_PREFETCH_MAX candidates worth adding to a product's lookup: not asked for already, not stated
 * by any of its listings, not cached and not being looked up elsewhere right now (synonyms count as the same key).
 */
function pickExtras(identity: string, items: Item[], attrs: MissingAttribute[], candidates: MissingAttribute[]): MissingAttribute[] {
  const asked = new Set(attrs.flatMap((a) => db.keyAliasesOf(a.key)));
  const out: MissingAttribute[] = [];
  for (const c of candidates) {
    if (out.length >= env.ENRICH_PREFETCH_MAX) break;
    const names = db.keyAliasesOf(c.key);
    if (names.some((k) => asked.has(k))) continue;
    if (items.some((i) => names.some((k) => i.specs[k] !== undefined))) continue;
    if (cachedFact(identity, c.key) || inflight.has(flightKey(identity, c.key))) continue;
    out.push(c);
    for (const k of names) asked.add(k);
  }
  return out;
}
