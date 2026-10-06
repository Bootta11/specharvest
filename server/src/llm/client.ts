import OpenAI from "openai";
import type { LlmPurpose } from "@specharvest/shared";
import type { z } from "zod";
import { env, requireEnv } from "../config.ts";
import { createLogger } from "../lib/logger.ts";
import { recordUsage, type CompletionUsage } from "./usage.ts";

const log = createLogger("llm");

let client: OpenAI | null = null;

export function openrouter(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: requireEnv("OPENROUTER_API_KEY"),
      baseURL: "https://openrouter.ai/api/v1",
      maxRetries: env.OPENROUTER_MAX_RETRIES,
      timeout: env.OPENROUTER_TIMEOUT_MS,
      defaultHeaders: { "X-Title": "SpecHarvest" },
    });
  }
  return client;
}

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
  /** What the call is for — groups spend in the usage breakdown. */
  purpose: LlmPurpose;
  model?: string;
  /** Extra request fields (e.g. OpenRouter server tools). */
  extra?: Record<string, unknown>;
  maxTokens?: number;
  /** Ask the provider for a JSON object response (response_format json_object). */
  jsonMode?: boolean;
}

export interface AskResult<T> {
  data: T;
  /** url_citation annotations, when web search ran. */
  citations: Array<{ url: string; title?: string }>;
  webSearches: number;
}

/**
 * One chat completion that must return JSON matching `schema`. Retries once
 * with the validation error appended when the model's JSON doesn't fit.
 */
export async function askForJson<T>(schema: z.ZodType<T>, system: string, user: string, options: AskOptions): Promise<AskResult<T>> {
  const model = options.model ?? env.OPENROUTER_MODEL;
  let lastError: unknown;
  let retryNote = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await openrouter().chat.completions.create({
      model,
      temperature: 0,
      max_tokens: options.maxTokens ?? 4000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user + retryNote },
      ],
      // OpenRouter usage accounting: adds `usage.cost` (USD) to the response.
      usage: { include: true },
      ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(options.extra ?? {}),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming);

    const message = completion.choices[0]?.message;
    const content = message?.content;
    const annotations = ((message as unknown as { annotations?: Array<{ type: string; url_citation?: { url: string; title?: string } }> })?.annotations ?? [])
      .filter((a) => a.type === "url_citation" && a.url_citation?.url)
      .map((a) => ({ url: a.url_citation!.url, title: a.url_citation!.title }));
    const usage = completion.usage as unknown as CompletionUsage | undefined;
    const webSearches = usage?.server_tool_use?.web_search_requests ?? (annotations.length > 0 ? 1 : 0);
    recordUsage(options.purpose, completion.model ?? model, usage, webSearches);

    if (completion.choices[0]?.finish_reason === "length") {
      log.warn(`Response hit max_tokens (${options.maxTokens ?? 4000}) on ${model}`);
    }
    if (!content) {
      lastError = new Error("LLM returned an empty response");
      continue;
    }
    try {
      const parsed = schema.safeParse(extractJson(content));
      if (parsed.success) return { data: parsed.data, citations: annotations, webSearches };
      lastError = new Error(`LLM JSON failed validation: ${parsed.error.message.slice(0, 500)}`);
      retryNote = `\n\nYour previous answer did not match the required JSON shape (${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}). Answer again with ONLY the corrected JSON object.`;
    } catch (err) {
      lastError = err;
      retryNote = "\n\nYour previous answer was not valid JSON. Answer again with ONLY one JSON object.";
    }
    log.warn(`Attempt ${attempt} failed (${model})`, { error: String(lastError), raw: content.slice(0, 800) });
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
