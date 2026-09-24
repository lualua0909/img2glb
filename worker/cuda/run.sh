#!/usr/bin/env bash
# Runs the worker on a CUDA host for the local web app (web/.env.local: HUNYUAN_WORKER_URL=http://localhost:8081).
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="$(cd .. && pwd)/data"

# Load tencent/Hunyuan3D-2 from the cached HF snapshot (see mac/run.sh).
SNAP=$(ls -d "$DATA"/models/hub/models--tencent--Hunyuan3D-2/snapshots/*/ 2>/dev/null | head -1)
if [ -n "$SNAP" ]; then
  mkdir -p "$DATA/models/hy3dgen/tencent"
  ln -sfn "${SNAP%/}" "$DATA/models/hy3dgen/tencent/Hunyuan3D-2"
fi

export WORKER_TOKEN="${WORKER_TOKEN:-$(grep '^HUNYUAN_WORKER_TOKEN=' ../web/.env.local | cut -d= -f2-)}"
export DEVICE=cuda
export ALLOWED_IMAGE_HOSTS="${ALLOWED_IMAGE_HOSTS:-localhost}" # web app serves inputs from localhost (STORAGE_DRIVER=local)
export HY3DGEN_MODELS="$DATA/models/hy3dgen"
exec .venv/bin/python server.py
