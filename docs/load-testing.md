# Load testing

`scripts/load-test.mjs` simulates many users at once. It has no dependencies and needs Node 24. Each simulated
user crawls a **different category** of [books.toscrape.com](https://books.toscrape.com/), a public scraping
sandbox, so no LLM work is shared between users. Each one:

1. opens the app (`/api/config`, `/api/collections`, `/api/jobs`);
2. checks the URL (`POST /api/crawl/inspect`) and starts a crawl (one listing page, `--max-items` items);
3. follows the job's live events (`/api/jobs/:id/events`) until it finishes, refreshing `/api/jobs` and the items
   every few seconds like the UI does;
4. runs a few filter-only searches (no LLM) and one typed search on the results;
5. deletes its collection (`--keep` skips this).

It answers questions like: how long do crawls wait for the shared browser (`SCRAPE_MAX_CONCURRENT_PAGES` page slots
for *all* users), how API latency changes under load, and where 429s, 5xx errors or timeouts start.

## Locally

```bash
npm run loadtest:server                     # throwaway API on :3195, data in .run/loadtest-data
npm run loadtest -- setup --users 50        # create test users (≈ 6 s each: login is rate limited)
npm run loadtest -- run --users 5,20,50 --ramp 30s --max-items 10
npm run loadtest -- cleanup                 # delete the test accounts
kill "$(cat .run/loadtest-server.pid)"      # stop the throwaway API (scripts/kill.sh also stops the dev servers)
```

The throwaway instance uses your `.env` (LLM key, models) but its own port, data dir and admin
(`loadtest-admin@example.com`), so the dev server and its database are untouched. It runs crawls in local Chrome.
To compare settings, restart it with e.g. `SCRAPE_MAX_CONCURRENT_PAGES=4`. Add `LOADTEST_RESET=1` to start from an
empty database. `setup` on a local instance also allows the server LLM key for everyone.

## Against a deployed instance

1. Sign in as an admin and create an API key under *Account*.
2. Make sure test users can use an LLM: *Admin → LLM access* must allow the server key for everyone. Keep in mind
   the per-user daily limit.
3. Start small, then increase:

```bash
export LOADTEST_ADMIN_KEY=shk_…
npm run loadtest -- setup   --base-url https://specharvest.example --users 20
npm run loadtest -- run     --base-url https://specharvest.example --users 5 --ramp 30s
npm run loadtest -- run     --base-url https://specharvest.example --users 5,20 --ramp 60s
npm run loadtest -- cleanup --base-url https://specharvest.example
```

The test users are `loadtest-<tag>-<n>@example.com`. Their passwords and API keys are kept in
`.run/loadtest/users-<host>.json` (gitignored), so later runs need no login. Each run starts at the next category,
so re-runs don't hit the "unchanged item" shortcut.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--base-url` | `http://localhost:3195` | Server to test |
| `--users` | `5` | `setup`: how many users; `run`: users per stage, comma-separated stages run one after another |
| `--ramp` | `30s` | Arrivals are spread evenly over this time |
| `--max-items` | `10` | Items per crawl (one listing page) |
| `--searches` / `--typed-searches` | `3` / `1` | Searches per user after the crawl |
| `--timeout` | `10m` | A crawl still running after this is stopped and counted as `timeout` |
| `--server-pid` | the local instance | Process whose RSS/CPU is sampled every 2 s |
| `--keep` | off | Keep the test collections |

## Reading the report

Each stage prints:

- **Requests**: count, errors (status 0 = network/timeout, or ≥ 400), and p50/p95/p99/max latency per endpoint.
- **Crawls**: final status counts, items indexed, LLM cost, **time to first item** (mostly waiting for a free page
  slot plus listing detection) and **crawl duration**.
- **Health**: `/api/health` latency polled every 2 s. If it climbs, the event loop is busy.
- **Server process**: peak memory and CPU (local only).
- Users with errors, with the reason (e.g. `job stopped: … out of credit`).

The full data goes to `.run/loadtest/report-<time>.json`.

## Cost

Each user spends about one small page-check call plus one extraction call per item. With the default
`gemini-2.5-flash-lite` this is well under $0.01 per user at `--max-items 10`. Listing detection is reused across
users on the same site, as in production. The run prints the actual spend: the jobs' `llmCost`, or the whole
server's spend when admin credentials are set.
