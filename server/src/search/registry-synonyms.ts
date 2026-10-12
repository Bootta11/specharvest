import { isListingField, type MissingAttribute, type SpecKey } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { proposeKeyMerges } from "../llm/consolidate.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";

const log = createLogger("search");

/**
 * Checks keys a search asked for but no listing field has ("boot_capacity_liters") against the scope's own
 * fields ("trunk_volume_l"): a synonym is saved as a key alias, so sanitizePlan turns the plan to the existing
 * field and no web lookup is offered for values the listings already state. One `consolidate` call, only for
 * keys not yet compared with these collections' fields at their current size. Non-fatal; returns aliases saved.
 */
export async function matchRegistrySynonyms(missing: MissingAttribute[], keys: SpecKey[], scope: db.CollectionScope): Promise<number> {
  if (missing.length === 0) return 0;
  const sizes = db.registrySizes(scope);
  const unchecked = missing.filter((m) => !db.registryChecked(m.key, sizes));
  if (unchecked.length === 0) return 0;
  let saved = 0;
  const types = new Set(unchecked.map((m) => m.type));
  const registry = keys.filter((k) => !isListingField(k.key) && types.has(k.type));
  if (registry.length > 0) {
    const asked = new Set(unchecked.map((m) => m.key));
    const known = new Set(registry.map((k) => k.key));
    const candidates: SpecKey[] = [
      ...unchecked.map((m) => ({ key: m.key, type: m.type, unit: m.unit ?? null, label: m.label, example: null, count: 0, origin: "web" as const })),
      ...registry,
    ];
    try {
      const merges = await proposeKeyMerges(candidates);
      // Only "asked key = an existing field" with matching units; merges among the registry are the crawl's business.
      for (const m of merges) {
        if (m.factor === 1 && asked.has(m.from) && known.has(m.to) && db.saveKeyAlias(m.from, m.to)) {
          saved++;
          log.info(`Searched key ${m.from} = existing field ${m.to}`);
        }
      }
    } catch (err) {
      log.warn("registry synonym check skipped", errorMessage(err));
      return 0;
    }
  }
  for (const m of unchecked) db.markRegistryChecked(m.key, sizes);
  return saved;
}
