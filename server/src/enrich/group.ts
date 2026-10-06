import { z } from "zod";
import type { Item } from "@specharvest/shared";
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

/**
 * Groups identities never seen before with each other and with products
 * already known (looked up or grouped earlier), saving an alias for every one
 * of them so it is never asked about again. Never throws: on an LLM failure the
 * identities stay ungrouped (exact match) and are retried next time.
 */
export async function canonicalizeIdentities(items: Array<Pick<Item, "identity" | "title">>): Promise<{ merged: number; calls: number }> {
  const titleOf = new Map<string, string>();
  for (const item of items) {
    const id = lookupIdentity(item);
    if (id && !titleOf.has(id)) titleOf.set(id, item.title);
  }
  const seen = db.aliasedIdentities([...titleOf.keys()]);
  const fresh = [...titleOf.keys()].filter((id) => !seen.has(id));
  if (fresh.length === 0) return { merged: 0, calls: 0 };

  // Sorted by name so a brand's variants land in the same call; known products only for the brands in it.
  fresh.sort();
  let merged = 0;
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
    merged += mapping.size;
  }
  return { merged, calls };
}

/** Asks the model for groups and keeps only the members that pass `sameProduct` against their canonical. */
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
      if (sameProduct(m, canonical) && accepted.every((a) => sameProduct(m, a))) {
        out.set(m, canonical);
        accepted.push(m);
      } else log.debug(`rejected grouping "${m}" → "${canonical}"`);
    }
  }
  // A fresh identity used as someone's canonical must map to itself (no chains).
  for (const to of new Set(out.values())) if (freshSet.has(to)) out.delete(to);
  return out;
}

// ---------- Safety net ----------

const GEAR = new Set(["at", "mt", "aut", "man", "automatic", "manual", "cvt", "4wd", "awd", "2wd", "fwd", "rwd", "4x4", "4x2", "4motion", "quattro", "xdrive", "allgrip"]);
const GEAR_RE = /^\d?(e?dct|dsg|at|mt|cvt)\d?$/;
const FILLER = new Set(["fl", "facelift", "new", "novi", "nova"]);
/** Engine words a fuller name may add without naming a different trim ("yaris cross" ~ "yaris cross hybrid"). */
const POWERTRAIN = new Set([
  "hybrid", "ehybrid", "mhev", "hev", "phev", "mild", "ev", "electric", "diesel", "petrol", "benzin", "turbo",
  "tdi", "tsi", "tfsi", "tgdi", "gdi", "crdi", "tce", "dci", "hdi", "bluehdi", "puretech", "ecoboost", "vvti", "skyactiv",
]);

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

function features(identity: string) {
  const [brand = "", ...rest] = normalize(identity);
  const f = { brand, years: new Set<string>(), disp: new Set<string>(), powerKw: [] as number[], gear: new Set<string>(), words: new Set<string>() };
  for (const t of rest) {
    if (/^(19|20)\d{2}$/.test(t)) f.years.add(t);
    else if (/^\d\.\d[a-z]*$/.test(t)) f.disp.add(t.replace(/l$/, ""));
    else if (/^\d{2,4}(kw|hp|ps|ks)?$/.test(t) && !/^\d{4}$/.test(t)) {
      // Power in kW; a bare figure ("tce 130", "hybrid 145") is horsepower.
      const n = parseInt(t, 10);
      f.powerKw.push(t.endsWith("kw") ? n : n * 0.7355);
    }
    else if (GEAR.has(t) || GEAR_RE.test(t)) f.gear.add(t);
    else if (!FILLER.has(t)) f.words.add(t);
  }
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

/**
 * Guard against the model grouping different products: same brand; year,
 * displacement, power and gearbox/drivetrain must not contradict; and the
 * remaining name words must match, the longer name adding only engine words
 * (a trim word like "premium" or "edition" means a different product).
 * "golf life plus 2.0 tdi 2026" ~ "golf life+ 2.0 tdi 85kw 2026" pass,
 * "x7 1.5 2025" ~ "x7 1.5t dct 2026" fail.
 */
export function sameProduct(a: string, b: string): boolean {
  const fa = features(a);
  const fb = features(b);
  if (!fa.brand || fa.brand !== fb.brand) return false;
  if (!compatible(fa.years, fb.years) || !compatible(fa.disp, fb.disp) || !powerCompatible(fa.powerKw, fb.powerKw) || !compatible(fa.gear, fb.gear)) return false;
  const [small, big] = fa.words.size <= fb.words.size ? [fa.words, fb.words] : [fb.words, fa.words];
  if (![...small].every((w) => big.has(w))) return false;
  return [...big].every((w) => small.has(w) || POWERTRAIN.has(w));
}
