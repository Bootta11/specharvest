# Deployment

CI builds one image and publishes it to GHCR. A production host only pulls it,
it never builds from source.

```
push to master ─▶ test (typecheck + unit tests)
               └▶ image (build, Trivy scan, smoke test: container must become healthy)
                    both pass ─▶ publish ghcr.io/bootta11/specharvest
```

Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Pull
requests run test + image but never publish.

## Tags

| Tag | When | Use it for |
| --- | --- | --- |
| `sha-<short commit>` | every push to `master` or a `v*` tag | exact, reproducible rollbacks |
| `latest` | every push to `master` | convenience; moves on every merge |
| `x.y.z` | git tag `vx.y.z` | pinned releases |

Auto-updaters (Watchtower and similar) follow the tag you run, so `latest`
deploys every push to `master` unattended. Pin `x.y.z` or `sha-…` if that's
not what you want. Images are `linux/amd64` only.

`GET /api/config` returns `"version": "<commit>"`, so you can always tell
which build is running.

## Health check

`GET /api/health` is public and never cached. It runs `SELECT 1` against the
database and returns `200` with
`{"ok":true,"status":"ok","checks":{"database":{"ok":true,"latencyMs":…}},"uptimeSeconds":…,"timestamp":…}`,
or `503` with `ok:false` when the database is unreachable (error details are
only logged server-side). `HEAD /api/health` returns the same status with no
body. The image's `HEALTHCHECK` uses it.

Uptime Kuma: an **HTTP(s)** monitor on `https://<your-host>/api/health` with
the default accepted codes (`200-299`), or **HTTP(s) - Json Query** with
expression `$.ok` and expected value `true`.

## CI setup

Nothing to configure: the workflow logs in to GHCR with the built-in
`GITHUB_TOKEN`. After the first publish, check the package at
GitHub → your profile → **Packages** → `specharvest`:

- If the repository is private, the package is private too. Hosts need a pull token (below).
- To make it public: package → **Package settings** → **Change visibility**.

Verify a publish: `docker buildx imagetools inspect ghcr.io/bootta11/specharvest:latest`.

Dependabot ([`.github/dependabot.yml`](../.github/dependabot.yml)) opens weekly
PRs for npm packages, the base image digests pinned in the `Dockerfile`, and
the GitHub Actions versions.

## Host setup (Docker Compose)

The host needs only `compose.yaml` and a `.env`:

```bash
mkdir specharvest && cd specharvest
curl -fsSLO https://raw.githubusercontent.com/Bootta11/specharvest/master/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/Bootta11/specharvest/master/.env.example
# edit .env: ENCRYPTION_KEY, OPENROUTER_API_KEY, PUPPETEER_WS_ENDPOINT, ADMIN_EMAIL, PUBLIC_URL …
docker compose pull && docker compose up -d
docker compose logs app | grep -i password   # first admin's generated password, if ADMIN_PASSWORD was blank
```

Private package: create a GitHub **classic** personal access token with only
`read:packages` (GitHub → Settings → Developer settings → Personal access
tokens), then on the host:

```bash
echo "<token>" | docker login ghcr.io -u <github-username> --password-stdin
```

Update: `docker compose pull && docker compose up -d`. Roll back: set
`IMAGE=ghcr.io/bootta11/specharvest:sha-<commit>` in `.env`, then `up -d`.

### Updates and restarts

An update (`up -d`, Watchtower) stops the container and starts the new one. On a small VPS the new server answers
about 15–20 s later. The startup log line `ready in … s (modules … s)` shows how long it took. Running crawls carry
on by themselves:

- **On SIGTERM**, the server first refuses requests that would start work it can't finish: crawls, resumes, web
  lookups, page checks, imports, key consolidation, capacity tests and image builds. They get
  `503 {"restarting": true}` with `Retry-After: 5`, and the web and Android clients retry them on their own.
  Searches, edits and settings keep working.
- **Running crawls close their pages and pause.** Pages still waiting for a browser slot are dropped. The pause is
  recorded only on the server, so clients don't announce a stopped crawl. A crawl its user had stopped stays
  stopped.
