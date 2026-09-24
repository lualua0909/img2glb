#!/usr/bin/env bash
# Sets up the Hunyuan3D-2.1 engine on a CUDA host (Linux, NVIDIA GPU): worker/.venv21, Hunyuan3D-2.1 with the same
# device-agnostic patch as the Mac, the CUDA custom_rasterizer and the mesh inpaint extension. Runs next to the 2.0
# engine (setup.sh). Requires uv, a C++ compiler and the CUDA toolkit (nvcc) matching TORCH_INDEX (default CUDA 12.8).
set -euo pipefail
cd "$(dirname "$0")/.."
HY="${HY21_REPO:-../Hunyuan3D-2.1}"
PATCH="$PWD/mac/hunyuan3d-2.1-mps.patch" # keeps the CUDA paths; adds the device argument the worker passes
PY=.venv21/bin/python
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu128}"

command -v nvidia-smi >/dev/null || { echo "No NVIDIA GPU (nvidia-smi not found): on a Mac use mac/setup-2.1.sh" >&2; exit 1; }
command -v nvcc >/dev/null || { echo "nvcc not found: install the CUDA toolkit (custom_rasterizer is a CUDA extension)" >&2; exit 1; }
if [ ! -e "$HY/.git" ]; then
  git -C .. submodule update --init -- "$(basename "$HY")" 2>/dev/null || git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git "$HY"
fi
if git -C "$HY" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "device patch already applied"
else
  git -C "$HY" apply "$PATCH"
fi

[ -x "$PY" ] || uv venv --python 3.12 .venv21
uv pip install --python "$PY" torch torchvision --index-url "$TORCH_INDEX"
# Upstream pins (requirements.txt), minus packages the worker never imports: cupy, bpy (GLB export goes through
# trimesh), deepspeed (training), gradio (demo UI). Same set as mac/setup-2.1.sh.
uv pip install --python "$PY" "diffusers==0.30.0" "transformers==4.46.0" "accelerate==1.1.1" \
  "huggingface-hub==0.30.2" safetensors "numpy<2" scipy einops pandas "opencv-python<4.11" imageio scikit-image \
  "rembg[cpu]" realesrgan basicsr trimesh pymeshlab pygltflib xatlas omegaconf pyyaml configargparse tqdm psutil \
  timm torchdiffeq pytorch-lightning onnxruntime ninja pybind11 setuptools -r requirements.txt
uv pip install --python "$PY" --no-build-isolation "$HY/hy3dpaint/custom_rasterizer"
(
  cd "$HY/hy3dpaint/DifferentiableRenderer"
  INC="$("$OLDPWD/$PY" -c 'import pybind11, sysconfig; print(pybind11.get_include()); print(sysconfig.get_paths()["include"])')"
  SUF="$("$OLDPWD/$PY" -c 'import sysconfig; print(sysconfig.get_config_var("EXT_SUFFIX"))')"
  c++ -O3 -shared -std=c++11 -fPIC -I"$(sed -n 1p <<<"$INC")" -I"$(sed -n 2p <<<"$INC")" \
    mesh_inpaint_processor.cpp -o "mesh_inpaint_processor$SUF"
)
mkdir -p ../data/models/realesrgan
[ -f ../data/models/realesrgan/RealESRGAN_x4plus.pth ] || curl -fL -o ../data/models/realesrgan/RealESRGAN_x4plus.pth \
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
"$PY" -c "import torch, custom_rasterizer; print('torch', torch.__version__, '| cuda', torch.cuda.is_available())"
