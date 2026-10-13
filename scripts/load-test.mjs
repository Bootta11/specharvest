#!/usr/bin/env node
// Load test: simulates N users who each crawl a different books.toscrape.com category, follow the job
// live, browse and search the results. No dependencies — Node 24 fetch + streamed SSE.
// See docs/load-testing.md.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".run/loadtest");
const BOOKS = "https://books.toscrape.com/";
const FINISHED = new Set(["done", "failed", "stopped", "interrupted"]);
// Login and account deletion allow 10 requests a minute per IP.
const CREDENTIAL_GAP_MS = 6_500;

const HELP = `Usage: npm run loadtest -- <command> [options]

Commands:
  setup     Create test users (admin needed) and store an API key for each
  run       Simulate users: crawl a category each, follow the job, browse, search
  cleanup   Delete every test account in the state file

Options:
  --base-url <url>        Server to test (default http://localhost:3195)
  --users <n[,n…]>        setup: how many users; run: users per stage, e.g. 5,20,50 (default 5)
  --ramp <dur>            Spread each stage's arrivals over this time, e.g. 30s, 2m (default 30s)
  --max-items <n>         Items per crawl (default 10; one listing page)
  --searches <n>          Filter-only searches per user after the crawl (default 3)
  --typed-searches <n>    Typed searches per user, one small LLM call each (default 1)
  --timeout <dur>         Give up on a crawl after this long and stop it (default 10m)
  --server-pid <pid>      Sample this process's RSS/CPU (default: .run/loadtest-server.pid for the local instance)
  --keep                  Keep the test collections after the run
  -h, --help

Admin credentials (setup always, run/cleanup optional for LLM spend and fallbacks):
  LOADTEST_ADMIN_KEY=shk_…                          an admin's API key, or
  LOADTEST_ADMIN_EMAIL=… LOADTEST_ADMIN_PASSWORD=…  (defaults to the local instance's admin on localhost)`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "base-url": { type: "string", default: "http://localhost:3195" },
    users: { type: "string", default: "5" },
    ramp: { type: "string", default: "30s" },
    "max-items": { type: "string", default: "10" },
    searches: { type: "string", default: "3" },
    "typed-searches": { type: "string", default: "1" },
    timeout: { type: "string", default: "10m" },
    "server-pid": { type: "string" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];
if (opts.help || !["setup", "run", "cleanup"].includes(command)) {
  console.log(HELP);
  process.exit(opts.help ? 0 : 1);
}

