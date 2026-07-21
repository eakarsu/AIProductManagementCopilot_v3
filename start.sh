#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-${BACKEND_PORT:-3000}}"
export PORT
if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is occupied; no process was terminated." >&2
  exit 1
fi
cd "$PROJECT_DIR"
exec node src/server.js
