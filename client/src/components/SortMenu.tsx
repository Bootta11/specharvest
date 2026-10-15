import type { QueryPlan, SpecKey } from "@specharvest/shared";
import { specLabel } from "@specharvest/shared";

export type Sort = QueryPlan["sort"];

/** Numeric fields offered in the menu, most common first. */
const MAX_FIELDS = 30;

const encode = (s: Sort) => (s ? `${s.dir}:${s.key}` : "");
const decode = (v: string): Sort => {
  if (!v) return null;
  const [dir, ...key] = v.split(":");
  return { key: key.join(":"), dir: dir === "desc" ? "desc" : "asc" };
};

/** "Power (kW)", "Price", "Name". */
export function sortFieldLabel(key: string, keys: Map<string, SpecKey>): string {
  if (key === "price") return "Price";
  if (key === "title") return "Name";
  const unit = keys.get(key)?.unit;
  return `${specLabel(key)}${unit ? ` (${unit})` : ""}`;
}

/**
 * The order of the results: newest (or relevance for a meaning search), price, name, or any numeric field of the
 * searched collections. A sort the typed request chose on another field shows as its own option.
 */
export function SortMenu({ sort, keys, semantic, onChange }: { sort: Sort; keys: Map<string, SpecKey>; semantic: boolean; onChange: (sort: Sort) => void }) {
  const numeric = [...keys.values()]
    .filter((k) => k.type === "number" && k.count > 0 && k.key !== "price")
    .sort((a, b) => b.count - a.count || specLabel(a.key).localeCompare(specLabel(b.key)))
    .slice(0, MAX_FIELDS);
  const listed = new Set(["price", "title", ...numeric.map((k) => k.key)]);
  const both = (key: string, low: string, high: string) => (
    <>
      <option value={`asc:${key}`}>{low}</option>
      <option value={`desc:${key}`}>{high}</option>
    </>
  );

  return (
    <label className="inline-flex items-center gap-1.5 text-xs">
      <span>Sort</span>
      <select className="input w-auto max-w-48 py-1 pr-7 text-xs" value={encode(sort)} onChange={(e) => onChange(decode(e.target.value))} aria-label="Sort results">
        <option value="">{semantic ? "Best match" : "Newest first"}</option>
        {both("price", "Price: low to high", "Price: high to low")}
        {both("title", "Name: A–Z", "Name: Z–A")}
        {sort && !listed.has(sort.key) && <option value={encode(sort)}>{`${sortFieldLabel(sort.key, keys)} ${sort.dir === "asc" ? "↑" : "↓"}`}</option>}
        {numeric.length > 0 && (
          <optgroup label="Fields">
            {numeric.map((k) => (
              <SortPair key={k.key} name={sortFieldLabel(k.key, keys)} k={k.key} />
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

function SortPair({ name, k }: { name: string; k: string }) {
  return (
    <>
      <option value={`asc:${k}`}>{name} ↑</option>
      <option value={`desc:${k}`}>{name} ↓</option>
    </>
  );
}