const BASE = opts["base-url"].replace(/\/+$/, "");
const baseHost = new URL(BASE).hostname;
const isLocal = ["localhost", "127.0.0.1", "::1"].includes(baseHost);
const STATE_FILE = path.join(OUT_DIR, `users-${new URL(BASE).host.replace(/[^a-z0-9.-]/gi, "_")}.json`);

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));
const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number`);
  return n;
};
function duration(v) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(v).trim());
  if (!m) throw new Error(`Not a duration: ${v} (use e.g. 500ms, 30s, 2m)`);
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000 }[m[2] ?? "s"]);
}
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
function stats(values) {
  const s = values.filter((v) => v != null).sort((a, b) => a - b);
  return { count: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1) ?? null };
}
const fmtMs = (v) => (v == null ? "-" : v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
const usd = (v) => `$${(v ?? 0).toFixed(4)}`;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}
function writeState(state) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// ---------- HTTP with metrics ----------

/** Request timings of the current stage: `${METHOD} ${route}` → [{ms, status}]. */
let metrics = new Map();
function record(name, ms, status) {
  if (!metrics.has(name)) metrics.set(name, []);
  metrics.get(name).push({ ms, status });
}

/**
 * One API call. `auth` is headers; `name` groups it in the report (route without ids).
 * Returns {status, data, headers}; network errors come back as status 0.
 */
async function api(method, url, { auth = {}, body, name, timeoutMs = 120_000, track = true } = {}) {
  const started = performance.now();
  let status = 0;
  try {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status, data, headers: res.headers };
  } catch (err) {
    return { status: 0, data: { error: err.name === "TimeoutError" ? "timeout" : err.message }, headers: new Headers() };
  } finally {
    if (track) record(name ?? `${method} ${url.split("?")[0]}`, performance.now() - started, status);
  }
}

/** Like api(), but waits out 429s on rate-limited credential routes. */
async function apiPatient(method, url, o) {
  for (let attempt = 0; ; attempt++) {
    const r = await api(method, url, { ...o, track: false });
    if (r.status !== 429 || attempt >= 5) return r;
    const wait = (Number(r.headers.get("retry-after")) || 30) * 1000;
    console.log(`  rate limited, waiting ${Math.round(wait / 1000)} s…`);
    await sleep(wait);
  }
}

const errText = (r) => `${r.status} ${typeof r.data === "object" && r.data?.error ? r.data.error : String(r.data).slice(0, 200)}`;

// ---------- admin ----------

async function adminAuth({ required }) {
  if (process.env.LOADTEST_ADMIN_KEY) return { "X-Api-Key": process.env.LOADTEST_ADMIN_KEY };
  const email = process.env.LOADTEST_ADMIN_EMAIL ?? (isLocal ? "loadtest-admin@example.com" : undefined);
  const password = process.env.LOADTEST_ADMIN_PASSWORD ?? (isLocal ? "loadtest-admin-password" : undefined);
  if (email && password) {
    const r = await apiPatient("POST", "/api/auth/login", { auth: { "X-SpecHarvest-Client": "app" }, body: { email, password } });
    if (r.status === 200 && r.data?.token) {
      if (r.data.user?.role !== "admin") throw new Error(`${email} is not an admin`);
      return { Authorization: `Bearer ${r.data.token}` };
    }
    if (required) throw new Error(`Admin login failed: ${errText(r)}`);
  }
  if (required) throw new Error("Set LOADTEST_ADMIN_KEY (an admin's API key) or LOADTEST_ADMIN_EMAIL + LOADTEST_ADMIN_PASSWORD");
  return null;
}

async function llmSpend(admin) {
  if (!admin) return null;
  const r = await api("GET", "/api/usage?scope=all", { auth: admin, track: false });
  return r.status === 200 && typeof r.data?.allTime === "number" ? r.data.allTime : null;
}

// ---------- setup ----------

async function setup() {
  const want = int(opts.users.split(",").map(Number).reduce((a, b) => Math.max(a, b)), "users");
  const admin = await adminAuth({ required: true });
  const me = await api("GET", "/api/auth/me", { auth: admin, track: false });
  if (me.data?.role !== "admin") throw new Error(`Admin credentials rejected: ${errText(me)}`);

  const state = readState() ?? { baseUrl: BASE, tag: randomBytes(3).toString("hex"), runOffset: 0, users: [] };
  console.log(`${state.users.length} test user(s) already in ${path.relative(ROOT, STATE_FILE)}; want ${want}`);

  for (let i = state.users.length; i < want; i++) {
    const email = `loadtest-${state.tag}-${i + 1}@example.com`;
    const created = await api("POST", "/api/users", { auth: admin, body: { email, role: "user" }, track: false });
    if (created.status !== 201) throw new Error(`Creating ${email} failed: ${errText(created)}`);
    const password = created.data.temporaryPassword;
    if (i > 0) await sleep(CREDENTIAL_GAP_MS);
    const login = await apiPatient("POST", "/api/auth/login", { auth: { "X-SpecHarvest-Client": "app" }, body: { email, password } });
    if (login.status !== 200) throw new Error(`Login as ${email} failed: ${errText(login)}`);
    const bearer = { Authorization: `Bearer ${login.data.token}` };
    const key = await api("POST", "/api/api-keys", { auth: bearer, body: { label: "load test" }, track: false });
    if (key.status !== 201) throw new Error(`API key for ${email} failed: ${errText(key)}`);
    await api("POST", "/api/auth/logout", { auth: bearer, track: false });
    state.users.push({ id: created.data.id, email, password, apiKey: key.data.key });
    writeState(state);
    console.log(`  created ${email} (${i + 1}/${want})`);
  }

  if (!state.users.length) return;
  const user = { "X-Api-Key": state.users[0].apiKey };
  let config = await api("GET", "/api/config", { auth: user, track: false });
  if (config.status !== 200) throw new Error(`Test user can't call the API: ${errText(config)}`);
  if (!config.data.llmConfigured) {
    if (!isLocal) {
      throw new Error("Test users have no LLM access. As admin, allow the server key for everyone (Admin → LLM access) or give them a key, then run setup again.");
    }
    console.log("  allowing the server LLM key for everyone on this local instance");
    const put = await api("PUT", "/api/settings/admin", { auth: admin, body: { serverLlmAccess: "everyone" }, track: false });
    if (put.status !== 200) throw new Error(`Couldn't change LLM access: ${errText(put)}`);
    config = await api("GET", "/api/config", { auth: user, track: false });
    if (!config.data.llmConfigured) throw new Error("Still no LLM for test users — is OPENROUTER_API_KEY set on the server?");
  }
  console.log(`ready: ${state.users.length} users, LLM ok`);
}

