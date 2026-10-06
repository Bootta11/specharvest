import type { Page } from "puppeteer-core";
import type { CollectionDetection } from "../db/sqlite.ts";
import { detectListing } from "../llm/detect.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { gotoAndSettle } from "./browser.ts";
import { collectItemUrls, withPageParam } from "./paginate.ts";
import { findRepeatedClassNames, sanitizeForLlm } from "./sanitize.ts";

const log = createLogger("detect");

const MIN_ITEMS = 2;
const PAGE_PARAM_CANDIDATES = ["page", "p", "pg", "paged", "strana", "stranica", "pageNumber", "pagenum", "seite", "pagina"];

/** Regex for the dominant URL shape among item URLs (e.g. ^https://olx\.ba/artikal/), or null if no clear one. */
export function inferItemUrlPattern(urls: string[]): string | null {
  if (urls.length < 3) return null;
  const counts = new Map<string, number>();
  for (const u of urls) {
    try {
      const url = new URL(u);
      const first = url.pathname.split("/").filter(Boolean)[0];
      const key = `${url.origin}/${first ? first + "/" : ""}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } catch {
      /* skip */
    }
  }
  const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (!best || n / urls.length < 0.8 || best.endsWith(".")) return null;
  // Only meaningful when the first segment is a real prefix (not every same-origin page).
  if (new URL(best).pathname === "/") return null;
  return "^" + best.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fallback when the LLM can't find a working card selector: the most common
 * same-origin link shape outside nav/header/footer (≥5 distinct links).
 */
async function heuristicDetection(page: Page): Promise<CollectionDetection | null> {
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .filter((a) => !a.closest("nav, header, footer"))
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((h) => h.startsWith(location.origin) && h !== location.href),
  );
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
  const origin = new URL(page.url()).origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = "^" + origin + "/" + best[0].split("/").map((s) => (s === "*" ? "[^/?#]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "(?:[/?#]|$)";
  log.info(`Heuristic link-shape detection: ${best[0]} (${best[1].size} links)`);
  return { listItemSelector: "", paginationType: "pages", nextSelector: null, itemUrlPattern: pattern };
}

/**
 * Tries ?page=2-style params: if loading the next page number yields new item
 * URLs, URL-based paging is the most reliable mechanism (no clicking, works
 * for SPA "next" buttons that don't expose hrefs).
 */
async function probePageParam(page: Page, startUrl: string, d: CollectionDetection, firstPage: string[], preferred?: string | null): Promise<string | null> {
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
}

/** detect → verify in the live DOM → one grounded retry → heuristic fallback; then pagination probing. */
export async function detectListingStructure(page: Page, startUrl: string, report: (msg: string) => void): Promise<DetectResult> {
  await gotoAndSettle(page, startUrl);
  const html = await page.content();
  const sanitized = sanitizeForLlm(html);
  let detection: CollectionDetection | null = null;
  let urls: string[] = [];

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

  return { detection, firstPageUrls: urls };
}
