import { z } from "zod";
import type { Item, MatchSuggestion, ProductGroup, SameProduct } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { askForJson } from "../llm/client.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";

const log = createLogger("group");

/** Identity used for lookups/caching: extracted identity, else the normalized title. */
export function lookupIdentity(item: Pick<Item, "identity" | "title">): string {
  return (item.identity || item.title).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The canonical identity an item's product was grouped under (web_facts are stored under it). */
export function resolvedIdentity(item: Pick<Item, "identity" | "title">): string {
  return db.getCanonicalIdentity(lookupIdentity(item));
}

const groupSchema = z.object({
  groups: z
    .array(
      z.object({
        canonical: z.string(),
        members: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const SYSTEM = `You deduplicate product identities collected from shop listings, so the same product is researched on the web only once.

Return ONLY: { "groups": [ { "canonical": string, "members": string[] } ] }

Rules:
- Put identities in one group only when they are LITERALLY the same product written differently: spelling/format variants ("life+" = "life plus", "s-cross" = "s cross"), word order, or one side adding a detail the other omits without contradicting it (e.g. power "85kw" added to an otherwise identical name).
- NEVER group across a different trim/equipment line, engine, displacement, power, gearbox, drivetrain, body style, generation or model year. When unsure, do NOT group — a missed group costs one extra lookup, a wrong group copies wrong specs.
- "canonical" must be one of the listed identities. If a group contains an identity from "Known products", use that one as canonical; otherwise pick the most complete name.
- Only list groups with at least two identities. Every identity in "New" may appear in at most one group. Copy identities exactly as given.`;

const NEW_PER_CALL = 120;

/** The other listings (visible in `scope`) grouped as the same product as `item`; null when there are none. */
export function sameProductOf(item: Pick<Item, "id" | "identity" | "title">, scope: db.CollectionScope, limit = 20): SameProduct | null {
  const canonical = resolvedIdentity(item);
  const { items, total } = db.listItemsByIdentities(db.aliasesOf(canonical), scope, limit + 1);
  const others = items.filter((i) => i.id !== item.id).slice(0, limit);
  const totalOthers = total - (items.some((i) => i.id === item.id) ? 1 : 0);
  if (totalOthers <= 0) return null;
  return {
    canonical,
    listings: others.map(({ id, collectionId, title, url, identity, price, currency, goneAt }) => ({ id, collectionId, title, url, identity, price, currency, goneAt })),
    more: Math.max(0, totalOthers - others.length),
  };
}

/** Items grouped by product (canonical identity), biggest groups first, then by name. */
export function productGroups(items: Item[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const item of items) {
    const canonical = resolvedIdentity(item);
    const g = groups.get(canonical) ?? { canonical, listings: [] };
    const { id, collectionId, title, url, identity, price, currency, goneAt } = item;
    g.listings.push({ id, collectionId, title, url, identity, price, currency, goneAt });
    groups.set(canonical, g);
  }
  return [...groups.values()].sort((a, b) => b.listings.length - a.listings.length || a.canonical.localeCompare(b.canonical));
}

/** How many of these items' names have never been through grouping. */
export function ungroupedCount(items: Array<Pick<Item, "identity" | "title">>): number {
  const ids = [...new Set(items.map(lookupIdentity).filter(Boolean))];
  return ids.length - db.aliasedIdentities(ids).size;
}

/**
 * Groups identities never seen before with each other and with products
 * already known (looked up or grouped earlier), saving an alias for every one
 * of them so it is never asked about again, then runs the rule-based `regroup`
 * over all of them. Never throws on an LLM failure: those identities stay
 * ungrouped (exact match) and are retried next time.
 */
export async function canonicalizeIdentities(
  items: Array<Pick<Item, "identity" | "title">>,
): Promise<{ merged: number; calls: number; merges: Array<{ from: string; to: string }> }> {
  const titleOf = new Map<string, string>();
  for (const item of items) {
    const id = lookupIdentity(item);
    if (id && !titleOf.has(id)) titleOf.set(id, item.title);
  }
  const seen = db.aliasedIdentities([...titleOf.keys()]);
  const fresh = [...titleOf.keys()].filter((id) => !seen.has(id));

  // Sorted by name so a brand's variants land in the same call; known products only for the brands in it.
  fresh.sort();
  const merges: Array<{ from: string; to: string }> = [];
  let calls = 0;
  for (let i = 0; i < fresh.length; i += NEW_PER_CALL) {
    const chunk = fresh.slice(i, i + NEW_PER_CALL);
    const chunkSet = new Set(chunk);
    const brands = [...new Set(chunk.map(brandOf).filter(Boolean))];
    const known = [...new Set(brands.flatMap((b) => db.knownCanonicals(b, 50)))].filter((k) => !chunkSet.has(k)).slice(0, 300);
    let mapping = new Map<string, string>();
    if (chunk.length + known.length >= 2) {
      try {
        calls++;
        mapping = await proposeGroups(chunk, known, titleOf);
      } catch (err) {
        log.warn("grouping product identities failed", errorMessage(err));
        continue; // leave un-aliased → retried on the next job
      }
    }
    db.saveIdentityAliases(chunk.map((id) => ({ identity: id, canonical: mapping.get(id) ?? id })));
    for (const [from, to] of mapping) merges.push({ from, to });
  }
  // Rule-based pass over every name (not only new ones): catches what the model missed, never undoes a "different".
  merges.push(...regroup([...titleOf.keys()]));
  return { merged: merges.length, calls, merges };
}

/** Asks the model for groups and keeps only the members that pass `sameProduct` (less certain ones become suggestions via `matchSuggestions`). */
async function proposeGroups(fresh: string[], known: string[], titleOf: Map<string, string>): Promise<Map<string, string>> {
  const list = fresh.map((id) => `- ${id}${titleOf.get(id) && titleOf.get(id)!.toLowerCase() !== id ? `  (listing title: ${titleOf.get(id)})` : ""}`).join("\n");
  const user = `New:\n${list}\n\nKnown products:\n${known.length ? known.map((k) => `- ${k}`).join("\n") : "(none)"}`;
  const { data } = await askForJson(groupSchema, SYSTEM, user, { purpose: "group", model: env.OPENROUTER_SMART_MODEL, maxTokens: 4000 });

  const freshSet = new Set(fresh);
  const knownSet = new Set(known);
  const out = new Map<string, string>();
  for (const g of data.groups) {
    const all = [g.canonical, ...g.members].map((s) => s.trim()).filter((s) => freshSet.has(s) || knownSet.has(s));
    // A known product always wins as canonical (its cached facts are stored under it).
    let canonical = all.find((s) => knownSet.has(s)) ?? (freshSet.has(g.canonical.trim()) ? g.canonical.trim() : all[0]);
    if (!canonical) continue;
    canonical = db.getCanonicalIdentity(canonical);
    // Each member must match the canonical AND every member accepted before it ("85kw" and "110kw" can't both join a power-less name).
    const accepted: string[] = [];
    for (const m of all) {
      if (!freshSet.has(m) || out.has(m) || m === canonical) continue;
      if (sameProduct(m, canonical) && accepted.every((a) => sameProduct(m, a)) && !db.isRejected(m, canonical)) {
        out.set(m, canonical);
        accepted.push(m);
      } else log.debug(`rejected grouping "${m}" → "${canonical}"`);
    }
  }
  // A fresh identity used as someone's canonical must map to itself (no chains).
  for (const to of new Set(out.values())) if (freshSet.has(to)) out.delete(to);
  return out;
}

// ---------- Matching rules ----------

const GEAR = new Set(["at", "mt", "aut", "man", "automatic", "manual", "cvt", "4wd", "awd", "2wd", "fwd", "rwd", "4x4", "4x2", "4motion", "quattro", "xdrive", "allgrip"]);
const GEAR_RE = /^\d?(e?dct|dsg|at|mt|cvt)\d?$/;
const FILLER = new Set(["fl", "facelift", "new", "novi", "nova", "turbo", "mild", "scr", "adblue", "euro6", "euro6d", "start/stop"]);
/** Engine words name the fuel, not the product: "1.5 turbo" = "1.5 t-gdi" = "1.5 tgdi". Only a different fuel separates names. */
const COMBUSTION: Record<string, "diesel" | "petrol"> = {
  diesel: "diesel", tdi: "diesel", crdi: "diesel", dci: "diesel", hdi: "diesel", bluehdi: "diesel", cdti: "diesel", cdi: "diesel", jtd: "diesel", multijet: "diesel",
  petrol: "petrol", benzin: "petrol", tsi: "petrol", tfsi: "petrol", tgdi: "petrol", gdi: "petrol", tce: "petrol", puretech: "petrol", ecoboost: "petrol", vvti: "petrol", skyactiv: "petrol", mpi: "petrol",
};
const ELECTRIFIED: Record<string, "hybrid" | "phev" | "ev"> = {
  hybrid: "hybrid", ehybrid: "hybrid", hev: "hybrid", mhev: "hybrid", phev: "phev", ev: "ev", electric: "ev", bev: "ev", electro: "ev",
};

function normalize(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/\//g, "")
    .replace(/(\d)\s+(kw|hp|ps|ks)\b/g, "$1$2")
    .replace(/-/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

function brandOf(identity: string): string {
  return normalize(identity)[0] ?? "";
}

interface Features {
  brand: string;
  years: Set<string>;
  disp: Set<string>;
  powerKw: number[];
  gear: Set<string>;
  combustion: Set<string>;
  electrified: Set<string>;
  /** Model and trim words — what actually names the product. */
  words: Set<string>;
  /** How much the name says (more = more specific). */
  detail: number;
}

const featureCache = new Map<string, Features>();
function features(identity: string): Features {
  const cached = featureCache.get(identity);
  if (cached) return cached;
  const [brand = "", ...rest] = normalize(identity);
  const f: Features = { brand, years: new Set(), disp: new Set(), powerKw: [], gear: new Set(), combustion: new Set(), electrified: new Set(), words: new Set(), detail: 0 };
  for (const t of rest) {
    if (/^(19|20)\d{2}$/.test(t)) f.years.add(t);
    else if (/^\d\.\d[a-z]*$/.test(t)) f.disp.add(t.replace(/l$/, ""));
    else if (/^\d{2,4}(kw|hp|ps|ks)?$/.test(t) && !/^\d{4}$/.test(t)) {
      // Power in kW; a bare figure ("tce 130", "hybrid 145") is horsepower.
      const n = parseInt(t, 10);
      f.powerKw.push(t.endsWith("kw") ? n : n * 0.7355);
    } else if (GEAR.has(t) || GEAR_RE.test(t)) f.gear.add(t);
    else if (COMBUSTION[t]) f.combustion.add(COMBUSTION[t]);
    else if (ELECTRIFIED[t]) f.electrified.add(ELECTRIFIED[t]);
    else if (!FILLER.has(t)) f.words.add(t);
  }
  f.detail = f.years.size + f.disp.size + f.powerKw.length + f.gear.size + f.combustion.size + f.electrified.size + f.words.size;
  if (featureCache.size > 20_000) featureCache.clear();
  featureCache.set(identity, f);
  return f;
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
/** Equal when both sides state it; one side omitting it is fine. */
const compatible = (a: Set<string>, b: Set<string>) => a.size === 0 || b.size === 0 || sameSet(a, b);
/** Same power figures within 4 % (115 hp ≈ 85 kW), or one side doesn't state any. */
const powerCompatible = (a: number[], b: number[]) => {
  const near = (x: number, ys: number[]) => ys.some((y) => Math.abs(x - y) <= 0.04 * Math.max(x, y));
  return a.length === 0 || b.length === 0 || (a.every((x) => near(x, b)) && b.every((y) => near(y, a)));
};

/** Brand, year, displacement, power, gearbox/drivetrain and fuel don't contradict. */
function specsCompatible(fa: Features, fb: Features): boolean {
  return (
    !!fa.brand &&
    fa.brand === fb.brand &&
    compatible(fa.years, fb.years) &&
    compatible(fa.disp, fb.disp) &&
    powerCompatible(fa.powerKw, fb.powerKw) &&
    compatible(fa.gear, fb.gear) &&
    compatible(fa.combustion, fb.combustion) &&
    compatible(fa.electrified, fb.electrified)
  );
}

/**
 * Certainly the same product: nothing contradicts and the model/trim words
 * are identical — the names differ only in spelling, word order or details one
 * side leaves out (year, engine, power). Grouped automatically.
 * "cityray 1.5 gk" ~ "cityray gk 1.5 t-gdi 2026" ~ "cityray 1.5 turbo gk 2026" pass,
 * "x7 1.5 2025" ~ "x7 1.5t dct 2026" and "golf life" ~ "golf style" fail.
 */
export function sameProduct(a: string, b: string): boolean {
  const fa = features(a);
  const fb = features(b);
  return specsCompatible(fa, fb) && sameSet(fa.words, fb.words);
}

/**
 * Possibly the same product: nothing contradicts and one name's model/trim
 * words are all in the other, which adds more (usually the trim:
 * "starray em-i 2026" ~ "starray em-i 1.5 t-gdi phev max 2026"). Never grouped
 * automatically — offered for the user to confirm.
 */
export function maybeSameProduct(a: string, b: string): boolean {
  const fa = features(a);
  const fb = features(b);
  if (!specsCompatible(fa, fb) || sameSet(fa.words, fb.words)) return false;
  const [small, big] = fa.words.size <= fb.words.size ? [fa.words, fb.words] : [fb.words, fa.words];
  return small.size > 0 && [...small].every((w) => big.has(w));
}

// ---------- Rule-based regrouping & suggestions ----------

/** Current products (canonical → all its names) for a set of names. */
function clustersOf(identities: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const id of identities) {
    const root = db.getCanonicalIdentity(id);
    if (!out.has(root)) out.set(root, new Set(db.aliasesOf(root)));
    out.get(root)!.add(id);
  }
  return out;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

function rejectedSet(identities: string[]): Set<string> {
  return new Set(db.rejectedPairs(identities).map(([a, b]) => pairKey(a, b)));
}

function anyRejected(a: Set<string>, b: Set<string>, rejected: Set<string>): boolean {
  if (rejected.size === 0) return false;
  for (const x of a) for (const y of b) if (rejected.has(pairKey(x, y))) return true;
  return false;
}

/**
 * Merges products whose every name pair is certainly the same (`sameProduct`)
 * and that the user never marked as different. No LLM; safe to run often.
 */
export function regroup(identities: string[]): Array<{ from: string; to: string }> {
  const clusters = clustersOf([...new Set(identities)]);
  const rejected = rejectedSet([...clusters.values()].flatMap((s) => [...s]));
  const byBrand = new Map<string, string[]>();
  for (const root of clusters.keys()) byBrand.set(brandOf(root), [...(byBrand.get(brandOf(root)) ?? []), root]);

  const merges: Array<{ from: string; to: string }> = [];
  for (const roots of byBrand.values()) {
    if (roots.length < 2) continue;
    // Most specific first, so it becomes the canonical name of what joins it.
    roots.sort((a, b) => features(b).detail - features(a).detail || b.length - a.length || a.localeCompare(b));
    const alive = new Set(roots);
    for (const a of roots) {
      if (!alive.has(a)) continue;
      for (const b of roots) {
        if (a === b || !alive.has(b)) continue;
        const A = clusters.get(a)!;
        const B = clusters.get(b)!;
        if (anyRejected(A, B, rejected)) continue;
        if (![...A].every((x) => [...B].every((y) => sameProduct(x, y)))) continue;
        db.mergeCanonical(b, a);
        for (const n of B) A.add(n);
        alive.delete(b);
        merges.push({ from: b, to: a });
      }
    }
  }
  return merges;
}

/**
 * Pairs of products in this set that might be the same (`maybeSameProduct`)
 * and are waiting for the user: the less specific name and its candidates.
 */
export function matchSuggestions(items: Item[]): MatchSuggestion[] {
  const listingsOf = new Map<string, Item[]>();
  for (const item of items) {
    const root = resolvedIdentity(item);
    listingsOf.set(root, [...(listingsOf.get(root) ?? []), item]);
  }
  const roots = [...listingsOf.keys()];
  const clusters = clustersOf(roots);
  const rejected = rejectedSet([...clusters.values()].flatMap((s) => [...s]));
  const candidates = new Map<string, string[]>();
  for (const a of roots) {
    for (const b of roots) {
      if (a >= b || brandOf(a) !== brandOf(b) || !maybeSameProduct(a, b)) continue;
      if (anyRejected(clusters.get(a)!, clusters.get(b)!, rejected)) continue;
      const general = features(a).words.size <= features(b).words.size ? a : b;
      const specific = general === a ? b : a;
      candidates.set(general, [...(candidates.get(general) ?? []), specific]);
    }
  }
  const brief = (root: string) => ({ canonical: root, listings: listingsOf.get(root)!.length, title: listingsOf.get(root)![0].title });
  return [...candidates.entries()]
    .map(([identity, to]) => ({ ...brief(identity), identity, candidates: to.map(brief).sort((x, y) => y.listings - x.listings) }))
    .sort((x, y) => x.identity.localeCompare(y.identity));
}

/**
 * Loose grouping: confirms every possible match that has exactly one candidate, as if the owner had clicked
 * "Same product" (names marked different are never suggested). Repeats while merges reveal new
 * single-candidate matches. No LLM. Returns the merges made.
 */
export function autoConfirmMatches(items: Item[], maxRounds = 5): Array<{ from: string; to: string }> {
  const merges: Array<{ from: string; to: string }> = [];
  for (let round = 0; round < maxRounds; round++) {
    const single = matchSuggestions(items).filter((s) => s.candidates.length === 1);
    if (single.length === 0) break;
    for (const s of single) {
      const from = db.getCanonicalIdentity(s.identity);
      const to = db.getCanonicalIdentity(s.candidates[0].canonical);
      if (from === to) continue;
      db.mergeCanonical(from, to);
      merges.push({ from, to });
    }
  }
  return merges;
}

/**
 * Groups a collection's names per its grouping mode: certain matches always (LLM for names never seen,
 * then the free rule-based pass); in loose mode also single-candidate possible matches.
 * `llm: false` skips the LLM step (no key, or a viewer who must not be billed).
 */
export async function groupForCollection(
  collectionId: number,
  items: Item[],
  opts: { llm?: boolean } = {},
): Promise<{ calls: number; merges: Array<{ from: string; to: string }>; loose: Array<{ from: string; to: string }> }> {
  let calls = 0;
  const merges: Array<{ from: string; to: string }> = [];
  if (opts.llm !== false && ungroupedCount(items) > 0) {
    const res = await canonicalizeIdentities(items);
    calls = res.calls;
    merges.push(...res.merges);
  } else merges.push(...regroup(items.map(lookupIdentity)));
  const loose = db.getCollection(collectionId)?.grouping === "loose" ? autoConfirmMatches(items) : [];
  return { calls, merges, loose };
}
