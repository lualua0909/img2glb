# Worker on Apple Silicon (MPS)

Runs the Hunyuan3D-2.1 worker on a Mac for the local web app. Shape and PBR texture both run on the Mac GPU (MPS),
no CUDA needed. Tested on an M4 with 32 GB, macOS 26.6.

## Setup

```bash
./mac/setup.sh
```

This creates `worker/.venv` and, against the vendored `../Hunyuan3D-2.1` (upstream commit `82920d6` with
`hunyuan3d-2.1-mps.patch` already applied; the patch file is kept as the record of local changes), builds the CPU-only `custom_rasterizer` and the mesh inpaint extension, and downloads the
Real-ESRGAN checkpoint. It skips cupy, bpy, deepspeed and gradio (not used by the worker). Needs `uv` and the Xcode
command line tools.

Weights go into the worker's Hugging Face cache, `data/models`, on the first job (~20 GB: DiT v2.1, VAE, PaintPBR,
DINOv2-giant). The admin CMS can download them ahead of time.

## Run

```bash
./mac/run.sh     # or ../start.sh
```

`run.sh` reads the token from `web/.env.local`, which needs:

```
HUNYUAN_WORKER_URL=http://localhost:8081
HUNYUAN_WORKER_TOKEN=<24+ chars>
```

On the M4 (30 steps, octree 256, 40k faces): models load in ~33 s, shape takes ~585 s, PBR texture
(6 views x 512) ~495 s, peak RSS ~18 GB. 9 views x 768 (upstream's default) does not fit in 32 GB, so `run.sh`
sets `PAINT_VIEWS=6` and `PAINT_RESOLUTION=512`.

## Notes

- `hunyuan3d-2.1-mps.patch` makes the pipelines device-agnostic: it removes hardcoded `cuda` devices, makes `bpy`
  optional, builds `custom_rasterizer` without CUDA (the renderer runs on CPU, the diffusion models on MPS) and runs
  multiview attention in query chunks off CUDA (MPS has no memory-efficient SDPA). CUDA builds behave as before.
- diffusers imports the PaintPBR UNet code from the HF snapshot, so the worker overwrites those three `.py` files
  with the patched repo copies (weights untouched).
- The worker packs the baked OBJ and PBR maps into a glTF metallic-roughness material with trimesh instead of Blender.
- The full shape model needs 30-50 steps (quality presets in `/app/admin`). Only full models are used (no turbo/fast/mini).
- `data/worker-config.json` (written by the admin CMS and on every model load) overrides `ENABLE_TEX` / `ENABLE_T2I`.
- Text-to-3D (HunyuanDiT) is untested on MPS, so `run.sh` disables it (`ENABLE_T2I=0`).
- `run.sh` points `HY3DGEN_MODELS` at the cached snapshot so hy3dshape loads it in place instead of copying it.
