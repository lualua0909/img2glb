# 0004. Hunyuan3D-2.1 is the only engine; 2.0 removed

- Status: Accepted
- Date: 2026-09-30
- Supersedes: [0003](0003-hunyuan3d-2.1-side-by-side.md)

## Context

[0003](0003-hunyuan3d-2.1-side-by-side.md) ran Hunyuan3D-2.0 and 2.1 side by side to compare them. The owner
decided to keep only Hunyuan3D-2.1 (3.3B shape DiT, PBR textures).

## Decision

- The `Hunyuan3D-2` submodule, `worker/mac/hunyuan3d-mps.patch`, the 2.0 code paths in `worker/server.py`
  (`ENGINE`, `hy3dgen`, Paint/Delight v2.0, `LOW_VRAM`, FlashVDM) and the 2.0 catalog entries are removed.
- One worker process, one venv: `worker/{mac,cuda}/setup.sh` build `worker/.venv` for Hunyuan3D-2.1 and
  `run.sh` serves it on `:8081` (`HUNYUAN_WORKER_URL`). `HUNYUAN21_WORKER_URL`, port 8082, `.venv21`,
  `run-2.1.sh` / `setup-2.1.sh`, `data/engine.lock` / `engine.want` and the "waiting for memory" stage are gone.
  Job outputs and the admin model config are back to `data/worker-jobs/` and `data/worker-config.json`.
- Web: the provider is the constant `hunyuan21` (`web/src/lib/providers`). The studio engine picker, the
  `engine` request field, the `generation.provider` admin setting and the Admin → Models engine tabs are removed.
  New jobs, retries and refinements all run on 2.1, including refinements of models made with 2.0.
  Unfinished jobs still stored as `hunyuan` fail with "Generation provider changed."
- The map worker generates its props on the 2.1 worker.
- The app ships the Tencent Hunyuan 3D 2.1 Community License (`web/public/HUNYUAN3D_LICENSE.txt`); its terms
  (territory, AUP, >1M MAU) match 2.0, so the geo-block and terms stay.

## Consequences

- Jobs are slower and need more memory than with 2.0 (see the measurements in 0003): about 20 min per textured
  model on the 32 GB M4, and CUDA hosts need ~29 GB VRAM for shape + texture.
- Every textured result has PBR materials (base color + metallic/roughness).
- Models made with 2.0 stay in the database and in `data/outputs` as history.
