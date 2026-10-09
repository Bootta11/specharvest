import PQueue from "p-queue";
import type { CrawlMode, CrawlRequest, Job, JobEvent, SpecValue } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { upsertVector } from "../db/lance.ts";
import { embed } from "../embedding.ts";
import { coerceToType, extractItem, type Extraction } from "../llm/extract.ts";
import { llmBlocked } from "../llm/client.ts";
import { proposeKeyMerges } from "../llm/consolidate.ts";
import { groupForCollection } from "../enrich/group.ts";
import { withLlmContext } from "../llm/usage.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { httpError } from "../lib/http-error.ts";
import { getUser } from "../auth/users.ts";
import { notifyJobFinished } from "../notify/index.ts";
import { publish, retireChannel, reviveChannel } from "../sse/hub.ts";
import { BlockedPageError, gotoAndSettle, waitForStableText, withPage } from "./browser.ts";
import { detectListingStructure } from "./detect.ts";
import { changedTokens, fingerprint, removedShare } from "./fingerprint.ts";
import { collectItemUrls, walkListing } from "./paginate.ts";
import { snapshotDetail, type DetailSnapshot, type OtherListingHints } from "./sanitize.ts";
import { safeItemUrlPattern } from "./url-pattern.ts";

const log = createLogger("job");

export const jobChannel = (jobId: number) => `job:${jobId}`;
/** Snapshots of every job (no logs) — feeds the UI's running-jobs panel. */
export const JOBS_CHANNEL = "jobs";

export function emitJob(job: Job) {
  publish(jobChannel(job.id), { type: "job", job });
  publish(JOBS_CHANNEL, { type: "job", job });
}

export function emit(jobId: number, event: JobEvent) {
  publish(jobChannel(jobId), event);
}

export function jobLog(jobId: number, message: string, level: "info" | "warn" | "error" = "info") {
  log[level](`job ${jobId}: ${message}`);
  emit(jobId, { type: "log", message, level });
}

/**
 * One user can't fill the shared browser and queue with their jobs: a non-admin may have at most
 * MAX_ACTIVE_JOBS_PER_USER crawls + web lookups queued or running. Throws 429 when that's reached.
 */
export function assertJobSlot(userId: number | null) {
  const max = env.MAX_ACTIVE_JOBS_PER_USER;
  if (userId === null || max <= 0 || getUser(userId)?.role === "admin") return;
  const running = db.countActiveJobs(userId);
  if (running >= max) throw httpError(429, `You already have ${running} job${running === 1 ? "" : "s"} running (at most ${max}) — wait for one to finish, or stop one.`);
}

export function patchJob(jobId: number, patch: Parameters<typeof db.updateJob>[1]): Job {
  const job = db.updateJob(jobId, patch);
  emitJob(job);
  if (patch.status === "done" || patch.status === "failed") void notifyJobFinished(job);
  return job;
}

