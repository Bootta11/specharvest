/**
 * DOM functions that run *inside* a crawled page — the same code for both runners: the server injects them
 * with puppeteer (`page.evaluate`), the browser extension bundles them and runs them with
 * `chrome.scripting.executeScript`. Both serialize each function with `toString()`, so every function here
 * must be self-contained: no imports, no references to anything outside its own body (helpers are inlined),
 * at most one JSON-serializable argument and a JSON-serializable result.
 *
 * Bundlers that keep function names wrap inner named functions in `__name(...)`; the runners define a no-op
 * `__name` in the page before calling these.
 */

/** Scrolls one step down; true once the bottom is reached. */
function scrollStep(args: { step: number }): boolean {
  window.scrollBy(0, args.step);
  return window.scrollY + window.innerHeight >= document.body.scrollHeight - 2;
}

function scrollToTop(): void {
  window.scrollTo(0, 0);
}

function scrollToBottom(): void {
  window.scrollTo(0, document.body.scrollHeight);
}

/** Clones open shadow roots into light DOM so the page's HTML and selectors see their content. */
function flattenShadowDom(): void {
  const flatten = (root: Document | ShadowRoot): void => {
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) {
        const clone = document.createElement("div");
        clone.setAttribute("data-shadow-flattened", "true");
        clone.innerHTML = shadow.innerHTML;
        el.appendChild(clone);
        flatten(shadow);
      }
    }
  };
  flatten(document);
}

/**
 * Cloudflare-style interstitial: a suspicious title plus a challenge marker in the HTML. The title test
 * comes first so ordinary pages never pay for serializing their HTML.
 */
function isBotChallenge(): boolean {
  if (!/just a moment|attention required|access denied|verify you are human/i.test(document.title)) return false;
  return /challenges\.cloudflare\.com|cf-chl-|cf-turnstile|captcha|perimeterx|datadome/i.test(document.documentElement.outerHTML);
}

function pageInfo(): { url: string; title: string } {
  return { url: location.href, title: document.title };
}

/** Serialized page HTML (doctype left out — nothing downstream needs it). */
function pageHtml(): string {
  return document.documentElement.outerHTML;
}

/**
 * Distinct page links (http only — not wishlist/compare `javascript:` buttons) and height — compared before
 * and after scrolling to tell whether the page loads more items on scroll.
 */
function scrollMetrics(): { links: number; height: number; scrolled: boolean } {
  const urls = new Set<string>();
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    const href = (a as HTMLAnchorElement).href;
    if (/^https?:/.test(href)) urls.add(href.split("#")[0]!);
  }
  return { links: urls.size, height: document.body?.scrollHeight ?? 0, scrolled: window.scrollY > 0 };
}

/** Length of the visible text of `main` (or the body) — polled until it stops growing. */
function visibleTextLength(): number {
  return (document.querySelector("main") ?? document.body)?.innerText.length ?? 0;
}

/**
 * Item cards on the page: for each element matching `selector`, the card's own href (if it is an <a>) or its
 * main link, plus the card's text. Without a selector, every non-chrome link matching `pattern` (card text
 * from its closest card-like container).
 *
 * A card's main link is the item's page, not whatever link comes first (often a brand or category link above
 * the title): links matching `pattern` win; then a link the card repeats (image and title both point to the
 * item) or that sits in its title, minus links shared by many cards (brand, category, "compare").
 */
function collectCards(args: { selector: string; pattern: string }): Array<{ url: string; cardText: string }> {
  const isReal = (href: string | null | undefined) => !!href && /^https?:/.test(href) && href !== location.href && !href.startsWith(location.href + "#");
  const textOf = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? "").slice(0, 1000);
  const out: Array<{ url: string; cardText: string }> = [];
  if (args.selector) {
    let els: Element[] = [];
    try {
      els = Array.from(document.querySelectorAll(args.selector));
    } catch {
      return [];
    }
    const re = args.pattern ? new RegExp(args.pattern) : null;
    const linksOf = (card: Element) =>
      Array.from(card.querySelectorAll("a[href]"))
        .map((a) => ({ a: a as HTMLAnchorElement, url: (a as HTMLAnchorElement).href.split("#")[0]! }))
        .filter((l) => isReal(l.url));
    const perCard = els.map(linksOf);
    // In how many cards each URL appears.
    const spread = new Map<string, number>();
    for (const links of perCard) for (const url of new Set(links.map((l) => l.url))) spread.set(url, (spread.get(url) ?? 0) + 1);
    const shared = Math.max(3, Math.ceil(els.length * 0.3));
    els.forEach((card, i) => {
      const self = card.tagName === "A" ? (card as HTMLAnchorElement).href : null;
      if (isReal(self)) return void out.push({ url: self!, cardText: textOf(card) });
      const scores = new Map<string, number>();
      perCard[i]!.forEach((l, order) => {
        let score = (scores.get(l.url) ?? 0) + 1;
        if (l.a.closest("h1, h2, h3, h4, h5, h6, [class*=title i], [class*=name i]")) score += 2;
        if (l.a.querySelector("img")) score += 1;
        if (order === 0) score += 0.5;
        scores.set(l.url, score);
      });
      let best: string | null = null;
      let bestScore = -Infinity;
      for (const [url, base] of scores) {
        const score = base + (re && re.test(url) ? 100 : 0) - ((spread.get(url) ?? 0) >= shared ? 5 : 0);
        if (score > bestScore) [best, bestScore] = [url, score];
      }
      if (best) out.push({ url: best, cardText: textOf(card) });
    });
  } else if (args.pattern) {
    const re = new RegExp(args.pattern);
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      if (a.closest("nav, header, footer")) continue;
      const href = (a as HTMLAnchorElement).href;
      if (isReal(href) && re.test(href)) out.push({ url: href, cardText: textOf(a.closest("li, article, [class*=card i], [class*=item i]") ?? a) });
    }
  }
  return out;
}

