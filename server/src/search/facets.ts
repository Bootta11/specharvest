import { isListingField, isStrictField, LISTING_FIELDS, type Facet, type Filter, type ListingField, type SpecKey, type SpecValue } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { buildFacetQuery } from "./filters.ts";

/** Most distinct values listed per field; the rest stay reachable with `contains`. */
export const FACET_VALUE_CAP = 500;

interface Bucket {
  value: string | number;
  count: number;
  /** Original spellings of a text value (counted case-insensitively) — the most common one is shown. */
  spellings: Map<string, number>;
}

type Acc =
  | { kind: "range"; count: number; min: number; max: number; unit: string | null }
  | { kind: "values"; count: number; numeric: boolean; buckets: Map<string, Bucket> }
  | { kind: "boolean"; count: number; yes: number; no: number }
  | { kind: "text"; count: number };

/** Several fields' filters fail on a row: it counts toward no field. */
const MULTI = Symbol("several fields");

function mostCommon(counts: Map<string, number>): string | null {
  let best: string | null = null;
  for (const [s, n] of counts) if (best === null || n > counts.get(best)!) best = s;
  return best;
}

function listingAcc(key: ListingField, priceUnit: string | null): Acc {
  if (key === "price") return { kind: "range", count: 0, min: Infinity, max: -Infinity, unit: priceUnit };
  if (key === "currency" || key === "collection") return { kind: "values", count: 0, numeric: key === "collection", buckets: new Map() };
  return { kind: "text", count: 0 };
}

function specAcc(spec: SpecKey): Acc {
  if (spec.type === "number") return { kind: "range", count: 0, min: Infinity, max: -Infinity, unit: spec.unit };
  if (spec.type === "boolean") return { kind: "boolean", count: 0, yes: 0, no: 0 };
  return { kind: "values", count: 0, numeric: false, buckets: new Map() };
}

/** How a value is compared: numbers for collection ids, else the same case folding as ulower() in SQL. */
const norm = (acc: { numeric: boolean }, v: string | number) => (acc.numeric ? String(Number(v)) : String(v).toLowerCase());

function add(acc: Acc, v: SpecValue): void {
  if (acc.kind === "text") {
    acc.count++;
  } else if (acc.kind === "range") {
    // Like CAST(… AS REAL) in the candidate query, numeric text counts as a number.
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n)) return;
    acc.count++;
    acc.min = Math.min(acc.min, n);
    acc.max = Math.max(acc.max, n);
  } else if (acc.kind === "boolean") {
    // Only real booleans compare equal to true/false in SQL.
    if (v === true) acc.yes++;
    else if (v === false) acc.no++;
    else return;
    acc.count++;
  } else {
    if (typeof v === "boolean") return;
    const id = norm(acc, v);
    let b = acc.buckets.get(id);
    if (!b) acc.buckets.set(id, (b = { value: acc.numeric ? Number(v) : String(v), count: 0, spellings: new Map() }));
    b.count++;
    acc.count++;
    if (!acc.numeric) b.spellings.set(String(v), (b.spellings.get(String(v)) ?? 0) + 1);
  }
}

/** Values ticked in `eq` / `in` filters, per key — they stay listed even past the cap or with no matches left. */
function selectedValues(active: Filter[]): Map<string, Array<string | number>> {
  const out = new Map<string, Array<string | number>>();
  for (const f of active) {
    const list = f.op === "in" && Array.isArray(f.value) ? f.value : f.op === "eq" && (typeof f.value === "string" || typeof f.value === "number") ? [f.value] : [];
    if (list.length) out.set(f.key, [...(out.get(f.key) ?? []), ...list]);
  }
  return out;
}

