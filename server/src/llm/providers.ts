import type { JSONValue, LanguageModel, ProviderMetadata, ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createFireworks } from "@ai-sdk/fireworks";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { llmTiers, type LlmProviderInfo, type LlmTier } from "@specharvest/shared";
import { env } from "../config.ts";

/**
 * Every LLM provider a key can be added for. Library-specific code lives here and in client.ts only —
 * the keyring, settings UI, ledger and (later) credits don't depend on the AI SDK.
 *
 * Models are always built from a provider instance created with the key (`createX({ apiKey })(modelId)`),
 * never from a plain "provider/model" string, which the AI SDK would route through Vercel's AI Gateway.
 */

export type ProviderOptions = Record<string, Record<string, JSONValue>>;

export interface ProviderConnection {
  apiKey: string;
  /** Custom endpoint only. */
  baseUrl?: string | null;
}

/** A model object — deliberately not `string`: a string model id would go through Vercel's AI Gateway. */
export type ProviderModel = Exclude<LanguageModel, string>;

export interface ProviderClient {
  model(modelId: string): ProviderModel;
  /** Provider-native web search tools (empty for models that always search); null = no web search. */
  webSearch(): ToolSet | null;
}

export interface ProviderDef extends Omit<LlmProviderInfo, "webSearch" | "exactCost"> {
  /** models.dev provider id, for the price list and model suggestions. */
  modelsDev: string | null;
  create(conn: ProviderConnection): ProviderClient;
  /** Can run web lookups. */
  canSearch: boolean;
  /** Only these models can search (default: all of the provider's models). */
  searchModels?: RegExp;
  /** Approximate fee per web search, USD — for cost estimates only. */
  searchFeeUsd: number;
  /** Ask for JSON output (response_format json_object or equivalent). */
  jsonMode: boolean;
  /** Per-call provider options (e.g. keep reasoning short so JSON tasks stay cheap). */
  options?: (tier: LlmTier, modelId: string) => ProviderOptions | undefined;
  /** USD the provider itself reported for the call; null = estimate it. */
  exactCost?: (meta: ProviderMetadata | undefined) => number | null;
}

