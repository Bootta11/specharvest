import { useEffect, useState, type ReactNode } from "react";
import type { Collection, Facet, Filter, SpecKey } from "@specharvest/shared";
import { displayUnit, isListingField, isStrictField, specLabel } from "@specharvest/shared";
import { currencyLabel } from "./ItemCard.tsx";

type RangeFacet = Extract<Facet, { kind: "range" }>;
type ValuesFacet = Extract<Facet, { kind: "values" }>;
type BooleanFacet = Extract<Facet, { kind: "boolean" }>;

interface Props {
  facets: Facet[];
  /** Registry keys (labels in the page's own wording, units). */
  keys: Map<string, SpecKey>;
  /** The plan's filters — what the controls show. */
  filters: Filter[];
  collections: Collection[];
  /** Replace every condition on `key` with `next` ([] = no condition). */
  onChange: (key: string, next: Filter[]) => void;
}

const LISTING_ORDER = ["title", "price", "product", "description", "currency", "collection"];
const TEXT_PLACEHOLDER: Record<string, string> = { title: "Words in the title", product: "e.g. golf 2.0 tdi", description: "Words in the description" };

/** Case-insensitive, like the server's comparison. */
const same = (a: string | number, b: string | number) => String(a).toLowerCase() === String(b).toLowerCase();
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

function selectedValues(filters: Filter[], key: string): Array<string | number> {
  return filters.flatMap((f) => {
    if (f.key !== key) return [];
    if (f.op === "in" && Array.isArray(f.value)) return f.value;
    if (f.op === "eq" && (typeof f.value === "string" || typeof f.value === "number")) return [f.value];
    return [];
  });
}

/** The bounds a key's conditions set: gt/gte → min, lt/lte → max, eq → both. */
function numberRange(filters: Filter[], key: string): { min?: number; max?: number } {
  const out: { min?: number; max?: number } = {};
  for (const f of filters) {
    if (f.key !== key || typeof f.value !== "number") continue;
    if (f.op === "gt" || f.op === "gte" || f.op === "eq") out.min = f.value;
    if (f.op === "lt" || f.op === "lte" || f.op === "eq") out.max = f.value;
  }
  return out;
}

const valuesFilter = (key: string, values: Array<string | number>): Filter[] =>
  values.length === 0 ? [] : values.length === 1 ? [{ key, op: "eq", value: values[0] }] : [{ key, op: "in", value: values }];

const rangeFilters = (key: string, min?: number, max?: number): Filter[] => [
  ...(min !== undefined ? [{ key, op: "gte" as const, value: min }] : []),
  ...(max !== undefined ? [{ key, op: "lte" as const, value: max }] : []),
];

/** Every word must appear: one `contains` per word. */
const containsFilters = (key: string, text: string): Filter[] =>
  [...new Set(text.toLowerCase().split(/\s+/).filter(Boolean))].map((w) => ({ key, op: "contains" as const, value: w }));

const containsText = (filters: Filter[], key: string) =>
  filters
    .filter((f) => f.key === key && f.op === "contains" && typeof f.value === "string")
    .map((f) => f.value)
    .join(" ");

function booleanChoice(filters: Filter[], key: string): boolean | null {
  const f = filters.find((x) => x.key === key && x.op === "eq" && typeof x.value === "boolean");
  return typeof f?.value === "boolean" ? f.value : null;
}

/** What happens to listings without a value for a listing field — so none disappear unnoticed. */
function missingNote(f: Facet, filtered: boolean): string | null {
  if (f.missing <= 0) return null;
  const n = f.missing;
  if (f.key === "price") return filtered ? `${n} on request are under “can't be judged yet”` : `${n} on request`;
  if (filtered && isStrictField(f.key)) return `${n} without it ${n === 1 ? "is" : "are"} left out`;
  return `${n} ${n === 1 ? "has" : "have"} none`;
}

