#!/usr/bin/env bash
# Runs the worker on Apple Silicon (MPS) for the local web app (web/.env.local: HUNYUAN_WORKER_URL=http://localhost:8081).
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="$(cd .. && pwd)/data"

# Load tencent/Hunyuan3D-2.1 from the cached HF snapshot instead of letting hy3dshape copy it into HY3DGEN_MODELS.
SNAP=$(ls -d "$DATA"/models/hub/models--tencent--Hunyuan3D-2.1/snapshots/*/ 2>/dev/null | head -1)
if [ -n "$SNAP" ]; then
  mkdir -p "$DATA/models/hy3dgen/tencent"
  ln -sfn "${SNAP%/}" "$DATA/models/hy3dgen/tencent/Hunyuan3D-2.1"
fi

export WORKER_TOKEN="${WORKER_TOKEN:-$(grep '^HUNYUAN_WORKER_TOKEN=' ../web/.env.local | cut -d= -f2-)}"
export DEVICE=mps
export ENABLE_T2I="${ENABLE_T2I:-0}"                     # text-to-3D (HunyuanDiT) is untested on MPS
# PBR paint views x resolution. 9 x 768 (upstream max) needs >32 GB: on a 32 GB M4 it swaps for 20+ min.
export PAINT_VIEWS="${PAINT_VIEWS:-6}"
export PAINT_RESOLUTION="${PAINT_RESOLUTION:-512}"
export ALLOWED_IMAGE_HOSTS="${ALLOWED_IMAGE_HOSTS:-localhost}" # web app serves inputs from localhost (STORAGE_DRIVER=local)
export HY3DGEN_MODELS="$DATA/models/hy3dgen"
exec .venv/bin/python server.py
