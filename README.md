# img2glb (Forma3D) — Image & Text to 3D

Upload an image or type a prompt, get a textured GLB. Next.js web app + self-hosted
[Tencent Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) worker, with 3D/AR
preview and GLB · STL · OBJ · USDZ export.

## Layout

| Path | What |
|---|---|
| `web/` | Next.js 16 SaaS: studio, viewer, billing (VietQR), admin CMS — see [`web/README.md`](web/README.md) |
| `worker/` | GPU inference backend wrapping upstream Hunyuan3D — see [`worker/README.md`](worker/README.md) |
| `Hunyuan3D-2/`, `Hunyuan3D-2.1/` | Upstream checkouts as git submodules (pinned in `.gitmodules`) |
| `data/` | Runtime only (ignored): Postgres files, weights, inputs/outputs, worker jobs |
| `docs/adr/` | Architecture decisions (engine choice, 2.0 vs 2.1) |
| `start.sh` / `shutdown.sh` | Start/stop everything locally |

## Prerequisites

- Node 20.9+, pnpm, Postgres
- Python via `uv`, Xcode command line tools (Mac) or NVIDIA GPU + CUDA toolkit + `nvcc` (Linux)
- Firebase project (Auth only) for sign-in

## Quickstart

```bash
git clone --recursive https://github.com/lualua0909/img2glb.git
cd img2glb

# 1. Worker (once per engine). Picks CUDA on NVIDIA hosts, MPS on Apple Silicon.
#    Mac:
worker/mac/setup.sh            # Hunyuan3D-2.0
worker/mac/setup-2.1.sh        # optional second engine (port 8082)
#    CUDA instead:
#    worker/cuda/setup.sh && worker/cuda/setup-2.1.sh

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
The setup scripts do this automatically when `Hunyuan3D-2/.git` is missing.

## Docs

- [`web/README.md`](web/README.md) — architecture, job state machine, credits, payments, admin CMS, production checklist
- [`worker/README.md`](worker/README.md) — Docker/CUDA run, env vars, refinement, auto-rig
- [`worker/mac/README.md`](worker/mac/README.md) — Apple Silicon specifics and measured timings
- [`docs/adr/`](docs/adr/) — why Hunyuan3D only, quality variants, running 2.1 next to 2.0

## License notes

Upstream models are under the Tencent Hunyuan 3D Community License (see
`web/public/HUNYUAN3D_LICENSE.txt`): geo-block for EU/UK/KR applies, >1M MAU needs a
separate license from Tencent. App code here does not relicense upstream.