function toFacet(key: string, acc: Acc, missing: number, selected: Array<string | number> = []): Facet {
  if (acc.kind === "range") return { key, kind: "range", count: acc.count, missing, min: acc.count ? acc.min : null, max: acc.count ? acc.max : null, unit: acc.unit };
  if (acc.kind === "boolean") return { key, kind: "boolean", count: acc.count, missing, yes: acc.yes, no: acc.no };
  if (acc.kind === "text") return { key, kind: "text", count: acc.count, missing };
  const all = [...acc.buckets.entries()]
    .map(([id, b]) => ({ id, value: acc.numeric ? b.value : (mostCommon(b.spellings) ?? b.value), count: b.count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  const listed = all.slice(0, FACET_VALUE_CAP);
  for (const s of selected) {
    const id = norm(acc, s);
    if (listed.some((x) => x.id === id)) continue;
    listed.push(all.find((x) => x.id === id) ?? { id, value: s, count: 0 });
  }
  const inAll = listed.filter((x) => x.count > 0).length;
  return { key, kind: "values", count: acc.count, missing, values: listed.map(({ value, count }) => ({ value, count })), more: all.length - inAll };
}

/**
 * Value counts per field for a filter panel: listing fields, then every registry key present in the scope. Each
 * field is counted over the items that pass every *other* active filter, so its own options stay visible while it
 * is filtered ("petrol (18)" next to a ticked "diesel"). Pass/fail per filter comes from the same SQL as the
 * candidate query, and an item missing a filtered key fails that filter — as in search's matched/unknown buckets.
 */
export function computeFacets(active: Filter[], keys: SpecKey[], scope: db.CollectionScope, includeGone = false): Facet[] {
  const { sql, params } = buildFacetQuery(active, keys, scope, includeGone);
  const rows = db.queryFacetRows(sql, params, active.length);
  const registry = new Map(keys.filter((k) => !isListingField(k.key)).map((k) => [k.key, k]));
  const accs = new Map<string, Acc>();
  const accFor = (key: string, make: () => Acc) => {
    let a = accs.get(key);
    if (!a) accs.set(key, (a = make()));
    return a;
  };
  const rowHas = (row: db.FacetRow, key: string) => (key === "price" ? row.price !== null : row.specs[key] !== undefined && row.specs[key] !== null);

  // Prices are compared as plain numbers, so a currency is shown only when every priced listing uses it.
  const currencies = new Set(rows.filter((r) => r.price !== null).map((r) => r.currency));
  const priceUnit = currencies.size === 1 ? [...currencies][0] : null;

  let passAll = 0;
  const failOnly = new Map<string, number>();
  for (const row of rows) {
    // The one field whose filters this row fails (it then counts toward that field only), or MULTI.
    let failed: string | typeof MULTI | null = null;
    for (let i = 0; i < active.length; i++) {
      const key = active[i].key;
      if (row.passes[i] && (isStrictField(key) || rowHas(row, key))) continue;
      failed = failed === null || failed === key ? key : MULTI;
    }
    // Rows each field is counted over — `missing` is what's left after the ones with a value.
    if (failed === null) passAll++;
    else if (failed !== MULTI) failOnly.set(failed, (failOnly.get(failed) ?? 0) + 1);
    const counts = (key: string) => failed === null || failed === key;

    const listing: Array<[ListingField, SpecValue | null]> = [
      ["price", row.price],
      ["title", row.hasTitle || null],
      ["description", row.hasDescription || null],
      ["product", row.hasProduct || null],
      ["currency", row.currency],
      ["collection", row.collectionId],
    ];
    for (const [key, v] of listing) {
      if (v === null) continue;
      const acc = accFor(key, () => listingAcc(key, priceUnit));
      if (counts(key)) add(acc, v);
    }
    for (const [key, v] of Object.entries(row.specs)) {
      const spec = registry.get(key);
      if (!spec || v === null || v === undefined) continue;
      const acc = accFor(key, () => specAcc(spec));
      if (counts(key)) add(acc, v);
    }
  }

  const selected = selectedValues(active);
  return [...LISTING_FIELDS, ...registry.keys()].flatMap((key) => {
    const acc = accs.get(key);
    return acc ? [toFacet(key, acc, passAll + (failOnly.get(key) ?? 0) - acc.count, selected.get(key))] : [];
  });
}
