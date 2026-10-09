import { createHash } from "node:crypto";
import { isListingField, LISTING_FIELDS, queryPlanSchema, type Filter, type QueryPlan, type SpecKey } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { createLogger } from "../lib/logger.ts";
import { askForJson } from "./client.ts";
import { normalizeKey } from "./extract.ts";

const SYSTEM = `You turn a shopper's natural-language request (any language) into a structured search plan over a product database whose attributes are listed in the registry below.

Return ONLY one JSON object:
{
  "filters": [ { "key": string, "op": "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"|"exists", "value": number|boolean|string|null } ],
  "sort": { "key": string, "dir": "asc"|"desc" } | null,
  "semanticText": string | null,
  "missingAttributes": [ { "key": string, "type": "number"|"boolean"|"string", "unit": string|null, "label": string } ],
  "show": [ string ]
}

Rules:
- Hard constraints (numbers, yes/no features, exact categories) become filters on registry keys. "price" is always available (number, in the listing currency).
- The listing fields title, description and product (normalized brand/model/variant/year) are always available too. Use them only with "contains", and only for literal words the user wants in the listing that no registry key covers (e.g. a model name missing from the registry). "currency" takes one of its listed values.
- Use registry keys exactly. For string keys use one of the listed sample values when it matches (map synonyms/other languages: "dizel" -> "diesel", "automatik" -> "automatic").
- Booleans: "has X" / "with X" -> {"op":"eq","value":true}; "without X" -> {"op":"eq","value":false}.
- Superlatives ("biggest boot", "lowest mileage", "cheapest", "most powerful") -> sort, not a filter.
- Convert user units to the key's unit (e.g. "150 hp" on a _kw key -> 110; "under 50k" price -> 50000).
- Vague, descriptive or subjective wishes ("comfortable family car", "good for city driving", "sporty") go into semanticText as a short English phrase. null if nothing descriptive remains.
- If the user asks about an attribute that has NO matching registry key (e.g. "0-100 acceleration", "boot space" when absent), still emit the filter/sort using a NEW English snake_case key with a unit suffix (e.g. "acceleration_0_100_s", "boot_capacity_liters", "power_kw"), AND add it to missingAttributes so it can be looked up on the web. Never put registry keys in missingAttributes.
  Example: "hybrid with the fastest 0-100" (no acceleration key) -> filters [fuel_type eq "hybrid"], sort {"key":"acceleration_0_100_s","dir":"asc"}, semanticText null, missingAttributes [{"key":"acceleration_0_100_s","type":"number","unit":"s","label":"0-100 km/h acceleration"}].
  Example: "car with the biggest boot space" (no boot key) -> filters [], sort {"key":"boot_capacity_liters","dir":"desc"}, semanticText null, missingAttributes [{"key":"boot_capacity_liters","type":"number","unit":"l","label":"boot space"}].
- "show": keys the user wants to see or compare WITHOUT a condition or ordering ("compare boot space and power", "list fuel consumption", "what's the top speed"). Use registry keys when they exist; otherwise a new snake_case key that is also added to missingAttributes. Don't repeat keys already used in filters or sort. [] if none.
- A superlative or numeric condition is NEVER semanticText — it is a sort or filter, even on a missing key.
- Don't invent constraints the user didn't ask for.`;

function registryForPrompt(scope: db.CollectionScope, keys: SpecKey[]): string {
  const samples = db.stringValueSamples(scope);
  const ranges = db.numericRanges(scope);
  const price = db.priceStats(scope);
  const currencies = db.currencies(scope);
  const lines = keys.filter((k) => !isListingField(k.key)).slice(0, 300).map((k) => {
    let extra = "";
    if (k.type === "string" && samples.get(k.key)?.length) extra = ` values: ${samples.get(k.key)!.map((v) => JSON.stringify(v)).join(", ")}`;
    if (k.type === "number" && ranges.get(k.key)) extra = ` range: ${ranges.get(k.key)!.min}–${ranges.get(k.key)!.max}`;
    return `- ${k.key} (${k.type}${k.unit ? `, ${k.unit}` : ""}, ${k.count} items)${extra}`;
  });
  const listing = [
    ...(price ? [`- price (number, ${price.currency ?? "listing currency"}) range: ${price.min}–${price.max}`] : []),
    `- title (string, the listing's title — "contains" only)`,
    `- description (string, the listing's text — "contains" only)`,
    `- product (string, normalized brand/model/variant/year — "contains" only)`,
    ...(currencies.length ? [`- currency (string) values: ${currencies.map((c) => JSON.stringify(c)).join(", ")}`] : []),
  ];
  return [...listing, ...lines].join("\n");
}

const log = createLogger("parse-query");