- **Web lookups end as stopped** and keep what they found. *Look up N more* finishes the rest, after a click: paid
  lookups never continue on their own.
- **The drain gets up to 15 s,** then up to 5 s for writes still in flight. Then rented browser servers are deleted
  and the server exits, at most 25 s after the signal.
- **On start**, every crawl a restart cut off continues in the same job, skipping items it already handled. That
  covers a clean pause, and also a crash or a shutdown that ran out of time.
  - **Crash limit:** a crawl the server crashed under 3 times in a row stays paused, so it can't keep taking the
    server down.
  - **No working LLM key:** the crawl stays paused.
  - **Crawls that run in the user's Chrome** wait up to 2 minutes for their extension to reconnect (it retries within
    about 30 s), then continue.
  - Crawls that can't continue get a "Crawl paused" notification through their user's crawl-failed channels.
- **Clients:** while the server can't be reached, a banner says so and counts the seconds. Requests retry for up to
  45 s, and the live job feeds reconnect and catch up.

Two settings need to match:
- **Stop timeout:** give the container at least 30 s to stop: `stop_grace_period: 30s` in this `compose.yaml`, and
  for Watchtower `WATCHTOWER_TIMEOUT=30s`. containrrr/watchtower defaults to 10 s; the nicholas-fedor fork already
  defaults to 30 s.
- **Docker Engine 25+:** the image's healthcheck uses `--start-interval=2s`, so a new container is `healthy`, and
  Traefik routes to it, about 2 s after it listens. Older engines ignore the option and first check after 30 s. Until
  then Traefik answers 404.

Uptime Kuma: set the monitor's **Retries** to 1 or more, so the ~20 s of an update doesn't raise an alert.

### Compose variables

These go in `.env` next to the app settings and only affect Compose:

| Variable | Default | Purpose |
| --- | --- | --- |
| `IMAGE` | `ghcr.io/bootta11/specharvest:latest` | Image and tag to run |
| `HOST_BIND` | `127.0.0.1` | Host address the port is published on |
| `HOST_PORT` | `3100` | Host port |
| `MEM_LIMIT` | `1g` | Container memory cap (the embedding model needs a few hundred MB) |
| `PULL_POLICY` | `missing` | Set `always` to pull on every `up` |

The port is published on localhost only, because Docker-published ports
bypass host firewalls like ufw. Put a reverse proxy (Caddy, Traefik, nginx) in
front and set `PUBLIC_URL` to its https address, which also turns on the
`Secure` session cookie. Or set `HOST_BIND` to a private/VPN address. Inside
the container the app always listens on 3100. Don't change `PORT` in `.env`
for Compose.

Building from a checkout instead: `docker compose up -d --build`.

## Configuration in the image

All settings are runtime environment variables. Nothing is baked in at build
time except the commit SHA. The client bundle reads everything from the API.

Secrets can come from files instead of env (Docker/Compose secrets): set
`OPENROUTER_API_KEY_FILE`, `OPENROUTER_MANAGEMENT_KEY_FILE`, `PUPPETEER_WS_API_KEY_FILE`,
`PUPPETEER_WS_PASSWORD_FILE`, `PROXY_PASSWORD_FILE`, `VAPID_PRIVATE_KEY_FILE`,
`ADMIN_PASSWORD_FILE` or `ENCRYPTION_KEY_FILE` to a path such as `/run/secrets/openrouter`.

