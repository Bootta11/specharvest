// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://shop.example/list"}
import { beforeEach, describe, expect, it } from "vitest";
import { PAGE_SCRIPTS, PAGE_SCRIPT_NAMES, type PageScriptName } from "@specharvest/shared/page-scripts";

/**
 * Runs a page script the way both runners do: rebuilt from its source text, so a function that leans on
 * anything outside its own body fails here instead of in a crawled page.
 */
function runSerialized<K extends PageScriptName>(name: K, ...args: unknown[]): ReturnType<(typeof PAGE_SCRIPTS)[K]> {
  (globalThis as { __name?: unknown }).__name ??= (f: unknown) => f;
  const fn = new Function(`return (${PAGE_SCRIPTS[name].toString()})`)() as (...a: unknown[]) => ReturnType<(typeof PAGE_SCRIPTS)[K]>;
  return fn(...args);
}

// jsdom has no layout, so no innerText: textContent is close enough for these checks.
if (!("innerText" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    get(this: HTMLElement) {
      return this.textContent;
    },
  });
}

/** Same-origin pages only (jsdom's URL is fixed per file). */
function setPage(url: string, html: string, title = "") {
  window.history.replaceState(null, "", url);
  document.head.innerHTML = "";
  document.title = title;
  document.body.innerHTML = html;
}

