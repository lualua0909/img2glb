#!/usr/bin/env bash
# Sets up the Hunyuan3D-2.1 engine on Apple Silicon (MPS): worker/.venv21, patched Hunyuan3D-2.1,
# CPU-only custom_rasterizer and the mesh inpaint extension. Runs next to the 2.0 engine (setup.sh).
# Requires uv (https://docs.astral.sh/uv/) and Xcode command line tools.
set -euo pipefail
cd "$(dirname "$0")/.."
HY="${HY21_REPO:-../Hunyuan3D-2.1}"
PATCH="$PWD/mac/hunyuan3d-2.1-mps.patch"
PY=.venv21/bin/python

if [ ! -e "$HY/.git" ]; then
  git -C .. submodule update --init -- "$(basename "$HY")" 2>/dev/null || git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git "$HY"
fi
if git -C "$HY" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "macOS patch already applied"
else
  git -C "$HY" apply "$PATCH"
fi

[ -x "$PY" ] || uv venv --python 3.12 .venv21
# Upstream pins (requirements.txt), minus CUDA/Blender/training/demo packages: cupy, bpy, deepspeed, gradio.
uv pip install --python "$PY" torch torchvision "diffusers==0.30.0" "transformers==4.46.0" "accelerate==1.1.1" \
  "huggingface-hub==0.30.2" safetensors "numpy<2" scipy einops pandas "opencv-python<4.11" imageio scikit-image \
  "rembg[cpu]" realesrgan basicsr trimesh pymeshlab pygltflib xatlas omegaconf pyyaml configargparse tqdm psutil \
  timm torchdiffeq pytorch-lightning onnxruntime ninja pybind11 setuptools -r requirements.txt
uv pip install --python "$PY" --no-build-isolation "$HY/hy3dpaint/custom_rasterizer"
(
  cd "$HY/hy3dpaint/DifferentiableRenderer"
  INC="$("$OLDPWD/$PY" -c 'import pybind11, sysconfig; print(pybind11.get_include()); print(sysconfig.get_paths()["include"])')"
  SUF="$("$OLDPWD/$PY" -c 'import sysconfig; print(sysconfig.get_config_var("EXT_SUFFIX"))')"
  c++ -O3 -shared -std=c++11 -fPIC -undefined dynamic_lookup -I"$(sed -n 1p <<<"$INC")" -I"$(sed -n 2p <<<"$INC")" \
    mesh_inpaint_processor.cpp -o "mesh_inpaint_processor$SUF"
)
mkdir -p ../data/models/realesrgan
[ -f ../data/models/realesrgan/RealESRGAN_x4plus.pth ] || curl -fL -o ../data/models/realesrgan/RealESRGAN_x4plus.pth \
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
"$PY" -c "import torch, custom_rasterizer; print('torch', torch.__version__, '| mps', torch.backends.mps.is_available())"
