import { currentLlmContext } from "../llm/usage.ts";

/**
 * Where a crawl's time goes: page-slot waits, page loads by phase, LLM calls, embeddings. Every timed step adds
 * to the job it runs under (found through the job's LLM context, which already follows its async work), and the
 * crawl logs one summary line when it ends. Durations are summed over parallel work, so they can add up to more
 * than the crawl's wall time.
 */

interface Bucket {
  count: number;
  ms: number;
}

const jobs = new Map<number, { startedAt: number; buckets: Map<string, Bucket> }>();

export function startJobTiming(jobId: number) {
  jobs.set(jobId, { startedAt: performance.now(), buckets: new Map() });
}

/** Adds `ms` to bucket `name` of the job the caller runs under (no-op outside a job, e.g. a page check). */
export function addTiming(name: string, ms: number, count = 1) {
  const jobId = currentLlmContext()?.jobId;
  const job = jobId === undefined ? undefined : jobs.get(jobId);
  if (!job) return;
  const b = job.buckets.get(name) ?? { count: 0, ms: 0 };
  b.count += count;
  b.ms += ms;
  job.buckets.set(name, b);
}

/** Runs `fn` and adds its duration to bucket `name`. */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    addTiming(name, performance.now() - t0);
  }
}

// ---------- Per page ----------

/** Phase durations of one open page (keyed by its driver), for the page's own log line. */
const pagePhases = new WeakMap<object, { url: string | null; phases: Record<string, number> }>();

export function notePageUrl(page: object, url: string) {
  const p = pagePhases.get(page) ?? { url: null, phases: {} };
  p.url = url;
  pagePhases.set(page, p);
}

/** Records one phase of loading a page (goto, idle, scroll…), on the page and on its job. */
export function notePagePhase(page: object, phase: string, ms: number) {
  const p = pagePhases.get(page) ?? { url: null, phases: {} };
  p.phases[phase] = (p.phases[phase] ?? 0) + ms;
  pagePhases.set(page, p);
  addTiming(`page.${phase}`, ms);
}

export function takePagePhases(page: object) {
  const p = pagePhases.get(page);
  pagePhases.delete(page);
  return p ?? { url: null, phases: {} };
}

// ---------- Summary ----------

export const fmtMs = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

const PAGE_PHASES: Array<[string, string]> = [
  ["goto", "goto"],
  ["idle", "network idle"],
  ["scroll", "scroll"],
  ["settle", "text settle"],
];
const OPEN_PHASES: Array<[string, string]> = [
  ["context", "context"],
  ["newPage", "new page"],
  ["setup", "setup"],
];

/** The job's timing summary (and forgets it); null when nothing was timed. */
export function finishJobTiming(jobId: number): string | null {
  const job = jobs.get(jobId);
  jobs.delete(jobId);
  if (!job || job.buckets.size === 0) return null;
  const b = (name: string) => job.buckets.get(name) ?? { count: 0, ms: 0 };
  const parts = [`${fmtMs(performance.now() - job.startedAt)} total`];

  const pages = b("page.work");
  if (pages.count) {
    const wait = b("page.wait");
    const list = (items: Array<[string, string]>) =>
      items
        .map(([k, label]) => [label, b(k).ms] as const)
        .filter(([, ms]) => ms > 0)
        .map(([label, ms]) => `${label} ${fmtMs(ms)}`);
    const phases = list(PAGE_PHASES.map(([k, label]) => [`page.${k}`, label]));
    const open = b("page.open");
    const openPhases = list(OPEN_PHASES.map(([k, label]) => [`page.open.${k}`, label]));
    const checks = b("page.filter");
    const blocked = [
      [b("page.trackers").count, "trackers"],
      [b("page.prefetches").count, "prefetches"],
    ]
      .filter(([n]) => n)
      .map(([n, what]) => `${n} ${what}`)
      .join(" + ");
    const blockedPart = blocked ? `${blocked} blocked` : "";
    parts.push(
      `${pages.count} pages: waited for a free browser page ${fmtMs(wait.ms)} (avg ${fmtMs(wait.ms / pages.count)}), ` +
        `opening ${fmtMs(open.ms)} (avg ${fmtMs(open.ms / pages.count)}${openPhases.length ? `: ${openPhases.join(", ")}` : ""}), ` +
        `loading ${fmtMs(pages.ms)} (avg ${fmtMs(pages.ms / pages.count)}${phases.length ? `: ${phases.join(", ")}` : ""})` +
        (checks.count ? `, request checks ${fmtMs(checks.ms)} (${[`${checks.count} requests`, blockedPart].filter(Boolean).join(", ")})` : ""),
    );
  }

  const llm = [...job.buckets.entries()].filter(([k]) => k.startsWith("llm."));
  if (llm.length) {
    const calls = llm.reduce((n, [, v]) => n + v.count, 0);
    const ms = llm.reduce((n, [, v]) => n + v.ms, 0);
    parts.push(`LLM ${calls} calls ${fmtMs(ms)} (${llm.map(([k, v]) => `${k.slice(4)} ${v.count}× ${fmtMs(v.ms)}`).join(", ")})`);
  }

  for (const [name, label] of [
    ["embed", "embedding"],
    ["consolidate", "key merging"],
    ["group", "product grouping"],
  ]) {
    const v = b(name);
    if (v.count) parts.push(`${label} ${v.count > 1 ? `${v.count}× ` : ""}${fmtMs(v.ms)}`);
  }
  return `Timing (summed over parallel work): ${parts.join(" · ")}`;
}
