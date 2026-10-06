import type { SQLInputValue } from "node:sqlite";
import type { Filter, SpecKey, SpecType, SpecValue } from "@specharvest/shared";
import { scopeCondition, type CollectionScope } from "../db/sqlite.ts";

export const COLUMN_KEYS: Record<string, { column: string; type: SpecType }> = {
  price: { column: "price", type: "number" },
  title: { column: "title", type: "string" },
};

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

/**
 * Builds a parametrized candidate query. Spec values are read with
 * json_extract on a quoted path (key is bound, never interpolated), and every
 * condition tolerates a missing value — rows lacking a filtered key come back
 * too, so search can put them in the "unknown" bucket instead of dropping them.
 */
export function buildCandidateQuery(filters: Filter[], registry: SpecKey[], scope: CollectionScope, includeGone = false): CandidateQuery {
  const types = new Map<string, SpecType>(registry.map((k) => [k.key, k.type]));
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const active: Filter[] = [];
  const pending: Filter[] = [];

  const cond = scopeCondition(scope);
  if (cond) {
    where.push(cond.sql);
    params.push(...cond.params);
  }
  // Listings that disappeared from the shop (sold/removed).
  if (!includeGone) where.push("gone_at IS NULL");

  for (const f of filters) {
    const column = COLUMN_KEYS[f.key];
    const type = column?.type ?? types.get(f.key);
    if (!type) {
      pending.push(f);
      continue;
    }
    const expr = column ? column.column : "json_extract(specs, '$.' || json_quote(?))";
    const exprParams: SQLInputValue[] = column ? [] : [f.key];

    if (f.op === "exists") {
      // Nothing to compare — presence is checked when bucketing.
      active.push(f);
      continue;
    }

    let cond: string | null = null;
    let condParams: SQLInputValue[] = [];
    if (f.op === "contains") {
      const v = toSqlValue(f.value, "string");
      if (v === undefined) continue;
      cond = `lower(CAST(${expr} AS TEXT)) LIKE '%' || ? || '%'`;
      condParams = [...exprParams, v];
    } else if (type === "number") {
      const v = toSqlValue(f.value, "number");
      if (v === undefined) continue;
      cond = `CAST(${expr} AS REAL) ${NUMERIC_OPS[f.op]} ?`;
      condParams = [...exprParams, v];
    } else if (type === "boolean") {
      if (f.op !== "eq" && f.op !== "neq") continue;
      const v = toSqlValue(f.value, "boolean");
      if (v === undefined) continue;
      cond = `${expr} ${f.op === "eq" ? "=" : "<>"} ?`;
      condParams = [...exprParams, v];
    } else {
      const v = toSqlValue(f.value, "string");
      if (v === undefined) continue;
      if (f.op === "eq" || f.op === "neq") {
        cond = `lower(${expr}) ${f.op === "eq" ? "=" : "<>"} ?`;
      } else {
        cond = `lower(${expr}) ${NUMERIC_OPS[f.op]} ?`;
      }
      condParams = [...exprParams, v];
    }

    where.push(`(${expr} IS NULL OR ${cond})`);
    params.push(...exprParams, ...condParams);
    active.push(f);
  }

  const sql = `SELECT id FROM items${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return { sql, params, active, pending };
}

/** Whether an item has a value for a plan key (column keys always count when non-null). */
export function hasValue(item: { price: number | null; title: string; specs: Record<string, SpecValue> }, key: string): boolean {
  if (key === "price") return item.price !== null;
  if (key === "title") return !!item.title;
  return item.specs[key] !== undefined && item.specs[key] !== null;
}

export function valueOf(item: { price: number | null; title: string; specs: Record<string, SpecValue> }, key: string): SpecValue | null {
  if (key === "price") return item.price;
  if (key === "title") return item.title;
  return item.specs[key] ?? null;
}
