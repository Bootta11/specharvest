import { useEffect, useRef, useState } from "react";
import { isActiveJob, type Job } from "@specharvest/shared";
import { formatUsd, type JobStream } from "../lib/api.ts";

const statusStyle: Record<Job["status"], string> = {
  queued: "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  running: "bg-brand-100 text-brand-800 dark:bg-brand-900 dark:text-brand-100",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  stopped: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  interrupted: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
};

const barStyle = (status: Job["status"]) =>
  status === "failed" ? "bg-red-500" : status === "stopped" || status === "interrupted" ? "bg-amber-500" : "bg-brand-600";

/** Share of found items processed, 0–100. */
export function jobPercent(job: Job): number {
  const done = job.itemsIndexed + job.itemsFailed;
  return job.itemsFound > 0 ? Math.min(100, Math.round((done / job.itemsFound) * 100)) : job.status === "done" ? 100 : 0;
}

export function StatusBadge({ status }: { status: Job["status"] }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyle[status]}`}>{status}</span>;
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="min-w-0">
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="truncate text-xs text-stone-500">{label}</div>
    </div>
  );
}

interface JobProgressProps {
  stream: JobStream;
  title: string;
  onStop?: (job: Job) => Promise<void>;
  onResume?: (job: Job) => Promise<void>;
}

export function JobProgress({ stream, title, onStop, onResume }: JobProgressProps) {
  const { job, logs, recentItems, queue } = stream;
  const [showLog, setShowLog] = useState(false);
  const [acting, setActing] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, showLog]);

  if (!job) return <div className="card animate-pulse p-4 text-sm text-stone-500">Connecting…</div>;
  const pct = jobPercent(job);
  const stopping = job.message === "Stopping…";
  const act = (fn: (job: Job) => Promise<void>) => async () => {
    setActing(true);
    try {
      await fn(job);
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-medium">{title}</h3>
        {onStop && job.kind === "crawl" && job.status === "running" && (
          <button className="btn-ghost btn-sm" disabled={acting || stopping} onClick={act(onStop)}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
        {onResume && job.resumable && (
          <button className="btn-primary btn-sm" disabled={acting} onClick={act(onResume)}>
            {acting ? "Resuming…" : "Resume"}
          </button>
        )}
        <StatusBadge status={job.status} />
      </div>
      {job.message && <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">{job.message}</p>}
      {job.error && <p className="mt-1 text-sm text-red-700 dark:text-red-300">{job.error}</p>}

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
        <div className={`h-full rounded-full transition-all ${barStyle(job.status)}`} style={{ width: `${pct}%` }} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {job.kind === "crawl" ? (
          <>
            <Stat label="pages walked" value={job.pagesSeen} />
            <Stat label="items found" value={job.itemsFound} />
            <Stat label="indexed" value={job.itemsIndexed} />
            <Stat label={queue && isActiveJob(job) ? `failed · ${queue.size + queue.pending} in queue` : "failed"} value={job.itemsFailed} />
            <Stat label="LLM cost" value={formatUsd(job.llmCost)} />
          </>
        ) : (
          <>
            <Stat label="products" value={job.itemsFound} />
            <Stat label="resolved" value={job.itemsIndexed} />
            <Stat label="web searches" value={job.webSearches} />
            <Stat label="failed" value={job.itemsFailed} />
            <Stat label="LLM cost" value={formatUsd(job.llmCost)} />
          </>
        )}
      </div>

      {recentItems.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {recentItems.slice(0, 4).map((it) => (
            <li key={it.url} className="truncate text-stone-600 dark:text-stone-400">
              <span className="text-emerald-600">✓</span> {it.title}
            </li>
          ))}
        </ul>
      )}

      {logs.length > 0 && (
        <div className="mt-3">
          <button className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-500" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Hide log" : `Show log (${logs.length})`}
          </button>
          {showLog && (
            <div ref={logRef} className="mt-2 max-h-56 overflow-y-auto rounded-lg bg-stone-950 p-3 font-mono text-[11px] leading-relaxed text-stone-300">
              {logs.map((l, i) => (
                <div key={i} className={l.level === "warn" ? "text-amber-300" : l.level === "error" ? "text-red-300" : ""}>
                  {l.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
