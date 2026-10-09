# Search & web lookups

`POST /api/search` with `{ collectionId?, query? | plan?, enrich? }`.

## Query plan

The LLM (given the key registry with sample values / numeric ranges) turns the
request into:

```json
{
  "filters": [{ "key": "fuel_type", "op": "eq", "value": "diesel" },
              { "key": "engine_power_kw", "op": "gt", "value": 100 }],
  "sort": { "key": "mileage_km", "dir": "asc" },
  "semanticText": "comfortable family car",
  "missingAttributes": [{ "key": "acceleration_0_100_s", "type": "number", "unit": "s", "label": "0-100 km/h acceleration" }],
  "show": ["boot_capacity_liters"]
}
```

`show` lists attributes the user wants to see or compare without a condition
("compare boot space and power"). Unknown `show` keys are added to
`missingAttributes` and looked up like any other missing key; known ones with
poor coverage also trigger a lookup. Older plans without `show` still parse.

Plans are **cached** in `query_cache` by (collection, lowercased/trimmed
request). A repeated search costs no LLM call. A miss falls back to the same
request cached for another collection with an identical registry signature. A cached plan is used only
while the collection's key registry is unchanged (sha1 of `key:type:unit`).
New, merged or web-added keys trigger a fresh parse. `GET /api/searches`
lists recent cached requests (the UI shows them as *Recent* chips).

The parser is also given every key already looked up on the web
(`web_facts`, including "not found" ones). A later "boot space" request then
reuses `trunk_volume_liters` and hits the cache instead of inventing
`boot_capacity_liters` and paying for a new web search.

Units are converted to the key's unit, other languages map to stored values
("dizel" → "diesel"), superlatives become sorts. The UI shows the plan as chips;
removing one re-runs the search with the edited `plan` (no LLM call).

## Execution

1. `filters.ts` builds a parametrized query (listings marked *gone* are
   excluded unless `includeGone`) — keys are bound, never
   interpolated (`json_extract(specs, '$.' || json_quote(?))`). Each condition
   is `value IS NULL OR <cond>` so items **missing** a filtered key come back.
