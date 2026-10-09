import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Collection, CollectionGroup, Filter, Item, QueryPlan, RecentSearch, SearchResponse, SpecKey } from "@specharvest/shared";
import { formatSpecValue, humanizeKey, isListingField, specLabel } from "@specharvest/shared";
import { api, ApiError, formatUsd, parseScope, scopeParams, storageGet, storageSet, useJobStream, type AppConfig, type SearchScope } from "../lib/api.ts";
import { LookupSummary } from "../components/LookupSummary.tsx";
import { GlobeIcon, ItemCard, formatPrice } from "../components/ItemCard.tsx";
import { ItemModal } from "../components/ItemModal.tsx";
import { CompareTable } from "../components/CompareTable.tsx";
import { FilterIcon, FilterPanel } from "../components/FilterPanel.tsx";
import { Modal } from "../components/Modal.tsx";

type ViewMode = "list" | "cards";
const VIEW_STORAGE = "specharvest.resultsView";
const FILTERS_STORAGE = "specharvest.filtersOpen";
/** Panel changes are batched this long before searching (one request for quick clicks). */
const FILTER_DEBOUNCE_MS = 350;
/** Tailwind `lg`: the filter panel is a sidebar from here up, a bottom sheet below. */
const DESKTOP_QUERY = "(min-width: 64rem)";

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_STORAGE) === "cards" ? "cards" : "list";
  } catch {
    return "list";
  }
}

function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

interface Props {
  config: AppConfig | null;
  collections: Collection[];
  groups: CollectionGroup[];
  scope: SearchScope;
  onSelectScope: (scope: SearchScope) => void;
  onGoIngest: () => void;
}

const OP_LABEL: Record<Filter["op"], string> = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contains", exists: "has", in: "in" };

