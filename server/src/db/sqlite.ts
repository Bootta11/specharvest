import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Collection, Item, Job, JobKind, LlmPurpose, SpecKey, SpecOrigin, SpecSource, SpecType, SpecValue, UsageSummary } from "@specharvest/shared";
import { env } from "../config.ts";

let db: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_url TEXT NOT NULL,
  host TEXT NOT NULL,
  detection TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  price REAL,
  currency TEXT,
  main_image TEXT,
  description TEXT,
  identity TEXT,
  specs TEXT NOT NULL DEFAULT '{}',
  raw_text TEXT,
  indexed_at INTEGER NOT NULL,
  UNIQUE (collection_id, url)
);
CREATE INDEX IF NOT EXISTS items_identity ON items(identity);
CREATE TABLE IF NOT EXISTS spec_keys (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  type TEXT NOT NULL,
  unit TEXT,
  label TEXT NOT NULL,
  example TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'page',
  PRIMARY KEY (collection_id, key)
);
CREATE TABLE IF NOT EXISTS spec_sources (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  origin TEXT NOT NULL,
  source_url TEXT,
  confidence REAL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, key)
);
CREATE TABLE IF NOT EXISTS web_facts (
  identity TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  unit TEXT,
  source_url TEXT,
  confidence REAL,
  found INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (identity, key)
);
-- Raw product identity → canonical one, so spelling variants of the same product share web_facts (enrich/group.ts).
CREATE TABLE IF NOT EXISTS identity_aliases (
  identity TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS identity_aliases_canonical ON identity_aliases(canonical);
CREATE TABLE IF NOT EXISTS query_cache (
  collection_id INTEGER NOT NULL DEFAULT 0,
  query TEXT NOT NULL,
  registry_sig TEXT NOT NULL,
  plan TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, query)
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  pages_seen INTEGER NOT NULL DEFAULT 0,
  items_found INTEGER NOT NULL DEFAULT 0,
  items_indexed INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
-- One row per OpenRouter completion. No FKs: spend history outlives deleted collections/jobs.
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  web_searches INTEGER NOT NULL DEFAULT 0,
  job_id INTEGER,
  collection_id INTEGER
);
CREATE INDEX IF NOT EXISTS llm_usage_created ON llm_usage(created_at);
CREATE INDEX IF NOT EXISTS llm_usage_collection ON llm_usage(collection_id);

-- App settings set from the UI (JSON values), e.g. notification channels and generated VAPID keys.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Web Push subscriptions, one per browser that opted in.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  keys TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

