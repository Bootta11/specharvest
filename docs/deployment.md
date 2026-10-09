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

- **Builder:** `node:22-trixie-slim`. **Runtime:** `gcr.io/distroless/nodejs22-debian13:nonroot`, with no shell, npm or apt, running as uid 65532. Both are pinned by digest.
- **No Alpine:** `onnxruntime-node`, used for embeddings, has no musl build.
- **Size, about 590 MB:** mostly the LanceDB native binary (~255 MB after stripping debug symbols) and the Node runtime (~120 MB). The builder drops onnxruntime binaries for other platforms and the unused browser WASM of `onnxruntime-web`.
- **Hardening:** the container runs with `read_only`, `cap_drop: ALL`, `no-new-privileges`, `init`, memory and PID limits, and log rotation.

There's no shell, so run one-off commands through node:

```bash
docker compose exec app /nodejs/bin/node --import tsx server/src/scripts/seed-admin.ts --email you@example.com
```
