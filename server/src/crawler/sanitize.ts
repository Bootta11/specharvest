import sanitizeHtml from "sanitize-html";
import type { Page } from "puppeteer-core";

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
export async function snapshotDetail(page: Page, hints: OtherListingHints = {}): Promise<DetailSnapshot> {
  const snap = await page.evaluate((cardSelector, itemPattern) => {
    const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || null;

    // JSON-LD Product / Vehicle / Offer
    let ld: { title: string | null; price: number | null; currency: string | null; image: string | null; description: string | null } = {
      title: null, price: null, currency: null, image: null, description: null,
    };
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      const o = node as Record<string, unknown>;
      if (o["@graph"]) visit(o["@graph"]);
      const type = String(o["@type"] ?? "");
      if (/Product|Vehicle|Car|IndividualProduct/i.test(type)) {
        const offers = (Array.isArray(o.offers) ? o.offers[0] : o.offers) as Record<string, unknown> | undefined;
        const img = Array.isArray(o.image) ? o.image[0] : o.image;
        ld = {
          title: typeof o.name === "string" ? o.name : ld.title,
          price: offers?.price != null && !isNaN(Number(offers.price)) ? Number(offers.price) : ld.price,
          currency: typeof offers?.priceCurrency === "string" ? offers.priceCurrency : ld.currency,
          image: typeof img === "string" ? img : typeof (img as Record<string, unknown>)?.url === "string" ? String((img as Record<string, unknown>).url) : ld.image,
          description: typeof o.description === "string" ? o.description.slice(0, 2000) : ld.description,
        };
      }
    };
    for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        visit(JSON.parse(s.textContent ?? ""));
      } catch {
        /* ignore malformed JSON-LD */
      }
    }

    // Large content images (gallery), deduped, before we strip anything.
    const images = Array.from(document.querySelectorAll("img"))
      .filter((img) => (img.naturalWidth || img.width) >= 300)
      .map((img) => img.currentSrc || img.src)
      .filter((src) => /^https?:/.test(src));

    // Work on a clone so the live page is untouched.
    const root = (document.querySelector("main") ?? document.body).cloneNode(true) as HTMLElement;
    const junk = [
      "script", "style", "noscript", "svg", "iframe", "nav", "footer", "header", "form", "template",
      "[role=dialog]", "[aria-modal=true]",
      "[id*=cookie i]", "[class*=cookie i]", "[id*=consent i]", "[class*=consent i]", "[id*=gdpr i]", "[class*=gdpr i]",
      "[class*=fc-consent]", "[id*=onetrust i]", "[class*=newsletter i]",
    ].join(",");
    root.querySelectorAll(junk).forEach((el) => el.remove());

    // innerText needs layout; attach the clone off-screen so line breaks are preserved.
    root.style.position = "absolute";
    root.style.left = "-100000px";
    root.style.width = "1200px";
    document.body.appendChild(root);
    const text = root.innerText;

    // Drop cards of other listings for the change fingerprint.
    if (cardSelector) {
      try {
        root.querySelectorAll(cardSelector).forEach((el) => el.remove());
      } catch {
        /* invalid selector */
      }
    }
    if (itemPattern) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(itemPattern);
      } catch {
        /* invalid pattern */
      }
      const self = location.href.split("#")[0];
      for (const a of Array.from(root.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
        if (!a.isConnected || !re?.test(a.href) || a.href.split("#")[0] === self) continue;
        // Climb to the smallest container that still looks like a single card.
        let el: HTMLElement = a;
        while (el.parentElement && el.parentElement !== root && (el.parentElement.textContent?.length ?? 0) < 400) el = el.parentElement;
        el.remove();
      }
    }
    const stableText = root.innerText;
    root.remove();

    return {
      text,
      stableText,
      ld,
      og: {
        title: meta('meta[property="og:title"]'),
        image: meta('meta[property="og:image"]'),
        description: meta('meta[property="og:description"]') ?? meta('meta[name="description"]'),
        price: meta('meta[property="product:price:amount"]'),
        currency: meta('meta[property="product:price:currency"]'),
      },
      h1: document.querySelector("h1")?.textContent?.trim() || null,
      images: [...new Set(images)].slice(0, 12),
    };
  }, hints.listItemSelector ?? "", hints.itemUrlPattern ?? "");

  const clean = (raw: string) =>
    raw
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l, i, arr) => l.length > 0 && !(l === arr[i - 1]))
      .join("\n");
  const text = clean(snap.text);

  return {
    url: page.url(),
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
