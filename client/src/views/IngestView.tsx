import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { isActiveJob, type Collection, type CollectionGroup, type CrawlMode, type Job } from "@specharvest/shared";
import { api, downloadExport, formatUsd, storageGet, storageSet, useJobStream, type AppConfig, type JobsFeed, type SearchScope } from "../lib/api.ts";
import { JobProgress, StatusBadge, jobPercent } from "../components/JobProgress.tsx";
import { ProductsModal } from "../components/ProductsModal.tsx";
import { GroupModal } from "../components/GroupModal.tsx";
import { clearPendingShare, peekPendingShare, sameUrl } from "../lib/share.ts";
import { ClearableInput } from "../components/ClearableInput.tsx";

interface Props {
  config: AppConfig | null;
  collections: Collection[];
  groups: CollectionGroup[];
  feed: JobsFeed;
  onChanged: () => void;
  onSearch: (scope: SearchScope) => void;
}

const MODES: Array<{ value: CrawlMode; label: string; hint: string }> = [
  { value: "quick", label: "Quick check", hint: "Compares listing tiles; opens an ad only if its tile changed. AI reads only new or changed ads." },
  { value: "deep", label: "Deep check", hint: "Opens every saved ad and compares its text. AI reads only new or changed ads." },
  { value: "full", label: "Re-extract all", hint: "AI reads every ad again, changed or not. Slowest and most expensive." },
];

const timeAgo = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
};

const jobLabel = (j: Job) => `${j.kind === "crawl" ? "Crawl" : "Web lookup"} #${j.id}`;

