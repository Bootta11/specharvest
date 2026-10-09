import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-usage-"));
process.env.DATA_DIR = dataDir;
const db = await import("../db/sqlite.ts");
const { recordUsage, withLlmContext } = await import("./usage.ts");

const call = (model: string, promptTokens: number, completionTokens: number, cost: number | null, extra: Partial<Parameters<typeof recordUsage>[1]> = {}) => ({
  provider: "openrouter",
  model,
  funding: "platform" as const,
  promptTokens,
  completionTokens,
  cost,
  costEstimated: false,
  webSearches: 0,
  ...extra,
});

describe("LLM usage ledger", () => {
  let collectionId: number;
  let jobId: number;

  beforeAll(() => {
    collectionId = db.createCollection("shop", "https://shop.example/cars", "shop.example");
    jobId = db.createJob("crawl", collectionId).id;
  });
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it("attributes calls to the surrounding job, collection and accumulator", async () => {
    const spent = { cost: 0 };
    await withLlmContext({ jobId, collectionId, spent }, async () => {
      await Promise.resolve();
      recordUsage("extract", call("model-a", 1000, 200, 0.002));
      recordUsage("extract", call("model-a", 500, 100, 0.001));
    });
    expect(spent.cost).toBeCloseTo(0.003);
    expect(db.getJob(jobId)!.llmCost).toBeCloseTo(0.003);
    expect(db.getCollection(collectionId)!.llmCost).toBeCloseTo(0.003);
  });

  it("records calls outside any context and counts unpriced ones", () => {
    recordUsage("search", call("model-b", 300, 50, 0.0005));
    recordUsage("web-lookup", call("model-b", 0, 0, null, { webSearches: 1 }));

    const s = db.usageSummary();
    expect(s.allTime).toBeCloseTo(0.0035);
    expect(s.today).toBeCloseTo(0.0035);
    expect(s.last30d).toBeCloseTo(0.0035);
    expect(s.unpricedCalls).toBe(1);
    expect(s.byPurpose.find((p) => p.purpose === "extract")).toMatchObject({ calls: 2 });
    expect(s.byModel.find((m) => m.model === "model-a")).toMatchObject({ provider: "openrouter", calls: 2, promptTokens: 1500, completionTokens: 300 });
    // Collection-less search doesn't leak into the collection total.
    expect(db.getCollection(collectionId)!.llmCost).toBeCloseTo(0.003);
  });

  it("splits spend by who paid and totals estimated costs", () => {
    recordUsage("extract", call("gpt-5-nano", 1000, 100, 0.0001, { provider: "openai", funding: "own", costEstimated: true }));
    const s = db.usageSummary();
    expect(s.byFunding.own).toBeCloseTo(0.0001);
    expect(s.byFunding.platform).toBeCloseTo(0.0035);
    expect(s.estimated).toBeCloseTo(0.0001);
    // Same model name under another provider is its own row.
    expect(s.byModel.find((m) => m.provider === "openai")).toMatchObject({ model: "gpt-5-nano", calls: 1 });
  });

  it("keeps spend in the totals after its collection is deleted", () => {
    db.deleteCollection(collectionId);
    expect(db.usageSummary().allTime).toBeCloseTo(0.0036);
  });
});
