import type { SQLInputValue } from "node:sqlite";
import { isListingField, isStrictField, type Filter, type Item, type ListingField, type QueryPlan, type SpecKey, type SpecType, type SpecValue } from "@specharvest/shared";
import { scopeCondition, type CollectionScope } from "../db/sqlite.ts";

/**
 * Listing fields as SQL over item columns. All but price are strict (isStrictField): a missing value never matches,
 * so such items drop out instead of landing in the "can't be judged yet" bucket. A listing without a product name
 * is searched by its title — the same fallback web lookups use (lookupIdentity).
 */
export const COLUMN_KEYS: Record<ListingField, { column: string; type: SpecType }> = {
  price: { column: "price", type: "number" },
  title: { column: "title", type: "string" },
  description: { column: "description", type: "string" },
  product: { column: "COALESCE(NULLIF(identity, ''), title)", type: "string" },
  currency: { column: "currency", type: "string" },
  collection: { column: "collection_id", type: "number" },
};

const columnOf = (key: string) => (isListingField(key) ? COLUMN_KEYS[key] : undefined);

export interface CandidateQuery {
  sql: string;
  params: SQLInputValue[];
  /** Filters applied in SQL (key known). */
  active: Filter[];
  /** Filters on keys nobody has yet (waiting for web enrichment). */
  pending: Filter[];
}

const NUMERIC_OPS: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=", neq: "<>" };

function toSqlValue(v: SpecValue | null | undefined, type: SpecType): SQLInputValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (type === "number") {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "boolean") {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (/^(true|yes|1)$/i.test(String(v))) return 1;
    if (/^(false|no|0)$/i.test(String(v))) return 0;
    return undefined;
  }
  return String(v).toLowerCase();
}

/** `contains` matches what the user typed literally: % and _ are no wildcards. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One filter as SQL: on a key nobody has yet, not comparable (skipped), presence only (checked when bucketing), or a condition. */
export type CompiledFilter = { kind: "pending" } | { kind: "skip" } | { kind: "exists" } | { kind: "sql"; sql: string; params: SQLInputValue[] };

/**
 * Spec values are read with json_extract on a quoted path (key is bound, never interpolated). Unless the key is
 * strict, the condition tolerates a missing value — rows lacking it come back too, so search can put them in the
 * "unknown" bucket instead of dropping them. Text is compared through ulower() (Unicode-aware, see db/sqlite.ts).
 */
export function compileFilter(f: Filter, types: Map<string, SpecType>): CompiledFilter {
  const column = columnOf(f.key);
  const type = column?.type ?? types.get(f.key);
  if (!type) return { kind: "pending" };
  const expr = column ? column.column : "json_extract(specs, '$.' || json_quote(?))";
  const exprParams: SQLInputValue[] = column ? [] : [f.key];

  if (f.op === "exists") {
    // Strict fields have no "unknown" bucket to sort a missing value into, so their presence is checked here.
    return isStrictField(f.key) ? { kind: "sql", sql: `(${expr} IS NOT NULL AND ${expr} <> '')`, params: [] } : { kind: "exists" };
  }

  let cond: string;
  let condParams: SQLInputValue[];
  if (f.op === "in") {
    if (type === "boolean") return { kind: "skip" };
    const values = (Array.isArray(f.value) ? f.value : [f.value]).map((v) => toSqlValue(v, type)).filter((v): v is SQLInputValue => v !== undefined);
    if (values.length === 0) return { kind: "skip" };
    const list = values.map(() => "?").join(",");
    cond = type === "number" ? `CAST(${expr} AS REAL) IN (${list})` : `ulower(${expr}) IN (${list})`;
    condParams = [...exprParams, ...values];
  } else if (Array.isArray(f.value)) {
    // A list only means something with `in` (sanitizePlan turns eq + list into in).
    return { kind: "skip" };
  } else if (f.op === "contains") {
    const v = toSqlValue(f.value, "string");
    if (v === undefined) return { kind: "skip" };
    cond = `ulower(CAST(${expr} AS TEXT)) LIKE '%' || ? || '%' ESCAPE '\\'`;
    condParams = [...exprParams, escapeLike(String(v))];
  } else if (type === "number") {
    const v = toSqlValue(f.value, "number");
    if (v === undefined) return { kind: "skip" };
    cond = `CAST(${expr} AS REAL) ${NUMERIC_OPS[f.op]} ?`;
    condParams = [...exprParams, v];
  } else if (type === "boolean") {
    if (f.op !== "eq" && f.op !== "neq") return { kind: "skip" };
    const v = toSqlValue(f.value, "boolean");
    if (v === undefined) return { kind: "skip" };
    cond = `${expr} ${f.op === "eq" ? "=" : "<>"} ?`;
    condParams = [...exprParams, v];
  } else {
    const v = toSqlValue(f.value, "string");
    if (v === undefined) return { kind: "skip" };
    cond = `ulower(${expr}) ${NUMERIC_OPS[f.op]} ?`;
    condParams = [...exprParams, v];
  }
  if (isStrictField(f.key)) return { kind: "sql", sql: cond, params: condParams };
  return { kind: "sql", sql: `(${expr} IS NULL OR ${cond})`, params: [...exprParams, ...condParams] };
}

