import { z } from "zod";

export type SpecValue = number | boolean | string;
export type SpecType = "number" | "boolean" | "string";
export type SpecOrigin = "page" | "web";

export type GroupingMode = "strict" | "loose";
export const groupingModes = ["strict", "loose"] as const satisfies readonly GroupingMode[];

export interface Collection {
  id: number;
  name: string;
  startUrl: string;
  host: string;
  createdAt: number;
  itemCount: number;
  /** Distinct products among the active items (name variants grouped as one). */
  productCount: number;
  /** USD spent on LLM calls for this collection (crawls, lookups, searches). */
  llmCost: number;
  ownerId: number | null;
  ownerEmail: string | null;
  /** Readable (search only) by every signed-in user. */
  isShared: boolean;
  /** How product names are grouped: strict = certain matches only; loose = also a possible match with a single candidate. */
  grouping: GroupingMode;
  /** The viewer owns it or is an admin: may crawl, rename, share or delete. */
  canEdit: boolean;
}

export interface SpecKey {
  key: string;
  type: SpecType;
  unit: string | null;
  label: string;
  example: string | null;
  count: number;
  origin: SpecOrigin;
}

export interface SpecSource {
  origin: SpecOrigin;
  sourceUrl: string | null;
  confidence: number | null;
}

export interface Item {
  id: number;
  collectionId: number;
  url: string;
  title: string;
  price: number | null;
  currency: string | null;
  mainImage: string | null;
  description: string | null;
  identity: string | null;
  specs: Record<string, SpecValue>;
  /** Only keys whose value did not come from the item's own page. */
  sources: Record<string, SpecSource>;
  indexedAt: number;
  /** Set when the listing was missing from a complete re-crawl (sold/removed). */
  goneAt: number | null;
  score?: number | null;
}

/** Other listings grouped as the same product (spelling variants share web lookups). */
export interface SameProduct {
  /** The name web facts are stored under. */
  canonical: string;
  /** Other listings of this product the viewer can see (not including the item itself). */
  listings: Array<Pick<Item, "id" | "collectionId" | "title" | "url" | "identity" | "price" | "currency" | "goneAt">>;
  /** How many more matched than are listed. */
  more: number;
}

/** One product in a collection and every listing of it (spelling variants included). */
export interface ProductGroup {
  /** The name the product is grouped (and looked up) under. */
  canonical: string;
  listings: SameProduct["listings"];
}

/** A product that might be the same as one (or one of several) others — waiting for the user. */
export interface MatchSuggestion {
  /** The less specific name, e.g. "geely starray em-i 2026". */
  identity: string;
  listings: number;
  title: string;
  /** Products it might be (pick one, or none). */
  candidates: Array<{ canonical: string; listings: number; title: string }>;
}

export interface CollectionProducts {
  products: ProductGroup[];
  /** Possible matches to confirm (only for users who can edit the collection). */
  suggestions: MatchSuggestion[];
  listings: number;
  /** False when some names were never grouped (only the collection's owner triggers grouping). */
  grouped: boolean;
}

export interface ItemDetail extends Item {
  rawText: string | null;
  sameProduct: SameProduct | null;
}

// ---------- Query plan ----------

/**
 * Item fields that aren't specs but are filtered (and sorted) like spec keys: `product` is the normalized
 * brand/model/variant/year (`identity`), `collection` the collection id. A spec key of the same name is shadowed.
 */
export const LISTING_FIELDS = ["price", "title", "description", "product", "currency", "collection"] as const;
export type ListingField = (typeof LISTING_FIELDS)[number];
export const isListingField = (key: string): key is ListingField => (LISTING_FIELDS as readonly string[]).includes(key);
/**
 * Listing fields where a listing without the value never matches: nothing fills them in later (web lookups only add
 * specs). Price instead keeps such listings ("price on request") under "can't be judged yet".
 */
export const isStrictField = (key: string) => isListingField(key) && key !== "price";

/** `in` takes a list: any of the values matches (several ticked values of one field). */
export const filterOps = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists", "in"] as const;
export type FilterOp = (typeof filterOps)[number];

export const filterSchema = z.object({
  key: z.string().min(1),
  op: z.enum(filterOps),
  value: z.union([z.number(), z.boolean(), z.string(), z.null(), z.array(z.union([z.string(), z.number()])).min(1).max(500)]).optional(),
});
export type Filter = z.infer<typeof filterSchema>;

