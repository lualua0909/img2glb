# 0003. Run Hunyuan3D-2.1 next to 2.0, picked per job

- Status: Accepted
- Date: 2026-09-23

## Context

Hunyuan3D-2.1 is the newest release: a 3.3B shape DiT and a PBR texture model (albedo + metallic/roughness).
The owner wants to compare its speed and quality with 2.0 on the same machine (Apple M4, 32 GB, MPS) before
choosing one. Upstream 2.1 targets CUDA. It hardcodes `cuda` devices, needs a CUDA rasterizer, exports GLB
through Blender (`bpy`), and pins older libraries (diffusers 0.30, transformers 4.46) than the 2.0 worker
(0.40 / 5.17).

## Decision

- **One worker codebase, two processes.** `worker/server.py` takes `ENGINE=2.0|2.1`. The 2.1 process runs
  from its own venv (`worker/.venv21`, `mac/setup-2.1.sh`) on `:8082`. It shares the job, admin, preprocess
  and refine API, and keeps its own job dir and model config (`worker-jobs-2.1/`, `worker-config-2.1.json`).
- **MPS port** (`worker/mac/hunyuan3d-2.1-mps.patch`):
  - The rasterizer builds as a CPU-only kernel (the same approach as 2.0).
  - Hardcoded CUDA devices are removed, and `bpy` is optional.
  - Multiview attention runs in query chunks off CUDA. MPS has no memory-efficient SDPA and would
    allocate a single 21 GiB buffer. The result is identical.
  - The worker packs the baked OBJ and PBR maps into a glTF metallic-roughness material with trimesh,
    instead of using Blender.
  - diffusers imports the UNet code from the HF snapshot, so the worker overwrites those three `.py` files
    (symlinks) with the patched repo copies. The weight blobs are not touched.
- **Shared memory.** Both models don't fit in 32 GB together. `data/engine.lock` lets only one engine keep
  its models in memory. A worker with a job writes `data/engine.want` and blocks. The holder unloads once
  its queue is empty. The job shows "Waiting for memory (other engine)" and records the wait.
- **Per-job choice.** The web app gets `HUNYUAN21_WORKER_URL` (same token). The studio shows a
  2.0 / 2.1 picker, and the job stores its engine in `generation.provider` (`hunyuan` / `hunyuan21`).
  A refinement uses its parent's engine. Admin → Models has one tab per engine.
- **Measurements.** Each job reports seconds per stage (wait, load, shape, texture, total) and peak memory.
  These are stored in `generation.stats` (migration 0007) and shown on the model page.
- **Defaults.** Each engine uses its upstream guidance (2.0: 5.0, 2.1: 7.5). PBR paint defaults to
  upstream's maximum on CUDA (9 views × 768 px). On the Mac, `run-2.1.sh` uses 6 × 512: at 9 × 768 the model
  took about 20 GB of GPU memory and the machine swapped for 20+ minutes without finishing.

## Measured on the M4 (2026-09-23, image 052.png, 30 steps, octree 256, 40k faces, textured)

| | Hunyuan3D 2.0 | Hunyuan3D 2.1 |
|---|---|---|
| Load models | 37 s | 33 s |
| Shape | 398 s | 584 s |
| Texture | 272 s (RGB) | 495 s (PBR, 6 views × 512) |
| Total | 12.0 min | 20.2 min |
| Peak RSS | 15.4 GB | 17.6 GB |
| Output | 40k faces, base color 2048² | 40k faces, base color + metallic/roughness 2048² |

With 50 steps and octree 380 (the High preset), 2.1 shape alone is about 10 min of diffusion plus about
12 min of volume decoding. Job timeout is 120 min (`JOB_TIMEOUT_MINUTES`, admin setting).

## Consequences

- There are two venvs and two worker processes, about 15 GB of extra weights (2.1 DiT, VAE, PaintPBR),
  DINOv2-giant (4.5 GB) and Real-ESRGAN.
- Switching engines costs one model load (about 35 s) plus the other engine finishing its queue.
- After the comparison, one engine should be retired. That decision gets a new ADR superseding this one.
