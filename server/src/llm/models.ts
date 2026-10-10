import type { LlmModelList, LlmModelOption, LlmTier } from "@specharvest/shared";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { modelOptions, modelPrice } from "./pricing.ts";
import { getProvider, modelCanSearch } from "./providers.ts";

const log = createLogger("llm-models");

/**
 * Model lists for the pickers in Settings → LLM provider: each provider's own live list, fetched with the
 * user's key (so it shows what that account can use), priced from OpenRouter's list or models.dev. When the
 * provider has no list endpoint or the call fails, models.dev's list is used instead (source "models.dev").
 */

type Format = "openai" | "array" | "anthropic" | "google" | "openrouter";

interface ListEndpoint {
  url: string;
  auth: "bearer" | "anthropic" | "google" | "none";
  format: Format;
}

/** Fixed public hosts only. The custom endpoint is listed by routes.ts (admins, user-set URL). */
const ENDPOINTS: Record<string, ListEndpoint> = {
  openrouter: { url: "https://openrouter.ai/api/v1/models", auth: "none", format: "openrouter" },
  openai: { url: "https://api.openai.com/v1/models", auth: "bearer", format: "openai" },
  anthropic: { url: "https://api.anthropic.com/v1/models?limit=1000", auth: "anthropic", format: "anthropic" },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", auth: "google", format: "google" },
  mistral: { url: "https://api.mistral.ai/v1/models", auth: "bearer", format: "openai" },
  xai: { url: "https://api.x.ai/v1/models", auth: "bearer", format: "openai" },
  deepseek: { url: "https://api.deepseek.com/models", auth: "bearer", format: "openai" },
  groq: { url: "https://api.groq.com/openai/v1/models", auth: "bearer", format: "openai" },
  deepinfra: { url: "https://api.deepinfra.com/v1/openai/models", auth: "bearer", format: "openai" },
  togetherai: { url: "https://api.together.xyz/v1/models", auth: "bearer", format: "array" },
  fireworks: { url: "https://api.fireworks.ai/inference/v1/models", auth: "bearer", format: "openai" },
  cerebras: { url: "https://api.cerebras.ai/v1/models", auth: "bearer", format: "openai" },
};

/** Ids of models that can't do chat (embeddings, speech, images…) — unless the price list knows them as text models. */
const NOT_CHAT = /embed|tts|whisper|dall-e|davinci|babbage|image|moderation|audio|transcri|rerank|guard|realtime|speech|computer-use|sora|veo|imagen|lyria|aqa|ocr/i;

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; list: LlmModelList }>();

function headersFor(e: ListEndpoint, apiKey: string | null): Record<string, string> {
  if (e.auth === "none" || !apiKey) return {};
  if (e.auth === "anthropic") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  if (e.auth === "google") return { "x-goog-api-key": apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

const perMillion = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
};

/** Raw list → options, before filtering. Exported for tests. */
export function parseModelList(providerId: string, format: Format, body: unknown): LlmModelOption[] {
  const b = body as Record<string, unknown> | unknown[] | null;
  const priced = (id: string, name?: unknown): LlmModelOption => {
    const p = modelPrice(providerId, id);
    return { id, name: typeof name === "string" && name ? name : (p?.name ?? id), input: p?.input ?? null, output: p?.output ?? null };
  };
  switch (format) {
    case "openrouter":
      return ((b as { data?: unknown[] })?.data ?? []).flatMap((m) => {
        const r = m as { id?: string; name?: string; pricing?: { prompt?: unknown; completion?: unknown }; architecture?: { output_modalities?: string[] } };
        if (!r.id || (r.architecture?.output_modalities && !r.architecture.output_modalities.includes("text"))) return [];
        return [{ id: r.id, name: r.name || r.id, input: perMillion(r.pricing?.prompt), output: perMillion(r.pricing?.completion) }];
      });
    case "anthropic":
      return ((b as { data?: unknown[] })?.data ?? []).flatMap((m) => {
        const r = m as { id?: string; display_name?: string };
        return r.id ? [priced(r.id, r.display_name)] : [];
      });
    case "google":
      return ((b as { models?: unknown[] })?.models ?? []).flatMap((m) => {
        const r = m as { name?: string; displayName?: string; supportedGenerationMethods?: string[] };
        if (!r.name || !r.supportedGenerationMethods?.includes("generateContent")) return [];
        return [priced(r.name.replace(/^models\//, ""), r.displayName)];
      });
    case "array":
    case "openai": {
      const items = format === "array" && Array.isArray(b) ? b : ((b as { data?: unknown[] })?.data ?? []);
      return items.flatMap((m) => {
        const r = m as { id?: string; display_name?: string; type?: string };
        if (!r.id || (r.type && r.type !== "chat" && r.type !== "language")) return [];
        return [priced(r.id, r.display_name)];
      });
    }
  }
}

/** Sorted cheapest first (unpriced last), chat models only. */
function tidy(providerId: string, list: LlmModelOption[]): LlmModelOption[] {
  const seen = new Set<string>();
  return list
    .filter((m) => !seen.has(m.id) && seen.add(m.id) && (!NOT_CHAT.test(m.id) || modelPrice(providerId, m.id)))
    .sort((a, b) => (a.input ?? Infinity) + (a.output ?? Infinity) - ((b.input ?? Infinity) + (b.output ?? Infinity)) || a.id.localeCompare(b.id));
}

async function fetchList(providerId: string, apiKey: string | null, fetchImpl: typeof fetch): Promise<LlmModelList> {
  const e = ENDPOINTS[providerId];
  if (!e || (e.auth !== "none" && !apiKey)) return { source: "models.dev", models: modelOptions(providerId) };
  try {
    const res = await fetchImpl(e.url, { headers: headersFor(e, apiKey), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${e.url} → ${res.status}`);
    const models = tidy(providerId, parseModelList(providerId, e.format, await res.json()));
    if (models.length === 0) throw new Error("empty list");
    return { source: "live", models };
  } catch (err) {
    log.warn(`Live model list for ${providerId} failed — using models.dev`, errorMessage(err));
    return { source: "models.dev", models: modelOptions(providerId) };
  }
}

/** The models a user can pick for a provider (and tier: web keeps only models that can search). */
export async function listModels(userId: number, providerId: string, apiKey: string | null, tier?: LlmTier, fetchImpl: typeof fetch = fetch): Promise<LlmModelList> {
  const key = `${userId}:${providerId}`;
  let hit = cache.get(key);
  if (!hit || Date.now() - hit.at > TTL_MS) {
    hit = { at: Date.now(), list: await fetchList(providerId, apiKey, fetchImpl) };
    cache.set(key, hit);
  }
  const p = getProvider(providerId);
  if (tier !== "web" || !p) return hit.list;
  return { ...hit.list, models: hit.list.models.filter((m) => modelCanSearch(p, m.id)) };
}

/** After a user's keys change. */
export function forgetModelLists(userId: number) {
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
}