-- ---------- Users & auth (see docs/auth.md) ----------
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  disabled_at INTEGER,
  created_at INTEGER NOT NULL
);
-- Only sha256 of the token is stored; a DB leak can't be replayed as a cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id);
-- Per-user "Recent" searches (query_cache stays a shared LLM plan cache). collection_id 0 = all collections.
CREATE TABLE IF NOT EXISTS search_history (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL DEFAULT 0,
  query TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, collection_id, query)
);
`;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  db = new DatabaseSync(path.join(env.DATA_DIR, "specharvest.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Columns added after the first release (CREATE TABLE IF NOT EXISTS doesn't add them).
  addColumnIfMissing("items", "card_hash", "TEXT");
  addColumnIfMissing("items", "content_hash", "TEXT");
  addColumnIfMissing("items", "content_text", "TEXT");
  addColumnIfMissing("items", "last_seen_at", "INTEGER");
  addColumnIfMissing("items", "checked_at", "INTEGER");
  addColumnIfMissing("items", "gone_at", "INTEGER");
  addColumnIfMissing("jobs", "llm_cost", "REAL NOT NULL DEFAULT 0");
  addColumnIfMissing("jobs", "params", "TEXT");
  addColumnIfMissing("jobs", "items_remaining", "INTEGER NOT NULL DEFAULT 0");
  // Ownership (users). NULL = created before users existed; handed to the first admin by assignOrphansTo().
  addColumnIfMissing("collections", "user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL");
  addColumnIfMissing("collections", "is_shared", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("jobs", "user_id", "INTEGER");
  addColumnIfMissing("llm_usage", "user_id", "INTEGER");
  addColumnIfMissing("push_subscriptions", "user_id", "INTEGER");
  db.exec(
    "CREATE INDEX IF NOT EXISTS collections_user ON collections(user_id); CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id); CREATE INDEX IF NOT EXISTS llm_usage_user ON llm_usage(user_id);",
  );
  // Jobs cut off by a restart: crawls with saved options can be resumed, everything else can never finish.
  const now = Date.now();
  db.prepare(
    "UPDATE jobs SET status = 'interrupted', error = 'Interrupted by server restart', finished_at = ? WHERE status IN ('queued','running') AND kind = 'crawl' AND params IS NOT NULL",
  ).run(now);
  db.prepare("UPDATE jobs SET status = 'failed', error = 'Interrupted by server restart', finished_at = ? WHERE status IN ('queued','running')").run(now);
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY id LIMIT 1").get() as Row | undefined;
  if (admin) assignOrphansTo(Number(admin.id));
  return db;
}

/**
 * Gives rows from before users existed (user_id NULL) to `userId` — normally
 * the first admin. Also seeds their Recent searches from the plan cache once.
 * Returns how many collections were assigned.
 */
export function assignOrphansTo(userId: number): number {
  const d = getDb();
  const collections = Number(d.prepare("UPDATE collections SET user_id = ? WHERE user_id IS NULL").run(userId).changes);
  // Jobs follow their collection's owner; collection-less (all-collections) jobs go to the admin.
  d.prepare("UPDATE jobs SET user_id = COALESCE((SELECT c.user_id FROM collections c WHERE c.id = jobs.collection_id), ?) WHERE user_id IS NULL").run(userId);
  d.prepare("UPDATE llm_usage SET user_id = ? WHERE user_id IS NULL").run(userId);
  d.prepare("UPDATE push_subscriptions SET user_id = ? WHERE user_id IS NULL").run(userId);
  if (!d.prepare("SELECT 1 FROM search_history LIMIT 1").get()) {
    d.prepare("INSERT OR IGNORE INTO search_history (user_id, collection_id, query, used_at, hits) SELECT ?, collection_id, query, used_at, hits FROM query_cache").run(userId);
  }
  // Notification channels from before users existed (key "notifications") become this user's.
  d.prepare("INSERT OR IGNORE INTO settings (key, value) SELECT ?, value FROM settings WHERE key = 'notifications'").run(`notifications:${userId}`);
  d.prepare("DELETE FROM settings WHERE key = 'notifications'").run();
  return collections;
}

// ---------- Viewer & scope ----------

/** Who is asking — enough to decide what they may read or change. */
export interface Viewer {
  id: number;
  role: "admin" | "user";
}

/**
 * Which collections a query covers: one id, the set a user may read, or null
 * for every collection (admins). An empty set matches nothing.
 */
export type CollectionScope = number | readonly number[] | null;

/** SQL condition + params restricting `column` to a scope; null = no restriction. */
export function scopeCondition(scope: CollectionScope, column = "collection_id"): { sql: string; params: number[] } | null {
  if (scope === null) return null;
  if (typeof scope === "number") return { sql: `${column} = ?`, params: [scope] };
  if (scope.length === 0) return { sql: "0", params: [] };
  return { sql: `${column} IN (${scope.map(() => "?").join(",")})`, params: [...scope] };
}

/** Collections `viewer` may read: own + shared, or null (= all) for admins. */
export function readableScope(viewer: Viewer): CollectionScope {
  if (viewer.role === "admin") return null;
  return (getDb().prepare("SELECT id FROM collections WHERE user_id = ? OR is_shared = 1").all(viewer.id) as Row[]).map((r) => Number(r.id));
}

type Row = Record<string, SQLInputValue>;

function addColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = (db!.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name));
  if (!cols.includes(column)) db!.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

const parseJson = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string" || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ---------- Collections ----------

export interface CollectionDetection {
  listItemSelector: string;
  paginationType: "pages" | "loadMore" | "infiniteScroll" | "urlPage";
  nextSelector?: string | null;
  loadMoreSelector?: string | null;
  pageParam?: string | null;
  itemUrlPattern?: string | null;
}

function toCollection(r: Row, viewer?: Viewer): Collection {
  const ownerId = r.user_id == null ? null : Number(r.user_id);
  return {
    id: Number(r.id),
    name: String(r.name),
    startUrl: String(r.start_url),
    host: String(r.host),
    createdAt: Number(r.created_at),
    itemCount: Number(r.item_count ?? 0),
    llmCost: Number(r.llm_cost ?? 0),
    ownerId,
    ownerEmail: r.owner_email == null ? null : String(r.owner_email),
    isShared: Number(r.is_shared ?? 0) === 1,
    canEdit: !!viewer && (viewer.role === "admin" || ownerId === viewer.id),
  };
}

const COLLECTION_SELECT = `SELECT c.*, u.email AS owner_email, (SELECT COUNT(*) FROM items i WHERE i.collection_id = c.id) AS item_count,
  (SELECT COALESCE(SUM(l.cost), 0) FROM llm_usage l WHERE l.collection_id = c.id) AS llm_cost
  FROM collections c LEFT JOIN users u ON u.id = c.user_id`;


/** What `viewer` can see: own + shared collections (admins: all). Without a viewer, everything. */
export function listCollections(viewer?: Viewer): Collection[] {
  const restrict = viewer && viewer.role !== "admin";
  const rows = getDb()
    .prepare(`${COLLECTION_SELECT} ${restrict ? "WHERE c.user_id = ? OR c.is_shared = 1" : ""} ORDER BY c.created_at DESC`)
    .all(...(restrict ? [viewer.id] : [])) as Row[];
  return rows.map((r) => toCollection(r, viewer));
}

export function getCollection(id: number, viewer?: Viewer): (Collection & { detection: CollectionDetection | null }) | null {
  const r = getDb().prepare(`${COLLECTION_SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
  if (!r) return null;
  return { ...toCollection(r, viewer), detection: parseJson<CollectionDetection | null>(r.detection, null) };
}

/** The user's own collection for a start URL — re-crawling someone else's (shared) URL makes a new one. */
export function findCollectionByUrl(startUrl: string, userId: number | null) {
  const r = getDb().prepare("SELECT id FROM collections WHERE start_url = ? AND user_id IS ?").get(startUrl, userId) as Row | undefined;
  return r ? getCollection(Number(r.id)) : null;
}

export function createCollection(name: string, startUrl: string, host: string, userId: number | null = null): number {
  const res = getDb()
    .prepare("INSERT INTO collections (name, start_url, host, created_at, user_id) VALUES (?, ?, ?, ?, ?)")
    .run(name, startUrl, host, Date.now(), userId);
  return Number(res.lastInsertRowid);
}

