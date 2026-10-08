# Crawling

A crawl job (`POST /api/crawl`) runs five stages; progress streams over
`GET /api/jobs/:id/events`.

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
   from the found links to drop promos/ads inside the grid.
6. **Page-param probing**: load `?page=2` (then `p`, `pg`, `paged`, `strana`, …).
   If it yields new items, URL paging wins — it is the most reliable mechanism
   and handles SPA "next" buttons that have no `href` (OLX.ba is one).

The result is saved on the collection; a re-crawl reuses it and only
re-detects when it stops matching. A new collection on a host another
collection (anyone's) already detected tries that structure first and keeps
it when it yields ≥ 2 items on the live page — no LLM call.

## 2. Listing walk

Walkers collect item URLs (deduped, tracking params stripped) until
`maxPages` / `maxItems`, an empty page, or a page with nothing new. A JS-only
"next" button is clicked and the walker waits for the card set to change.

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
- The **first item runs alone** to seed the registry before parallel workers
  start; otherwise each worker invents its own names.
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

## Stop & resume

*Stop* (`POST /api/jobs/:id/stop`) drops queued item pages; pages already open
finish and are saved, then the job becomes **stopped**. A server restart leaves
running crawls **interrupted**. Both show *Resume* (`POST /api/jobs/:id/resume`),
which continues the **same job** with the options it was started with
(`jobs.params`) — nothing resumes automatically.

A resumed crawl walks the listing again (browser only, no LLM), then skips every
item whose `last_seen_at` is at or after the job's `started_at` — i.e. extracted
or confirmed unchanged before the stop. Failed items were never touched, so they
are retried. Key consolidation and gone-marking only run when a crawl completes,
so a stopped crawl skips them until it is resumed. Jobs created before params
were saved can't be resumed — start a new crawl instead.

## Site notes

- **OLX.ba** — Nuxt SPA: needs a real browser; next button has no href →
  `page` param; detail pages are Bosnian label/value lists (translated to
  English keys); Cloudflare occasionally challenges bursts (handled by backoff
  or the proxy).
- **Remote browser** — `PUPPETEER_WS_ENDPOINT` behind traefik-apikeys needs
  `PUPPETEER_WS_API_KEY` (sent as `X-Api-Key`), like price-catcher.
- **Proxy** — `PROXY_SERVER` (+ credentials) is opt-in per crawl ("Use proxy").
