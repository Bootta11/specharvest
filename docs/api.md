# HTTP API

Every route except `/api/health` and `/api/auth/{status,login,signup,logout}`
needs a signed-in user: the `specharvest_session` cookie set by login, or an
`X-Api-Key: shk_…` header (create keys under *Account*). Without one the API
answers `401`. What a user sees is scoped to them — see [auth](auth.md):
collections they own or that are shared (admins: all), and only their own jobs,
searches, spend and notification channels. Someone else's private collection or
job answers `404`; changing a collection shared with you answers `403`.

```bash
curl -H "X-Api-Key: shk_…" https://specharvest.example/api/collections
```

## Auth & users

| Method & path | Body / query | Returns |
| --- | --- | --- |
| `GET /api/auth/status` | | `{signupEnabled}` (public) |
| `POST /api/auth/login` | `{email, password}` | user, sets the session cookie; 401 on bad credentials (rate limited) |
| `POST /api/auth/signup` | `{email, password}` (8+ chars) | user + cookie; 403 unless an admin enabled sign-up |
| `POST /api/auth/logout` | | 204, revokes the session |
| `GET /api/auth/me` | | `{id, email, role, disabledAt, createdAt}` |
| `PATCH /api/auth/me` | `{currentPassword, email?, newPassword?}` | user; a new password signs out your other sessions |
| `GET /api/api-keys` | | your active keys `[{id, label, keyPrefix, createdAt, lastUsedAt}]` |
| `POST /api/api-keys` | `{label}` | key incl. the full `key` — shown only once (201) |
| `DELETE /api/api-keys/:id` | | `{ok}` |
| `GET /api/users` | admin | all users |
| `POST /api/users` | admin; `{email, role?: "user"\|"admin"}` | user + `temporaryPassword` (shown once) (201) |
| `PATCH /api/users/:id` | admin; `{disabled}` | user (disabling signs them out; their data stays) |
| `GET /api/settings/admin`, `PUT /api/settings/admin` | admin; `{signupEnabled}` | `{signupEnabled}` |

## App

| Method & path | Body / query | Returns |
| --- | --- | --- |
| `GET /api/health` | `?deep=1` also checks the browser | `{status, checks}` (503 if DB down) |
| `GET /api/config` | | proxy/web/LLM flags, crawl defaults, models |
| `GET /api/collections` | | readable collections with item counts, `llmCost` (USD), `ownerEmail`, `isShared`, `canEdit` |
| `PATCH /api/collections/:id` | `{name?, isShared?}` (owner/admin) | collection |
| `DELETE /api/collections/:id` | | deletes items + vectors |
| `GET /api/collections/:id/export` | (any reader) | `.json` download (see [Export file](#export-file)) |
| `GET /api/collections/export` | | `.json` download of every readable collection (`format: "specharvest.collections"`) |
| `POST /api/collections/import` | an export file, single or *Export all* (≤ 500 MB) | new private collection(s) of the caller (201): the collection, or an array for a bundle (all or nothing); vectors are rebuilt in the background |
| `GET /api/collections/:id/keys`, `GET /api/keys` | | key registry (one collection / merged) |
| `POST /api/collections/:id/consolidate` | | `{merges, moved}` — merge duplicate keys now |
| `GET /api/items` | `?collectionId&limit&offset&includeGone=1` | items (gone listings hidden unless `includeGone`) |
| `GET /api/items/:id` | | item incl. `rawText` |
| `POST /api/crawl` | `{url, collectionId?, name?, maxPages?, maxItems?, useProxy?, mode?: "quick"\|"deep"\|"full"}` (`refresh: true` = `full`; `name` sets the collection name instead of deriving it from the page title; `collectionId` re-crawls that collection — owner/admin — otherwise your own collection for the URL is reused or a new one created) | job (202) |
| `POST /api/search` | `{collectionId?, query? \| plan?, limit?, enrich?, includeGone?}` | `{plan, items, unknown, total, keys, enrichJobId, enrichNote, llmCost}` (`llmCost` = USD spent parsing the query, 0 when cached) |
| `GET /api/searches` | `?collectionId&limit` | your recent searches `[{query, usedAt, hits}]` |
| `POST /api/enrich` | `{collectionId?, attributes:[{key,type,unit,label}], itemIds?}` | `{job}` (202) |
| `GET /api/jobs`, `GET /api/jobs/:id` | | jobs (incl. `llmCost` so far, `resumable`) |
| `POST /api/jobs/:id/stop` | | running crawl → *stopped* once open pages finish; job (202), 409 if not a running crawl |
| `POST /api/jobs/:id/resume` | | continues a *stopped*/*interrupted* crawl in the same job; job (202), 409 if not resumable or the collection is busy |
| `GET /api/usage` | `?scope=all` (admin: everyone's) | your LLM spend `{today, last30d, allTime, byPurpose, byModel, unpricedCalls}` (USD, from OpenRouter's `usage.cost`) |
| `GET /api/usage/credits` | admin | OpenRouter balance `{provider, key, account, errors, fetchedAt}`: `key` = API key limit/remaining/usage (`/api/v1/key`); `account` = purchased/used/remaining credits, only when `OPENROUTER_MANAGEMENT_KEY` is set. Cached 60 s |
| `GET /api/jobs/events` | SSE | your jobs (admins: all): `jobs` (active jobs snapshot on connect), then `job` on every change |
| `GET /api/jobs/:id/events` | SSE | events `job`, `log`, `item`, `queue` (history replayed) |
| `GET /api/settings/notifications` | | your notification settings, secrets replaced by `********` |
| `PUT /api/settings/notifications` | settings (a `********` field keeps its stored value) | saved settings (masked) |
| `POST /api/notifications/test` | `{channel: "ntfy"\|"telegram"\|"discord"\|"webhook"\|"apprise"\|"push"}` | `{ok, error?}` |
| `GET /api/push/key` | | `{publicKey}` (VAPID) |
| `POST /api/push/subscribe`, `DELETE /api/push/subscribe` | `PushSubscription` JSON / `{endpoint}` | `{ok}` |

## Export file

`{format: "specharvest.collection", version: 1, exportedAt, collection, specKeys, items, aliases, webFacts}`:

- `collection`: `{name, startUrl, host, createdAt, detection}`. Import always creates a new collection; on a name clash
  with one of yours it gets an ` (imported)` suffix.
- `items`: every listing (gone ones included) with `specs`, per-key `sources` (web lookup values: origin, source URL,
  confidence), raw/detail text and change-detection hashes, so a later *Re-crawl* still skips unchanged ads. No ids.
- `specKeys`: the key registry (counts are recomputed on import).
- `aliases`, `webFacts`: product grouping and the web lookup cache for the collection's product names. Imported with
  insert-or-ignore, so grouping decisions and lookups already on the target server win.

*Export all* wraps several of these: `{format: "specharvest.collections", version: 1, exportedAt, collections: [<export>, …]}`.

Not included: vectors (re-embedded locally), jobs, LLM spend, search history, "not the same product" decisions.

## LLM spend

Every OpenRouter completion (including JSON-retry attempts) writes a row to the
`llm_usage` table with its purpose, model, tokens and the USD cost OpenRouter
reports. Rows are attributed to the surrounding job/collection and the user who
started it via
`withLlmContext` (`server/src/llm/usage.ts`) and have no foreign keys, so
deleting a collection doesn't remove its spend from the totals. Calls that fail
before a response arrives aren't recorded.
