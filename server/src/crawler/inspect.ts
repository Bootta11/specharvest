import type { InspectResult, PageKind, Runner } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { classifyPage } from "../llm/classify.ts";
import { withLlmContext } from "../llm/usage.ts";
import { createLogger } from "../lib/logger.ts";
import { gotoAndSettle, withPage, type WithPageOptions } from "./browser.ts";
import { collectItemUrls } from "./paginate.ts";

/**
 * The check before a crawl: is this URL a shop listing, a single item page, or something unrelated (news,
 * blog…)? Cheap signals first — what we already know about the site, then JSON-LD / OpenGraph — and one
 * small LLM call only when those don't settle it.
 */

const log = createLogger("inspect");

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; result: InspectResult }>();

/** What the page says about itself (gathered in the browser). */
export interface PageSignals {
  url: string;
  /** Every JSON-LD @type on the page. */
  ldTypes: string[];
  /** JSON-LD Product/Vehicle-like nodes (several = a listing's structured data). */
  productNodes: number;
  ogType: string | null;
  /** This URL matches the item-URL pattern already known for the site. */
  knownItemUrl: boolean;
  /** Item links the site's known listing structure finds on this page. */
  knownListingItems: number;
  /** A collection already crawls this URL as its listing. */
  knownListingUrl?: boolean;
}

const LISTING_MIN_CARDS = 10;
const ARTICLE_TYPES = /^(NewsArticle|Article|BlogPosting|Report|ReportageNewsArticle|AnalysisNewsArticle|OpinionNewsArticle|LiveBlogPosting|TechArticle)$/i;
const LISTING_TYPES = /^(ItemList|OfferCatalog|SearchResultsPage|CollectionPage)$/i;

/** A verdict from structured signals alone, or null when the LLM has to look. */
export function classify(s: PageSignals): { kind: PageKind; reason: string } | null {
  // A few matching cards can be an item page's "similar ads" strip; a real listing shows many.
  if (s.knownListingItems >= LISTING_MIN_CARDS) return { kind: "listing", reason: `Shows ${s.knownListingItems} items like this site's listings` };
  if (s.knownListingUrl && s.knownListingItems >= 1) return { kind: "listing", reason: "A listing page of this site" };
  if (s.knownItemUrl) return { kind: "item", reason: "Has the address of an item page on this site" };
  if (s.productNodes >= 2 || s.ldTypes.some((t) => LISTING_TYPES.test(t))) return { kind: "listing", reason: "The page describes itself as a list of products" };
  if (s.productNodes === 1 || s.ogType === "product" || s.ogType === "og:product") return { kind: "item", reason: "The page describes itself as one product" };
  if (s.ldTypes.some((t) => ARTICLE_TYPES.test(t)) || s.ogType === "article") return { kind: "other", reason: "Looks like an article, not a shop page" };
  return null;
}

export interface Crumb {
  name: string;
  url: string | null;
}

/**
 * The category an item page belongs to: the deepest breadcrumb with a link that isn't the page itself or the
 * site's home page, on the same site.
 */
export function categoryFromCrumbs(crumbs: Crumb[], pageUrl: string, pageTitle: string | null): { name: string; url: string } | null {
  const page = new URL(pageUrl);
  const same = (a: string, b: string) => a.replace(/[#?].*$/, "").replace(/\/+$/, "") === b.replace(/[#?].*$/, "").replace(/\/+$/, "");
  const title = pageTitle?.trim().toLowerCase();
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const { name, url } = crumbs[i];
    if (!url || !name.trim()) continue;
    let u: URL;
    try {
      u = new URL(url, page);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || u.hostname !== page.hostname || u.pathname === "/" || same(u.href, page.href)) continue;
    if (title && name.trim().toLowerCase() === title) continue;
    return { name: name.trim().slice(0, 200), url: u.href };
  }
  return null;
}

/** Checks a page. Cached per URL for a few minutes, so re-sharing or re-typing it doesn't load it again. */
export async function inspectUrl(url: string, userId: number | null, opts: { useProxy?: boolean; runner?: Runner } = {}): Promise<InspectResult> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  // A check must answer quickly: no waiting for the user to allow the site (the crawl itself asks).
  const pageOpts: WithPageOptions = opts.runner === "browser" ? { runner: "browser", userId, permissionWaitMs: 0 } : { useProxy: opts.useProxy };
  const result = await withLlmContext({ userId }, () => runInspect(url, pageOpts));
  cache.set(url, { at: Date.now(), result });
  for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  return result;
}

async function runInspect(url: string, opts: WithPageOptions): Promise<InspectResult> {
  const host = new URL(url).hostname;
  const known = db.findDetectionForHost(host, 0);
  // Someone is waiting on the crawl form: skip the queue of crawl pages.
  const page = await withPage(async (p) => {
    await gotoAndSettle(p, url);
    const knownListingItems = known ? (await collectItemUrls(p, known).catch(() => [])).length : 0;
    const facts = await p.run("pageSignals");
    return { ...facts, knownListingItems };
  }, { ...opts, priority: "interactive" });

  const knownItemUrl = !!known?.itemUrlPattern && new RegExp(known.itemUrlPattern).test(url);
  const knownListingUrl = db.isListingStartUrl(host, url);
  const signals: PageSignals = { url, ldTypes: page.ldTypes, productNodes: page.productNodes, ogType: page.ogType, knownItemUrl, knownListingItems: page.knownListingItems, knownListingUrl };
  const verdict = classify(signals) ?? (await classifyPage({ url, title: page.title, text: page.text, links: page.links, prices: page.prices }));
  const title = page.title?.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  log.info(`${url} → ${verdict.kind} (${verdict.reason})`);
  return {
    kind: verdict.kind,
    title,
    reason: verdict.reason,
    category: verdict.kind === "item" ? categoryFromCrumbs(page.crumbs, url, title) : null,
  };
}
