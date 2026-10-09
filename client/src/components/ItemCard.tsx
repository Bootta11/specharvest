import type { Item, SpecKey, SpecValue } from "@specharvest/shared";
import { formatSpecValue, sourceHost, specLabel } from "@specharvest/shared";
import { safeUrl } from "../lib/api.ts";

/** How a currency is written after an amount ("BAM" is shown as "KM"). */
export const currencyLabel = (currency: string | null) => (currency === "BAM" ? "KM" : currency);

export function formatPrice(price: number | null, currency: string | null) {
  if (price === null) return "Price on request";
  const n = price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return currency ? `${n} ${currencyLabel(currency)}` : n;
}

export function GlobeIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5c2.2 2.3 3.2 4.8 3.2 7.5s-1 5.2-3.2 7.5c-2.2-2.3-3.2-4.8-3.2-7.5s1-5.2 3.2-7.5z" />
    </svg>
  );
}

export function PageIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden="true">
      <path d="M5 2.5h6.5L15 6v11.5H5z" />
      <path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" />
    </svg>
  );
}

/** Shown on listings that disappeared from the shop on a later crawl. */
export function GoneBadge({ item, className = "" }: { item: Pick<Item, "goneAt">; className?: string }) {
  if (!item.goneAt) return null;
  return (
    <span
      title={`No longer listed since ${new Date(item.goneAt).toLocaleDateString()} — probably sold or removed`}
      className={`inline-flex shrink-0 items-center rounded-full bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700 dark:bg-stone-700 dark:text-stone-200 ${className}`}
    >
      Gone
    </span>
  );
}

/** Where a value came from: the listing page itself or a web lookup (with link). Nothing when the value is missing. */
export function SourceBadge({ item, k, compact = false }: { item: Item; k: string; compact?: boolean }) {
  const value = k === "price" ? item.price : item.specs[k];
  if (value === null || value === undefined) return null;
  const source = item.sources[k];
  const link = "inline-flex items-center gap-1 whitespace-nowrap hover:underline";
  if (source?.origin === "web") {
    const sourceUrl = safeUrl(source.sourceUrl);
    const host = sourceHost(sourceUrl);
    const title = `Found by web lookup${source.confidence != null ? ` (${Math.round(source.confidence * 100)}% confident)` : ""}${sourceUrl ? ` — ${sourceUrl}` : ""}`;
    const body = (
      <>
        <GlobeIcon className="size-3.5 shrink-0" />
        {!compact && <span className="truncate">{host ?? "web"}</span>}
      </>
    );
    return sourceUrl ? (
      <a href={sourceUrl} target="_blank" rel="noreferrer" title={title} className={`${link} min-w-0 text-sky-600 dark:text-sky-400`} onClick={(e) => e.stopPropagation()}>
        {body}
      </a>
    ) : (
      <span title={title} className={`${link} text-sky-600 dark:text-sky-400`}>
        {body}
      </span>
    );
  }
  return (
    <a href={safeUrl(item.url)} target="_blank" rel="noreferrer" title="Scraped from the listing page" className={`${link} text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300`} onClick={(e) => e.stopPropagation()}>
      <PageIcon className="size-3.5 shrink-0" />
      {!compact && <span>Listing</span>}
    </a>
  );
}

export function SpecRow({ item, k, keyInfo, highlight }: { item: Item; k: string; keyInfo?: SpecKey; highlight?: boolean }) {
  const value: SpecValue | null | undefined = k === "price" ? item.price : item.specs[k];
  return (
    <div className={`flex items-baseline justify-between gap-3 rounded-md px-2 py-1 text-sm ${highlight ? "bg-brand-50 dark:bg-brand-900/30" : ""}`}>
      <span className="min-w-0 truncate text-stone-500 dark:text-stone-400">{specLabel(k)}</span>
      <span className={`flex shrink-0 items-center gap-1 text-right font-medium ${value === undefined ? "text-stone-400" : ""}`}>
        {k === "price" ? formatPrice(item.price, item.currency) : formatSpecValue(value, keyInfo?.unit)}
        <SourceBadge item={item} k={k} compact />
      </span>
    </div>
  );
}

interface Props {
  item: Item;
  keys: Map<string, SpecKey>;
  highlightKeys: string[];
  onOpen: () => void;
}

/** Numeric/string specs that describe most items in the collection, shown when the plan doesn't name any. */
export function headlineKeys(keys: Map<string, SpecKey>, item: Item, exclude: string[], max: number): string[] {
  return [...keys.values()]
    .filter((k) => k.type !== "boolean" && !exclude.includes(k.key) && item.specs[k.key] !== undefined && !/^(manufacturer|model|title|condition)$/.test(k.key))
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((k) => k.key);
}

export function ItemCard({ item, keys, highlightKeys, onOpen }: Props) {
  const shown = highlightKeys.filter((k) => k !== "title");
  const extra = headlineKeys(keys, item, shown, Math.max(0, 5 - shown.length));
  const features = Object.entries(item.specs).filter(([, v]) => v === true).length;

  return (
    <article className={`card flex flex-col overflow-hidden ${item.goneAt ? "opacity-60" : ""}`}>
      <button onClick={onOpen} className="relative block aspect-[4/3] w-full overflow-hidden bg-stone-100 dark:bg-stone-800" aria-label={`Details for ${item.title}`}>
        {safeUrl(item.mainImage) ? (
          <img src={safeUrl(item.mainImage)} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover transition hover:scale-[1.02]" />
        ) : (
          <span className="flex size-full items-center justify-center text-sm text-stone-400">No image</span>
        )}
        <GoneBadge item={item} className="absolute left-2 top-2 shadow-sm" />
        {item.score != null && (
          <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white" title="Semantic match">
            {Math.round(Math.max(0, item.score) * 100)}% match
          </span>
        )}
      </button>
      <div className="flex flex-1 flex-col p-3">
        <h3 className="line-clamp-2 font-medium leading-snug">
          <button onClick={onOpen} className="text-left hover:text-brand-700 dark:hover:text-brand-500">
            {item.title}
          </button>
        </h3>
        <div className="mt-1 text-lg font-semibold text-brand-800 dark:text-brand-100">{formatPrice(item.price, item.currency)}</div>
        <div className="mt-2 space-y-0.5">
          {shown
            .filter((k) => k !== "price")
            .map((k) => (
              <SpecRow key={k} item={item} k={k} keyInfo={keys.get(k)} highlight />
            ))}
          {extra.map((k) => (
            <SpecRow key={k} item={item} k={k} keyInfo={keys.get(k)} />
          ))}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-xs text-stone-500">
          <span>
            {Object.keys(item.specs).length} specs{features ? ` · ${features} features` : ""}
          </span>
          <a href={safeUrl(item.url)} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline dark:text-brand-500">
            Open listing ↗
          </a>
        </div>
      </div>
    </article>
  );
}
