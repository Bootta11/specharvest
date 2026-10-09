import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { llmModelChoicesSchema, llmTiers, saveLlmKeySchema, type LlmModelOption, type LlmPurpose, type LlmSettingsResponse, type LlmTestResult, type LlmTier } from "@specharvest/shared";
import { env } from "../config.ts";
import { httpError } from "../lib/http-error.ts";
import { errorMessage } from "../lib/logger.ts";
import { currentUser } from "../auth/plugin.ts";
import type { AuthUser } from "../auth/ownership.ts";
import { classifyLlmError, probeModel } from "./client.ts";
import { deleteKey, listKeys, markKeyWorking, modelChoices, saveKey, saveModelChoices, setKeyError, usableKeys } from "./keys.ts";
import { modelOptions } from "./pricing.ts";
import { getProvider, modelCanSearch, PROVIDERS, providerInfo, servesTier, type ProviderDef } from "./providers.ts";
import { clientForKey, forgetClients, llmStatus, resolveModel, serverAllowed, serverLlmAccess, type ResolvedModel } from "./resolve.ts";

/** Saving/testing a key makes a real (tiny) call to the provider — keep it from being hammered. */
const probeLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

const providerParam = (params: unknown, user: AuthUser): ProviderDef => {
  const p = getProvider(String((params as { provider?: string }).provider ?? ""));
  if (!p) throw httpError(404, "Unknown provider");
  // A custom URL makes the server call any address — admins only.
  if (p.custom && user.role !== "admin") throw httpError(403, "Only admins can add a custom endpoint");
  return p;
};

function settingsFor(user: AuthUser): LlmSettingsResponse {
  return {
    keys: listKeys(user.id),
    models: modelChoices(user.id),
    ...llmStatus(user.id),
    server: { configured: !!env.OPENROUTER_API_KEY, allowed: serverAllowed(user), access: serverLlmAccess() },
    providers: PROVIDERS.filter((p) => !p.custom || user.role === "admin").map(providerInfo),
  };
}

function normalizeBaseUrl(raw: string | undefined): string {
  let url: URL;
  try {
    url = new URL((raw ?? "").trim());
  } catch {
    throw httpError(400, "Enter the endpoint's base URL, e.g. http://localhost:11434/v1");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw httpError(400, "The base URL must start with http:// or https://");
  return url.toString().replace(/\/+$/, "");
}

/** GET {baseUrl}/models of an OpenAI-compatible server. */
async function listRemoteModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(10_000) });
  if (res.status === 401 || res.status === 403) throw httpError(400, `The endpoint rejected this key (${res.status})`);
  if (!res.ok) throw httpError(400, `${baseUrl}/models answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
  return (body?.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
}

/** The model to check a new key with: one the user already picked for this provider, else its default. */
function probeTarget(userId: number, p: ProviderDef): { modelId: string; tier: LlmTier } | null {
  const picks = modelChoices(userId);
  for (const tier of llmTiers) if (picks[tier]?.provider === p.id) return { modelId: picks[tier]!.model, tier };
  for (const tier of llmTiers) if (p.defaults[tier]) return { modelId: p.defaults[tier]!, tier };
  return null;
}

/** Checks a key with a tiny call. Rejected keys throw (never stored); a working key with a problem returns a warning. */
async function verifyKey(userId: number, p: ProviderDef, apiKey: string, baseUrl: string | null): Promise<string | null> {
  if (p.custom) {
    try {
      await listRemoteModels(baseUrl!, apiKey);
      return null;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode) throw err;
      throw httpError(400, `Couldn't reach ${baseUrl}/models: ${errorMessage(err)}`);
    }
  }
  const target = probeTarget(userId, p);
  if (!target) return null;
  try {
    await probeModel(clientForKey(p, { apiKey, baseUrl }).model(target.modelId), p.options?.(target.tier, target.modelId));
    return null;
  } catch (err) {
    const { kind, detail } = classifyLlmError(err);
    if (kind === "auth") throw httpError(400, `${p.label} rejected this key: ${detail}`);
    if (kind === "other") throw httpError(400, `Couldn't check the key with ${p.label}: ${detail}`);
    // The key itself was accepted.
    if (kind === "credit") return `Out of credit: ${detail}`;
    if (kind === "model") return `Model ${target.modelId}: ${detail} — pick another model below.`;
    return `Rate limited while checking: ${detail}`;
  }
}

