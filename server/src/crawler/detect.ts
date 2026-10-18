import type { CollectionDetection } from "../db/sqlite.ts";
import { detectListing } from "../llm/detect.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { gotoAndSettle } from "./browser.ts";
import type { PageDriver } from "./driver.ts";
import { collectItemUrls, withPageParam } from "./paginate.ts";
import { findRepeatedClassNames, sanitizeForLlm } from "./sanitize.ts";

const log = createLogger("detect");

const MIN_ITEMS = 2;
const PAGE_PARAM_CANDIDATES = ["page", "p", "pg", "paged", "strana", "stranica", "pageNumber", "pagenum", "seite", "pagina"];

/**
 * Regex for the dominant URL shape among item URLs: the deepest directory prefix ≥ 80% of them share
 * (e.g. ^https://olx\.ba/artikal/, ^https://shop\.example/catalog/product/), or null if there is no clear one.
 * The deepest one, so it doesn't also match the site's listing pages (/catalog/phones).
 */
export function inferItemUrlPattern(urls: string[]): string | null {
  if (urls.length < 3) return null;
  const parsed = urls.flatMap((u) => {
    try {
      const url = new URL(u);
      return [{ origin: url.origin, segs: url.pathname.split("/").filter(Boolean) }];
    } catch {
      return [];
    }
  });
  let best: string | null = null;
  for (let depth = 1; ; depth++) {
    // Directory prefixes only: the item's own last segment (its slug or id) never counts.
    const counts = new Map<string, number>();
    for (const p of parsed) {
      if (p.segs.length <= depth) continue;
      const key = `${p.origin}/${p.segs.slice(0, depth).join("/")}/`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const [key, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (!key || n / urls.length < 0.8 || key.split("/").some((seg) => seg.endsWith("."))) break;
    best = key;
  }
  return best ? "^" + escapeRe(best) : inferSlugWordPattern(urls);
}

/**
 * A saved item-URL pattern made stricter from the item URLs a walk found, when one fits them all — patterns saved
 * before inferItemUrlPattern looked past the first path segment also matched listing pages. Null to keep it.
 */
export function tighterItemUrlPattern(current: string | null | undefined, urls: string[]): string | null {
  if (!current) return null;
  const next = inferItemUrlPattern(urls);
  if (!next || next === current || !next.startsWith(current)) return null;
  const re = new RegExp(next);
  return urls.every((u) => re.test(u)) ? next : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Items whose URLs share no path prefix but a word in the slug — e.g. tehnomag.com/<name>-proizvod-9357/ next
 * to /blog/… and filter links: the same path depth, and a `-word-` in the last segment of ≥80% of them.
 */
function inferSlugWordPattern(urls: string[]): string | null {
  const parsed = urls.flatMap((u) => {
    try {
      const url = new URL(u);
      return [{ origin: url.origin, segs: url.pathname.split("/").filter(Boolean) }];
    } catch {
      return [];
    }
  });
  const byShape = new Map<string, typeof parsed>();
  for (const p of parsed) if (p.segs.length) (byShape.get(`${p.origin} ${p.segs.length}`) ?? byShape.set(`${p.origin} ${p.segs.length}`, []).get(`${p.origin} ${p.segs.length}`)!).push(p);
  const group = [...byShape.values()].sort((a, b) => b.length - a.length)[0];
  if (!group || group.length / urls.length < 0.8) return null;
  // Words inside the last segment (not its first or last word, which are the name and the id).
  const words = new Map<string, number>();
  for (const p of group) {
    const inner = new Set(p.segs.at(-1)!.toLowerCase().split("-").slice(1, -1));
    for (const w of inner) if (/^[a-z]{3,}$/.test(w)) words.set(w, (words.get(w) ?? 0) + 1);
  }
  const [word, n] = [...words.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0] ?? [null, 0];
  if (!word || n / urls.length < 0.8) return null;
  const { origin, segs } = group[0]!;
  return `^${escapeRe(origin)}/${"[^/?#]+/".repeat(segs.length - 1)}[^/?#]+-${word}-[^/?#]+(?:[/?#]|$)`;
}

/**
 * Fallback when the LLM can't find a working card selector: the most common
 * same-origin link shape outside nav/header/footer (≥5 distinct links).
 */
async function heuristicDetection(page: PageDriver): Promise<CollectionDetection | null> {
  const { origin: pageOrigin, links } = await page.run("sameOriginLinks");
  const shapes = new Map<string, Set<string>>();
  for (const h of links) {
    const u = new URL(h);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length === 0) continue;
    const shape = segs.map((s, i) => (/\d{3,}/.test(s) ? "*" : i === segs.length - 1 && segs.length > 1 ? "*" : s)).join("/");
    if (!shape.includes("*")) continue;
    (shapes.get(shape) ?? shapes.set(shape, new Set()).get(shape)!).add(h.split("#")[0]);
  }
  const best = [...shapes.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  if (!best || best[1].size < 5) return null;
  const origin = pageOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = "^" + origin + "/" + best[0].split("/").map((s) => (s === "*" ? "[^/?#]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "(?:[/?#]|$)";
  log.info(`Heuristic link-shape detection: ${best[0]} (${best[1].size} links)`);
  return { listItemSelector: "", paginationType: "pages", nextSelector: null, itemUrlPattern: pattern };
}

/**
 * Tries ?page=2-style params: if loading the next page number yields new item
 * URLs, URL-based paging is the most reliable mechanism (no clicking, works
 * for SPA "next" buttons that don't expose hrefs).
 */
async function probePageParam(page: PageDriver, startUrl: string, d: CollectionDetection, firstPage: string[], preferred?: string | null): Promise<string | null> {
  const candidates = [...new Set([preferred, ...PAGE_PARAM_CANDIDATES].filter((x): x is string => !!x))];
  const current = new URL(startUrl);
  for (const param of candidates.slice(0, 5)) {
    const nextNum = (Number(current.searchParams.get(param)) || 1) + 1;
    try {
      await gotoAndSettle(page, withPageParam(startUrl, param, nextNum), { scroll: true });
      const urls = await collectItemUrls(page, d);
      const fresh = urls.filter((u) => !firstPage.includes(u));
      log.info(`Page-param probe "${param}=${nextNum}": ${urls.length} items, ${fresh.length} new`);
      if (fresh.length > 0 && fresh.length >= urls.length / 2) return param;
    } catch (err) {
      log.info(`Page-param probe "${param}" failed`, errorMessage(err));
    }
  }
  return null;
}

export interface DetectResult {
  detection: CollectionDetection;
  firstPageUrls: string[];
  /**
   * False when the selector found a single card: enough to crawl this listing's one item, but too little to
   * trust the selector on the site's other listings, so the caller doesn't save it.
   */
  verified: boolean;
}

/** detect → verify in the live DOM → one grounded retry → heuristic fallback; then pagination probing. */
export async function detectListingStructure(page: PageDriver, startUrl: string, report: (msg: string) => void): Promise<DetectResult> {
  await gotoAndSettle(page, startUrl);
  const html = await page.run("pageHtml");
  const sanitized = sanitizeForLlm(html);
  let detection: CollectionDetection | null = null;
  let urls: string[] = [];
  // An LLM selector that found exactly one card: a listing with a single item, which can't verify a selector.
  let single: { detection: CollectionDetection; urls: string[] } | null = null;

  report("Asking the LLM to find item cards and pagination…");
  let retry: Parameters<typeof detectListing>[2];
  for (let attempt = 1; attempt <= 2 && !detection; attempt++) {
    try {
      const llm = await detectListing(sanitized, startUrl, retry);
      const candidate: CollectionDetection = {
        listItemSelector: llm.listItemSelector,
        paginationType: llm.paginationType,
        nextSelector: llm.nextSelector ?? null,
        loadMoreSelector: llm.loadMoreSelector ?? null,
        pageParam: llm.pageParam ?? null,
        itemUrlPattern: null,
      };
      urls = await collectItemUrls(page, candidate);
      log.info(`Attempt ${attempt}: "${candidate.listItemSelector}" → ${urls.length} item URLs (${candidate.paginationType})`);
      if (urls.length === 1) single ??= { detection: candidate, urls };
      if (urls.length >= MIN_ITEMS) detection = candidate;
      else retry = { previousSelector: candidate.listItemSelector, matched: urls.length, repeatedClasses: findRepeatedClassNames(sanitized) };
    } catch (err) {
      log.warn(`LLM detection attempt ${attempt} failed`, errorMessage(err));
      if (attempt === 1) retry = { previousSelector: "(invalid response)", matched: 0, repeatedClasses: findRepeatedClassNames(sanitized) };
    }
  }

  if (!detection) {
    report("LLM selector didn't verify — falling back to link-shape heuristic");
    detection = await heuristicDetection(page);
    if (!detection && single) {
      report("This listing shows only one item — crawling it without saving the selector for the site's other listings");
      return { detection: single.detection, firstPageUrls: single.urls, verified: false };
    }
    if (!detection) throw new Error("Could not find item links on the listing page");
    urls = await collectItemUrls(page, detection);
  }

  detection.itemUrlPattern ??= inferItemUrlPattern(urls);
  if (detection.itemUrlPattern) urls = urls.filter((u) => new RegExp(detection!.itemUrlPattern!).test(u));
  report(`Found ${urls.length} items on page 1 (selector: ${detection.listItemSelector || detection.itemUrlPattern})`);

  // Pagination: trust a param-based answer only if the param actually pages; otherwise probe.
  const llmParamOk = detection.paginationType === "urlPage" && !!detection.pageParam;
  const param = await probePageParam(page, startUrl, detection, urls, llmParamOk ? detection.pageParam : null);
  if (param) {
    detection.paginationType = "urlPage";
    detection.pageParam = param;
    report(`Pagination: URL parameter "${param}"`);
  } else if (llmParamOk) {
    // Param didn't produce new items — maybe there is just one page.
    report(`Pagination: "${detection.pageParam}" gave no new items (single page?)`);
  } else {
    report(`Pagination: ${detection.paginationType}${detection.nextSelector ? ` via ${detection.nextSelector}` : detection.loadMoreSelector ? ` via ${detection.loadMoreSelector}` : ""}`);
  }

  return { detection, firstPageUrls: urls, verified: true };
}
