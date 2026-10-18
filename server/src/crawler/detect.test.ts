import { describe, expect, it } from "vitest";
import { inferItemUrlPattern, tighterItemUrlPattern } from "./detect.ts";
import { normalizeItemUrl } from "./paginate.ts";
import { findRepeatedClassNames, sanitizeForLlm } from "./sanitize.ts";
import { isSafeItemUrlPattern, safeItemUrlPattern, withSafeUrlPattern } from "./url-pattern.ts";

describe("inferItemUrlPattern", () => {
  it("finds the dominant first path segment", () => {
    const urls = ["https://olx.ba/artikal/1", "https://olx.ba/artikal/2", "https://olx.ba/artikal/3", "https://olx.ba/artikal/4", "https://olx.ba/shop/x"];
    const re = new RegExp(inferItemUrlPattern(urls)!);
    expect(re.test("https://olx.ba/artikal/99")).toBe(true);
    expect(re.test("https://olx.ba/shop/x")).toBe(false);
  });

  it("takes the deepest shared directory, so listing pages of the site don't match", () => {
    const items = [31, 32, 33, 34, 35, 36].map((id) => `https://webscraper.io/test-sites/e-commerce/static/product/${id}`);
    const pattern = inferItemUrlPattern(items)!;
    expect(pattern).toBe("^https://webscraper\\.io/test-sites/e-commerce/static/product/");
    expect(isSafeItemUrlPattern(pattern)).toBe(true);
    expect(new RegExp(pattern).test("https://webscraper.io/test-sites/e-commerce/static/computers/tablets")).toBe(false);
    // Ids under one item directory: the item's own segment never becomes the prefix.
    expect(inferItemUrlPattern(["https://olx.ba/artikal/1/a", "https://olx.ba/artikal/2/b", "https://olx.ba/artikal/3/c"])).toBe("^https://olx\\.ba/artikal/");
  });

  it("narrows a saved broad pattern when a tighter one fits every walked item", () => {
    const items = [31, 32, 33].map((id) => `https://webscraper.io/test-sites/e-commerce/static/product/${id}`);
    expect(tighterItemUrlPattern("^https://webscraper\\.io/test-sites/", items)).toBe(inferItemUrlPattern(items));
    expect(tighterItemUrlPattern(inferItemUrlPattern(items), items)).toBeNull();
    expect(tighterItemUrlPattern(null, items)).toBeNull();
    // An item outside the tighter prefix keeps the saved pattern.
    expect(tighterItemUrlPattern("^https://webscraper\\.io/test-sites/", [...items, "https://webscraper.io/test-sites/other/9"])).toBeNull();
  });

  it("returns null without a clear majority", () => {
    expect(inferItemUrlPattern(["https://a.com/x/1", "https://a.com/y/2", "https://a.com/z/3"])).toBeNull();
  });

  it("falls back to a word shared by the slugs when items sit at the site root", () => {
    const items = ["dyson-v16-proizvod-9357", "samsung-jet-proizvod-4105", "bosch-bcs-proizvod-5412", "elit-zoomx-proizvod-9200"].map((s) => `https://shop.example/${s}/`);
    const pattern = inferItemUrlPattern([...items, "https://shop.example/blog/promo/gift/"])!;
    expect(isSafeItemUrlPattern(pattern)).toBe(true);
    const re = new RegExp(pattern);
    expect(items.every((u) => re.test(u))).toBe(true);
    expect(re.test("https://shop.example/blog/promo/gift/")).toBe(false);
    expect(re.test("https://shop.example/proizvodi/usisivaci/?page=2")).toBe(false);
    // No shared word: no pattern.
    expect(inferItemUrlPattern(["https://a.com/red-shoe-1/", "https://a.com/blue-hat-2/", "https://a.com/green-bag-3/"])).toBeNull();
  });
});

describe("normalizeItemUrl", () => {
  it("drops fragments and tracking params", () => {
    expect(normalizeItemUrl("https://s.com/p/1?utm_source=x&id=5#top")).toBe("https://s.com/p/1?id=5");
  });
});

describe("sanitizeForLlm", () => {
  it("strips scripts/styles/svg but keeps structure and classes", () => {
    const out = sanitizeForLlm('<div class="card"><script>x()</script><style>.a{}</style><svg><path/></svg><a href="https://s.com/p" class="t">Item</a></div>');
    expect(out).toBe('<div class="card"><a href="https://s.com/p" class="t">Item</a></div>');
  });

  it("finds repeated classes", () => {
    expect(findRepeatedClassNames('<i class="c x"></i><i class="c"></i><i class="c y"></i>')).toEqual(["c"]);
  });
});

describe("isSafeItemUrlPattern", () => {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("accepts what our detection produces", () => {
    expect(isSafeItemUrlPattern(inferItemUrlPattern(["https://olx.ba/artikal/1", "https://olx.ba/artikal/2", "https://olx.ba/artikal/3"])!)).toBe(true);
    // heuristicDetection's shape: escaped origin, literal and [^/?#]+ segments, end anchor.
    expect(isSafeItemUrlPattern(`^${esc("https://www.auto.example")}/oglasi/[^/?#]+/[^/?#]+(?:[/?#]|$)`)).toBe(true);
    expect(isSafeItemUrlPattern(`^${esc("http://[::1]:8080/p/")}`)).toBe(true);
  });

  it("rejects anything that could backtrack or isn't anchored", () => {
    for (const p of ["^(a+)+$", "(.*)*", "^a\\1", "^[a-z]+$", "^.*", "^https://x\\.com/(?:a|b)", "^https://x\\.com/a{1,9}", "https://x\\.com/"]) {
      expect(isSafeItemUrlPattern(p), p).toBe(false);
    }
    expect(safeItemUrlPattern("^(a+)+$")).toBeNull();
    expect(withSafeUrlPattern({ listItemSelector: ".c", itemUrlPattern: "^(a+)+$" })).toEqual({ listItemSelector: ".c", itemUrlPattern: null });
    expect(withSafeUrlPattern(null)).toBeNull();
  });
});