export function setCollectionShared(id: number, shared: boolean) {
  getDb().prepare("UPDATE collections SET is_shared = ? WHERE id = ?").run(shared ? 1 : 0, id);
}

export function saveDetection(id: number, detection: CollectionDetection | null) {
  getDb().prepare("UPDATE collections SET detection = ? WHERE id = ?").run(detection ? JSON.stringify(detection) : null, id);
}

export function renameCollection(id: number, name: string) {
  getDb().prepare("UPDATE collections SET name = ? WHERE id = ?").run(name, id);
}

export function deleteCollection(id: number): number[] {
  const ids = (getDb().prepare("SELECT id FROM items WHERE collection_id = ?").all(id) as Row[]).map((r) => Number(r.id));
  getDb().prepare("DELETE FROM collections WHERE id = ?").run(id);
  getDb().prepare("DELETE FROM query_cache WHERE collection_id = ?").run(id);
  getDb().prepare("DELETE FROM search_history WHERE collection_id = ?").run(id);
  return ids;
}

// ---------- Items ----------

export interface ItemInput {
  collectionId: number;
  url: string;
  title: string;
  price: number | null;
  currency: string | null;
  mainImage: string | null;
  description: string | null;
  identity: string | null;
  specs: Record<string, SpecValue>;
  rawText: string | null;
  cardHash?: string | null;
  contentHash?: string | null;
  /** Detail text without other listings — what contentHash was computed from (for change diffs). */
  contentText?: string | null;
}

export function upsertItem(input: ItemInput): number {
  const d = getDb();
  const existing = d.prepare("SELECT id, specs FROM items WHERE collection_id = ? AND url = ?").get(input.collectionId, input.url) as Row | undefined;
  const now = Date.now();
  if (existing) {
    const id = Number(existing.id);
    // Keep web-sourced values the page still doesn't state.
    const webKeys = (d.prepare("SELECT key FROM spec_sources WHERE item_id = ? AND origin = 'web'").all(id) as Row[]).map((r) => String(r.key));
    const old = parseJson<Record<string, SpecValue>>(existing.specs, {});
    const specs = { ...input.specs };
    for (const k of webKeys) {
      if (specs[k] === undefined && old[k] !== undefined) specs[k] = old[k];
      else if (specs[k] !== undefined) d.prepare("DELETE FROM spec_sources WHERE item_id = ? AND key = ?").run(id, k);
    }
    d.prepare(
      `UPDATE items SET title=?, price=?, currency=?, main_image=?, description=?, identity=?, specs=?, raw_text=?, indexed_at=?,
         card_hash=COALESCE(?, card_hash), content_hash=COALESCE(?, content_hash), content_text=COALESCE(?, content_text), last_seen_at=?, checked_at=?, gone_at=NULL WHERE id=?`,
    ).run(input.title, input.price, input.currency, input.mainImage, input.description, input.identity, JSON.stringify(specs), input.rawText, now, input.cardHash ?? null, input.contentHash ?? null, input.contentText ?? null, now, now, id);
    return id;
  }
  const res = d
    .prepare(
      `INSERT INTO items (collection_id, url, title, price, currency, main_image, description, identity, specs, raw_text, indexed_at, card_hash, content_hash, content_text, last_seen_at, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.collectionId, input.url, input.title, input.price, input.currency, input.mainImage, input.description, input.identity, JSON.stringify(input.specs), input.rawText, now, input.cardHash ?? null, input.contentHash ?? null, input.contentText ?? null, now, now);
  return Number(res.lastInsertRowid);
}

export interface ItemFingerprint {
  id: number;
  cardHash: string | null;
  contentHash: string | null;
  /** Stable detail text from the last check/extraction (falls back to raw_text for older rows). */
  contentText: string | null;
  goneAt: number | null;
}

/** Change-detection state of every item in a collection, by URL. */
export function getItemFingerprints(collectionId: number): Map<string, ItemFingerprint> {
  const rows = getDb().prepare("SELECT id, url, card_hash, content_hash, COALESCE(content_text, raw_text) AS content_text, gone_at FROM items WHERE collection_id = ?").all(collectionId) as Row[];
  return new Map(
    rows.map((r) => [
      String(r.url),
      {
        id: Number(r.id),
        cardHash: r.card_hash == null ? null : String(r.card_hash),
        contentHash: r.content_hash == null ? null : String(r.content_hash),
        contentText: r.content_text == null ? null : String(r.content_text),
        goneAt: r.gone_at == null ? null : Number(r.gone_at),
      },
    ]),
  );
}

/**
 * Records that an item was seen (and optionally re-checked) without
 * re-extracting it. A null hash leaves the stored one untouched.
 */
export function touchItem(id: number, opts: { cardHash?: string | null; contentHash?: string | null; contentText?: string | null; checked?: boolean }) {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE items SET card_hash = COALESCE(?, card_hash), content_hash = COALESCE(?, content_hash), content_text = COALESCE(?, content_text),
         last_seen_at = ?, checked_at = CASE WHEN ? THEN ? ELSE checked_at END, gone_at = NULL WHERE id = ?`,
    )
    .run(opts.cardHash ?? null, opts.contentHash ?? null, opts.contentText ?? null, now, opts.checked ? 1 : 0, now, id);
}