export const missingAttributeSchema = z.object({
  key: z.string().min(1),
  type: z.enum(["number", "boolean", "string"]),
  unit: z.string().nullable().optional(),
  label: z.string().min(1),
});
export type MissingAttribute = z.infer<typeof missingAttributeSchema>;

export const queryPlanSchema = z.object({
  filters: z.array(filterSchema).max(100).default([]),
  sort: z
    .object({ key: z.string().min(1), dir: z.enum(["asc", "desc"]) })
    .nullable()
    .optional(),
  semanticText: z.string().nullable().optional(),
  missingAttributes: z.array(missingAttributeSchema).default([]),
  /** Keys the user wants to see/compare without a condition ("compare boot space"). */
  show: z.array(z.string().min(1)).default([]),
});
export type QueryPlan = z.infer<typeof queryPlanSchema>;

/** A saved, private set of collections searched together. */
export interface CollectionGroup {
  id: number;
  name: string;
  /** Members the viewer can still read (unshared or deleted collections drop out). */
  collectionIds: number[];
  itemCount: number;
  createdAt: number;
}

export const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  collectionIds: z.array(z.number().int().positive()).min(1).max(200),
});
export type GroupInput = z.infer<typeof groupInputSchema>;

export const searchRequestSchema = z.object({
  collectionId: z.number().int().positive().nullable().optional(),
  /** Search a saved group instead of one collection (not both). */
  groupId: z.number().int().positive().nullable().optional(),
  query: z.string().max(1000).optional(),
  plan: queryPlanSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  /** Set false to skip triggering web enrichment for this search. */
  enrich: z.boolean().optional(),
  /** Include listings marked gone (sold/removed). */
  includeGone: z.boolean().optional(),
  /** Extra conditions (e.g. from the filter panel), ANDed with the parsed `query` or the given `plan`; a plan condition on the same key wins. */
  filters: z.array(filterSchema).max(100).optional(),
  /** Also return `facets` (value counts per field) for a filter panel. */
  facets: z.boolean().optional(),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/**
 * The values of one field among the items that pass every *other* active filter, so a field's own options stay
 * visible while it is filtered. `count` = how many of those items have a value for it.
 */
export type Facet = {
  key: string;
  count: number;
  /** Items counted for this field that have no (usable) value. */
  missing: number;
} & (
  | { kind: "range"; min: number | null; max: number | null; unit: string | null }
  /** Most common first; `more` = distinct values left out past the cap (reachable with `contains`). */
  | { kind: "values"; values: Array<{ value: string | number; count: number }>; more: number }
  | { kind: "boolean"; yes: number; no: number }
  /** Free text (title, description, product): searched with `contains`. */
  | { kind: "text" }
);

export interface SearchResponse {
  plan: QueryPlan;
  items: Item[];
  /** Candidates that could not be judged because a filtered/sorted key is missing on them. */
  unknown: Item[];
  total: number;
  /** Keys the registry knows for the searched scope (for chip labels). */
  keys: SpecKey[];
  enrichJobId: number | null;
  /** Why enrichment was (or wasn't) started, for the UI. */
  enrichNote: string | null;
  /** USD spent parsing this query (0 when the plan came from cache). */
  llmCost: number;
  /** Listing fields first, then every spec key present in the scope — only when the request asked for `facets`. */
  facets?: Facet[];
  /** Web lookups this search would have started but didn't (it sent `enrich: false`): search again with `enrich: true` to start them. */
  enrichOffer: { attributes: MissingAttribute[]; products: number; listings: number } | null;
}

// ---------- Jobs ----------

export type JobKind = "crawl" | "enrich";
/** stopped — by the user; interrupted — by a server restart. Both can be resumed (crawls only). */
export type JobStatus = "queued" | "running" | "done" | "failed" | "stopped" | "interrupted";

export interface Job {
  id: number;
  collectionId: number | null;
  /** Who started it — only they (and admins) see it. */
  userId: number | null;
  kind: JobKind;
  status: JobStatus;
  pagesSeen: number;
  itemsFound: number;
  itemsIndexed: number;
  itemsFailed: number;
  webSearches: number;
  /** USD spent on LLM calls by this job so far. */
  llmCost: number;
  /** Web lookups: products left out because of ENRICH_MAX_LOOKUPS (run again to continue). */
  itemsRemaining: number;
  /** Web lookups: how listings became products and where values came from (null for crawls / older jobs). */
  lookup: LookupStats | null;
  message: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** A stopped/interrupted crawl whose start options were saved, so it can pick up where it left off. */
  resumable: boolean;
}

/** Breakdown of one web lookup job. */
export interface LookupStats {
  /** Attribute labels being looked up. */
  attributes: string[];
  /** Listings missing at least one of them. */
  listings: number;
  /** Distinct products those listings are, after grouping name variants. */
  products: number;
  /** Name variants merged into another product by this run's grouping. */
  merged: number;
  /** The merges themselves (first 100). */
  merges: Array<{ from: string; to: string }>;
  /** Products fully answered without the web (cache or sibling listings). */
  cached: number;
  /** Values copied from another listing of the same product that states them on its own page. */
  fromSiblings: number;
  /** Products sent to the web this run (at most ENRICH_MAX_LOOKUPS). */
  toLookUp: number;
  /** Products left for the next run. */
  remaining: number;
  /** Extra values found and cached by the same lookups (predicted attributes nobody asked for yet). Older jobs lack it. */
  prefetched?: number;
}

/** Still queued or running (anything else is a final or paused state). */
export const isActiveJob = (job: Pick<Job, "status">) => job.status === "queued" || job.status === "running";

/** SSE events on /api/jobs/:id/events (and /api/jobs/events: `jobs` snapshot of active jobs on connect, then `job`) */
export type JobEvent =
  | { type: "job"; job: Job }
  | { type: "jobs"; jobs: Job[] }
  | { type: "log"; message: string; level: "info" | "warn" | "error" }
  | { type: "item"; title: string; url: string }
  | { type: "queue"; size: number; pending: number };

export const crawlModes = ["quick", "deep", "full"] as const;
export type CrawlMode = (typeof crawlModes)[number];

/** Hard ceilings of one crawl (admins); other users are capped lower by MAX_PAGES_CAP / MAX_ITEMS_CAP. */
export const CRAWL_MAX_PAGES = 200;
export const CRAWL_MAX_ITEMS = 5000;

/** An absolute http(s) URL — what links, images and sources may be (never javascript:, data:, file:, …). */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

export const crawlRequestSchema = z.object({
  url: httpUrlSchema,
  /** Re-crawl this existing collection (needs edit rights) instead of matching by URL. */
  collectionId: z.number().int().positive().optional(),
  /** Collection name; when omitted, it's derived from the listing page's title. */
  name: z.string().trim().max(200).optional(),
  maxPages: z.number().int().min(1).max(CRAWL_MAX_PAGES).optional(),
  maxItems: z.number().int().min(1).max(CRAWL_MAX_ITEMS).optional(),
  /** Route page loads through PROXY_SERVER. */
  useProxy: z.boolean().optional(),
  /**
   * How already-indexed items are re-checked:
   * quick — compare listing-card text, open the detail page only when it changed (default);
   * deep  — open every detail page and compare a text fingerprint;
   * full  — re-extract everything with the LLM.
   * The LLM only runs for new items and items whose page text changed (except in full).
   */
  mode: z.enum(crawlModes).optional(),
  /** Legacy alias for mode "full". */
  refresh: z.boolean().optional(),
});
export type CrawlRequest = z.infer<typeof crawlRequestSchema>;

export const enrichRequestSchema = z.object({
  collectionId: z.number().int().positive().nullable().optional(),
  groupId: z.number().int().positive().nullable().optional(),
  attributes: z.array(missingAttributeSchema).min(1).max(5),
  itemIds: z.array(z.number().int().positive()).max(500).optional(),
});
export type EnrichRequest = z.infer<typeof enrichRequestSchema>;

// ---------- Collection export / import ----------

export const COLLECTION_EXPORT_FORMAT = "specharvest.collection";

// Size limits are far above anything a crawl produces; they only keep a hand-made file from bloating the DB.
const specKeyName = z.string().min(1).max(100);
const specValueSchema = z.union([z.number(), z.boolean(), z.string().max(5000)]);
const specOriginSchema = z.enum(["page", "web"]);
const nullableString = (max: number) => z.string().max(max).nullable().default(null);
const nullableNumber = z.number().nullable().default(null);
/** Links and images: anything that isn't an absolute http(s) URL becomes null (older files may hold relative ones). */
const nullableHttpUrl = z
  .string()
  .nullable()
  .default(null)
  .transform((v) => (isHttpUrl(v) && v.length <= 2048 ? v : null));

/** Listing structure as saved by a crawl (selectors run in the page; the URL pattern is re-checked server-side). */
export const listingDetectionSchema = z.object({
  listItemSelector: z.string().max(500),
  paginationType: z.enum(["pages", "loadMore", "infiniteScroll", "urlPage"]),
  nextSelector: z.string().max(500).nullable().optional(),
  loadMoreSelector: z.string().max(500).nullable().optional(),
  pageParam: z
    .string()
    .regex(/^[\w.-]{1,40}$/)
    .nullable()
    .optional(),
  itemUrlPattern: z.string().max(1000).nullable().optional(),
});

/**
 * One collection as a portable file: items with their specs and spec sources (web lookups
 * included), the spec key registry, and the product-grouping / lookup cache rows for its
 * products. No ids, owners, jobs or LLM spend — import always creates a new collection.
 */
export const collectionExportSchema = z.object({
  format: z.literal(COLLECTION_EXPORT_FORMAT),
  version: z.literal(1),
  exportedAt: z.number(),
  collection: z.object({
    name: z.string().trim().min(1).max(200),
    startUrl: httpUrlSchema,
    host: z.string().max(300),
    createdAt: z.number(),
    // Absent in files from before grouping modes existed.
    grouping: z.enum(groupingModes).default("strict"),
    // A detection that doesn't fit is dropped (the next crawl detects again) rather than failing the import.
    detection: listingDetectionSchema.nullable().default(null).catch(null),
  }),
  specKeys: z
    .array(
      z.object({
        key: specKeyName,
        type: z.enum(["number", "boolean", "string"]),
        unit: nullableString(40),
        label: z.string().max(300),
        example: nullableString(500),
        origin: specOriginSchema,
      }),
    )
    .max(5000),
  items: z
    .array(
      z.object({
        url: httpUrlSchema,
        title: z.string().max(2000),
        price: nullableNumber,
        currency: nullableString(20),
        mainImage: nullableHttpUrl,
        description: nullableString(20_000),
        identity: nullableString(500),
        specs: z.record(specKeyName, specValueSchema).refine((s) => Object.keys(s).length <= 500, "At most 500 specs per item"),
        sources: z.record(specKeyName, z.object({ origin: specOriginSchema, sourceUrl: nullableHttpUrl, confidence: nullableNumber })).default({}),
        rawText: nullableString(100_000),
        contentText: nullableString(500_000),
        contentHash: nullableString(200),
        cardHash: nullableString(200),
        indexedAt: z.number(),
        lastSeenAt: nullableNumber,
        checkedAt: nullableNumber,
        goneAt: nullableNumber,
      }),
    )
    .max(20_000),
  aliases: z.array(z.object({ identity: z.string().min(1).max(500), canonical: z.string().min(1).max(500) })).default([]),
  webFacts: z
    .array(
      z.object({
        identity: z.string().min(1).max(500),
        key: specKeyName,
        value: specValueSchema.nullable(),
        unit: nullableString(40),
        sourceUrl: nullableHttpUrl,
        confidence: nullableNumber,
        found: z.boolean(),
        fetchedAt: z.number(),
      }),
    )
    .default([]),
});
export type CollectionExport = z.infer<typeof collectionExportSchema>;

export const COLLECTIONS_EXPORT_FORMAT = "specharvest.collections";

/** Several collections in one file ("Export all"): each entry is a single-collection export. */
export const collectionsExportSchema = z.object({
  format: z.literal(COLLECTIONS_EXPORT_FORMAT),
  version: z.literal(1),
  exportedAt: z.number(),
  collections: z.array(collectionExportSchema).max(1000),
});
export type CollectionsExport = z.infer<typeof collectionsExportSchema>;

/** What import accepts: one collection or an "Export all" bundle. */
export const importRequestSchema = z.discriminatedUnion("format", [collectionExportSchema, collectionsExportSchema]);

/** A previously parsed search, served from the plan cache. */
export interface RecentSearch {
  query: string;
  usedAt: number;
  hits: number;
}

const UNIT_DISPLAY: Record<string, string> = { kw: "kW", hp: "hp", ps: "hp", cc: "cc", ccm: "cc", l: "L", liters: "L", litres: "L", kg: "kg", mm: "mm", cm: "cm", km: "km", inch: "″", s: "s", gb: "GB", tb: "TB", mah: "mAh", w: "W" };

/** Normalized display unit ("KW" → "kW", "ccm" → "cc", "liters" → "L"). */
export function displayUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  return UNIT_DISPLAY[unit.toLowerCase()] ?? unit;
}

const UNIT_SUFFIXES = new Set(["kw", "hp", "ps", "cc", "ccm", "l", "liters", "litres", "kg", "mm", "cm", "km", "inch", "s", "gb", "tb", "mah", "w"]);

/** Human label for a key, without the unit suffix (the value shows the unit). */
export function specLabel(key: string): string {
  const parts = key.split("_");
  if (parts.length > 1 && UNIT_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return humanizeKey(parts.join("_"));
}

export function formatSpecValue(value: SpecValue | null | undefined, unit?: string | null): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    const n = Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
    const u = displayUnit(unit);
    return u ? (u === "″" ? `${n}″` : `${n} ${u}`) : n;
  }
  return value;
}

