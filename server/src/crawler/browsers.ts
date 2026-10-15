import { browserInputSchema, browserPatchSchema, type BrowserInput, type BrowserPatch, type BrowserStatus } from "@specharvest/shared";
import { env } from "../config.ts";
import * as db from "../db/sqlite.ts";
import { createLogger, errorMessage } from "../lib/logger.ts";
import { httpError } from "../lib/http-error.ts";
import { decryptSecret, encryptSecret } from "../lib/secrets.ts";
import { browserFleet, envBrowserEndpoints, type BrowserCredentials } from "./browser.ts";
import { deleteSavedCapacity, renameSavedCapacity, savedCapacity } from "./capacity.ts";

/**
 * Remote browsers added in the admin dashboard (Browser servers), on top of the ones in PUPPETEER_WS_ENDPOINT.
 * Each has its own credentials (encrypted at rest), page limit, on/off switch and proxy setting. A change drains the
 * browser's open pages in the background and puts the new version in the pool (browser.ts browserFleet).
 */

const log = createLogger("browsers");

/** How long a changed or removed browser may finish its open pages before its connection closes. */
const DRAIN_TIMEOUT_MS = 120_000;
const UNREADABLE = "Can't be decrypted (was ENCRYPTION_KEY changed?) — enter it again.";

const aad = (id: number, field: "apiKey" | "password") => `browser:${id}:${field}`;

function readSecret(id: number, field: "apiKey" | "password", blob: string | null): { value: string | null; warning?: string } {
  if (!blob) return { value: null };
  try {
    return { value: decryptSecret(blob, aad(id, field)) };
  } catch {
    return { value: null, warning: UNREADABLE };
  }
}

export function credentialsOf(row: db.BrowserRow): BrowserCredentials {
  return { apiKey: readSecret(row.id, "apiKey", row.apiKeyEnc).value, username: row.username, password: readSecret(row.id, "password", row.passwordEnc).value };
}

/** Names the .env browsers (main, main-2…) and rented servers (<BURST_NAME>-burst-N) use. */
function checkName(name: string, exceptId?: number) {
  if (/^main(-\d+)?$/i.test(name)) throw httpError(400, `"${name}" is reserved for browsers from PUPPETEER_WS_ENDPOINT`);
  if (name.toLowerCase().startsWith(`${env.BURST_NAME}-burst`)) throw httpError(400, `Names starting with "${env.BURST_NAME}-burst" are reserved for rented servers`);
  if (db.listBrowsers().some((b) => b.id !== exceptId && b.name.toLowerCase() === name.toLowerCase())) throw httpError(409, `A browser named "${name}" already exists`);
}

