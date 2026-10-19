import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-web-"));
process.env.DATA_DIR = dataDir;
process.env.ENRICH_PREFETCH_MAX = "3";

/** Every LLM call the code under test makes, by purpose. Web lookups answer every key in their prompt. */
const calls: Array<{ purpose: string; user: string }> = [];
vi.mock("../llm/client.ts", () => ({
  askForJson: vi.fn(async (_schema: unknown, _system: string, user: string, opts: { purpose: string }) => {
    calls.push({ purpose: opts.purpose, user });
    if (opts.purpose === "predict") {
      return { data: { attributes: [{ key: "top_speed_kmh", type: "number", unit: "km/h", label: "top speed" }, { key: "length_mm", type: "number", unit: "mm", label: "length" }] }, citations: [], webSearches: 0 };
    }
    if (opts.purpose === "web-lookup") {
      await new Promise((r) => setTimeout(r, 30));
      const keys = [...user.matchAll(/^- ([a-z0-9_]+):/gm)].map((m) => m[1]);
      // Bowl sets: "zdjele" finds another brand's set; "wmf" finds the same one, with a lone citation and no source_url.
      if (/zdjele|wmf/.test(user)) {
        const other = user.includes("zdjele");
        const results = keys.map((key) => ({ key, value: 1.69, unit: "kg", confidence: 0.8, source_url: null, matched_brand: other ? "Rorence" : "WMF", matched_product: other ? "Rorence Set zdjela" : "WMF Gourmet" }));
        const citations = other ? [{ url: "https://topideas.example/rorence" }, { url: "https://b.example" }] : [{ url: "https://wmf.example/gourmet" }];
        return { data: { results }, citations, webSearches: 1 };
      }
      // length_mm is never found — a predicted miss must not be cached as "not found".
      const results = keys.map((key) => ({ key, value: key === "length_mm" ? null : 100, unit: null, confidence: 0.9, source_url: "https://specs.example/x" }));
      return { data: { results }, citations: [], webSearches: 1 };
    }
    return { data: { merges: [], groups: [] }, citations: [], webSearches: 0 };
  }),
}));
vi.mock("../db/lance.ts", () => ({ upsertVector: vi.fn(async () => {}) }));
vi.mock("../embedding.ts", () => ({ embed: vi.fn(async () => [0]) }));

