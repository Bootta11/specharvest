import sanitizeHtml from "sanitize-html";
import type { RawDetailSnapshot } from "@specharvest/shared/page-scripts";
import type { PageDriver } from "./driver.ts";

// Listing pages can bury the item grid behind huge mega-menus/facets, and
// pagination usually sits at the end — keep head + tail rather than head only.
const MAX_CHARS = 200_000;
const TAIL_CHARS = 40_000;

/** Trimmed HTML for listing-page container/pagination detection (structure + classes only). */
export function sanitizeForLlm(html: string): string {
  const cleaned = sanitizeHtml(html, {
    allowedTags: [
      "html", "body", "div", "span", "section", "article", "main", "header", "footer", "nav",
      "ul", "ol", "li", "a", "img", "h1", "h2", "h3", "h4", "h5", "h6", "p",
      "table", "thead", "tbody", "tr", "td", "th", "button", "strong", "em", "b", "i", "figure",
    ],
    allowedAttributes: {
      a: ["href", "class", "id", "rel", "aria-label"],
      img: ["src", "alt", "class"],
      button: ["class", "id", "type", "aria-label", "disabled"],
      "*": ["class", "id"],
    },
    allowedSchemes: ["http", "https"],
    nonTextTags: ["script", "style", "noscript", "svg", "iframe", "canvas", "video", "audio", "head", "template"],
  });
  const collapsed = cleaned.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
  return collapsed.length > MAX_CHARS ? collapsed.slice(0, MAX_CHARS - TAIL_CHARS) + "<!--truncated-->" + collapsed.slice(-TAIL_CHARS) : collapsed;
}

const CLASS_ATTR_RE = /class="([^"]*)"/g;

/** Class names on ≥ minCount elements — grounding hint for a retry of container detection. */
export function findRepeatedClassNames(html: string, minCount = 3, limit = 40): string[] {
  const counts = new Map<string, number>();
  for (const m of html.matchAll(CLASS_ATTR_RE)) {
    for (const token of m[1].split(/\s+/).filter(Boolean)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t);
}

export interface DetailSnapshot {
  url: string;
  text: string;
  prefill: {
    title: string | null;
    price: number | null;
    currency: string | null;
    image: string | null;
    description: string | null;
  };
  images: string[];
  /**
   * Page text without other listings ("similar ads", seller's other items),
   * which change independently of this item — used only for change fingerprints.
   */
  stableText: string;
}

/** Listing structure hints that identify cards of *other* items on a detail page. */
export interface OtherListingHints {
  listItemSelector?: string | null;
  itemUrlPattern?: string | null;
}

const DETAIL_TEXT_MAX = 15_000;

/**
 * Reads a rendered product page: visible text (innerText keeps label/value
 * line breaks, unlike textContent) with chrome/consent removed, plus
 * JSON-LD / OpenGraph values as reliable defaults.
 */
export async function snapshotDetail(page: PageDriver, hints: OtherListingHints = {}): Promise<DetailSnapshot> {
  return toDetailSnapshot(await page.run("detailSnapshot", { cardSelector: hints.listItemSelector ?? "", itemPattern: hints.itemUrlPattern ?? "" }));
}

/** Cleans what the `detailSnapshot` page script read (also used for a snapshot the extension sends as is). */
export function toDetailSnapshot(snap: RawDetailSnapshot): DetailSnapshot {
  const clean = (raw: string) =>
    raw
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l, i, arr) => l.length > 0 && !(l === arr[i - 1]))
      .join("\n");
  const text = clean(snap.text);

  return {
    url: snap.url,
    text: text.length > DETAIL_TEXT_MAX ? text.slice(0, DETAIL_TEXT_MAX) + "\n[truncated]" : text,
    prefill: {
      title: snap.ld.title ?? snap.og.title ?? snap.h1,
      price: snap.ld.price ?? (snap.og.price && !isNaN(Number(snap.og.price)) ? Number(snap.og.price) : null),
      currency: snap.ld.currency ?? snap.og.currency,
      image: snap.ld.image ?? snap.og.image ?? snap.images[0] ?? null,
      description: snap.ld.description ?? snap.og.description,
    },
    images: snap.images,
    stableText: clean(snap.stableText),
  };
}
