#!/usr/bin/env bash
# Starts a throwaway API instance for load tests (docs/load-testing.md): its own port and data dir,
# so the dev server and its database are never touched. PID → .run/loadtest-server.pid (scripts/kill.sh
# stops it), log → .run/loadtest-server.log. Settings from .env still apply unless overridden here.
#   scripts/loadtest-server.sh
#   SCRAPE_MAX_CONCURRENT_PAGES=4 scripts/loadtest-server.sh
#   LOADTEST_RESET=1 scripts/loadtest-server.sh   # wipe the load-test data dir first
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .run

port="${LOADTEST_PORT:-3195}"
data="$PWD/.run/loadtest-data"
pidfile=".run/loadtest-server.pid"

if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  echo "load-test server already running (pid $(cat "$pidfile")) on http://localhost:$port"
  exit 0
fi
if (( $(node -p 'process.versions.node.split(".")[0]') < 24 )); then
  echo "Node 24+ needed (found $(node -v)) — e.g. nvm use" >&2
  exit 1
fi
if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $port is already in use — set LOADTEST_PORT" >&2
  exit 1
fi

[[ "${LOADTEST_RESET:-}" == "1" ]] && rm -rf "$data"
mkdir -p "$data"
# Reuse the downloaded embedding model instead of fetching it again.
[[ -d data/models && ! -d "$data/models" ]] && cp -R data/models "$data/models"

chrome="${PUPPETEER_EXECUTABLE_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

# Vars set here win over ../.env (node's --env-file never overrides the environment).
(
  cd server
  PORT="$port" \
  DATA_DIR="$data" \
  ADMIN_EMAIL="${LOADTEST_ADMIN_EMAIL:-loadtest-admin@example.com}" \
  ADMIN_PASSWORD="${LOADTEST_ADMIN_PASSWORD:-loadtest-admin-password}" \
  SESSION_COOKIE_SECURE=false \
  PUBLIC_URL= \
  PUPPETEER_WS_ENDPOINT="${LOADTEST_WS_ENDPOINT:-}" \
  PUPPETEER_EXECUTABLE_PATH="$chrome" \
  SCRAPE_MAX_CONCURRENT_PAGES="${SCRAPE_MAX_CONCURRENT_PAGES:-2}" \
  nohup node --import tsx --env-file-if-exists=../.env src/index.ts >"../.run/loadtest-server.log" 2>&1 &
  echo $! >"../$pidfile"
)
echo "load-test server started (pid $(cat "$pidfile"), log .run/loadtest-server.log)"

for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$port/api/health" >/dev/null 2>&1; then
    echo "ready: http://localhost:$port"
    exit 0
  fi
  sleep 1
done
echo "server didn't answer /api/health within 60 s — see .run/loadtest-server.log" >&2
exit 1
