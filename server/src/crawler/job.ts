import PQueue from "p-queue";
import type { CrawlMode, CrawlRequest, Job, JobEvent, PageSnapshot, Runner, SpecValue } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { upsertVector } from "../db/lance.ts";
import { embed } from "../embedding.ts";
import { finishJobTiming, startJobTiming, timed } from "../lib/timing.ts";
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
import { prepareBrowserRunner } from "../extension/driver.ts";
import { BlockedPageError, BotWallError, gotoAndSettle, waitForStableText, withPage, type WithPageOptions } from "./browser.ts";
import { FatalDriverError } from "./driver.ts";
import { detectListingStructure } from "./detect.ts";
import { changedTokens, fingerprint, removedShare } from "./fingerprint.ts";
import { collectItemUrls, walkListing } from "./paginate.ts";
import { snapshotDetail, toDetailSnapshot, type DetailSnapshot, type OtherListingHints } from "./sanitize.ts";
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
async function loadDetail(url: string, pageOpts: WithPageOptions, hints: OtherListingHints) {
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

/** Where the crawl's time went (lib/timing.ts) — logged before its final status, while clients still listen. */
function logJobTiming(jobId: number) {
  const timing = finishJobTiming(jobId);
  if (timing) jobLog(jobId, timing);
}

/** Crawls running in this process, so they can be stopped. */
const running = new Map<number, AbortController>();

/**
 * Sites whose listing structure a server crawl is detecting right now. A crawl of the same site that starts
 * meanwhile waits for it and reuses the result, instead of paying for its own detection (or failing on a listing
 * too small to detect from).
 */
const detectingHosts = new Map<string, Promise<void>>();
const HOST_DETECTION_WAIT_MS = 120_000;

/** Waits (bounded) while another crawl detects `host`; then claims it if `claim`. Returns the claim's release. */
async function awaitHostDetection(host: string, jobId: number, signal: AbortSignal, claim: boolean): Promise<() => void> {
  const deadline = Date.now() + HOST_DETECTION_WAIT_MS;
  for (let pending = detectingHosts.get(host); pending && Date.now() < deadline && !signal.aborted; pending = detectingHosts.get(host)) {
    patchJob(jobId, { message: `Waiting for another crawl to learn the structure of ${host}` });
    jobLog(jobId, `Another crawl is detecting the listing structure of ${host} — waiting to reuse it`);
    let timer: NodeJS.Timeout | undefined;
    const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    await Promise.race([pending, aborted, new Promise((resolve) => (timer = setTimeout(resolve, deadline - Date.now())))]);
    clearTimeout(timer);
  }
  if (!claim || detectingHosts.has(host)) return () => {};
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  detectingHosts.set(host, mine);
  return () => {
    if (detectingHosts.get(host) === mine) detectingHosts.delete(host);
    done();
  };
}

/** Can't go on right now, but resuming later can: a dead LLM key, the user's browser gone, a bot wall. */
const pausesJob = (err: unknown) => llmBlocked(err) || err instanceof FatalDriverError || err instanceof BotWallError;

/**
 * Runs (or resumes) a crawl job in the background. `resumeSince` skips items the job already handled;
 * `snapshot` is the item page as the user's open tab showed it (add-item from the extension).
 */
function launch(jobId: number, collectionId: number, req: CrawlRequest, resumeSince?: number, snapshot?: PageSnapshot) {
  const controller = new AbortController();
  running.set(jobId, controller);
  const url = new URL(req.url).toString();
  const userId = db.getJob(jobId)?.userId ?? null;
  startJobTiming(jobId);
  withLlmContext({ jobId, collectionId, userId }, () => runCrawl(jobId, collectionId, url, req, controller.signal, resumeSince, snapshot))
    .catch((err) => {
      logJobTiming(jobId);
      if (err instanceof BotWallError) patchJob(jobId, { botWall: true });
      // A rejected / out-of-credit LLM key, a disconnected browser or a bot wall stops the crawl like the user
      // would: resumable once it's fixed.
      if (err instanceof StopError || pausesJob(err)) {
        // Stopped by the user while waiting on their browser: a plain stop, not a failure reason.
        const reason = err instanceof StopError ? err.reason : controller.signal.aborted ? undefined : err.message;
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
    .finally(() => {
      running.delete(jobId);
      finishJobTiming(jobId);
    });
}

/**
 * Creates (or reuses) the collection + a job and runs the crawl in the background.
 * `collectionId` re-crawls that collection (the caller checked write access); otherwise the user's own
 * collection for the URL is reused or a new one is made for them.
 * kind "item" adds the one item page at `url` to `collectionId`, or to a new collection of kind "items".
 */
export function startCrawl(req: CrawlRequest, userId: number | null, collectionId?: number): Job {
  const url = new URL(req.url).toString();
  const addItem = req.kind === "item";
  const existing = collectionId ? db.getCollection(collectionId) : addItem ? null : db.findCollectionByUrl(url, userId);
  if (existing) {
    const active = db.activeJobForCollection(existing.id, "crawl");
    if (active && addItem) throw httpError(409, `Crawl #${active.id} is running for "${existing.name}" — add the item when it finishes`);
    if (active) return active;
  }
  assertJobSlot(userId);
  const host = new URL(url).hostname;
  const name = req.name?.trim();
  const targetId = existing?.id ?? db.createCollection(name || host, url, host, userId, addItem ? "items" : "listing");
  if (existing && !addItem && name && name !== existing.name) db.renameCollection(existing.id, name);
  const runner: Runner = req.runner ?? "server";
  // Saved as the job's params (resume reuses them) — without the page snapshot, which is used once.
  const params: CrawlRequest = {
    url,
    maxPages: req.maxPages,
    maxItems: req.maxItems,
    useProxy: runner === "server" ? req.useProxy : undefined,
    mode: req.mode ?? (req.refresh ? "full" : "quick"),
    ...(addItem ? { kind: "item" as const } : {}),
    ...(runner === "browser" ? { runner } : {}),
  };
  const job = db.createJob("crawl", targetId, params, userId);
  emitJob(job);
  launch(job.id, targetId, params, undefined, addItem && runner === "browser" ? req.snapshot : undefined);
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

/**
 * Continues a stopped/interrupted crawl in the same job, skipping items it already handled. `runner` switches
 * whose browser loads the pages from here on (e.g. the user's own after a bot wall).
 */
export function resumeCrawl(jobId: number, runner?: Runner): Job {
  const job = db.getJob(jobId);
  let params = db.getJobParams<CrawlRequest>(jobId);
  if (!job || !job.resumable || !params || job.collectionId == null) throw new ResumeError("This job can't be resumed");
  if (runner && runner !== (params.runner ?? "server")) {
    params = { ...params, runner: runner === "browser" ? "browser" : undefined, useProxy: runner === "browser" ? undefined : params.useProxy };
    db.setJobParams(jobId, params);
  }
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

async function runCrawl(jobId: number, collectionId: number, url: string, req: CrawlRequest, signal: AbortSignal, resumeSince?: number, snapshot?: PageSnapshot) {
  const maxPages = req.maxPages ?? env.MAX_PAGES;
  const maxItems = req.maxItems ?? env.MAX_ITEMS;
  const target = db.getCollection(collectionId)!;
  const ownerId = db.getJob(jobId)?.userId ?? null;
  const inBrowser = req.runner === "browser";
  const pageOpts: WithPageOptions = inBrowser
    ? {
        runner: "browser",
        userId: ownerId,
        notice: (message) => {
          patchJob(jobId, { message });
          jobLog(jobId, message, "warn");
        },
        signal,
        origin: new URL(url).origin,
      }
    : { useProxy: !!req.useProxy };
  /** The add-item page as the user's tab showed it: read once instead of loading the page again. */
  const takeSnapshot = (itemUrl: string): DetailSnapshot | null => {
    if (!snapshot || snapshot.url.split("#")[0] !== itemUrl.split("#")[0]) return null;
    const s = toDetailSnapshot(snapshot);
    snapshot = undefined;
    return s;
  };
  // Adding one item is a single page someone is waiting for, so it skips the queue of crawl pages.
  const itemPageOpts: WithPageOptions = req.kind === "item" ? { ...pageOpts, priority: "interactive" } : pageOpts;
  const loadItem = async (itemUrl: string) => takeSnapshot(itemUrl) ?? loadDetail(itemUrl, itemPageOpts, hints);
  // No listing to walk: adding one item page, or re-checking a collection built from item pages.
  const addItem = req.kind === "item";
  const itemsOnly = !addItem && target.kind === "items";
  // Without a listing card to compare, a quick check would call everything unchanged — open the pages.
  const requested: CrawlMode = req.mode ?? (req.refresh ? "full" : "quick");
  const mode: CrawlMode = (addItem || itemsOnly) && requested === "quick" ? "deep" : requested;
  patchJob(jobId, { status: "running", message: addItem ? "Opening item page" : itemsOnly ? "Re-checking items" : "Opening listing page" });
  if (resumeSince) jobLog(jobId, "Resuming — skipping items already handled");
  if (inBrowser) {
    jobLog(jobId, "Pages load in your own browser (SpecHarvest extension)");
    await prepareBrowserRunner(ownerId, url, pageOpts);
    if (!snapshot) patchJob(jobId, { message: addItem ? "Opening item page in your browser" : itemsOnly ? "Re-checking items in your browser" : "Opening listing page in your browser" });
  }
  if (addItem) jobLog(jobId, `Adding item ${url} to "${target.name}"${req.useProxy ? " (via proxy)" : ""}`);
  else if (itemsOnly) jobLog(jobId, `Re-checking the ${target.itemCount} items of "${target.name}" (${mode} check${req.useProxy ? ", via proxy" : ""})`);
  else jobLog(jobId, `Crawling ${url} (max ${maxPages} pages, ${maxItems} items, ${mode} check${req.useProxy ? ", via proxy" : ""})`);

  // Detail pages open while the listing is still being walked: each listing page's cards are sorted
  // (new → extract; existing → change check, no LLM unless changed) and queued right away.
  const known = db.getItemFingerprints(collectionId);
  // Resumed: items extracted or seen since the job first started were handled before the stop.
  const handled = resumeSince ? db.urlsSeenSince(collectionId, resumeSince) : new Set<string>();
  /** Set once the listing structure is known, before the first card is queued. */
  let hints: OtherListingHints = { listItemSelector: "", itemUrlPattern: null };
  const hintsFor = (d: db.CollectionDetection): OtherListingHints => ({ listItemSelector: d.listItemSelector, itemUrlPattern: safeItemUrlPattern(d.itemUrlPattern) });
  let indexed = 0;
  let extracted = 0;
  let reused = 0;
  let changed = 0;
  let failed = 0;
  let unchanged = 0;
  let skipped = 0;
  let newCount = 0;
  let checkCount = 0;
  let byHand = 0;
  // The first extraction runs alone so it seeds the key registry: parallel workers starting from an empty
  // registry each invent their own names for the same specs. A collection that has keys starts at once.
  let seeding: Promise<void> | null = null;
  let seeded = db.listSpecKeys(collectionId).length > 0;
  const queue = new PQueue({ concurrency: env.SCRAPE_MAX_CONCURRENT_PAGES, autoStart: seeded });
  const emitQueue = () => emit(jobId, { type: "queue", size: queue.size, pending: queue.pending });

  // ---- Detail pages: render → (fingerprint) → LLM extract → store → embed ----
  const extractAndStore = async (itemUrl: string, snapshot: DetailSnapshot, cardHash: string) => {
    if (snapshot.text.length < 50) throw new Error("Page had almost no text");
    const contentHash = fingerprint(snapshot.stableText);
    // The same unchanged ad was already read in another collection: copy it instead of paying the LLM again
    // (a full re-crawl always re-extracts). Nothing about where it came from is stored or shown.
    const donor = mode === "full" ? null : db.findReusableExtraction(itemUrl, contentHash, collectionId, ownerId);
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
      manual: addItem || undefined,
      fromBrowser: inBrowser,
    });
    for (const s of extraction.specs) {
      db.upsertSpecKey(collectionId, { key: s.key, type: s.type, unit: s.unit, label: s.label, example: String(s.value).slice(0, 60), origin: "page" });
    }
    await upsertVector(itemId, collectionId, await timed("embed", () => embed(embeddingText({ ...extraction, specs }))));
    if (donor) reused++;
    else extracted++;
    emit(jobId, { type: "item", title: extraction.title, url: itemUrl });
  };

  /** Set when the LLM key or the user's browser stops working: every further item would fail the same way, so the rest is dropped. */
  let halt = null as Error | null;
  let botWall = false;

  const run = (fn: () => Promise<void>, itemUrl: string) => async () => {
    if (signal.aborted || halt) return;
    emitQueue();
    try {
      await fn();
      indexed++;
      patchJob(jobId, { itemsIndexed: indexed });
    } catch (err) {
      if (llmBlocked(err) || err instanceof FatalDriverError) {
        // Not this item's fault — it's picked up again on resume.
        halt ??= err;
        queue.clear();
        return;
      }
      if (err instanceof BotWallError && !botWall) {
        botWall = true;
        patchJob(jobId, { botWall: true });
      }
      failed++;
      patchJob(jobId, { itemsFailed: failed });
      jobLog(jobId, `Failed ${itemUrl}: ${errorMessage(err)}`, "warn");
    } finally {
      emitQueue();
    }
  };

  const extractNew = (t: { url: string; cardHash: string }) => run(async () => extractAndStore(t.url, await loadItem(t.url), t.cardHash), t.url);

  const check = (t: CheckTarget) =>
    run(async () => {
      let snapshot = await loadItem(t.url);
      // Lots of known text missing usually means the page hadn't finished rendering — look once more
      // rather than re-extracting (and overwriting good specs) from a partial page.
      if (t.fp.contentText && removedShare(t.fp.contentText, snapshot.stableText) > PARTIAL_RENDER_SHARE) {
        const retry = await loadDetail(t.url, itemPageOpts, hints);
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

  const enqueueNew = (t: { url: string; cardHash: string }) => {
    if (signal.aborted || halt) return;
    if (seeded || seeding) {
      void queue.add(extractNew(t));
      return;
    }
    seeding = extractNew(t)().finally(() => {
      seeded = true;
      if (!signal.aborted && !halt) queue.start();
    });
  };
  const enqueueCheck = (t: CheckTarget) => {
    if (signal.aborted || halt) return;
    checkCount++;
    void queue.add(check(t));
  };

  /** Sorts one walked card: new → extract; existing → change check (quick mode skips unchanged cards). */
  const classify = (itemUrl: string, cardText: string) => {
    if (handled.has(itemUrl)) {
      skipped++;
      indexed++;
      return;
    }
    const cardHash = fingerprint(cardText);
    const fp = known.get(itemUrl);
    if (!fp) {
      newCount++;
      enqueueNew({ url: itemUrl, cardHash });
    } else if (mode === "full") enqueueNew({ url: itemUrl, cardHash });
    // No card text (item pages without a listing): keep the stored card hash.
    else if (mode === "deep") enqueueCheck({ url: itemUrl, cardHash: cardText ? cardHash : (fp.cardHash ?? cardHash), fp });
    // Quick: a card we have never fingerprinted (rows from before change tracking) is adopted as the baseline.
    else if (fp.cardHash === null || fp.cardHash === cardHash) {
      db.touchItem(fp.id, { cardHash });
      unchanged++;
      indexed++;
    } else enqueueCheck({ url: itemUrl, cardHash, fp });
  };

  /** A walk without a listing (fixed item URLs): everything is known up front. */
  const queueFixed = (w: ReturnType<typeof fixedWalk>) => {
    hints = hintsFor(w.detection);
    patchJob(jobId, { itemsFound: w.items.size });
    for (const [itemUrl, cardText] of w.items) classify(itemUrl, cardText);
    return w;
  };

  // On stop, drop what hasn't started; pages already open finish and are saved.
  const onStop = () => {
    queue.clear();
    emitQueue();
  };
  signal.addEventListener("abort", onStop, { once: true });

  // ---- 1. Listing: detect (or reuse) structure, then walk pages (queuing cards as they're found) ----
  // Assigned in the try below, which rethrows on any failure.
  let walk!: { items: Map<string, string>; complete: boolean; detection: db.CollectionDetection };
  // Held while this crawl learns the site's listing structure (see detectingHosts).
  let releaseHost = () => {};
  try {
    throwIfStopped(signal);
    if (!addItem && !itemsOnly && !target.detection) {
      // Structures found in the user's browser aren't shared between collections, so only server crawls claim.
      releaseHost = await awaitHostDetection(target.host, jobId, signal, !inBrowser);
      throwIfStopped(signal);
    }
    // Detection and the walk go before item pages other crawls have queued: they produce the first results.
    walk = addItem || itemsOnly ? queueFixed(fixedWalk(target, addItem ? [url] : [...known.keys()])) : await withPage(async (page) => {
      // The user's browser hides crawl pages by default, and hidden pages don't scroll: check once per site.
      const scroll = await page.checkScrollLoading?.(url);
      if (scroll?.message) jobLog(jobId, scroll.message);
      const collection = db.getCollection(collectionId)!;
      let detection = collection.detection;
      if (detection) {
        await gotoAndSettle(page, url);
        const urls = await collectItemUrls(page, detection);
        // A structure already verified on this site may find a single card: a listing with one item.
        if (urls.length < 1) {
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
          if (urls.length >= 1) {
            detection = fromHost;
            db.saveDetection(collectionId, detection, inBrowser);
            jobLog(jobId, `Reusing the listing structure already known for ${collection.host} (${urls.length} items on page 1)`);
          }
        }
      }
      // A selector verified on a single card only is used for this crawl, but not saved.
      let save = true;
      if (!detection) {
        patchJob(jobId, { message: "Detecting item cards and pagination" });
        const result = await detectListingStructure(page, url, (m) => jobLog(jobId, m));
        detection = result.detection;
        save = result.verified;
        if (save) db.saveDetection(collectionId, detection, inBrowser);
        if (collection.name === collection.host) db.renameCollection(collectionId, collectionName(url, await page.run("pageInfo").then((i) => i.title, () => null)));
      }

      // The page itself showed it loads more on scroll; the LLM, reading one snapshot of it, often can't tell.
      if (scroll?.loadsOnScroll && detection.paginationType === "pages" && !detection.nextSelector) {
        detection = { ...detection, paginationType: "infiniteScroll" };
        if (save) db.saveDetection(collectionId, detection, inBrowser);
        jobLog(jobId, "Pagination: more items load as you scroll");
      }
      releaseHost();

      patchJob(jobId, { message: "Walking listing pages — indexing items as they're found" });
      hints = hintsFor(detection);
      const result = await walkListing(page, url, detection, {
        maxPages,
        maxItems,
        onPage: (pageNum, fresh, total) => {
          throwIfStopped(signal);
          if (halt) throw new StopError(halt.message);
          for (const card of fresh) classify(card.url, card.cardText);
          patchJob(jobId, { pagesSeen: pageNum, itemsFound: total, itemsIndexed: indexed });
          jobLog(jobId, `Listing page ${pageNum}: +${fresh.length} items (${total} total)`);
        },
        onNotice: (message, warn) => {
          patchJob(jobId, { message });
          jobLog(jobId, message, warn ? "warn" : "info");
        },
      });
      return { ...result, detection };
    }, { ...pageOpts, priority: "listing" });

    throwIfStopped(signal);
    if (walk.items.size === 0) throw new Error(itemsOnly ? "This collection has no items to re-check" : "No item links found on the listing page");

    // Hand-added items aren't on the listing: open their pages too (LLM only if they changed).
    if (!addItem && !itemsOnly) {
      for (const [itemUrl, fp] of known) {
        if (!fp.manual || walk.items.has(itemUrl) || handled.has(itemUrl)) continue;
        if (mode === "full") enqueueNew({ url: itemUrl, cardHash: fp.cardHash ?? "" });
        else enqueueCheck({ url: itemUrl, cardHash: fp.cardHash ?? "", fp });
        byHand++;
      }
    }
    if (resumeSince) jobLog(jobId, `Resuming — ${skipped} items already handled, ${walk.items.size - skipped} left`);
    patchJob(jobId, {
      itemsFound: walk.items.size,
      itemsIndexed: indexed,
      message: `${newCount} new, ${checkCount} to check, ${unchanged} unchanged`,
    });
    jobLog(
      jobId,
      mode === "full"
        ? `Re-extracting all ${walk.items.size - skipped + byHand} items`
        : addItem || itemsOnly
          ? `${newCount} new · ${checkCount} to re-check`
          : `${newCount} new · ${checkCount - byHand} to re-check (${mode === "deep" ? "every detail page" : "listing card changed"})${byHand ? ` · ${byHand} added by hand to re-check` : ""} · ${unchanged} unchanged (skipped)`,
    );

    // Nothing new to seed the registry with: start the checks.
    if (!seeded && !seeding) {
      seeded = true;
      queue.start();
    }
    await seeding;
    await queue.onIdle();
  } catch (err) {
    // Stopped or failed mid-walk: let pages already open finish (and be saved) before reporting.
    queue.clear();
    await seeding;
    await queue.onIdle();
    db.recountSpecKeys(collectionId);
    throw err;
  } finally {
    releaseHost();
    signal.removeEventListener("abort", onStop);
  }
  // An item already in the collection (e.g. from its listing) that didn't change is still "added by hand" now.
  if (addItem && !halt && failed === 0) db.setItemManual(collectionId, url);
  db.recountSpecKeys(collectionId);
  // Key merging and gone-marking need the whole listing handled — they run when the resumed crawl completes.
  if (halt) throw new StopError(halt.message);
  throwIfStopped(signal);
  if (extracted + reused > 0) await timed("consolidate", () => consolidateKeys(jobId, collectionId));
  if (extracted + reused > 0) await timed("group", () => groupProducts(jobId, collectionId));

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
  } else if (known.size > 0 && !addItem && !itemsOnly) {
    jobLog(jobId, "Listing walk stopped at a limit — not checking for removed items");
  }

  const summary = `${newCount} new, ${changed} changed, ${unchanged} unchanged, ${gone} gone, ${failed} failed${skipped ? `, ${skipped} handled before the stop` : ""}`;
  const status = indexed === 0 && walk.items.size > 0 ? "failed" : "done";
  logJobTiming(jobId);
  patchJob(jobId, {
    status,
    message: summary,
    error: status === "failed" ? "No items could be extracted" : null,
    finishedAt: Date.now(),
  });
  jobLog(jobId, `Done: ${summary} — ${extracted} LLM extractions${reused ? `, ${reused} ads reused from cache (no LLM call)` : ""}`);
  retireChannel(jobChannel(jobId));
}

type CheckTarget = { url: string; cardHash: string; fp: db.ItemFingerprint };

/** The "walk" of a collection without a listing: just these item URLs (no card text), never complete. */
function fixedWalk(collection: { host: string; id: number; detection: db.CollectionDetection | null }, urls: string[]) {
  // A known listing structure on this site helps strip "similar ads" from the item pages.
  const detection = collection.detection ?? db.findDetectionForHost(collection.host, collection.id);
  return {
    items: new Map(urls.map((u) => [u, ""])),
    complete: false,
    detection: detection ?? { listItemSelector: "", paginationType: "pages" as const, itemUrlPattern: null },
  };
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