function filterLabel(f: Filter, keys: Map<string, SpecKey>, collectionName: (id: number) => string): string {
  const name = specLabel(f.key);
  if (f.op === "exists") return `has ${name.toLowerCase()}`;
  const show = (v: string | number) => (f.key === "collection" ? collectionName(Number(v)) : String(v));
  if (Array.isArray(f.value)) return `${name}: ${f.value.slice(0, 3).map(show).join(", ")}${f.value.length > 3 ? ` +${f.value.length - 3}` : ""}`;
  if (typeof f.value === "boolean") return f.value === (f.op === "eq") ? name : `no ${name.toLowerCase()}`;
  if (f.key === "collection" && typeof f.value === "number") return `${name} ${OP_LABEL[f.op]} ${show(f.value)}`;
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

export function SearchView({ config, collections, groups, scope, onSelectScope, onGoIngest }: Props) {
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
  /** Keys set in the filter panel: their conditions stay when a new request is typed. */
  const [manualKeys, setManualKeys] = useState<Set<string>>(() => new Set());
  const [filtersOpen, setFiltersOpenState] = useState(() => storageGet(FILTERS_STORAGE) !== "0");
  const [sheetOpen, setSheetOpen] = useState(false);
  const desktop = useDesktop();
  const filterTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** A search answered "too many searches" is sent again by itself after the wait the server asked for. */
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  useEffect(
    () => () => {
      clearTimeout(filterTimer.current);
      clearTimeout(retryTimer.current);
    },
    [],
  );
  // The sheet is the small-screen form of the sidebar.
  useEffect(() => {
    if (desktop) setSheetOpen(false);
  }, [desktop]);

  // Registry keys, plus not-yet-indexed keys from the plan (so web-only values get their unit).
  const keys = useMemo(() => {
    const map = new Map((result?.keys ?? []).map((k) => [k.key, k]));
    for (const m of result?.plan.missingAttributes ?? []) {
      if (!map.has(m.key)) map.set(m.key, { key: m.key, type: m.type, unit: m.unit ?? null, label: m.label, example: null, count: 0, origin: "web" });
    }
    return map;
  }, [result]);

  const loadRecent = useCallback(() => api.recentSearches(scope).then(setRecent, () => setRecent([])), [scope]);

  const run = useCallback(
    async function search(body: { query?: string; plan?: QueryPlan; filters?: Filter[]; enrich?: boolean; includeGone?: boolean }) {
      // Anything run now supersedes a filter change or retry still waiting to be sent.
      clearTimeout(filterTimer.current);
      clearTimeout(retryTimer.current);
      setRetryIn(null);
      const mySeq = ++seq.current;
      setLoading(true);
      setError(null);
      // Only a typed request (or a button saying so) may start paid web lookups; other re-runs get an offer instead.
      const enrich = body.enrich ?? !!body.query?.trim();
      try {
        const res = await api.search({ ...scopeParams(scope), includeGone, facets: true, ...body, enrich });
        if (mySeq !== seq.current) return;
        setResult(res);
        if (res.enrichJobId) setEnrichJobId(res.enrichJobId);
        if (body.query) loadRecent();
      } catch (err) {
        if (mySeq !== seq.current) return;
        if (err instanceof ApiError && err.status === 429) {
          const wait = err.retryAfter ?? 5;
          setRetryIn(wait);
          retryTimer.current = setTimeout(() => search(body), wait * 1000);
        } else setError((err as Error).message);
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    },
    [scope, includeGone, loadRecent],
  );

  // Browse everything when the collection or group changes.
  useEffect(() => {
    setEnrichJobId(null);
    setQuery("");
    setManualKeys(new Set());
    run({});
    loadRecent();
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run the current plan (no LLM call) when sold/removed listings are toggled.
  const toggleGone = (on: boolean) => {
    setIncludeGoneState(on);
    storageSet("specharvest.includeGone", on ? "1" : "0");
    run(result?.plan ? { plan: result.plan, enrich: false, includeGone: on } : { includeGone: on });
  };

  // The panel's conditions, sent along with a typed request (its own condition on the same field wins).
  const manualFilters = () => (result?.plan.filters ?? []).filter((f) => manualKeys.has(f.key));

  const runQuery = (q: string) => {
    setQuery(q);
    setEnrichJobId(null);
    run({ query: q, filters: manualFilters() });
  };

  // When a web lookup finishes, re-run the same plan (without starting another lookup).
  const enrichDone = enrich.job?.status === "done" || enrich.job?.status === "failed";
  useEffect(() => {
    if (enrichDone && result?.plan) run({ plan: result.plan, enrich: false });
  }, [enrichDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setEnrichJobId(null);
    run(query.trim() ? { query: query.trim(), filters: manualFilters() } : { filters: manualFilters() });
  };

  const editPlan = (next: QueryPlan) => {
    setManualKeys((prev) => new Set([...prev].filter((k) => next.filters.some((f) => f.key === k))));
    run({ plan: next });
  };

  /** A filter-panel change: replaces every condition on `key`, shows at once, searches after a short pause (no LLM call, no web lookup). */
  const applyFilters = (key: string, next: Filter[]) => {
    if (!result) return;
    const nextPlan = { ...result.plan, filters: [...result.plan.filters.filter((f) => f.key !== key), ...next] };
    setManualKeys((prev) => {
      const keys = new Set(prev);
      if (next.length) keys.add(key);
      else keys.delete(key);
      return keys;
    });
    setResult({ ...result, plan: nextPlan });
    // A search already on its way answers the old filters — drop its response.
    seq.current++;
    setLoading(true);
    clearTimeout(filterTimer.current);
    filterTimer.current = setTimeout(() => run({ plan: nextPlan, enrich: false }), FILTER_DEBOUNCE_MS);
  };

  const clearFilters = () => {
    if (!result) return;
    const nextPlan = { ...result.plan, filters: [] };
    setManualKeys(new Set());
    setResult({ ...result, plan: nextPlan });
    run({ plan: nextPlan, enrich: false });
  };

  const setFiltersOpen = (open: boolean) => {
    setFiltersOpenState(open);
    storageSet(FILTERS_STORAGE, open ? "1" : "0");
  };

  const plan = result?.plan;
  const facets = result?.facets ?? [];
  const filteredFields = new Set(plan?.filters.map((f) => f.key)).size;
  const sidebar = desktop && filtersOpen && facets.length > 0;
  const collectionName = (id: number) => collections.find((c) => c.id === id)?.name ?? `Collection ${id}`;
  // Fields the user asked about: sorted-by first, then filters, explicit "show" keys and web-looked-up ones.
  // Listing fields other than price already show on every card and row.
  const highlightKeys = plan
    ? [...new Set([...(plan.sort ? [plan.sort.key] : []), ...plan.filters.map((f) => f.key), ...plan.show, ...plan.missingAttributes.map((m) => m.key)])].filter(
        (k) => k === "price" || !isListingField(k),
      )
    : [];
  const missingKeys = new Set(plan?.missingAttributes.map((m) => m.key) ?? []);
  const enriching = enrichJobId !== null && enrich.job && (enrich.job.status === "running" || enrich.job.status === "queued");
  const pendingKeys = enriching ? new Set(highlightKeys) : new Set<string>();
  const hasFields = highlightKeys.some((k) => k !== "price");
  const mode: ViewMode = hasFields ? view : "cards";

  // What "can't be judged yet" items lack that a web lookup can fill in: specs only (not price or other listing
  // fields), and not what the banner already offers to look up.
  const offered = new Set(result?.enrichOffer?.attributes.map((a) => a.key));
  const unknownAttrs = [...new Set(plan?.filters.map((f) => f.key))]
    .filter((k) => keys.has(k) && !isListingField(k) && !offered.has(k) && result?.unknown.some((i) => i.specs[k] === undefined))
    .map((k) => ({ key: k, type: keys.get(k)!.type, unit: keys.get(k)!.unit, label: humanizeKey(k).toLowerCase() }))
    .slice(0, 5);
  const missingIn = (item: Item) => [
    ...(item.price === null && plan?.filters.some((f) => f.key === "price") ? ["price"] : []),
    ...new Set(plan?.filters.filter((f) => item.specs[f.key] === undefined && !isListingField(f.key)).map((f) => humanizeKey(f.key).toLowerCase())),
  ];

  const lookUpUnknown = async () => {
    if (!result || unknownAttrs.length === 0) return;
    const itemIds = result.unknown.filter((i) => unknownAttrs.some((a) => i.specs[a.key] === undefined)).map((i) => i.id);
    try {
      const res = await api.enrich({ ...scopeParams(scope), attributes: unknownAttrs, itemIds });
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
            value={scope}
            onChange={(e) => onSelectScope(parseScope(e.target.value) ?? "all")}
            aria-label="Collection or group"
          >
            <option value="all">All collections</option>
            {groups.length > 0 && (
              <optgroup label="Groups">
                {groups.map((g) => (
                  <option key={g.id} value={`g:${g.id}`}>
                    {g.name} ({g.collectionIds.length} collections · {g.itemCount})
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Collections">
              {collections.map((c) => (
                <option key={c.id} value={`c:${c.id}`}>
                  {c.name} ({c.itemCount}){!c.canEdit && c.isShared ? ` · shared by ${c.ownerEmail ?? "another user"}` : ""}
                </option>
              ))}
            </optgroup>
          </select>
          <input
            className="input sm:flex-1"
            placeholder="Describe what you want, e.g. automatic diesel with the lowest mileage"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search"
          />
          <div className="flex gap-2">
            {facets.length > 0 && (
              <button
                type="button"
                className="btn-ghost flex-1 sm:flex-none"
                onClick={() => (desktop ? setFiltersOpen(!filtersOpen) : setSheetOpen(true))}
                aria-expanded={desktop ? sidebar : sheetOpen}
                aria-controls={desktop ? "search-filters" : undefined}
                title={desktop ? (sidebar ? "Hide filters" : "Show filters") : "Filter by any field"}
              >
                <FilterIcon />
                Filters
                {filteredFields > 0 && <span className="rounded-full bg-brand-700 px-1.5 text-xs leading-5 text-white">{filteredFields}</span>}
              </button>
            )}
            <button className="btn-primary flex-1 sm:flex-none" disabled={loading}>
              {loading ? "Searching…" : "Search"}
            </button>
          </div>
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
                {filterLabel(f, keys, collectionName)}
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

      <div className={sidebar ? "grid grid-cols-[18rem_minmax(0,1fr)] items-start gap-4" : ""}>
        {sidebar && (
          <aside id="search-filters" aria-label="Filters" className="card sticky top-[4.5rem] flex max-h-[calc(100dvh-5.5rem)] flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
              <h2 className="font-semibold">Filters</h2>
              <button type="button" className="btn-ghost btn-sm ml-auto" disabled={filteredFields === 0} onClick={clearFilters}>
                Clear all
              </button>
            </div>
            <FilterPanel key={scope} facets={facets} keys={keys} filters={plan?.filters ?? []} collections={collections} onChange={applyFilters} />
          </aside>
        )}
        <div className="min-w-0 space-y-4">
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
          {retryIn !== null && !loading && (
            <div className="rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300" role="status">
              Too many searches in a minute — updating by itself in {retryIn} s.
            </div>
          )}
          {result?.enrichOffer && !enriching && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
              <GlobeIcon className="size-4" />
              <span className="min-w-0 flex-1">
                {/* Registry keys read as fields ("Boot capacity"); keys new to the plan keep the parser's wording. */}
                {humanizeKey(result.enrichOffer.attributes.map((a) => (plan?.missingAttributes.some((m) => m.key === a.key) ? a.label : specLabel(a.key).toLowerCase())).join(", "))}{" "}
                {result.enrichOffer.attributes.length === 1 ? "isn’t" : "aren’t"} stated for{" "}
                {result.enrichOffer.listings} listing{result.enrichOffer.listings === 1 ? "" : "s"}
              </span>
              <button type="button" className="btn-ghost btn-sm" onClick={() => run({ plan: result.plan, enrich: true })}>
                <GlobeIcon /> Look up {result.enrichOffer.products} product{result.enrichOffer.products === 1 ? "" : "s"} on the web
              </button>
            </div>
          )}
          {enrichDone && enrich.job && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-stone-500">
              <span className="min-w-0">
                <GlobeIcon className="mr-1 inline size-3.5 text-sky-600" />
                Web lookup finished: {enrich.job.message ?? enrich.job.error}
                {enrich.job.llmCost > 0 && ` · ${formatUsd(enrich.job.llmCost)}`}
              </span>
              {enrich.job.itemsRemaining > 0 && result?.plan && !result.enrichOffer && (
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
            <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${sidebar ? "xl:grid-cols-3" : "lg:grid-cols-3 xl:grid-cols-4"}`}>
              {result?.items.map((item) => (
                <ItemCard key={item.id} item={item} keys={keys} highlightKeys={highlightKeys} onOpen={() => setOpen(item)} />
              ))}
            </div>
          )}

          {result && result.items.length === 0 && !loading && (
            <div className="card p-6 text-center text-sm text-stone-500">No items match. Remove a filter to widen the search.</div>
          )}

          {result && result.unknown.length > 0 && (
            <div className="card">
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                <button className="mr-auto text-left text-sm font-medium" onClick={() => setShowUnknown((v) => !v)} aria-expanded={showUnknown}>
                  {showUnknown ? "▾" : "▸"} {result.unknown.length} items missing a filtered value
                </button>
                {config?.webSearchEnabled && !enriching && unknownAttrs.length > 0 && (
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
                          missing {missingIn(item).join(", ")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

        </div>
      </div>

      {sheetOpen && (
        <Modal
          title="Filters"
          onClose={() => setSheetOpen(false)}
          bodyClassName="flex min-h-0 flex-1 flex-col"
          footer={
            <>
              <button type="button" className="btn-ghost" disabled={filteredFields === 0} onClick={clearFilters}>
                Clear all
              </button>
              <button type="button" className="btn-primary flex-1" onClick={() => setSheetOpen(false)}>
                {loading ? "Updating…" : `Show ${result?.total ?? 0} result${result?.total === 1 ? "" : "s"}`}
              </button>
            </>
          }
        >
          <FilterPanel key={scope} facets={facets} keys={keys} filters={plan?.filters ?? []} collections={collections} onChange={applyFilters} />
        </Modal>
      )}
      {open && <ItemModal item={open} keys={keys} highlightKeys={highlightKeys} onClose={() => setOpen(null)} />}
    </div>
  );
}
