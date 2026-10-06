import { AsyncLocalStorage } from "node:async_hooks";
import type { LlmPurpose } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("usage");

export interface LlmContext {
  jobId?: number;
  collectionId?: number | null;
  /** Who the spend is billed to. */
  userId?: number | null;
  /** Running USD total for whoever opened this context (e.g. one search request). */
  spent?: { cost: number };
}

const storage = new AsyncLocalStorage<LlmContext>();

/** Runs `fn` so every LLM call inside it is attributed to this job/collection. */
export function withLlmContext<T>(ctx: LlmContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  server_tool_use?: { web_search_requests?: number };
}

/** Writes one ledger row for a completion. Never throws — spend tracking must not break a crawl. */
export function recordUsage(purpose: LlmPurpose, model: string, usage: CompletionUsage | undefined, webSearches: number) {
  const ctx = storage.getStore();
  const cost = typeof usage?.cost === "number" ? usage.cost : null;
  if (ctx?.spent && cost) ctx.spent.cost += cost;
  try {
    db.recordLlmUsage({
      purpose,
      model,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      cost,
      webSearches,
      jobId: ctx?.jobId ?? null,
      collectionId: ctx?.collectionId ?? null,
      userId: ctx?.userId ?? null,
    });
  } catch (err) {
    log.warn("Could not record LLM usage", { error: String(err) });
  }
}
