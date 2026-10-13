import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageDriver } from "./driver.ts";

const llm = vi.hoisted(() => ({ detectListing: vi.fn() }));
const urlsFor = vi.hoisted(() => ({ fn: vi.fn<(selector: string) => string[]>() }));

vi.mock("../llm/detect.ts", () => llm);
vi.mock("./browser.ts", () => ({ gotoAndSettle: vi.fn(async () => 200) }));
vi.mock("./paginate.ts", () => ({
  collectItemUrls: async (_page: unknown, d: { listItemSelector: string }) => urlsFor.fn(d.listItemSelector),
  withPageParam: (url: string) => url,
}));

const { detectListingStructure } = await import("./detect.ts");

const page = {
  run: async (name: string) => (name === "pageHtml" ? "<main><div class='card'><a href='/p/1'>One</a></div></main>" : { origin: "https://shop.example", links: [] }),
} as unknown as PageDriver;

const answer = (selector: string) => ({ listItemSelector: selector, paginationType: "pages" });

describe("detectListingStructure", () => {
  beforeEach(() => {
    llm.detectListing.mockReset();
    urlsFor.fn.mockReset();
  });

  it("crawls a listing with a single card, but marks the selector unverified", async () => {
    llm.detectListing.mockResolvedValue(answer(".card"));
    urlsFor.fn.mockReturnValue(["https://shop.example/p/1"]);
    const result = await detectListingStructure(page, "https://shop.example/c/tiny", () => {});
    expect(result.verified).toBe(false);
    expect(result.firstPageUrls).toEqual(["https://shop.example/p/1"]);
    expect(result.detection.listItemSelector).toBe(".card");
  });

  it("verifies a selector that finds several cards", async () => {
    llm.detectListing.mockResolvedValue(answer(".card"));
    urlsFor.fn.mockReturnValue(["https://shop.example/p/1", "https://shop.example/p/2"]);
    const result = await detectListingStructure(page, "https://shop.example/c/big", () => {});
    expect(result.verified).toBe(true);
    expect(result.firstPageUrls).toHaveLength(2);
  });

  it("still fails when no selector finds any card", async () => {
    llm.detectListing.mockResolvedValue(answer(".nothing"));
    urlsFor.fn.mockReturnValue([]);
    await expect(detectListingStructure(page, "https://shop.example/c/none", () => {})).rejects.toThrow("Could not find item links");
  });
});
