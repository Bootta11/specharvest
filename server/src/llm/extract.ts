import { z } from "zod";
import type { SpecKey, SpecType, SpecValue } from "@specharvest/shared";
import { env } from "../config.ts";
import { askForJson } from "./client.ts";
import type { DetailSnapshot } from "../crawler/sanitize.ts";

// Compact tuple [key, value, unit?, label?] — dealer pages can list 100+
// equipment items and the verbose object form runs past the token limit.
const specSchema = z
  .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .min(2)
  .transform((t) => ({
    key: String(t[0] ?? ""),
    value: t[1] as number | boolean | string | null,
    unit: typeof t[2] === "string" ? t[2] : null,
    label: typeof t[3] === "string" ? t[3] : null,
  }));

const extractionSchema = z.object({
  title: z.string().min(1),
  price: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  main_image: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  identity: z.string().nullable().optional(),
  specs: z.array(specSchema).default([]),
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

function registryText(keys: SpecKey[]): string {
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

export async function extractItem(snapshot: DetailSnapshot, registry: SpecKey[]): Promise<Extraction> {
  const prefill = Object.entries(snapshot.prefill)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`)
    .join("\n");
  const user = `Spec key registry (reuse these keys):\n${registryText(registry)}\n\nPage URL: ${snapshot.url}\n\nStructured hints from page metadata:\n${prefill || "(none)"}\n\nCandidate image URLs:\n${snapshot.images.slice(0, 5).join("\n") || "(none)"}\n\nPage text:\n${snapshot.text}`;

  const { data } = await askForJson(extractionSchema, SYSTEM, user, { purpose: "extract", model: env.OPENROUTER_EXTRACTION_MODEL, maxTokens: 12000 });

  const byKey = new Map(registry.map((k) => [k.key, k]));
  const specs = new Map<string, ExtractedSpec>();
  for (const s of data.specs) {
    if (s.value === null || s.value === "") continue;
    const key = normalizeKey(s.key);
    if (!key) continue;
    const known = byKey.get(key);
    const type = known?.type ?? typeOf(s.value);
    const value = coerceToType(s.value, type);
    if (value === null) continue;
    specs.set(key, { key, value, type, unit: known?.unit ?? s.unit ?? null, label: s.label?.trim() || key });
  }

  return {
    title: data.title.trim() || snapshot.prefill.title || "Untitled",
    price: data.price ?? snapshot.prefill.price,
    currency: data.currency ?? snapshot.prefill.currency,
    mainImage: data.main_image && /^https?:/.test(data.main_image) ? data.main_image : snapshot.prefill.image,
    description: data.description ?? snapshot.prefill.description,
    identity: data.identity?.trim().toLowerCase().replace(/\s+/g, " ") || null,
    specs: [...specs.values()],
  };
}