/** Short host for a source link ("https://www.auto-data.net/x" → "auto-data.net"). */
export function sourceHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function humanizeKey(key: string): string {
  const s = key.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Users ----------

export type UserRole = "admin" | "user";

export interface UserSummary {
  id: number;
  email: string;
  role: UserRole;
  disabledAt: number | null;
  createdAt: number;
}

/** Returned once when an admin creates a user. */
export interface UserCreated extends UserSummary {
  temporaryPassword: string;
}

export interface ApiKeySummary {
  id: number;
  label: string;
  /** First characters of the key, to tell keys apart. */
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Returned once when a key is created — the full key is never shown again. */
export interface ApiKeyCreated extends ApiKeySummary {
  key: string;
}

/** Public (pre-login) info for the login screen. */
export interface AuthStatus {
  signupEnabled: boolean;
}

export interface AdminSettings {
  signupEnabled: boolean;
  /** Who may use the server's LLM key when they have no key of their own. */
  serverLlmAccess: ServerLlmAccess;
  /** USD each non-admin may spend on the server's key per day; 0 = no limit. */
  serverLlmDailyLimitUsd: number;
  /** Read-only: OPENROUTER_API_KEY is set. */
  serverLlmConfigured: boolean;
}

export const loginSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()), password: z.string().min(1).max(200) });
export const signupSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()), password: z.string().min(8).max(200) });
export const updateAccountSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  newPassword: z.string().min(8).max(200).optional(),
});
export const createUserSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()), role: z.enum(["admin", "user"]).default("user") });