/** Marks items of a collection not in `seenUrls` as gone; returns how many were newly marked. */
export function markGone(collectionId: number, seenUrls: Iterable<string>): number {
  const seen = new Set(seenUrls);
  const d = getDb();
  const rows = d.prepare("SELECT id, url FROM items WHERE collection_id = ? AND gone_at IS NULL").all(collectionId) as Row[];
  const stmt = d.prepare("UPDATE items SET gone_at = ? WHERE id = ?");
  const now = Date.now();
  let n = 0;
  for (const r of rows) {
    if (seen.has(String(r.url))) continue;
    stmt.run(now, Number(r.id));
    n++;
  }
  return n;
}

/** URLs of a collection's items that were extracted or seen at/after `since` — what a resumed crawl already handled. */
export function urlsSeenSince(collectionId: number, since: number): Set<string> {
  const rows = getDb().prepare("SELECT url FROM items WHERE collection_id = ? AND last_seen_at >= ?").all(collectionId, since) as Row[];
  return new Set(rows.map((r) => String(r.url)));
}

export function itemExists(collectionId: number, url: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM items WHERE collection_id = ? AND url = ?").get(collectionId, url);
}

function sourcesFor(ids: number[]): Map<number, Record<string, SpecSource>> {
  const out = new Map<number, Record<string, SpecSource>>();
  if (ids.length === 0) return out;
  const rows = getDb()
    .prepare(`SELECT * FROM spec_sources WHERE item_id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as Row[];
  for (const r of rows) {
    const id = Number(r.item_id);
    const rec = out.get(id) ?? {};
    rec[String(r.key)] = {
      origin: String(r.origin) as SpecOrigin,
      sourceUrl: r.source_url == null ? null : String(r.source_url),
      confidence: r.confidence == null ? null : Number(r.confidence),
    };
    out.set(id, rec);
  }
  return out;
}

function toItem(r: Row, sources: Record<string, SpecSource> = {}): Item {
  return {
    id: Number(r.id),
    collectionId: Number(r.collection_id),
    url: String(r.url),
    title: String(r.title),
    price: r.price == null ? null : Number(r.price),
    currency: r.currency == null ? null : String(r.currency),
    mainImage: r.main_image == null ? null : String(r.main_image),
    description: r.description == null ? null : String(r.description),
    identity: r.identity == null ? null : String(r.identity),
    specs: parseJson<Record<string, SpecValue>>(r.specs, {}),
    sources,
    indexedAt: Number(r.indexed_at),
    goneAt: r.gone_at == null ? null : Number(r.gone_at),
  };
}

const ITEM_COLUMNS = "id, collection_id, url, title, price, currency, main_image, description, identity, specs, indexed_at, gone_at";

export function getItemsByIds(ids: number[]): Item[] {
  if (ids.length === 0) return [];
  const rows: Row[] = [];
  // SQLite caps bound parameters; chunk to be safe.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...(getDb().prepare(`SELECT ${ITEM_COLUMNS} FROM items WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Row[]));
  }
  const src = sourcesFor(ids);
  const byId = new Map(rows.map((r) => [Number(r.id), toItem(r, src.get(Number(r.id)))]));
  return ids.map((id) => byId.get(id)).filter((x): x is Item => !!x);
}

export function getItem(id: number): (Item & { rawText: string | null }) | null {
  const r = getDb().prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
  if (!r) return null;
  return { ...toItem(r, sourcesFor([id]).get(id)), rawText: r.raw_text == null ? null : String(r.raw_text) };
}

export function listItems(scope: CollectionScope, limit = 100, offset = 0, includeGone = false): Item[] {
  const cond = scopeCondition(scope);
  const where = [cond?.sql, includeGone ? null : "gone_at IS NULL"].filter(Boolean);
  const rows = getDb()
    .prepare(`SELECT ${ITEM_COLUMNS} FROM items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY indexed_at DESC LIMIT ? OFFSET ?`)
    .all(...(cond?.params ?? []), limit, offset) as Row[];
  const src = sourcesFor(rows.map((r) => Number(r.id)));
  return rows.map((r) => toItem(r, src.get(Number(r.id))));
}

/** Runs a candidate query built by search/filters.ts. */
export function queryItemIds(sql: string, params: SQLInputValue[]): number[] {
  return (getDb().prepare(sql).all(...params) as Row[]).map((r) => Number(r.id));
}

export function setItemSpec(itemId: number, key: string, value: SpecValue, source: { origin: SpecOrigin; sourceUrl: string | null; confidence: number | null }) {
  const d = getDb();
  const sqlValue = typeof value === "boolean" ? (value ? "true" : "false") : value;
  // json() keeps booleans as JSON booleans rather than 1/0 / strings.
  if (typeof value === "boolean") {
    d.prepare("UPDATE items SET specs = json_set(specs, '$.' || json_quote(?), json(?)) WHERE id = ?").run(key, sqlValue, itemId);
  } else {
    d.prepare("UPDATE items SET specs = json_set(specs, '$.' || json_quote(?), ?) WHERE id = ?").run(key, sqlValue, itemId);
  }
  d.prepare(
    `INSERT INTO spec_sources (item_id, key, origin, source_url, confidence, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, key) DO UPDATE SET origin=excluded.origin, source_url=excluded.source_url, confidence=excluded.confidence, fetched_at=excluded.fetched_at`,
  ).run(itemId, key, source.origin, source.sourceUrl, source.confidence, Date.now());
}

// ---------- Spec key registry ----------

