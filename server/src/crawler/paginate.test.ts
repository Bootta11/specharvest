import { describe, expect, it } from "vitest";
import type { PageDriver } from "./driver.ts";
import { walkListing } from "./paginate.ts";

// A public IP literal: the URL guard in gotoAndSettle needs no DNS lookup.
const BASE = "https://93.184.216.34/list";

/** A fake page whose cards depend on the ?page= it was sent to; records the pages visited. */
function fakeListing(cardsOnPage: (page: number) => number[]) {
  const visited: number[] = [];
  let current = 1;
  const page: PageDriver = {
    runner: "server",
    async goto(url) {
      current = Number(new URL(url).searchParams.get("page")) || 1;
      visited.push(current);
      return { status: 200 };
    },
    async run(name: string) {
      if (name === "collectCards") return cardsOnPage(current).map((i) => ({ url: `https://93.184.216.34/item/${i}`, cardText: `Item ${i}` }));
      if (name === "scrollStep") return true;
      return name === "isBotChallenge" ? false : null;
    },
    async click() {},
    async waitForNetworkIdle() {},
  } as PageDriver;
  return { page, visited };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const detection = { listItemSelector: ".card", paginationType: "urlPage" as const, pageParam: "page", nextSelector: null, itemUrlPattern: null };
const walk = (page: PageDriver) => walkListing(page, BASE, detection, { maxPages: 10, maxItems: 500, onPage: () => {} });

describe("walkListing by page number", () => {
  it("goes on past a page whose items an earlier page's scrolling already loaded", async () => {
    // Page 1 scrolled in pages 2–3; page 3 has nothing new; page 4 has the rest; past the end the site repeats page 4.
    const { page, visited } = fakeListing((p) => (p === 1 ? range(1, 40) : p === 2 ? range(30, 55) : p === 3 ? range(41, 55) : range(56, 61)));
    const result = await walk(page);
    expect(result.items.size).toBe(61);
    expect(result.complete).toBe(true);
    expect(visited).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("ends at a page without cards", async () => {
    const { page, visited } = fakeListing((p) => (p <= 2 ? range(p * 10, p * 10 + 9) : []));
    const result = await walk(page);
    expect(result.items.size).toBe(20);
    expect(result.complete).toBe(true);
    expect(visited).toEqual([1, 2, 3]);
  });
});

describe("walkListing by next control", () => {
  it("clicks a next control without a real href and waits for the cards to change", async () => {
    // A JS pager (href="#"): clicking swaps the cards in place; the last page has no enabled next control.
    let current = 1;
    const cards = () => range((current - 1) * 16 + 1, Math.min(current * 16, 41)).map((i) => ({ url: `https://93.184.216.34/item/${i}`, cardText: `Item ${i}` }));
    const page = {
      runner: "server",
      async goto() {
        return { status: 200 };
      },
      async run(name: string, args?: { prev?: string[] }) {
        if (name === "collectCards") return cards();
        if (name === "nextControl") return current < 3 ? { found: true, href: null } : { found: false, href: null };
        if (name === "cardsChangedSince") return cards().some((c) => !args!.prev!.includes(c.url));
        if (name === "scrollStep") return true;
        return name === "isBotChallenge" ? false : null;
      },
      async click() {
        current++;
      },
      async waitForNetworkIdle() {},
    } as PageDriver;
    const result = await walkListing(page, BASE, { ...detection, paginationType: "pages", pageParam: null, nextSelector: "a[aria-label='Goto next page']" }, { maxPages: 10, maxItems: 500, onPage: () => {} });
    expect(result.items.size).toBe(41);
    expect(result.complete).toBe(true);
  });
});
