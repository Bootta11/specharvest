import { useEffect, useMemo, useState } from "react";
import type { Collection, CollectionProducts, MatchSuggestion } from "@specharvest/shared";
import { api } from "../lib/api.ts";
import { formatPrice, GoneBadge } from "./ItemCard.tsx";
import { Modal, Notice } from "./Modal.tsx";

/** A collection's products: listings grouped by product, name variants included. */
export function ProductsModal({ collection, onClose, onGrouped }: { collection: Collection; onClose: () => void; onGrouped?: () => void }) {
  const [data, setData] = useState<CollectionProducts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [multiOnly, setMultiOnly] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    api.collectionProducts(collection.id).then(
      (d) => {
        if (!live) return;
        setData(d);
        // Grouping may have changed the product count shown in the collections list.
        if (d.products.length !== collection.productCount) onGrouped?.();
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [collection.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Runs a grouping decision, then reloads the products. */
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setReload((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const multi = useMemo(() => data?.products.filter((p) => p.listings.length > 1).length ?? 0, [data]);
  const shown = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    return data.products.filter(
      (p) =>
        (!multiOnly || p.listings.length > 1) &&
        (!q || p.canonical.includes(q) || p.listings.some((l) => l.title.toLowerCase().includes(q) || l.identity?.includes(q))),
    );
  }, [data, filter, multiOnly]);

  return (
    <Modal title={`Products · ${collection.name}`} onClose={onClose} wide>
      {error && <Notice kind="error">{error}</Notice>}
      {!data && !error && (
        <p className="animate-pulse text-sm text-stone-500">
          {collection.canEdit ? "Grouping product names… (the first time can take a few seconds)" : "Loading products…"}
        </p>
      )}
      {data && (
        <div className="space-y-3">
          <p className="text-sm text-stone-600 dark:text-stone-400">
            {data.listings} listings → <strong className="text-stone-900 dark:text-stone-100">{data.products.length} products</strong> · {multi} with several listings
          </p>
          {data.suggestions.length > 0 && (
            <Suggestions
              suggestions={data.suggestions}
              busy={busy}
              onDecide={(s, to) => act(s.identity, () => api.decideMatch(collection.id, s.identity, to))}
            />
          )}
          {!data.grouped && (
            <p className="text-xs text-amber-700 dark:text-amber-300">Some names haven’t been grouped yet — the owner’s next crawl or visit here groups them.</p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <input
              type="search"
              className="input min-w-0 flex-1 basis-56"
              placeholder="Filter products…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter products"
            />
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-brand-700" checked={multiOnly} onChange={(e) => setMultiOnly(e.target.checked)} />
              Only products with several listings
            </label>
          </div>

          {shown.length === 0 ? (
            <p className="text-sm text-stone-500">{multiOnly && multi === 0 ? "Every product has a single listing." : "No products match."}</p>
          ) : (
            <ul className="divide-y divide-stone-200 dark:divide-stone-800">
              {shown.map((p) => {
                const variants = new Set(p.listings.map((l) => l.identity).filter((v) => v && v !== p.canonical)).size;
                return (
                  <li key={p.canonical} className="py-2.5">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium" title={p.canonical}>
                        {p.canonical}
                      </span>
                      <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-xs tabular-nums text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                        {p.listings.length} listing{p.listings.length === 1 ? "" : "s"}
                      </span>
                      {variants > 0 && (
                        <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200" title="Spelled differently but grouped as this product">
                          {variants} name variant{variants === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                    <ul className="mt-1 space-y-0.5 pl-3 text-sm">
                      {p.listings.map((l) => (
                        <li key={l.id} className="flex flex-wrap items-baseline gap-x-2">
                          <a href={l.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-brand-700 hover:underline dark:text-brand-500" title={l.title}>
                            {l.title} ↗
                          </a>
                          <GoneBadge item={l} />
                          {l.price != null && <span className="shrink-0 text-xs text-stone-500">{formatPrice(l.price, l.currency)}</span>}
                          {l.identity && l.identity !== p.canonical && (
                            <span className="flex w-full min-w-0 items-baseline gap-2 text-xs text-stone-500">
                              <span className="min-w-0 truncate" title={l.identity}>
                                as “{l.identity}”
                              </span>
                              {collection.canEdit && (
                                <button
                                  type="button"
                                  className="shrink-0 font-medium text-red-700 hover:underline disabled:opacity-50 dark:text-red-300"
                                  disabled={busy !== null}
                                  onClick={() => act(`split:${l.identity}`, () => api.splitProductName(collection.id, l.identity!))}
                                  title="Take this name out of the group — it won't be grouped with it again"
                                >
                                  {busy === `split:${l.identity}` ? "Separating…" : "Not the same"}
                                </button>
                              )}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Possible matches waiting for the user: "Same as <candidate>" or "Different product". */
function Suggestions({ suggestions, busy, onDecide }: { suggestions: MatchSuggestion[]; busy: string | null; onDecide: (s: MatchSuggestion, to: string | null) => void }) {
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
      <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
        {suggestions.length} possible match{suggestions.length === 1 ? "" : "es"} to review
      </h3>
      <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-200">
        These names might be the same product (usually one leaves out the trim). Grouped products share web lookups.
      </p>
      <ul className="mt-2 space-y-3">
        {suggestions.map((s) => (
          <li key={s.identity} className="min-w-0 rounded-md bg-white p-2.5 text-sm shadow-sm dark:bg-stone-900">
            <div className="truncate font-medium" title={s.identity}>
              {s.identity}
            </div>
            <div className="truncate text-xs text-stone-500" title={s.title}>
              {s.listings} listing{s.listings === 1 ? "" : "s"} · {s.title}
            </div>
            <div className="mt-2 text-xs text-stone-500">{s.candidates.length > 1 ? "Same product as one of these?" : "Same product as"}</div>
            <ul className="mt-1 space-y-1.5">
              {s.candidates.map((c) => (
                <li key={c.canonical} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 flex-1 basis-48 truncate" title={c.canonical}>
                    {c.canonical} <span className="text-xs text-stone-500">({c.listings})</span>
                  </span>
                  <button type="button" className="btn-ghost btn-sm" disabled={busy !== null} onClick={() => onDecide(s, c.canonical)}>
                    {busy === s.identity ? "Saving…" : "Same product"}
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="mt-2 text-xs font-medium text-stone-600 hover:underline disabled:opacity-50 dark:text-stone-400"
              disabled={busy !== null}
              onClick={() => onDecide(s, null)}
            >
              {s.candidates.length > 1 ? "None of these — different product" : "Different product"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
