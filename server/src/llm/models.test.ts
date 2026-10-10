import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-models-"));
process.env.DATA_DIR = dataDir;
const { forgetModelLists, listModels, parseModelList } = await import("./models.ts");
const { parseModelsDev, setPriceTable } = await import("./pricing.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("live model lists", () => {
  beforeEach(() => {
    setPriceTable(parseModelsDev({ openai: { models: { "gpt-5-nano": { name: "GPT-5 Nano", cost: { input: 0.05, output: 0.4 } }, "gpt-5-mini": { name: "GPT-5 Mini", cost: { input: 0.25, output: 2 } } } } }));
    for (const u of [1, 2, 3, 4, 5]) forgetModelLists(u);
  });

  it("reads OpenRouter's prices (USD per token → per 1M) and skips image-only models", () => {
    const list = parseModelList("openrouter", "openrouter", {
      data: [
        { id: "google/gemini-2.5-flash-lite", name: "Google: Gemini 2.5 Flash Lite", pricing: { prompt: "0.0000001", completion: "0.0000004" }, architecture: { output_modalities: ["text"] } },
        { id: "google/imagen", name: "Imagen", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["image"] } },
      ],
    });
    expect(list).toEqual([{ id: "google/gemini-2.5-flash-lite", name: "Google: Gemini 2.5 Flash Lite", input: 0.1, output: 0.4 }]);
  });

  it("reads Anthropic, Google and OpenAI-style shapes, pricing from models.dev", () => {
    expect(parseModelList("anthropic", "anthropic", { data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }] })).toEqual([
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", input: null, output: null },
    ]);
    expect(
      parseModelList("google", "google", {
        models: [
          { name: "models/gemini-flash-latest", displayName: "Gemini Flash Latest", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        ],
      }).map((m) => m.id),
    ).toEqual(["gemini-flash-latest"]);
    expect(parseModelList("openai", "openai", { data: [{ id: "gpt-5-nano" }] })).toEqual([{ id: "gpt-5-nano", name: "GPT-5 Nano", input: 0.05, output: 0.4 }]);
    expect(parseModelList("togetherai", "array", [{ id: "a", type: "chat" }, { id: "b", type: "embedding" }]).map((m) => m.id)).toEqual(["a"]);
  });

  it("lists what the key's account has, chat models only, cheapest first", async () => {
    const res = await listModels(1, "openai", "sk-test", "fast", json({ data: [{ id: "gpt-5-mini" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "gpt-5-nano" }, { id: "gpt-x-unpriced" }] }));
    expect(res.source).toBe("live");
    expect(res.models.map((m) => m.id)).toEqual(["gpt-5-nano", "gpt-5-mini", "gpt-x-unpriced"]);
  });

  it("falls back to models.dev when the list can't be fetched or there's no key", async () => {
    expect(await listModels(2, "openai", "sk-test", "fast", json({ error: "nope" }, 401))).toMatchObject({ source: "models.dev", models: [{ id: "gpt-5-nano" }, { id: "gpt-5-mini" }] });
    expect((await listModels(3, "openai", null, "fast", json({ data: [{ id: "x" }] }))).source).toBe("models.dev");
    // Perplexity has no list endpoint.
    expect((await listModels(3, "perplexity", "pplx-1", "web")).source).toBe("models.dev");
  });

  it("keeps only models that can search for web lookups, and caches per user", async () => {
    let calls = 0;
    const groq = (async () => (calls++, new Response(JSON.stringify({ data: [{ id: "openai/gpt-oss-120b" }, { id: "llama-3.3-70b-versatile" }] })))) as unknown as typeof fetch;
    expect((await listModels(4, "groq", "gsk", "fast", groq)).models.map((m) => m.id)).toEqual(["llama-3.3-70b-versatile", "openai/gpt-oss-120b"]);
    expect((await listModels(4, "groq", "gsk", "web", groq)).models.map((m) => m.id)).toEqual(["openai/gpt-oss-120b"]);
    expect(calls).toBe(1);
    forgetModelLists(4);
    await listModels(4, "groq", "gsk", "fast", groq);
    expect(calls).toBe(2);
  });
});