/** The purpose a tier test runs as (decides the server key's model too). */
const TEST_PURPOSE: Record<LlmTier, LlmPurpose> = { fast: "extract", smart: "group", web: "web-lookup" };

export function registerLlmRoutes(app: FastifyInstance) {
  app.get("/api/settings/llm", async (req): Promise<LlmSettingsResponse> => settingsFor(currentUser(req)));

  // Verified with a tiny call first; a rejected key is not stored. The key never comes back from the API.
  app.put("/api/settings/llm/keys/:provider", probeLimit, async (req): Promise<LlmSettingsResponse> => {
    const user = currentUser(req);
    const p = providerParam(req.params, user);
    const body = saveLlmKeySchema.parse(req.body);
    if (!p.custom && body.apiKey.length < 8) throw httpError(400, "That doesn't look like an API key");
    const baseUrl = p.custom ? normalizeBaseUrl(body.baseUrl) : null;
    const warning = await verifyKey(user.id, p, body.apiKey, baseUrl);
    saveKey(user.id, p.id, body.apiKey, baseUrl, warning);
    forgetClients(user.id);
    return settingsFor(user);
  });

  app.delete("/api/settings/llm/keys/:provider", async (req, reply) => {
    const user = currentUser(req);
    const p = getProvider(String((req.params as { provider?: string }).provider ?? ""));
    if (!p || !deleteKey(user.id, p.id)) return reply.status(404).send({ error: "Not found" });
    forgetClients(user.id);
    return settingsFor(user);
  });

  // null = automatic. A pick must use a provider the user has a key for; web picks must be able to search.
  app.put("/api/settings/llm/models", async (req): Promise<LlmSettingsResponse> => {
    const user = currentUser(req);
    const choices = llmModelChoicesSchema.parse(req.body);
    const keys = usableKeys(user.id);
    for (const tier of llmTiers) {
      const pick = choices[tier];
      if (!pick) continue;
      const p = getProvider(pick.provider);
      if (!p || !keys.has(p.id)) throw httpError(400, `Add a ${p?.label ?? pick.provider} key first`);
      if (!servesTier(p, tier) || (tier === "web" && !modelCanSearch(p, pick.model))) {
        throw httpError(400, tier === "web" ? `${pick.model} on ${p.label} can't search the web` : `${p.label} can't be used for ${tier} tasks`);
      }
    }
    saveModelChoices(user.id, choices);
    return settingsFor(user);
  });

  // Suggestions for the model pickers (models.dev prices); a custom endpoint lists its own models.
  app.get("/api/settings/llm/models/:provider", async (req): Promise<LlmModelOption[]> => {
    const user = currentUser(req);
    const p = providerParam(req.params, user);
    if (!p.custom) return modelOptions(p.id);
    const key = usableKeys(user.id).get(p.id);
    if (!key?.baseUrl) return [];
    try {
      return (await listRemoteModels(key.baseUrl, key.apiKey)).map((id) => ({ id, name: id, input: null, output: null }));
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode) throw err;
      throw httpError(400, `Couldn't reach ${key.baseUrl}/models: ${errorMessage(err)}`);
    }
  });

  // A tiny call on whatever the tier resolves to for this user (own key or server key).
  app.post("/api/settings/llm/test", probeLimit, async (req): Promise<LlmTestResult> => {
    const user = currentUser(req);
    const { tier } = z.object({ tier: z.enum(llmTiers) }).parse(req.body);
    let r: ResolvedModel;
    try {
      r = resolveModel(user.id, TEST_PURPOSE[tier]);
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    try {
      const ms = await probeModel(r.model, r.providerOptions);
      if (r.keyOwner !== null) markKeyWorking(r.keyOwner, r.provider.id);
      return { ok: true, provider: r.provider.id, model: r.modelId, ms };
    } catch (err) {
      const { kind, detail } = classifyLlmError(err);
      if (r.keyOwner !== null && kind !== "other" && kind !== "rate") setKeyError(r.keyOwner, r.provider.id, detail);
      return { ok: false, provider: r.provider.id, model: r.modelId, error: detail };
    }
  });
}
