import { describe, expect, it } from "vitest";
import { inferItemUrlPattern } from "./detect.ts";
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

  it("returns null without a clear majority", () => {
    expect(inferItemUrlPattern(["https://a.com/x/1", "https://a.com/y/2", "https://a.com/z/3"])).toBeNull();
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