export function embeddingText(item: { title: string; identity: string | null; description: string | null; specs: Record<string, SpecValue> }): string {
  const specs = Object.entries(item.specs)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "boolean" ? (v ? "yes" : "no") : v}`)
    .join("; ");
  return [item.title, item.identity, item.description, specs].filter(Boolean).join("\n");
}

function collectionName(url: string, pageTitle: string | null): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const t = pageTitle?.replace(/\s+/g, " ").trim();
  return t ? `${host} — ${t.slice(0, 80)}` : host;
}

/**
 * Renders a detail page. A bot challenge mid-crawl is usually rate limiting,
 * so back off and retry a couple of times before giving up on the item.
 */
async function loadDetail(url: string, pageOpts: { useProxy: boolean }, hints: OtherListingHints) {
  const delays = [8_000, 20_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await withPage(async (page) => {
        await gotoAndSettle(page, url);
        await waitForStableText(page);
        return snapshotDetail(page, hints);
      }, pageOpts);
    } catch (err) {
      if (!(err instanceof BlockedPageError) || attempt >= delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt] + Math.random() * 3000));
    }
  }
}

/** Thrown at a checkpoint once the user stopped the crawl — or with a `reason` when it can't go on (LLM key rejected). */
class StopError extends Error {
  constructor(readonly reason?: string) {
    super(reason ?? "Stopped");
  }
}

function throwIfStopped(signal: AbortSignal) {
  if (signal.aborted) throw new StopError();
}

/** Crawls running in this process, so they can be stopped. */
const running = new Map<number, AbortController>();

/** Runs (or resumes) a crawl job in the background. `resumeSince` skips items the job already handled. */
function launch(jobId: number, collectionId: number, req: CrawlRequest, resumeSince?: number) {
  const controller = new AbortController();
  running.set(jobId, controller);
  const url = new URL(req.url).toString();
  const userId = db.getJob(jobId)?.userId ?? null;
  withLlmContext({ jobId, collectionId, userId }, () => runCrawl(jobId, collectionId, url, req, controller.signal, resumeSince))
    .catch((err) => {
      // A rejected / out-of-credit LLM key stops the crawl like the user would: resumable once it's fixed.
      if (err instanceof StopError || llmBlocked(err)) {
        const reason = err instanceof StopError ? err.reason : err.message;
        const job = db.getJob(jobId)!;
        const handled = `${job.itemsIndexed} of ${job.itemsFound || "?"} items handled`;
        const summary = reason ? `Stopped: ${reason} (${handled})` : `Stopped — ${handled}`;
        patchJob(jobId, { status: "stopped", message: summary, error: null, finishedAt: Date.now() });
        jobLog(jobId, reason ? `${summary}. Resume once it's fixed.` : `${summary}. Resume to continue where it left off.`, "warn");
      } else {
        patchJob(jobId, { status: "failed", error: errorMessage(err), finishedAt: Date.now() });
        jobLog(jobId, `Crawl failed: ${errorMessage(err)}`, "error");
      }
      retireChannel(jobChannel(jobId));
    })
    .finally(() => running.delete(jobId));
}

/**
 * Creates (or reuses) the collection + a job and runs the crawl in the background.
 * `collectionId` re-crawls that collection (the caller checked write access); otherwise the user's own
 * collection for the URL is reused or a new one is made for them.
 */
export function startCrawl(req: CrawlRequest, userId: number | null, collectionId?: number): Job {
  const url = new URL(req.url).toString();
  const existing = collectionId ? db.getCollection(collectionId) : db.findCollectionByUrl(url, userId);
  if (existing) {
    const active = db.activeJobForCollection(existing.id, "crawl");
    if (active) return active;
  }
  assertJobSlot(userId);
  const host = new URL(url).hostname;
  const name = req.name?.trim();
  const targetId = existing?.id ?? db.createCollection(name || host, url, host, userId);
  if (existing && name && name !== existing.name) db.renameCollection(existing.id, name);
  const params: CrawlRequest = {
    url,
    maxPages: req.maxPages,
    maxItems: req.maxItems,
    useProxy: req.useProxy,
    mode: req.mode ?? (req.refresh ? "full" : "quick"),
  };
  const job = db.createJob("crawl", targetId, params, userId);
  emitJob(job);
  launch(job.id, targetId, params);
  return job;
}

/** Asks a running crawl to stop; in-flight pages finish first. False if it isn't running here. */
export function stopCrawl(jobId: number): Job | null {
  const controller = running.get(jobId);
  if (!controller) return null;
  if (!controller.signal.aborted) {
    controller.abort();
    jobLog(jobId, "Stop requested — finishing pages already open");
  }
  return patchJob(jobId, { message: "Stopping…" });
}

export class ResumeError extends Error {}