**`ENCRYPTION_KEY`** encrypts the LLM API keys users add (`openssl rand -base64 32`).
Set it explicitly and keep a copy outside the data volume. If it's blank, one
is generated into the volume (`encryption.key`), so a copy of the volume holds
both the database and the key. Losing or changing it means users have to
re-enter their keys. See [LLM providers](llm-providers.md#keys-at-rest).

Compose interpolates `$` inside `.env` values. Single-quote any value that
contains one, e.g. `ADMIN_PASSWORD='pa$$word'`.

### Crawl capacity

`SCRAPE_MAX_CONCURRENT_PAGES` (default 2) is how many browser pages all crawls and page checks
share; see [page slots](crawling.md#2-listing-walk). The API itself is rarely the limit: under
load, crawls mostly wait for a free page. Each open page costs roughly 100–200 MB in the browser
and some CPU, and a remote browser (`PUPPETEER_WS_ENDPOINT`) may be shared with other apps. Raise
it step by step and measure each step with the [load test](load-testing.md). Stop when crawl
times stop improving or the browser host runs short of memory.

Crawled pages don't load ad and analytics requests (Google Ads/Tag Manager, ad exchanges, social pixels, session
recorders; the list is in `server/src/crawler/trackers.ts`) or the links a site prefetches for a visitor's next click.
This saves browser CPU and gets pages quiet sooner. Set `SCRAPE_BLOCK_TRACKERS=false` if a site you crawl needs one
of those scripts to show its content. Prefetches are always skipped.

Once the browser host is out of CPU, more pages per browser only make each page slower: add a
browser instead. `PUPPETEER_WS_ENDPOINT` takes several endpoints, comma-separated, with the same
auth headers. Each takes `SCRAPE_MAX_CONCURRENT_PAGES` pages, and each page goes to the browser
with the most free pages (`server/src/crawler/browser-pool.ts`). A browser that can't be reached
gets no pages for 30 s, and the page is tried once on another one. The page log lines name the
browser (`[detail on main-2]`).

Browsers can also be added in the [admin dashboard](auth.md#admin-dashboard) (`/admin/`): **Browser servers** → **Add browser**.
Each one has its own URL, API key (`X-Api-Key`), username and password (Basic auth), and those keys are stored
encrypted with `ENCRYPTION_KEY`. Each one can also have its own page limit (empty = `SCRAPE_MAX_CONCURRENT_PAGES`),
be turned off without deleting it, and be kept away from proxy pages. **Test** connects with the entered keys and
shows the browser's version. When a browser is changed, turned off or deleted, its open pages finish first (up to
2 min) before the change takes effect. Browsers from `PUPPETEER_WS_ENDPOINT` show in the same list but can be changed
only in `.env`, and they keep sharing the `PUPPETEER_WS_*` keys. The names `main`, `main-N` and
`<BURST_NAME>-burst…` are reserved. The code is in `server/src/crawler/browsers.ts`.
**Test capacity** on each browser finds its best page limit; see
[Browser capacity](load-testing.md#browser-capacity-admin-ui).

### Extra browser servers on demand

Rather than a second browser that runs all the time, SpecHarvest can rent one from DigitalOcean
while pages queue up and delete it when the queue is gone (`server/src/crawler/burst/`). You pay
only for the minutes it runs.

- **When:** when at least `BURST_MIN_WAITING` (4) pages have waited `BURST_AFTER_SECONDS` (60 s),
  SpecHarvest creates a droplet (`BURST_SIZE`, default `s-4vcpu-8gb`, in `BURST_REGION`). It takes
  `BURST_TABS` (6) pages once its browser answers: about 1.4 min from a fresh Debian image, 0.7 min
  from our own image (see below).
- **Until:** the droplet is deleted after `BURST_IDLE_MINUTES` (5) with no page while nothing
  waits, or after `BURST_MAX_MINUTES` (180) at the latest. Pages running there get up to 2 min to
  finish first.
- **Spending limits:**
  - `BURST_MAX_SERVERS` (1) servers at once;
  - `BURST_MAX_HOURS_PER_DAY` (12) server-hours per UTC day, recorded in SQLite so restarts do not reset it;
  - after a failed start, the next try waits 10 min;
  - at startup and every 10 min, droplets tagged `<BURST_NAME>-burst` that this instance doesn't
    run are deleted (leftovers of a crash or restart), and on shutdown it deletes its own.

  Each deletion logs the server's lifetime, page count and estimated cost. Also set a billing
  alert in DigitalOcean.
- **What runs there:** Debian's Chromium (security updates from Debian), headless, listening on
  127.0.0.1 only. Caddy on port 9223 passes only `/<token>/…` to it; the token is random per
  server. A DigitalOcean firewall (`<BURST_NAME>-burst-firewall`, created on first use) lets only
  `BURST_ALLOWED_IP`, this server's public IP, reach port 9223. Nothing else is open, not even SSH.
- **No TLS:** the connection is plain `ws://`. Crawled public pages go through it, but pages
  through the proxy (whose credentials travel over the browser connection) never run on a rented
  browser.

Setup:
1. Create a DigitalOcean API token (*API → Tokens → Generate New Token*) with **custom scopes**,
   not full access, so the token can't touch anything else in the account:

   | Resource | Scopes | Used for |
   | --- | --- | --- |
   | droplet | create, read, delete | starting servers, waiting for them, finding leftovers, deleting them |
   | firewall | create, read, update | the firewall that lets only `BURST_ALLOWED_IP` in, created once and updated when the IP changes |
   | tag | create, read | tagging servers so leftovers can be found |
   | sizes | read | hourly price for the cost line in the log |
   | ssh_key | read | only with `BURST_DO_SSH_KEY_ID` |
   | image | create, read, delete | only for `npm run burst:image`: saving, listing and deleting our images |
   | actions | read | only for `npm run burst:image`: waiting for the shutdown and the snapshot |
   | droplet | update | only for `npm run burst:image`: shutting the build droplet down |

   The admin panel's **Test** button checks the read scopes for droplets, firewalls, sizes, images,
   actions and tags. Write scopes cannot be checked without changing the account. Related read
   scopes that DigitalOcean adds on its own (regions, images…) are fine. A missing
   scope shows up in the log as `DigitalOcean POST /droplets → 403: …`.
2. Set `BURST_PROVIDER=digitalocean`. Set `BURST_DO_TOKEN` (or `BURST_DO_TOKEN_FILE`) and
   `BURST_ALLOWED_IP` in env to keep the feature on immediately, or enter them under
   **Admin dashboard → Browser servers** and switch it on there. Panel values override env; removing
   one returns to its env value. The token is encrypted with `ENCRYPTION_KEY` and is never returned
   by the API. If that key is lost, enter the token again.
3. Optional: add an SSH key to the account and set `BURST_DO_SSH_KEY_ID`. Without it, DigitalOcean
   emails a root password for every server.
4. The startup log shows `On-demand browser servers on digitalocean: …`. The `page slots: …`
   lines list each browser's load.

Instances sharing one account (dev and live) need different `BURST_NAME`s, or each deletes the
other's servers as leftovers.

The admin panel also changes the server count, tabs, queue threshold, delays, lifetimes and daily
limit without a redeploy. `BURST_NAME`, `BURST_PROVIDER`, `BURST_DO_SSH_KEY_ID` and
`ENCRYPTION_KEY` remain env-only. Turning the feature off drains active pages for up to two minutes
and deletes the rented servers.

#### Faster starts from our own image

A fresh Debian droplet spends most of its start installing Chromium and Caddy. `npm run burst:image`
does that once:
1. It starts a Debian 13 droplet that installs all updates, Chromium and Caddy, and checks that
   Chromium runs.
2. It saves the droplet as a snapshot named `<BURST_NAME>-browser-<date>`, then deletes the droplet.
3. It keeps the two newest of our images (`--keep N`) and switches new servers to the latest one.

A build takes ~2–5 min and costs under a cent. Storing the image costs ~$0.06 per GB per month
(~1.7 GB, about $0.10 a month). Servers started from it skip the install and are ready in about
0.7 min instead of 1.4. `npm run burst:image -- --list` shows our
images.

No secret goes into the image: each server's token is still written at boot, and until then Caddy
only answers 403. Run it where `BURST_ALLOWED_IP` points (the firewall lets only that IP check on
the build), i.e. on the host, in the app container:

```bash
# Compose setup from this repo (service "app")
docker compose exec -w /app app /nodejs/bin/node --import tsx server/src/scripts/burst-image.ts
# any setup: find the container by its image
docker exec -w /app $(docker ps -q -f ancestor=ghcr.io/bootta11/specharvest:latest) /nodejs/bin/node --import tsx server/src/scripts/burst-image.ts
```

Paste it as one line: a line break in the middle runs Node without the script.

The app builds the first image once account setup is complete, then rebuilds it every seven days by
default. The panel shows progress and has **Rebuild now**; set the interval to 0 to turn automatic
builds off. A failed automatic build retries after 24 hours. `BURST_IMAGE` is the fallback until the
first successful app build. The CLI/SSH command above remains a fallback. If the fallback image no
longer exists, server starts fail with `422` in the log. The previous app-built image is kept.

## Security settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Which peers may set `X-Forwarded-For`/`-Proto`/`-Host`: IPs, CIDRs or those names, or `true`/`false`. The default trusts a reverse proxy or tunnel on the host or a private Docker network. A client connecting directly can't fake its IP (login rate limits key on it). Hop counts aren't supported. |
| `ALLOW_PRIVATE_TARGETS` | `false` | Let crawls (and everyone's notifications) reach private/LAN addresses. Only for a single-user setup that crawls intranet sites. |
| `OUTBOUND_ALLOWED_HOSTS` | `apprise` | Hosts every user's notifications may reach although they're private, e.g. the bundled Apprise container. Blank = none. |
| `MAX_PAGES_CAP` / `MAX_ITEMS_CAP` | `50` / `1000` | Most a non-admin may ask one crawl for (admins: 200 / 5000) |
| `MAX_ACTIVE_JOBS_PER_USER` | `3` | Crawls + web lookups one non-admin may run at once (0 = no limit) |
| `IMPORT_MAX_MB` | `50` | Largest collection file an import accepts |

The daily limit on the server's LLM key is set in the admin dashboard (*Settings*).

**Outbound requests.** The app refuses to crawl loopback, private, link-local
(cloud metadata) and other non-public addresses. That covers the start URL and
every request the crawled pages make, including redirects. The browser's
check keeps each host's answer for up to 5 minutes (30 s for a refused one),
so pages don't look the same hosts up again. Notification
webhooks from non-admins get the same check at connect time, so DNS tricks
don't get around it, and redirects aren't followed. Chrome resolves names
itself, though, so a hostile site could still try DNS rebinding against the
browser. For full isolation, give the browser container a network without a
route to your LAN or the Docker host: a dedicated Docker network plus host
firewall rules, or an egress proxy for the browser.

**Headers.** The server sets a Content-Security-Policy, `X-Frame-Options`,
`nosniff`, `Referrer-Policy` and, when `PUBLIC_URL` is https, HSTS. Have your
reverse proxy pass them through rather than replace them.

## Data

Everything that needs to survive a restart lives in the `specharvest-data`
volume at `/app/data`: the SQLite database, the LanceDB vectors, the
embedding model cache (downloaded on first use, about 25 MB) and, when
`ENCRYPTION_KEY` is not set, the generated `encryption.key`. The rest of the
container filesystem is read-only.

Backup:

```bash
docker compose stop app
docker run --rm -v specharvest_specharvest-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/specharvest-data.tgz -C /data .
docker compose start app
```

## Image

- **Builder:** `node:24-trixie-slim`. **Runtime:** `gcr.io/distroless/nodejs24-debian13:nonroot`, with no shell, npm or apt, running as uid 65532. Both are pinned by digest.
- **No Alpine:** `onnxruntime-node`, used for embeddings, has no musl build.
- **Size, about 590 MB:** mostly the LanceDB native binary (~255 MB after stripping debug symbols) and the Node runtime (~120 MB). The builder drops onnxruntime binaries for other platforms and the unused browser WASM of `onnxruntime-web`.
- **Hardening:** the container runs with `read_only`, `cap_drop: ALL`, `no-new-privileges`, `init`, memory and PID limits, and log rotation.

There's no shell, so run one-off commands through node:

```bash
docker compose exec app /nodejs/bin/node --import tsx server/src/scripts/seed-admin.ts --email you@example.com
```
