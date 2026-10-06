import type { Item, QueryPlan, SpecKey } from "@specharvest/shared";
import { formatSpecValue, specLabel } from "@specharvest/shared";
import { formatPrice, GlobeIcon, GoneBadge, PageIcon, SourceBadge } from "./ItemCard.tsx";

interface Props {
  items: Item[];
  keys: Map<string, SpecKey>;
  /** Requested fields, in column order. */
  fieldKeys: string[];
  sort: QueryPlan["sort"];
  /** Keys a running web lookup may still fill in. */
  pendingKeys: Set<string>;
  onOpen: (item: Item) => void;
}

function Value({ item, k, keys, pending }: { item: Item; k: string; keys: Map<string, SpecKey>; pending: boolean }) {
  if (k === "price") return <>{formatPrice(item.price, item.currency)}</>;
  const value = item.specs[k];
  if (value === undefined) return <span className="font-normal text-stone-400">{pending ? "looking up…" : "—"}</span>;
  return <>{formatSpecValue(value, keys.get(k)?.unit)}</>;
}

/** Comparison list: one row per item, one column per requested field, every value with its source. */
export function CompareTable({ items, keys, fieldKeys, sort, pendingKeys, onOpen }: Props) {
  const fields = ["price", ...fieldKeys.filter((k) => k !== "price" && k !== "title")];
  const header = (k: string) => (
    <>
      {k === "price" ? "Price" : specLabel(k)}
      {sort?.key === k && <span className="ml-1 text-violet-600 dark:text-violet-400">{sort.dir === "asc" ? "↑" : "↓"}</span>}
    </>
  );

  return (
    <div className="card overflow-hidden">
      {/* Tablet / desktop: table scrolling inside its own box */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500 dark:border-stone-800">
              <th className="w-10 px-3 py-2 font-medium">#</th>
              <th className="sticky left-0 z-10 min-w-56 bg-white px-3 py-2 font-medium dark:bg-stone-900">Item</th>
              {fields.map((k) => (
                <th key={k} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                  {header(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
            {items.map((item, i) => (
              <tr key={item.id} className="group hover:bg-stone-50 dark:hover:bg-stone-800/50">
                <td className="px-3 py-2 align-top text-stone-400">{i + 1}</td>
                <td className="sticky left-0 z-10 max-w-80 bg-white px-3 py-2 align-top group-hover:bg-stone-50 dark:bg-stone-900 dark:group-hover:bg-stone-800">
                  <button onClick={() => onOpen(item)} className="flex w-full min-w-0 items-center gap-3 text-left">
                    {item.mainImage ? (
                      <img src={item.mainImage} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-10 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="size-10 shrink-0 rounded bg-stone-100 dark:bg-stone-800" />
                    )}
                    <span className="line-clamp-2 min-w-0 font-medium leading-snug hover:text-brand-700 dark:hover:text-brand-500">{item.title}</span>
                    <GoneBadge item={item} />
                  </button>
                </td>
                {fields.map((k) => (
                  <td key={k} className={`whitespace-nowrap px-3 py-2 text-right align-top ${sort?.key === k ? "bg-violet-50/60 dark:bg-violet-950/30" : ""}`}>
                    <div className="font-medium">
                      <Value item={item} k={k} keys={keys} pending={pendingKeys.has(k)} />
                    </div>
                    <div className="mt-0.5 flex justify-end text-xs">
                      <SourceBadge item={item} k={k} />
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone: stacked rows */}
      <ul className="divide-y divide-stone-200 sm:hidden dark:divide-stone-800">
        {items.map((item, i) => (
          <li key={item.id} className="p-3">
            <button onClick={() => onOpen(item)} className="flex w-full items-start gap-3 text-left">
              <span className="w-5 shrink-0 pt-0.5 text-sm text-stone-400">{i + 1}</span>
              <span className="line-clamp-2 min-w-0 flex-1 font-medium leading-snug">{item.title}</span>
              <GoneBadge item={item} />
            </button>
            <dl className="mt-2 space-y-1 pl-8 text-sm">
              {fields.map((k) => (
                <div key={k} className="flex items-baseline justify-between gap-3">
                  <dt className="min-w-0 truncate text-stone-500 dark:text-stone-400">{header(k)}</dt>
                  <dd className="flex min-w-0 shrink-0 items-baseline gap-2 text-right font-medium">
                    <Value item={item} k={k} keys={keys} pending={pendingKeys.has(k)} />
                    <span className="flex min-w-0 max-w-28 overflow-hidden text-xs font-normal">
                      <SourceBadge item={item} k={k} />
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-stone-200 px-3 py-2 text-xs text-stone-500 dark:border-stone-800">
        <span className="inline-flex items-center gap-1">
          <PageIcon /> Listing = scraped from the item’s page
        </span>
        <span className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-400">
          <GlobeIcon /> = found by web lookup (click for the source)
        </span>
      </p>
    </div>
  );
}