const db = await import("../db/sqlite.ts");
const { sourceMatches, startEnrichment, stopEnrichment } = await import("./web.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const addUser = (email: string) =>
  Number(db.getDb().prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, 'x', 'user', ?)").run(email, Date.now()).lastInsertRowid);

async function finished(jobId: number) {
  for (let i = 0; i < 200; i++) {
    const job = db.getJob(jobId)!;
    if (job.status === "done" || job.status === "failed" || job.status === "stopped") return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${jobId} did not finish`);
}

const boot = { key: "boot_capacity_liters", type: "number" as const, unit: "l", label: "boot space" };

describe("web enrichment across users", () => {
  const alice = addUser("alice@example.com");
  const bob = addUser("bob@example.com");
  const ca = db.createCollection("A", "https://cars.example/a", "cars.example", alice);
  const cb = db.createCollection("B", "https://cars.example/b", "cars.example", bob);
  const item = (collectionId: number, url: string) =>
    db.upsertItem({ collectionId, url, title: "Kia Ceed", price: 1, currency: "EUR", mainImage: null, description: null, identity: "kia ceed 1.5 2025", specs: {}, rawText: null });
  const a = item(ca, "https://cars.example/1");
  const b = item(cb, "https://cars.example/2");

  beforeEach(() => {
    calls.length = 0;
  });

  it("pays once when two users ask about the same product at the same time, and prefetches predicted specs", async () => {
    const j1 = startEnrichment({ collectionId: ca, userId: alice, attributes: [boot], itemIds: [a] });
    const j2 = startEnrichment({ collectionId: cb, userId: bob, attributes: [boot], itemIds: [b] });
    await Promise.all([finished(j1.id), finished(j2.id)]);

    const lookups = calls.filter((c) => c.purpose === "web-lookup");
    expect(lookups).toHaveLength(1);
    expect(lookups[0].user).toContain("Also fill these");
    expect(db.getItemsByIds([a, b]).map((i) => i.specs.boot_capacity_liters)).toEqual([100, 100]);

    // Predicted extra found → cached (not applied to items); predicted miss → not cached at all.
    expect(db.getWebFact("kia ceed 1.5 2025", "top_speed_kmh")?.value).toBe(100);
    expect(db.getItemsByIds([a])[0].specs.top_speed_kmh).toBeUndefined();
    expect(db.getWebFact("kia ceed 1.5 2025", "length_mm")).toBeNull();
    const stats = [db.getJob(j1.id)!.lookup, db.getJob(j2.id)!.lookup];
    expect(stats.some((s) => s?.prefetched === 1)).toBe(true);
  });

  it("answers a later request for a prefetched spec from the cache, even under a synonym", async () => {
    db.saveKeyAlias("max_speed_kmh", "top_speed_kmh");
    const job = startEnrichment({ collectionId: ca, userId: alice, attributes: [{ key: "max_speed_kmh", type: "number", unit: "km/h", label: "top speed" }], itemIds: [a] });
    await finished(job.id);
    expect(calls.filter((c) => c.purpose === "web-lookup")).toHaveLength(0);
    expect(db.getItemsByIds([a])[0].specs.max_speed_kmh).toBe(100);
  });
});

describe("lookups skip and stop", () => {
  const user = addUser("carol@example.com");
  const col = db.createCollection("C", "https://cars.example/c", "cars.example", user);
  const add = (n: number, specs: Record<string, number> = {}) =>
    db.upsertItem({ collectionId: col, url: `https://cars.example/c/${n}`, title: `Car ${n}`, price: 1, currency: "EUR", mainImage: null, description: null, identity: `car model ${n}`, specs, rawText: null });

  beforeEach(() => {
    calls.length = 0;
  });

  it("doesn't look up a listing that states the value under a synonym", async () => {
    db.saveKeyAlias("cargo_space_l", "boot_space_l");
    const id = add(1, { cargo_space_l: 300 });
    const job = await finished(startEnrichment({ collectionId: col, userId: user, attributes: [{ key: "boot_space_l", type: "number", unit: "l", label: "boot space" }], itemIds: [id] }).id);
    expect(job.status).toBe("done");
    expect(calls.filter((c) => c.purpose === "web-lookup")).toHaveLength(0);
    expect(db.getItemsByIds([id])[0].specs.boot_space_l).toBeUndefined();
  });

  it("stops before paying when asked right away, leaving the products for next run", async () => {
    const ids = [add(2), add(3), add(4)];
    const started = startEnrichment({ collectionId: col, userId: user, attributes: [{ key: "range_km", type: "number", unit: "km", label: "range" }], itemIds: ids });
    expect(stopEnrichment(started.id)?.message).toBe("Stopping…");
    const job = await finished(started.id);
    expect(job.status).toBe("stopped");
    expect(job.itemsRemaining).toBe(3);
    expect(job.lookup?.remaining).toBe(3);
    expect(calls.filter((c) => c.purpose === "web-lookup")).toHaveLength(0);
    expect(stopEnrichment(started.id)).toBeNull();
  });
});

describe("key aliases", () => {
  it("stay one hop deep and never form a cycle", () => {
    expect(db.saveKeyAlias("trunk_volume_liters", "boot_capacity_liters")).toBe(true);
    expect(db.saveKeyAlias("boot_capacity_liters", "luggage_liters")).toBe(true);
    expect(db.canonicalKey("trunk_volume_liters")).toBe("luggage_liters");
    expect(db.keyAliasesOf("trunk_volume_liters").sort()).toEqual(["boot_capacity_liters", "luggage_liters", "trunk_volume_liters"]);
    expect(db.saveKeyAlias("luggage_liters", "trunk_volume_liters")).toBe(false);
    expect(db.canonicalKey("luggage_liters")).toBe("luggage_liters");
  });
});

describe("cross-collection reuse", () => {
  const owner = addUser("owner@example.com");
  const other = addUser("other@example.com");
  const src = db.createCollection("Src", "https://shop.example/list", "shop.example", owner);
  const dst = db.createCollection("Dst", "https://shop.example/list?page=1", "shop.example", other);
  const id = db.upsertItem({ collectionId: src, url: "https://shop.example/ad/1", title: "Ad", price: 5, currency: "EUR", mainImage: null, description: "d", identity: "x y", specs: { power_kw: 50 }, rawText: null, contentHash: "h1" });
  db.upsertSpecKey(src, { key: "power_kw", type: "number", unit: "kW", label: "Snaga", example: "50", origin: "page" });
  db.setItemSpec(id, "weight_kg", 900, { origin: "web", sourceUrl: "https://w.example", confidence: 0.9 });

  it("finds the same unchanged ad in another collection, page values only", () => {
    const found = db.findReusableExtraction("https://shop.example/ad/1", "h1", dst)!;
    expect(found.title).toBe("Ad");
    expect(found.specs).toEqual([{ key: "power_kw", value: 50, type: "number", unit: "kW", label: "Snaga" }]);
    expect(db.findReusableExtraction("https://shop.example/ad/1", "changed", dst)).toBeNull();
    expect(db.findReusableExtraction("https://shop.example/ad/1", "h1", src)).toBeNull();
  });

  it("reuses listing detection from the same host", () => {
    db.saveDetection(src, { listItemSelector: ".card", paginationType: "pages", nextSelector: "a.next" });
    expect(db.findDetectionForHost("shop.example", dst)?.listItemSelector).toBe(".card");
    expect(db.findDetectionForHost("other.example", dst)).toBeNull();
  });

  it("shares a parsed plan with another collection whose registry signature matches", () => {
    db.saveCachedPlan(src, "cheap", "sig1", '{"filters":[]}');
    expect(db.getCachedPlan(dst, "cheap", "sig1")).toBe('{"filters":[]}');
    expect(db.getCachedPlan(dst, "cheap", "sig2")).toBeNull();
  });
});

describe("source must be the same product", () => {
  const user = addUser("dora@example.com");
  const col = db.createCollection("Bowls", "https://shop.example/bowls", "shop.example", user);
  const weight = { key: "weight_kg", type: "number" as const, unit: "kg", label: "weight" };
  const bowl = (n: number, title: string, brand: string, description: string | null) =>
    db.upsertItem({ collectionId: col, url: `https://shop.example/bowls/${n}`, title, price: 1, currency: "KM", mainImage: null, description, identity: title.toLowerCase(), specs: { diameter_cm: 15, brand }, rawText: null });

  beforeEach(() => {
    calls.length = 0;
  });

  it("drops a value taken from another brand's product, and sends the listing's description and URL", async () => {
    const id = bowl(1, "ZDJELE SET 3/1 fi 11/13/15CM", "was", "Set   of three\nbowls with lids");
    const job = await finished(startEnrichment({ collectionId: col, userId: user, attributes: [weight], itemIds: [id] }).id);
    expect(job.status).toBe("done");

    const prompt = calls.find((c) => c.purpose === "web-lookup")!.user;
    expect(prompt).toContain("Shop listing: https://shop.example/bowls/1");
    expect(prompt).toContain("Description: Set of three bowls with lids");
    expect(prompt).toContain("Known specs: brand: was, diameter_cm: 15");

    expect(db.getItemsByIds([id])[0].specs.weight_kg).toBeUndefined();
    const fact = db.getWebFact("zdjele set 3/1 fi 11/13/15cm", "weight_kg")!;
    expect(fact.found).toBe(false);
    expect(fact.sourceUrl).toBeNull(); // two citations: neither is assumed to be the source
  });

  it("keeps a value from the same brand, linking the lone citation when no source_url is given", async () => {
    const id = bowl(2, "WMF zdjela Gourmet 24cm", "WMF", null);
    await finished(startEnrichment({ collectionId: col, userId: user, attributes: [weight], itemIds: [id] }).id);
    const item = db.getItemsByIds([id])[0];
    expect(item.specs.weight_kg).toBe(1.69);
    expect(item.sources.weight_kg?.sourceUrl).toBe("https://wmf.example/gourmet");
    expect(calls.find((c) => c.purpose === "web-lookup")!.user).not.toContain("Description:");
  });

  it("compares brands ignoring case, accents and punctuation, as whole words", () => {
    const item = (brand?: string) => ({ specs: brand ? { brand } : {} }) as never;
    expect(sourceMatches(item("Mališić"), { matched_product: "MALISIC zdjela 24" })).toBe(true);
    expect(sourceMatches(item("WMF"), { matched_brand: "w.m.f" })).toBe(false);
    expect(sourceMatches(item("was"), { matched_product: "Washable bowl set" })).toBe(false);
    expect(sourceMatches(item("was"), { matched_brand: "WAS Germany" })).toBe(true);
    expect(sourceMatches(item(), { matched_brand: "Rorence" })).toBe(true);
    expect(sourceMatches(item("was"), {})).toBe(true);
  });
});
