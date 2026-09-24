# GPU worker: Hunyuan3D-2 shape + texture + text-to-image.
# Needs an NVIDIA GPU with >= 16 GB VRAM for shape+texture (24 GB recommended with text-to-3D).
FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 \
    DATA_ROOT=/data TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9;9.0"
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.10 python3-pip python3.10-dev git libgl1 libglib2.0-0 libegl1 build-essential ninja-build \
    && rm -rf /var/lib/apt/lists/* && ln -sf /usr/bin/python3.10 /usr/bin/python

RUN pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124

WORKDIR /opt
# Pin to a known commit in production: git checkout <sha>
RUN git clone --depth 1 https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git
WORKDIR /opt/Hunyuan3D-2
RUN pip install -r requirements.txt && pip install -e . \
    && cd hy3dgen/texgen/custom_rasterizer && python setup.py install \
    && cd ../differentiable_renderer && python setup.py install

COPY requirements.txt /opt/worker/requirements.txt
RUN pip install -r /opt/worker/requirements.txt
COPY server.py /opt/worker/server.py

# Model weights (/data/models), job outputs (/data/worker-jobs) and the admin model config live under /data.
# Mount the project's data/ folder (or a volume) there to persist them.
VOLUME ["/data"]
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=900s CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8081/healthz')"
CMD ["python", "/opt/worker/server.py"]
