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
const { startEnrichment } = await import("./web.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const addUser = (email: string) =>
  Number(db.getDb().prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, 'x', 'user', ?)").run(email, Date.now()).lastInsertRowid);

async function finished(jobId: number) {
  for (let i = 0; i < 200; i++) {
    const job = db.getJob(jobId)!;
    if (job.status === "done" || job.status === "failed") return job;
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