// ---------- LLM spend ----------

export type LlmPurpose = "detect" | "extract" | "consolidate" | "search" | "web-lookup" | "group" | "predict";

export interface UsageSummary {
  today: number;
  last30d: number;
  allTime: number;
  /** All-time spend by who paid: the user's own keys or the server's key. */
  byFunding: Record<LlmFunding, number>;
  /** Part of allTime estimated from a price list (providers that don't report a price). */
  estimated: number;
  byPurpose: Array<{ purpose: LlmPurpose; cost: number; calls: number }>;
  byModel: Array<{ provider: string; model: string; cost: number; calls: number; promptTokens: number; completionTokens: number }>;
  /** Calls with no known price (counted as $0 above). */
  unpricedCalls: number;
}

// ---------- LLM providers (per-user keys, see docs/llm-providers.md) ----------

/** Every LLM purpose maps to a tier; each tier gets its own model. */
export const llmTiers = ["fast", "smart", "web"] as const;
export type LlmTier = (typeof llmTiers)[number];

/** Who pays for a call: the user's own key, or the server's key (later: the user's credits). */
export type LlmFunding = "own" | "platform";

export const serverLlmAccessModes = ["everyone", "admins", "nobody"] as const;
export type ServerLlmAccess = (typeof serverLlmAccessModes)[number];