2. Items missing an active filter key go to the **unknown** bucket ("can't be
   judged yet") instead of disappearing.
3. If `semanticText` is set, candidates are ranked by cosine similarity in
   LanceDB (`item_id IN (…)` prefilter).
4. An explicit sort wins; semantic score breaks ties; missing sort values go last.

## Results list & sources

When the plan names any fields (sort, filters, `show`, missing attributes), the
UI defaults to a **List** view: one row per item, a column per requested field
(sorted-by first), e.g. `biggest boot space` → Boot capacity 540 L, 420 L,
350 L… The Cards/List choice is remembered per browser.

Every value carries its source: **Listing** (scraped from the item's page,
links to it) or 🌐 *host* (web lookup, links to `sourceUrl`, confidence in the
tooltip). An item's `sources` map only holds non-page keys, so a value without
an entry is from the page. Cells show "looking up…" while a lookup job runs.

## Web lookups (enrichment)

Triggered when the plan has `missingAttributes`, or a filtered/sorted key is
present on fewer than `ENRICH_COVERAGE_THRESHOLD` (80 %) of candidates. Also
available manually ("Look up on the web" under the unknown bucket,
`POST /api/enrich`).

- Items are grouped by `identity` (normalized brand/model/variant/year from
  extraction), so **one lookup answers every listing of the same model**.
- Spelling variants of the same product ("golf life+ 2.0 tdi" / "golf life plus
  2.0 tdi 85kw") are grouped first (`server/src/enrich/group.ts`): identities
  never seen before go to one LLM call per ~120 (purpose `group`), together with
  the already-known products of the same brands. The result is saved in
  `identity_aliases` (raw → canonical), so each identity is asked about only
  once, and `web_facts` are stored under the canonical identity. Grouping is
  strict: a deterministic check (`sameProduct`) rejects any merge whose brand,
  year, displacement, power (hp/kW-aware), gearbox/drivetrain or trim words
  differ. The longer name may only add engine words like "hybrid" or "t-gdi".
  If the call fails, identities stay ungrouped and are retried next job.
  Matching has two levels. **Certain** (`sameProduct`): nothing contradicts
  and the model/trim words are identical. Engine words only set the fuel
  (`turbo` = `t-gdi`), and years/power/engine may be missing on one side.
  These are grouped automatically, by the LLM for new names and by a free
  rule-based `regroup` over all names. **Possible** (`maybeSameProduct`): one
  name's words are a subset of the other's (usually a missing trim). In
  **Strict** mode (the default) these are never grouped automatically; the
  owner confirms them in the Products view ("Same product" / "Different
  product"). Decisions and "Not the same" splits are stored in
  `identity_rejections`, so the same pair is never grouped or suggested again.
  **Grouping mode** is set per collection by its owner (Products view →
  *Grouping: Strict · Loose*, `PATCH /api/collections/:id {grouping}`). In
  **Loose** mode, a possible match with exactly **one** candidate is grouped
  automatically, the same as clicking "Same product" (free, no LLM). This runs
  when switching to Loose, after crawls, before web lookups and when the owner
  opens Products. Names with several candidates still wait for the owner, and
  rejected pairs are never grouped. Product names are shared, so a loose merge
  also applies to other collections with those names. Switching back to Strict
  stops new loose merges; existing ones stay until split ("Not the same").
  Grouping also runs at the end of every crawl that extracted something, and
  the first time a collection's owner opens its **Products** view
  (`GET /api/collections/:id/products`; read-only viewers are never billed).
  Collections report `productCount` (active listings, variants counted once).
  Each merge is written to the job log (`Same product: "a" → "b"`), and the
  item modal shows a "Same product" section (from `GET /api/items/:id` →
  `sameProduct`) listing the other listings you can see and the name variant
  each was grouped from.
- Before a paid lookup, a value that another listing of the same product states
  on **its own page** is copied (saved as a web fact with that listing's URL,
  confidence 0.95).
- Cached `web_facts` are applied synchronously during the search; only
  never-looked-up identities start a background job (max `ENRICH_MAX_LOOKUPS`
  per job, products with the most listings first). When capped, the job's
  `itemsRemaining` drives a "Look up N more products" button, which re-runs
  the search with enrichment so the next batch starts (the first is cached now).
- Each lookup job stores a breakdown on `job.lookup` (listings → products,
  name variants merged, already known, copied from siblings, looked up,
  left for next run, plus the merged names). It is shown in the search banner,
  the "Web lookup finished" line and the job card on the Ingest view.
- **Predicted extras (prefetch)**: the search fee is per search, not per
  attribute, so each paid lookup also asks for up to `ENRICH_PREFETCH_MAX`
  (12) likely-wanted specs nobody requested yet — keys already looked up for
  this collection or for products of the same brands, then the collection's
  *spec profile* (spec-sheet attributes for this kind of product, never
  listing-specific ones like mileage or color; one cheap `predict` LLM call
  per collection, stored in `settings`). The model fills them only from pages
  it already found. Found values are cached in `web_facts` and applied when
  someone asks for them (free, instant); misses are **not** cached as "not
  found", so a later explicit request still gets a real lookup. Cost: a few
  output tokens per extra (~$0.002 for 12). Shown as "+N extra specs cached".
- **Shared across users**: `web_facts` are global. Two jobs (any users) that
  need the same product + key at the same time share one paid lookup — the
  second waits for the first and reads the cache.
- **Key synonyms**: before lookups, web keys never checked before are reviewed
  once for synonyms of known ones (`trunk_volume_liters` = `boot_capacity_liters`,
  one `consolidate` call) and saved in `key_aliases`. Cache reads, sibling
  copies and query plans treat synonyms as one key.
- "Not found" answers are retried after `ENRICH_NOT_FOUND_TTL_DAYS` (30, `0` =
  never); found facts don't expire.
- Each lookup is one chat completion with the OpenRouter server tool
  `{"type":"openrouter:web_search","parameters":{"engine":"auto","max_results":5,"max_uses":1}}`
  (`WEB_SEARCH_MAX_USES`, default 1 — each extra search is another fee)
  ([docs](https://openrouter.ai/docs/guides/features/server-tools/web-search)),
  asking for value + unit + confidence + source URL per attribute.
- Answers below `ENRICH_MIN_CONFIDENCE` (0.6) are cached as "not found".
- A value from the item's own page always wins over a web value; re-crawls keep
  web values the page still doesn't state.
- The UI follows the job over SSE and re-runs the same plan with
  `enrich: false` when it finishes (no loops).

Cost: roughly one web search per distinct product (requested + predicted attributes together)
(OpenRouter's Exa engine is about $0.007/search) plus tokens. The job reports
`webSearches` from `usage.server_tool_use`.
