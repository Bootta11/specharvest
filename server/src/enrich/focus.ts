import PQueue from "p-queue";
import { z } from "zod";
import type { Job, SpecKey, SpecValue } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { upsertVector } from "../db/lance.ts";
import { embed } from "../embedding.ts";
import { askForJson, llmBlocked } from "../llm/client.ts";
import { withLlmContext } from "../llm/usage.ts";
import { focusAnswerSchema, focusInstructions, focusSpecKey, normalizeSpecs, registryText, specSchema, toFocusAnswer } from "../llm/extract.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { assertAcceptingWork } from "../lib/shutdown.ts";
import { retireChannel } from "../sse/hub.ts";
import { assertJobSlot, embeddingText, emitJob, jobChannel, jobLog, patchJob } from "../crawler/job.ts";

const log = createLogger("focus");

const answerSchema = z.object({
  specs: z.array(specSchema).default([]),
  focus: focusAnswerSchema,
});

const SYSTEM = `You read a product listing page that was already turned into structured data once, and answer one question the user has about it. The page text may be in any language; keys and enumerated values must be in English.

Return ONLY one JSON object:
{
  "focus": { "match": true | false | null, "evidence": string | null },
  "specs": [ [key, value, unit, label], ... ]   // only the attributes that answer the question, one compact tuple per line
}

- Do not invent values that are not on the page; a fact stated only in the seller's free text still counts.
- Spec keys: English snake_case with a unit suffix for numbers (_km, _years, …); REUSE a registry key whenever the meaning matches. label = the original page label, only for keys not in the registry.
- Yes/no facts -> boolean; false only when the page explicitly says no.
- No phone numbers, emails, names or addresses anywhere in the answer.`;

/** One small LLM call: the stored page text against the focus. */
export async function checkFocus(rawText: string, focus: string, registry: SpecKey[]) {
  const user = `Spec key registry (reuse these keys):\n${registryText(registry)}\n\n${focusInstructions(focus)}\n\nPage text:\n${rawText}`;
  const { data } = await askForJson(answerSchema, SYSTEM, user, { purpose: "focus", maxTokens: 2000 });
  return { ...toFocusAnswer(data.focus), specs: normalizeSpecs(data.specs, registry) };
}

const runningJobs = new Map<number, { controller: AbortController; done: Promise<void> }>();
/** Jobs a shutdown stopped (rather than their user), for the message. */
const interrupted = new Set<number>();

/**
 * Checks the collection's saved items against its current focus (the ones not checked yet), from their stored page
 * text — no pages are loaded. Returns the running job when one is already checking this collection.
 */
export function startFocusCheck(collectionId: number, userId: number | null): Job {
  const active = db.activeJobForCollection(collectionId, "focus");
  if (active) return active;
  assertAcceptingWork();
  assertJobSlot(userId);
  const job = db.createJob("focus", collectionId, undefined, userId);
  const controller = new AbortController();
  emitJob(job);
  const done = withLlmContext({ jobId: job.id, collectionId, userId }, () => runFocusCheck(job.id, collectionId, controller.signal))
    .catch((err) => {
      patchJob(job.id, { status: "failed", error: errorMessage(err), finishedAt: Date.now() });
      jobLog(job.id, `Focus check failed: ${errorMessage(err)}`, "error");
    })
    .finally(() => {
      runningJobs.delete(job.id);
      interrupted.delete(job.id);
      retireChannel(jobChannel(job.id));
    });
  runningJobs.set(job.id, { controller, done });
  return job;
}

/** Asks a running focus check to stop: items not started are left for the next run, answers so far are kept. */
export function stopFocusCheck(jobId: number): Job | null {
  const controller = runningJobs.get(jobId)?.controller;
  if (!controller) return null;
  if (!controller.signal.aborted) {
    controller.abort();
    jobLog(jobId, "Stop requested — finishing items already running");
  }
  return patchJob(jobId, { message: "Stopping…" });
}