export function IngestView({ config, collections, groups, feed, onChanged, onSearch }: Props) {
  /** A link shared from another app (Android), prefilled below until a crawl starts or it's dismissed. */
  const [shared, setShared] = useState(peekPendingShare);
  const [url, setUrl] = useState(() => shared?.url ?? "");
  const [name, setName] = useState(() => shared?.title ?? "");
  const [maxPages, setMaxPages] = useState<number | "">("");
  const [maxItems, setMaxItems] = useState<number | "">("");
  const [useProxy, setUseProxy] = useState(false);
  const [mode, setMode] = useState<CrawlMode>(() => (storageGet("crawlMode") as CrawlMode | null) ?? "quick");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(() => Number(storageGet("crawlJobId")) || null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [streamNonce, setStreamNonce] = useState(0);
  const [productsOf, setProductsOf] = useState<Collection | null>(null);
  /** The group being edited; null = a new one. */
  const [editingGroup, setEditingGroup] = useState<CollectionGroup | null | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const stream = useJobStream(jobId, streamNonce);

  const loadJobs = () => api.jobs().then(setJobs, () => {});
  useEffect(() => {
    loadJobs();
  }, []);

  // Read during render (pure), cleared here once shown.
  useEffect(() => {
    if (!shared) return;
    clearPendingShare();
    window.scrollTo({ top: 0 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A shared link fills every field: the limits get the server defaults (config may arrive after mount).
  useEffect(() => {
    if (!shared || !config) return;
    setMaxPages((v) => (v === "" ? config.defaults.maxPages : v));
    setMaxItems((v) => (v === "" ? config.defaults.maxItems : v));
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const sharedMatch = shared ? collections.find((c) => c.canEdit && sameUrl(c.startUrl, shared.url)) : undefined;

  // Refresh lists when the watched job finishes.
  const finished = !!stream.job && !isActiveJob(stream.job);
  useEffect(() => {
    if (finished) {
      onChanged();
      loadJobs();
    }
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetched history merged with live snapshots from the feed, newest first.
  const recentJobs = (() => {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    for (const j of feed.jobs.values()) byId.set(j.id, j);
    return [...byId.values()].sort((a, b) => b.id - a.id);
  })();
  const collectionName = (id: number | null) => collections.find((c) => c.id === id)?.name ?? null;
  const selectJob = (id: number) => {
    setJobId(id);
    storageSet("crawlJobId", String(id));
  };

  const chooseMode = (m: CrawlMode) => {
    setMode(m);
    storageSet("crawlMode", m);
  };

  const start = async (body: { url: string; collectionId?: number; name?: string; maxPages?: number; maxItems?: number; useProxy?: boolean; mode: CrawlMode }) => {
    setBusy(true);
    setError(null);
    try {
      const job = await api.crawl(body);
      selectJob(job.id);
      setShared(null);
      if (body.name) setName("");
      onChanged();
      loadJobs();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    start({
      url: url.trim(),
      name: name.trim() || undefined,
      maxPages: maxPages || undefined,
      maxItems: maxItems || undefined,
      useProxy: useProxy || undefined,
      mode,
    });
  };

  const stopJob = async (j: Job) => {
    setError(null);
    await api.stopJob(j.id).catch((err) => setError((err as Error).message));
  };

  const resumeJob = async (j: Job) => {
    setError(null);
    try {
      await api.resumeJob(j.id);
      selectJob(j.id);
      // Same job id — reconnect its stream to follow the resumed run.
      setStreamNonce((n) => n + 1);
      loadJobs();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (c: Collection) => {
    if (!window.confirm(`Delete "${c.name}" and its ${c.itemCount} items?`)) return;
    await api.deleteCollection(c.id).catch((err) => setError((err as Error).message));
    onChanged();
  };

  const toggleShared = async (c: Collection) => {
    setError(null);
    await api.shareCollection(c.id, !c.isShared).catch((err) => setError((err as Error).message));
    onChanged();
  };

  const rename = async (c: Collection) => {
    const name = window.prompt("Collection name", c.name)?.trim();
    if (!name || name === c.name) return;
    await api.renameCollection(c.id, name).catch((err) => setError((err as Error).message));
    onChanged();
  };

  const removeGroup = async (g: CollectionGroup) => {
    if (!window.confirm(`Delete group "${g.name}"? Its collections stay.`)) return;
    await api.deleteGroup(g.id).catch((err) => setError((err as Error).message));
    onChanged();
  };

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} isn't a SpecHarvest export (not valid JSON)`);
      }
      await api.importCollection(data);
      onChanged();
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className="space-y-4">
        {shared && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-900 dark:border-brand-900 dark:bg-brand-900/30 dark:text-brand-100">
            <div className="min-w-0 flex-1 basis-56">
              <div className="font-medium">Shared link</div>
              <div className="truncate text-xs opacity-80" title={shared.url}>
                {shared.url}
              </div>
              <div className="mt-1">
                {sharedMatch ? (
                  <>
                    Already collected as <span className="font-medium">{sharedMatch.name}</span> — re-crawl it, or start a new collection below.
                  </>
                ) : (
                  "Review the settings below and tap Start crawl."
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {sharedMatch && (
                <button className="btn-primary btn-sm" disabled={busy} onClick={() => start({ url: sharedMatch.startUrl, collectionId: sharedMatch.id, mode })}>
                  Re-crawl
                </button>
              )}
              <button className="btn-ghost btn-sm" onClick={() => setShared(null)} aria-label="Dismiss shared link">
                Dismiss
              </button>
            </div>
          </div>
        )}
        <form onSubmit={submit} className="card space-y-4 p-4 sm:p-5">
          <div>
            <h2 className="text-lg font-semibold">Crawl a shop listing</h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Paste a category or search-results URL. Item cards and pagination are detected automatically, every item page is read, and its specs are normalized.
            </p>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Listing URL</span>
            <ClearableInput type="url" required placeholder="https://shop.example/category?…" value={url} onChange={(e) => setUrl(e.target.value)} onClear={() => setUrl("")} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">
              Title <span className="font-normal text-stone-500">(optional)</span>
            </span>
            <ClearableInput type="text" maxLength={200} placeholder="Defaults to the page title" value={name} onChange={(e) => setName(e.target.value)} onClear={() => setName("")} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Max pages</span>
              <ClearableInput
                type="number"
                min={1}
                max={config?.limits.maxPages ?? 200}
                placeholder={String(config?.defaults.maxPages ?? 10)}
                value={maxPages}
                onChange={(e) => setMaxPages(e.target.value ? Number(e.target.value) : "")}
                onClear={() => setMaxPages("")}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Max items</span>
              <ClearableInput
                type="number"
                min={1}
                max={config?.limits.maxItems ?? 5000}
                placeholder={String(config?.defaults.maxItems ?? 200)}
                value={maxItems}
                onChange={(e) => setMaxItems(e.target.value ? Number(e.target.value) : "")}
                onClear={() => setMaxItems("")}
              />
            </label>
          </div>
          <fieldset>
            <legend className="mb-1 block text-sm font-medium">Already saved ads</legend>
            <div role="radiogroup" className="grid grid-cols-1 gap-1 rounded-lg bg-stone-100 p-1 sm:grid-cols-3 dark:bg-stone-800">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.value}
                  onClick={() => chooseMode(m.value)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    mode === m.value ? "bg-white text-brand-800 shadow-sm dark:bg-stone-900 dark:text-brand-200" : "text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-stone-500">{MODES.find((m) => m.value === mode)!.hint}</p>
          </fieldset>
          {config?.proxyConfigured && (
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-brand-700" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
              Use proxy
            </label>
          )}
          {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
          <button className="btn-primary w-full sm:w-auto" disabled={busy || !url.trim() || config?.llmConfigured === false}>
            {busy ? "Starting…" : "Start crawl"}
          </button>
        </form>

        {jobId && (
          <JobProgress
            stream={stream}
            title={[`${stream.job?.kind === "enrich" ? "Web lookup" : "Crawl"} #${jobId}`, collectionName(stream.job?.collectionId ?? null)].filter(Boolean).join(" · ")}
            onStop={stopJob}
            onResume={resumeJob}
          />
        )}
      </section>

      <section className="space-y-4">
        {feed.active.length > 0 && (
          <div className="card">
            <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-500 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-brand-600" />
              </span>
              <h2 className="font-semibold">Running now</h2>
              <span className="ml-auto text-sm text-stone-500">{feed.active.length}</span>
            </div>
            <ul className="divide-y divide-stone-200 dark:divide-stone-800">
              {feed.active.map((j) => (
                <li key={j.id} className={`flex items-start ${j.id === jobId ? "bg-brand-50 dark:bg-brand-900/30" : ""}`}>
                  <button
                    className="block min-w-0 flex-1 px-4 py-3 text-left hover:bg-stone-50 dark:hover:bg-stone-800/50"
                    onClick={() => selectJob(j.id)}
                    aria-current={j.id === jobId ? "true" : undefined}
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <span className="shrink-0 font-medium">{jobLabel(j)}</span>
                      <span className="min-w-0 flex-1 truncate text-stone-500" title={collectionName(j.collectionId) ?? undefined}>
                        {collectionName(j.collectionId)}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-stone-500">
                        {j.itemsIndexed}/{j.itemsFound || "?"}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
                      <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${Math.max(jobPercent(j), 2)}%` }} />
                    </div>
                    {j.message && <div className="mt-1 truncate text-xs text-stone-500">{j.message}</div>}
                  </button>
                  {j.kind === "crawl" && j.status === "running" && (
                    <button className="btn-ghost btn-sm my-2.5 mr-3 shrink-0" disabled={j.message === "Stopping…"} onClick={() => stopJob(j)} title="Stop — you can resume it later">
                      {j.message === "Stopping…" ? "Stopping…" : "Stop"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="card">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
            <h2 className="font-semibold">Collections</h2>
            <span className="text-sm text-stone-500">{collections.reduce((n, c) => n + c.itemCount, 0)} items</span>
            <button
              className="btn-ghost btn-sm ml-auto"
              disabled={collections.length === 0}
              onClick={() => downloadExport(api.exportAllCollectionsUrl, "specharvest-all.json").catch((err) => setError((err as Error).message))}
              title="Download every collection you can see as one .json file"
            >
              Export all
            </button>
            <button className="btn-ghost btn-sm" disabled={importing} onClick={() => importInput.current?.click()} title="Add collections from an exported .json file (one or Export all)">
              {importing ? "Importing…" : "Import"}
            </button>
            <input ref={importInput} type="file" accept=".json,application/json" className="hidden" onChange={importFile} />
          </div>
          {importError && <p className="border-b border-stone-200 px-4 py-2 text-sm text-red-700 dark:border-stone-800 dark:text-red-300">{importError}</p>}
          {collections.length === 0 ? (
            <p className="p-4 text-sm text-stone-500">Nothing crawled yet.</p>
          ) : (
            <ul className="divide-y divide-stone-200 dark:divide-stone-800">
              {collections.map((c) => (
                <li key={c.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium" title={c.name}>
                        {c.name}
                      </span>
                      {c.isShared && (
                        <span
                          className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-100"
                          title={c.canEdit ? "Every user can search this collection" : `Shared by ${c.ownerEmail ?? "another user"} — read only`}
                        >
                          {c.canEdit ? "Shared" : "Shared with you"}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-stone-500">
                      {!c.canEdit && c.ownerEmail && <>by {c.ownerEmail} · </>}
                      {c.itemCount} items ·{" "}
                      <button
                        type="button"
                        className="hover:text-brand-700 hover:underline dark:hover:text-brand-500"
                        onClick={() => setProductsOf(c)}
                        title="Listings of the same product (name variants included) count once"
                      >
                        {c.productCount} products
                      </button>{" "}
                      · {c.host} · {timeAgo(c.createdAt)}
                      {c.llmCost > 0 && <span title="Spent on LLM calls for this collection"> · {formatUsd(c.llmCost)} LLM</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-primary btn-sm" onClick={() => onSearch(`c:${c.id}`)}>
                      Search
                    </button>
                    <button className="btn-ghost btn-sm" onClick={() => setProductsOf(c)}>
                      Products
                    </button>
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => downloadExport(api.exportCollectionUrl(c.id), "collection.json").catch((err) => setError((err as Error).message))}
                      title="Download as .json — items, specs and web lookup results"
                    >
                      Export
                    </button>
                    {c.canEdit && (
                      <>
                        <button
                          className="btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => start({ url: c.startUrl, collectionId: c.id, mode })}
                          title={`Crawl again — ${MODES.find((m) => m.value === mode)!.label.toLowerCase()} of saved ads`}
                        >
                          Re-crawl
                        </button>
                        <button className="btn-ghost btn-sm" onClick={() => rename(c)}>
                          Rename
                        </button>
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() => toggleShared(c)}
                          aria-pressed={c.isShared}
                          title={c.isShared ? "Make private again" : "Let every user search it (read only)"}
                        >
                          {c.isShared ? "Unshare" : "Share"}
                        </button>
                        <button className="btn-ghost btn-sm text-red-700 dark:text-red-300" onClick={() => remove(c)}>
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {(collections.length > 1 || groups.length > 0) && (
          <div className="card">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
              <h2 className="font-semibold">Groups</h2>
              <span className="text-sm text-stone-500">search several collections at once</span>
              <button className="btn-ghost btn-sm ml-auto" onClick={() => setEditingGroup(null)}>
                New group
              </button>
            </div>
            {groups.length === 0 ? (
              <p className="p-4 text-sm text-stone-500">No groups yet — e.g. put all your car collections in a "Cars" group.</p>
            ) : (
              <ul className="divide-y divide-stone-200 dark:divide-stone-800">
                {groups.map((g) => {
                  const members = g.collectionIds.map((id) => collections.find((c) => c.id === id)?.name).filter(Boolean);
                  return (
                    <li key={g.id} className="flex flex-col gap-2 px-4 py-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium" title={g.name}>
                          {g.name}
                        </div>
                        <div className="truncate text-xs text-stone-500" title={members.join(", ")}>
                          {g.itemCount} items · {members.length ? members.join(", ") : "no collections left"}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button className="btn-primary btn-sm" disabled={g.collectionIds.length === 0} onClick={() => onSearch(`g:${g.id}`)}>
                          Search
                        </button>
                        <button className="btn-ghost btn-sm" onClick={() => setEditingGroup(g)}>
                          Edit
                        </button>
                        <button className="btn-ghost btn-sm text-red-700 dark:text-red-300" onClick={() => removeGroup(g)}>
                          Delete
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {recentJobs.length > 0 && (
          <div className="card">
            <h2 className="border-b border-stone-200 px-4 py-3 font-semibold dark:border-stone-800">Recent jobs</h2>
            <ul className="divide-y divide-stone-200 text-sm dark:divide-stone-800">
              {recentJobs.slice(0, 8).map((j) => (
                <li key={j.id} className={`flex items-center ${j.id === jobId ? "bg-brand-50 dark:bg-brand-900/30" : ""}`}>
                  <button className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left hover:bg-stone-50 dark:hover:bg-stone-800/50" onClick={() => selectJob(j.id)}>
                    <span className="w-28 shrink-0 whitespace-nowrap font-medium">{jobLabel(j)}</span>
                    <span className="min-w-0 flex-1 truncate text-stone-500">{j.error ?? j.message ?? ""}</span>
                    <StatusBadge status={j.status} />
                  </button>
                  {j.resumable && (
                    <button className="btn-ghost btn-sm mr-3 shrink-0" onClick={() => resumeJob(j)} title="Continue where it left off">
                      Resume
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      {editingGroup !== undefined && <GroupModal group={editingGroup} collections={collections} onSaved={onChanged} onClose={() => setEditingGroup(undefined)} />}
      {productsOf && <ProductsModal collection={productsOf} onClose={() => setProductsOf(null)} onGrouped={onChanged} />}
    </div>
  );
}
