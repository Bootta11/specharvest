import type { Page } from "puppeteer-core";
import type { CollectionDetection } from "../db/sqlite.ts";
import { gotoAndSettle } from "./browser.ts";
import { createLogger } from "../lib/logger.ts";

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
export async function collectItemCards(page: Page, detection: Pick<CollectionDetection, "listItemSelector" | "itemUrlPattern">): Promise<ItemCard[]> {
  const cards = await page.evaluate(
    (selector, pattern) => {
      const isReal = (href: string | null | undefined) => !!href && /^https?:/.test(href) && href !== location.href && !href.startsWith(location.href + "#");
      const textOf = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? "").slice(0, 1000);
      const out: Array<{ url: string; cardText: string }> = [];
      if (selector) {
        let els: Element[] = [];
        try {
          els = Array.from(document.querySelectorAll(selector));
        } catch {
          return [];
        }
        for (const card of els) {
          const self = card.tagName === "A" ? (card as HTMLAnchorElement).href : null;
          const url = isReal(self) ? self! : Array.from(card.querySelectorAll("a[href]")).map((x) => (x as HTMLAnchorElement).href).find(isReal);
          if (url) out.push({ url, cardText: textOf(card) });
        }
      } else if (pattern) {
        const re = new RegExp(pattern);
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
          if (a.closest("nav, header, footer")) continue;
          const href = (a as HTMLAnchorElement).href;
          if (isReal(href) && re.test(href)) out.push({ url: href, cardText: textOf(a.closest("li, article, [class*=card i], [class*=item i]") ?? a) });
        }
      }
      return out;
    },
    detection.listItemSelector || "",
    detection.itemUrlPattern || "",
  );
  const re = detection.itemUrlPattern ? new RegExp(detection.itemUrlPattern) : null;
  const byUrl = new Map<string, string>();
  for (const c of cards) {
    const url = normalizeItemUrl(c.url);
    if ((!re || re.test(url)) && !byUrl.has(url)) byUrl.set(url, c.cardText);
  }
  return [...byUrl].map(([url, cardText]) => ({ url, cardText }));
}

/** Item detail URLs on the current page (see collectItemCards). */
export async function collectItemUrls(page: Page, detection: Pick<CollectionDetection, "listItemSelector" | "itemUrlPattern">): Promise<string[]> {
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
  onPage: (pageNum: number, newUrls: string[], totalSoFar: number) => void;
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
export async function walkListing(page: Page, startUrl: string, d: CollectionDetection, opts: WalkOptions): Promise<WalkResult> {
  const items = new Map<string, string>();
  const take = (cards: ItemCard[]) => {
    const fresh = cards.filter((c) => !items.has(c.url));
    for (const c of fresh) {
      if (items.size >= opts.maxItems) break;
      items.set(c.url, c.cardText);
    }
    return fresh.map((c) => c.url);
  };
  const full = () => items.size >= opts.maxItems;
  const done = (complete: boolean): WalkResult => ({ items, complete: complete && !full() });

  await gotoAndSettle(page, startUrl);

  if (d.paginationType === "urlPage" && d.pageParam) {
    const startNum = Number(new URL(startUrl).searchParams.get(d.pageParam)) || 1;
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
      const fresh = take(await collectItemCards(page, d));
      opts.onPage(pageNum, fresh, items.size);
      if (fresh.length === 0) return done(true);
      if (full()) return done(false);
    }
    return done(false);
  }

  if (d.paginationType === "loadMore" || d.paginationType === "infiniteScroll") {
    for (let step = 1; step <= opts.maxPages; step++) {
      const fresh = take(await collectItemCards(page, d));
      opts.onPage(step, fresh, items.size);
      if (step > 1 && fresh.length === 0) return done(true);
      if (full()) return done(false);
      if (d.paginationType === "loadMore") {
        if (!d.loadMoreSelector) return done(true);
        const clicked = await page.click(d.loadMoreSelector).then(() => true, () => false);
        if (!clicked) return done(true);
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      }
      await page.waitForNetworkIdle({ idleTime: 700, timeout: 10_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
    }
    return done(false);
  }

  // "pages": follow the next link's href, or click a JS-only next button and wait for new items.
  for (let pageNum = 1; pageNum <= opts.maxPages; pageNum++) {
    const current = await collectItemCards(page, d);
    const fresh = take(current);
    opts.onPage(pageNum, fresh, items.size);
    if (pageNum > 1 && fresh.length === 0) return done(true);
    if (full() || pageNum === opts.maxPages) return done(false);
    if (!d.nextSelector) return done(true);

    const nextHref = await page
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return { found: false, href: null };
        const a = (el.tagName === "A" ? el : el.closest("a")) as HTMLAnchorElement | null;
        return { found: true, href: a?.href && /^https?:/.test(a.href) ? a.href : null };
      }, d.nextSelector)
      .catch(() => ({ found: false, href: null }));
    if (!nextHref.found) return done(true);

    if (nextHref.href) {
      await gotoAndSettle(page, nextHref.href);
    } else {
      await page.click(d.nextSelector).catch(() => {});
      const before = current.map((c) => c.url);
      const changed = await page
        .waitForFunction(
          (sel, prev) => {
            const hrefs = Array.from(document.querySelectorAll(sel)).map((c) => (c.tagName === "A" ? (c as HTMLAnchorElement).href : (c.querySelector("a[href]") as HTMLAnchorElement | null)?.href));
            return hrefs.some((h) => h && !prev.includes(h));
          },
          { timeout: 10_000 },
          d.listItemSelector,
          before,
        )
        .then(() => true, () => false);
      // Unclear whether that was the last page or a slow one — don't claim completeness.
      if (!changed) return done(false);
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5_000 }).catch(() => {});
    }
  }
  return done(false);
}