/** Continues a stopped/interrupted crawl in the same job, skipping items it already handled. */
export function resumeCrawl(jobId: number): Job {
  const job = db.getJob(jobId);
  const params = db.getJobParams<CrawlRequest>(jobId);
  if (!job || !job.resumable || !params || job.collectionId == null) throw new ResumeError("This job can't be resumed");
  const active = db.activeJobForCollection(job.collectionId, "crawl");
  if (active) throw new ResumeError(`Crawl #${active.id} is already running for this collection`);
  assertJobSlot(job.userId);
  reviveChannel(jobChannel(jobId));
  const resumed = patchJob(jobId, { status: "running", error: null, finishedAt: null, itemsFailed: 0, message: "Resuming" });
  launch(jobId, job.collectionId, params, job.startedAt);
  return resumed;
}

/** A walk that would mark more than this share of a collection as gone is treated as a glitch. */
const MAX_GONE_SHARE = 0.5;
/** A re-check missing more than this share of the item's known words is reloaded once before trusting it. */
const PARTIAL_RENDER_SHARE = 0.1;
/** Still missing more than this after the reload: keep the saved data instead of re-extracting from a partial page. */
const PARTIAL_RENDER_REJECT_SHARE = 0.3;

async function runCrawl(jobId: number, collectionId: number, url: string, req: CrawlRequest, signal: AbortSignal, resumeSince?: number) {
  const maxPages = req.maxPages ?? env.MAX_PAGES;
  const maxItems = req.maxItems ?? env.MAX_ITEMS;
  const mode: CrawlMode = req.mode ?? (req.refresh ? "full" : "quick");
  const pageOpts = { useProxy: !!req.useProxy };
  patchJob(jobId, { status: "running", message: "Opening listing page" });
  if (resumeSince) jobLog(jobId, "Resuming — walking the listing again, then skipping items already handled");
  jobLog(jobId, `Crawling ${url} (max ${maxPages} pages, ${maxItems} items, ${mode} check${req.useProxy ? ", via proxy" : ""})`);

  // ---- 1. Listing: detect (or reuse) structure, then walk pages ----
  throwIfStopped(signal);
  const walk = await withPage(async (page) => {
    const collection = db.getCollection(collectionId)!;
    let detection = collection.detection;
    if (detection) {
      await gotoAndSettle(page, url);
      const urls = await collectItemUrls(page, detection);
      if (urls.length < 2) {
        jobLog(jobId, "Saved selectors no longer match — re-detecting", "warn");
        detection = null;
      } else {
        jobLog(jobId, `Reusing saved listing structure (${urls.length} items on page 1)`);
      }
    }
    if (!detection) {
      // Another collection on the same site (anyone's) already taught us its cards and pagination.
      const fromHost = db.findDetectionForHost(collection.host, collectionId);
      if (fromHost) {
        await gotoAndSettle(page, url);
        const urls = await collectItemUrls(page, fromHost);
        if (urls.length >= 2) {
          detection = fromHost;
          db.saveDetection(collectionId, detection);
          jobLog(jobId, `Reusing the listing structure already known for ${collection.host} (${urls.length} items on page 1)`);
        }
      }
    }
    if (!detection) {
      patchJob(jobId, { message: "Detecting item cards and pagination" });
      const result = await detectListingStructure(page, url, (m) => jobLog(jobId, m));
      detection = result.detection;
      db.saveDetection(collectionId, detection);
      if (collection.name === collection.host) db.renameCollection(collectionId, collectionName(url, await page.title().catch(() => null)));
    }

    patchJob(jobId, { message: "Walking listing pages" });
    const result = await walkListing(page, url, detection, {
      maxPages,
      maxItems,
      onPage: (pageNum, fresh, total) => {
        throwIfStopped(signal);
        patchJob(jobId, { pagesSeen: pageNum, itemsFound: total });
        jobLog(jobId, `Listing page ${pageNum}: +${fresh.length} items (${total} total)`);
      },
    });
    return { ...result, detection };
  }, pageOpts);

  throwIfStopped(signal);
  if (walk.items.size === 0) throw new Error("No item links found on the listing page");
  const hints: OtherListingHints = { listItemSelector: walk.detection.listItemSelector, itemUrlPattern: safeItemUrlPattern(walk.detection.itemUrlPattern) };

  // ---- 2. Sort walked items: new → extract; existing → change check (no LLM unless changed) ----
  const known = db.getItemFingerprints(collectionId);
  // Resumed: items extracted or seen since the job first started were handled before the stop.
  const handled = resumeSince ? db.urlsSeenSince(collectionId, resumeSince) : new Set<string>();
  const toExtract: Array<{ url: string; cardHash: string }> = [];
  const toCheck: Array<{ url: string; cardHash: string; fp: db.ItemFingerprint }> = [];
  let unchanged = 0;
  let skipped = 0;
  for (const [itemUrl, cardText] of walk.items) {
    if (handled.has(itemUrl)) {
      skipped++;
      continue;
    }
    const cardHash = fingerprint(cardText);
    const fp = known.get(itemUrl);
    if (!fp) toExtract.push({ url: itemUrl, cardHash });
    else if (mode === "full") toExtract.push({ url: itemUrl, cardHash });
    else if (mode === "deep") toCheck.push({ url: itemUrl, cardHash, fp });
    // Quick: a card we have never fingerprinted (rows from before change tracking) is adopted as the baseline.
    else if (fp.cardHash === null || fp.cardHash === cardHash) {
      db.touchItem(fp.id, { cardHash });
      unchanged++;
    } else toCheck.push({ url: itemUrl, cardHash, fp });
  }
  const newCount = toExtract.filter((t) => !known.has(t.url)).length;
  if (resumeSince) jobLog(jobId, `Resuming — ${skipped} items already handled, ${walk.items.size - skipped} left`);
  patchJob(jobId, {
    itemsFound: walk.items.size,
    itemsIndexed: unchanged + skipped,
    message: `${newCount} new, ${toCheck.length} to check, ${unchanged} unchanged`,
  });
  jobLog(
    jobId,
    mode === "full"
      ? `Re-extracting all ${toExtract.length} items`
      : `${newCount} new · ${toCheck.length} to re-check (${mode === "deep" ? "every detail page" : "listing card changed"}) · ${unchanged} unchanged (skipped)`,
  );

  // ---- 3. Detail pages: render → (fingerprint) → LLM extract → store → embed ----
  let indexed = unchanged + skipped;
  let extracted = 0;
  let reused = 0;
  let changed = 0;
  let failed = 0;
  const queue = new PQueue({ concurrency: env.SCRAPE_MAX_CONCURRENT_PAGES });
  const emitQueue = () => emit(jobId, { type: "queue", size: queue.size, pending: queue.pending });

  const extractAndStore = async (itemUrl: string, snapshot: DetailSnapshot, cardHash: string) => {
    if (snapshot.text.length < 50) throw new Error("Page had almost no text");
    const contentHash = fingerprint(snapshot.stableText);
    // The same unchanged ad was already read in another collection: copy it instead of paying the LLM again
    // (a full re-crawl always re-extracts). Nothing about where it came from is stored or shown.
    const donor = mode === "full" ? null : db.findReusableExtraction(itemUrl, contentHash, collectionId);
    const extraction = donor ? adoptExtraction(donor, db.listSpecKeys(collectionId)) : await extractItem(snapshot, db.listSpecKeys(collectionId));
    const specs: Record<string, SpecValue> = Object.fromEntries(extraction.specs.map((s) => [s.key, s.value]));
    const itemId = db.upsertItem({
      collectionId,
      url: itemUrl,
      title: extraction.title,
      price: extraction.price,
      currency: extraction.currency,
      mainImage: extraction.mainImage,
      description: extraction.description,
      identity: extraction.identity,
      specs,
      rawText: snapshot.text,
      cardHash,
      contentHash,
      contentText: snapshot.stableText,
    });
    for (const s of extraction.specs) {
      db.upsertSpecKey(collectionId, { key: s.key, type: s.type, unit: s.unit, label: s.label, example: String(s.value).slice(0, 60), origin: "page" });
    }
    await upsertVector(itemId, collectionId, await embed(embeddingText({ ...extraction, specs })));
    if (donor) reused++;
    else extracted++;
    emit(jobId, { type: "item", title: extraction.title, url: itemUrl });
  };

  /** Set when the LLM key stops working: every further item would fail the same way, so the rest is dropped. */
  let halt = null as Error | null;

  const run = (fn: () => Promise<void>, itemUrl: string) => async () => {
    if (signal.aborted || halt) return;
    emitQueue();
    try {
      await fn();
      indexed++;
      patchJob(jobId, { itemsIndexed: indexed });
    } catch (err) {
      if (llmBlocked(err)) {
        // Not this item's fault — it's picked up again on resume.
        halt ??= err;
        queue.clear();
        return;
      }
      failed++;
      patchJob(jobId, { itemsFailed: failed });
      jobLog(jobId, `Failed ${itemUrl}: ${errorMessage(err)}`, "warn");
    } finally {
      emitQueue();
    }
  };

  const extractNew = (t: { url: string; cardHash: string }) => run(async () => extractAndStore(t.url, await loadDetail(t.url, pageOpts, hints), t.cardHash), t.url);

  const check = (t: (typeof toCheck)[number]) =>
    run(async () => {
      let snapshot = await loadDetail(t.url, pageOpts, hints);
      // Lots of known text missing usually means the page hadn't finished rendering — look once more
      // rather than re-extracting (and overwriting good specs) from a partial page.
      if (t.fp.contentText && removedShare(t.fp.contentText, snapshot.stableText) > PARTIAL_RENDER_SHARE) {
        const retry = await loadDetail(t.url, pageOpts, hints);
        if (removedShare(t.fp.contentText, retry.stableText) < removedShare(t.fp.contentText, snapshot.stableText)) snapshot = retry;
        const lost = removedShare(t.fp.contentText, snapshot.stableText);
        if (lost > PARTIAL_RENDER_REJECT_SHARE) {
          throw new Error(`page looks partially rendered (${Math.round(lost * 100)}% of its known text missing twice) — kept the saved data`);
        }
      }
      const contentHash = fingerprint(snapshot.stableText);
      // Rows from before change tracking have no content hash. A deep check adopts this visit as the
      // baseline; a quick check only got here because the card changed, so that counts as a change.
      if (t.fp.contentHash === contentHash || (t.fp.contentHash === null && mode === "deep")) {
        db.touchItem(t.fp.id, { cardHash: t.cardHash, contentHash, contentText: snapshot.stableText, checked: true });
        unchanged++;
        return;
      }
      changed++;
      const diff = t.fp.contentText ? changedTokens(t.fp.contentText, snapshot.stableText) : [];
      jobLog(jobId, `Changed: ${t.url}${diff.length ? ` (${diff.join(" | ")})` : ""} — re-extracting`);
      await extractAndStore(t.url, snapshot, t.cardHash);
    }, t.url);

  // The first extraction runs alone so it seeds the key registry; parallel workers
  // starting from an empty registry each invent their own names for the same specs.
  // On stop, drop what hasn't started; pages already open finish and are saved.
  const onStop = () => {
    queue.clear();
    emitQueue();
  };
  signal.addEventListener("abort", onStop, { once: true });
  const [first, ...rest] = toExtract;
  if (first) await extractNew(first)();
  if (!signal.aborted && !halt) {
    for (const t of rest) queue.add(extractNew(t));
    for (const t of toCheck) queue.add(check(t));
  }
  await queue.onIdle();
  signal.removeEventListener("abort", onStop);
  db.recountSpecKeys(collectionId);
  // Key merging and gone-marking need the whole listing handled — they run when the resumed crawl completes.
  if (halt) throw new StopError(halt.message);
  throwIfStopped(signal);
  if (extracted + reused > 0) await consolidateKeys(jobId, collectionId);
  if (extracted + reused > 0) await groupProducts(jobId, collectionId);

  // ---- 4. Listings missing from a complete walk are gone (sold/removed) ----
  let gone = 0;
  if (walk.complete) {
    const active = [...known.values()].filter((f) => f.goneAt === null).length;
    const missing = [...known.keys()].filter((u) => !walk.items.has(u) && known.get(u)!.goneAt === null).length;
    if (missing > 0 && active >= 4 && missing / active > MAX_GONE_SHARE) {
      jobLog(jobId, `${missing} of ${active} saved items were not on the listing — too many to trust, not marking them gone`, "warn");
    } else {
      gone = db.markGone(collectionId, walk.items.keys());
      if (gone) jobLog(jobId, `${gone} items are no longer listed — marked as gone`);
    }
  } else if (known.size > 0) {
    jobLog(jobId, "Listing walk stopped at a limit — not checking for removed items");
  }

  const summary = `${newCount} new, ${changed} changed, ${unchanged} unchanged, ${gone} gone, ${failed} failed${skipped ? `, ${skipped} handled before the stop` : ""}`;
  const status = indexed === 0 && walk.items.size > 0 ? "failed" : "done";
  patchJob(jobId, {
    status,
    message: summary,
    error: status === "failed" ? "No items could be extracted" : null,
    finishedAt: Date.now(),
  });
  jobLog(jobId, `Done: ${summary} — ${extracted} LLM extractions${reused ? `, ${reused} ads reused from cache (no LLM call)` : ""}`);
  retireChannel(jobChannel(jobId));
}

