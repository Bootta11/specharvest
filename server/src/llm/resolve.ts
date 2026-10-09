import type { ToolSet } from "ai";
import { llmTiers, serverLlmAccessModes, type LlmEffective, type LlmFunding, type LlmPurpose, type LlmStatus, type LlmTier, type ServerLlmAccess, type UserRole } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { getUser } from "../auth/users.ts";
import { usableKeys, modelChoices, type UsableKey } from "./keys.ts";
import { getProvider, modelCanSearch, PROVIDERS, servesTier, type ProviderClient, type ProviderDef, type ProviderModel, type ProviderOptions } from "./providers.ts";

/**
 * Picks the provider, model and payer for each LLM call. Per tier, first match wins:
 *  1. the model the user picked for the tier, if they still have that provider's key (web: the model can search);
 *  2. automatic: the first of the user's keys (catalog order) that serves the tier, with its default model;
 *  3. the server's OpenRouter key, if the admin lets this user use it;
 *  4. otherwise LlmUnavailableError with what to do.
 * A failing own key is never silently swapped for the server key.
 */

export const TIER_OF: Record<LlmPurpose, LlmTier> = {
  detect: "fast",
  extract: "fast",
  search: "fast",
  predict: "fast",
  consolidate: "smart",
  group: "smart",
  "web-lookup": "web",
};

export const SETTINGS_PATH = "Settings → LLM provider";