/** A provider users can add a key for (the server's catalog, as sent to the UI). */
export interface LlmProviderInfo {
  id: string;
  label: string;
  group: "popular" | "more" | "custom";
  /** Where to create a key. */
  keyUrl: string | null;
  /** Tiers it can serve (Perplexity searches on every call, so web only). */
  tiers: LlmTier[];
  /** Can run web lookups (provider-native web search). */
  webSearch: boolean;
  /** Default model per tier; missing = the user picks one. */
  defaults: Partial<Record<LlmTier, string>>;
  /** Custom OpenAI-compatible URL — admins only. */
  custom: boolean;
  /** Reports the exact price of each call (else it's estimated from a price list). */
  exactCost: boolean;
}

/** A stored key — the key itself never leaves the server. */
export interface LlmKeySummary {
  provider: string;
  /** Last 4 characters. */
  keyHint: string;
  baseUrl: string | null;
  createdAt: number;
  verifiedAt: number | null;
  /** Last failure (rejected key, out of credit, can't be decrypted). */
  lastError: string | null;
}

export const llmModelRefSchema = z.object({ provider: z.string().min(1).max(40), model: z.string().trim().min(1).max(200) });
export type LlmModelRef = z.infer<typeof llmModelRefSchema>;

/** The user's pick per tier; null = automatic. */
export const llmModelChoicesSchema = z.object({
  fast: llmModelRefSchema.nullable().default(null),
  smart: llmModelRefSchema.nullable().default(null),
  web: llmModelRefSchema.nullable().default(null),
});
export type LlmModelChoices = z.infer<typeof llmModelChoicesSchema>;