/**
 * An extraction copied from the same ad in another collection, fitted to this collection's registry:
 * a donor key this registry knows under a synonym takes the registry's name, values take its type.
 */
function adoptExtraction(donor: db.ReusableExtraction, registry: ReturnType<typeof db.listSpecKeys>): Extraction {
  const byKey = new Map(registry.map((k) => [k.key, k]));
  const specs: Extraction["specs"] = [];
  for (const s of donor.specs) {
    const key = byKey.has(s.key) ? s.key : (db.keyAliasesOf(s.key).find((k) => byKey.has(k)) ?? s.key);
    const known = byKey.get(key);
    const value = coerceToType(s.value, known?.type ?? s.type);
    if (value === null || specs.some((x) => x.key === key)) continue;
    specs.push({ key, value, type: known?.type ?? s.type, unit: known?.unit ?? s.unit, label: s.label });
  }
  return { title: donor.title, price: donor.price, currency: donor.currency, mainImage: donor.mainImage, description: donor.description, identity: donor.identity, specs };
}

/**
 * Groups name variants of the same product (LLM only for names never grouped before), per the collection's
 * grouping mode — loose also merges single-candidate possible matches. Non-fatal.
 */
export async function groupProducts(jobId: number, collectionId: number) {
  try {
    patchJob(jobId, { message: "Grouping product names" });
    const { merges, calls, loose } = await groupForCollection(collectionId, db.listItems(collectionId, 5000, 0, true));
    if (calls > 0) {
      jobLog(jobId, `Grouped product names: ${merges.length} variant${merges.length === 1 ? "" : "s"} merged into the same product`);
      for (const m of merges) jobLog(jobId, `Same product: "${m.from}" → "${m.to}"`);
    }
    for (const m of loose) jobLog(jobId, `Same product (loose): "${m.from}" → "${m.to}"`);
  } catch (err) {
    jobLog(jobId, `Product grouping skipped: ${errorMessage(err)}`, "warn");
  }
}

/** LLM pass that merges synonym keys (e.g. engine_power_kw → engine_kw, hp → kW). Non-fatal. */
export async function consolidateKeys(jobId: number, collectionId: number) {
  try {
    patchJob(jobId, { message: "Merging duplicate spec keys" });
    const merges = await proposeKeyMerges(db.listSpecKeys(collectionId));
    if (merges.length === 0) return;
    const moved = db.applyKeyMerges(collectionId, merges);
    jobLog(jobId, `Merged ${merges.length} duplicate keys (${moved} values moved): ${merges.map((m) => `${m.from}→${m.to}${m.factor !== 1 ? ` ×${m.factor}` : ""}`).join(", ")}`);
  } catch (err) {
    jobLog(jobId, `Key consolidation skipped: ${errorMessage(err)}`, "warn");
  }
}
