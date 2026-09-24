#!/usr/bin/env bash
# Runs the Hunyuan3D-2.1 engine on Apple Silicon (MPS) next to the 2.0 worker
# (web/.env.local: HUNYUAN21_WORKER_URL=http://localhost:8082). Models load on the first 2.1 job; the two
# engines hand memory to each other through data/engine.lock (see server.py).
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
export ENGINE=2.1
export PORT="${PORT:-8082}"
export LOAD_ON_START="${LOAD_ON_START:-0}"
export DEVICE=mps
export ENABLE_T2I="${ENABLE_T2I:-0}"                     # text-to-3D (HunyuanDiT) is untested on MPS
# PBR paint views x resolution. 9 x 768 (upstream max) needs >32 GB: on a 32 GB M4 it swaps for 20+ min.
export PAINT_VIEWS="${PAINT_VIEWS:-6}"
export PAINT_RESOLUTION="${PAINT_RESOLUTION:-512}"
export ALLOWED_IMAGE_HOSTS="${ALLOWED_IMAGE_HOSTS:-localhost}"
export HY3DGEN_MODELS="$DATA/models/hy3dgen"
exec .venv21/bin/python server.py
