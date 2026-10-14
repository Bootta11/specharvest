import fs from "node:fs";
import { isIP } from "node:net";
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

/** A whole number; blank means the default, like unset. */
const int = (def: number, min = 0) => z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(min).default(def));

/**
 * Fastify trustProxy: which peers may set X-Forwarded-For/-Proto/-Host. Default: proxies on loopback or a
 * private network (reverse proxy on the host, a Traefik/cloudflared container). `true` would trust a client's
 * own X-Forwarded-For when the port is reachable directly — rate limits could then be dodged.
 */
const trustProxy = (v: string | undefined): boolean | string => {
  const s = v?.trim();
  if (!s) return "loopback,linklocal,uniquelocal";
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  return s;
};

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
  // Optional management key: only used to read the account credit balance.
  OPENROUTER_MANAGEMENT_KEY: optionalNonEmpty(),

  WEB_SEARCH_ENABLED: bool(true),
  WEB_SEARCH_ENGINE: z.enum(["auto", "native", "exa", "parallel", "perplexity", "firecrawl"]).default("auto"),
  // Searches one lookup may run; each costs a fee (~$0.007), so one is the default.
  WEB_SEARCH_MAX_USES: z.coerce.number().int().min(1).max(5).default(1),
  ENRICH_MAX_LOOKUPS: z.coerce.number().int().min(1).default(15),
  // Extra, likely-wanted attributes asked for in the same paid lookup and cached for later searches (0 = off).
  ENRICH_PREFETCH_MAX: z.coerce.number().int().min(0).max(30).default(12),
  ENRICH_COVERAGE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  ENRICH_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  // "Not found" web answers are retried after this many days (0 = never).
  ENRICH_NOT_FOUND_TTL_DAYS: z.coerce.number().min(0).default(30),

  // One remote browser, or several separated by commas (each takes SCRAPE_MAX_CONCURRENT_PAGES pages; crawler/browser-pool.ts).
  PUPPETEER_WS_ENDPOINT: optionalNonEmpty().refine(
    (v) => v === undefined || v.split(",").every((u) => /^wss?:\/\//.test(u.trim())),
    "PUPPETEER_WS_ENDPOINT must be a ws:// or wss:// URL (or several, comma-separated)",
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

  // On-demand browser servers while pages queue up (crawler/burst/, docs/deployment.md#extra-browser-servers-on-demand).
  BURST_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["digitalocean"]).optional()),
  BURST_DO_TOKEN: optionalNonEmpty(),
  // SpecHarvest's own public IP: the only address the servers' firewall lets in.
  BURST_ALLOWED_IP: optionalNonEmpty().refine((v) => v === undefined || isIP(v) !== 0, "BURST_ALLOWED_IP must be an IP address"),
  BURST_REGION: z.string().default("fra1"),
  BURST_SIZE: z.string().default("s-4vcpu-8gb"),
  BURST_IMAGE: z.string().default("debian-13-x64"),
  // A DigitalOcean SSH key (id or fingerprint); without one, DigitalOcean emails a root password per server.
  BURST_DO_SSH_KEY_ID: optionalNonEmpty(),
  BURST_MAX_SERVERS: int(1, 1),
  BURST_TABS: int(6, 1),
  BURST_MIN_WAITING: int(4, 1),
  BURST_AFTER_SECONDS: int(60),
  BURST_IDLE_MINUTES: int(5),
  BURST_MAX_MINUTES: int(180, 10),
  BURST_MAX_HOURS_PER_DAY: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().min(0).default(12)),
  // Names and tags the servers; instances sharing one DigitalOcean account need different names.
  BURST_NAME: z
    .string()
    .default("specharvest")
    .refine((v) => /^[a-z0-9-]{1,40}$/.test(v), "BURST_NAME: lowercase letters, digits and dashes"),
  // Abort ad/analytics requests in crawled pages (crawler/trackers.ts): less browser CPU, quicker network idle.
  SCRAPE_BLOCK_TRACKERS: bool(true),
  MAX_PAGES: z.coerce.number().int().min(1).default(10),
  MAX_ITEMS: z.coerce.number().int().min(1).default(200),
  // Most a non-admin may ask one crawl for (admins: 200 pages / 5000 items).
  MAX_PAGES_CAP: int(50, 1),
  MAX_ITEMS_CAP: int(1000, 1),
  // Crawls + web lookups one non-admin may have queued or running at once (0 = no limit).
  MAX_ACTIVE_JOBS_PER_USER: int(3),
  // Largest collection file /api/collections/import accepts.
  IMPORT_MAX_MB: int(50, 1),

  // See trustProxy() above.
  TRUST_PROXY: z
    .string()
    .optional()
    // Fastify ignores hop counts (it can't check the peer then) — name the proxies instead.
    .refine((v) => !v || !/^\s*\d+\s*$/.test(v), "TRUST_PROXY takes proxy addresses (IPs, CIDRs, loopback/linklocal/uniquelocal) or true/false, not a hop count")
    .transform(trustProxy),
  // Let crawls (and everyone's notifications) reach private/LAN addresses — only for a single-user LAN setup.
  ALLOW_PRIVATE_TARGETS: bool(false),
  // Hosts every user's notifications may reach although they're private (e.g. the bundled Apprise container).
  // Unset = "apprise"; blank = none.
  OUTBOUND_ALLOWED_HOSTS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "apprise")
        .split(/[\s,]+/)
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),

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
  // Encrypts users' LLM API keys at rest: 32 random bytes, base64 or hex (openssl rand -base64 32).
  // Blank = generated once into DATA_DIR/encryption.key (see lib/secrets.ts).
  ENCRYPTION_KEY: optionalNonEmpty(),
  // Extra origins allowed to call the API with a bearer token (comma-separated). The Android app
  // (https://localhost) is always allowed — see docs/mobile-app.md.
  APP_ORIGINS: optionalNonEmpty(),

  // Chrome Web Store page of the SpecHarvest extension, linked from the crawl form (docs/extension.md).
  EXTENSION_STORE_URL: optionalNonEmpty(),

  // Commit the image was built from (set by the Dockerfile's GIT_SHA build arg).
  APP_GIT_SHA: optionalNonEmpty(),
});

// Secrets can also come from files (Docker/Compose secrets): OPENROUTER_API_KEY_FILE=/run/secrets/openrouter.
const FILE_SECRETS = ["BURST_DO_TOKEN", "OPENROUTER_API_KEY", "OPENROUTER_MANAGEMENT_KEY", "PUPPETEER_WS_API_KEY", "PUPPETEER_WS_PASSWORD", "PROXY_PASSWORD", "VAPID_PRIVATE_KEY", "ADMIN_PASSWORD", "ENCRYPTION_KEY"];
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
  // Capacitor serves the Android app from https://localhost.
  APP_ORIGINS: ["https://localhost", "http://localhost", ...(parsed.APP_ORIGINS ?? "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean)],
};

export function requireEnv<K extends keyof typeof env>(key: K): NonNullable<(typeof env)[K]> {
  const v = env[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`${String(key)} is not configured — set it in .env`);
  }
  return v as NonNullable<(typeof env)[K]>;
}
