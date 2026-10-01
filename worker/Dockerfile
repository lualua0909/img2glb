# GPU worker: Hunyuan3D-2.1 shape + PBR texture + text-to-image.
# Needs an NVIDIA GPU with >= 32 GB VRAM for shape + texture (upstream: 10 GB shape, 21 GB texture, 29 GB both).
# Build from the repo root (needs the vendored Hunyuan3D-2.1/): docker build -f worker/Dockerfile -t hy3d-worker .
FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 \
    DATA_ROOT=/data TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9;9.0" \
    HY21_REPO=/opt/Hunyuan3D-2.1 OMNI_REPO=/opt/Hunyuan3D-Omni REALESRGAN_CKPT=/opt/realesrgan/RealESRGAN_x4plus.pth
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.10 python3-pip python3.10-dev git curl libgl1 libglib2.0-0 libegl1 build-essential ninja-build \
    && rm -rf /var/lib/apt/lists/* && ln -sf /usr/bin/python3.10 /usr/bin/python

RUN pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124

# Vendored Hunyuan3D-2.1, device-agnostic patch already applied (see mac/README.md).
WORKDIR /opt
COPY Hunyuan3D-2.1 /opt/Hunyuan3D-2.1
# Vendored Hunyuan3D-Omni (multi-view jobs with `omni`), see worker/hunyuan3d-omni.patch.
COPY Hunyuan3D-Omni /opt/Hunyuan3D-Omni

# Upstream pins minus packages the worker never imports (cupy, bpy, deepspeed, gradio); same set as cuda/setup.sh.
COPY worker/requirements.txt /opt/worker/requirements.txt
RUN pip install "diffusers==0.30.0" "transformers==4.46.0" "accelerate==1.1.1" \
      "huggingface-hub==0.30.2" safetensors "numpy<2" scipy einops pandas "opencv-python<4.11" imageio scikit-image \
      "rembg[cpu]" realesrgan basicsr trimesh pymeshlab pygltflib xatlas omegaconf pyyaml configargparse tqdm psutil \
      timm torchdiffeq pytorch-lightning onnxruntime ninja pybind11 setuptools -r /opt/worker/requirements.txt \
    && pip install --no-build-isolation /opt/Hunyuan3D-2.1/hy3dpaint/custom_rasterizer \
    && cd /opt/Hunyuan3D-2.1/hy3dpaint/DifferentiableRenderer \
    && c++ -O3 -shared -std=c++11 -fPIC $(python -m pybind11 --includes) \
         mesh_inpaint_processor.cpp -o "mesh_inpaint_processor$(python -c 'import sysconfig; print(sysconfig.get_config_var("EXT_SUFFIX"))')"
RUN mkdir -p /opt/realesrgan && curl -fL -o "$REALESRGAN_CKPT" \
      https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth

COPY worker/server.py worker/texture_clean.py worker/multiview.py worker/wings.py /opt/worker/

# Model weights (/data/models), job outputs (/data/worker-jobs) and the admin model config live under /data.
# Mount the project's data/ folder (or a volume) there to persist them.
VOLUME ["/data"]
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=900s CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8081/healthz')"
CMD ["python", "/opt/worker/server.py"]