function parseNumber(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** What a collapsed field row shows when the field is filtered. */
function summary(facet: Facet, filters: Filter[], label: (v: string | number) => string): string | null {
  if (!filters.some((f) => f.key === facet.key)) return null;
  if (facet.kind === "range") {
    const { min, max } = numberRange(filters, facet.key);
    if (min !== undefined && max !== undefined) return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
    if (min !== undefined) return `≥ ${fmt(min)}`;
    if (max !== undefined) return `≤ ${fmt(max)}`;
  }
  const picked = selectedValues(filters, facet.key);
  if (picked.length) return picked.map(label).join(", ");
  const words = containsText(filters, facet.key);
  return words ? `contains ${words}` : "filtered";
}

export function FilterIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 4.5h14l-5.5 6.5v5l-3 1.5v-6.5z" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`size-3.5 shrink-0 text-stone-400 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true">
      <path d="M7.5 5l5 5-5 5" />
    </svg>
  );
}

/** Min/max boxes, applied on Enter or when leaving a box. */
function RangeControl({ facet, unit, filters, onChange }: { facet: RangeFacet; unit: string | null; filters: Filter[]; onChange: (next: Filter[]) => void }) {
  const range = numberRange(filters, facet.key);
  const [min, setMin] = useState(range.min?.toString() ?? "");
  const [max, setMax] = useState(range.max?.toString() ?? "");
  // Follow changes made elsewhere (a removed chip, Clear all, a typed request).
  useEffect(() => setMin(range.min?.toString() ?? ""), [range.min]);
  useEffect(() => setMax(range.max?.toString() ?? ""), [range.max]);

  const commit = () => {
    const from = parseNumber(min);
    const to = parseNumber(max);
    if (from !== range.min || to !== range.max) onChange(rangeFilters(facet.key, from, to));
  };
  const name = specLabel(facet.key);
  const box = (value: string, set: (v: string) => void, bound: number | null, label: string) => (
    <input
      className="input h-9 min-w-0 flex-1 px-2"
      type="number"
      inputMode="decimal"
      step="any"
      value={value}
      placeholder={bound !== null ? fmt(bound) : label}
      aria-label={`${name} ${label}`}
      onChange={(e) => set(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        commit();
      }}
    />
  );
  return (
    <div className="flex items-center gap-1.5">
      {box(min, setMin, facet.min, "from")}
      <span className="text-stone-400">–</span>
      {box(max, setMax, facet.max, "to")}
      {unit && <span className="shrink-0 text-xs text-stone-500">{unit}</span>}
    </div>
  );
}

/** Words that must all appear; applied on Enter, when leaving the box, or when it's cleared. */
function ContainsBox({ fieldKey, filters, placeholder, onChange }: { fieldKey: string; filters: Filter[]; placeholder: string; onChange: (next: Filter[]) => void }) {
  const current = containsText(filters, fieldKey);
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current]);

  const commit = (value = text) => {
    const next = containsFilters(fieldKey, value);
    if (next.map((f) => f.value).join(" ") !== current) onChange(next);
  };
  return (
    <input
      className="input h-9 px-2"
      type="search"
      value={text}
      placeholder={placeholder}
      aria-label={`${specLabel(fieldKey)} contains`}
      onChange={(e) => {
        setText(e.target.value);
        if (!e.target.value) commit("");
      }}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        commit();
      }}
    />
  );
}

/** Every value with its count; several can be ticked (any of them matches). */
function ValuesControl({ facet, filters, label, onChange }: { facet: ValuesFacet; filters: Filter[]; label: (v: string | number) => string; onChange: (next: Filter[]) => void }) {
  const [find, setFind] = useState("");
  const picked = selectedValues(filters, facet.key);
  const ticked = (v: string | number) => picked.some((p) => same(p, v));
  // Values no item has under the other filters only stay while ticked.
  const values = facet.values.filter((v) => v.count > 0 || ticked(v.value));
  const q = find.trim().toLowerCase();
  const shown = q ? values.filter((v) => label(v.value).toLowerCase().includes(q)) : values;
  const toggle = (v: string | number, on: boolean) => onChange(valuesFilter(facet.key, on ? [...picked, v] : picked.filter((p) => !same(p, v))));

  return (
    <div className="space-y-2">
      {values.length > 8 && (
        <input
          className="input h-8 px-2 text-xs"
          type="search"
          value={find}
          placeholder={`Search ${values.length} values…`}
          aria-label={`Search ${specLabel(facet.key)} values`}
          onChange={(e) => setFind(e.target.value)}
        />
      )}
      {values.length === 0 ? (
        <p className="text-xs text-stone-500">No values among the current results.</p>
      ) : (
        <ul className="max-h-64 space-y-px overflow-y-auto">
          {shown.map((v) => (
            <li key={String(v.value)}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-stone-50 dark:hover:bg-stone-800/50">
                <input type="checkbox" className="size-4 shrink-0 accent-brand-700" checked={ticked(v.value)} onChange={(e) => toggle(v.value, e.target.checked)} />
                <span className="min-w-0 flex-1 truncate" title={label(v.value)}>
                  {label(v.value)}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-stone-500">{v.count}</span>
              </label>
            </li>
          ))}
          {shown.length === 0 && <li className="px-1.5 py-1 text-xs text-stone-500">No value matches “{find}”.</li>}
        </ul>
      )}
      {facet.more > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-stone-500">{facet.more} rarer values aren't listed — match them by text:</p>
          <ContainsBox fieldKey={facet.key} filters={filters} placeholder="Contains…" onChange={onChange} />
        </div>
      )}
    </div>
  );
}

