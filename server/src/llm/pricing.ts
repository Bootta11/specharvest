import type { LlmModelOption } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { getProvider, PROVIDERS } from "./providers.ts";

const log = createLogger("pricing");

/**
 * Model prices from models.dev (open, MIT, maintained by SST) — the same provider ids and model ids the
 * AI SDK uses. Used to estimate the cost of calls whose provider doesn't report a price, and for the
 * model suggestions in Settings. Kept in the settings table so restarts and offline periods still work.
 */
const SOURCE = "https://models.dev/api.json";
const SETTINGS_KEY = "llm-prices";
const REFRESH_MS = 24 * 3600_000;

/** USD per 1M tokens. */
export interface ModelPrice {
  name: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  deprecated: boolean;
}

export interface PriceTable {
  fetchedAt: number;
  /** Catalog provider id → model id → price. */
  providers: Record<string, Record<string, ModelPrice>>;
}

interface ModelsDevModel {
  name?: string;
  status?: string;
  modalities?: { output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

let table: PriceTable | null | undefined;

export function priceTable(): PriceTable | null {
  if (table === undefined) table = db.getSetting<PriceTable>(SETTINGS_KEY);
  return table;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Keeps only the catalog's providers and text models. */
export function parseModelsDev(data: Record<string, { models?: Record<string, ModelsDevModel> }>, now = Date.now()): PriceTable {
  const providers: PriceTable["providers"] = {};
  for (const p of PROVIDERS) {
    if (!p.modelsDev) continue;
    const out: Record<string, ModelPrice> = {};
    for (const [id, m] of Object.entries(data[p.modelsDev]?.models ?? {})) {
      if (m.modalities?.output && !m.modalities.output.includes("text")) continue;
      out[id] = {
        name: m.name || id,
        input: n(m.cost?.input),
        output: n(m.cost?.output),
        cacheRead: n(m.cost?.cache_read),
        cacheWrite: n(m.cost?.cache_write),
        deprecated: m.status === "deprecated",
      };
    }
    providers[p.id] = out;
  }
  return { fetchedAt: now, providers };
}

export async function refreshPrices(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(SOURCE, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${SOURCE} → ${res.status}`);
    const next = parseModelsDev((await res.json()) as Record<string, { models?: Record<string, ModelsDevModel> }>);
    table = next;
    db.setSetting(SETTINGS_KEY, next);
    log.info(`LLM prices refreshed (${Object.values(next.providers).reduce((s, m) => s + Object.keys(m).length, 0)} models)`);
    return true;
  } catch (err) {
    log.warn("Could not refresh LLM prices from models.dev — estimates use the last copy", errorMessage(err));
    return false;
  }
}

/** Refreshes now when the stored copy is missing or older than a day, then daily. */
export function startPriceRefresh() {
  const t = priceTable();
  if (!t || Date.now() - t.fetchedAt > REFRESH_MS) void refreshPrices();
  setInterval(() => void refreshPrices(), REFRESH_MS).unref();
}

/** Test hook. */
export function setPriceTable(t: PriceTable | null) {
  table = t;
}

export function modelPrice(providerId: string, modelId: string): ModelPrice | null {
  const models = priceTable()?.providers[providerId];
  if (!models) return null;
  // OpenRouter variants (":free", ":online") and Google's "models/" prefix price like the base model.
  return models[modelId] ?? models[modelId.replace(/^models\//, "")] ?? models[modelId.replace(/:[a-z-]+$/, "")] ?? null;
}

export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens that were neither read from nor written to the cache, when the provider says. */
  noCacheTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** USD estimate for one call; null when the model isn't in the price list. */
export function estimateCost(providerId: string, modelId: string, usage: TokenCounts, webSearches = 0): number | null {
  const price = modelPrice(providerId, modelId);
  if (!price || price.input === null || price.output === null) return null;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const fresh = usage.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  const perToken = (usdPerMillion: number) => usdPerMillion / 1e6;
  return (
    fresh * perToken(price.input) +
    cacheRead * perToken(price.cacheRead ?? price.input) +
    cacheWrite * perToken(price.cacheWrite ?? price.input) +
    (usage.outputTokens ?? 0) * perToken(price.output) +
    webSearches * (getProvider(providerId)?.searchFeeUsd ?? 0)
  );
}

/** Suggestions for the model pickers: current models, cheapest first. */
export function modelOptions(providerId: string): LlmModelOption[] {
  const models = priceTable()?.providers[providerId] ?? {};
  return Object.entries(models)
    .filter(([, m]) => !m.deprecated)
    .map(([id, m]) => ({ id, name: m.name, input: m.input, output: m.output }))
    .sort((a, b) => (a.input ?? Infinity) + (a.output ?? Infinity) - ((b.input ?? Infinity) + (b.output ?? Infinity)) || a.id.localeCompare(b.id));
}
