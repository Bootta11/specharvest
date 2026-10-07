import type { ProviderCredits } from "@specharvest/shared";
import { env } from "../config.ts";

const BASE = "https://openrouter.ai/api/v1";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 10_000;

let cache: { at: number; value: ProviderCredits } | null = null;

async function getData<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(`${path} → ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`);
  }
  return ((await res.json()) as { data: T }).data;
}

interface KeyData {
  label?: string | null;
  limit?: number | null;
  limit_remaining?: number | null;
  usage?: number;
  usage_daily?: number;
  usage_monthly?: number;
  is_free_tier?: boolean;
}

/** OpenRouter balance for the server's key (and the whole account with a management key). Never throws; cached for a minute. */
export async function getProviderCredits(now = Date.now()): Promise<ProviderCredits> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const errors: string[] = [];
  const apiKey = env.OPENROUTER_API_KEY;
  const mgmtKey = env.OPENROUTER_MANAGEMENT_KEY;

  const [keyResult, accountResult] = await Promise.allSettled([
    apiKey ? getData<KeyData>("/key", apiKey) : Promise.reject(new Error("OPENROUTER_API_KEY is not set")),
    mgmtKey
      ? getData<{ total_credits: number; total_usage: number }>("/credits", mgmtKey)
      : Promise.reject(new Error("Set OPENROUTER_MANAGEMENT_KEY to show the account balance")),
  ]);

  let key: ProviderCredits["key"] = null;
  if (keyResult.status === "fulfilled") {
    const d = keyResult.value;
    key = {
      label: d.label ?? null,
      limit: d.limit ?? null,
      remaining: d.limit_remaining ?? null,
      usage: d.usage ?? 0,
      usageDaily: d.usage_daily ?? 0,
      usageMonthly: d.usage_monthly ?? 0,
      freeTier: d.is_free_tier ?? false,
    };
  } else errors.push(String(keyResult.reason instanceof Error ? keyResult.reason.message : keyResult.reason));

  let account: ProviderCredits["account"] = null;
  if (accountResult.status === "fulfilled") {
    const { total_credits, total_usage } = accountResult.value;
    account = { totalCredits: total_credits, totalUsage: total_usage, remaining: total_credits - total_usage };
  } else errors.push(String(accountResult.reason instanceof Error ? accountResult.reason.message : accountResult.reason));

  const value: ProviderCredits = { provider: "openrouter", key, account, errors, fetchedAt: new Date(now).toISOString() };
  cache = { at: now, value };
  return value;
}

/** Test hook. */
export function clearCreditsCache() {
  cache = null;
}
