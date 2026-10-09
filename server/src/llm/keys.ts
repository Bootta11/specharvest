import type { SQLInputValue } from "node:sqlite";
import { llmModelChoicesSchema, llmTiers, type LlmKeySummary, type LlmModelChoices } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { decryptSecret, encryptSecret } from "../lib/secrets.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";

const log = createLogger("llm-keys");

type Row = Record<string, SQLInputValue>;

/** A user's decrypted key, ready to build a provider client. `version` changes whenever the key is re-saved. */
export interface UsableKey {
  provider: string;
  apiKey: string;
  baseUrl: string | null;
  version: number;
}

const UNREADABLE = "This key can't be decrypted (was ENCRYPTION_KEY changed?) — enter it again.";

/** Binds each ciphertext to its row, so a key copied onto another user's row won't decrypt. */
const aad = (userId: number, provider: string) => `llm-key:${userId}:${provider}`;

/** Last 4 characters — enough to tell keys apart, useless to an attacker. */
export const keyHint = (apiKey: string) => apiKey.slice(-4);

/** Decrypted keys per user, dropped whenever that user's keys change. */
const cache = new Map<number, Map<string, UsableKey>>();

export function listKeys(userId: number): LlmKeySummary[] {
  return (db.getDb().prepare("SELECT provider, key_hint, base_url, created_at, verified_at, last_error FROM llm_keys WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map((r) => ({
    provider: String(r.provider),
    keyHint: String(r.key_hint),
    baseUrl: r.base_url == null ? null : String(r.base_url),
    createdAt: Number(r.created_at),
    verifiedAt: r.verified_at == null ? null : Number(r.verified_at),
    lastError: r.last_error == null ? null : String(r.last_error),
  }));
}

/** The user's keys that can be used right now (unreadable ones are flagged and skipped). */
export function usableKeys(userId: number): Map<string, UsableKey> {
  const cached = cache.get(userId);
  if (cached) return cached;
  const out = new Map<string, UsableKey>();
  for (const r of db.getDb().prepare("SELECT provider, key_enc, base_url, created_at, last_error FROM llm_keys WHERE user_id = ?").all(userId) as Row[]) {
    const provider = String(r.provider);
    try {
      out.set(provider, { provider, apiKey: decryptSecret(String(r.key_enc), aad(userId, provider)), baseUrl: r.base_url == null ? null : String(r.base_url), version: Number(r.created_at) });
    } catch (err) {
      log.warn(`LLM key ${provider} of user ${userId} can't be decrypted`, errorMessage(err));
      if (r.last_error !== UNREADABLE) setKeyError(userId, provider, UNREADABLE);
    }
  }
  cache.set(userId, out);
  return out;
}

/** Encrypts and stores (or replaces) the user's key for a provider. `error` = saved, but with a warning. */
export function saveKey(userId: number, provider: string, apiKey: string, baseUrl: string | null, error: string | null = null) {
  const now = Date.now();
  db.getDb()
    .prepare(
      `INSERT INTO llm_keys (user_id, provider, key_enc, key_hint, base_url, created_at, verified_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET key_enc = excluded.key_enc, key_hint = excluded.key_hint, base_url = excluded.base_url,
         created_at = excluded.created_at, verified_at = excluded.verified_at, last_error = excluded.last_error`,
    )
    .run(userId, provider, encryptSecret(apiKey, aad(userId, provider)), keyHint(apiKey), baseUrl, now, now, error);
  cache.delete(userId);
}

/** Removes the key and any model picks that used it. */
export function deleteKey(userId: number, provider: string): boolean {
  const removed = Number(db.getDb().prepare("DELETE FROM llm_keys WHERE user_id = ? AND provider = ?").run(userId, provider).changes) > 0;
  cache.delete(userId);
  const choices = modelChoices(userId);
  if (llmTiers.some((t) => choices[t]?.provider === provider)) {
    saveModelChoices(userId, Object.fromEntries(llmTiers.map((t) => [t, choices[t]?.provider === provider ? null : choices[t]])) as LlmModelChoices);
  }
  return removed;
}

/** Remembers why a key failed (rejected, out of credit) so Settings can show it. */
export function setKeyError(userId: number, provider: string, error: string | null) {
  db.getDb().prepare("UPDATE llm_keys SET last_error = ? WHERE user_id = ? AND provider = ?").run(error, userId, provider);
}

/** A call with the key just worked: clear a stale error. Cheap no-op when there was none. */
export function markKeyWorking(userId: number, provider: string) {
  db.getDb().prepare("UPDATE llm_keys SET last_error = NULL, verified_at = ? WHERE user_id = ? AND provider = ? AND last_error IS NOT NULL").run(Date.now(), userId, provider);
}

const choicesKey = (userId: number) => `llm-models:${userId}`;

export function modelChoices(userId: number): LlmModelChoices {
  const parsed = llmModelChoicesSchema.safeParse(db.getSetting(choicesKey(userId)) ?? {});
  return parsed.success ? parsed.data : { fast: null, smart: null, web: null };
}

export function saveModelChoices(userId: number, choices: LlmModelChoices) {
  db.setSetting(choicesKey(userId), choices);
}

/** Test hook. */
export function clearKeyCache() {
  cache.clear();
}
