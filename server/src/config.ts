import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// A blank value (`PROXY_USERNAME=`) parses as "", not undefined — .env.example
// documents "leave blank to disable", so blank must behave like unset.
const optionalNonEmpty = () =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined));

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : !/^(0|false|no|off)$/i.test(v)));

const envSchema = z.object({
  PORT: z.coerce.number().default(3100),
  DATA_DIR: z.string().default("./data"),

  OPENROUTER_API_KEY: optionalNonEmpty(),
  OPENROUTER_MODEL: z.string().default("google/gemini-2.5-flash-lite"),
  OPENROUTER_EXTRACTION_MODEL: optionalNonEmpty(),
  OPENROUTER_WEB_MODEL: optionalNonEmpty(),
  // Stronger model for registry-wide judgement calls (merging duplicate keys).
  OPENROUTER_SMART_MODEL: z.string().default("google/gemini-2.5-flash"),
  OPENROUTER_MAX_RETRIES: z.coerce.number().default(3),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().default(90_000),

  WEB_SEARCH_ENABLED: bool(true),
  WEB_SEARCH_ENGINE: z.enum(["auto", "native", "exa", "parallel", "perplexity", "firecrawl"]).default("auto"),
  ENRICH_MAX_LOOKUPS: z.coerce.number().int().min(1).default(15),
  ENRICH_COVERAGE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  ENRICH_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  // "Not found" web answers are retried after this many days (0 = never).
  ENRICH_NOT_FOUND_TTL_DAYS: z.coerce.number().min(0).default(30),

  PUPPETEER_WS_ENDPOINT: optionalNonEmpty().refine(
    (v) => v === undefined || /^wss?:\/\//.test(v),
    "PUPPETEER_WS_ENDPOINT must be a ws:// or wss:// URL",
  ),
  // Auth for a gated remote browser (traefik-apikeys X-Api-Key and/or Basic auth), like price-catcher.
  PUPPETEER_WS_API_KEY: optionalNonEmpty(),
  PUPPETEER_WS_USER: optionalNonEmpty(),
  PUPPETEER_WS_PASSWORD: optionalNonEmpty(),
  // Local-dev fallback when PUPPETEER_WS_ENDPOINT is blank: launch this Chrome binary headless.
  PUPPETEER_EXECUTABLE_PATH: optionalNonEmpty(),
  PROXY_SERVER: optionalNonEmpty(),
  PROXY_USERNAME: optionalNonEmpty(),
  PROXY_PASSWORD: optionalNonEmpty(),

  SCRAPE_MAX_CONCURRENT_PAGES: z.coerce.number().int().min(1).default(2),
  MAX_PAGES: z.coerce.number().int().min(1).default(10),
  MAX_ITEMS: z.coerce.number().int().min(1).default(200),

  // Base URL used for links in notifications (e.g. https://specharvest.example). Blank = no link.
  PUBLIC_URL: optionalNonEmpty(),
  // Web Push keys; generated once and stored in the DB when blank.
  VAPID_PUBLIC_KEY: optionalNonEmpty(),
  VAPID_PRIVATE_KEY: optionalNonEmpty(),
  VAPID_SUBJECT: z.string().default("mailto:admin@localhost"),

  // First admin, created on boot when no user exists (else use `npm run seed:admin`).
  ADMIN_EMAIL: optionalNonEmpty(),
  // Blank = generate one and print it to the log once.
  ADMIN_PASSWORD: optionalNonEmpty(),
  // Secure flag on the session cookie. Blank = on when PUBLIC_URL is https.
  SESSION_COOKIE_SECURE: optionalNonEmpty(),

  // Commit the image was built from (set by the Dockerfile's GIT_SHA build arg).
  APP_GIT_SHA: optionalNonEmpty(),
});

// Secrets can also come from files (Docker/Compose secrets): OPENROUTER_API_KEY_FILE=/run/secrets/openrouter.
const FILE_SECRETS = ["OPENROUTER_API_KEY", "PUPPETEER_WS_API_KEY", "PUPPETEER_WS_PASSWORD", "PROXY_PASSWORD", "VAPID_PRIVATE_KEY", "ADMIN_PASSWORD"];
for (const key of FILE_SECRETS) {
  const file = process.env[`${key}_FILE`];
  if (file && !process.env[key]) process.env[key] = fs.readFileSync(file, "utf8").trim();
}

const parsed = envSchema.parse(process.env);

/** Repo root (server/src/config.ts → ../..), so relative DATA_DIR works the same from any cwd. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const env = {
  ...parsed,
  OPENROUTER_EXTRACTION_MODEL: parsed.OPENROUTER_EXTRACTION_MODEL ?? parsed.OPENROUTER_MODEL,
  // Web lookups need reliable tool use + JSON — default to the smart model.
  OPENROUTER_WEB_MODEL: parsed.OPENROUTER_WEB_MODEL ?? parsed.OPENROUTER_SMART_MODEL,
  DATA_DIR: path.resolve(ROOT, parsed.DATA_DIR),
  PUBLIC_URL: parsed.PUBLIC_URL?.replace(/\/+$/, ""),
  SESSION_COOKIE_SECURE:
    parsed.SESSION_COOKIE_SECURE === undefined ? !!parsed.PUBLIC_URL?.startsWith("https://") : !/^(0|false|no|off)$/i.test(parsed.SESSION_COOKIE_SECURE),
};

export function requireEnv<K extends keyof typeof env>(key: K): NonNullable<(typeof env)[K]> {
  const v = env[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`${String(key)} is not configured — set it in .env`);
  }
  return v as NonNullable<(typeof env)[K]>;
}
