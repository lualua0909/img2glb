# Worker on Apple Silicon (MPS)

Runs the worker on a Mac for the local web app. Shape and texture both run on the Mac GPU (MPS), no CUDA needed.
Tested on an M4 with 32 GB, macOS 26.6, torch 2.14.

## Setup

```bash
./mac/setup.sh
```

This creates `worker/.venv`, applies `hunyuan3d-mps.patch` to `../Hunyuan3D-2` and builds the CPU-only
`custom_rasterizer`. It skips gradio (only used by upstream's demo app). Needs `uv` and the Xcode command line tools.

Weights go into the worker's Hugging Face cache, `data/models`. The worker defaults to the full (non-distilled)
models:

```bash
HF_HOME=../data/models .venv/bin/hf download tencent/Hunyuan3D-2 \
  --include "hunyuan3d-dit-v2-0/*" --include "hunyuan3d-delight-v2-0/*" --include "hunyuan3d-paint-v2-0/*" \
  --exclude "*.ckpt"
```

The `.ckpt` files duplicate the `.safetensors` ones (~5 GB). The admin CMS download also works, but it fetches them.

## Run

```bash
./mac/run.sh
```

`run.sh` reads the token from `web/.env.local`, which needs:

```
HUNYUAN_WORKER_URL=http://localhost:8081
HUNYUAN_WORKER_TOKEN=<24+ chars>
```

On the M4 (full models, 30 steps, octree 256, 40k faces): models load in ~37 s, shape takes ~400 s, texture
~270 s, peak RSS ~15 GB.

## Hunyuan3D-2.1 (second engine, :8082)

```bash
./mac/setup-2.1.sh   # clones ../Hunyuan3D-2.1, applies hunyuan3d-2.1-mps.patch, creates .venv21
./mac/run-2.1.sh     # or ../start.sh, which starts it when web/.env.local has HUNYUAN21_WORKER_URL
```

Models download on the first 2.1 job (~20 GB: DiT v2.1, VAE, PaintPBR, DINOv2-giant, Real-ESRGAN). The two
engines never hold models at the same time: they hand memory over through `data/engine.lock` (see
`docs/adr/0003-hunyuan3d-2.1-side-by-side.md`). Same settings on the M4: load ~33 s, shape ~585 s,
PBR texture (6 views x 512) ~495 s, peak RSS ~18 GB. 9 views x 768 does not fit in 32 GB.

## Notes

- `hunyuan3d-mps.patch` makes texturing device-agnostic. It adds a `device` argument where upstream hardcodes
  `cuda`, uses float32 where MPS has no float64, builds `custom_rasterizer` without CUDA (the renderer runs on CPU,
  the diffusion models on MPS) and passes `trust_remote_code` as newer diffusers requires. CUDA builds behave as
  before.
- The full shape model needs 30-50 steps (quality presets in `/app/admin`). Only full models are used (no turbo/fast/mini).
- `data/worker-config.json` (written by the admin CMS and on every model load) overrides `ENABLE_TEX` / `ENABLE_T2I`.
- Text-to-3D (HunyuanDiT) is untested on MPS, so `run.sh` disables it (`ENABLE_T2I=0`).
- `run.sh` points `HY3DGEN_MODELS` at the cached snapshot. Recent `huggingface_hub` versions refuse cached
  snapshots with missing files, so otherwise the worker would download the skipped `.ckpt` files.