function toSpecKey(r: Row): SpecKey {
  return {
    key: String(r.key),
    type: String(r.type) as SpecType,
    unit: r.unit == null ? null : String(r.unit),
    label: String(r.label),
    example: r.example == null ? null : String(r.example),
    count: Number(r.count),
    origin: String(r.origin) as SpecOrigin,
  };
}

/** Registry for one collection, or merged across a set of collections (null = all). */
export function listSpecKeys(scope: CollectionScope): SpecKey[] {
  if (typeof scope === "number") {
    return (getDb().prepare("SELECT * FROM spec_keys WHERE collection_id = ? ORDER BY count DESC, key").all(scope) as Row[]).map(toSpecKey);
  }
  const cond = scopeCondition(scope);
  const rows = getDb()
    .prepare(
      `SELECT key, MIN(type) AS type, MAX(unit) AS unit, MAX(label) AS label, MAX(example) AS example, SUM(count) AS count, MIN(origin) AS origin
       FROM spec_keys ${cond ? `WHERE ${cond.sql}` : ""} GROUP BY key ORDER BY count DESC, key`,
    )
    .all(...(cond?.params ?? [])) as Row[];
  return rows.map(toSpecKey);
}

export function upsertSpecKey(collectionId: number, k: { key: string; type: SpecType; unit: string | null; label: string; example: string | null; origin: SpecOrigin }, increment = 1) {
  getDb()
    .prepare(
      `INSERT INTO spec_keys (collection_id, key, type, unit, label, example, count, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection_id, key) DO UPDATE SET count = count + excluded.count,
         unit = COALESCE(spec_keys.unit, excluded.unit), example = COALESCE(spec_keys.example, excluded.example),
         origin = CASE WHEN spec_keys.origin = 'page' THEN 'page' ELSE excluded.origin END`,
    )
    .run(collectionId, k.key, k.type, k.unit, k.label, k.example, increment, k.origin);
}

/** Recomputes counts from actual item specs (after re-crawls or enrichment). */
export function recountSpecKeys(collectionId: number) {
  getDb()
    .prepare(
      `UPDATE spec_keys SET count = (
         SELECT COUNT(*) FROM items i, json_each(i.specs) j WHERE i.collection_id = spec_keys.collection_id AND j.key = spec_keys.key
       ) WHERE collection_id = ?`,
    )
    .run(collectionId);
}

// ---------- Web facts cache ----------

export interface WebFact {
  identity: string;
  key: string;
  value: SpecValue | null;
  unit: string | null;
  sourceUrl: string | null;
  confidence: number | null;
  found: boolean;
  fetchedAt: number;
}

/** A cached fact, or null when there is none — or it is a "not found" older than ENRICH_NOT_FOUND_TTL_DAYS (worth retrying). */
export function getWebFact(identity: string, key: string): WebFact | null {
  const r = getDb().prepare("SELECT * FROM web_facts WHERE identity = ? AND key = ?").get(identity, key) as Row | undefined;
  if (!r) return null;
  const ttl = env.ENRICH_NOT_FOUND_TTL_DAYS * 86_400_000;
  if (Number(r.found) !== 1 && ttl > 0 && Date.now() - Number(r.fetched_at) > ttl) return null;
  return {
    identity: String(r.identity),
    key: String(r.key),
    value: parseJson<SpecValue | null>(r.value, null),
    unit: r.unit == null ? null : String(r.unit),
    sourceUrl: r.source_url == null ? null : String(r.source_url),
    confidence: r.confidence == null ? null : Number(r.confidence),
    found: Number(r.found) === 1,
    fetchedAt: Number(r.fetched_at),
  };
}

export function saveWebFact(f: Omit<WebFact, "fetchedAt">) {
  getDb()
    .prepare(
      `INSERT INTO web_facts (identity, key, value, unit, source_url, confidence, found, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity, key) DO UPDATE SET value=excluded.value, unit=excluded.unit, source_url=excluded.source_url,
         confidence=excluded.confidence, found=excluded.found, fetched_at=excluded.fetched_at`,
    )
    .run(f.identity, f.key, JSON.stringify(f.value), f.unit, f.sourceUrl, f.confidence, f.found ? 1 : 0, Date.now());
}

// ---------- Identity aliases ----------

/** The canonical identity `identity` was grouped under, or itself when it never was. */
export function getCanonicalIdentity(identity: string): string {
  const r = getDb().prepare("SELECT canonical FROM identity_aliases WHERE identity = ?").get(identity) as Row | undefined;
  return r ? String(r.canonical) : identity;
}

