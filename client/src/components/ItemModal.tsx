import { useEffect, useState } from "react";
import type { Item, SpecKey } from "@specharvest/shared";
import { humanizeKey, specLabel } from "@specharvest/shared";
import { api } from "../lib/api.ts";
import { formatPrice, GlobeIcon, GoneBadge, SpecRow } from "./ItemCard.tsx";

interface Props {
  item: Item;
  keys: Map<string, SpecKey>;
  highlightKeys: string[];
  onClose: () => void;
}

export function ItemModal({ item, keys, highlightKeys, onClose }: Props) {
  const [rawText, setRawText] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  useEffect(() => {
    if (showRaw && rawText === null) api.item(item.id).then((d) => setRawText(d.rawText ?? ""), () => setRawText(""));
  }, [showRaw, rawText, item.id]);

  const entries = Object.entries(item.specs);
  const values = entries.filter(([, v]) => typeof v !== "boolean").map(([k]) => k);
  const yes = entries.filter(([, v]) => v === true).map(([k]) => k);
  const no = entries.filter(([, v]) => v === false).map(([k]) => k);
  const webCount = Object.values(item.sources).filter((s) => s.origin === "web").length;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={item.title}>
      <div
        className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-stone-200 p-4 dark:border-stone-800">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold leading-snug">
              {item.title} <GoneBadge item={item} className="ml-1 align-middle" />
            </h2>
            <div className="mt-0.5 text-sm text-stone-500">
              {formatPrice(item.price, item.currency)}
              {item.identity && <> · {item.identity}</>}
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost btn-sm" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="overflow-y-auto p-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            {item.mainImage && <img src={item.mainImage} alt="" referrerPolicy="no-referrer" className="w-full rounded-lg object-cover" />}
            <div>
              {item.description && <p className="text-sm text-stone-700 dark:text-stone-300">{item.description}</p>}
              <a href={item.url} target="_blank" rel="noreferrer" className="btn-primary btn-sm mt-3">
                Open original listing ↗
              </a>
              {webCount > 0 && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-sky-700 dark:text-sky-400">
                  <GlobeIcon /> {webCount} value{webCount > 1 ? "s" : ""} found on the web (not stated in the listing)
                </p>
              )}
            </div>
          </div>

          <h3 className="mt-5 text-sm font-semibold">Specifications</h3>
          <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
            {values.map((k) => (
              <SpecRow key={k} item={item} k={k} keyInfo={keys.get(k)} highlight={highlightKeys.includes(k)} />
            ))}
          </div>

          {yes.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-semibold">Features ({yes.length})</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {yes.map((k) => (
                  <span
                    key={k}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${
                      highlightKeys.includes(k) ? "bg-brand-100 text-brand-900 dark:bg-brand-900 dark:text-brand-100" : "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300"
                    }`}
                  >
                    {humanizeKey(k)}
                    {item.sources[k]?.origin === "web" && <GlobeIcon className="size-3 text-sky-600" />}
                  </span>
                ))}
              </div>
            </>
          )}
          {no.length > 0 && (
            <p className="mt-3 text-xs text-stone-500">
              Not included: {no.map((k) => humanizeKey(k).toLowerCase()).join(", ")}
            </p>
          )}

          <button className="mt-5 text-xs font-medium text-brand-700 hover:underline dark:text-brand-500" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "Hide page text" : "Show extracted page text"}
          </button>
          {showRaw && (
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-3 text-xs dark:bg-stone-800">{rawText ?? "Loading…"}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
