#!/usr/bin/env bash
# Runs the worker on Apple Silicon (MPS) for the local web app (web/.env.local: HUNYUAN_WORKER_URL=http://localhost:8081).
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="$(cd .. && pwd)/data"

# Load tencent/Hunyuan3D-2 from the cached HF snapshot. Without this, hy3dgen asks the Hub for whole subfolders
# and re-downloads files we skip on purpose (duplicate .ckpt weights, ~5 GB each).
SNAP=$(ls -d "$DATA"/models/hub/models--tencent--Hunyuan3D-2/snapshots/*/ 2>/dev/null | head -1)
if [ -n "$SNAP" ]; then
  mkdir -p "$DATA/models/hy3dgen/tencent"
  ln -sfn "${SNAP%/}" "$DATA/models/hy3dgen/tencent/Hunyuan3D-2"
fi

export WORKER_TOKEN="${WORKER_TOKEN:-$(grep '^HUNYUAN_WORKER_TOKEN=' ../web/.env.local | cut -d= -f2-)}"
export DEVICE=mps
export ENABLE_T2I="${ENABLE_T2I:-0}"                     # text-to-3D (HunyuanDiT) is untested on MPS
export ALLOWED_IMAGE_HOSTS="${ALLOWED_IMAGE_HOSTS:-localhost}" # web app serves inputs from localhost (STORAGE_DRIVER=local)
export HY3DGEN_MODELS="$DATA/models/hy3dgen"
exec .venv/bin/python server.py