/** Which of these identities have already been through grouping. */
export function aliasedIdentities(identities: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < identities.length; i += 500) {
    const chunk = identities.slice(i, i + 500);
    const rows = getDb().prepare(`SELECT identity FROM identity_aliases WHERE identity IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Row[];
    for (const r of rows) out.add(String(r.identity));
  }
  return out;
}

export function saveIdentityAliases(pairs: Array<{ identity: string; canonical: string }>) {
  const stmt = getDb().prepare("INSERT OR REPLACE INTO identity_aliases (identity, canonical, created_at) VALUES (?, ?, ?)");
  const now = Date.now();
  for (const p of pairs) stmt.run(p.identity, p.canonical, now);
}

/** Canonical identities already known for a brand (first token): grouped earlier or looked up on the web. */
export function knownCanonicals(brand: string, limit = 200): string[] {
  const like = `${brand.replace(/[%_\\]/g, "")} %`;
  return (
    getDb()
      .prepare(
        "SELECT canonical AS identity FROM identity_aliases WHERE canonical LIKE ? UNION SELECT identity FROM web_facts WHERE identity LIKE ? LIMIT ?",
      )
      .all(like, like, limit) as Row[]
  ).map((r) => String(r.identity));
}

/** Every raw identity grouped under `canonical` (including itself). */
export function aliasesOf(canonical: string): string[] {
  const rows = getDb().prepare("SELECT identity FROM identity_aliases WHERE canonical = ?").all(canonical) as Row[];
  return [...new Set([canonical, ...rows.map((r) => String(r.identity))])];
}

/**
 * A value for `key` that a listing of one of these product identities states
 * on its own page (not filled from the web), with that listing's URL.
 */
export function findPageValue(identities: string[], key: string): { value: SpecValue; url: string } | null {
  if (identities.length === 0) return null;
  const r = getDb()
    .prepare(
      `SELECT i.url, json_extract(i.specs, p.path) AS v, json_type(i.specs, p.path) AS t
       FROM items i, (SELECT '$.' || json_quote(?) AS path) p
       WHERE i.identity IN (${identities.map(() => "?").join(",")})
         AND json_type(i.specs, p.path) NOT IN ('null', 'object', 'array')
         -- 0 / "" on a page is almost always an extraction slip — don't spread it to siblings.
         AND NOT (json_type(i.specs, p.path) IN ('integer', 'real') AND json_extract(i.specs, p.path) = 0)
         AND NOT (json_type(i.specs, p.path) = 'text' AND trim(json_extract(i.specs, p.path)) = '')
         AND NOT EXISTS (SELECT 1 FROM spec_sources s WHERE s.item_id = i.id AND s.key = ? AND s.origin = 'web')
       LIMIT 1`,
    )
    .get(key, ...identities, key) as Row | undefined;
  if (!r) return null;
  const t = String(r.t);
  const value: SpecValue = t === "true" ? true : t === "false" ? false : t === "integer" || t === "real" ? Number(r.v) : String(r.v);
  return { value, url: String(r.url) };
}

/** Every attribute key ever looked up on the web (found or not), so query parsing reuses the names. */
export function webFactKeys(): string[] {
  return (getDb().prepare("SELECT key, COUNT(*) AS n FROM web_facts GROUP BY key ORDER BY n DESC LIMIT 100").all() as Row[]).map((r) => String(r.key));
}

// ---------- Query plan cache ----------

export function getCachedPlan(collectionId: number | null, query: string, registrySig: string): string | null {
  const d = getDb();
  const r = d.prepare("SELECT plan, registry_sig FROM query_cache WHERE collection_id = ? AND query = ?").get(collectionId ?? 0, query) as Row | undefined;
  if (!r || String(r.registry_sig) !== registrySig) return null;
  d.prepare("UPDATE query_cache SET used_at = ?, hits = hits + 1 WHERE collection_id = ? AND query = ?").run(Date.now(), collectionId ?? 0, query);
  return String(r.plan);
}

export function saveCachedPlan(collectionId: number | null, query: string, registrySig: string, plan: string) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO query_cache (collection_id, query, registry_sig, plan, created_at, used_at, hits) VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(collection_id, query) DO UPDATE SET registry_sig=excluded.registry_sig, plan=excluded.plan, created_at=excluded.created_at, used_at=excluded.used_at`,
    )
    .run(collectionId ?? 0, query, registrySig, plan, now, now);
}

/** Adds (or bumps) a search in the user's Recent list. */
export function recordSearch(userId: number, collectionId: number | null, query: string) {
  getDb()
    .prepare(
      `INSERT INTO search_history (user_id, collection_id, query, used_at, hits) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(user_id, collection_id, query) DO UPDATE SET used_at = excluded.used_at, hits = hits + 1`,
    )
    .run(userId, collectionId ?? 0, query, Date.now());
}

export function listRecentQueries(userId: number, collectionId: number | null, limit = 10): Array<{ query: string; usedAt: number; hits: number }> {
  return (
    getDb()
      .prepare("SELECT query, used_at, hits FROM search_history WHERE user_id = ? AND collection_id = ? ORDER BY used_at DESC LIMIT ?")
      .all(userId, collectionId ?? 0, limit) as Row[]
  ).map((r) => ({ query: String(r.query), usedAt: Number(r.used_at), hits: Number(r.hits) }));
}

// ---------- Jobs ----------

function toJob(r: Row): Job {
  const status = String(r.status) as Job["status"];
  return {
    id: Number(r.id),
    collectionId: r.collection_id == null ? null : Number(r.collection_id),
    userId: r.user_id == null ? null : Number(r.user_id),
    kind: String(r.kind) as JobKind,
    status,
    pagesSeen: Number(r.pages_seen),
    itemsFound: Number(r.items_found),
    itemsIndexed: Number(r.items_indexed),
    itemsFailed: Number(r.items_failed),
    webSearches: Number(r.web_searches),
    llmCost: Number(r.llm_cost ?? 0),
    itemsRemaining: Number(r.items_remaining ?? 0),
    message: r.message == null ? null : String(r.message),
    error: r.error == null ? null : String(r.error),
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    resumable: r.kind === "crawl" && (status === "stopped" || status === "interrupted") && r.params != null && r.collection_id != null,
  };
}

