import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError, RetryError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

// config.ts reads DATA_DIR at import time — point it at a throwaway dir first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specharvest-client-"));
process.env.DATA_DIR = dataDir;

// The resolver is swapped for a mock model; everything else (ledger, pricing) is real.
vi.mock("./resolve.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("./resolve.ts")>()), resolveModel: vi.fn() }));
const { resolveModel } = await import("./resolve.ts");
const { askForJson, classifyLlmError, countWebSearches, extractJson, LlmCredentialError, llmBlocked, salvageJson } = await import("./client.ts");
const { withLlmContext } = await import("./usage.ts");
const { parseModelsDev, setPriceTable } = await import("./pricing.ts");
const { getProvider } = await import("./providers.ts");
const db = await import("../db/sqlite.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("extractJson", () => {
  it("parses fenced and chatty responses", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":[1,2]} hope that helps')).toEqual({ a: [1, 2] });
  });

  it("repairs lone backslashes", () => {
    expect(extractJson('{"sel":".lg\\:w-1"}')).toEqual({ sel: ".lg\\:w-1" });
  });

  it("salvages a truncated spec list", () => {
    const broken = '{"title":"Car","specs":[["a",1,null],["b",true,null],["c","x';
    expect(extractJson(broken)).toEqual({ title: "Car", specs: [["a", 1, null], ["b", true, null]] });
  });
});

describe("salvageJson", () => {
  it("ignores brackets inside strings", () => {
    expect(salvageJson('{"t":"a ] b","l":[1,2],"z":"unterminated')).toEqual({ t: "a ] b", l: [1, 2] });
  });
});

// ---------- Transport (AI SDK) ----------

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

const gen = (text: string, extra: Partial<GenResult> = {}): GenResult => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: "stop" },
  usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 200, text: 200, reasoning: 0 } },
  warnings: [],
  ...extra,
});

function useModel(model: MockLanguageModelV4, providerId: string, extra: Record<string, unknown> = {}) {
  vi.mocked(resolveModel).mockReturnValue({
    provider: getProvider(providerId)!,
    modelId: model.modelId,
    funding: "platform",
    model,
    jsonMode: getProvider(providerId)!.jsonMode,
    keyOwner: null,
    ...extra,
  });
}

