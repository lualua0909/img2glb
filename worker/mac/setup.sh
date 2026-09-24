#!/usr/bin/env bash
# Sets up the worker on Apple Silicon (MPS): worker/.venv, patched Hunyuan3D-2, CPU-only custom_rasterizer.
# Requires uv (https://docs.astral.sh/uv/) and Xcode command line tools.
set -euo pipefail
cd "$(dirname "$0")/.."
HY="${HY3D_REPO:-../Hunyuan3D-2}"
PATCH="$PWD/mac/hunyuan3d-mps.patch"

if [ ! -e "$HY/.git" ]; then
  git -C .. submodule update --init -- "$(basename "$HY")" 2>/dev/null || git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git "$HY"
fi
if git -C "$HY" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "macOS patch already applied"
else
  git -C "$HY" apply "$PATCH"
fi

[ -x .venv/bin/python ] || uv venv --python 3.12 .venv
# gradio is only for upstream's demo app, not the worker
REQS="$(mktemp)"
grep -vx 'gradio' "$HY/requirements.txt" > "$REQS"
uv pip install --python .venv/bin/python -r "$REQS" -r requirements.txt setuptools
rm -f "$REQS"
uv pip install --python .venv/bin/python --no-deps -e "$HY"
uv pip install --python .venv/bin/python --no-build-isolation "$HY/hy3dgen/texgen/custom_rasterizer"
.venv/bin/python -c "import torch, custom_rasterizer; print('torch', torch.__version__, '| mps', torch.backends.mps.is_available())"
