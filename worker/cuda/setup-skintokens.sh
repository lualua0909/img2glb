#!/usr/bin/env bash
# Sets up auto-rigging (SkinTokens/TokenRig, MIT) for the worker on a CUDA host (Linux, NVIDIA GPU >= 14 GB free,
# CUDA toolkit >= 12.1 for flash-attn). Own Python 3.11 venv in ../SkinTokens/.venv. Weights (~3 GB) go to
# data/models/skintokens and are linked into the checkout. Requires uv (https://docs.astral.sh/uv/).
# TORCH_INDEX: PyTorch wheel index matching your driver (default CUDA 12.8).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
REPO="${SKINTOKENS_REPO:-$ROOT/SkinTokens}"
DATA="${DATA_ROOT:-$ROOT/data}"
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu128}"

command -v nvidia-smi >/dev/null || { echo "No NVIDIA GPU (nvidia-smi not found): auto-rigging needs CUDA." >&2; exit 1; }
[ -d "$REPO" ] || git clone https://github.com/VAST-AI-Research/SkinTokens.git "$REPO"
[ -x "$REPO/.venv/bin/python" ] || uv venv --python 3.11 "$REPO/.venv"
PY="$REPO/.venv/bin/python"

uv pip install --python "$PY" torch==2.7.0 torchvision==0.22.0 --index-url "$TORCH_INDEX"
# gradio is only for upstream's demo UI; the worker runs cuda/skintokens_rig.py instead
REQS="$(mktemp)"
grep -vx 'gradio' "$REPO/requirements.txt" > "$REQS"
uv pip install --python "$PY" -r "$REQS"
rm -f "$REQS"
uv pip install --python "$PY" --no-build-isolation flash-attn

# Checkpoints and the Qwen3-0.6B config under data/, linked into the checkout (download.py writes relative to cwd).
mkdir -p "$DATA/models/skintokens"
for d in experiments models; do
  mkdir -p "$DATA/models/skintokens/$d"
  [ -e "$REPO/$d" ] || ln -s "$DATA/models/skintokens/$d" "$REPO/$d"
done
(cd "$REPO" && HF_HOME="$DATA/models" "$PY" download.py --model)

"$PY" -c "import torch, flash_attn, bpy; print('torch', torch.__version__, '| cuda', torch.cuda.is_available(), '| bpy', bpy.app.version_string)"
echo "SkinTokens ready: restart the worker, /healthz then reports \"autorig\": true."
