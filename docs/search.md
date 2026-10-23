# Search & web lookups

`POST /api/search` with `{ collectionId? | groupId?, query? | plan?, filters?, facets?, enrich? }` — see [API](api.md).

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

**Product words filter the title.** A word naming a kind of product ("lijevak",
"funnel") becomes `title contains <stem>`: the word in the listings' language,
cut to its stem so other grammatical forms match ("lijevak" → `lijev` matches
"LIJEVAKA" too), never shorter than 4 letters. Its English meaning also goes into
`semanticText` for ranking. Vague wishes ("something for salad") only go into
`semanticText`. Without this, a single product word only *ranked* the whole
collection and every item counted as a match. The chip reads
*Title contains “lijev”*, and the Title field in the filter panel is marked
**active** (as is every filtered listing field).

Plans are **cached** in `query_cache` by (collection, lowercased/trimmed
request). A repeated search costs no LLM call. A miss falls back to the same
request cached for another collection with an identical registry signature. A cached plan is used only
while the collection's key registry is unchanged (sha1 of `key:type:unit`) and was made
by the current prompt (`PLAN_VERSION` in `server/src/llm/parse-query.ts` is part of
the hash; bump it whenever the prompt changes what a plan looks like).
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
   Without a sort: best match for a meaning search, otherwise newest first.
5. A meaning search grades every match by its distance from the **best** one
   and by a floor (`server/src/search/relevance.ts`): **High** within 0.08 cosine
   similarity of the best and at least 0.35, **Medium** within 0.18 and at least
   0.25, else **Low**. The floor keeps a search with no real match (e.g. "phone"
   among laptops, best ≈ 0.2) from calling anything strong. The embedding model
   (`all-MiniLM-L6-v2`) is English-only: non-English titles score low and almost
   at random ("funnel" vs "LIJEVAK 17 CM" ≈ 0.11), so on such listings the title
   filter above does the real work. Nothing is dropped: items carry
   `relevance`, the response carries `strongCount` (high + medium), and the UI
   shows ●●● High · ●●○ Medium · ●○○ Low on every row and tile (raw similarity
   in the tooltip). Low matches are faded, and in best-match order a
   *Weaker matches — N* divider comes before the first one. The results bar reads
   "803 matches · 4 strong".

**More than 60 matches.** A search returns one page (`limit`, default 60) of
`items` and of `unknown`, plus `total` and `unknownTotal`. *Show 60 more (N left)*
under the list (and under "can't be judged yet") re-runs the same plan with
`offset` / `unknownOffset` and `enrich: false`: no LLM call, no web lookup. Any
new search, filter, sort or scope change starts again from the first page.

**Choosing the order yourself.** The results bar has a *Sort* menu with newest (or best match), price, name and the
scope's numeric fields, most common first. In the list view, column headers sort too: one click ↑, the next ↓, the
third back to the default. A picked order re-runs the same plan, with no LLM call and no web lookup, and is sent as
`sort` with later typed requests. It applies unless the request asks for its own order ("cheapest" still means
price ↑). Removing the violet sort chip goes back to the default. Prices in different currencies are compared by
amount only, and the results bar says so when that happens.

## Filter panel

*Filters* on the Search tab lists every field of the searched items, each with
the control that fits it. It is a sidebar from 1024 px up (the Filters button
hides it, remembered per browser) and a bottom sheet below that. *Find a field*
searches the English name and the page's own wording.

| Field | Control | Condition |
| --- | --- | --- |
| Number specs, price | from / to | `gte` / `lte` |
| Text specs, currency, collection (group or all collections) | every value with its count | one → `eq`, several → `in` (any of them) |
| Yes/no specs (features) | Yes / No | `eq true` / `eq false` |
| Title, description, product | contains | one `contains` per word (all must appear) |

