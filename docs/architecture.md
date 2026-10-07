# Architecture

```
React UI (Vite) ──HTTP/SSE──► Fastify API ──► crawler (puppeteer-core, p-queue)
                                   │                 │
                                   │                 ├─► LLM (OpenRouter): listing detection, spec extraction, key merging
                                   │                 └─► embeddings (Transformers.js, local)
                                   ├─► SQLite (node:sqlite)  items · specs JSON · key registry · jobs · web facts
                                   ├─► LanceDB               item vectors (semantic ranking)
                                   └─► LLM + openrouter:web_search  missing-spec lookups
```

## Workspaces

| Path | What |
| --- | --- |
| `shared/` | Types + zod schemas shared by API and UI (query plan, job events, …) |
| `server/src/crawler/` | `browser.ts` (remote/local Chrome, page slots, proxy, navigation + bot-wall check), `detect.ts` (card + pagination detection), `paginate.ts` (walkers, card text, walk completeness), `fingerprint.ts` (change-detection hashes), `sanitize.ts` (LLM-ready HTML, detail-page text snapshot), `job.ts` (crawl orchestration) |
| `server/src/llm/` | `client.ts` (OpenRouter via `openai` SDK, JSON extraction/repair/salvage), prompts: `detect.ts`, `extract.ts`, `parse-query.ts`, `consolidate.ts` |
| `server/src/search/` | `filters.ts` (plan → parametrized SQL), `hybrid.ts` (bucketing, ranking, enrichment trigger) |
| `server/src/enrich/web.ts` | Web lookups, `web_facts` cache, merging found values into items |
| `server/src/db/` | `sqlite.ts` (schema + queries), `lance.ts` (vectors) |
| `server/src/notify/` | `index.ts` (settings, job-finished dispatch), `channels.ts` (ntfy, Telegram, Discord/Slack, webhook, Apprise), `push.ts` (Web Push / VAPID) — see [notifications](notifications.md) |
| `server/src/auth/` | `plugin.ts` (cookie / `X-Api-Key` → `req.user` hook), `routes.ts`, `users.ts`, `sessions.ts`, `api-keys.ts`, `crypto.ts` (scrypt, tokens), `ownership.ts` (read/write checks), `bootstrap.ts` — see [auth](auth.md) |
| `server/src/scripts/seed-admin.ts` | `npm run seed:admin` — creates the first admin |
| `server/src/sse/hub.ts` | Per-job SSE channels with replay for late subscribers; per-subscriber filters (each user's jobs feed) |
| `client/src/` | `views/LoginView.tsx`, `views/IngestView.tsx`, `views/SearchView.tsx`, item card/modal, job progress, `components/{UserMenu,AccountModal,AdminModal}.tsx`, `lib/auth.ts` |

The server runs TypeScript directly through `tsx` (dev and Docker), so there is
no server build step; `tsc` is used for type checking only.

## Data model (SQLite)

- `collections` — one per crawled start URL per user (`user_id`, `is_shared`); stores the detected listing structure (`detection` JSON) so re-crawls skip the LLM.
- `items` — fixed fields (`title`, `price`, `currency`, `main_image`, `description`, `identity`) + `specs` JSON of dynamic keys + `raw_text` (the page text sent to the LLM) + change tracking (`card_hash`, `content_hash`, `content_text`, `last_seen_at`, `checked_at`, `gone_at`; see [crawling](crawling.md#re-crawls-change-detection)).
- `spec_keys` — **key registry** per collection: key, type, unit, original label, count, origin (`page`/`web`). Extraction is given it so the same attribute keeps one name; query parsing is given it so filters target real keys.
- `spec_sources` — provenance for values that did not come from the item's page (web lookups): source URL + confidence.
- `web_facts` — cache of web lookups keyed by product `identity` + key (also caches "not found").
- `query_cache` — parsed search plans per (collection, normalized request) + registry signature, shared by all users.
- `search_history` — each user's "recent searches" per collection.
- `jobs` — crawl and enrich jobs with counters, message, error, and the user who started them.
- `llm_usage` — one row per OpenRouter call, billed to a user, job and collection.
- `settings` — JSON values: per-user notification channels (`notifications:<userId>`), generated VAPID keys, the sign-up toggle.
- `push_subscriptions` — browsers that enabled Web Push, per user.
- `users`, `sessions`, `api_keys` — accounts, login sessions and API keys (tokens stored as sha256 only); see [auth](auth.md).

LanceDB (`data/lancedb/item_vectors`) holds `{item_id, collection_id, vector}`
only; SQLite is the source of truth.

## Models

| Env var | Default | Used for |
| --- | --- | --- |
| `OPENROUTER_MODEL` | `google/gemini-2.5-flash-lite` | listing detection, query parsing |
| `OPENROUTER_EXTRACTION_MODEL` | = main | per-item spec extraction (the bulk of the cost) |
| `OPENROUTER_SMART_MODEL` | `google/gemini-2.5-flash` | merging duplicate keys (needs judgement) |
| `OPENROUTER_WEB_MODEL` | = smart | web lookups (tool use + strict JSON) |

Admins see the OpenRouter credit balance in the spend menu (`GET /api/usage/credits`).
The regular key yields its own limit and usage; the account balance needs an optional
`OPENROUTER_MANAGEMENT_KEY` (OpenRouter's `/api/v1/credits` rejects regular keys).
