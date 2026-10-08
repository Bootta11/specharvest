import { z } from "zod";
import type { SpecKey } from "@specharvest/shared";
import { env } from "../config.ts";
import { askForJson } from "./client.ts";

const mergeSchema = z.object({
  merges: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        factor: z.number().positive().nullable().optional(),
      }),
    )
    .default([]),
});

export interface KeyMerge {
  from: string;
  to: string;
  /** Multiply numeric values by this when moving them (unit conversion); 1 when units match. */
  factor: number;
}

const SYSTEM = `You maintain a registry of product attribute keys extracted by different runs. Some keys are duplicates: the same attribute under different names (e.g. "engine_kw" vs "engine_power_kw", "trunk_volume_liters" vs "trunk_capacity_liters", "led_lights" vs "led_headlights" only if truly the same thing).

Return ONLY: { "merges": [ { "from": string, "to": string, "factor": number | null } ] }

Rules:
- Merge only keys that a shopper would consider LITERALLY the same attribute (pure synonyms, spelling/plural variants, filler words like "power", "capacity"/"volume"). When unsure, do NOT merge — a missed merge is harmless, a wrong merge corrupts data.
- Qualifiers make DIFFERENT attributes: adaptive vs plain cruise control, heated vs cooled, front vs rear, panoramic roof vs sunroof, automatic high beam vs light sensor, spare tire vs repair kit, rain sensor vs light sensor, "type" vs the attribute itself when values differ in kind. Never merge those.
- Never merge a general attribute into a more specific one or vice versa (abs ≠ abs_with_ebd only if they differ; "air_conditioning" ≠ "dual_zone_climate_control").
- "to" must be the canonical key: prefer the one with the higher item count; on ties the clearer standard name.
- Same type only (number→number, boolean→boolean, string→string).
- Numbers with different units of the same quantity may merge with a conversion "factor" (to_value = from_value × factor), e.g. engine_hp → engine_kw factor 0.7355, engine_displacement_liters → engine_cc factor 1000. Use null when the units are the same.
- Never chain: every "to" must not itself appear as a "from".`;

export async function proposeKeyMerges(keys: SpecKey[]): Promise<KeyMerge[]> {
  if (keys.length < 2) return [];
  const list = keys
    .slice(0, 500)
    .map((k) => `${k.key} (${k.type}${k.unit ? `, ${k.unit}` : ""}, ${k.count} items${k.example ? `, e.g. ${JSON.stringify(k.example)}` : ""})`)
    .join("\n");
  const { data } = await askForJson(mergeSchema, SYSTEM, `Registry:\n${list}`, { purpose: "consolidate", maxTokens: 3000, model: env.OPENROUTER_SMART_MODEL });

  const byKey = new Map(keys.map((k) => [k.key, k]));
  const froms = new Set<string>();
  const out: KeyMerge[] = [];
  for (const m of data.merges) {
    let from = byKey.get(m.from);
    let to = byKey.get(m.to);
    if (!from || !to || from.key === to.key || from.type !== to.type) continue;
    if (!namesRelated(from.key, to.key, from.type === "boolean")) continue;
    let factor = from.type === "number" ? (m.factor ?? 1) : 1;
    // Canonical = the key more items already use (fewer values to move); ties → shorter name.
    if (to.count < from.count || (to.count === from.count && to.key.length > from.key.length)) {
      [from, to] = [to, from];
      factor = factor === 1 ? 1 : 1 / factor;
    }
    if (froms.has(from.key)) continue;
    out.push({ from: from.key, to: to.key, factor });
    froms.add(from.key);
  }
  // Drop chains (a "to" that is also merged away).
  return out.filter((m) => !froms.has(m.to));
}

const UNIT_TOKENS = new Set(["kw", "hp", "ps", "cc", "ccm", "l", "liters", "litres", "kg", "mm", "cm", "m", "inch", "km", "gb", "tb", "mah", "w", "years", "months", "s"]);
const FILLER = new Set(["power", "capacity", "volume", "size", "number", "of", "count", "total", "type", "system", "function", "feature", "with", "and"]);

// Regional / everyday synonyms folded to one token, so "trunk_volume_liters" ~ "boot_capacity_liters" can merge.
const SYNONYMS: Record<string, string> = { trunk: "boot", cargo: "boot", luggage: "boot", kerb: "curb", maximum: "max", top: "max", mass: "weight" };

function tokens(key: string): Set<string> {
  return new Set(
    key
      .split("_")
      .map((t) => t.replace(/s$/, ""))
      .map((t) => SYNONYMS[t] ?? t)
      .filter((t) => t && !UNIT_TOKENS.has(t) && !FILLER.has(t)),
  );
}

/**
 * Safety net against a model merging unrelated attributes: the meaningful
 * tokens (units and filler words removed, plurals folded) of the two names
 * must overlap substantially. "engine_kw" ~ "engine_power_hp" pass,
 * "cooled_seats" ~ "heated_seats" fail.
 */
export function namesRelated(a: string, b: string, exact = false): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  if (inter === 0) return false;
  // Every meaningful token of the shorter name must appear in the longer one,
  // and the longer one may add at most one extra token.
  // Booleans (equipment flags) only merge on identical meaningful tokens —
  // "remote_central_locking" is not "central_locking".
  if (exact) return inter === ta.size && inter === tb.size;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return inter === small.size && big.size - small.size <= 1 && !hasConflictingQualifier(ta, tb);
}

const QUALIFIERS = ["adaptive", "heated", "cooled", "ventilated", "front", "rear", "panoramic", "automatic", "electric", "manual", "digital", "led", "xenon", "sport", "split", "memory", "high", "low", "remote", "curtain", "side", "knee", "central"];

function hasConflictingQualifier(a: Set<string>, b: Set<string>): boolean {
  return QUALIFIERS.some((q) => a.has(q) !== b.has(q));
}
