import { describe, expect, it } from "vitest";
import { FatalDriverError, type PageDriver } from "./driver.ts";
import { confirmsGone, probeItem, sampleUrls, type ProbeResult } from "./gone.ts";

// A public IP literal: the URL guard in gotoAndSettle needs no DNS lookup.
const OLD = "https://93.184.216.34/old/1";
const NEW = "https://93.184.216.34/new/1";
const seen = new Set([NEW]);

function fakePage(o: { status?: number | null; finalUrl?: string; botWall?: boolean; error?: Error }): PageDriver {
  return {
    runner: "server",
    async goto() {
      if (o.error) throw o.error;
      return { status: o.status === undefined ? 200 : o.status };
    },
    async run(name: string) {
      if (name === "isBotChallenge") return !!o.botWall;
      return name === "pageInfo" ? { url: o.finalUrl ?? OLD, title: "" } : null;
    },
    async click() {},
    async waitForNetworkIdle() {},
  } as PageDriver;
}

describe("probeItem", () => {
  it.each<[string, Parameters<typeof fakePage>[0], ProbeResult]>([
    ["404", { status: 404 }, "dead"],
    ["410", { status: 410 }, "dead"],
    ["redirect to an item the walk found", { finalUrl: `${NEW}?utm_source=x#top` }, "dead"],
    ["redirect elsewhere", { finalUrl: "https://93.184.216.34/" }, "unknown"],
    ["its own page", {}, "alive"],
    ["its own page, status not known", { status: null }, "alive"],
    ["403", { status: 403 }, "unknown"],
    ["503", { status: 503 }, "unknown"],
    ["a bot wall answering 404", { status: 404, botWall: true }, "unknown"],
    ["navigation error", { error: new Error("timeout") }, "unknown"],
  ])("%s", async (_name, page, expected) => {
    expect(await probeItem(fakePage(page), OLD, seen)).toBe(expected);
  });

  it("passes on a browser that stopped working", async () => {
    await expect(probeItem(fakePage({ error: new FatalDriverError("gone") }), OLD, seen)).rejects.toBeInstanceOf(FatalDriverError);
  });
});

describe("confirmsGone", () => {
  const r = (dead: number, alive: number, unknown: number): ProbeResult[] => [
    ...Array<ProbeResult>(dead).fill("dead"),
    ...Array<ProbeResult>(alive).fill("alive"),
    ...Array<ProbeResult>(unknown).fill("unknown"),
  ];
  it.each([
    ["all dead", r(8, 0, 0), 800, true],
    ["enough dead, some unclear", r(5, 0, 3), 800, true],
    ["too few dead", r(4, 0, 4), 800, false],
    ["one still there", r(7, 1, 0), 800, false],
    ["nothing to go by", r(0, 0, 8), 800, false],
    ["no answers", [], 800, false],
    ["few missing, all dead", r(3, 0, 0), 3, true],
    ["few missing, one unclear", r(2, 0, 1), 3, false],
  ])("%s", (_name, results, missing, expected) => {
    expect(confirmsGone(results, missing)).toBe(expected);
  });
});

it("samples distinct urls, at most n", () => {
  const urls = Array.from({ length: 20 }, (_, i) => `u${i}`);
  const s = sampleUrls(urls, 8);
  expect(new Set(s).size).toBe(8);
  expect(s.every((u) => urls.includes(u))).toBe(true);
  expect(sampleUrls(["a"], 8)).toEqual(["a"]);
});