/** A yes/no feature: Yes / No toggles (pressing the active one again clears it). */
function FeatureRow({ facet, hint, filters, onChange }: { facet: BooleanFacet; hint?: string; filters: Filter[]; onChange: (next: Filter[]) => void }) {
  const choice = booleanChoice(filters, facet.key);
  const name = specLabel(facet.key);
  const button = (value: boolean, text: string) => (
    <button
      type="button"
      aria-pressed={choice === value}
      onClick={() => onChange(choice === value ? [] : [{ key: facet.key, op: "eq", value }])}
      className={`px-2 py-1 text-xs font-medium transition ${
        choice === value
          ? value
            ? "bg-brand-700 text-white"
            : "bg-stone-700 text-white dark:bg-stone-200 dark:text-stone-900"
          : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
      }`}
    >
      {text}
    </button>
  );
  return (
    <li className={`flex items-center gap-2 px-1.5 py-1 text-sm ${facet.yes + facet.no === 0 && choice === null ? "opacity-50" : ""}`}>
      <span className="min-w-0 flex-1 truncate" title={hint && hint !== facet.key ? `${name} (${hint})` : name}>
        {name}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-stone-500" title={`${facet.yes} with it, ${facet.no} without`}>
        {facet.yes}
      </span>
      <span className="inline-flex shrink-0 divide-x divide-stone-300 overflow-hidden rounded-md border border-stone-300 dark:divide-stone-700 dark:border-stone-700" role="group" aria-label={name}>
        {button(true, "Yes")}
        {button(false, "No")}
      </span>
    </li>
  );
}

function Section({ title, count, open, onToggle, children }: { title: string; count: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="border-t border-stone-200 pt-2 first:border-t-0 first:pt-0 dark:border-stone-800">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-1.5 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
        <Chevron open={open} />
        <span className="flex-1">{title}</span>
        <span className="font-normal normal-case tracking-normal">{count}</span>
      </button>
      {open && <div className="pb-1">{children}</div>}
    </section>
  );
}

/**
 * Every field of the searched items: the listing's own fields, every number/text spec and every yes/no feature,
 * each with the control that fits it. Counts come from the server (each field counted over the other filters).
 */
