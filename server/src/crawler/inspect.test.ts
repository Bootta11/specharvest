import { describe, expect, it } from "vitest";
import { categoryFromCrumbs, classify, type PageSignals } from "./inspect.ts";

const signals = (s: Partial<PageSignals>): PageSignals => ({ url: "https://shop.example/x", ldTypes: [], productNodes: 0, ogType: null, knownItemUrl: false, knownListingItems: 0, ...s });

describe("classify", () => {
  it("one JSON-LD product is an item page", () => {
    expect(classify(signals({ ldTypes: ["Product", "BreadcrumbList"], productNodes: 1 }))?.kind).toBe("item");
    expect(classify(signals({ ogType: "product" }))?.kind).toBe("item");
  });

  it("several products or an ItemList is a listing", () => {
    expect(classify(signals({ ldTypes: ["ItemList", "ListItem", "Product"], productNodes: 3 }))?.kind).toBe("listing");
    expect(classify(signals({ ldTypes: ["CollectionPage"] }))?.kind).toBe("listing");
  });

  it("articles are not shop pages", () => {
    expect(classify(signals({ ldTypes: ["NewsArticle"] }))?.kind).toBe("other");
    expect(classify(signals({ ogType: "article" }))?.kind).toBe("other");
  });

  it("uses what is known about the site, but a few similar-ad cards don't make a listing", () => {
    expect(classify(signals({ knownItemUrl: true }))?.kind).toBe("item");
    expect(classify(signals({ knownItemUrl: true, knownListingItems: 6 }))?.kind).toBe("item");
    expect(classify(signals({ knownListingItems: 24 }))?.kind).toBe("listing");
  });

  it("leaves unclear pages to the LLM", () => {
    expect(classify(signals({ ldTypes: ["WebSite", "Organization"] }))).toBeNull();
    expect(classify(signals({ knownListingItems: 4 }))).toBeNull();
  });
});

describe("categoryFromCrumbs", () => {
  const page = "https://shop.example/bikes/mtb/rockhopper-123";
  it("takes the deepest same-site crumb that isn't the page or home", () => {
    const crumbs = [
      { name: "Home", url: "https://shop.example/" },
      { name: "Bikes", url: "https://shop.example/bikes" },
      { name: "Mountain bikes", url: "/bikes/mtb" },
      { name: "Rockhopper", url: page },
    ];
    expect(categoryFromCrumbs(crumbs, page, "Rockhopper")).toEqual({ name: "Mountain bikes", url: "https://shop.example/bikes/mtb" });
  });

  it("skips the item's own crumb without a link and other sites", () => {
    expect(categoryFromCrumbs([{ name: "Bikes", url: "https://other.example/bikes" }, { name: "Rockhopper", url: null }], page, null)).toBeNull();
    expect(categoryFromCrumbs([{ name: "Home", url: "https://shop.example/" }], page, null)).toBeNull();
  });
});
