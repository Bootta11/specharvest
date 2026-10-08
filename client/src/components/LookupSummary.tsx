import { useMemo, useState } from "react";
import type { LookupStats } from "@specharvest/shared";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Chip({ children, tone = "stone", title }: { children: React.ReactNode; tone?: "stone" | "sky" | "emerald" | "amber"; title?: string }) {
  const tones = {
    stone: "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
    sky: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
    emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs tabular-nums ${tones[tone]}`} title={title}>
      {children}
    </span>
  );
}

/**
 * How a web lookup turned listings into products and where the values came
 * from, plus an expandable list of the name variants treated as one product.
 */
export function LookupSummary({ stats, className = "" }: { stats: LookupStats; className?: string }) {
  const [showMerges, setShowMerges] = useState(false);
  // from → to pairs grouped by product, so each product shows its variants once.
  const byProduct = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const { from, to } of stats.merges) m.set(to, [...(m.get(to) ?? []), from]);
    return [...m.entries()];
  }, [stats.merges]);

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip title="Listings missing a value → distinct products after grouping name variants">
          {plural(stats.listings, "listing")} → {plural(stats.products, "product")}
        </Chip>
        {stats.merged > 0 && <Chip tone="sky">{plural(stats.merged, "name variant")} merged</Chip>}
        {stats.cached > 0 && (
          <Chip tone="emerald" title="Answered from earlier lookups or other listings of the same product — no web search">
            {stats.cached} already known
          </Chip>
        )}
        {stats.fromSiblings > 0 && (
          <Chip tone="emerald" title="Copied from another listing of the same product that states it on its own page">
            {plural(stats.fromSiblings, "value")} from sibling listings
          </Chip>
        )}
        {stats.toLookUp > 0 && <Chip tone="sky">{stats.toLookUp} looked up on the web</Chip>}
        {!!stats.prefetched && (
          <Chip tone="emerald" title="Other likely-wanted specs found by the same searches and saved — later searches for them cost nothing">
            +{plural(stats.prefetched, "extra spec")} cached
          </Chip>
        )}
        {stats.remaining > 0 && (
          <Chip tone="amber" title="Over the per-run limit (ENRICH_MAX_LOOKUPS) — products with the most listings went first">
            {stats.remaining} left for next run
          </Chip>
        )}
      </div>

      {byProduct.length > 0 && (
        <div className="mt-1.5">
          <button
            type="button"
            className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-500"
            onClick={() => setShowMerges((v) => !v)}
            aria-expanded={showMerges}
          >
            {showMerges ? "Hide" : "Show"} merged names ({stats.merged})
          </button>
          {showMerges && (
            <ul className="mt-1.5 max-h-64 space-y-1.5 overflow-y-auto rounded-lg bg-stone-50 p-2.5 text-xs dark:bg-stone-900">
              {byProduct.map(([product, variants]) => (
                <li key={product} className="min-w-0">
                  <div className="truncate font-medium text-stone-800 dark:text-stone-200" title={product}>
                    {product}
                  </div>
                  {variants.map((v) => (
                    <div key={v} className="truncate pl-3 text-stone-500" title={v}>
                      ← {v}
                    </div>
                  ))}
                </li>
              ))}
              {stats.merged > stats.merges.length && <li className="text-stone-500">…and {stats.merged - stats.merges.length} more</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