export function createJob(kind: JobKind, collectionId: number | null, params?: unknown, userId: number | null = null): Job {
  const res = getDb()
    .prepare("INSERT INTO jobs (collection_id, kind, status, started_at, params, user_id) VALUES (?, ?, 'queued', ?, ?, ?)")
    .run(collectionId, kind, Date.now(), params === undefined ? null : JSON.stringify(params), userId);
  return getJob(Number(res.lastInsertRowid))!;
}

/** The options a job was started with (crawls only; null for jobs from before they were saved). */
export function getJobParams<T>(id: number): T | null {
  const r = getDb().prepare("SELECT params FROM jobs WHERE id = ?").get(id) as Row | undefined;
  return parseJson<T | null>(r?.params, null);
}

export function getJob(id: number): Job | null {
  const r = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
  return r ? toJob(r) : null;
}

/** A viewer's own jobs (admins: everyone's); no viewer = all. */
function jobOwnerFilter(viewer?: Viewer): { sql: string; params: number[] } {
  return viewer && viewer.role !== "admin" ? { sql: "user_id = ?", params: [viewer.id] } : { sql: "1", params: [] };
}

export function listJobs(limit = 20, viewer?: Viewer): Job[] {
  const f = jobOwnerFilter(viewer);
  return (getDb().prepare(`SELECT * FROM jobs WHERE ${f.sql} ORDER BY id DESC LIMIT ?`).all(...f.params, limit) as Row[]).map(toJob);
}

/** Jobs are private to whoever started them (and admins). */
export function canSeeJob(job: Pick<Job, "userId">, viewer: Viewer): boolean {
  return viewer.role === "admin" || job.userId === viewer.id;
}

const JOB_COLUMNS: Record<string, string> = {
  status: "status",
  pagesSeen: "pages_seen",
  itemsFound: "items_found",
  itemsIndexed: "items_indexed",
  itemsFailed: "items_failed",
  webSearches: "web_searches",
  itemsRemaining: "items_remaining",
  message: "message",
  error: "error",
  finishedAt: "finished_at",
};

export function updateJob(id: number, patch: Partial<Omit<Job, "id" | "kind" | "collectionId" | "startedAt">>): Job {
  const entries = Object.entries(patch).filter(([k]) => JOB_COLUMNS[k]);
  if (entries.length > 0) {
    const set = entries.map(([k]) => `${JOB_COLUMNS[k]} = ?`).join(", ");
    getDb()
      .prepare(`UPDATE jobs SET ${set} WHERE id = ?`)
      .run(...entries.map(([, v]) => (v ?? null) as SQLInputValue), id);
  }
  return getJob(id)!;
}

export function listActiveJobs(viewer?: Viewer): Job[] {
  const f = jobOwnerFilter(viewer);
  return (getDb().prepare(`SELECT * FROM jobs WHERE status IN ('queued','running') AND ${f.sql} ORDER BY id`).all(...f.params) as Row[]).map(toJob);
}

export function activeJobForCollection(collectionId: number, kind: JobKind): Job | null {
  const r = getDb()
    .prepare("SELECT * FROM jobs WHERE collection_id = ? AND kind = ? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1")
    .get(collectionId, kind) as Row | undefined;
  return r ? toJob(r) : null;
}

/** Most common values of string-typed keys, so query parsing can map "dizel" → "diesel". */
export function stringValueSamples(scope: CollectionScope, perKey = 12): Map<string, string[]> {
  const cond = scopeCondition(scope, "i.collection_id");
  const rows = getDb()
    .prepare(
      `SELECT j.key AS key, j.value AS value, COUNT(*) AS n FROM items i, json_each(i.specs) j
       WHERE j.type = 'text' ${cond ? `AND ${cond.sql}` : ""}
       GROUP BY j.key, j.value ORDER BY j.key, n DESC`,
    )
    .all(...(cond?.params ?? [])) as Row[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(String(r.key)) ?? [];
    if (list.length < perKey) list.push(String(r.value));
    out.set(String(r.key), list);
  }
  return out;
}

/** Numeric range per number key (helps the parser judge "cheap", "big", etc.). */
export function numericRanges(scope: CollectionScope): Map<string, { min: number; max: number }> {
  const cond = scopeCondition(scope, "i.collection_id");
  const rows = getDb()
    .prepare(
      `SELECT j.key AS key, MIN(j.value) AS mn, MAX(j.value) AS mx FROM items i, json_each(i.specs) j
       WHERE j.type IN ('integer','real') ${cond ? `AND ${cond.sql}` : ""} GROUP BY j.key`,
    )
    .all(...(cond?.params ?? [])) as Row[];
  return new Map(rows.map((r) => [String(r.key), { min: Number(r.mn), max: Number(r.mx) }]));
}

export function priceStats(scope: CollectionScope): { min: number; max: number; currency: string | null } | null {
  const cond = scopeCondition(scope);
  const r = getDb()
    .prepare(`SELECT MIN(price) mn, MAX(price) mx, MAX(currency) cur FROM items WHERE price IS NOT NULL ${cond ? `AND ${cond.sql}` : ""}`)
    .get(...(cond?.params ?? [])) as Row | undefined;
  if (!r || r.mn == null) return null;
  return { min: Number(r.mn), max: Number(r.mx), currency: r.cur == null ? null : String(r.cur) };
}

/**
 * Renames duplicate spec keys inside one collection: moves each item's value
 * (scaled by factor for unit conversions) to the canonical key unless the item
 * already has it, then drops the old key from items, provenance and registry.
 */
