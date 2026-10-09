# SpecHarvest

Crawl a shop's listing pages, let an LLM turn each item's messy spec text into
comparable structured data, then search it in plain language — hard filters
("over 100 kW", "has heated seats"), sorting ("lowest mileage") and fuzzy
wishes ("comfortable family car"). Specs a listing doesn't state can be looked
up on the web once per product model and cached.

## Requirements

- Node.js 22.13+ (uses the built-in `node:sqlite`)
- npm 11 (`npx npm@11 install` — npm 10 hits a resolver bug on this tree)
- An LLM API key: the server's [OpenRouter](https://openrouter.ai/keys) key, and/or each user's own key
  (OpenRouter, OpenAI, Anthropic, Google, Mistral, DeepSeek, … — see [LLM providers](docs/llm-providers.md))
- A Chrome to drive: a remote Puppeteer WebSocket endpoint, or local Chrome for dev

## Setup

```bash
npx npm@11 install
cp .env.example .env   # set PUPPETEER_WS_ENDPOINT (or PUPPETEER_EXECUTABLE_PATH), ENCRYPTION_KEY and the server's OPENROUTER_API_KEY
npm run seed:admin -- --email you@example.com   # first admin; prints a password once
```

Signing in is required. Existing data goes to the first admin. In Docker you
can set `ADMIN_EMAIL` instead (see [users & access](docs/auth.md)).

## Run

```bash
scripts/dev.sh          # API on :3100 + UI on :5180 (background, logs in .run/)
scripts/kill.sh         # stop them
npm test                # unit tests
npm run typecheck
```

Local Chrome instead of a remote browser:

```bash
PUPPETEER_WS_ENDPOINT= PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" scripts/dev.sh
```

Docker (single container, data in the `specharvest-data` volume, port on localhost only):

```bash
docker compose up -d           # pulls ghcr.io/bootta11/specharvest:latest → http://localhost:3100
docker compose up -d --build   # or build from this checkout
```

CI tests, scans and publishes the image on every push to `master`. See
[deployment](docs/deployment.md) for tags, host setup and backups.

## Use

0. **Users** — the avatar menu has *Account & API keys*, *LLM provider* (your
   own API keys and models, see [LLM providers](docs/llm-providers.md)) and, for
   admins, *Users & sign-up* (add people, disable them, allow self sign-up, who
   may use the server's LLM key). Each
   person has their own collections, jobs, searches, alerts and spend.
   *Share* makes a collection searchable by everyone, read only
   ([details](docs/auth.md)).
1. **Collections** tab → paste a category/search URL → *Start crawl*. Cards and
   pagination are detected automatically; progress streams live. *Re-crawl*
   only sends new or changed ads to the LLM (*Quick check* compares listing
   tiles, *Deep check* every ad page) and marks vanished ads as gone. *Stop* a
   running crawl, or one cut off by a restart, and *Resume* it later — ads
   already read are skipped ([details](docs/crawling.md#stop--resume)).
   *Export* downloads a collection (items, specs, web lookup results) as
   `.json`, *Export all* every collection you can see in one file; *Import*
   adds the collection(s) from such a file as new ones of yours
   ([format](docs/api.md#export-file)). *Groups* → *New group* bundles
   several collections (e.g. all your car sites as "Cars") to search together.
2. **Search** tab → pick a collection, a group or *All collections*, then type
   a request in any language (repeat searches are cached and shown as
   *Recent*), e.g.
   `automatic diesel with the lowest mileage and over 100 kW`. The parsed plan
   appears as chips; remove one to widen the search.
3. Ask for something listings don't state (`biggest boot`, `fastest 0-100`) and
   a web lookup runs in the background. Requested fields appear side by side in
   the **List** view (e.g. boot space 540 L, 420 L, 350 L…), and every value
   shows its source: *Listing* (scraped from the item page) or 🌐 *site*
   (web lookup, linked).
4. **Running jobs & notifications** — crawls keep running on the server when
   the tab is closed. The header shows how many are running and the
   Collections tab lists them live. The 🔔 button sets up alerts when a crawl
   finishes or fails: browser/Web Push, ntfy, Telegram, Discord/Slack, webhook
   or Apprise — see [notifications](docs/notifications.md).
5. **LLM spend** — the `$` pill in the header shows your LLM spend (click for
   today / 30 days / all time, by task and model, your keys vs the server key).
   Each crawl and web-lookup job, collection and search also shows what it cost.

## Configuration

All settings live in `.env` — see [`.env.example`](.env.example) for every
variable with comments. The essentials:

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | The server's LLM key, for users without a key of their own (the admin decides who may use it) |
| `ENCRYPTION_KEY` | Encrypts users' LLM API keys at rest (`openssl rand -base64 32`); generated into `DATA_DIR` if blank |
| `PUPPETEER_WS_ENDPOINT` | Remote browser (`ws://`/`wss://`); `PUPPETEER_WS_API_KEY` / `_USER` / `_PASSWORD` for gated endpoints |
| `PUPPETEER_EXECUTABLE_PATH` | Local Chrome, used when the WS endpoint is blank |
| `OPENROUTER_MODEL` / `_EXTRACTION_MODEL` / `_SMART_MODEL` / `_WEB_MODEL` | Server-key models per task |
| `WEB_SEARCH_*`, `ENRICH_*` | Web lookup switch, searches per lookup, caps, prefetch and thresholds |
| `MAX_PAGES`, `MAX_ITEMS`, `SCRAPE_MAX_CONCURRENT_PAGES` | Crawl limits |
| `PUBLIC_URL`, `VAPID_*` | Links in notifications; Web Push keys (auto-generated if blank) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin, created on boot when no user exists |
| `SESSION_COOKIE_SECURE` | Session cookie `Secure` flag (default: on when `PUBLIC_URL` is https) |

## Docs

- [Architecture](docs/architecture.md) — modules, data model, request flow
- [Crawling](docs/crawling.md) — listing detection, pagination, extraction, site gotchas
- [Search & web lookups](docs/search.md) — query plans, filtering, enrichment, caching
- [API](docs/api.md) — HTTP endpoints
- [Users & access](docs/auth.md) — roles, sharing, sessions, API keys, first admin
- [LLM providers](docs/llm-providers.md) — your own API keys, supported providers, server key access, cost, credits roadmap
- [Deployment](docs/deployment.md) — CI → GHCR image, tags, Compose host setup, secrets, backups
- [Notifications](docs/notifications.md) — running jobs, browser/Web Push, ntfy, Telegram, Discord/Slack, webhook, Apprise
