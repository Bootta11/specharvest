import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Collection, Filter, Item, QueryPlan, RecentSearch, SearchResponse, SpecKey } from "@specharvest/shared";
import { formatSpecValue, humanizeKey, specLabel } from "@specharvest/shared";
import { api, formatUsd, storageGet, storageSet, useJobStream, type AppConfig } from "../lib/api.ts";
import { LookupSummary } from "../components/LookupSummary.tsx";
import { GlobeIcon, ItemCard, formatPrice } from "../components/ItemCard.tsx";
import { ItemModal } from "../components/ItemModal.tsx";
import { CompareTable } from "../components/CompareTable.tsx";

type ViewMode = "list" | "cards";
const VIEW_STORAGE = "specharvest.resultsView";

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_STORAGE) === "cards" ? "cards" : "list";
  } catch {
    return "list";
  }
}

interface Props {
  config: AppConfig | null;
  collections: Collection[];
  collectionId: number | null;
  onSelectCollection: (id: number | null) => void;
  onGoIngest: () => void;
}

const OP_LABEL: Record<Filter["op"], string> = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contains", exists: "has" };

function filterLabel(f: Filter, keys: Map<string, SpecKey>): string {
  const name = specLabel(f.key);
  if (f.op === "exists") return `has ${name.toLowerCase()}`;
  if (typeof f.value === "boolean") return f.value === (f.op === "eq") ? name : `no ${name.toLowerCase()}`;
  const unit = keys.get(f.key)?.unit;
  const value = f.key === "price" && typeof f.value === "number" ? f.value.toLocaleString("en-US") : formatSpecValue(f.value ?? null, unit);
  return `${name} ${OP_LABEL[f.op]} ${value}`;
}

function Chip({ children, onRemove, tone = "default", title }: { children: React.ReactNode; onRemove?: () => void; tone?: "default" | "sort" | "semantic" | "pending"; title?: string }) {
  const tones = {
    default: "bg-brand-50 text-brand-900 border-brand-200 dark:bg-brand-900/40 dark:text-brand-100 dark:border-brand-800",
    sort: "bg-violet-50 text-violet-900 border-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:border-violet-900",
    semantic: "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-900",
    pending: "bg-sky-50 text-sky-900 border-sky-300 border-dashed dark:bg-sky-950 dark:text-sky-200 dark:border-sky-800",
  };
  return (
    <span title={title} className={`inline-flex max-w-full items-center gap-1.5 rounded-full border py-1 pl-3 text-sm ${onRemove ? "pr-1" : "pr-3"} ${tones[tone]}`}>
      <span className="truncate">{children}</span>
      {onRemove && (
        <button onClick={onRemove} className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10" aria-label="Remove">
          ×
        </button>
      )}
    </span>
  );
}

function examplesFor(keys: SpecKey[]): string[] {
  const has = (k: string) => keys.some((x) => x.key === k);
  if (has("fuel_type")) {
    return ["automatic diesel with the lowest mileage", "family SUV with heated seats under 55000", "hybrid with the fastest 0-100", "most powerful car with a parking camera"];
  }
  const nums = keys.filter((k) => k.type === "number").slice(0, 2);
  return ["cheapest first", ...nums.map((k) => `highest ${humanizeKey(k.key).toLowerCase()}`)];
}

