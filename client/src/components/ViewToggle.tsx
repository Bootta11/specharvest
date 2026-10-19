import { useState } from "react";
import { safeUrl, storageGet, storageSet } from "../lib/api.ts";

/** How an items list is laid out: compact rows, or image tiles for telling items apart by their photo. */
export type ViewMode = "list" | "tiles";

/** The view picked for one list, remembered per browser/app ("cards" is what older builds stored for tiles). */
export function useViewMode(storageKey: string, fallback: ViewMode = "list"): [ViewMode, (v: ViewMode) => void] {
  const [view, setViewState] = useState<ViewMode>(() => {
    const stored = storageGet(storageKey);
    return stored === "tiles" || stored === "cards" ? "tiles" : stored === "list" ? "list" : fallback;
  });
  const setView = (v: ViewMode) => {
    setViewState(v);
    storageSet(storageKey, v);
  };
  return [view, setView];
}

/** List / Tiles switch. Icons only on phones, icon + label from `sm` up. */
export function ViewToggle({ value, onChange, className = "" }: { value: ViewMode; onChange: (v: ViewMode) => void; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 rounded-lg border border-stone-200 p-0.5 text-xs dark:border-stone-700 ${className}`} role="group" aria-label="View">
      {(["list", "tiles"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          aria-label={v === "list" ? "List view" : "Tiles view"}
          title={v === "list" ? "List" : "Tiles — bigger images"}
          className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1 font-medium ${
            value === v ? "bg-brand-600 text-white" : "text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          }`}
        >
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            {v === "list" ? <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h0M2.5 8h0M2.5 12h0" /> : <path d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z" />}
          </svg>
          <span className="hidden sm:inline">{v === "list" ? "List" : "Tiles"}</span>
        </button>
      ))}
    </span>
  );
}

/** An item's image (lazy, no referrer) filling its box; a broken or missing one leaves the placeholder. */
export function Thumb({ src, className = "", placeholder = false }: { src: string | null | undefined; className?: string; placeholder?: boolean }) {
  const url = safeUrl(src);
  const [broken, setBroken] = useState(false);
  return (
    <span className={`flex items-center justify-center overflow-hidden bg-stone-100 text-xs text-stone-400 dark:bg-stone-800 ${className}`}>
      {url && !broken ? (
        <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        placeholder && "No image"
      )}
    </span>
  );
}
