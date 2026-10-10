import { z } from "zod";
import { askForJson } from "./client.ts";

const classificationSchema = z.object({
  kind: z.enum(["listing", "item", "other"]),
  reason: z.string().max(200),
});

const SYSTEM = `You classify a web page before a shop crawler runs on it. Answer with exactly one kind:
- "listing": a shop/classifieds category, search-results or catalog page showing MANY products or ads to choose from.
- "item": the page of ONE product or ad (its own title, price, photos, specs or description), even if it also shows "similar items".
- "other": anything else — news or blog article, homepage without a product grid, forum, docs, login, error page.

Respond with ONLY one JSON object, no prose: {"kind": "listing" | "item" | "other", "reason": string}
"reason" is at most 12 plain words for a non-technical user, e.g. "Shows one used bike ad with price and specs".`;

/** Last resort of the page check (crawler/inspect.ts) when structured data doesn't settle it. */
export async function classifyPage(input: { url: string; title: string | null; text: string; links: number; prices: number }) {
  const user = `Page URL: ${input.url}
Title: ${input.title ?? "(none)"}
Links on the page: ${input.links}; price-like amounts: ${input.prices}

Visible text (start):
${input.text}`;
  const { data } = await askForJson(classificationSchema, SYSTEM, user, { purpose: "detect", maxTokens: 200, jsonMode: true });
  return data;
}
