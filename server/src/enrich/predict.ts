import { z } from "zod";
import type { Item, MissingAttribute, SpecKey } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { askForJson } from "../llm/client.ts";
import { normalizeKey } from "../llm/extract.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { lookupIdentity } from "./group.ts";

const log = createLogger("predict");

const profileSchema = z.object({
  attributes: z
    .array(
      z.object({
        key: z.string(),
        type: z.enum(["number", "boolean", "string"]),
        unit: z.string().nullable().optional(),
        label: z.string(),
      }),
    )
    .default([]),
});

const SYSTEM = `You pick the product specifications shoppers most often compare for a product category — facts printed on manufacturer spec sheets and spec databases that are the same for every unit of the exact model (cars: boot capacity, 0-100 acceleration, top speed, fuel consumption, length, kerb weight, torque; laptops: weight, battery capacity, screen brightness).

Return ONLY: { "attributes": [ { "key": string, "type": "number" | "boolean" | "string", "unit": string | null, "label": string } ] }

- Up to 20 attributes, most useful first.
- NEVER listing-specific facts that differ from ad to ad: price, mileage, condition, color, location, number of owners, registration or production date, remaining warranty, seller, optional equipment.
- Reuse a registry key exactly when it means the same thing; otherwise a new English snake_case key with a unit suffix when numeric (_liters, _kg, _mm, _s, _kmh, _kw, _nm, _l_100km, _wh, _mah, _inch).
- label: short English name.`;

const profileKey = (collectionId: number) => `attr-profile:${collectionId}`;
const pending = new Map<number, Promise<MissingAttribute[]>>();

/**
 * Spec-sheet attributes worth knowing for this collection's kind of product. One cheap LLM call per
 * collection, stored in settings; later calls are free. Failures return [] (retried next time).
 */
export function categoryProfile(collectionId: number, registry: SpecKey[], items: Item[]): Promise<MissingAttribute[]> {
  const saved = db.getSetting<{ attributes: MissingAttribute[] }>(profileKey(collectionId));
  if (saved) return Promise.resolve(saved.attributes);
  const running = pending.get(collectionId);
  if (running) return running;
  const products = [...new Set(items.map(lookupIdentity).filter(Boolean))].slice(0, 15);
  const keys = registry
    .slice(0, 150)
    .map((k) => `${k.key} (${k.type}${k.unit ? `, ${k.unit}` : ""})`)
    .join("\n");
  const user = `Products in this collection:\n${products.join("\n") || "(unknown)"}\n\nAttribute registry:\n${keys || "(empty)"}`;
  const job = askForJson(profileSchema, SYSTEM, user, { purpose: "predict", maxTokens: 1500, jsonMode: true })
    .then(({ data }) => {
      const byKey = new Map(registry.map((k) => [k.key, k]));
      const attributes: MissingAttribute[] = [];
      for (const a of data.attributes) {
        const key = normalizeKey(a.key);
        if (!key || attributes.some((x) => x.key === key)) continue;
        const known = byKey.get(key);
        attributes.push({ key, type: known?.type ?? a.type, unit: known?.unit ?? a.unit ?? null, label: a.label.trim() || key.replace(/_/g, " ") });
      }
      db.setSetting(profileKey(collectionId), { attributes, createdAt: Date.now() });
      return attributes;
    })
    .catch((err) => {
      log.warn(`category profile for collection ${collectionId} failed`, errorMessage(err));
      return [] as MissingAttribute[];
    })
    .finally(() => pending.delete(collectionId));
  pending.set(collectionId, job);
  return job;
}

/**
 * Attributes to ask for alongside a paid lookup, best first: keys already looked up for this collection
 * or for the same brands (proven demand), then the collection's spec-sheet profile. Synonyms are folded
 * to one canonical key. Per-product filtering (already stated / cached) is the caller's job.
 */
export async function candidateAttributes(collectionId: number, items: Item[]): Promise<MissingAttribute[]> {
  const registry = db.listSpecKeys(collectionId);
  const byKey = new Map(registry.map((k) => [k.key, k]));
  const brands = [...new Set(items.map((i) => lookupIdentity(i).split(" ")[0]))];
  const out = new Map<string, MissingAttribute>();
  const add = (a: MissingAttribute) => {
    const canonical = db.canonicalKey(a.key);
    if (out.has(canonical)) return;
    const known = byKey.get(a.key);
    out.set(canonical, { ...a, type: known?.type ?? a.type, unit: known?.unit ?? a.unit });
  };
  for (const k of db.webKeysNear(collectionId, brands)) add({ key: k.key, type: k.type, unit: k.unit, label: k.key.replace(/_/g, " ") });
  for (const a of await categoryProfile(collectionId, registry, items)) add(a);
  return [...out.values()];
}