const lastUsage = () =>
  db.getDb().prepare("SELECT provider, model, funding, cost, cost_estimated, web_searches FROM llm_usage ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;

const schema = z.object({ answer: z.number() });

describe("askForJson", () => {
  beforeEach(() => vi.mocked(resolveModel).mockReset());

  it("retries once with the validation error, and records both calls", async () => {
    const model = new MockLanguageModelV4({ modelId: "m-1", doGenerate: [gen('{"answer":"forty-two"}'), gen('{"answer":42}')] });
    useModel(model, "openai");
    const before = db.usageSummary().byPurpose.find((p) => p.purpose === "detect")?.calls ?? 0;
    const res = await withLlmContext({}, () => askForJson(schema, "system", "user", { purpose: "detect" }));
    expect(res.data).toEqual({ answer: 42 });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("did not match the required JSON shape");
    expect(db.usageSummary().byPurpose.find((p) => p.purpose === "detect")?.calls).toBe(before + 2);
  });

  it("asks for JSON mode only where the provider supports it", async () => {
    const openai = new MockLanguageModelV4({ modelId: "m", doGenerate: gen('{"answer":1}') });
    useModel(openai, "openai");
    await askForJson(schema, "s", "u", { purpose: "detect", jsonMode: true });
    expect(openai.doGenerateCalls[0].responseFormat).toEqual({ type: "json" });

    const anthropic = new MockLanguageModelV4({ modelId: "m", doGenerate: gen('Here you go: {"answer":1}') });
    useModel(anthropic, "anthropic");
    expect((await askForJson(schema, "s", "u", { purpose: "detect", jsonMode: true })).data).toEqual({ answer: 1 });
    expect(anthropic.doGenerateCalls[0].responseFormat).toBeUndefined();
  });

  it("records the provider's exact cost when it reports one", async () => {
    const model = new MockLanguageModelV4({ modelId: "google/x", doGenerate: gen('{"answer":1}', { providerMetadata: { openrouter: { usage: { cost: 0.0123 } } } }) });
    useModel(model, "openrouter");
    await askForJson(schema, "s", "u", { purpose: "search" });
    expect(lastUsage()).toMatchObject({ provider: "openrouter", funding: "platform", cost: 0.0123, cost_estimated: 0 });
  });

  it("estimates the cost from the price list otherwise, search fees included", async () => {
    setPriceTable(parseModelsDev({ openai: { models: { "gpt-test": { cost: { input: 1, output: 2 } } } } }));
    const model = new MockLanguageModelV4({
      modelId: "gpt-test",
      doGenerate: gen('{"answer":1}', {
        content: [
          { type: "tool-call", toolCallId: "1", toolName: "web_search", input: "{}", providerExecuted: true },
          { type: "source", sourceType: "url", id: "s1", url: "https://example.com/spec", title: "Spec" },
          { type: "text", text: '{"answer":1}' },
        ],
      }),
    });
    useModel(model, "openai", { funding: "own", tools: {} });
    const res = await askForJson(schema, "s", "u", { purpose: "web-lookup", webSearch: true });
    expect(res.citations).toEqual([{ url: "https://example.com/spec", title: "Spec" }]);
    expect(res.webSearches).toBe(1);
    // 1000 in × $1 + 200 out × $2 per 1M, + 1 search × $0.01.
    expect(lastUsage()).toMatchObject({ provider: "openai", model: "gpt-test", funding: "own", cost_estimated: 1, web_searches: 1 });
    expect(lastUsage().cost as number).toBeCloseTo(0.001 + 0.0004 + 0.01, 8);
  });

  it("turns a rejected key into LlmCredentialError instead of failing item by item", async () => {
    const model = new MockLanguageModelV4({
      modelId: "m",
      doGenerate: async () => {
        throw new APICallError({ message: "Incorrect API key provided", url: "https://api.openai.com/v1/responses", requestBodyValues: {}, statusCode: 401 });
      },
    });
    useModel(model, "openai", { funding: "own" });
    const err = await askForJson(schema, "s", "u", { purpose: "extract" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmCredentialError);
    expect(llmBlocked(err)).toBe(true);
    expect((err as Error).message).toBe("Your OpenAI key was rejected — fix it in Settings → LLM provider.");
    expect((err as { statusCode: number }).statusCode).toBe(400);
  });
});

describe("classifyLlmError", () => {
  const apiError = (statusCode: number, message: string, responseBody?: string) => new APICallError({ message, url: "https://x", requestBodyValues: {}, statusCode, responseBody });

  it("tells auth, credit, model and rate-limit failures apart", () => {
    expect(classifyLlmError(apiError(401, "Unauthorized")).kind).toBe("auth");
    expect(classifyLlmError(apiError(400, "API key not valid. Please pass a valid API key.")).kind).toBe("auth");
    // OpenAI reports an empty account as 429 insufficient_quota — that's credit, not a rate limit.
    expect(classifyLlmError(apiError(429, "You exceeded your current quota", '{"error":{"code":"insufficient_quota"}}')).kind).toBe("credit");
    expect(classifyLlmError(apiError(402, "Payment required")).kind).toBe("credit");
    expect(classifyLlmError(apiError(404, "The model `gpt-9` does not exist")).kind).toBe("model");
    expect(classifyLlmError(apiError(429, "Rate limit reached")).kind).toBe("rate");
    expect(classifyLlmError(apiError(500, "Internal error")).kind).toBe("other");
    expect(classifyLlmError(new Error("socket hang up")).kind).toBe("other");
  });

  it("looks through retries at the last error", () => {
    const err = new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [apiError(429, "slow down"), apiError(401, "bad key")] });
    expect(classifyLlmError(err).kind).toBe("auth");
  });
});

describe("countWebSearches", () => {
  const base = { content: [], providerMetadata: undefined, response: { body: undefined }, sources: [] } as unknown as Parameters<typeof countWebSearches>[0];

  it("uses executed search calls, then the provider's own count, then cited sources", () => {
    expect(countWebSearches({ ...base, response: { body: { usage: { server_tool_use: { web_search_requests: 2 } } } } } as never)).toBe(2);
    expect(countWebSearches({ ...base, providerMetadata: { google: { groundingMetadata: { webSearchQueries: ["a", "b", "c"] } } } } as never)).toBe(3);
    expect(countWebSearches({ ...base, sources: [{ type: "source", sourceType: "url", id: "1", url: "https://a" }] } as never)).toBe(1);
    expect(countWebSearches(base)).toBe(0);
  });
});
