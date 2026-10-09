import { AsyncLocalStorage } from "node:async_hooks";
import type { LlmFunding, LlmPurpose } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("usage");

export interface LlmContext {
  jobId?: number;
  collectionId?: number | null;
  /** Who the spend is billed to — and whose LLM keys are used (llm/resolve.ts). */
  userId?: number | null;
  /** Running USD total for whoever opened this context (e.g. one search request). */
  spent?: { cost: number };
}

const storage = new AsyncLocalStorage<LlmContext>();

/** Runs `fn` so every LLM call inside it is attributed to this job/collection/user. */
export function withLlmContext<T>(ctx: LlmContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentLlmContext(): LlmContext | undefined {
  return storage.getStore();
}

export interface CallUsage {
  provider: string;
  model: string;
  funding: LlmFunding;
  promptTokens: number;
  completionTokens: number;
  /** USD; null when unknown. */
  cost: number | null;
  /** Cost comes from the price list, not from the provider. */
  costEstimated: boolean;
  webSearches: number;
}

/**
 * Writes one ledger row for a completion. The single place every LLM cost passes through — prepaid credits
 * will debit platform-funded calls here. Never throws: spend tracking must not break a crawl.
 */
export function recordUsage(purpose: LlmPurpose, u: CallUsage) {
  const ctx = storage.getStore();
  if (ctx?.spent && u.cost) ctx.spent.cost += u.cost;
  try {
    db.recordLlmUsage({
      purpose,
      ...u,
      jobId: ctx?.jobId ?? null,
      collectionId: ctx?.collectionId ?? null,
      userId: ctx?.userId ?? null,
    });
  } catch (err) {
    log.warn("Could not record LLM usage", { error: String(err) });
  }
}
