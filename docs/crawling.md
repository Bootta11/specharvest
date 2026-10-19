# Crawling

A crawl job (`POST /api/crawl`) runs five stages; progress streams over
`GET /api/jobs/:id/events`.

## 0. Page check

Before anything is crawled, the form asks `POST /api/crawl/inspect` what the URL is
(`crawler/inspect.ts`) — as soon as it's typed (debounced) or shared:

1. **What we know about the site**: a saved listing structure for the host whose card
   selector finds ≥ 10 items here, or a URL a collection already crawls as its listing (with
   at least one card still there) → *listing*; the URL matches its item-URL pattern →
   *item* (a few matching cards can be an item page's "similar ads" strip).
2. **Structured data**: one JSON-LD `Product`/`Vehicle` (related products inside it don't
   count) or `og:type=product` → *item*; several products, `ItemList` or `CollectionPage` →
   *listing*; `NewsArticle`/`Article`/`BlogPosting` or `og:type=article` → *other*.
3. Otherwise **one small LLM call** (detect tier) on the page's title, link/price counts
   and visible text.

Costs one page load and at most one small LLM call; cached per URL for 10 minutes.
The form then adapts:

- *listing* → crawl as below.
- *item* → **Add item**: `POST /api/crawl` with `kind: "item"` adds that one page to a
  collection you can edit (default: your newest one from the same site) or to a new
  collection (named after the item's breadcrumb category). Hand-added items are never
  marked gone, and a *Re-crawl* re-opens their pages too (LLM only if they changed). A
  collection started from an item has no listing: its *Re-check* deep-checks its items. When
  the page has a breadcrumb category, the form offers to crawl that listing instead.
- *other* (news, blog…) → a warning; *Start crawl* stays off until *Crawl anyway*.

If the check fails or takes over 25 s, the form works as before.

## 1. Listing detection (once per collection)

Strategy adapted from twinlisting:

1. Render the start URL (`gotoAndSettle`: `load` + bounded network-idle, scroll
   to the bottom for lazy content, flatten shadow DOM, one retry).
2. `sanitizeForLlm` keeps structure + classes (head + tail when huge, since
   pagination sits at the end).
3. LLM returns `listItemSelector` + pagination (`pages` / `loadMore` /
   `infiniteScroll` / `urlPage`).
4. **Verify in the live DOM**: the selector must yield ≥ 2 item URLs. Otherwise
   retry once with a grounding hint (classes that repeat 3+ times), then fall
   back to a link-shape heuristic (most common same-origin path pattern).
5. An item-URL prefix pattern (e.g. `^https://olx\.ba/artikal/`) is inferred
   from the found links to drop promos/ads inside the grid: the deepest directory ≥ 80 % of
   them share, so it doesn't also match the site's listing pages (the page check would take
   those for item pages). Patterns saved before this looked at the first path segment only;
   a walk that finds a tighter one fitting all its items saves it, and the server narrows
   them at startup from each collection's items (or the site's, for one with < 3).
6. **Page-param probing**: load `?page=2` (then `p`, `pg`, `paged`, `strana`, …).
   If it yields new items, URL paging wins — it is the most reliable mechanism
   and handles SPA "next" buttons that have no `href` (OLX.ba is one).

The result is saved on the collection; a re-crawl reuses it and only
re-detects when it stops matching. A new collection on a host another
collection (anyone's) already detected tries that structure first and keeps
it when it yields an item on the live page — no LLM call. A structure verified on
the site this way also accepts a listing with a single card.

Fresh detection needs ≥ 2 cards to verify a selector. On a site we don't know yet, a
listing with one card still gets crawled: its one item is indexed, but the selector is
not saved, since one card proves too little to reuse it on the site's other listings
(a re-crawl detects again, or reuses a structure the site has learned since).

Crawls of the same site that start together (server crawls without a saved structure)
don't each detect it: the first one detects, and the others wait for it, up to 2 min,
then reuse its structure. That saves the LLM calls, and lets a one-card listing reuse a
proper structure.

## 2. Listing walk

Walkers collect item URLs (deduped, tracking params stripped) until
`maxPages` / `maxItems`, an empty page, or a page with nothing new. A JS-only
"next" button is clicked and the walker waits for the card set to change. A
"next" link that only points back at the same page (`href="#"`, as in
Bootstrap-Vue pagers) counts as such a button: it is clicked, not followed.

Items are **indexed while the walk goes on**: each listing page's new cards are
sorted right away (new → extract, existing → change check) and queued for the
detail workers, so the first results appear after page 1 instead of after the
last page. The walk keeps its own browser page, so a crawl has up to
`SCRAPE_MAX_CONCURRENT_PAGES` + 1 pages open. Hand-added items and gone-marking
still wait for the whole walk.

**Page slots.** Every crawl and page check on the server shares one pool of browser pages
(`crawler/slots.ts`): `SCRAPE_MAX_CONCURRENT_PAGES` per configured browser, plus `BURST_TABS` per
rented one ([extra browsers](deployment.md#crawl-capacity)). Each page runs in the browser with
the most free pages (`crawler/browser-pool.ts`). When it's full, waiting
pages go in this order: page checks and single added items (someone is looking at the form),
then listing detection and walks (a crawl's first results), then item pages. Under load a new
crawl therefore starts producing results soon, instead of queueing behind every item page
other crawls have queued. Pages run in the user's own browser (`runner: "browser"`) don't use
the pool.

## 3. Item extraction

Per new or changed item (concurrency `SCRAPE_MAX_CONCURRENT_PAGES`; see
[Re-crawls](#re-crawls-change-detection) for what counts as changed):

- `snapshotDetail` reads `innerText` of `main` (keeps label/value line breaks)
  after removing nav/footer/cookie-consent; JSON-LD / OpenGraph give reliable
  title/price/image defaults.
- The LLM returns English snake_case keys with unit suffixes, normalized
  numbers and booleans, reusing registry keys. Specs come back as compact
  tuples `[key, value, unit, label]` — dealer pages list 100+ equipment items
  and the verbose object form ran past the token limit.
- A truncated/derailed JSON answer is **salvaged** up to the last complete
  element rather than discarded.
- In a collection with no keys yet, the **first item runs alone** to seed the
  registry before parallel workers start; otherwise each worker invents its own
  names. Re-crawls (registry already filled) start in parallel at once.
- A bot challenge on a detail page is retried with backoff (8 s, 20 s).
- **Reuse across collections**: if the same ad (URL) with the same content hash
  was already extracted in another collection — any user's — its page values
  are copied instead of calling the LLM (web-filled values are left out; keys
  are mapped to this registry's names via key synonyms). The job log says
  "N ads reused from cache"; nothing about the other collection or its owner is
  stored or shown. A *Full* re-crawl always re-extracts.

## 4. Key consolidation

After new items are indexed, `OPENROUTER_SMART_MODEL` proposes merges of
duplicate keys (`engine_power_hp → engine_power_kw ×0.7355`). Merges are
accepted only if:

- types match and names are related (same meaningful tokens; units/filler
  words ignored; conflicting qualifiers like *heated/cooled*, *front/rear*,
  *adaptive* reject),
- booleans (equipment flags) have identical meaningful tokens,
- the canonical key is the one more items already use.

Same-unit merges are also saved as global **key synonyms** (`key_aliases`), so
web lookups cached under either name serve every collection. The name check
folds a few everyday synonyms (*trunk/cargo/luggage = boot*, *top = max*,
*kerb = curb*).

The cheap model merged unrelated features (cooled → heated seats) in testing;
that is why both the stronger model and the name check exist. Run manually with
`POST /api/collections/:id/consolidate`.

## Re-crawls: change detection

Everything scraped stays in SQLite, so a re-crawl only spends LLM calls on
listings that are **new or changed**. The `mode` of a crawl decides how saved
items are re-checked:

| Mode | Saved item handling | Browser visits | LLM calls |
| --- | --- | --- | --- |
| `quick` (default) | compare the listing-card fingerprint; open the detail page only if it changed, then compare the page fingerprint | changed cards only | changed pages only |
| `deep` | open every saved item and compare the page fingerprint | every item | changed pages only |
| `full` | re-extract everything (old *refresh*) | every item | every item |

Fingerprints (`crawler/fingerprint.ts`) are sha256 hashes of the **set of
unique lowercase words/numbers** left after `normalizeForHash`. Using a set
ignores render jitter (line wrapping, casing, a breadcrumb drawn twice).
`normalizeForHash` applies these rules:

- whitespace collapsed, empty lines dropped;
- **volatile lines** dropped: relative times (`2 hours ago`, `prije 3 dana`,
  `vor 5 Minuten`), view/favourite counters, renew stamps, seller activity
  (`Online prije 30 minuta`, `Prosječno vrijeme odgovora …`);
- **volatile label/value pairs** dropped: a label like `Broj pregleda` or
  `Obnovljen` plus the numeric/date line after it.
- Q&A counters (`Pitanja (0)`), promoted/"other ads" headings, and site
  price-rating badges (`Realna cijena`).

Prices and spec numbers are kept, so a price drop is a change. The page
fingerprint uses `stableText`, the detail text with **other listings
removed** (elements matching the collection's card selector, and small
containers around links to other item URLs). "Similar ads" blocks would
otherwise change the hash on every visit. The LLM still sees the full `text`.

Detail pages wait until their visible text stops growing before the
snapshot, because OLX hydrates spec tables late. Even so, some loads come
back partial, which needs two guards. A re-check missing more than 10 % of the
item's known words is **reloaded once**. If more than 30 % is still missing,
the job keeps the saved data and counts the item as failed. Re-extracting
from a half-rendered page would overwrite good specs. The other direction is
safe: a fuller page than the saved one counts as a change and repairs the item.

A changed item is logged with the removed/added words (`- 25.900 | + 24.500`)
so false positives are easy to spot. Add any new noisy pattern to
`VOLATILE_LINE` / `VOLATILE_LABEL`. Rows saved before change tracking have no
fingerprints. The first quick or deep run adopts the current card or page as
the baseline instead of re-extracting everything.

Columns on `items`: `card_hash`, `content_hash`, `content_text` (the stable
text the hash came from, used for diffs), `last_seen_at`, `checked_at`, `gone_at`.

### Gone listings

A walk is **complete** when it reaches the natural end of the listing (empty
page, nothing new, no next control). It is not complete when it stops at
`maxPages`/`maxItems` or a page fails to load. After a complete walk, saved items
that were not seen get `gone_at` and are hidden from search, `/api/items`
and web enrichment unless `includeGone` is set (UI: *Show sold/removed*).
If more than half of a collection would be marked gone at once, the job
assumes a glitch and marks nothing. An item that reappears is un-gone
automatically.

## Where the time goes

Every crawl ends with a `Timing` line in its job log (and the server log). It is written before the final status, so
the UI and the [load test](load-testing.md) see it:

```
Timing (summed over parallel work): 37s total · 7 pages: waited for a free browser page 13s (avg 1.9s),
opening 2.4s (avg 343ms: context 520ms, new page 1.8s, setup 98ms), loading 24s (avg 3.4s: goto 7.1s,
network idle 4.5s, scroll 3.9s, text settle 4.3s), request checks 210ms (402 requests, 38 trackers + 150 prefetches blocked) ·
LLM 9 calls 11s (detect 1× 749ms, extract 6× 6.7s, …) · embedding 6× 53ms · key merging 1.0s
```

How to read it (from `lib/timing.ts`; the parts are summed over pages that ran in parallel):

- **waited for a free browser page**: the shared page slots were full, so there are too few slots for the load
  (`SCRAPE_MAX_CONCURRENT_PAGES`).
- **opening**: a fresh browser context per page (*context*), the tab (*new page*), then *setup* (user agent,
  viewport, request filter). The setup calls are sent together. High *context*/*new page* times mean the browser
  is busy, not that the site is slow. The page slot is freed as soon as the work is done; closing the tab doesn't
  hold it.
- **loading**: time with a page open. *goto* is the site and the browser rendering. *network idle*, *scroll* and
  *text settle* are the crawler's own waits: 500 ms of network quiet (at most 8 s; a request open longer than 2 s,
  like an analytics beacon or long poll, no longer counts), a 150 ms pause per scroll step plus 250 ms
  after scrolling, and the visible text unchanged over two 300 ms polls (≈ 1.5 s per page even on a static site; the
  constants are at the top of the navigation section in `crawler/browser.ts`). Item pages don't block images: the
  snapshot keeps only images that loaded at ≥ 300 px wide. If the average climbs when slots are raised, the browser
  host is out of CPU.
  Network quiet is measured from the browser's own network events on a separate CDP session (`crawler/network-idle.ts`).
  Puppeteer's built-in count misses finished requests when request filtering is on, so on many shops it always
  waited the full 8 s. The extension runner applies the same 2 s rule to the requests it can see.
- **request checks**: how long the page's requests waited for the private-address check (with
  `ALLOW_PRIVATE_TARGETS=false`), and how many ad/analytics requests and link prefetches were blocked
  ([`SCRAPE_BLOCK_TRACKERS`](deployment.md#crawl-capacity)). Each host's answer is shared across pages for up to 5 minutes, so this is
  ~1 ms per request for a site's first page and near zero afterwards. If it is high, DNS or the server's event loop
  is slow.
- **LLM**: time per purpose. Slow calls point at the provider or model.

With `DEBUG=1` the server also logs one line per page (URL, priority and browser, e.g. `[detail on burst-1]`, slot
wait, pages queued ahead, busy slots,
each opening and loading phase, requests checked, close time) and per LLM call (purpose, model, duration, tokens). Pages that take ≥ 20 s and LLM calls ≥ 20 s are
logged without `DEBUG`. While pages wait for a slot, `page slots: n/N busy (main 5/5, burst-1 6/6), m pages waiting` is logged every 30 s.

## Stop & resume

*Stop* (`POST /api/jobs/:id/stop`) drops queued item pages and ends the listing
walk; pages already open finish and are saved, then the job becomes **stopped**.
Web lookup jobs can be stopped the same way (see
[Search & web lookups](search.md#web-lookups-enrichment)). A server restart leaves
running crawls **interrupted**. Both show *Resume* (`POST /api/jobs/:id/resume`),
which continues the **same job** with the options it was started with
(`jobs.params`). A stopped crawl only continues when its user resumes it, even if an
update restarts the server meanwhile. A crawl interrupted by a restart continues on
its own after the restart. A crawl in the user's Chrome first waits up to 2 minutes
for the extension to reconnect. It stays paused, with a notification, when the server
crashed under it 3 times in a row, when its user has no working LLM key, or when the
browser doesn't come back
([Updates and restarts](deployment.md#updates-and-restarts)).

A resumed crawl walks the listing again (browser only, no LLM), then skips every
item whose `last_seen_at` is at or after the job's `started_at` — i.e. extracted
or confirmed unchanged before the stop. Failed items were never touched, so they
are retried. Key consolidation and gone-marking only run when a crawl completes,
so a stopped crawl skips them until it is resumed. Jobs created before params
were saved can't be resumed — start a new crawl instead.

## Pick items before extracting

With *Let me pick items first* (`pickItems: true`, listing crawls and re-crawls only), a crawl runs in two phases
in the same job:

1. **Walk**: detection and the listing walk run as usual, but no card is queued for extraction. Each card's title
   (its heading, else the item link's text, else an image's alt; the first line of the card text as a last resort)
   and image are kept with its card text in `job_candidates`. The only LLM call is listing detection on a site we
   don't know yet. The job then **parks** in status `picking`: it holds no job slot or browser page, waits without
   a time limit, survives restarts as is, and its user gets a notification (the *crawl done* setting).
2. **Extract**: the user ticks items in the picker (nothing is ticked by default; filter, *Pick all/shown*,
   *Only new*; *List* or *Tiles* with large card images) and starts it (`POST /api/jobs/:id/pick`). Only the picked URLs are sorted like walked cards
   (new → extract; saved → change check per `mode`, using the card text from the walk), without loading the
   listing again. Hand-added items aren't re-checked.

Saved items left unticked are untouched: no change check, and never marked gone, since they were on the listing.
Gone-marking still runs after a complete walk, counting every candidate as seen. *Stop*/*Resume* and restarts
during the extract phase continue with the same picks. *Discard* (stop while `picking`) drops the list; *Resume*
then walks the listing again and offers a new pick. While a crawl waits for a pick, a new crawl of the same
collection returns that job instead.

## Whose browser loads the pages

A crawl's `runner` is `server` (the server's headless Chrome, default) or
`browser`: the user's own Chrome through the [browser extension](extension.md),
which gets past most bot checks. Both drive the same `PageDriver` interface
(`crawler/driver.ts`) and run the same page scripts
(`shared/src/page-scripts.ts`), so detection, walking, snapshots and change
detection behave the same way. Differences:

- A browser crawl first asks the extension for access to the site. Until the user
  allows it, the job waits (up to 5 min, or until *Stop*) and says so in its message.
- The user's browser going away (Chrome closed, sleep) stops the job as
  *resumable* instead of failing its items.
- A bot wall on the server's browser stops the crawl (resumable) with
  `botWall` set, and the UI offers *Resume in my browser*.
  `POST /api/jobs/:id/resume {runner}` switches the runner of a stopped job.
- Items and listing structures read in a browser are only reused by that user's
  own collections (see [extension security](extension.md#security)).

## Site notes

- **OLX.ba** — Nuxt SPA: needs a real browser; next button has no href →
  `page` param; detail pages are Bosnian label/value lists (translated to
  English keys); Cloudflare occasionally challenges bursts (handled by backoff
  or the proxy).
- **Remote browser** — `PUPPETEER_WS_ENDPOINT` behind traefik-apikeys needs
  `PUPPETEER_WS_API_KEY` (sent as `X-Api-Key`), like price-catcher.
- **Proxy** — `PROXY_SERVER` (+ credentials) is opt-in per crawl ("Use proxy").
