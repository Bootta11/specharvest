import { z } from "zod";
import { FOCUS_SPEC_KEY, isHttpUrl, type SpecKey, type SpecType, type SpecValue } from "@specharvest/shared";
import { askForJson } from "./client.ts";
import type { DetailSnapshot } from "../crawler/sanitize.ts";

// Compact tuple [key, value, unit?, label?] — dealer pages can list 100+
// equipment items and the verbose object form runs past the token limit.
export const specSchema = z
  .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .min(2)
  .transform((t) => ({
    key: String(t[0] ?? ""),
    value: t[1] as number | boolean | string | null,
    unit: typeof t[2] === "string" ? t[2] : null,
    label: typeof t[3] === "string" ? t[3] : null,
  }));

/** The page's answer to the collection's focus (only asked for when one is set). */
export const focusAnswerSchema = z
  .object({
    match: z.boolean().nullable().optional(),
    evidence: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const extractionSchema = z.object({
  title: z.string().min(1),
  price: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  main_image: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  identity: z.string().nullable().optional(),
  specs: z.array(specSchema).default([]),
  focus: focusAnswerSchema,
});

export interface ExtractedSpec {
  key: string;
  value: SpecValue;
  type: SpecType;
  unit: string | null;
  label: string;
}

export interface Extraction {
  title: string;
  price: number | null;
  currency: string | null;
  mainImage: string | null;
  description: string | null;
  identity: string | null;
  specs: ExtractedSpec[];
  /** Answer to the collection's focus: true/false when the page says, null when it doesn't (or no focus was asked). */
  focusMatch: boolean | null;
  /** Short quote backing focusMatch. */
  focusNote: string | null;
}

const SYSTEM = `You normalize product listing pages into structured, comparable data. The page text may be in any language (e.g. Bosnian/Croatian/Serbian); your output keys and enumerated values must be in English.

Return ONLY one JSON object:
{
  "title": string,                 // product title as shown
  "price": number | null,          // current asking price as a plain number (if a discounted/"akcija" price is shown, use it)
  "currency": string | null,       // ISO code if obvious (KM/BAM -> "BAM", € -> "EUR", $ -> "USD")
  "main_image": string | null,     // absolute URL of the main product photo, if given
  "description": string | null,    // 1-3 sentence English summary of the seller's free text (condition, notable extras) — no phone numbers, emails, names or addresses
  "identity": string | null,       // lowercase canonical product identity for looking it up elsewhere: brand + model + variant/engine/trim + year when known, e.g. "volvo xc40 2.0 b3 core 2025", "lenovo thinkpad t14 gen 4 i7-1355u"
  "specs": [ [key, value, unit, label], ... ]   // one compact tuple per attribute, one per line
}

Rules for specs:
- One entry per distinct attribute stated on the page (spec tables, label/value lists, equipment checklists, and clear facts in the description). Do not invent values that are not on the page.
- "key": English snake_case. Put the unit in the key as a suffix when numeric: _km, _kw, _hp, _cc, _liters, _kg, _mm, _cm, _inch, _gb, _tb, _mah, _w, _years, _months, _seats, _doors. Example: "Kilometraža: 22.429km" -> ["mileage_km", 22429, "km"].
- REUSE an existing key from the registry below whenever the meaning matches (even if the page words it differently). Only create a new key for a genuinely new attribute.
- Numbers: plain numbers in the key's unit. Treat "." and "," as thousand separators or decimals by context ("22.429km" = 22429; "2.0" engine = 2.0 liters). ALWAYS convert to the key's unit: e.g. displacement shown as "1.6" or "2.0" (liters) under an _cc key -> 1600 / 2000; "163 KS/PS/hp" under a _kw key -> 120.
- Yes/no facts and equipment checklist items -> boolean true (e.g. "Klima: Da" -> air_conditioning true; a listed "ABS" item -> abs true). Use false only when the page explicitly says no/ne.
- Enumerations as short lowercase English strings: fuel_type "diesel" | "petrol" | "hybrid" | "electric" | "lpg"; transmission "automatic" | "manual"; drivetrain "fwd" | "rwd" | "awd"; condition "new" | "used"; colors in English.
- Multi-detail items: if a value has a qualifier ("Parking senzori: Naprijed i nazad"), emit the boolean (parking_sensors true) plus a specific key when useful (parking_sensors_position "front and rear").
- Tuple: [key, value, unit or null, label]. label = the original page label, ONLY for keys not already in the registry; omit it (3-element tuple) for registry keys. Example: ["mileage_km", 22429, "km"], ["heated_seats", true, null, "Grijanje sjedišta"].
- Keep it to the 150 most useful attributes; never repeat a key.
- Output compact JSON: write each tuple on ONE line, no indentation inside tuples.
- Skip page chrome: ids, view counts, dates published/renewed, seller contact, share buttons, navigation.`;

/** What the user is looking for in particular: added to the extraction and focus-check prompts. */
export function focusInstructions(focus: string): string {
  return `Crawl focus — the user is looking for this in particular: "${focus.replace(/\s+/g, " ")}"
- Read the whole page (spec lists, equipment, and the seller's free text) for facts that answer it.
- State each such fact as a spec (reuse registry keys; otherwise a clear English snake_case key, e.g. first_owner true, previous_owners_count 1, service_history "full"). A fact stated only in the description still counts.
- "focus": { "match": true | false | null, "evidence": string | null } — match = whether this listing is what the user is looking for; null when the page doesn't say (never guess). evidence = the short original page wording that decides it (max ~200 chars, no phone numbers, emails, names or addresses), null when match is null.`;
}

/** Turns the model's spec tuples into typed specs, reusing the registry's type and unit for known keys. */
export function normalizeSpecs(tuples: Array<z.infer<typeof specSchema>>, registry: SpecKey[]): ExtractedSpec[] {
  const byKey = new Map(registry.map((k) => [k.key, k]));
  const specs = new Map<string, ExtractedSpec>();
  for (const s of tuples) {
    if (s.value === null || s.value === "") continue;
    const key = normalizeKey(s.key);
    // The focus answer comes from "focus", not from a spec the model made up.
    if (!key || key === FOCUS_SPEC_KEY) continue;
    const known = byKey.get(key);
    const type = known?.type ?? typeOf(s.value);
    const value = coerceToType(s.value, type);
    if (value === null) continue;
    specs.set(key, { key, value, type, unit: known?.unit ?? s.unit ?? null, label: s.label?.trim() || key });
  }
  return [...specs.values()];
}

/** The registry entry of the focus answer spec. */
export function focusSpecKey(example: boolean) {
  return { key: FOCUS_SPEC_KEY, type: "boolean" as const, unit: null, label: "Matches focus", example: String(example), origin: "page" as const };
}

/** The focus answer as stored: a match needs a yes/no; the quote is kept short. */
export function toFocusAnswer(focus: z.infer<typeof focusAnswerSchema>): { focusMatch: boolean | null; focusNote: string | null } {
  const focusMatch = typeof focus?.match === "boolean" ? focus.match : null;
  const note = focus?.evidence?.trim().replace(/\s+/g, " ") || null;
  return { focusMatch, focusNote: focusMatch === null || !note ? null : note.slice(0, 300) };
}

export function registryText(keys: SpecKey[]): string {
  if (keys.length === 0) return "(empty — you are defining the first keys)";
  return keys
    .slice(0, 400)
    .map((k) => `${k.key} (${k.type}${k.unit ? `, ${k.unit}` : ""})${k.label && k.label !== k.key ? ` — e.g. "${k.label}"` : ""}`)
    .join("\n");
}

export function normalizeKey(key: string): string {
  return key
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function parseLooseNumber(s: string): number | null {
  const m = s.replace(/\s/g, "").match(/-?\d[\d.,]*/);
  if (!m) return null;
  let n = m[0];
  if (/^\d{1,3}([.,]\d{3})+$/.test(n)) n = n.replace(/[.,]/g, "");
  else n = n.replace(",", ".");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/** Coerce a value to the registry's type for that key; null when impossible. */
export function coerceToType(value: SpecValue, type: SpecType): SpecValue | null {
  if (type === "number") {
    if (typeof value === "number") return value;
    if (typeof value === "string") return parseLooseNumber(value);
    return null;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (/^(yes|true|da|ja|oui|si|1)$/i.test(value.trim())) return true;
      if (/^(no|false|ne|nein|non|0)$/i.test(value.trim())) return false;
    }
    return null;
  }
  return typeof value === "string" ? value.trim().toLowerCase() : String(value);
}

const typeOf = (v: SpecValue): SpecType => (typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string");

/** `focus`: the collection's crawl focus — the answer comes back as focusMatch/focusNote. */
export async function extractItem(snapshot: DetailSnapshot, registry: SpecKey[], focus?: string | null): Promise<Extraction> {
  const prefill = Object.entries(snapshot.prefill)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`)
    .join("\n");
  const user = `Spec key registry (reuse these keys):\n${registryText(registry)}\n\nPage URL: ${snapshot.url}\n\nStructured hints from page metadata:\n${prefill || "(none)"}\n\nCandidate image URLs:\n${snapshot.images.slice(0, 5).join("\n") || "(none)"}${focus ? `\n\n${focusInstructions(focus)}` : ""}\n\nPage text:\n${snapshot.text}`;

  const { data } = await askForJson(extractionSchema, SYSTEM, user, { purpose: "extract", maxTokens: 12000 });

  return {
    title: data.title.trim() || snapshot.prefill.title || "Untitled",
    price: data.price ?? snapshot.prefill.price,
    currency: data.currency ?? snapshot.prefill.currency,
    mainImage: [data.main_image, snapshot.prefill.image].find(isHttpUrl) ?? null,
    description: data.description ?? snapshot.prefill.description,
    identity: data.identity?.trim().toLowerCase().replace(/\s+/g, " ") || null,
    specs: normalizeSpecs(data.specs, registry),
    ...(focus ? toFocusAnswer(data.focus) : { focusMatch: null, focusNote: null }),
  };
}
