#!/usr/bin/env bash
# Starts everything for local use: Postgres (5433), Hunyuan3D-2.0 worker (8081, background),
# Hunyuan3D-2.1 worker (8082, background, when set up and HUNYUAN21_WORKER_URL is set), web app (3000, foreground).
# The workers run on CUDA when the machine has an NVIDIA GPU (worker/cuda/*), else on Apple Silicon (worker/mac/*);
# WORKER_PLATFORM=cuda|mac overrides the detection.
# Ctrl+C stops the web app and the workers this script started. Postgres keeps running (pg_ctl -D data/pgdata stop).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="$ROOT/data"
WORKER_PIDS=()

detect_platform() {
  if command -v nvidia-smi >/dev/null && nvidia-smi -L 2>/dev/null | grep -q '^GPU'; then
    echo cuda
  elif [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then
    echo mac
  fi
}
PLATFORM="${WORKER_PLATFORM:-$(detect_platform)}"
case "$PLATFORM" in
  cuda | mac) echo "==> Worker platform: $PLATFORM" ;;
  *) echo "The worker needs an NVIDIA GPU (CUDA) or an Apple Silicon Mac; set WORKER_PLATFORM=cuda|mac to force one" >&2; exit 1 ;;
esac

# Linux packages keep pg_ctl outside PATH (e.g. /usr/lib/postgresql/16/bin)
if ! command -v pg_ctl >/dev/null; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$PG_BIN" ] && PATH="$PG_BIN:$PATH"
fi

cleanup() {
  for pid in ${WORKER_PIDS[@]+"${WORKER_PIDS[@]}"}; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "==> Stopping worker (PID $pid)"
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

# 1. Postgres
if pg_ctl -D "$DATA/pgdata" status >/dev/null 2>&1; then
  echo "==> Postgres already running"
else
  echo "==> Starting Postgres on 5433"
  pg_ctl -D "$DATA/pgdata" -o "-p 5433" -l "$DATA/pgdata.log" -w start
fi

# 2. Hunyuan3D workers. Both can run: they share data/engine.lock, so only one keeps its models in memory.
start_worker() { # name run-script venv-python port setup-script log
  local name="$1" run="$2" venv="$3" port="$4" setup="$5" logf="$6" pid
  if curl -sf "http://localhost:$port/healthz" >/dev/null; then
    echo "==> $name worker already running (port $port)"
    return
  fi
  [ -x "$venv" ] || { echo "$venv missing, run $setup" >&2; exit 1; }
  echo "==> Starting $name worker (log: data/$logf)"
  "$run" >"$DATA/$logf" 2>&1 &
  pid=$!
  WORKER_PIDS+=("$pid")
  printf "    waiting for worker"
  until curl -sf "http://localhost:$port/healthz" >/dev/null; do
    kill -0 "$pid" 2>/dev/null || { echo; echo "Worker exited, see data/$logf" >&2; tail -20 "$DATA/$logf" >&2; exit 1; }
    printf "."
    sleep 2
  done
  echo " ready"
}
start_worker "Hunyuan3D-2.0" "$ROOT/worker/$PLATFORM/run.sh" "$ROOT/worker/.venv/bin/python" 8081 "worker/$PLATFORM/setup.sh" worker.log
if grep -q '^HUNYUAN21_WORKER_URL=' "$ROOT/web/.env.local" 2>/dev/null; then
  start_worker "Hunyuan3D-2.1" "$ROOT/worker/$PLATFORM/run-2.1.sh" "$ROOT/worker/.venv21/bin/python" 8082 "worker/$PLATFORM/setup-2.1.sh" worker-2.1.log
fi
if [ "$PLATFORM" = cuda ] && [ ! -x "$ROOT/SkinTokens/.venv/bin/python" ]; then
  echo "    AI auto-rig is off: run worker/cuda/setup-skintokens.sh to enable it (then restart)"
fi

# 3. Web
cd "$ROOT/web"
[ -d node_modules ] || pnpm install
# drizzle-kit does not read .env.local (next dev does)
echo "==> Applying DB migrations"
if ! MIGRATE_OUT="$(DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d "\"'")" pnpm db:migrate 2>&1)"; then
  echo "$MIGRATE_OUT" >&2
  exit 1
fi
if lsof -ti tcp:3000 -sTCP:LISTEN >/dev/null; then
  echo "==> Web app already running: http://localhost:3000"
  # Keep the workers this script started alive until Ctrl+C
  [ ${#WORKER_PIDS[@]} -eq 0 ] || wait "${WORKER_PIDS[@]}"
  exit 0
fi
echo "==> Web app: http://localhost:3000"
pnpm dev
