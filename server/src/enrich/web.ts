import PQueue from "p-queue";
import { z } from "zod";
import type { Item, Job, MissingAttribute, SpecValue } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { upsertVector } from "../db/lance.ts";
import { embed } from "../embedding.ts";
import { askForJson } from "../llm/client.ts";
import { withLlmContext } from "../llm/usage.ts";
import { coerceToType } from "../llm/extract.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { retireChannel } from "../sse/hub.ts";
import { embeddingText, emitJob, jobChannel, jobLog, patchJob } from "../crawler/job.ts";
import { canonicalizeIdentities, lookupIdentity, resolvedIdentity } from "./group.ts";

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

async function lookup(item: Item, attrs: MissingAttribute[]): Promise<{ results: LookupResult[]; webSearches: number }> {
  const wanted = attrs.map((a) => `- ${a.key}: ${a.label} (${a.type}${a.unit ? `, unit: ${a.unit}` : ""})`).join("\n");
  const user = `Product: ${item.title}\nIdentity: ${lookupIdentity(item)}\nKnown specs: ${contextSpecs(item) || "(none)"}\n\nFind:\n${wanted}`;
  const res = await askForJson(answerSchema, SYSTEM, user, {
    purpose: "web-lookup",
    model: env.OPENROUTER_WEB_MODEL,
    maxTokens: 1500,
    extra: {
      tools: [
        {
          type: "openrouter:web_search",
          parameters: { engine: env.WEB_SEARCH_ENGINE, max_results: 5, max_uses: 2, search_context_size: "medium" },
        },
      ],
    },
  });
  const byKey = new Map(res.data.results.map((r) => [r.key, r]));
  const results = attrs.map((a) => {
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

/** Cached fact for a product: under its canonical identity, else under any spelling it was grouped from (cached before grouping). */
function cachedFact(canonical: string, key: string): db.WebFact | null {
  const direct = db.getWebFact(canonical, key);
  if (direct) return direct;
  for (const alias of db.aliasesOf(canonical)) {
    const fact = alias === canonical ? null : db.getWebFact(alias, key);
    if (fact) return fact;
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
  /** Who asked — owns the job and pays for the lookups. */
  userId: number | null;
  attributes: MissingAttribute[];
  itemIds: number[];
}

const activeByScope = new Map<string, number>();

/** Starts a background enrichment job (or returns the running one for the same scope + keys). */
export function startEnrichment(input: EnrichInput): Job {
  const scope = `${input.userId ?? "-"}:${input.collectionId ?? "all"}:${input.attributes.map((a) => a.key).sort().join(",")}`;
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

  // Spelling variants of the same product share one lookup (one LLM call for identities never grouped before).
  const needing = items.filter((item) => input.attributes.some((a) => item.specs[a.key] === undefined));
  const grouping = await canonicalizeIdentities(needing);
  if (grouping.calls) jobLog(jobId, `Grouped product names: ${grouping.merged} variants merged into the same product`);

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
        const sibling = db.findPageValue(db.aliasesOf(identity), attr.key);
        const value = sibling ? coerceToType(sibling.value, attr.type) : null;
        if (sibling && value !== null) {
          db.saveWebFact({ identity, key: attr.key, value, unit: attr.unit ?? null, sourceUrl: sibling.url, confidence: 0.95, found: true });
          fact = db.getWebFact(identity, attr.key);
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

  // Products with the most listings first: each paid lookup then fills the most items.
  toFetch.sort((a, b) => b[1].items.length - a[1].items.length);
  const capped = toFetch.slice(0, env.ENRICH_MAX_LOOKUPS);
  patchJob(jobId, {
    itemsFound: groups.size,
    itemsIndexed: groups.size - toFetch.length,
    itemsRemaining: toFetch.length - capped.length,
    message: `${groups.size} products, ${groups.size - toFetch.length} cached, ${capped.length} to look up${toFetch.length > capped.length ? ` (capped at ${env.ENRICH_MAX_LOOKUPS})` : ""}`,
  });
  jobLog(jobId, `Need ${labels} for ${groups.size} distinct products (${needing.length} listings); ${toFetch.length} not cached${siblingFills ? `, ${siblingFills} values copied from sibling listings` : ""}`);
  if (toFetch.length > capped.length)
    jobLog(jobId, `Only the ${capped.length} products with the most listings are looked up now (ENRICH_MAX_LOOKUPS); ${toFetch.length - capped.length} left for the next run`, "warn");

  let done = groups.size - toFetch.length;
  let failed = 0;
  const queue = new PQueue({ concurrency: 3 });
  for (const [identity, g] of capped) {
    queue.add(async () => {
      try {
        const res = await lookup(g.items[0], g.attrs);
        lookups++;
        webSearches += res.webSearches;
        for (const r of res.results) {
          const attr = g.attrs.find((a) => a.key === r.key)!;
          const found = r.value !== null && (r.confidence ?? 0) >= env.ENRICH_MIN_CONFIDENCE;
          db.saveWebFact({ identity, key: r.key, value: found ? r.value : null, unit: r.unit, sourceUrl: r.sourceUrl, confidence: r.confidence, found });
          const fact = db.getWebFact(identity, r.key)!;
          for (const item of g.items) if (applyFact(item, attr, fact)) (applied++, changed.add(item));
          jobLog(jobId, found ? `${identity}: ${r.key} = ${r.value}${r.unit ? " " + r.unit : ""} (${Math.round((r.confidence ?? 0) * 100)}%)` : `${identity}: ${r.key} not found${r.value !== null ? ` (low confidence ${r.confidence})` : ""}`);
        }
      } catch (err) {
        failed++;
        jobLog(jobId, `Lookup failed for ${identity}: ${errorMessage(err)}`, "warn");
      } finally {
        done++;
        patchJob(jobId, { itemsIndexed: done, itemsFailed: failed, webSearches });
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
    message: `Filled ${applied} values from ${lookups} web lookups (${webSearches} searches)${toFetch.length > capped.length ? ` — ${toFetch.length - capped.length} products not looked up yet` : ""}`,
    finishedAt: Date.now(),
  });
  jobLog(jobId, `Done: ${applied} values filled, ${lookups} lookups, ${webSearches} web searches, ${failed} failed`);
}