function secretPatch(id: number, input: Pick<BrowserPatch, "apiKey" | "password">): Partial<db.BrowserRow> {
  const patch: Partial<db.BrowserRow> = {};
  if (input.apiKey === null) Object.assign(patch, { apiKeyEnc: null, apiKeyLast4: null });
  else if (input.apiKey !== undefined) Object.assign(patch, { apiKeyEnc: encryptSecret(input.apiKey, aad(id, "apiKey")), apiKeyLast4: input.apiKey.slice(-4) });
  if (input.password === null) patch.passwordEnc = null;
  else if (input.password !== undefined) patch.passwordEnc = encryptSecret(input.password, aad(id, "password"));
  return patch;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

function capacityOf(name: string): BrowserStatus["capacity"] {
  const saved = savedCapacity(name);
  if (!saved?.finishedAt || !saved.steps.length) return null;
  return { testedAt: saved.finishedAt, recommended: saved.recommended, bestPagesPerMin: Math.max(...saved.steps.map((s) => s.pagesPerMin)) };
}

function liveStats(name: string): BrowserStatus["live"] {
  const s = browserFleet.get(name);
  return s ? { active: s.active, tabs: s.tabs, state: s.state, pages: s.pages } : null;
}

export function listBrowserStatus(): BrowserStatus[] {
  const defaultTabs = browserFleet.defaultTabs();
  const fromEnv: BrowserStatus[] = envBrowserEndpoints().map(({ name, url }) => ({
    id: null,
    name,
    source: "env",
    host: hostOf(url),
    url: null,
    apiKey: { set: !!env.PUPPETEER_WS_API_KEY, last4: env.PUPPETEER_WS_API_KEY ? env.PUPPETEER_WS_API_KEY.slice(-4) : null },
    username: env.PUPPETEER_WS_USER ?? null,
    password: { set: !!env.PUPPETEER_WS_PASSWORD },
    tabs: null,
    defaultTabs,
    enabled: true,
    allowProxy: true,
    live: liveStats(name),
    capacity: capacityOf(name),
  }));
  const fromApp: BrowserStatus[] = db.listBrowsers().map((row) => {
    const apiKey = readSecret(row.id, "apiKey", row.apiKeyEnc);
    const password = readSecret(row.id, "password", row.passwordEnc);
    // While a change is applied, the pool may still hold the old version under the old name.
    const live = liveStats(applied.get(row.id) ?? row.name);
    return {
      id: row.id,
      name: row.name,
      source: "app",
      host: hostOf(row.url),
      url: row.url,
      apiKey: { set: !!row.apiKeyEnc, last4: row.apiKeyLast4, ...(apiKey.warning ? { warning: apiKey.warning } : {}) },
      username: row.username,
      password: { set: !!row.passwordEnc, ...(password.warning ? { warning: password.warning } : {}) },
      tabs: row.tabs,
      defaultTabs,
      enabled: row.enabled,
      allowProxy: row.allowProxy,
      live,
      capacity: capacityOf(row.name),
    };
  });
  return [...fromEnv, ...fromApp];
}

export function createBrowser(body: unknown): number {
  const input: BrowserInput = browserInputSchema.parse(body);
  checkName(input.name);
  const id = db.insertBrowser({
    name: input.name,
    url: input.url,
    username: input.username ?? null,
    tabs: input.tabs ?? null,
    enabled: input.enabled ?? true,
    allowProxy: input.allowProxy ?? true,
  });
  db.updateBrowser(id, secretPatch(id, input));
  apply(id);
  return id;
}

export function updateBrowser(id: number, body: unknown) {
  const before = db.getBrowser(id);
  if (!before) throw httpError(404, "Not found");
  const input = browserPatchSchema.parse(body);
  if (input.name !== undefined) checkName(input.name, id);
  if (input.name !== undefined && input.name !== before.name) renameSavedCapacity(before.name, input.name);
  db.updateBrowser(id, {
    name: input.name,
    url: input.url,
    username: input.username,
    tabs: input.tabs,
    enabled: input.enabled,
    allowProxy: input.allowProxy,
    ...secretPatch(id, input),
  });
  apply(id);
}

export function deleteBrowser(id: number) {
  const row = db.getBrowser(id);
  if (!row) throw httpError(404, "Not found");
  deleteSavedCapacity(row.name);
  db.deleteBrowser(id);
  apply(id);
}

// ---------- Keeping the pool in step with the table ----------

/** Browser id → the name it has in the pool now. */
const applied = new Map<number, string>();
/** Changes are applied one after another, so a drain never races the next add under the same name. */
let queue: Promise<void> = Promise.resolve();

function apply(id: number): Promise<void> {
  queue = queue.then(async () => {
    try {
      const old = applied.get(id);
      if (old !== undefined) {
        await browserFleet.removeConfigured(old, DRAIN_TIMEOUT_MS);
        applied.delete(id);
      }
      const row = db.getBrowser(id);
      if (!row?.enabled) return;
      browserFleet.addConfigured(row.name, row.url, credentialsOf(row), { tabs: row.tabs, allowProxy: row.allowProxy });
      applied.set(id, row.name);
    } catch (err) {
      log.error(`Could not apply browser #${id}`, errorMessage(err));
    }
  });
  return queue;
}

/** Puts every enabled browser from the table in the pool (server start). */
export function startConfiguredBrowsers(): Promise<void> {
  for (const row of db.listBrowsers()) if (row.enabled) void apply(row.id);
  return queue;
}

/** Test hook: resolves once every pending change is in the pool. */
export const settled = () => queue;
