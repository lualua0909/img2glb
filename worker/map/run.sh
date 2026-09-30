#!/usr/bin/env bash
# Runs the map worker (port 8083) for the local web app (web/.env.local: MAP_WORKER_URL=http://localhost:8083).
set -euo pipefail
cd "$(dirname "$0")"
TOKEN="$(grep '^HUNYUAN_WORKER_TOKEN=' ../../web/.env.local | cut -d= -f2-)"
export WORKER_TOKEN="${WORKER_TOKEN:-$(grep '^MAP_WORKER_TOKEN=' ../../web/.env.local | cut -d= -f2- || true)}"
export WORKER_TOKEN="${WORKER_TOKEN:-$TOKEN}"
export HUNYUAN_WORKER_URL="${HUNYUAN_WORKER_URL:-http://localhost:8081}"
export HUNYUAN_WORKER_TOKEN="${HUNYUAN_WORKER_TOKEN:-$TOKEN}"
export ALLOWED_IMAGE_HOSTS="${ALLOWED_IMAGE_HOSTS:-localhost}" # web app serves inputs from localhost
exec .venv/bin/python server.py
