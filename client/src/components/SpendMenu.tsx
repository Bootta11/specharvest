import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageSummary } from "@specharvest/shared";
import { api, formatUsd } from "../lib/api.ts";
import { SpendBreakdown } from "./SpendBreakdown.tsx";

const REFRESH_MS = 20_000;

/** Header pill with your all-time LLM spend; opens a today / 30 days / all-time breakdown (everyone's: admin dashboard). */
export function SpendMenu() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    api.usage().then(setUsage, () => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    refresh();
    const onDown = (e: PointerEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, refresh]);

  if (!usage) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-stone-200 px-2.5 py-1 text-xs font-medium tabular-nums text-stone-600 hover:border-brand-600 hover:text-brand-800 dark:border-stone-700 dark:text-stone-300 dark:hover:text-brand-100"
        title="Your LLM spend (all time)"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {formatUsd(usage.allTime)}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="LLM spend"
          className="card fixed inset-x-4 top-16 z-30 max-h-[calc(100dvh-5rem)] overflow-y-auto p-4 text-sm shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96"
        >
          <h2 className="font-medium">Your LLM spend</h2>
          <SpendBreakdown usage={usage} />
        </div>
      )}
    </div>
  );
}