- **Listing fields** (`price`, `title`, `description`, `product` = the normalized
  `identity`, `currency`, `collection`) are item columns that filter and sort like
  spec keys. Except price they are *strict*: a listing without the value never
  matches (a web lookup can't fill it in), instead of landing in "can't be judged
  yet". A collection filter only narrows the already-checked read scope. The query
  parser knows these fields too, for literal words no spec key covers.
- **Counts** come with the search (`facets: true`, `server/src/search/facets.ts`,
  one extra scan of the scope). Each field is counted over the items that pass
  every *other* active filter, so its own options stay visible while it is
  filtered ("petrol 18" next to a ticked "diesel"). An item missing a filtered
  spec counts toward that field only. Text values are counted case-insensitively;
  up to 500 per field are listed (rarer ones are matched with a contains box), and
  ticked values always are.
- A panel change replaces every condition on that field (LLM-made ones too),
  shows at once as chips, and searches 350 ms later with the edited `plan` — no
  LLM call, and `enrich: false`, so it never starts a paid web lookup. Items missing
  a filtered spec still show under "can't be judged yet" with *Look up on the web*.
- Fields set in the panel **stick across typed requests**: they are sent as
  `filters` next to `query` and merged after parsing (cached plans never hold
  them); the request's own condition on the same field wins. Switching the
  collection or group clears them.
- Text is compared Unicode-aware through `ulower()`, a JS function registered on
  the SQLite connection (SQLite's `lower()` only folds ASCII, so "škoda" would miss
  "Škoda"). `contains` matches literally: `%` and `_` are escaped.
- Listings without a value don't vanish silently: under each listing field the
  panel says how many have none ("30 have none", price: "on request") and, while
  the field is filtered, that they are left out (price: under "can't be judged
  yet"). Facets carry this as `missing`. A listing without a product name is
  searched by its title.
- Filter-only searches have their own, higher rate limit (240 a minute, typed
  requests 30). If one is still hit, the UI waits the `Retry-After` time and
  searches again ("updating in N s") instead of showing an error.

## Results list & sources

Results switch between **List** and **Tiles** at any time. List is one row per
item with a small photo and a column per requested field (price first, then the
sorted-by one), e.g. `biggest boot space` → Boot capacity 540 L, 420 L, 350 L…
Tiles show a large photo per item, for telling items apart by how they look; the
*can't be judged yet* list follows the same choice. Every items list in the app
(search, the [crawl picker](crawling.md#pick-items-before-extracting), a
collection's products) has this switch, each remembered separately per browser
or app.

Every value carries its source: **Listing** (scraped from the item's page,
links to it) or 🌐 *host* (web lookup, links to `sourceUrl`, confidence in the
tooltip). An item's `sources` map only holds non-page keys, so a value without
an entry is from the page. Cells show "looking up…" while a lookup job runs.

## Web lookups (enrichment)

Triggered when the plan has `missingAttributes`, or a filtered/sorted key is
present on fewer than `ENRICH_COVERAGE_THRESHOLD` (80 %) of candidates. Also
available manually ("Look up on the web" under the unknown bucket,
`POST /api/enrich`; shown only when an item there lacks a spec — price and
other listing fields can't be looked up).

In the UI, searches **never start a paid lookup by themselves**: every search
(typed requests too) sends `enrich: false`. The server then returns
`enrichOffer`, and the banner offers **Look up N products on the web**
(about one paid search per product, on your key or the server's), so nothing is
spent until it's pressed. A device can opt back in under *Settings → LLM
provider → Start web lookups automatically* (stored in that browser only). With
it on, a typed request starts lookups as before.

A running lookup can be **stopped** (Stop in the search banner, on the job card
or in *Running now*; `POST /api/jobs/:id/stop`). Products that haven't started
are dropped, and lookups already running finish. Every value found so far is
kept and cached. The job ends as *stopped* with `itemsRemaining` set, so
"Look up N more products" continues where it left off.

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
- **Same product only.** A lookup sends the title, identity, known specs (brand
  and model first), the listing URL and the start of its description. The model
  may use only values stated for that exact product (same brand, model and
  sizes). For a generic or unbranded item, it may use only the shop's own page or
  a page that clearly shows the same item. Each answer names the product and
  brand it came from (`matched_product`, `matched_brand`). When the item has a
  brand spec and the source names a different brand, the value is dropped and
  cached as not found, whatever the model's confidence. The job log says
  `weight_kg skipped — source is "…" (other brand)`. `sourceUrl` is the page
  the model read the value from. A search citation stands in only when it is
  the only one.
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
  the "Web lookup finished/stopped" line and the job card on the Ingest view.
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
- **Fields the listings already have**: when a search asks for a key the
  collection doesn't have (`missingAttributes`), it is first checked against
  the scope's **own fields** of the same type. This is one small `consolidate`
  call per key and collection, remembered in `key_registry_checks` and checked
  again when the collection gains new fields. A match is saved as a key alias,
  and the plan uses the existing field, so e.g. "boot space" sorts by a crawled
  `trunk_volume_l` instead of offering a web lookup. Coverage counts and lookups
  also treat a value stored under any synonym as present.
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
