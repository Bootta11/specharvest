import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-usage-"));
process.env.DATA_DIR = dataDir;
const db = await import("../db/sqlite.ts");
const { recordUsage, withLlmContext } = await import("./usage.ts");

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
      recordUsage("extract", "model-a", { prompt_tokens: 1000, completion_tokens: 200, cost: 0.002 }, 0);
      recordUsage("extract", "model-a", { prompt_tokens: 500, completion_tokens: 100, cost: 0.001 }, 0);
    });
    expect(spent.cost).toBeCloseTo(0.003);
    expect(db.getJob(jobId)!.llmCost).toBeCloseTo(0.003);
    expect(db.getCollection(collectionId)!.llmCost).toBeCloseTo(0.003);
  });

  it("records calls outside any context and counts unpriced ones", () => {
    recordUsage("search", "model-b", { prompt_tokens: 300, completion_tokens: 50, cost: 0.0005 }, 0);
    recordUsage("web-lookup", "model-b", undefined, 1);

    const s = db.usageSummary();
    expect(s.allTime).toBeCloseTo(0.0035);
    expect(s.today).toBeCloseTo(0.0035);
    expect(s.last30d).toBeCloseTo(0.0035);
    expect(s.unpricedCalls).toBe(1);
    expect(s.byPurpose.find((p) => p.purpose === "extract")).toMatchObject({ calls: 2 });
    expect(s.byModel.find((m) => m.model === "model-a")).toMatchObject({ calls: 2, promptTokens: 1500, completionTokens: 300 });
    // Collection-less search doesn't leak into the collection total.
    expect(db.getCollection(collectionId)!.llmCost).toBeCloseTo(0.003);
  });

  it("keeps spend in the totals after its collection is deleted", () => {
    db.deleteCollection(collectionId);
    expect(db.usageSummary().allTime).toBeCloseTo(0.0035);
  });
});