describe("page scripts", () => {
  beforeEach(() => setPage("https://shop.example/list", ""));

  it("are all self-contained", () => {
    for (const name of PAGE_SCRIPT_NAMES) {
      expect(() => new Function(`return (${PAGE_SCRIPTS[name].toString()})`)(), name).not.toThrow();
    }
  });

  it("collectCards: card's own link or its first outbound link", () => {
    setPage(
      "https://shop.example/list",
      `<div class="card"><a href="/item/1">One</a> 100 €</div>
       <a class="card" href="/item/2">Two</a>
       <div class="card"><a href="#top">no real link</a></div>`,
    );
    expect(runSerialized("collectCards", { selector: ".card", pattern: "" }).map((c) => c.url)).toEqual([
      "https://shop.example/item/1",
      "https://shop.example/item/2",
    ]);
  });

  it("collectCards: a card's item link wins over a brand link that comes first", () => {
    const card = (brand: string, id: number) =>
      `<article class="cp"><a href="/brands/${brand}/">${brand}</a><a href="/p-${id}/"><img src="x.jpg"></a><h2 class="cp-title"><a href="/p-${id}/">Item ${id}</a></h2><a href="/compare">⇄</a></article>`;
    setPage("https://shop.example/list", [card("dyson", 1), card("dyson", 2), card("bosch", 3), card("dyson", 4)].join(""));
    expect(runSerialized("collectCards", { selector: "article.cp", pattern: "" }).map((c) => c.url)).toEqual([1, 2, 3, 4].map((i) => `https://shop.example/p-${i}/`));
    // A known item pattern decides outright.
    expect(runSerialized("collectCards", { selector: "article.cp", pattern: "/brands/" })[0]!.url).toBe("https://shop.example/brands/dyson/");
  });

  it("collectCards: pattern mode skips nav/header/footer links", () => {
    setPage("https://shop.example/list", `<nav><a href="/item/9">menu</a></nav><ul><li><a href="/item/3">Three</a></li></ul>`);
    expect(runSerialized("collectCards", { selector: "", pattern: "^https://shop\\.example/item/" }).map((c) => c.url)).toEqual(["https://shop.example/item/3"]);
  });

  it("collectCards: invalid selector yields nothing instead of throwing", () => {
    expect(runSerialized("collectCards", { selector: "div[", pattern: "" })).toEqual([]);
  });

  it("nextControl: href of a link, nothing when disabled", () => {
    setPage("https://shop.example/list", `<a class="next" href="/list?page=2">›</a><button class="more" disabled>more</button>`);
    expect(runSerialized("nextControl", { selector: ".next" })).toEqual({ found: true, href: "https://shop.example/list?page=2" });
    expect(runSerialized("nextControl", { selector: ".more" })).toEqual({ found: false, href: null });
    expect(runSerialized("nextControl", { selector: ".missing" })).toEqual({ found: false, href: null });
  });

  it("cardsChangedSince: true only when a new card link shows up", () => {
    setPage("https://shop.example/list", `<a class="card" href="/item/1">1</a>`);
    expect(runSerialized("cardsChangedSince", { selector: ".card", prev: ["https://shop.example/item/1"] })).toBe(false);
    document.body.innerHTML = `<a class="card" href="/item/2">2</a>`;
    expect(runSerialized("cardsChangedSince", { selector: ".card", prev: ["https://shop.example/item/1"] })).toBe(true);
  });

  it("sameOriginLinks: only same-origin content links", () => {
    setPage("https://shop.example/list", `<header><a href="/home">h</a></header><a href="/item/1">a</a><a href="https://other.example/x">b</a>`);
    expect(runSerialized("sameOriginLinks")).toEqual({ origin: "https://shop.example", links: ["https://shop.example/item/1"] });
  });

  it("scrollMetrics: counts distinct real links, not javascript: buttons or #anchors", () => {
    setPage(
      "https://shop.example/list",
      `<a href="/item/1">1</a><a href="/item/1#reviews">1 again</a><a href="/item/2">2</a>
       <a href="javascript:wishlist.add(1)">♡</a><a href="javascript:compare.add(1)">⇄</a>`,
    );
    expect(runSerialized("scrollMetrics").links).toBe(2);
  });

  it("isBotChallenge: needs both the title and a challenge marker", () => {
    setPage("https://shop.example/", `<div>hello</div>`, "Just a moment...");
    expect(runSerialized("isBotChallenge")).toBe(false);
    document.body.innerHTML = `<div id="cf-turnstile"></div><script src="https://challenges.cloudflare.com/x.js"></script>`;
    expect(runSerialized("isBotChallenge")).toBe(true);
  });

  it("pageSignals: JSON-LD product, breadcrumbs and og:type", () => {
    setPage(
      "https://shop.example/item/1",
      `<script type="application/ld+json">${JSON.stringify([
        { "@type": "Product", name: "Golf 7", isRelatedTo: { "@type": "Product", name: "Golf 8" } },
        { "@type": "BreadcrumbList", itemListElement: [{ position: 1, name: "Cars", item: "https://shop.example/cars" }] },
      ])}</script><main>Price 10.000 KM</main>`,
    );
    document.head.innerHTML = `<meta property="og:type" content="Product">`;
    const s = runSerialized("pageSignals");
    expect(s.productNodes).toBe(1);
    expect(s.title).toBe("Golf 7");
    expect(s.ogType).toBe("product");
    expect(s.crumbs).toEqual([{ name: "Cars", url: "https://shop.example/cars", position: 1 }]);
  });

  it("detailSnapshot: drops chrome and other listings from stable text", () => {
    setPage(
      "https://shop.example/item/1",
      `<header>Site menu</header>
       <main><h1>Golf 7</h1><p>Engine 110 kW</p>
         <div class="similar"><a class="card" href="/item/2">Passat 2015</a></div>
         <div class="cookie-banner">Accept cookies</div></main>`,
    );
    const snap = runSerialized("detailSnapshot", { cardSelector: ".card", itemPattern: "^https://shop\\.example/item/" });
    expect(snap.url).toBe("https://shop.example/item/1");
    expect(snap.h1).toBe("Golf 7");
    expect(snap.text).toContain("Engine 110 kW");
    expect(snap.text).not.toContain("Accept cookies");
    expect(snap.text).toContain("Passat");
    expect(snap.stableText).not.toContain("Passat");
    // The clone used for innerText is removed again.
    expect(document.querySelectorAll("main").length).toBe(1);
  });
});