/** Cache key for a request: case and whitespace don't change the meaning. */
export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Changes whenever keys are added, merged or retyped — a cached plan may then target stale keys. */
export function registrySignature(keys: SpecKey[]): string {
  const parts = keys.map((k) => `${k.key}:${k.type}:${k.unit ?? ""}`).sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

function webKeysForPrompt(keys: SpecKey[]): string {
  const registry = new Set(keys.map((k) => k.key));
  const extra = db.webFactKeys().filter((k) => !registry.has(k));
  if (extra.length === 0) return "";
  return `\n\nAttributes already looked up on the web (when the request needs one of these, reuse the exact key name in filters/sort/show and missingAttributes):\n${extra.map((k) => `- ${k}`).join("\n")}`;
}

/**
 * Natural-language request → plan. Plans are cached per (collection, request) until the key registry changes;
 * multi-collection scopes share the "all" slot — the registry signature keeps users with different scopes apart.
 */
export async function parseQuery(query: string, scope: db.CollectionScope, keys: SpecKey[]): Promise<QueryPlan> {
  const normalized = normalizeQuery(query);
  const collectionId = typeof scope === "number" ? scope : null;
  const sig = registrySignature(keys);
  const cached = db.getCachedPlan(collectionId, normalized, sig);
  if (cached) {
    const parsed = queryPlanSchema.safeParse(JSON.parse(cached));
    if (parsed.success) {
      log.info(`plan cache hit: "${normalized}"`);
      return sanitizePlan(parsed.data, keys, db.keyAliasesOf);
    }
  }
  const { data } = await askForJson(
    queryPlanSchema,
    SYSTEM,
    `Attribute registry:\n${registryForPrompt(scope, keys)}${webKeysForPrompt(keys)}\n\nRequest: ${query}`,
    { purpose: "search", maxTokens: 1200, jsonMode: true },
  );
  const plan = sanitizePlan(data, keys, db.keyAliasesOf);
  db.saveCachedPlan(collectionId, normalized, sig, JSON.stringify(plan));
  return plan;
}

/** A list only means something with `in`: eq + list → in, in + one value → eq; any other op with a list is dropped. */
function normalizeList(f: Filter): Filter | null {
  const list = Array.isArray(f.value) ? [...new Set(f.value)] : null;
  if (f.op === "in") {
    if (!list) return f.value === null || f.value === undefined ? null : { ...f, op: "eq" };
    return list.length === 1 ? { ...f, op: "eq", value: list[0] } : { ...f, value: list };
  }
  if (!list) return f;
  if (f.op === "eq") return list.length === 1 ? { ...f, value: list[0] } : { ...f, op: "in", value: list };
  return null;
}

/**
 * Normalizes keys and keeps missingAttributes consistent with the registry. `synonyms` (key_aliases) maps a
 * key to every name of the same attribute, canonical first: an unknown key becomes the registry's name for it,
 * else the canonical one — so web facts cached under any synonym are found.
 */
export function sanitizePlan(plan: Omit<QueryPlan, "show"> & { show?: string[] }, keys: SpecKey[], synonyms: (key: string) => string[] = (k) => [k]): QueryPlan {
  const known = new Set<string>([...LISTING_FIELDS, ...keys.map((k) => k.key)]);
  const resolve = (k: string) => {
    if (!k || known.has(k)) return k;
    const names = synonyms(k);
    return names.find((n) => known.has(n)) ?? names[0] ?? k;
  };
  const fix = (k: string) => (isListingField(k) ? k : resolve(normalizeKey(k)));
  const filters = plan.filters
    .map((f) => normalizeList({ ...f, key: fix(f.key) }))
    .filter((f): f is Filter => !!f?.key);
  const sort = plan.sort ? { ...plan.sort, key: fix(plan.sort.key) } : null;
  const used = new Set([...filters.map((f) => f.key), ...(sort ? [sort.key] : [])]);
  const show = [...new Set((plan.show ?? []).map(fix))].filter((k) => k && !used.has(k));
  const missing = new Map<string, QueryPlan["missingAttributes"][number]>();
  for (const m of plan.missingAttributes) {
    const key = fix(m.key);
    if (key && !known.has(key)) missing.set(key, { ...m, key });
  }
  // Any referenced unknown key must be listed as missing so the UI/enrichment can see it.
  for (const k of [...used, ...show]) {
    if (!known.has(k) && !missing.has(k)) {
      const f = filters.find((x) => x.key === k);
      const sample = Array.isArray(f?.value) ? f.value[0] : f?.value;
      const type = typeof sample === "boolean" ? "boolean" : typeof sample === "string" && f?.op !== "contains" ? "string" : "number";
      missing.set(k, { key: k, type, unit: null, label: k.replace(/_/g, " ") });
    }
  }
  return { filters, sort, semanticText: plan.semanticText?.trim() || null, missingAttributes: [...missing.values()], show };
}