/** apiKey may be blank only for a custom endpoint that needs none (e.g. a local Ollama). */
export const saveLlmKeySchema = z.object({
  apiKey: z.string().trim().max(500),
  baseUrl: z.string().trim().max(300).optional(),
});

/** Which model a tier actually uses right now, and who pays. */
export interface LlmEffective {
  funding: LlmFunding;
  provider: string;
  model: string;
}

export interface LlmStatus {
  effective: Record<LlmTier, LlmEffective | null>;
  /** Why a tier can't run (no key, no web-capable provider, server key not allowed). */
  unavailable: Partial<Record<LlmTier, string>>;
}

export interface LlmSettingsResponse extends LlmStatus {
  keys: LlmKeySummary[];
  models: LlmModelChoices;
  server: {
    configured: boolean;
    allowed: boolean;
    access: ServerLlmAccess;
    /** USD this user may spend on the server key today (0 = no limit, e.g. admins). */
    dailyLimitUsd: number;
    /** USD this user spent on the server key today. */
    spentTodayUsd: number;
  };
  providers: LlmProviderInfo[];
}

/** A model suggestion; prices in USD per 1M tokens (null = unknown). */
export interface LlmModelOption {
  id: string;
  name: string;
  input: number | null;
  output: number | null;
}

/** A provider's models for the pickers: live from the provider (with your key), or models.dev as fallback. */
export interface LlmModelList {
  source: "live" | "models.dev";
  models: LlmModelOption[];
}

export interface LlmTestResult {
  ok: boolean;
  provider?: string;
  model?: string;
  ms?: number;
  error?: string;
}

/** Remaining balance at the LLM provider (admin-only). */
export interface ProviderCredits {
  provider: "openrouter";
  /** The server's API key: `limit` null = uncapped. */
  key: { label: string | null; limit: number | null; remaining: number | null; usage: number; usageDaily: number; usageMonthly: number; freeTier: boolean } | null;
  /** Whole account; needs OPENROUTER_MANAGEMENT_KEY. */
  account: { totalCredits: number; totalUsage: number; remaining: number } | null;
  /** Why a part is missing (no key, 403, network). */
  errors: string[];
  fetchedAt: string;
}

// ---------- Notifications ----------

/** Stands in for stored secrets in GET responses; sending it back keeps the stored value. */
export const SECRET_MASK = "********";

const settingText = (def: string, max = 2000) => z.string().trim().max(max).default(def);

export const notificationSettingsSchema = z.object({
  events: z
    .object({
      crawlDone: z.boolean().default(true),
      crawlFailed: z.boolean().default(true),
      enrichDone: z.boolean().default(false),
    })
    .default({ crawlDone: true, crawlFailed: true, enrichDone: false }),
  ntfy: z
    .object({ enabled: z.boolean().default(false), server: settingText("https://ntfy.sh"), topic: settingText("", 200), token: settingText("", 500) })
    .default({ enabled: false, server: "https://ntfy.sh", topic: "", token: "" }),
  telegram: z
    .object({ enabled: z.boolean().default(false), botToken: settingText("", 500), chatId: settingText("", 100) })
    .default({ enabled: false, botToken: "", chatId: "" }),
  /** Discord webhook; Slack incoming-webhook URLs work too. */
  discord: z.object({ enabled: z.boolean().default(false), webhookUrl: settingText("") }).default({ enabled: false, webhookUrl: "" }),
  /** Generic JSON POST. */
  webhook: z.object({ enabled: z.boolean().default(false), url: settingText("") }).default({ enabled: false, url: "" }),
  /** Apprise API (stateless /notify) — one URL per line/space for 130+ services. */
  apprise: z
    .object({ enabled: z.boolean().default(false), apiUrl: settingText("http://apprise:8000"), urls: settingText("", 10_000) })
    .default({ enabled: false, apiUrl: "http://apprise:8000", urls: "" }),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const notificationChannels = ["ntfy", "telegram", "discord", "webhook", "apprise", "push"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];
