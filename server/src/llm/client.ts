import { APICallError, generateText, RetryError, wrapLanguageModel, type GenerateTextResult, type LanguageModelMiddleware, type ToolSet } from "ai";
import type { LlmPurpose } from "@specharvest/shared";
import type { z } from "zod";
import { env } from "../config.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { markKeyWorking, setKeyError } from "./keys.ts";
import { estimateCost } from "./pricing.ts";
import { LlmUnavailableError, resolveModel, SETTINGS_PATH, type ResolvedModel } from "./resolve.ts";
import { currentLlmContext, recordUsage } from "./usage.ts";

const log = createLogger("llm");

// AI SDK warnings (e.g. "temperature isn't supported by reasoning models") go to our log, once per kind.
const seenWarnings = new Set<string>();
globalThis.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
  for (const w of warnings) {
    const what = "message" in w ? w.message : `${w.type}: ${"feature" in w ? w.feature : ""}${"details" in w && w.details ? ` (${w.details})` : ""}`;
    const line = `${provider ?? "?"}/${model ?? "?"} ${what}`;
    if (seenWarnings.has(line)) continue;
    seenWarnings.add(line);
    log.warn(`AI SDK warning: ${line}`);
  }
};

/** Asks the provider for a JSON object (response_format json_object or its equivalent) without the SDK parsing it. */
const jsonModeMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({ ...params, responseFormat: { type: "json" } }),
};

const JSON_VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** Models sometimes emit a lone backslash (e.g. CSS escapes) that isn't a legal JSON escape — double it. */
function repairBadBackslashEscapes(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += ch === "\\" && !JSON_VALID_ESCAPES.has(text[i + 1]) ? "\\\\" : ch;
    if (ch === "\\" && JSON_VALID_ESCAPES.has(text[i + 1])) out += text[++i];
  }
  return out;
}

function parseWithRepair(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    try {
      return JSON.parse(repairBadBackslashEscapes(text));
    } catch {
      throw err;
    }
  }
}

/**
 * Recovers a truncated/derailed JSON document: cuts at the last complete
 * array/object element and closes every bracket still open. Lets a long
 * spec list that broke near the end keep everything before the break.
 */
export function salvageJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error("no JSON start");
  const src = text.slice(start);
  const cuts: number[] = [];
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "]" || ch === "}") cuts.push(i + 1);
  }
  for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < 400; k--, tries++) {
    const prefix = src.slice(0, cuts[k]);
    const stack: string[] = [];
    let str = false;
    for (let i = 0; i < prefix.length; i++) {
      const ch = prefix[i];
      if (str) {
        if (ch === "\\") i++;
        else if (ch === '"') str = false;
        continue;
      }
      if (ch === '"') str = true;
      else if (ch === "[" || ch === "{") stack.push(ch === "[" ? "]" : "}");
      else if (ch === "]" || ch === "}") stack.pop();
    }
    try {
      return JSON.parse(prefix + stack.reverse().join(""));
    } catch {
      /* try an earlier cut */
    }
  }
  throw new Error("could not salvage JSON");
}