/** The "next page" control: whether it exists (and isn't disabled), and its href when it is a real link. */
function nextControl(args: { selector: string }): { found: boolean; href: string | null } {
  let el: Element | null = null;
  try {
    el = document.querySelector(args.selector);
  } catch {
    return { found: false, href: null };
  }
  if (!el || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return { found: false, href: null };
  const a = (el.tagName === "A" ? el : el.closest("a")) as HTMLAnchorElement | null;
  return { found: true, href: a?.href && /^https?:/.test(a.href) ? a.href : null };
}

/** True once a card matching `selector` links somewhere not in `prev` (a JS "next" click swapped the cards). */
function cardsChangedSince(args: { selector: string; prev: string[] }): boolean {
  let cards: Element[] = [];
  try {
    cards = Array.from(document.querySelectorAll(args.selector));
  } catch {
    return false;
  }
  const hrefs = cards.map((c) => (c.tagName === "A" ? (c as HTMLAnchorElement).href : (c.querySelector("a[href]") as HTMLAnchorElement | null)?.href));
  return hrefs.some((h) => !!h && !args.prev.includes(h));
}

/** Clicks the first element matching `selector` (DOM click); false when there is none. */
function clickSelector(args: { selector: string }): boolean {
  let el: HTMLElement | null = null;
  try {
    el = document.querySelector(args.selector);
  } catch {
    return false;
  }
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.click();
  return true;
}

/** Same-origin links outside nav/header/footer — input for the link-shape fallback detection. */
function sameOriginLinks(): { origin: string; links: string[] } {
  return {
    origin: location.origin,
    links: Array.from(document.querySelectorAll("a[href]"))
      .filter((a) => !a.closest("nav, header, footer"))
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((h) => h.startsWith(location.origin) && h !== location.href),
  };
}

/** What a page says about itself, for the pre-crawl page check (listing / item / other). */
function pageSignals(): {
  ldTypes: string[];
  productNodes: number;
  ogType: string | null;
  title: string | null;
  crumbs: Array<{ name: string; url: string | null; position: number }>;
  text: string;
  links: number;
  prices: number;
} {
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
}

export interface RawDetailSnapshot {
  url: string;
  text: string;
  stableText: string;
  ld: { title: string | null; price: number | null; currency: string | null; image: string | null; description: string | null };
  og: { title: string | null; image: string | null; description: string | null; price: string | null; currency: string | null };
  h1: string | null;
  images: string[];
}

/**
 * Reads a rendered product page: visible text (innerText keeps label/value line breaks, unlike
 * textContent) with chrome/consent removed, JSON-LD / OpenGraph values as reliable defaults, and the text
 * once more without cards of *other* listings (`cardSelector` / `itemPattern`) for change fingerprints.
 */
function detailSnapshot(args: { cardSelector: string; itemPattern: string }): RawDetailSnapshot {
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || null;

  // JSON-LD Product / Vehicle / Offer
  let ld: RawDetailSnapshot["ld"] = { title: null, price: null, currency: null, image: null, description: null };
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
  if (args.cardSelector) {
    try {
      root.querySelectorAll(args.cardSelector).forEach((el) => el.remove());
    } catch {
      /* invalid selector */
    }
  }
  if (args.itemPattern) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(args.itemPattern);
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
    url: location.href,
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
}

export const PAGE_SCRIPTS = {
  scrollStep,
  scrollToTop,
  scrollToBottom,
  flattenShadowDom,
  isBotChallenge,
  pageInfo,
  pageHtml,
  visibleTextLength,
  scrollMetrics,
  collectCards,
  nextControl,
  cardsChangedSince,
  clickSelector,
  sameOriginLinks,
  pageSignals,
  detailSnapshot,
} as const;

export type PageScripts = typeof PAGE_SCRIPTS;
export type PageScriptName = keyof PageScripts;
export const PAGE_SCRIPT_NAMES = Object.keys(PAGE_SCRIPTS) as PageScriptName[];
/** The script's argument list: `[]` or `[args]`. */
export type PageScriptArgs<K extends PageScriptName> = Parameters<PageScripts[K]>;
export type PageScriptResult<K extends PageScriptName> = ReturnType<PageScripts[K]>;

/** Defined in the page before a script runs (see the header comment). */
export const NAME_SHIM = "globalThis.__name = globalThis.__name || ((f) => f);";
