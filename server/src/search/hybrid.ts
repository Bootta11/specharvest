import { humanizeKey, type Item, type MissingAttribute, type QueryPlan, type SearchRequest, type SearchResponse, type SpecKey } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { rankByVector } from "../db/lance.ts";
import { embed } from "../embedding.ts";
import { applyCachedFacts, startEnrichment } from "../enrich/web.ts";
import { normalizeQuery, parseQuery, sanitizePlan } from "../llm/parse-query.ts";
import { withLlmContext } from "../llm/usage.ts";
import { buildCandidateQuery, COLUMN_KEYS, hasValue, valueOf } from "./filters.ts";

const DEFAULT_LIMIT = 60;

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

/** In-JS check of a filter against an item that has the value (SQL already did this; used for exists + safety). */
function passes(item: Item, plan: QueryPlan, activeKeys: Set<string>): boolean {
  for (const f of plan.filters) {
    if (!activeKeys.has(f.key)) continue;
    if (f.op === "exists" && !hasValue(item, f.key)) return false;
  }
  return true;
}

/**
 * `scope` is what the caller resolved and checked read access for: `req.collectionId`, the readable members
 * of `req.groupId`, or the viewer's readable collections.
 */
export async function search(req: SearchRequest, viewer: db.Viewer, scope: db.CollectionScope): Promise<SearchResponse> {
  const spent = { cost: 0 };
  const res = await withLlmContext({ collectionId: req.collectionId ?? null, userId: viewer.id, spent }, () => runSearch(req, viewer, scope));
  return { ...res, llmCost: spent.cost };
}

async function runSearch(req: SearchRequest, viewer: db.Viewer, scope: db.CollectionScope): Promise<Omit<SearchResponse, "llmCost">> {
  const collectionId = req.collectionId ?? null;
  const keys: SpecKey[] = db.listSpecKeys(scope);
  const limit = req.limit ?? DEFAULT_LIMIT;

  let plan: QueryPlan;
  if (req.plan) plan = sanitizePlan(req.plan, keys, db.keyAliasesOf);
  else if (req.query?.trim()) {
    plan = await parseQuery(req.query.trim(), scope, keys);
    db.recordSearch(viewer.id, db.historySlot(collectionId, req.groupId), normalizeQuery(req.query));
  }
  else plan = { filters: [], sort: null, semanticText: null, missingAttributes: [], show: [] };

  const known = new Set([...Object.keys(COLUMN_KEYS), ...keys.map((k) => k.key)]);
  const q = buildCandidateQuery(plan.filters, keys, scope, req.includeGone);
  const pool = db.getItemsByIds(db.queryItemIds(q.sql, q.params));
  const activeKeys = new Set(q.active.map((f) => f.key));
  const sortKey = plan.sort && known.has(plan.sort.key) ? plan.sort : null;

  // ---- Which attributes are missing / poorly covered → web enrichment ----
  const wanted = new Map<string, MissingAttribute>();
  for (const m of plan.missingAttributes) wanted.set(m.key, m);
  const referenced = [...new Set([...q.active.map((f) => f.key), ...(sortKey ? [sortKey.key] : []), ...plan.show.filter((k) => known.has(k))])].filter((k) => !COLUMN_KEYS[k]);
  for (const k of referenced) {
    const covered = pool.filter((i) => hasValue(i, k)).length;
    if (pool.length > 0 && covered / pool.length < env.ENRICH_COVERAGE_THRESHOLD) {
      const spec = keys.find((x) => x.key === k)!;
      // Registry labels are the page's own wording (often not English) — use the key for display.
      wanted.set(k, { key: k, type: spec.type, unit: spec.unit, label: humanizeKey(k).toLowerCase() });
    }
  }

  let enrichJobId: number | null = null;
  let enrichNote: string | null = null;
  if (wanted.size > 0 && pool.length > 0) {
    const attrs = [...wanted.values()].slice(0, 5);
    const labels = attrs.map((w) => w.label).join(", ");
    // Cached facts (from earlier lookups of the same product) apply instantly.
    const { needLookup } = applyCachedFacts(pool, attrs);
    if (needLookup.length === 0) {
      const stillMissing = pool.filter((i) => attrs.some((a) => !hasValue(i, a.key))).length;
      if (stillMissing) enrichNote = `${stillMissing} items still lack ${labels} (not found on the web)`;
    } else if (!env.WEB_SEARCH_ENABLED) enrichNote = "Web lookups are disabled (WEB_SEARCH_ENABLED=false)";
    else if (!env.OPENROUTER_API_KEY) enrichNote = "Web lookups need OPENROUTER_API_KEY";
    else if (req.enrich !== false) {
      const job = startEnrichment({ collectionId, groupId: req.groupId, userId: viewer.id, attributes: attrs, itemIds: needLookup.map((i) => i.id) });
      enrichJobId = job.id;
      enrichNote = `Looking up ${labels} on the web for ${needLookup.length} items`;
    }
  }

  // ---- Bucket: an item missing any actively filtered key can't be judged yet ----
  const matched: Item[] = [];
  const unknown: Item[] = [];
  for (const item of pool) {
    if ([...activeKeys].some((k) => !hasValue(item, k))) unknown.push(item);
    else if (passes(item, plan, activeKeys)) matched.push(item);
  }

  // Semantic score (cosine distance → similarity) for ranking / tie-breaks.
  if (plan.semanticText && matched.length > 0) {
    const vec = await embed(plan.semanticText);
    const dist = await rankByVector(vec, matched.map((i) => i.id), matched.length);
    for (const item of matched) item.score = dist.has(item.id) ? 1 - dist.get(item.id)! : null;
  }

  matched.sort((a, b) => {
    if (sortKey) {
      const av = valueOf(a, sortKey.key);
      const bv = valueOf(b, sortKey.key);
      if (av === null && bv !== null) return 1;
      if (bv === null && av !== null) return -1;
      if (av !== null && bv !== null) {
        const c = compareValues(av, bv);
        if (c !== 0) return sortKey.dir === "asc" ? c : -c;
      }
    }
    if (plan.semanticText) return (b.score ?? -1) - (a.score ?? -1);
    return b.indexedAt - a.indexedAt;
  });

  return {
    plan,
    items: matched.slice(0, limit),
    unknown: unknown.slice(0, limit),
    total: matched.length,
    keys,
    enrichJobId,
    enrichNote,
  };
}
