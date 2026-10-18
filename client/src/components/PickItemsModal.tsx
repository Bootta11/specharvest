import { useEffect, useMemo, useState } from "react";
import type { Job, PickCandidate } from "@specharvest/shared";
import { api, safeUrl } from "../lib/api.ts";
import { ClearableInput } from "./ClearableInput.tsx";
import { Modal } from "./Modal.tsx";

/**
 * Chooses which items of a pick-first crawl to extract. Nothing starts ticked: extraction (LLM) only runs for
 * what the user picks, on their click.
 */
export function PickItemsModal({ job, onClose, onPicked }: { job: Job; onClose: () => void; onPicked: (job: Job) => void }) {
  const [candidates, setCandidates] = useState<PickCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.jobCandidates(job.id).then(setCandidates, (err) => setError((err as Error).message));
  }, [job.id]);

  // Every word must appear in the title, the card's other text or the URL.
  const shown = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!candidates || words.length === 0) return candidates ?? [];
    return candidates.filter((c) => {
      const text = `${c.title} ${c.snippet} ${c.url}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [candidates, filter]);

  const toggle = (url: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(url)) next.add(url);
      return next;
    });
  const pickAll = (list: PickCandidate[]) => setPicked((prev) => new Set([...prev, ...list.map((c) => c.url)]));
  const newCount = candidates?.filter((c) => !c.saved).length ?? 0;

  const extract = async () => {
    setBusy(true);
    setError(null);
    try {
      onPicked(await api.pickItems(job.id, [...picked]));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Pick items to extract"
      wide
      onClose={onClose}
      bodyClassName="flex min-h-0 flex-1 flex-col"
      footer={
        <>
          <div className="mr-auto min-w-0 text-xs text-stone-500">
            {error ? <span className="text-red-700 dark:text-red-300">{error}</span> : "Only the picked items are opened and read by the LLM."}
          </div>
          <button className="btn-ghost btn-sm" onClick={onClose}>
            Later
          </button>
          <button className="btn-primary btn-sm" disabled={busy || picked.size === 0} onClick={extract}>
            {busy ? "Starting…" : `Extract ${picked.size} item${picked.size === 1 ? "" : "s"}`}
          </button>
        </>
      }
    >
      <div className="space-y-2 border-b border-stone-200 p-3 dark:border-stone-800">
        <ClearableInput type="search" placeholder="Filter by title, price, place…" value={filter} onChange={(e) => setFilter(e.target.value)} onClear={() => setFilter("")} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="mr-auto text-stone-500">
            {picked.size} of {candidates?.length ?? 0} picked{filter && ` · ${shown.length} shown`}
          </span>
          <button className="font-medium text-brand-700 hover:underline dark:text-brand-100" disabled={!shown.length} onClick={() => pickAll(shown)}>
            {filter ? "Pick shown" : "Pick all"}
          </button>
          {newCount > 0 && newCount < (candidates?.length ?? 0) && (
            <button className="font-medium text-brand-700 hover:underline dark:text-brand-100" onClick={() => setPicked(new Set(candidates!.filter((c) => !c.saved).map((c) => c.url)))}>
              Only new ({newCount})
            </button>
          )}
          <button className="font-medium text-stone-600 hover:underline dark:text-stone-300" disabled={picked.size === 0} onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!candidates && !error && <p className="animate-pulse p-4 text-sm text-stone-500">Loading the list…</p>}
        {candidates && shown.length === 0 && <p className="p-4 text-sm text-stone-500">{candidates.length ? "Nothing matches the filter." : "This crawl has no items to pick."}</p>}
        <ul className="divide-y divide-stone-100 dark:divide-stone-800">
          {shown.map((c) => (
            <li key={c.url} className="[contain-intrinsic-size:auto_64px] [content-visibility:auto]">
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-800/50">
                <input type="checkbox" className="size-4 shrink-0 accent-brand-700" checked={picked.has(c.url)} onChange={() => toggle(c.url)} />
                <span className="size-12 shrink-0 overflow-hidden rounded-md bg-stone-100 dark:bg-stone-800">
                  {safeUrl(c.image) && (
                    <img
                      src={safeUrl(c.image)}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="size-full object-cover"
                      onError={(e) => (e.currentTarget.style.display = "none")}
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium" title={c.title}>
                      {c.title || c.url}
                    </span>
                    {c.saved && <span className="shrink-0 rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300">saved</span>}
                  </span>
                  {c.snippet && <span className="line-clamp-2 text-xs text-stone-500">{c.snippet}</span>}
                </span>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="shrink-0 rounded p-1.5 text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
                  title="Open the item page"
                  aria-label={`Open ${c.title || "item"}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                  </svg>
                </a>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
