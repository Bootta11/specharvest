import { z } from "zod";
import { askForJson } from "./client.ts";

export const detectionSchema = z.object({
  paginationType: z.enum(["pages", "loadMore", "infiniteScroll", "urlPage"]),
  nextSelector: z.string().nullable().optional(),
  loadMoreSelector: z.string().nullable().optional(),
  pageParam: z.string().nullable().optional(),
  listItemSelector: z.string().min(1),
});
export type LlmDetection = z.infer<typeof detectionSchema>;

const SYSTEM = `You are an expert web scraping assistant. You inspect sanitized HTML of a shop's item-listing (search/category) page and identify (1) a CSS selector for the repeating item card and (2) the pagination mechanism.

Selectors must be plain native CSS selectors usable with document.querySelectorAll — never jQuery-only syntax like :contains(). Only use class names that appear verbatim in the HTML. Prefer a short selector built from a class shared by EVERY card; never use per-instance auto-generated classes or ids (random-looking suffixes that differ per card). The item card must contain (or be) the link to the item's detail page.

Respond with ONLY one JSON object, no prose:
{
  "listItemSelector": string,
  "paginationType": "pages" | "loadMore" | "infiniteScroll" | "urlPage",
  "nextSelector": string | null,      // "pages": selector of the next-page link/button
  "loadMoreSelector": string | null,  // "loadMore": selector of the load-more button
  "pageParam": string | null          // "urlPage": query parameter holding the page number
}

If the Page URL already has a page-number query parameter (page, p, pg, paged, ...), use "urlPage" with that exact name. If page-number links in the HTML have hrefs with such a parameter, also use "urlPage". Ignore hidden duplicate pagination widgets. Never claim a type without its selector/param; if there is no visible pagination at all, use "pages" with nextSelector null.`;

export async function detectListing(sanitizedHtml: string, pageUrl: string, retry?: { previousSelector: string; matched: number; repeatedClasses: string[] }) {
  const retryNote = retry
    ? `\n\nNote: a previous attempt proposed listItemSelector "${retry.previousSelector}", which matched ${retry.matched} item link(s) on the live page — a listing page should have several. Pick a different selector shared by all cards. Class names that appear on 3+ elements (most frequent first): ${retry.repeatedClasses.join(", ")}.`
    : "";
  const { data } = await askForJson(detectionSchema, SYSTEM, `Page URL: ${pageUrl}\n\nSanitized HTML:\n${sanitizedHtml}${retryNote}`, { purpose: "detect", maxTokens: 800, jsonMode: true });
  return data;
}
