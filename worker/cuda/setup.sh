#!/usr/bin/env bash
# Sets up the worker on a CUDA host (Linux, NVIDIA GPU): worker/.venv, Hunyuan3D-2 with the same device-agnostic patch
# as the Mac (device argument, CUDA or CPU rasterizer) and the CUDA custom_rasterizer.
# Requires uv (https://docs.astral.sh/uv/), a C++ compiler and the CUDA toolkit (nvcc) matching TORCH_INDEX.
# TORCH_INDEX: PyTorch wheel index matching your driver (default CUDA 12.8).
set -euo pipefail
cd "$(dirname "$0")/.."
HY="${HY3D_REPO:-../Hunyuan3D-2}"
PATCH="$PWD/mac/hunyuan3d-mps.patch" # despite the name, it keeps the CUDA paths (builds the CUDA kernel when nvcc exists)
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu128}"

command -v nvidia-smi >/dev/null || { echo "No NVIDIA GPU (nvidia-smi not found): on a Mac use mac/setup.sh" >&2; exit 1; }
command -v nvcc >/dev/null || { echo "nvcc not found: install the CUDA toolkit (custom_rasterizer is a CUDA extension)" >&2; exit 1; }
if [ ! -e "$HY/.git" ]; then
  git -C .. submodule update --init -- "$(basename "$HY")" 2>/dev/null || git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git "$HY"
fi
if git -C "$HY" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "device patch already applied"
else
  git -C "$HY" apply "$PATCH"
fi

[ -x .venv/bin/python ] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python torch torchvision --index-url "$TORCH_INDEX"
# gradio is only for upstream's demo app, not the worker
REQS="$(mktemp)"
grep -vx 'gradio' "$HY/requirements.txt" > "$REQS"
uv pip install --python .venv/bin/python -r "$REQS" -r requirements.txt setuptools
rm -f "$REQS"
uv pip install --python .venv/bin/python --no-deps -e "$HY"
uv pip install --python .venv/bin/python --no-build-isolation "$HY/hy3dgen/texgen/custom_rasterizer"
.venv/bin/python -c "import torch, custom_rasterizer; print('torch', torch.__version__, '| cuda', torch.cuda.is_available())"