const all = [...llmTiers];
const noSearch = () => null;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    group: "popular",
    keyUrl: "https://openrouter.ai/keys",
    modelsDev: "openrouter",
    tiers: all,
    defaults: { fast: "google/gemini-2.5-flash-lite", smart: "google/gemini-2.5-flash", web: "google/gemini-2.5-flash" },
    custom: false,
    canSearch: true,
    searchFeeUsd: 0.007,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createOpenRouter({ apiKey, compatibility: "strict", appName: "SpecHarvest", appUrl: env.PUBLIC_URL });
      return {
        // Usage accounting adds the exact USD cost (incl. web search fees) to every response.
        model: (id) => p.chat(id, { usage: { include: true } }),
        // OpenRouter's server tool takes its settings nested under `parameters`; the provider's typed helper
        // would put them at the top level, so pass the documented shape through it.
        webSearch: () => ({
          web_search: p.tools.webSearch({
            parameters: { engine: env.WEB_SEARCH_ENGINE, max_results: 5, max_uses: env.WEB_SEARCH_MAX_USES, search_context_size: "medium" },
          } as unknown as Parameters<typeof p.tools.webSearch>[0]),
        }),
      };
    },
    exactCost: (meta) => num((meta?.openrouter as { usage?: { cost?: unknown } } | undefined)?.usage?.cost),
  },
  {
    id: "openai",
    label: "OpenAI",
    group: "popular",
    keyUrl: "https://platform.openai.com/api-keys",
    modelsDev: "openai",
    tiers: all,
    defaults: { fast: "gpt-5-nano", smart: "gpt-5-mini", web: "gpt-5-mini" },
    custom: false,
    canSearch: true,
    searchFeeUsd: 0.01,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createOpenAI({ apiKey });
      return { model: (id) => p(id), webSearch: () => ({ web_search: p.tools.webSearch({ searchContextSize: "medium" }) }) };
    },
    // Reasoning models: short reasoning keeps JSON extraction fast and cheap (ignored by non-reasoning models).
    options: () => ({ openai: { reasoningEffort: "low" } }),
  },
  {
    id: "anthropic",
    label: "Anthropic",
    group: "popular",
    keyUrl: "https://console.anthropic.com/settings/keys",
    modelsDev: "anthropic",
    tiers: all,
    defaults: { fast: "claude-haiku-4-5", smart: "claude-sonnet-5-5", web: "claude-haiku-4-5" },
    custom: false,
    canSearch: true,
    searchFeeUsd: 0.01,
    // No schema-less JSON mode; the prompts ask for JSON and the client repairs/salvages it.
    jsonMode: false,
    create: ({ apiKey }) => {
      const p = createAnthropic({ apiKey });
      return { model: (id) => p(id), webSearch: () => ({ web_search: p.tools.webSearch_20250305({ maxUses: env.WEB_SEARCH_MAX_USES }) }) };
    },
  },
  {
    id: "google",
    label: "Google Gemini",
    group: "popular",
    keyUrl: "https://aistudio.google.com/apikey",
    modelsDev: "google",
    tiers: all,
    defaults: { fast: "gemini-flash-lite-latest", smart: "gemini-flash-latest", web: "gemini-flash-latest" },
    custom: false,
    canSearch: true,
    searchFeeUsd: 0.014,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createGoogleGenerativeAI({ apiKey });
      return { model: (id) => p(id), webSearch: () => ({ google_search: p.tools.googleSearch({}) }) };
    },
  },
  {
    id: "mistral",
    label: "Mistral",
    group: "more",
    keyUrl: "https://console.mistral.ai/api-keys",
    modelsDev: "mistral",
    tiers: all,
    defaults: { fast: "mistral-small-latest", smart: "mistral-medium-latest", web: "mistral-medium-latest" },
    custom: false,
    canSearch: true,
    searchFeeUsd: 0.03,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createMistral({ apiKey });
      return { model: (id) => p(id), webSearch: () => ({ web_search: p.tools.webSearch() }) };
    },
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    group: "more",
    keyUrl: "https://console.x.ai",
    modelsDev: "xai",
    tiers: all,
    defaults: { fast: "grok-4.20-0309-non-reasoning", smart: "grok-4.3", web: "grok-4.3" },
    custom: false,
    canSearch: true,
    searchFeeUsd: 0.005,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createXai({ apiKey });
      return { model: (id) => p(id), webSearch: () => ({ web_search: p.tools.webSearch() }) };
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    group: "more",
    keyUrl: "https://platform.deepseek.com/api_keys",
    modelsDev: "deepseek",
    tiers: ["fast", "smart"],
    defaults: { fast: "deepseek-flash", smart: "deepseek-v4-pro" },
    custom: false,
    canSearch: false,
    searchFeeUsd: 0,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createDeepSeek({ apiKey });
      return { model: (id) => p(id), webSearch: noSearch };
    },
  },
  {
    id: "groq",
    label: "Groq",
    group: "more",
    keyUrl: "https://console.groq.com/keys",
    modelsDev: "groq",
    tiers: all,
    defaults: { fast: "openai/gpt-oss-20b", smart: "openai/gpt-oss-120b", web: "openai/gpt-oss-120b" },
    custom: false,
    canSearch: true,
    // Groq's browser search only runs on its gpt-oss models.
    searchModels: /^openai\/gpt-oss-/,
    searchFeeUsd: 0.005,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createGroq({ apiKey });
      return { model: (id) => p(id), webSearch: () => ({ browser_search: p.tools.browserSearch({}) }) };
    },
  },
  {
    id: "perplexity",
    label: "Perplexity",
    group: "more",
    keyUrl: "https://www.perplexity.ai/settings/api",
    modelsDev: "perplexity",
    // Sonar models search the web on every call — fine for lookups, wasteful for extraction.
    tiers: ["web"],
    defaults: { web: "sonar" },
    custom: false,
    canSearch: true,
    searchFeeUsd: 0,
    jsonMode: false,
    create: ({ apiKey }) => {
      const p = createPerplexity({ apiKey });
      return { model: (id) => p(id), webSearch: () => ({}) };
    },
    exactCost: (meta) => num((meta?.perplexity as { cost?: { totalCost?: unknown } } | undefined)?.cost?.totalCost),
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    group: "more",
    keyUrl: "https://deepinfra.com/dash/api_keys",
    modelsDev: "deepinfra",
    tiers: ["fast", "smart"],
    defaults: { fast: "openai/gpt-oss-120b", smart: "deepseek-ai/DeepSeek-V4-Flash" },
    custom: false,
    canSearch: false,
    searchFeeUsd: 0,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createDeepInfra({ apiKey });
      return { model: (id) => p(id), webSearch: noSearch };
    },
  },
  {
    id: "togetherai",
    label: "Together AI",
    group: "more",
    keyUrl: "https://api.together.ai/settings/api-keys",
    modelsDev: "togetherai",
    tiers: ["fast", "smart"],
    defaults: { fast: "openai/gpt-oss-120b", smart: "deepseek-ai/DeepSeek-V4.1-Flash" },
    custom: false,
    canSearch: false,
    searchFeeUsd: 0,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createTogetherAI({ apiKey });
      return { model: (id) => p(id), webSearch: noSearch };
    },
  },
  {
    id: "fireworks",
    label: "Fireworks",
    group: "more",
    keyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    modelsDev: "fireworks-ai",
    tiers: ["fast", "smart"],
    defaults: { fast: "accounts/fireworks/models/gpt-oss-120b", smart: "accounts/fireworks/models/deepseek-v4p1-flash" },
    custom: false,
    canSearch: false,
    searchFeeUsd: 0,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createFireworks({ apiKey });
      return { model: (id) => p(id), webSearch: noSearch };
    },
  },
  {
    id: "cerebras",
    label: "Cerebras",
    group: "more",
    keyUrl: "https://cloud.cerebras.ai",
    modelsDev: "cerebras",
    tiers: ["fast", "smart"],
    defaults: { fast: "gpt-oss-120b", smart: "gpt-oss-120b" },
    custom: false,
    canSearch: false,
    searchFeeUsd: 0,
    jsonMode: true,
    create: ({ apiKey }) => {
      const p = createCerebras({ apiKey });
      return { model: (id) => p(id), webSearch: noSearch };
    },
  },
  {
    // Any OpenAI-compatible server (Ollama, LM Studio, vLLM, …). Admins only: the server calls whatever URL is set.
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    group: "custom",
    keyUrl: null,
    modelsDev: null,
    tiers: ["fast", "smart"],
    defaults: {},
    custom: true,
    canSearch: false,
    searchFeeUsd: 0,
    jsonMode: true,
    create: ({ apiKey, baseUrl }) => {
      if (!baseUrl) throw new Error("The custom provider needs a base URL");
      const p = createOpenAICompatible({ name: "custom", baseURL: baseUrl, apiKey, includeUsage: true });
      return { model: (id) => p.chatModel(id), webSearch: noSearch };
    },
  },
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): ProviderDef | null {
  return byId.get(id) ?? null;
}

/** Can this provider serve the tier (web also needs search)? */
export function servesTier(p: ProviderDef, tier: LlmTier): boolean {
  return p.tiers.includes(tier) && (tier !== "web" || p.canSearch);
}

/** Can this model run web lookups? */
export function modelCanSearch(p: ProviderDef, modelId: string): boolean {
  return p.canSearch && (!p.searchModels || p.searchModels.test(modelId));
}

/** The catalog as the UI sees it. */
export function providerInfo(p: ProviderDef): LlmProviderInfo {
  return {
    id: p.id,
    label: p.label,
    group: p.group,
    keyUrl: p.keyUrl,
    tiers: p.tiers,
    webSearch: p.canSearch,
    defaults: p.defaults,
    custom: p.custom,
    exactCost: !!p.exactCost,
  };
}
