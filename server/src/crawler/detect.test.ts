import { describe, expect, it } from "vitest";
import { inferItemUrlPattern } from "./detect.ts";
import { normalizeItemUrl } from "./paginate.ts";
import { findRepeatedClassNames, sanitizeForLlm } from "./sanitize.ts";

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