/** Extracts the first JSON object/array from a possibly chatty response. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return parseWithRepair(trimmed);
  } catch {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i) ?? trimmed.match(/([[{][\s\S]*[\]}])/);
    if (match) {
      try {
        return parseWithRepair(match[1]);
      } catch {
        /* fall through to salvage */
      }
    }
    try {
      const salvaged = salvageJson(trimmed.replace(/^```(?:json)?/i, ""));
      log.warn("Parsed a truncated/broken JSON response by salvaging complete elements");
      return salvaged;
    } catch {
      throw new Error(`LLM response did not contain valid JSON: ${trimmed.slice(0, 300)}`);
    }
  }
}

export interface AskOptions {
  /** What the call is for — picks the model tier and groups spend in the usage breakdown. */
  purpose: LlmPurpose;
  maxTokens?: number;
  /** Ask the provider for a JSON object response, where it supports that. */
  jsonMode?: boolean;
  /** Give the model the provider's web search tool (web lookups). */
  webSearch?: boolean;
}

export interface AskResult<T> {
  data: T;
  /** URL sources the provider cited, when web search ran. */
  citations: Array<{ url: string; title?: string }>;
  webSearches: number;
}

// ---------- Errors ----------

export type LlmErrorKind = "auth" | "credit" | "model" | "rate" | "other";

/** What kind of provider failure this is (auth / out of credit / unknown model / rate limit / anything else). */
export function classifyLlmError(err: unknown): { kind: LlmErrorKind; status?: number; detail: string } {
  const e = RetryError.isInstance(err) ? err.lastError : err;
  if (!APICallError.isInstance(e)) return { kind: "other", detail: errorMessage(e) };
  const status = e.statusCode;
  const text = `${e.message} ${e.responseBody ?? ""}`.toLowerCase();
  const detail = e.message.slice(0, 300);
  if (/moderation|flagged/.test(text)) return { kind: "other", status, detail };
  if (status === 401 || (status === 403 && !/model/.test(text)) || /invalid api key|incorrect api key|api key not valid|invalid x-api-key|invalid_api_key|unauthorized/.test(text)) {
    return { kind: "auth", status, detail };
  }
  if (status === 402 || /insufficient_quota|insufficient credits|insufficient balance|credit balance|exceeded your current quota|payment required|billing/.test(text)) {
    return { kind: "credit", status, detail };
  }
  if (status === 404 || /model.{0,40}(not found|does not exist|not available|not supported|unknown)|no such model|invalid model|no endpoints found/.test(text)) {
    return { kind: "model", status, detail };
  }
  if (status === 429) return { kind: "rate", status, detail };
  return { kind: "other", status, detail };
}

/**
 * The key was rejected or its account is out of credit: retrying won't help, so jobs stop (resumable)
 * instead of failing every item. Own key → 400 telling the user what to fix; server key → 503.
 */
export class LlmCredentialError extends Error {
  readonly statusCode: number;
  constructor(
    message: string,
    readonly funding: "own" | "platform",
  ) {
    super(message);
    this.name = "LlmCredentialError";
    this.statusCode = funding === "own" ? 400 : 503;
  }
}

/** No LLM can run for this user right now (key rejected/out of credit, or none set up): retrying won't help. */
export function llmBlocked(err: unknown): err is LlmCredentialError | LlmUnavailableError {
  return err instanceof LlmCredentialError || err instanceof LlmUnavailableError;
}

function credentialMessage(kind: "auth" | "credit", r: ResolvedModel): string {
  const problem = kind === "auth" ? "was rejected" : "is out of credit";
  return r.funding === "own"
    ? `Your ${r.provider.label} key ${problem} — fix it in ${SETTINGS_PATH}.`
    : `The server's LLM key ${problem} — ask an admin.`;
}

// ---------- Usage ----------

type AnyResult = GenerateTextResult<ToolSet, never, never>;

/** Searches the provider ran: its executed search tool calls, else what its usage says, else 1 if it cited sources. */
export function countWebSearches(result: Pick<AnyResult, "content" | "providerMetadata" | "response" | "sources">): number {
  const calls = result.content.filter((p) => p.type === "tool-call" && p.providerExecuted && /search/i.test(p.toolName)).length;
  if (calls) return calls;
  const body = result.response.body as { usage?: { server_tool_use?: { web_search_requests?: unknown } } } | undefined;
  const meta = result.providerMetadata as
    | { perplexity?: { usage?: { numSearchQueries?: unknown } }; google?: { groundingMetadata?: { webSearchQueries?: unknown[] } } }
    | undefined;
  const reported = body?.usage?.server_tool_use?.web_search_requests ?? meta?.perplexity?.usage?.numSearchQueries ?? meta?.google?.groundingMetadata?.webSearchQueries?.length;
  if (typeof reported === "number") return reported;
  return result.sources.length > 0 ? 1 : 0;
}

function record(purpose: LlmPurpose, r: ResolvedModel, result: AnyResult, webSearches: number) {
  const u = result.usage;
  const exact = r.provider.exactCost?.(result.providerMetadata) ?? null;
  const estimate =
    exact === null
      ? estimateCost(
          r.provider.id,
          r.modelId,
          {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            noCacheTokens: u.inputTokenDetails?.noCacheTokens,
            cacheReadTokens: u.inputTokenDetails?.cacheReadTokens,
            cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens,
          },
          webSearches,
        )
      : null;
  recordUsage(purpose, {
    provider: r.provider.id,
    // The model that actually answered (OpenRouter may route an alias), else the one asked for.
    model: (r.provider.id === "openrouter" && result.response.modelId) || r.modelId,
    funding: r.funding,
    promptTokens: u.inputTokens ?? 0,
    completionTokens: u.outputTokens ?? 0,
    cost: exact ?? estimate,
    costEstimated: exact === null && estimate !== null,
    webSearches,
  });
}

// ---------- The call ----------

/** One completion through the resolved provider. Credential failures become LlmCredentialError (and are noted on the key). */
async function complete(r: ResolvedModel, system: string, prompt: string, options: AskOptions): Promise<AnyResult> {
  try {
    const result = (await generateText({
      model: options.jsonMode && r.jsonMode ? wrapLanguageModel({ model: r.model, middleware: jsonModeMiddleware }) : r.model,
      instructions: system,
      prompt,
      temperature: 0,
      maxOutputTokens: options.maxTokens ?? 4000,
      maxRetries: env.OPENROUTER_MAX_RETRIES,
      timeout: env.OPENROUTER_TIMEOUT_MS,
      ...(r.tools ? { tools: r.tools } : {}),
      ...(r.providerOptions ? { providerOptions: r.providerOptions } : {}),
    })) as unknown as AnyResult;
    if (r.keyOwner !== null) markKeyWorking(r.keyOwner, r.provider.id);
    return result;
  } catch (err) {
    const { kind, detail } = classifyLlmError(err);
    if (kind === "auth" || kind === "credit") {
      if (r.keyOwner !== null) setKeyError(r.keyOwner, r.provider.id, `${kind === "auth" ? "Rejected" : "Out of credit"}: ${detail}`);
      throw new LlmCredentialError(credentialMessage(kind, r), r.funding);
    }
    if (kind === "model" && r.keyOwner !== null) setKeyError(r.keyOwner, r.provider.id, `Model ${r.modelId}: ${detail}`);
    throw err;
  }
}

/**
 * One completion that must return JSON matching `schema`, on the provider/model the user's keys (or the
 * server key) resolve to for this purpose. Retries once with the validation error appended when the
 * model's JSON doesn't fit.
 */
export async function askForJson<T>(schema: z.ZodType<T>, system: string, user: string, options: AskOptions): Promise<AskResult<T>> {
  const r = resolveModel(currentLlmContext()?.userId ?? null, options.purpose, { webSearch: options.webSearch });
  const maxTokens = options.maxTokens ?? 4000;
  let lastError: unknown;
  let retryNote = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await complete(r, system, user + retryNote, options);
    const citations = result.sources.flatMap((s) => (s.sourceType === "url" ? [{ url: s.url, title: s.title }] : []));
    const webSearches = options.webSearch ? countWebSearches(result) : 0;
    record(options.purpose, r, result, webSearches);

    if (result.finishReason === "length") log.warn(`Response hit max_tokens (${maxTokens}) on ${r.provider.id}/${r.modelId}`);
    const content = result.text;
    if (!content) {
      lastError = new Error("LLM returned an empty response");
      continue;
    }
    try {
      const parsed = schema.safeParse(extractJson(content));
      if (parsed.success) return { data: parsed.data, citations, webSearches };
      lastError = new Error(`LLM JSON failed validation: ${parsed.error.message.slice(0, 500)}`);
      retryNote = `\n\nYour previous answer did not match the required JSON shape (${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}). Answer again with ONLY the corrected JSON object.`;
    } catch (err) {
      lastError = err;
      retryNote = "\n\nYour previous answer was not valid JSON. Answer again with ONLY one JSON object.";
    }
    log.warn(`Attempt ${attempt} failed (${r.provider.id}/${r.modelId})`, { error: String(lastError), raw: content.slice(0, 800) });
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** A tiny call to check that a key (and model) work — not added to the ledger. */
export async function probeModel(model: ResolvedModel["model"], providerOptions?: ResolvedModel["providerOptions"]): Promise<number> {
  const started = Date.now();
  await generateText({
    model,
    prompt: "Reply with OK.",
    maxOutputTokens: 16,
    maxRetries: 0,
    timeout: 30_000,
    ...(providerOptions ? { providerOptions } : {}),
  });
  return Date.now() - started;
}