/** Thrown when no key can serve a tier; the HTTP error handler turns it into a 400 with this message. */
export class LlmUnavailableError extends Error {
  readonly statusCode = 400;
  constructor(
    message: string,
    readonly tier: LlmTier,
  ) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

// ---------- Server key policy ----------

const ACCESS_KEY = "llm.serverAccess";

export function serverLlmAccess(): ServerLlmAccess {
  const v = db.getSetting<string>(ACCESS_KEY);
  return serverLlmAccessModes.includes(v as ServerLlmAccess) ? (v as ServerLlmAccess) : "everyone";
}

export function setServerLlmAccess(mode: ServerLlmAccess) {
  db.setSetting(ACCESS_KEY, mode);
}

interface Who {
  id: number;
  role: UserRole;
}

/** May this user's work run on the server's key? Work with no user (shouldn't happen) runs on it. */
export function serverAllowed(user: Who | null): boolean {
  if (!env.OPENROUTER_API_KEY) return false;
  if (!user) return true;
  const mode = serverLlmAccess();
  return mode === "everyone" || (mode === "admins" && user.role === "admin");
}

/** The server key's model for a purpose — the OPENROUTER_* settings, exactly as before per-user keys. */
function serverModel(purpose: LlmPurpose): string {
  switch (purpose) {
    case "extract":
      return env.OPENROUTER_EXTRACTION_MODEL;
    case "consolidate":
    case "group":
      return env.OPENROUTER_SMART_MODEL;
    case "web-lookup":
      return env.OPENROUTER_WEB_MODEL;
    default:
      return env.OPENROUTER_MODEL;
  }
}

const SERVER_MODEL_OF_TIER: Record<LlmTier, LlmPurpose> = { fast: "extract", smart: "group", web: "web-lookup" };

// ---------- Planning ----------

type Plan =
  | { ok: true; funding: "own"; provider: ProviderDef; modelId: string; key: UsableKey }
  | { ok: true; funding: "platform"; provider: ProviderDef }
  | { ok: false; reason: string };

const WEB_PROVIDERS = PROVIDERS.filter((p) => p.canSearch).map((p) => p.label);

function unavailableReason(tier: LlmTier, hasKeys: boolean): string {
  if (tier === "web") {
    return hasKeys
      ? `Web lookups need a provider that can search the web (${WEB_PROVIDERS.join(", ")}) — add one in ${SETTINGS_PATH}.`
      : `Web lookups need an LLM API key — add one in ${SETTINGS_PATH}.`;
  }
  return hasKeys ? `None of your LLM keys can run these tasks — add another provider in ${SETTINGS_PATH}.` : `Add an LLM API key in ${SETTINGS_PATH}.`;
}

function whoIs(userId: number | null): Who | null {
  if (userId === null) return null;
  const u = getUser(userId);
  return u ? { id: u.id, role: u.role } : null;
}

function planTier(user: Who | null, tier: LlmTier): Plan {
  let hasKeys = false;
  if (user) {
    const keys = usableKeys(user.id);
    hasKeys = keys.size > 0;
    const pick = modelChoices(user.id)[tier];
    if (pick) {
      const p = getProvider(pick.provider);
      const key = keys.get(pick.provider);
      if (p && key && servesTier(p, tier) && (tier !== "web" || modelCanSearch(p, pick.model))) {
        return { ok: true, funding: "own", provider: p, modelId: pick.model, key };
      }
    }
    for (const p of PROVIDERS) {
      const key = keys.get(p.id);
      const modelId = p.defaults[tier];
      if (!key || !modelId || !servesTier(p, tier) || (tier === "web" && !modelCanSearch(p, modelId))) continue;
      return { ok: true, funding: "own", provider: p, modelId, key };
    }
  }
  if (serverAllowed(user)) return { ok: true, funding: "platform", provider: getProvider("openrouter")! };
  return { ok: false, reason: unavailableReason(tier, hasKeys) };
}

/** What each tier runs on for this user right now — for Settings, /api/config and route checks. */
export function llmStatus(userId: number | null): LlmStatus {
  const user = whoIs(userId);
  const effective = {} as Record<LlmTier, LlmEffective | null>;
  const unavailable: LlmStatus["unavailable"] = {};
  for (const tier of llmTiers) {
    const plan = planTier(user, tier);
    if (!plan.ok) {
      effective[tier] = null;
      unavailable[tier] = plan.reason;
    } else if (plan.funding === "own") {
      effective[tier] = { funding: "own", provider: plan.provider.id, model: plan.modelId };
    } else {
      effective[tier] = { funding: "platform", provider: "openrouter", model: serverModel(SERVER_MODEL_OF_TIER[tier]) };
    }
  }
  return { effective, unavailable };
}

/** Throws (HTTP 400, actionable message) when the user has nothing that can serve the tier. */
export function requireLlm(userId: number, tier: LlmTier) {
  const plan = planTier(whoIs(userId), tier);
  if (!plan.ok) throw new LlmUnavailableError(plan.reason, tier);
}

export function llmReady(userId: number, tier: LlmTier): boolean {
  return planTier(whoIs(userId), tier).ok;
}

// ---------- Building models ----------

export interface ResolvedModel {
  provider: ProviderDef;
  modelId: string;
  funding: LlmFunding;
  model: ProviderModel;
  /** Web search tools, when asked for. */
  tools?: ToolSet;
  providerOptions?: ProviderOptions;
  jsonMode: boolean;
  /** Whose key it is (own funding) — failures are written back to it. */
  keyOwner: number | null;
}

/** Provider clients by key version; a re-saved or deleted key never reuses a stale client. */
const clients = new Map<string, ProviderClient>();

function clientFor(provider: ProviderDef, conn: { apiKey: string; baseUrl?: string | null }, cacheKey: string): ProviderClient {
  let c = clients.get(cacheKey);
  if (!c) {
    c = provider.create(conn);
    clients.set(cacheKey, c);
  }
  return c;
}

export function resolveModel(userId: number | null, purpose: LlmPurpose, opts: { webSearch?: boolean } = {}): ResolvedModel {
  const tier = TIER_OF[purpose];
  const plan = planTier(whoIs(userId), tier);
  if (!plan.ok) throw new LlmUnavailableError(plan.reason, tier);
  let client: ProviderClient;
  let modelId: string;
  if (plan.funding === "own") {
    client = clientFor(plan.provider, plan.key, `own:${userId}:${plan.provider.id}:${plan.key.version}`);
    modelId = plan.modelId;
  } else {
    client = clientFor(plan.provider, { apiKey: env.OPENROUTER_API_KEY! }, "platform");
    modelId = serverModel(purpose);
  }
  let tools: ToolSet | undefined;
  if (opts.webSearch) {
    tools = (modelCanSearch(plan.provider, modelId) && client.webSearch()) || undefined;
    if (!tools) throw new LlmUnavailableError(unavailableReason("web", true), "web");
  }
  return {
    provider: plan.provider,
    modelId,
    funding: plan.funding,
    model: client.model(modelId),
    tools,
    providerOptions: plan.provider.options?.(tier, modelId),
    jsonMode: plan.provider.jsonMode,
    keyOwner: plan.funding === "own" ? userId : null,
  };
}

/** A client for a key that isn't stored yet (verifying it before saving). */
export function clientForKey(provider: ProviderDef, conn: { apiKey: string; baseUrl?: string | null }): ProviderClient {
  return provider.create(conn);
}

/** Drop cached clients of a user (after their keys change). */
export function forgetClients(userId: number) {
  for (const k of clients.keys()) if (k.startsWith(`own:${userId}:`)) clients.delete(k);
}
