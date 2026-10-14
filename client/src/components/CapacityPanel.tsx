import type { CapacityRun } from "@specharvest/shared";

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const secs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);

/** 0–100: finished steps plus the running step's elapsed share. */
export function capacityPercent(run: CapacityRun): number {
  if (!run.running) return run.phase === "done" ? 100 : Math.round((run.steps.length / run.progress.stepCount) * 100);
  const p = run.progress;
  if (run.phase !== "testing" || p.stepStartedAt == null) return Math.round((run.steps.length / p.stepCount) * 100);
  const share = Math.min(1, Math.max(0, (p.elapsedMs - (p.stepStartedAt - run.startedAt)) / p.stepMs));
  return Math.round(((p.stepIndex + share) / p.stepCount) * 100);
}

function phaseText(run: CapacityRun): string {
  const p = run.progress;
  switch (run.phase) {
    case "collecting":
      return "Collecting test pages…";
    case "pausing":
      return p.waitingPages > 0
        ? `Pausing ${run.browser} for crawls — waiting for ${p.waitingPages} open page${p.waitingPages === 1 ? "" : "s"} to finish…`
        : `Pausing ${run.browser} for crawls…`;
    case "connecting":
      return "Connecting…";
    case "testing": {
      if (p.stepStartedAt == null) return `Step ${p.stepIndex + 2} of up to ${p.stepCount} starting…`;
      const left = Math.max(0, p.stepMs - (p.elapsedMs - (p.stepStartedAt - run.startedAt)));
      return `Step ${p.stepIndex + 1} of up to ${p.stepCount} · testing ${p.stepTabs} page${p.stepTabs === 1 ? "" : "s"} at once · ${Math.ceil(left / 1000)} s left in this step`;
    }
    case "done":
      return run.note ?? "Done.";
    case "stopped":
      return "Stopped.";
    case "failed":
      return `Failed: ${run.error ?? "unknown error"}`;
  }
}

export function CapacityPanel({
  run,
  busy,
  onStop,
  onApply,
  onClose,
}: {
  run: CapacityRun;
  busy: boolean;
  onStop: () => void;
  /** null for a .env browser (its limit is SCRAPE_MAX_CONCURRENT_PAGES). */
  onApply: ((tabs: number) => void) | null;
  onClose: () => void;
}) {
  const percent = capacityPercent(run);
  const p = run.progress;
  const live = run.running && run.phase === "testing" && p.current && p.stepTabs != null ? p.current : null;
  const failed = run.phase === "failed";

  return (
    <div className="space-y-3 rounded border border-stone-200 p-3 dark:border-stone-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Capacity test · {run.browser}</h4>
        {run.running ? (
          <button className="btn-secondary" disabled={busy} onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="text-xs text-stone-500 hover:underline" onClick={onClose}>
            Hide
          </button>
        )}
      </div>

      <div>
        <div
          className="h-2 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="Capacity test progress"
        >
          <div
            className={`h-full transition-[width] duration-1000 ease-linear ${failed ? "bg-red-500" : run.running ? "bg-brand-600" : "bg-emerald-500"}`}
            style={{ width: `${Math.max(run.running ? 2 : 0, percent)}%` }}
          />
        </div>
        <p className={`mt-2 text-sm ${failed ? "text-red-700 dark:text-red-400" : ""}`}>
          {run.running && <span className="mr-1 inline-block animate-pulse">●</span>}
          {phaseText(run)}
        </p>
        <p className="text-xs text-stone-500">
          {run.running
            ? `Elapsed ${clock(p.elapsedMs)} · at most ~${clock(p.maxRemainingMs)} left (it usually stops earlier) · ${percent}%`
            : `Took ${clock(p.elapsedMs)}`}
          {run.running && live && ` · this step so far: ${live.pages} pages, ${live.pagesPerMin.toFixed(1)}/min${live.errors ? `, ${live.errors} errors` : ""}`}
        </p>
        {run.note && run.running && <p className="text-xs text-amber-700 dark:text-amber-400">{run.note}</p>}
      </div>

      {(run.steps.length > 0 || live) && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-xs">
            <thead className="text-stone-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Pages at once</th>
                <th className="py-1 pr-3 font-medium">Pages/min</th>
                <th className="py-1 pr-3 font-medium">Time per page</th>
                <th className="py-1 pr-3 font-medium">Opening</th>
                <th className="py-1 font-medium">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
              {run.steps.map((s) => (
                <tr key={s.tabs} className={s.tabs === run.recommended && !run.running ? "font-semibold text-emerald-700 dark:text-emerald-400" : ""}>
                  <td className="py-1 pr-3">{s.tabs}</td>
                  <td className="py-1 pr-3">{s.pagesPerMin.toFixed(1)}</td>
                  <td className="py-1 pr-3">
                    {secs(s.totalP50Ms)} <span className="text-stone-500">(p95 {secs(s.totalP95Ms)})</span>
                  </td>
                  <td className="py-1 pr-3">{secs(s.openP50Ms)}</td>
                  <td className="py-1" title={s.errorSamples.join("\n")}>
                    {s.errors}
                  </td>
                </tr>
              ))}
              {live && (
                <tr className="bg-brand-50 dark:bg-stone-800/60">
                  <td className="py-1 pr-3">{p.stepTabs}</td>
                  <td className="py-1 pr-3">{live.pagesPerMin.toFixed(1)}…</td>
                  <td className="py-1 pr-3 text-stone-500">{live.pages} pages so far</td>
                  <td className="py-1 pr-3 text-stone-500">—</td>
                  <td className="py-1">{live.errors}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!run.running && run.phase !== "failed" && (
        <div className="flex flex-wrap items-center gap-2">
          {run.recommended != null ? (
            <>
              <span className="text-sm">
                Recommended: <strong>{run.recommended}</strong> page{run.recommended === 1 ? "" : "s"} at once
              </span>
              {onApply ? (
                <button className="btn-primary" disabled={busy} onClick={() => onApply(run.recommended!)}>
                  Use {run.recommended} page{run.recommended === 1 ? "" : "s"}
                </button>
              ) : (
                <span className="text-xs text-stone-500">Browsers from .env all use SCRAPE_MAX_CONCURRENT_PAGES — set it there.</span>
              )}
            </>
          ) : (
            <span className="text-sm text-stone-500">Not enough results for a recommendation.</span>
          )}
        </div>
      )}
      <p className="text-xs text-stone-500">Test pages come from books.toscrape.com, which is light; real shops with heavy scripts may reach the limit a bit sooner.</p>
    </div>
  );
}