export function applyKeyMerges(collectionId: number, merges: Array<{ from: string; to: string; factor: number }>): number {
  if (merges.length === 0) return 0;
  const d = getDb();
  const rows = d.prepare("SELECT id, specs FROM items WHERE collection_id = ?").all(collectionId) as Row[];
  let moved = 0;
  d.exec("BEGIN");
  try {
    for (const r of rows) {
      const specs = parseJson<Record<string, SpecValue>>(r.specs, {});
      let dirty = false;
      for (const m of merges) {
        if (specs[m.from] === undefined) continue;
        if (specs[m.to] === undefined) {
          const v = specs[m.from];
          specs[m.to] = typeof v === "number" && m.factor !== 1 ? Math.round(v * m.factor * 10) / 10 : v;
          d.prepare("UPDATE OR IGNORE spec_sources SET key = ? WHERE item_id = ? AND key = ?").run(m.to, Number(r.id), m.from);
          moved++;
        }
        delete specs[m.from];
        d.prepare("DELETE FROM spec_sources WHERE item_id = ? AND key = ?").run(Number(r.id), m.from);
        dirty = true;
      }
      if (dirty) d.prepare("UPDATE items SET specs = ? WHERE id = ?").run(JSON.stringify(specs), Number(r.id));
    }
    for (const m of merges) d.prepare("DELETE FROM spec_keys WHERE collection_id = ? AND key = ?").run(collectionId, m.from);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  recountSpecKeys(collectionId);
  return moved;
}

// ---------- LLM usage ----------

export interface LlmUsageInput {
  purpose: LlmPurpose;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** USD as reported by OpenRouter; null when the response carried no price. */
  cost: number | null;
  webSearches: number;
  jobId: number | null;
  collectionId: number | null;
  /** Who the spend is billed to (the user who started the job/search). */
  userId?: number | null;
}

export function recordLlmUsage(u: LlmUsageInput) {
  const d = getDb();
  d.prepare(
    "INSERT INTO llm_usage (created_at, purpose, model, prompt_tokens, completion_tokens, cost, web_searches, job_id, collection_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(Date.now(), u.purpose, u.model, u.promptTokens, u.completionTokens, u.cost, u.webSearches, u.jobId, u.collectionId, u.userId ?? null);
  if (u.jobId !== null && u.cost) d.prepare("UPDATE jobs SET llm_cost = llm_cost + ? WHERE id = ?").run(u.cost, u.jobId);
}

/** Spend of one user, or everyone's when userId is null. */
export function usageSummary(now = Date.now(), userId: number | null = null): UsageSummary {
  const d = getDb();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const who = userId === null ? "1" : "user_id = ?";
  const p = userId === null ? [] : [userId];
  const since = (ts: number) => Number((d.prepare(`SELECT COALESCE(SUM(cost), 0) AS c FROM llm_usage WHERE ${who} AND created_at >= ?`).get(...p, ts) as Row).c);
  const byPurpose = (d.prepare(`SELECT purpose, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS calls FROM llm_usage WHERE ${who} GROUP BY purpose ORDER BY cost DESC`).all(...p) as Row[]).map((r) => ({
    purpose: String(r.purpose) as LlmPurpose,
    cost: Number(r.cost),
    calls: Number(r.calls),
  }));
  const byModel = (
    d
      .prepare(
        `SELECT model, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS calls, SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct FROM llm_usage WHERE ${who} GROUP BY model ORDER BY cost DESC`,
      )
      .all(...p) as Row[]
  ).map((r) => ({ model: String(r.model), cost: Number(r.cost), calls: Number(r.calls), promptTokens: Number(r.pt), completionTokens: Number(r.ct) }));
  return {
    today: since(startOfDay.getTime()),
    last30d: since(now - 30 * 86_400_000),
    allTime: since(0),
    byPurpose,
    byModel,
    unpricedCalls: Number((d.prepare(`SELECT COUNT(*) AS n FROM llm_usage WHERE ${who} AND cost IS NULL`).get(...p) as Row).n),
  };
}

// ---------- Settings & push subscriptions ----------

export function getSetting<T>(key: string): T | null {
  const r = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
  if (!r) return null;
  try {
    return JSON.parse(String(r.value)) as T;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: unknown) {
  getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

export function deleteSetting(key: string) {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export interface PushSubscriptionRow {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Browsers subscribed by one user (null = every subscription). */
export function listPushSubs(userId: number | null): PushSubscriptionRow[] {
  const rows = (
    userId === null
      ? getDb().prepare("SELECT endpoint, keys FROM push_subscriptions").all()
      : getDb().prepare("SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?").all(userId)
  ) as Row[];
  return rows.map((r) => ({
    endpoint: String(r.endpoint),
    keys: JSON.parse(String(r.keys)),
  }));
}

/** A browser belongs to whoever subscribed it last (shared machine: the new user takes it over). */
export function savePushSub(sub: PushSubscriptionRow, userAgent: string | null, userId: number | null = null) {
  getDb()
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, keys, user_agent, created_at, user_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, user_agent = excluded.user_agent, user_id = excluded.user_id`,
    )
    .run(sub.endpoint, JSON.stringify(sub.keys), userAgent, Date.now(), userId);
}

/** Removes a subscription; with userId, only if it's theirs. */
export function deletePushSub(endpoint: string, userId?: number) {
  if (userId === undefined) getDb().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  else getDb().prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(endpoint, userId);
}
