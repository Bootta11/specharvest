import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-pricing-"));
process.env.DATA_DIR = dataDir;
const { estimateCost, modelOptions, parseModelsDev, refreshPrices, setPriceTable, priceTable } = await import("./pricing.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const modelsDev = {
  openai: {
    models: {
      "gpt-5-nano": { name: "GPT-5 Nano", cost: { input: 0.05, output: 0.4, cache_read: 0.005 } },
      "gpt-old": { name: "Old", status: "deprecated", cost: { input: 1, output: 2 } },
      "gpt-image": { name: "Image", modalities: { output: ["image"] }, cost: { input: 5, output: 40 } },
    },
  },
  anthropic: { models: { "claude-x": { name: "Claude X", cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } } } },
  openrouter: { models: { "meta/llama": { name: "Llama", cost: { input: 0.2, output: 0.6 } } } },
  "not-in-catalog": { models: { m: { cost: { input: 1, output: 1 } } } },
};

describe("models.dev price table", () => {
  beforeEach(() => setPriceTable(parseModelsDev(modelsDev, 1)));

  it("keeps catalog providers and text models only", () => {
    const t = priceTable()!;
    expect(Object.keys(t.providers.openai)).toEqual(["gpt-5-nano", "gpt-old"]);
    expect(t.providers["not-in-catalog"]).toBeUndefined();
    expect(t.providers.openai["gpt-old"].deprecated).toBe(true);
    expect(t.providers.anthropic["claude-x"]).toMatchObject({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
  });

  it("estimates fresh, cached and output tokens plus search fees", () => {
    // 600 fresh × $1 + 300 cache reads × $0.1 + 100 cache writes × $1.25 + 500 out × $5, per 1M tokens.
    const usage = { inputTokens: 1000, cacheReadTokens: 300, cacheWriteTokens: 100, outputTokens: 500 };
    expect(estimateCost("anthropic", "claude-x", usage)).toBeCloseTo((600 * 1 + 300 * 0.1 + 100 * 1.25 + 500 * 5) / 1e6, 10);
    // The provider's own split wins over subtracting; each web search adds the catalog fee ($0.01 for Anthropic).
    expect(estimateCost("anthropic", "claude-x", { ...usage, noCacheTokens: 500 }, 2)).toBeCloseTo((500 * 1 + 300 * 0.1 + 100 * 1.25 + 500 * 5) / 1e6 + 0.02, 10);
    // Cache reads without their own price cost like fresh input.
    expect(estimateCost("openrouter", "meta/llama", { inputTokens: 1000, cacheReadTokens: 1000, outputTokens: 0 })).toBeCloseTo(0.0002, 10);
  });

  it("prices variants like their base model and returns null for unknown models", () => {
    expect(estimateCost("openrouter", "meta/llama:free", { inputTokens: 1e6, outputTokens: 0 })).toBeCloseTo(0.2);
    expect(estimateCost("openai", "nope", { inputTokens: 10, outputTokens: 10 })).toBeNull();
    expect(estimateCost("custom", "anything", { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it("suggests current models, cheapest first", () => {
    expect(modelOptions("openai").map((m) => m.id)).toEqual(["gpt-5-nano"]);
    expect(modelOptions("openai")[0]).toEqual({ id: "gpt-5-nano", name: "GPT-5 Nano", input: 0.05, output: 0.4 });
    expect(modelOptions("deepseek")).toEqual([]);
  });

  it("stores a fresh copy, and keeps the old one when models.dev is down", async () => {
    const ok = await refreshPrices((async () => new Response(JSON.stringify(modelsDev))) as unknown as typeof fetch);
    expect(ok).toBe(true);
    const before = priceTable();
    const failed = await refreshPrices((async () => new Response("nope", { status: 503 })) as unknown as typeof fetch);
    expect(failed).toBe(false);
    expect(priceTable()).toBe(before);
  });
});