export function FilterPanel({ facets, keys, filters, collections, onChange }: Props) {
  const [find, setFind] = useState("");
  /** Open/closed state the user set for sections ("§…") and fields; otherwise the defaults below apply. */
  const [toggled, setToggled] = useState<Map<string, boolean>>(() => new Map());
  const q = find.trim().toLowerCase();
  const filtered = new Set(filters.map((f) => f.key));
  const matches = (key: string) => !q || [specLabel(key), keys.get(key)?.label ?? "", key].some((s) => s.toLowerCase().includes(q));
  const isOpen = (id: string, byDefault: boolean) => toggled.get(id) ?? byDefault;
  const toggle = (id: string, byDefault: boolean) => setToggled((m) => new Map(m).set(id, !(m.get(id) ?? byDefault)));

  const collectionName = (id: number) => collections.find((c) => c.id === id)?.name ?? `Collection ${id}`;
  const labelFor = (key: string) => (v: string | number) => (key === "collection" ? collectionName(Number(v)) : String(v));
  const unitFor = (f: RangeFacet) => (f.key === "price" ? currencyLabel(f.unit) : displayUnit(f.unit));
  const change = (key: string) => (next: Filter[]) => onChange(key, next);

  const byKey = new Map(facets.map((f) => [f.key, f]));
  // Currency and collection only narrow anything with two values or more.
  const listing = LISTING_ORDER.map((k) => byKey.get(k)).filter(
    (f): f is Facet => !!f && matches(f.key) && (f.kind !== "values" || f.values.length > 1 || filtered.has(f.key)),
  );
  const specs = facets.filter((f): f is RangeFacet | ValuesFacet => !isListingField(f.key) && (f.kind === "range" || f.kind === "values") && matches(f.key));
  const features = facets.filter((f): f is BooleanFacet => !isListingField(f.key) && f.kind === "boolean" && matches(f.key));
  const setIn = (list: Facet[]) => list.filter((f) => filtered.has(f.key)).length;

  const control = (f: Facet) => {
    if (f.kind === "range") return <RangeControl facet={f} unit={unitFor(f)} filters={filters} onChange={change(f.key)} />;
    if (f.kind === "values") return <ValuesControl facet={f} filters={filters} label={labelFor(f.key)} onChange={change(f.key)} />;
    if (f.kind === "text") return <ContainsBox fieldKey={f.key} filters={filters} placeholder={TEXT_PLACEHOLDER[f.key] ?? "Contains…"} onChange={change(f.key)} />;
    return null;
  };
  const sectionCount = (list: Facet[]) => {
    const n = setIn(list);
    return n ? `${list.length} · ${n} set` : list.length;
  };
  // While searching, every section with a match is open and a short list of fields opens up.
  const sectionOpen = (id: string, list: Facet[], byDefault: boolean) => (q ? list.length > 0 : isOpen(id, byDefault));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pb-2 pt-3">
        <input className="input h-9" type="search" value={find} placeholder="Find a field…" aria-label="Find a field" onChange={(e) => setFind(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {listing.length > 0 && (
          <Section title="Listing" count={sectionCount(listing)} open={sectionOpen("§listing", listing, true)} onToggle={() => toggle("§listing", true)}>
            <div className="space-y-3 px-1.5 pt-1">
              {listing.map((f) => (
                <div key={f.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium">{specLabel(f.key)}</span>
                    {f.kind !== "text" && <span className="text-xs tabular-nums text-stone-500">{f.count}</span>}
                  </div>
                  {control(f)}
                  {missingNote(f, filtered.has(f.key)) && <p className="text-xs text-stone-500">{missingNote(f, filtered.has(f.key))}</p>}
                </div>
              ))}
            </div>
          </Section>
        )}

        {specs.length > 0 && (
          <Section title="Specifications" count={sectionCount(specs)} open={sectionOpen("§specs", specs, true)} onToggle={() => toggle("§specs", true)}>
            <ul>
              {specs.map((f) => {
                const open = isOpen(f.key, filtered.has(f.key) || (!!q && specs.length <= 3));
                const set = summary(f, filters, labelFor(f.key));
                const hint = keys.get(f.key)?.label;
                return (
                  <li key={f.key} className={f.count === 0 && !set ? "opacity-60" : ""}>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggle(f.key, filtered.has(f.key) || (!!q && specs.length <= 3))}
                      title={hint && hint !== f.key ? `${specLabel(f.key)} (${hint})` : undefined}
                      className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-stone-50 dark:hover:bg-stone-800/50"
                    >
                      <Chevron open={open} />
                      <span className="min-w-0 flex-1 truncate font-medium">{specLabel(f.key)}</span>
                      <span className={`max-w-[55%] shrink-0 truncate text-xs ${set ? "font-medium text-brand-700 dark:text-brand-500" : "tabular-nums text-stone-500"}`}>{set ?? f.count}</span>
                    </button>
                    {open && <div className="px-1.5 pb-2 pt-1">{control(f)}</div>}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {features.length > 0 && (
          <Section title="Features" count={sectionCount(features)} open={sectionOpen("§features", features, setIn(features) > 0)} onToggle={() => toggle("§features", setIn(features) > 0)}>
            <ul>
              {features.map((f) => (
                <FeatureRow key={f.key} facet={f} hint={keys.get(f.key)?.label} filters={filters} onChange={change(f.key)} />
              ))}
            </ul>
          </Section>
        )}

        {listing.length + specs.length + features.length === 0 && <p className="py-6 text-center text-sm text-stone-500">{q ? `No field matches “${find}”.` : "Nothing to filter yet."}</p>}
      </div>
    </div>
  );
}