/** The scope, and listings that disappeared from the shop (sold/removed) left out unless asked for. */
function scopeWhere(scope: CollectionScope, includeGone: boolean): { where: string[]; params: SQLInputValue[] } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const cond = scopeCondition(scope);
  if (cond) {
    where.push(cond.sql);
    params.push(...cond.params);
  }
  if (!includeGone) where.push("gone_at IS NULL");
  return { where, params };
}

const whereClause = (where: string[]) => (where.length ? ` WHERE ${where.join(" AND ")}` : "");

/** Parametrized candidate query: the scope plus every filter on a known key (see compileFilter). */
export function buildCandidateQuery(filters: Filter[], registry: SpecKey[], scope: CollectionScope, includeGone = false): CandidateQuery {
  const types = new Map<string, SpecType>(registry.map((k) => [k.key, k.type]));
  const { where, params } = scopeWhere(scope, includeGone);
  const active: Filter[] = [];
  const pending: Filter[] = [];

  for (const f of filters) {
    const c = compileFilter(f, types);
    if (c.kind === "pending") pending.push(f);
    else if (c.kind === "exists") active.push(f);
    else if (c.kind === "sql") {
      where.push(c.sql);
      params.push(...c.params);
      active.push(f);
    }
  }

  return { sql: `SELECT id FROM items${whereClause(where)}`, params, active, pending };
}

/**
 * One scan for search/facets.ts: what each item in the scope has, plus a 0/1 column per active filter (f0…fN) — the
 * candidate query's own condition, so a filter counts the same in both. Select-list params come before WHERE params.
 */
export function buildFacetQuery(active: Filter[], registry: SpecKey[], scope: CollectionScope, includeGone = false): { sql: string; params: SQLInputValue[] } {
  const types = new Map<string, SpecType>(registry.map((k) => [k.key, k.type]));
  const columns = [
    "collection_id",
    "price",
    "currency",
    "specs",
    ...(["title", "description", "product"] as const).map((k) => `COALESCE(${COLUMN_KEYS[k].column}, '') <> '' AS has_${k}`),
  ];
  const params: SQLInputValue[] = [];
  active.forEach((f, i) => {
    const c = compileFilter(f, types);
    columns.push(c.kind === "sql" ? `(${c.sql}) AS f${i}` : `1 AS f${i}`);
    if (c.kind === "sql") params.push(...c.params);
  });
  const scoped = scopeWhere(scope, includeGone);
  return { sql: `SELECT ${columns.join(", ")} FROM items${whereClause(scoped.where)}`, params: [...params, ...scoped.params] };
}

/** Adds `extra` conditions (the filter panel's) on keys the plan doesn't filter yet — the plan's own condition wins. */
export function mergeFilters(plan: QueryPlan, extra: Filter[]): QueryPlan {
  const own = new Set(plan.filters.map((f) => f.key));
  const add = extra.filter((f) => !own.has(f.key));
  return add.length ? { ...plan, filters: [...plan.filters, ...add] } : plan;
}

type ValueSource = Pick<Item, "collectionId" | "title" | "price" | "currency" | "description" | "identity" | "specs">;

const LISTING_VALUE: Record<ListingField, (item: ValueSource) => SpecValue | null> = {
  price: (i) => i.price,
  title: (i) => i.title || null,
  description: (i) => i.description || null,
  product: (i) => i.identity || i.title || null,
  currency: (i) => i.currency || null,
  collection: (i) => i.collectionId,
};

/** A plan key's value on an item: a listing field or a spec (null when missing). */
export function valueOf(item: ValueSource, key: string): SpecValue | null {
  return isListingField(key) ? LISTING_VALUE[key](item) : (item.specs[key] ?? null);
}

export function hasValue(item: ValueSource, key: string): boolean {
  return valueOf(item, key) !== null;
}
