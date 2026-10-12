import type { CollectionDetection } from "../db/sqlite.ts";
import { gotoAndSettle } from "./browser.ts";
import { waitForScript, type PageDriver } from "./driver.ts";
import { createLogger } from "../lib/logger.ts";
import { safeItemUrlPattern } from "./url-pattern.ts";

const log = createLogger("paginate");

export interface ItemCard {
  url: string;
  /** Visible text of the listing card (title, price, short specs) — used to spot changes cheaply. */
  cardText: string;
}

/**
 * Item cards on the current page: for each element matching listItemSelector,
 * the card's own href (if it is an <a>) or its first real outbound link, plus
 * the card's text. Without a selector, every non-chrome link matching the URL
 * pattern (card text from its closest card-like container). Filtered by
 * itemUrlPattern (drops ads/promos inside the grid).
 */
export async function collectItemCards(page: PageDriver, detection: Pick<CollectionDetection, "listItemSelector" | "itemUrlPattern">): Promise<ItemCard[]> {
  // Compiled here and in the page for every link — only patterns that can't backtrack (crawler/url-pattern.ts).
  const pattern = safeItemUrlPattern(detection.itemUrlPattern);
  const cards = await page.run("collectCards", { selector: detection.listItemSelector || "", pattern: pattern || "" });
  const re = pattern ? new RegExp(pattern) : null;
  const byUrl = new Map<string, string>();
  for (const c of cards) {
    const url = normalizeItemUrl(c.url);
    if ((!re || re.test(url)) && !byUrl.has(url)) byUrl.set(url, c.cardText);
  }
  return [...byUrl].map(([url, cardText]) => ({ url, cardText }));
}

/** Item detail URLs on the current page (see collectItemCards). */
export async function collectItemUrls(page: PageDriver, detection: Pick<CollectionDetection, "listItemSelector" | "itemUrlPattern">): Promise<string[]> {
  return (await collectItemCards(page, detection)).map((c) => c.url);
}

/** Drops fragments and common tracking params so the same item dedupes across pages. */
export function normalizeItemUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_|sponsored|position|pos$|from$)/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function withPageParam(url: string, param: string, pageNum: number): string {
  const u = new URL(url);
  u.searchParams.set(param, String(pageNum));
  return u.toString();
}

export interface WalkOptions {
  maxPages: number;
  maxItems: number;
  /** Called after each listing page with the cards it added (within maxItems), so they can be processed at once. */
  onPage: (pageNum: number, added: ItemCard[], totalSoFar: number) => void;
  /** A line for the job log (e.g. the crawl tab moved to a visible window). */
  onNotice?: (message: string, warn: boolean) => void;
}

export interface WalkResult {
  /** Item URL → card text, in discovery order. */
  items: Map<string, string>;
  /**
   * True when the walk reached the natural end of the listing (empty page,
   * nothing new, no next control) rather than a limit or a load failure —
   * only then can missing items be treated as gone.
   */
  complete: boolean;
}

/**
 * Walks all listing pages from the page's current URL, returning deduped
 * item cards in discovery order. Stops on maxPages/maxItems, an empty page,
 * a page with nothing new, or a missing next control.
 */
export async function walkListing(page: PageDriver, startUrl: string, d: CollectionDetection, opts: WalkOptions): Promise<WalkResult> {
  const items = new Map<string, string>();
  const take = (cards: ItemCard[]) => {
    const added: ItemCard[] = [];
    for (const c of cards) {
      if (items.size >= opts.maxItems) break;
      if (items.has(c.url)) continue;
      items.set(c.url, c.cardText);
      added.push(c);
    }
    return added;
  };
  const full = () => items.size >= opts.maxItems;
  const done = (complete: boolean): WalkResult => ({ items, complete: complete && !full() });

  await gotoAndSettle(page, startUrl);

  if (d.paginationType === "urlPage" && d.pageParam) {
    const startNum = Number(new URL(startUrl).searchParams.get(d.pageParam)) || 1;
    let stale = 0;
    for (let i = 0; i < opts.maxPages; i++) {
      const pageNum = startNum + i;
      if (i > 0) {
        try {
          await gotoAndSettle(page, withPageParam(startUrl, d.pageParam, pageNum));
        } catch (err) {
          log.info(`Page ${pageNum} failed to load — treating as the end`, String(err));
          return done(false);
        }
      }
      const cards = await collectItemCards(page, d);
      const fresh = take(cards);
      opts.onPage(pageNum, fresh, items.size);
      if (cards.length === 0) return done(true);
      // Nothing new can just be overlap — scrolling an earlier page may have loaded this one's items already —
      // so only a second such page in a row ends the walk (sites past their last page repeat it).
      stale = fresh.length === 0 ? stale + 1 : 0;
      if (stale >= 2) return done(true);
      if (full()) return done(false);
    }
    return done(false);
  }

  if (d.paginationType === "loadMore" || d.paginationType === "infiniteScroll") {
    // A page that can't render can't scroll: an empty "next batch" then says nothing about the listing's end.
    let cantScroll = false;
    if (d.paginationType === "infiniteScroll") {
      const note = await page.ensureVisible?.("infiniteScroll");
      if (note) opts.onNotice?.(note.message, note.warn);
      cantScroll = !!note?.warn;
    }
    for (let step = 1; step <= opts.maxPages; step++) {
      const fresh = take(await collectItemCards(page, d));
      opts.onPage(step, fresh, items.size);
      if (step > 1 && fresh.length === 0) return done(!cantScroll);
      if (full()) return done(false);
      if (d.paginationType === "loadMore") {
        if (!d.loadMoreSelector) return done(true);
        const clicked = await page.click(d.loadMoreSelector).then(() => true, () => false);
        if (!clicked) return done(true);
      } else {
        await page.run("scrollToBottom");
      }
      await page.waitForNetworkIdle({ idleMs: 700, timeoutMs: 10_000 });
      await new Promise((r) => setTimeout(r, 800));
    }
    return done(false);
  }

  // "pages": follow the next link's href, or click a JS-only next button and wait for new items.
  let stale = 0;
  for (let pageNum = 1; pageNum <= opts.maxPages; pageNum++) {
    const current = await collectItemCards(page, d);
    const fresh = take(current);
    opts.onPage(pageNum, fresh, items.size);
    if (pageNum > 1 && current.length === 0) return done(true);
    // As above: one page of nothing new may be overlap; two in a row is the end.
    stale = pageNum > 1 && fresh.length === 0 ? stale + 1 : 0;
    if (stale >= 2) return done(true);
    if (full() || pageNum === opts.maxPages) return done(false);
    if (!d.nextSelector) return done(true);

    const nextHref = await page.run("nextControl", { selector: d.nextSelector }).catch(() => ({ found: false, href: null }));
    if (!nextHref.found) return done(true);

    if (nextHref.href) {
      await gotoAndSettle(page, nextHref.href);
    } else {
      await page.click(d.nextSelector).catch(() => {});
      const before = current.map((c) => c.url);
      const changed = await waitForScript(page, 10_000, "cardsChangedSince", { selector: d.listItemSelector, prev: before });
      // Unclear whether that was the last page or a slow one — don't claim completeness.
      if (!changed) return done(false);
      await page.waitForNetworkIdle({ idleMs: 500, timeoutMs: 5_000 });
    }
  }
  return done(false);
}
