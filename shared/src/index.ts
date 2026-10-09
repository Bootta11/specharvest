import { z } from "zod";

export type SpecValue = number | boolean | string;
export type SpecType = "number" | "boolean" | "string";
export type SpecOrigin = "page" | "web";

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

export const filterOps = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists"] as const;
export type FilterOp = (typeof filterOps)[number];

export const filterSchema = z.object({
  key: z.string().min(1),
  op: z.enum(filterOps),
  value: z.union([z.number(), z.boolean(), z.string(), z.null()]).optional(),
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
  filters: z.array(filterSchema).default([]),
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
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

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

export const crawlRequestSchema = z.object({
  url: z.string().url(),
  /** Re-crawl this existing collection (needs edit rights) instead of matching by URL. */
  collectionId: z.number().int().positive().optional(),
  /** Collection name; when omitted, it's derived from the listing page's title. */
  name: z.string().trim().max(200).optional(),
  maxPages: z.number().int().min(1).max(200).optional(),
  maxItems: z.number().int().min(1).max(5000).optional(),
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

const specValueSchema = z.union([z.number(), z.boolean(), z.string()]);
const specOriginSchema = z.enum(["page", "web"]);
const nullableString = z.string().nullable().default(null);
const nullableNumber = z.number().nullable().default(null);

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
    startUrl: z.string().min(1),
    host: z.string(),
    createdAt: z.number(),
    detection: z.record(z.string(), z.unknown()).nullable().default(null),
  }),
  specKeys: z
    .array(
      z.object({
        key: z.string().min(1),
        type: z.enum(["number", "boolean", "string"]),
        unit: nullableString,
        label: z.string(),
        example: nullableString,
        origin: specOriginSchema,
      }),
    )
    .max(5000),
  items: z
    .array(
      z.object({
        url: z.string().min(1),
        title: z.string(),
        price: nullableNumber,
        currency: nullableString,
        mainImage: nullableString,
        description: nullableString,
        identity: nullableString,
        specs: z.record(z.string(), specValueSchema),
        sources: z.record(z.string(), z.object({ origin: specOriginSchema, sourceUrl: nullableString, confidence: nullableNumber })).default({}),
        rawText: nullableString,
        contentText: nullableString,
        contentHash: nullableString,
        cardHash: nullableString,
        indexedAt: z.number(),
        lastSeenAt: nullableNumber,
        checkedAt: nullableNumber,
        goneAt: nullableNumber,
      }),
    )
    .max(20_000),
  aliases: z.array(z.object({ identity: z.string().min(1), canonical: z.string().min(1) })).default([]),
  webFacts: z
    .array(
      z.object({
        identity: z.string().min(1),
        key: z.string().min(1),
        value: specValueSchema.nullable(),
        unit: nullableString,
        sourceUrl: nullableString,
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
  byPurpose: Array<{ purpose: LlmPurpose; cost: number; calls: number }>;
  byModel: Array<{ model: string; cost: number; calls: number; promptTokens: number; completionTokens: number }>;
  /** Calls whose response carried no price (counted as $0 above). */
  unpricedCalls: number;
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

export const notificationSettingsSchema = z.object({
  events: z
    .object({
      crawlDone: z.boolean().default(true),
      crawlFailed: z.boolean().default(true),
      enrichDone: z.boolean().default(false),
    })
    .default({ crawlDone: true, crawlFailed: true, enrichDone: false }),
  ntfy: z
    .object({ enabled: z.boolean().default(false), server: z.string().trim().default("https://ntfy.sh"), topic: z.string().trim().default(""), token: z.string().trim().default("") })
    .default({ enabled: false, server: "https://ntfy.sh", topic: "", token: "" }),
  telegram: z
    .object({ enabled: z.boolean().default(false), botToken: z.string().trim().default(""), chatId: z.string().trim().default("") })
    .default({ enabled: false, botToken: "", chatId: "" }),
  /** Discord webhook; Slack incoming-webhook URLs work too. */
  discord: z.object({ enabled: z.boolean().default(false), webhookUrl: z.string().trim().default("") }).default({ enabled: false, webhookUrl: "" }),
  /** Generic JSON POST. */
  webhook: z.object({ enabled: z.boolean().default(false), url: z.string().trim().default("") }).default({ enabled: false, url: "" }),
  /** Apprise API (stateless /notify) — one URL per line/space for 130+ services. */
  apprise: z
    .object({ enabled: z.boolean().default(false), apiUrl: z.string().trim().default("http://apprise:8000"), urls: z.string().trim().default("") })
    .default({ enabled: false, apiUrl: "http://apprise:8000", urls: "" }),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const notificationChannels = ["ntfy", "telegram", "discord", "webhook", "apprise", "push"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];
