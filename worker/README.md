# Hunyuan3D-2 GPU worker

Self-hosted inference backend for the web app. Wraps the upstream
[Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) pipelines behind an authenticated job API.

Modified from upstream `api_server.py`: auth, FIFO GPU queue, URL input, text-to-3D, refinement, job status API,
TTL cleanup.

## Requirements

- NVIDIA GPU. Shape only: ~6 GB VRAM. Shape + texture: ~16 GB. With text-to-3D (HunyuanDiT): 24 GB recommended
  (or set `LOW_VRAM=1`).
- Recommended hosts: RunPod, Lambda, Vast.ai, AWS g5/g6, GCP L4/A100.
- Apple Silicon Mac (MPS): see [mac/README.md](mac/README.md).

## Local host (no Docker)

`../start.sh` runs the workers on the machine itself and picks the platform: `cuda/*` scripts when `nvidia-smi` lists
a GPU, `mac/*` on Apple Silicon (`WORKER_PLATFORM=cuda|mac` overrides). Both use `worker/.venv` (2.0) and
`worker/.venv21` (2.1) and the same device-agnostic Hunyuan patches (`mac/*.patch`: device argument, CUDA kernel when
nvcc exists, CPU kernel otherwise). On a CUDA host, set up once:

```bash
./cuda/setup.sh              # Hunyuan3D-2.0 (needs uv, nvcc; TORCH_INDEX picks the CUDA wheels, default cu128)
./cuda/setup-2.1.sh          # Hunyuan3D-2.1 (optional)
./cuda/setup-skintokens.sh   # AI auto-rig (optional, see below)
```

On CUDA the worker keeps upstream's quality defaults (2.1 paints 9 views at 768 px, text-to-3D on).

## Run

```bash
docker build -t hy3d-worker .
docker run --gpus all -p 8081:8081 -v "$PWD/../data:/data" \
  -e WORKER_TOKEN=$(openssl rand -hex 24) \
  -e ALLOWED_IMAGE_HOSTS=<web-app-host> \
  hy3d-worker
```

Everything the worker writes lives under `DATA_ROOT` (default `../data`, i.e. the `data/` folder next to `web/` and
`worker/`; `/data` in Docker):

```
data/models/             Hugging Face cache (HF_HOME) + rembg weights
data/worker-jobs/        per-job outputs, purged after JOB_TTL_SECONDS
data/worker-config.json  model selection saved from the admin CMS
```

The first start downloads ~15 GB of weights for the default models. Then set in the web app:

```
HUNYUAN_WORKER_URL=https://your-worker-host:8081
HUNYUAN_WORKER_TOKEN=<same token>
```

Put the worker behind HTTPS (Caddy, Cloudflare Tunnel, or your GPU host's proxy). Scale out by running more
workers behind a load balancer with sticky routing by job id, or one worker per GPU with a dispatcher.

## Admin CMS

Admins manage the worker from the web app at `/app/admin/models` (the web app proxies to `/v1/admin/*` with the
worker token): see GPU/VRAM/disk, download or delete model weights with progress, and switch the shape, texture
and text-to-image models. A switch reloads the pipelines between jobs (queued jobs wait); if the new models fail
to load, the previous ones are restored. The selection is saved to `data/worker-config.json` and overrides the env
defaults below.

## Refinement

A job with `edit_prompt` refines an earlier result: the reference image is edited with that instruction by
InstructPix2Pix (`EDIT_MODEL`, ~2.6 GB fp16), then the model is rebuilt from the edited image with the same seed. With
`mesh_url` (the earlier GLB) the mesh is kept and only its texture is repainted. Non-English instructions (e.g.
Vietnamese) are translated to English first by `TRANSLATE_MODEL` (~300 MB, CPU). Both load on the first refinement
job and download into `data/models/` the first time. Edits of color, material and style work well; shape changes
("make the roof taller") only partly.

## Auto-rigging (CUDA hosts only)

A job with `rig_url` (a finished GLB) returns it with a predicted skeleton and skin weights, textures and scale kept.
It runs [SkinTokens/TokenRig](https://github.com/VAST-AI-Research/SkinTokens) (MIT), UniRig's successor, in its own
Python 3.11 venv through `cuda/skintokens_rig.py` (upstream's CLI pipeline without its gradio UI). It needs flash-attn,
so it only runs on NVIDIA GPUs (~14 GB free VRAM; the generation models are unloaded first when there is less).
Set it up once with `cuda/setup-skintokens.sh` (clones `../SkinTokens`, weights in `data/models/skintokens`), then
restart the worker: `/healthz` reports `"autorig": true` and the web app's rig editor offers "Auto-rig with AI". On a
Mac, `autorig` is false, `rig_url` jobs get 501 and the editor keeps its browser template rig.

## Env

| Var | Default | |
|---|---|---|
| `WORKER_TOKEN` | — | required, ≥24 chars |
| `DATA_ROOT` | `../data` | models, job outputs, admin model config |
| `SHAPE_MODEL` / `SHAPE_SUBFOLDER` | `tencent/Hunyuan3D-2` / `hunyuan3d-dit-v2-0` | full shape model (30-50 steps) |
| `TEX_SUBFOLDER` | `hunyuan3d-paint-v2-0` | full texture model |
| `ENABLE_TEX` | `1` | texture (Hunyuan3D-Paint) |
| `ENABLE_T2I` | `1` | text-to-3D via HunyuanDiT |
| `T2I_MODEL` / `T2I_STEPS` | `Tencent-Hunyuan/HunyuanDiT-v1.2-Diffusers` / `50` | full (non-distilled) text-to-image |
| `REMBG_MODEL` | `birefnet-general` | background removal: BiRefNet-general (MIT, commercial use OK) |
| `ENGINE` | `2.0` | `2.1` runs Hunyuan3D-2.1 (own venv, see `mac/setup-2.1.sh`, `mac/run-2.1.sh`, port 8082) |
| `LOAD_ON_START` | `1` | `0` = load models with the first job (the engines share `DATA_ROOT/engine.lock`) |
| `PAINT_VIEWS` / `PAINT_RESOLUTION` | `9` / `768` | 2.1 PBR paint views and view size (Mac: 6 / 512) |
| `HY21_REPO` / `REALESRGAN_CKPT` | `../Hunyuan3D-2.1` / `DATA_ROOT/models/realesrgan/RealESRGAN_x4plus.pth` | 2.1 only |
| `LOW_VRAM` | `0` | CPU offload for texture model |
| `DEVICE` | auto | `cuda` when available, else `mps`, else `cpu` |
| `SKINTOKENS_REPO` / `SKINTOKENS_PYTHON` | `../SkinTokens` / `<repo>/.venv/bin/python` | auto-rigging checkout and venv |
| `AUTORIG_TIMEOUT` | `1800` | seconds before an auto-rig job is killed |
| `ALLOWED_IMAGE_HOSTS` | empty | comma list of hosts serving input images (the web app, e.g. `localhost`); strongly recommended (SSRF) |
| `EDIT_MODEL` | `timbrooks/instruct-pix2pix` | refinement image editor |
| `TRANSLATE_MODEL` | `Helsinki-NLP/opus-mt-vi-en` | translates non-English refinement prompts |
| `MAX_QUEUE` | `50` | 503 when full |
| `JOB_TTL_SECONDS` | `10800` | finished jobs are purged after this |

Jobs live in memory: a restart loses in-flight jobs; the web app detects the 404, fails the job and refunds credits.
