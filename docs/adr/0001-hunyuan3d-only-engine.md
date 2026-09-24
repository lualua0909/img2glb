# 0001. Hunyuan3D is the only generation engine

- Status: Accepted
- Date: 2026-09-23

## Context

The app had a pluggable provider layer (`GENERATION_PROVIDER`) with five backends: `hunyuan` (self-hosted
worker), `fal` (hosted Hunyuan3D-2), `img2threejs` (procedural Three.js via a Claude Code session), `trellis`
(Microsoft TRELLIS, CUDA only) and `mock`. The extra engines were kept for A/B testing. They added env vars,
workers, start/stop branches and admin UI, and a mismatch between env and admin settings caused failed jobs.
The app is local-only and self-hosted, so the hosted `fal` backend didn't fit either.

## Decision

Hunyuan3D, run by the self-hosted worker in `worker/`, is the only engine.

- Removed: `TRELLIS/`, `img2threejs/`, `worker-trellis/`, `worker-img2threejs/`, the `fal` and `mock`
  providers, `@fal-ai/client`, and the env vars `GENERATION_PROVIDER`, `FAL_*`, `IMG2THREEJS_*`, `TRELLIS_*`.
- The provider is `hunyuan` (Hunyuan3D-2.0). `HUNYUAN_WORKER_URL` and `HUNYUAN_WORKER_TOKEN` are required.
  Hunyuan3D-2.1 was later added as a second Hunyuan engine, `hunyuan21` (see [0003](0003-hunyuan3d-2.1-side-by-side.md)).
- `start.sh` always starts the worker on `:8081`. `shutdown.sh` only stops that worker.
- The `generation.provider` column and settings field stay, with the value `hunyuan`. Jobs from removed
  providers fail instead of being polled.

## Consequences

- There is one code path for generation, refinement, preprocessing and the admin model manager.
- Development needs the worker running. There's no mock mode.
- Changing engines means a new ADR. Improvements go into `worker/` and Hunyuan3D, for example the planned
  Hunyuan3D-2.1 port.