/** Shutdown: stops every focus check; each ends as stopped with its answers kept. Resolves once they have ended. */
export async function interruptFocusChecks(): Promise<void> {
  const jobs = [...runningJobs.entries()];
  for (const [id, { controller }] of jobs) {
    if (controller.signal.aborted) continue;
    interrupted.add(id);
    controller.abort();
    jobLog(id, "Server update — finishing items already running");
  }
  await Promise.allSettled(jobs.map(([, j]) => j.done));
}

/** Shutdown, after the drain: focus checks still running end as stopped. Database only. */
export function markUndrainedFocusChecks() {
  for (const id of runningJobs.keys()) db.updateJob(id, { status: "stopped", message: db.FOCUS_RESTART_MESSAGE, finishedAt: Date.now() });
}

async function runFocusCheck(jobId: number, collectionId: number, signal: AbortSignal) {
  const focus = db.collectionFocus(collectionId);
  if (!focus) throw new Error("This collection has no focus");
  const items = db.itemsPendingFocus(collectionId);
  patchJob(jobId, { status: "running", itemsFound: items.length, message: `Checking ${items.length} items for "${focus}"` });
  jobLog(jobId, `Checking ${items.length} saved items for "${focus}" — from their stored page text, no pages loaded`);

  let done = 0;
  let failed = 0;
  let matches = 0;
  let halt = null as Error | null;
  const queue = new PQueue({ concurrency: env.SCRAPE_MAX_CONCURRENT_PAGES });
  for (const item of items) {
    queue.add(async () => {
      if (halt || signal.aborted) return;
      try {
        const registry = db.listSpecKeys(collectionId);
        const answer = await checkFocus(item.rawText, focus, registry);
        // The focus changed while this item was being read: its answer is to the old question.
        if (db.collectionFocus(collectionId) !== focus) return;
        const specs: Record<string, SpecValue> = Object.fromEntries(answer.specs.map((s) => [s.key, s.value]));
        db.setItemFocus(item.id, focus, { match: answer.focusMatch, note: answer.focusNote, specs });
        for (const s of answer.specs) {
          db.upsertSpecKey(collectionId, { key: s.key, type: s.type, unit: s.unit, label: s.label, example: String(s.value).slice(0, 60), origin: "page" }, 0);
        }
        if (answer.focusMatch !== null) db.upsertSpecKey(collectionId, focusSpecKey(answer.focusMatch), 0);
        if (answer.focusMatch) matches++;
        const answerText = answer.focusMatch === null ? "not stated" : answer.focusMatch ? "matches" : "doesn't match";
        jobLog(jobId, `${item.title}: ${answerText}${answer.focusNote ? ` — "${answer.focusNote}"` : ""}`);
        const updated = db.getItemsByIds([item.id])[0];
        if (updated) await upsertVector(updated.id, collectionId, await embed(embeddingText(updated))).catch((err) => log.warn("re-embed failed", errorMessage(err)));
        done++;
      } catch (err) {
        if (llmBlocked(err)) {
          halt ??= err;
          queue.clear();
          return;
        }
        failed++;
        jobLog(jobId, `${item.title}: ${errorMessage(err)}`, "warn");
      } finally {
        patchJob(jobId, { itemsIndexed: done, itemsFailed: failed });
      }
    });
  }
  const onStop = () => queue.clear();
  if (signal.aborted) onStop();
  else signal.addEventListener("abort", onStop, { once: true });
  await queue.onIdle();
  signal.removeEventListener("abort", onStop);
  db.recountSpecKeys(collectionId);
  // Answers found before the key stopped working are kept; the job fails with what to fix.
  if (halt) throw halt;

  const summary = `${done} items checked, ${matches} match`;
  if (signal.aborted) {
    const left = items.length - done - failed;
    patchJob(jobId, {
      status: "stopped",
      itemsRemaining: left,
      message: `${interrupted.has(jobId) ? "Stopped by a server update" : "Stopped"} — ${summary}, ${left} not checked yet`,
      finishedAt: Date.now(),
    });
    jobLog(jobId, `Stopped: ${summary}, ${left} not checked yet`, "warn");
    return;
  }
  patchJob(jobId, { status: "done", message: `${summary}${failed ? `, ${failed} failed` : ""}`, finishedAt: Date.now() });
  jobLog(jobId, `Done: ${summary}, ${failed} failed`);
}