export function SearchView({ config, collections, collectionId, onSelectCollection, onGoIngest }: Props) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrichJobId, setEnrichJobId] = useState<number | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  const [showUnknown, setShowUnknown] = useState(false);
  const [includeGone, setIncludeGoneState] = useState(() => storageGet("specharvest.includeGone") === "1");
  const [recent, setRecent] = useState<RecentSearch[]>([]);
  const [view, setViewState] = useState<ViewMode>(readView);
  const setView = (v: ViewMode) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_STORAGE, v);
    } catch {
      /* storage unavailable — keep it for this session only */
    }
  };
  const enrich = useJobStream(enrichJobId);
  const seq = useRef(0);

  // Registry keys, plus not-yet-indexed keys from the plan (so web-only values get their unit).
  const keys = useMemo(() => {
    const map = new Map((result?.keys ?? []).map((k) => [k.key, k]));
    for (const m of result?.plan.missingAttributes ?? []) {
      if (!map.has(m.key)) map.set(m.key, { key: m.key, type: m.type, unit: m.unit ?? null, label: m.label, example: null, count: 0, origin: "web" });
    }
    return map;
  }, [result]);

  const loadRecent = useCallback(() => api.recentSearches(collectionId).then(setRecent, () => setRecent([])), [collectionId]);

  const run = useCallback(
    async (body: { query?: string; plan?: QueryPlan; enrich?: boolean; includeGone?: boolean }) => {
      const mySeq = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.search({ collectionId, includeGone, ...body });
        if (mySeq !== seq.current) return;
        setResult(res);
        if (res.enrichJobId) setEnrichJobId(res.enrichJobId);
        if (body.query) loadRecent();
      } catch (err) {
        if (mySeq === seq.current) setError((err as Error).message);
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    },
    [collectionId, includeGone, loadRecent],
  );

  // Browse everything when the collection changes.
  useEffect(() => {
    setEnrichJobId(null);
    setQuery("");
    run({});
    loadRecent();
  }, [collectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run the current plan (no LLM call) when sold/removed listings are toggled.
  const toggleGone = (on: boolean) => {
    setIncludeGoneState(on);
    storageSet("specharvest.includeGone", on ? "1" : "0");
    run(result?.plan ? { plan: result.plan, enrich: false, includeGone: on } : { includeGone: on });
  };

  const runQuery = (q: string) => {
    setQuery(q);
    setEnrichJobId(null);
    run({ query: q });
  };

  // When a web lookup finishes, re-run the same plan (without starting another lookup).
  const enrichDone = enrich.job?.status === "done" || enrich.job?.status === "failed";
  useEffect(() => {
    if (enrichDone && result?.plan) run({ plan: result.plan, enrich: false });
  }, [enrichDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setEnrichJobId(null);
    run(query.trim() ? { query: query.trim() } : {});
  };

  const editPlan = (next: QueryPlan) => run({ plan: next });
  const plan = result?.plan;
  // Fields the user asked about: sorted-by first, then filters, explicit "show" keys and web-looked-up ones.
  const highlightKeys = plan
    ? [...new Set([...(plan.sort ? [plan.sort.key] : []), ...plan.filters.map((f) => f.key), ...plan.show, ...plan.missingAttributes.map((m) => m.key)])].filter((k) => k !== "title")
    : [];
  const missingKeys = new Set(plan?.missingAttributes.map((m) => m.key) ?? []);
  const enriching = enrichJobId !== null && enrich.job && (enrich.job.status === "running" || enrich.job.status === "queued");
  const pendingKeys = enriching ? new Set(highlightKeys) : new Set<string>();
  const hasFields = highlightKeys.some((k) => k !== "price");
  const mode: ViewMode = hasFields ? view : "cards";

  const lookUpUnknown = async () => {
    if (!result || !plan) return;
    const attrs = plan.filters
      .filter((f) => keys.has(f.key))
      .map((f) => ({ key: f.key, type: keys.get(f.key)!.type, unit: keys.get(f.key)!.unit, label: humanizeKey(f.key).toLowerCase() }));
    if (attrs.length === 0) return;
    try {
      const res = await api.enrich({ collectionId, attributes: attrs.slice(0, 5), itemIds: result.unknown.map((i) => i.id) });
      if (res.job) setEnrichJobId(res.job.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (collections.length === 0) {
    return (
      <div className="card mx-auto max-w-lg p-6 text-center">
        <h2 className="text-lg font-semibold">No collections yet</h2>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">Crawl a shop listing first — then search it in plain language.</p>
        <button className="btn-primary mt-4" onClick={onGoIngest}>
          Crawl a listing
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="card space-y-3 p-3 sm:p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            className="input sm:w-64"
            value={collectionId ?? 0}
            onChange={(e) => onSelectCollection(Number(e.target.value) || null)}
            aria-label="Collection"
          >
            <option value={0}>All collections</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.itemCount}){!c.canEdit && c.isShared ? ` · shared by ${c.ownerEmail ?? "another user"}` : ""}
              </option>
            ))}
          </select>
          <input
            className="input sm:flex-1"
            placeholder="Describe what you want, e.g. automatic diesel with the lowest mileage"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search"
          />
          <button className="btn-primary" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
        {!plan || (plan.filters.length === 0 && !plan.sort && !plan.semanticText && plan.missingAttributes.length === 0 && plan.show.length === 0) ? (
          <div className="space-y-2">
            {recent.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-stone-500">Recent</span>
                {recent.map((r) => (
                  <button
                    key={r.query}
                    type="button"
                    title="Saved search — runs without asking the AI again"
                    className="max-w-full truncate rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs text-brand-900 hover:border-brand-600 dark:border-brand-800 dark:bg-brand-900/40 dark:text-brand-100"
                    onClick={() => runQuery(r.query)}
                  >
                    {r.query}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {recent.length > 0 && <span className="text-xs font-medium text-stone-500">Try</span>}
              {examplesFor(result?.keys ?? []).map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:border-brand-600 hover:text-brand-800 dark:border-stone-700 dark:text-stone-400"
                  onClick={() => runQuery(ex)}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {plan.filters.map((f, i) => (
              <Chip
                key={`f${i}`}
                tone={missingKeys.has(f.key) ? "pending" : "default"}
                title={missingKeys.has(f.key) ? "Not stated in listings — being looked up on the web" : undefined}
                onRemove={() => editPlan({ ...plan, filters: plan.filters.filter((_, j) => j !== i) })}
              >
                {missingKeys.has(f.key) && <GlobeIcon className="mr-1 inline size-3.5" />}
                {filterLabel(f, keys)}
              </Chip>
            ))}
            {plan.sort && (
              <Chip tone={missingKeys.has(plan.sort.key) ? "pending" : "sort"} onRemove={() => editPlan({ ...plan, sort: null })}>
                {missingKeys.has(plan.sort.key) && <GlobeIcon className="mr-1 inline size-3.5" />}
                {plan.sort.dir === "asc" ? "↑" : "↓"} {specLabel(plan.sort.key)}
              </Chip>
            )}
            {plan.semanticText && (
              <Chip tone="semantic" title="Ranked by meaning" onRemove={() => editPlan({ ...plan, semanticText: null })}>
                “{plan.semanticText}”
              </Chip>
            )}
            {plan.show.map((k) => (
              <Chip
                key={`s-${k}`}
                tone={missingKeys.has(k) ? "pending" : "default"}
                title="Shown for comparison"
                onRemove={() => editPlan({ ...plan, show: plan.show.filter((x) => x !== k), missingAttributes: plan.missingAttributes.filter((m) => m.key !== k) })}
              >
                {missingKeys.has(k) && <GlobeIcon className="mr-1 inline size-3.5" />}
                show {specLabel(k).toLowerCase()}
              </Chip>
            ))}
            {plan.missingAttributes
              .filter((m) => !plan.filters.some((f) => f.key === m.key) && plan.sort?.key !== m.key && !plan.show.includes(m.key))
              .map((m) => (
                <Chip key={m.key} tone="pending">
                  <GlobeIcon className="mr-1 inline size-3.5" />
                  {m.label}
                </Chip>
              ))}
            {result && result.llmCost > 0 && (
              <span className="ml-auto text-xs text-stone-500" title="LLM cost of turning this request into filters">
                parsed · {formatUsd(result.llmCost)}
              </span>
            )}
          </div>
        )}
      </form>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</div>}

      {(enriching || (result?.enrichNote && !enrichJobId)) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
          <GlobeIcon className={`size-4 ${enriching ? "animate-spin [animation-duration:3s]" : ""}`} />
          <div className="min-w-0 flex-1">
            {enriching ? (
              <>
                {enrich.job!.lookup ? `Looking up ${enrich.job!.lookup.attributes.join(", ")} on the web` : (result?.enrichNote ?? "Looking up missing specs on the web")}
                {enrich.job!.lookup
                  ? ` — ${Math.max(0, enrich.job!.itemsIndexed - enrich.job!.lookup.cached)} of ${enrich.job!.lookup.toLookUp} products looked up`
                  : ` — ${enrich.job!.itemsIndexed}/${enrich.job!.itemsFound} products`}
                {enrich.job!.webSearches ? `, ${enrich.job!.webSearches} searches` : ""}
                {enrich.job!.llmCost ? ` · ${formatUsd(enrich.job!.llmCost)}` : ""}
                {enrich.job!.lookup && <LookupSummary stats={enrich.job!.lookup} className="mt-2" />}
              </>
            ) : (
              result?.enrichNote
            )}
          </div>
        </div>
      )}
      {enrichDone && enrich.job && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-stone-500">
          <span className="min-w-0">
            <GlobeIcon className="mr-1 inline size-3.5 text-sky-600" />
            Web lookup finished: {enrich.job.message ?? enrich.job.error}
            {enrich.job.llmCost > 0 && ` · ${formatUsd(enrich.job.llmCost)}`}
          </span>
          {enrich.job.itemsRemaining > 0 && result?.plan && (
            // Products just looked up are cached now, so the server starts on the next batch.
            <button type="button" className="btn-ghost btn-sm" onClick={() => run({ plan: result.plan, enrich: true })}>
              <GlobeIcon /> Look up {enrich.job.itemsRemaining} more product{enrich.job.itemsRemaining === 1 ? "" : "s"}
            </button>
          )}
          {enrich.job.lookup && <LookupSummary stats={enrich.job.lookup} className="w-full" />}
        </div>
      )}

      {result && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-stone-600 dark:text-stone-400">
          <span>
            <strong className="text-stone-900 dark:text-stone-100">{result.total}</strong> match{result.total === 1 ? "" : "es"}
            {result.unknown.length > 0 && <> · {result.unknown.length} can’t be judged yet</>}
          </span>
          <span className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1.5 text-xs" title="Listings missing from the latest complete crawl">
              <input type="checkbox" className="size-3.5 accent-brand-700" checked={includeGone} onChange={(e) => toggleGone(e.target.checked)} />
              Show sold/removed
            </label>
            {loading && <span className="animate-pulse">updating…</span>}
            {hasFields && (
              <span className="inline-flex rounded-lg border border-stone-200 p-0.5 text-xs dark:border-stone-700" role="group" aria-label="Results view">
                {(["list", "cards"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    aria-pressed={mode === v}
                    className={`rounded-md px-2.5 py-1 font-medium ${mode === v ? "bg-brand-600 text-white" : "text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"}`}
                  >
                    {v === "list" ? "List" : "Cards"}
                  </button>
                ))}
              </span>
            )}
          </span>
        </div>
      )}

      {result && result.items.length > 0 && mode === "list" ? (
        <CompareTable items={result.items} keys={keys} fieldKeys={highlightKeys} sort={plan?.sort ?? null} pendingKeys={pendingKeys} onOpen={setOpen} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {result?.items.map((item) => (
            <ItemCard key={item.id} item={item} keys={keys} highlightKeys={highlightKeys} onOpen={() => setOpen(item)} />
          ))}
        </div>
      )}

      {result && result.items.length === 0 && !loading && (
        <div className="card p-6 text-center text-sm text-stone-500">No items match. Remove a filter chip to widen the search.</div>
      )}

      {result && result.unknown.length > 0 && (
        <div className="card">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <button className="mr-auto text-left text-sm font-medium" onClick={() => setShowUnknown((v) => !v)} aria-expanded={showUnknown}>
              {showUnknown ? "▾" : "▸"} {result.unknown.length} items missing a filtered spec
            </button>
            {config?.webSearchEnabled && !enriching && (
              <button className="btn-ghost btn-sm" onClick={lookUpUnknown}>
                <GlobeIcon /> Look up on the web
              </button>
            )}
          </div>
          {showUnknown && (
            <ul className="divide-y divide-stone-200 border-t border-stone-200 text-sm dark:divide-stone-800 dark:border-stone-800">
              {result.unknown.map((item) => (
                <li key={item.id}>
                  <button className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-800/50" onClick={() => setOpen(item)}>
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="shrink-0 text-stone-500">{formatPrice(item.price, item.currency)}</span>
                    <span className="hidden shrink-0 text-xs text-stone-400 sm:inline">
                      missing {plan?.filters.filter((f) => item.specs[f.key] === undefined && f.key !== "price").map((f) => humanizeKey(f.key).toLowerCase()).join(", ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {open && <ItemModal item={open} keys={keys} highlightKeys={highlightKeys} onClose={() => setOpen(null)} />}
    </div>
  );
}