// ---------- categories ----------

async function categories() {
  const res = await fetch(BOOKS + "index.html", { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`books.toscrape.com answered ${res.status}`);
  const html = await res.text();
  const found = [...html.matchAll(/href="(catalogue\/category\/books\/[^"]+\/index\.html)">\s*([^<]+?)\s*<\/a>/g)].map((m) => ({
    name: m[2],
    url: BOOKS + m[1],
  }));
  if (found.length < 10) throw new Error(`Found only ${found.length} categories on books.toscrape.com`);
  // Philosophy first, as in the original request.
  return found.sort((a, b) => (b.name === "Philosophy") - (a.name === "Philosophy"));
}

// ---------- monitoring ----------

function serverPid() {
  if (opts["server-pid"]) return int(opts["server-pid"], "server-pid");
  if (!isLocal || new URL(BASE).port !== "3195") return null;
  try {
    return Number(fs.readFileSync(path.join(ROOT, ".run/loadtest-server.pid"), "utf8").trim()) || null;
  } catch {
    return null;
  }
}

function startMonitor(pid) {
  const health = [];
  const proc = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const t = performance.now();
      const r = await api("GET", "/api/health", { track: false, timeoutMs: 10_000 });
      health.push({ ms: performance.now() - t, status: r.status });
      if (pid) {
        try {
          const [rss, cpu] = execFileSync("ps", ["-o", "rss=,%cpu=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
          proc.push({ rssMb: rss / 1024, cpu });
        } catch {
          /* process gone */
        }
      }
      await sleep(2000);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    const s = stats(health.map((h) => h.ms));
    return {
      health: { ...s, failures: health.filter((h) => h.status !== 200).length },
      server: proc.length ? { peakRssMb: Math.round(Math.max(...proc.map((p) => p.rssMb))), peakCpu: Math.max(...proc.map((p) => p.cpu)), avgCpu: Math.round(proc.reduce((a, p) => a + p.cpu, 0) / proc.length) } : null,
    };
  };
}

// ---------- one virtual user ----------

/**
 * Follows the job's SSE stream until it finishes, reconnecting with Last-Event-ID when the connection drops (as the
 * browser's EventSource does — proxies cut long streams). Returns timings and the last job snapshot.
 */
async function followJob(auth, jobId, acceptedAt, timeoutMs) {
  const out = { job: null, firstEventMs: null, firstItemMs: null, items: 0, maxQueue: 0, warnings: 0, reconnects: 0, timedOut: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let lastId = null;
  try {
    for (;;) {
      try {
        const connectAt = performance.now();
        const headers = { ...auth, Accept: "text/event-stream", ...(lastId ? { "Last-Event-ID": lastId } : {}) };
        const res = await fetch(`${BASE}/api/jobs/${jobId}/events`, { headers, signal: ctrl.signal });
        record("GET /api/jobs/:id/events (connect)", performance.now() - connectAt, res.status);
        if (!res.ok) throw new Error(`events answered ${res.status}`);
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const lines = buf.slice(0, idx).split("\n");
            buf = buf.slice(idx + 2);
            const id = lines.find((l) => l.startsWith("id:"));
            if (id) lastId = id.slice(3).trim();
            const dataLine = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (!dataLine) continue;
            const ev = JSON.parse(dataLine);
            out.firstEventMs ??= performance.now() - acceptedAt;
            if (ev.type === "item") {
              out.items++;
              out.firstItemMs ??= performance.now() - acceptedAt;
            } else if (ev.type === "queue") out.maxQueue = Math.max(out.maxQueue, ev.size + ev.pending);
            else if (ev.type === "log" && ev.message.startsWith("Timing")) out.timing = ev.message;
            else if (ev.type === "log" && ev.level !== "info") out.warnings++;
            else if (ev.type === "job") {
              out.job = ev.job;
              if (FINISHED.has(ev.job.status)) return out;
            }
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) throw err;
        if (out.reconnects >= 20) throw new Error(`event stream kept dropping (${err.message})`);
      }
      // Stream ended or dropped before the job finished: reconnect.
      out.reconnects++;
      await jitter(1000, 3000);
    }
  } catch (err) {
    if (ctrl.signal.aborted) {
      out.timedOut = true;
      return out;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

const SEARCH_QUERIES = ["cheapest books in stock", "books rated 5 stars under 30", "books over 40", "highest rated books"];

async function virtualUser(n, user, category, o) {
  const auth = { "X-Api-Key": user.apiKey };
  const result = { user: user.email, category: category.name, url: category.url, jobId: null, status: "not started", errors: [] };
  const fail = (step, r) => result.errors.push(`${step}: ${errText(r)}`);
  const t0 = performance.now();
  try {
    // Opening the app.
    await Promise.all([api("GET", "/api/config", { auth }), api("GET", "/api/collections", { auth }), api("GET", "/api/jobs", { auth })]);
    await jitter(500, 1500);

    const inspect = await api("POST", "/api/crawl/inspect", { auth, body: { url: category.url } });
    if (inspect.status !== 200) fail("inspect", inspect);
    else result.inspectKind = inspect.data.kind;
    await jitter(1000, 3000);

    const crawl = await api("POST", "/api/crawl", { auth, body: { url: category.url, maxPages: 1, maxItems: o.maxItems } });
    if (crawl.status !== 202) {
      fail("crawl", crawl);
      result.status = "rejected";
      return result;
    }
    const acceptedAt = performance.now();
    result.jobId = crawl.data.id;
    result.collectionId = crawl.data.collectionId;

    // While the crawl runs the UI refreshes the job list and the collection's items.
    let polling = true;
    const poller = (async () => {
      while (polling) {
        await jitter(3000, 5000);
        if (!polling) break;
        await api("GET", "/api/jobs", { auth });
        if (result.collectionId) await api("GET", `/api/items?collectionId=${result.collectionId}&limit=50`, { auth, name: "GET /api/items" });
      }
    })();
    let followed;
    try {
      followed = await followJob(auth, result.jobId, acceptedAt, o.timeoutMs);
    } finally {
      polling = false;
      await poller;
    }
    const job = followed.job;
    if (followed.timedOut) {
      result.errors.push(`crawl timed out after ${fmtMs(o.timeoutMs)}`);
      await api("POST", `/api/jobs/${result.jobId}/stop`, { auth, name: "POST /api/jobs/:id/stop" });
    }
    result.status = followed.timedOut ? "timeout" : (job?.status ?? "unknown");
    result.firstItemMs = followed.firstItemMs;
    result.totalMs = performance.now() - acceptedAt;
    result.serverMs = job?.finishedAt && job?.startedAt ? job.finishedAt - job.startedAt : null;
    result.itemsIndexed = job?.itemsIndexed ?? 0;
    result.itemsFailed = job?.itemsFailed ?? 0;
    result.llmCost = job?.llmCost ?? 0;
    result.maxQueue = followed.maxQueue;
    result.warnings = followed.warnings;
    result.reconnects = followed.reconnects;
    result.timing = followed.timing ?? null;
    if (job?.error) result.errors.push(`job: ${job.error}`);
    else if (job && job.status !== "done" && job.message) result.errors.push(`job ${job.status}: ${job.message}`);
    result.collectionId ??= job?.collectionId ?? null;

    if (result.collectionId && result.itemsIndexed > 0) {
      await api("GET", `/api/items?collectionId=${result.collectionId}&limit=50`, { auth, name: "GET /api/items" });
      for (let i = 0; i < o.searches; i++) {
        await jitter(1000, 3000);
        const s = await api("POST", "/api/search", {
          auth,
          name: "POST /api/search (filters)",
          body: { collectionId: result.collectionId, filters: [{ key: "price", op: "lt", value: 20 + Math.round(Math.random() * 40) }], facets: true, enrich: false, limit: 50 },
        });
        if (s.status !== 200) fail("filter search", s);
      }
      for (let i = 0; i < o.typedSearches; i++) {
        await jitter(1000, 3000);
        const s = await api("POST", "/api/search", {
          auth,
          name: "POST /api/search (typed)",
          body: { collectionId: result.collectionId, query: SEARCH_QUERIES[(n + i) % SEARCH_QUERIES.length], enrich: false, limit: 50 },
        });
        if (s.status !== 200) fail("typed search", s);
      }
    }
  } catch (err) {
    result.errors.push(err.message);
    if (result.status === "not started") result.status = "error";
  } finally {
    if (!o.keep && result.collectionId) {
      const d = await api("DELETE", `/api/collections/${result.collectionId}`, { auth, name: "DELETE /api/collections/:id" });
      if (d.status !== 200 && d.status !== 204) fail("delete collection", d);
    }
    result.wallMs = performance.now() - t0;
  }
  return result;
}

// ---------- run ----------

function summarize(stage) {
  const lines = [];
  lines.push(`\n=== ${stage.users} users — ${fmtMs(stage.wallMs)} ===`);
  lines.push("Requests                               count   err    p50    p95    p99    max");
  for (const [name, e] of Object.entries(stage.endpoints)) {
    lines.push(
      `  ${name.padEnd(36)} ${String(e.count).padStart(5)} ${String(e.errors).padStart(5)} ${fmtMs(e.p50).padStart(6)} ${fmtMs(e.p95).padStart(6)} ${fmtMs(e.p99).padStart(6)} ${fmtMs(e.max).padStart(6)}`,
    );
  }
  const statuses = Object.entries(stage.statuses).map(([s, c]) => `${s}×${c}`).join("  ");
  lines.push(`Statuses: ${statuses}`);
  const c = stage.crawls;
  lines.push(
    `Crawls: ${c.byStatus}  |  items ${c.itemsIndexed} (+${c.itemsFailed} failed)  |  LLM ${usd(c.llmCost)}  |  event-stream reconnects ${c.reconnects}`,
    `  time to first item  p50 ${fmtMs(c.firstItem.p50)}  p95 ${fmtMs(c.firstItem.p95)}  max ${fmtMs(c.firstItem.max)}`,
    `  crawl duration      p50 ${fmtMs(c.total.p50)}  p95 ${fmtMs(c.total.p95)}  max ${fmtMs(c.total.max)}`,
  );
  lines.push(`Health: p50 ${fmtMs(stage.health.p50)}  p95 ${fmtMs(stage.health.p95)}  max ${fmtMs(stage.health.max)}  failures ${stage.health.failures}`);
  lines.push(
    stage.llmSpendUsd != null
      ? `LLM spend (whole server): ${usd(stage.llmSpendUsd)}  ·  per user ${usd(stage.llmSpendUsd / stage.users)}  ·  per item ${c.itemsIndexed ? usd(stage.llmSpendUsd / c.itemsIndexed) : "-"}`
      : `LLM spend: ${usd(c.llmCost)} (crawls only; set admin credentials to include page checks and searches)`,
  );
  if (stage.server) lines.push(`Server process: peak RSS ${stage.server.peakRssMb} MB, CPU avg ${stage.server.avgCpu}% / peak ${stage.server.peakCpu}%`);
  // The server's own breakdown (lib/timing.ts) of the fastest, median and slowest finished crawl.
  const timed = stage.results.filter((r) => r.timing && r.status === "done").sort((a, b) => a.totalMs - b.totalMs);
  if (timed.length) {
    lines.push("Where crawl time went (server timing: fastest / median / slowest):");
    for (const r of [...new Set([timed[0], timed[Math.floor(timed.length / 2)], timed.at(-1)])]) lines.push(`  ${r.category}: ${r.timing.replace(/^Timing \(summed over parallel work\): /, "")}`);
  }
  const errs = stage.results.filter((r) => r.errors.length);
  if (errs.length) {
    lines.push(`Users with errors (${errs.length}):`);
    for (const r of errs.slice(0, 15)) lines.push(`  ${r.category}: ${r.errors.join("; ").slice(0, 300)}`);
  }
  return lines.join("\n");
}

/** One line per stage in .run/loadtest/spend.log, so spend adds up across runs and targets. */
function logSpend(stage) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const spend = stage.llmSpendUsd ?? stage.crawls.llmCost;
  const line = [new Date().toISOString(), BASE, `users=${stage.users}`, `items=${stage.crawls.itemsIndexed}`, `crawls=$${stage.crawls.llmCost.toFixed(4)}`, `total=$${spend.toFixed(4)}${stage.llmSpendUsd == null ? " (crawls only)" : ""}`].join("\t");
  fs.appendFileSync(path.join(OUT_DIR, "spend.log"), line + "\n");
}

async function run() {
  const stages = opts.users.split(",").map((v) => int(v.trim(), "users")).filter((n) => n > 0);
  const o = {
    rampMs: duration(opts.ramp),
    maxItems: int(opts["max-items"], "max-items"),
    searches: int(opts.searches, "searches"),
    typedSearches: int(opts["typed-searches"], "typed-searches"),
    timeoutMs: duration(opts.timeout),
    keep: opts.keep,
  };
  const state = readState();
  const need = Math.max(...stages);
  if (!state || state.users.length < need) {
    throw new Error(`Need ${need} test users, have ${state?.users.length ?? 0} — run: npm run loadtest -- setup --users ${need} --base-url ${BASE}`);
  }
  const health = await api("GET", "/api/health", { track: false });
  if (health.status !== 200) throw new Error(`${BASE}/api/health answered ${errText(health)}`);

  const cats = await categories();
  const admin = await adminAuth({ required: false }).catch(() => null);
  const pid = serverPid();
  const spendBefore = await llmSpend(admin);
  console.log(`Target ${BASE} · stages ${stages.join(", ")} · ramp ${opts.ramp} · ${o.maxItems} items/crawl · ${cats.length} categories${pid ? ` · sampling pid ${pid}` : ""}`);
  if (need > cats.length) console.log(`  note: more users than categories — categories repeat (shared host detection, but each user still extracts its own items)`);

  const report = { startedAt: new Date().toISOString(), baseUrl: BASE, options: { ...o, stages }, stages: [] };
  for (const users of stages) {
    metrics = new Map();
    const stageSpendBefore = await llmSpend(admin);
    const stopMonitor = startMonitor(pid);
    const started = performance.now();
    const offset = state.runOffset;
    console.log(`\n▶ ${users} users arriving over ${opts.ramp} (categories from #${offset % cats.length})`);
    const results = await Promise.all(
      Array.from({ length: users }, async (_, i) => {
        await sleep((o.rampMs * i) / users);
        const r = await virtualUser(i, state.users[i], cats[(offset + i) % cats.length], o);
        process.stdout.write(`  ${r.status === "done" ? "✓" : "✗"} ${r.category} (${r.status}, ${r.itemsIndexed ?? 0} items, ${fmtMs(r.totalMs)})\n`);
        return r;
      }),
    );
    const wallMs = performance.now() - started;
    const { health: h, server } = await stopMonitor();
    state.runOffset = offset + users;
    writeState(state);

    const endpoints = {};
    const statuses = {};
    for (const [name, rows] of [...metrics.entries()].sort()) {
      endpoints[name] = { ...stats(rows.map((r) => r.ms)), errors: rows.filter((r) => r.status === 0 || r.status >= 400).length };
      for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }
    const byStatus = {};
    for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const stage = {
      users,
      wallMs,
      endpoints,
      statuses,
      health: h,
      server,
      crawls: {
        byStatus: Object.entries(byStatus).map(([s, c]) => `${s} ${c}`).join(", "),
        itemsIndexed: results.reduce((a, r) => a + (r.itemsIndexed ?? 0), 0),
        itemsFailed: results.reduce((a, r) => a + (r.itemsFailed ?? 0), 0),
        llmCost: results.reduce((a, r) => a + (r.llmCost ?? 0), 0),
        reconnects: results.reduce((a, r) => a + (r.reconnects ?? 0), 0),
        firstItem: stats(results.map((r) => r.firstItemMs)),
        total: stats(results.map((r) => r.totalMs)),
        serverDuration: stats(results.map((r) => r.serverMs)),
      },
      results,
    };
    // Whole-server spend (crawls + searches + page checks) when admin credentials are set; else the jobs' own cost.
    const stageSpendAfter = await llmSpend(admin);
    stage.llmSpendUsd = stageSpendBefore != null && stageSpendAfter != null ? stageSpendAfter - stageSpendBefore : null;
    report.stages.push(stage);
    console.log(summarize(stage));
    logSpend(stage);
  }

  const spendAfter = await llmSpend(admin);
  if (spendBefore != null && spendAfter != null) report.llmSpendUsd = spendAfter - spendBefore;
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `report-${report.startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nLLM spend: ${usd(report.llmSpendUsd ?? report.stages.reduce((a, s) => a + s.crawls.llmCost, 0))}${report.llmSpendUsd == null ? " (crawls only; set admin credentials to include searches)" : ""}`);
  console.log(`Report: ${path.relative(ROOT, file)}`);
}

// ---------- cleanup ----------

async function cleanup() {
  const state = readState();
  if (!state?.users.length) {
    console.log(`Nothing to clean up (${path.relative(ROOT, STATE_FILE)} has no users)`);
    return;
  }
  const left = [];
  for (const [i, u] of state.users.entries()) {
    if (i > 0) await sleep(CREDENTIAL_GAP_MS);
    const r = await apiPatient("DELETE", "/api/auth/me", { auth: { "X-Api-Key": u.apiKey }, body: { currentPassword: u.password } });
    if (r.status === 204 || r.status === 401) console.log(`  deleted ${u.email}`);
    else {
      console.log(`  ${u.email}: ${errText(r)}`);
      left.push(u);
    }
  }
  if (left.length) {
    writeState({ ...state, users: left });
    throw new Error(`${left.length} account(s) not deleted — kept in the state file`);
  }
  fs.rmSync(STATE_FILE);
  console.log("All test accounts deleted");
}

try {
  await { setup, run, cleanup }[command]();
} catch (err) {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
}
