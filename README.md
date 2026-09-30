# img2glb (Forma3D) — Image & Text to 3D

Upload an image or type a prompt, get a textured GLB. Next.js web app + self-hosted
[Tencent Hunyuan3D-2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) worker, with 3D/AR
preview and GLB · STL · OBJ · USDZ export.

## Layout

| Path | What |
|---|---|
| `web/` | Next.js 16 SaaS: studio, viewer, billing (VietQR), admin CMS — see [`web/README.md`](web/README.md) |
| `worker/` | GPU inference backend wrapping upstream Hunyuan3D — see [`worker/README.md`](worker/README.md) |
| `worker/map/` | Game map image → layered 3D scene (terrain, water, instanced props) — see [`worker/map/README.md`](worker/map/README.md) |
| `Hunyuan3D-2.1/` | Upstream checkout as a git submodule (pinned in `.gitmodules`) |
| `data/` | Runtime only (ignored): Postgres files, weights, inputs/outputs, worker jobs |
| `docs/adr/` | Architecture decisions (engine choice, Hunyuan3D-2.1 only) |
| `start.sh` / `shutdown.sh` | Start/stop everything locally |

## Prerequisites

- Node 20.9+, pnpm, Postgres
- Python via `uv`, Xcode command line tools (Mac) or NVIDIA GPU + CUDA toolkit + `nvcc` (Linux)
- Firebase project (Auth only) for sign-in

## Quickstart

```bash
git clone --recursive https://github.com/lualua0909/img2glb.git
cd img2glb

# 1. Worker (once). Picks CUDA on NVIDIA hosts, MPS on Apple Silicon.
#    Mac:
worker/mac/setup.sh            # Hunyuan3D-2.1 (port 8081)
worker/map/setup.sh            # optional game map pipeline (port 8083, needs the Hunyuan3D worker)
#    CUDA instead:
#    worker/cuda/setup.sh

# 2. Web
cd web
pnpm install
cp .env.example .env.local     # fill DATABASE_URL, FILE_URL_SECRET, FIREBASE_*, HUNYUAN_WORKER_*
pnpm db:migrate
cd ..

# 3. Run everything: Postgres (5433) + worker(s) + web (3000)
./start.sh
```

Without `--recursive`, init the submodules once: `git submodule update --init --recursive`.
The setup scripts do this automatically when `Hunyuan3D-2.1/.git` is missing.

## Docs

- [`docs/blender-auto-rig.md`](docs/blender-auto-rig.md) — local headless Blender Rigify, RigConfig, testing and AI roadmap
- [`web/README.md`](web/README.md) — architecture, job state machine, credits, payments, admin CMS, production checklist
- [`worker/README.md`](worker/README.md) — Docker/CUDA run, env vars, refinement, auto-rig
- [`worker/mac/README.md`](worker/mac/README.md) — Apple Silicon specifics and measured timings
- [`worker/map/README.md`](worker/map/README.md) — game map pipeline: stages, models, timings, limits
- [`docs/adr/`](docs/adr/) — why Hunyuan3D only, quality variants, why only Hunyuan3D-2.1

## License notes

Upstream models are under the Tencent Hunyuan 3D 2.1 Community License (see
`web/public/HUNYUAN3D_LICENSE.txt`): geo-block for EU/UK/KR applies, >1M MAU needs a
separate license from Tencent. App code here does not relicense upstream.
