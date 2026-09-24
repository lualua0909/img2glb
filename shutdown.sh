#!/usr/bin/env bash
# Stops everything started by start.sh: web app (3000), Hunyuan3D-2.0 / 2.1 workers (8081 / 8082), Postgres (5433).
# Idempotent: safe to run even when nothing is running.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="$ROOT/data"

kill_port() {
  local port="$1" pids pid
  pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    echo "==> Port $port: not listening"
    return 0
  fi
  for pid in $pids; do
    echo "==> Killing PID $pid on port $port ($(ps -o command= -p "$pid" 2>/dev/null | cut -c1-100))"
    kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 15); do
    pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$pids" ] && { echo "    port $port freed"; return 0; }
    sleep 1
  done
  for pid in $pids; do
    echo "    force-killing PID $pid"
    kill -9 "$pid" 2>/dev/null || true
  done
}

# 1. Web app (next dev :3000, standalone build :3100)
kill_port 3000
kill_port 3100
# Catch orphaned dev processes scoped to this project (no port held during startup)
pkill -f "$ROOT/web/node_modules" 2>/dev/null || true
# pnpm dev whose cwd is under web/ (pattern match is broad, so filter by cwd)
for pid in $(pgrep -f "pnpm dev" 2>/dev/null || true); do
  if lsof -p "$pid" 2>/dev/null | grep -q "$ROOT/web"; then
    echo "==> Killing orphaned pnpm dev (PID $pid)"
    kill "$pid" 2>/dev/null || true
  fi
done

# 2. Workers (:8081 Hunyuan3D-2.0, :8082 Hunyuan3D-2.1; .venv / .venv21 + server.py under this project)
kill_port 8081
kill_port 8082
pkill -f "$ROOT/worker/.venv" 2>/dev/null || true  # also matches .venv21
pkill -f "$ROOT/SkinTokens/.venv" 2>/dev/null || true  # auto-rig jobs run in their own session (CUDA hosts)
for pid in $(pgrep -f "server\.py" 2>/dev/null || true); do
  if lsof -p "$pid" 2>/dev/null | grep -q "$ROOT"; then
    echo "==> Killing orphaned worker server.py (PID $pid)"
    kill "$pid" 2>/dev/null || true
  fi
done

# 3. Postgres (data/pgdata, -p 5433): first cancel every unfinished job (refunding paid ones) so none
# resumes on the next start, possibly against a different provider.
if pg_ctl -D "$DATA/pgdata" status >/dev/null 2>&1; then
  DB_URL="$(grep '^DATABASE_URL=' "$ROOT/web/.env.local" 2>/dev/null | cut -d= -f2- | tr -d "\"'" || true)"
  if [ -n "$DB_URL" ]; then
    CANCELLED="$(psql "$DB_URL" -Atq -v ON_ERROR_STOP=1 <<'SQL'
WITH f AS (
  UPDATE generation
  SET status = 'failed',
      error = 'Cancelled: server shut down.' || CASE WHEN cost > 0 THEN ' Your credits were refunded.' ELSE '' END,
      lease_until = NULL, completed_at = now(), progress_message = NULL
  WHERE status IN ('queued', 'processing')
  RETURNING id, user_id, cost
), r AS (
  INSERT INTO credit_ledger (id, user_id, delta, reason, generation_id)
  SELECT gen_random_uuid()::text, user_id, cost, 'refund', id FROM f WHERE cost > 0
  ON CONFLICT DO NOTHING
  RETURNING user_id, delta
), u AS (
  UPDATE "user" SET credits = credits + s.d
  FROM (SELECT user_id, sum(delta) AS d FROM r GROUP BY user_id) s
  WHERE "user".id = s.user_id
  RETURNING 1
)
SELECT count(*) FROM f;
SQL
)" && echo "==> Cancelled $CANCELLED unfinished job(s)" || echo "    WARNING: could not cancel unfinished jobs" >&2
  fi
  echo "==> Stopping Postgres"
  pg_ctl -D "$DATA/pgdata" stop
else
  echo "==> Postgres: not running"
fi

echo "==> Done. Remaining listeners:"
ALIVE=0
for p in 3000 3100 5433 8081 8082; do
  if lsof -i tcp:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "    port $p still listening:"
    lsof -i tcp:"$p" -sTCP:LISTEN 2>/dev/null
    ALIVE=1
  fi
done
[ "$ALIVE" -eq 0 ] && echo "    none"
