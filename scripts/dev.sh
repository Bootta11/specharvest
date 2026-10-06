#!/usr/bin/env bash
# Starts the API (tsx watch) and the Vite client in the background.
# PIDs go to .run/*.pid, logs to .run/*.log. Stop with scripts/kill.sh.
#   scripts/dev.sh          # both
#   scripts/dev.sh server   # API only
#   scripts/dev.sh client   # client only
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .run

start() {
  local name="$1"; shift
  local pidfile=".run/$name.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pidfile"))"
    return
  fi
  # setsid-less process group: run in its own group so kill.sh can stop children (tsx/vite spawn workers).
  nohup "$@" >".run/$name.log" 2>&1 &
  echo $! >"$pidfile"
  echo "$name started (pid $!, log .run/$name.log)"
}

what="${1:-all}"
if [[ "$what" == "all" || "$what" == "server" ]]; then
  start server npm run dev --workspace server
fi
if [[ "$what" == "all" || "$what" == "client" ]]; then
  start client npm run dev --workspace client
fi
echo "API: http://localhost:${PORT:-3100}  UI: http://localhost:5180"
