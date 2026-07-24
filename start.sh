#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
set -a
# shellcheck disable=SC1091
source ./.env
set +a
BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
CHILD_PIDS=()
if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is occupied; no process was terminated." >&2
    exit 1
  fi
done
cleanup() {
  for pid in "${CHILD_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM
(exec env SERVICE_MODE=api PORT="$BACKEND_PORT" node src/server.js) &
CHILD_PIDS+=("$!")
(exec env SERVICE_MODE=ui PORT="$FRONTEND_PORT" node src/server.js) &
CHILD_PIDS+=("$!")
wait "${CHILD_PIDS[@]}"
