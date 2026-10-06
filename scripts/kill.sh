#!/usr/bin/env bash
# Stops processes started by scripts/dev.sh (reads .run/*.pid, kills the
# process and its children, removes the PID files).
set -uo pipefail
cd "$(dirname "$0")/.."

kill_tree() {
  local pid="$1"
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null
}

shopt -s nullglob
found=0
for pidfile in .run/*.pid; do
  found=1
  name="$(basename "$pidfile" .pid)"
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill_tree "$pid"
    sleep 0.5
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    echo "stopped $name (pid $pid)"
  else
    echo "$name (pid $pid) was not running"
  fi
  rm -f "$pidfile"
done
[[ $found -eq 0 ]] && echo "nothing to stop (no .run/*.pid files)"
exit 0
