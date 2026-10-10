import type { InspectResult, PageKind } from "@specharvest/shared";
import * as db from "../db/sqlite.ts";
import { classifyPage } from "../llm/classify.ts";
import { withLlmContext } from "../llm/usage.ts";
import { createLogger } from "../lib/logger.ts";
import { gotoAndSettle, withPage } from "./browser.ts";
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
}

const LISTING_MIN_CARDS = 10;
const ARTICLE_TYPES = /^(NewsArticle|Article|BlogPosting|Report|ReportageNewsArticle|AnalysisNewsArticle|OpinionNewsArticle|LiveBlogPosting|TechArticle)$/i;
const LISTING_TYPES = /^(ItemList|OfferCatalog|SearchResultsPage|CollectionPage)$/i;

/** A verdict from structured signals alone, or null when the LLM has to look. */
export function classify(s: PageSignals): { kind: PageKind; reason: string } | null {
  // A few matching cards can be an item page's "similar ads" strip; a real listing shows many.
  if (s.knownListingItems >= LISTING_MIN_CARDS) return { kind: "listing", reason: `Shows ${s.knownListingItems} items like this site's listings` };
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
export async function inspectUrl(url: string, userId: number | null, opts: { useProxy?: boolean } = {}): Promise<InspectResult> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = await withLlmContext({ userId }, () => runInspect(url, opts));
  cache.set(url, { at: Date.now(), result });
  for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  return result;
}

async function runInspect(url: string, opts: { useProxy?: boolean }): Promise<InspectResult> {
  const host = new URL(url).hostname;
  const known = db.findDetectionForHost(host, 0);
  const page = await withPage(async (p) => {
    await gotoAndSettle(p, url);
    const knownListingItems = known ? (await collectItemUrls(p, known).catch(() => [])).length : 0;
    const facts = await p.evaluate(() => {
      const ldTypes: string[] = [];
      let productNodes = 0;
      let productName: string | null = null;
      const crumbs: Array<{ name: string; url: string | null; position: number }> = [];
      const visit = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(visit);
        const o = node as Record<string, unknown>;
        if (o["@graph"]) visit(o["@graph"]);
        const types = (Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]]).filter((t): t is string => typeof t === "string");
        ldTypes.push(...types);
        if (types.some((t) => /^(Product|Vehicle|Car|IndividualProduct|ProductModel|Motorcycle)$/i.test(t))) {
          productNodes++;
          if (typeof o.name === "string") productName ??= o.name;
          // Not inside: a product's isRelatedTo / isSimilarTo products don't make its page a listing.
          return;
        }
        if (types.some((t) => /^BreadcrumbList$/i.test(t)) && Array.isArray(o.itemListElement)) {
          for (const el of o.itemListElement as Array<Record<string, unknown>>) {
            const item = el.item as Record<string, unknown> | string | undefined;
            const name = typeof el.name === "string" ? el.name : typeof item === "object" && typeof item?.name === "string" ? item.name : "";
            const href = typeof item === "string" ? item : typeof item?.["@id"] === "string" ? String(item["@id"]) : typeof item?.url === "string" ? String(item.url) : null;
            crumbs.push({ name, url: href, position: Number(el.position) || crumbs.length + 1 });
          }
          return;
        }
        // Lists of products (ItemList → ListItem → Product) count every product they hold.
        for (const v of Object.values(o)) if (v && typeof v === "object") visit(v);
      };
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try {
          visit(JSON.parse(s.textContent ?? ""));
        } catch {
          /* malformed JSON-LD */
        }
      }
      crumbs.sort((a, b) => a.position - b.position);
      if (crumbs.length === 0) {
        const trail = document.querySelector('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, [class*="breadcrumb" i]');
        for (const a of Array.from(trail?.querySelectorAll("a[href]") ?? [])) {
          crumbs.push({ name: (a.textContent ?? "").replace(/\s+/g, " ").trim(), url: (a as HTMLAnchorElement).href, position: crumbs.length + 1 });
        }
      }
      const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || null;
      const text = (document.querySelector("main") ?? document.body)?.innerText ?? "";
      return {
        ldTypes,
        productNodes,
        ogType: meta('meta[property="og:type"]')?.toLowerCase() ?? null,
        title: productName ?? meta('meta[property="og:title"]') ?? (document.title.trim() || null),
        crumbs,
        text: text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").slice(0, 5000),
        links: document.querySelectorAll("a[href]").length,
        prices: (text.match(/(?:[$€£]|\bKM\b|\bEUR\b|\bUSD\b|\bkn\b|\bRSD\b|\bdin\b)\s?\d|\d[\d.,\s]*\s?(?:[$€£]|KM|EUR|USD|kn|RSD|din)\b/gi) ?? []).length,
      };
    });
    return { ...facts, knownListingItems };
  }, opts);

  const knownItemUrl = !!known?.itemUrlPattern && new RegExp(known.itemUrlPattern).test(url);
  const signals: PageSignals = { url, ldTypes: page.ldTypes, productNodes: page.productNodes, ogType: page.ogType, knownItemUrl, knownListingItems: page.knownListingItems };
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
