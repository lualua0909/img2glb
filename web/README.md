# Forma3D — Image & Text to 3D SaaS

A Next.js 16 + Tailwind v4 SaaS on top of [Tencent Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2).
Users upload an image or type a prompt, get a textured GLB, preview it in 3D/AR and export GLB · STL · OBJ · USDZ.

## Architecture

```
Browser ──► Next.js (Vercel / Docker)
             ├─ Firebase Auth (email+password, Google)    ─► Postgres (Drizzle)
             ├─ /api/generations  create → debit credits  ─► data/outputs (inputs, models)
             │   GET /:id  poll → advance job (leased)    ─► Hunyuan3D worker (self-hosted GPU, ../worker)
             ├─ /api/cron/sweep   advances orphaned jobs
             └─ VietQR bank transfer (admin confirms)
```

- **Job state machine**: `queued → processing → succeeded | failed`. Each client poll (and the cron) advances a
  job one step under a 90s DB lease, so concurrent pollers never double-process. Jobs time out after
  `JOB_TIMEOUT_MINUTES`.
- **Credits**: atomic debit (`credits >= cost` guard) in the same transaction as job insert; refunds are
  idempotent (unique index per generation). Purchase grants are idempotent per payment order.
- **Auth**: the browser signs in with the Firebase JS SDK (in-memory, nothing persisted), then posts the ID token to
  `/api/auth/session`, which requires a verified email, upserts the `user` row (id = Firebase uid) and sets an
  httpOnly `__session` cookie (Firebase session cookie, 14 days). Verification and password-reset emails are sent by
  Firebase.
- **Payments**: picking a pack creates a `payment_order` with a unique transfer code (`F3D…`) and shows a VietQR code
  (amount + code pre-filled). An admin matches the code on the bank statement and confirms it in **Admin → Payments**,
  which adds the credits.
- **Text → 3D**: text → concept image (HunyuanDiT on the worker, as the upstream repo does) → image → 3D. The concept image is saved as the thumbnail.
- **Refine**: `POST /api/generations/:id/refine {prompt, strength, keepShape}` creates a new version of a finished
  model. The worker edits the reference image with the instruction (InstructPix2Pix;
  Vietnamese is translated to English first) and rebuilds the model with the same seed, or with `keepShape` only
  repaints the texture on the existing mesh. Versions share `root_id`; `GET /api/generations/:id/versions` lists them.
- **Rig & animate** (only when the user opens it; models stay static by default): runs in the browser
  (`src/lib/rig`). The user picks a type (person, four-legged animal, bird, fish, vehicle, aircraft, plant,
  water/smoke, object), drags the guessed joint markers (Mixamo-style, mirrored left/right), and the model is
  skinned (bone heat diffusion with visibility for characters, chains for fish/plants, rigid parts for wheels).
  Procedural clips cover movements 01–12 (translate, rotate, scale, walk/run, vehicle, jump/fall, fly, swim,
  sway/bend, physics, interaction, environmental). The rigged GLB with the chosen clips is saved as a new version
  (`POST /api/generations/:id/rig`, multipart `model` + `meta`); no credits, no worker.
- **Viewer**: three.js inspector with texture / clay / wireframe / normals / UV checker / rig (skeleton) modes,
  animation playback in every mode (clicking the model plays its `Interact_*` clip), lighting and camera presets,
  mesh stats, PNG screenshots and fullscreen.
- **Exports**: GLB is stored; STL/OBJ/USDZ are converted in the browser with three.js exporters (no server cost).

## Admin CMS (`/app/admin`)

Accounts listed in `ADMIN_EMAILS` get an **Admin** tab (everyone else gets a 404):

- **Settings** — stored in the `app_setting` table and applied at runtime (≤5s cache), overriding the env/`config.ts`
  defaults: pause generation (maintenance message), guidance scale, per-quality diffusion steps + octree resolution, per-use-case face count, credit costs,
  sign-up bonus, concurrent-job limit, job timeout. Secrets (keys, URLs, tokens) stay in env.
- **Payments** — pending VietQR bank-transfer orders: confirm (adds credits) or cancel.
- **Models** — talks to the GPU worker's admin API through `/api/admin/worker/*` (token stays server-side): GPU/VRAM/
  disk status, download/delete Hunyuan3D-2 weights (shape, VAE, paint/delight, HunyuanDiT, or any HF repo) with
  progress, and switch the active models with a hot reload. Needs `HUNYUAN_WORKER_URL` + `HUNYUAN_WORKER_TOKEN`.

Admin accounts need a verified email (sign-in already requires one).

## Data folder

Downloaded weights and generated outputs live in `data/`, next to `web/` and `worker/`:

```
data/outputs/    inputs/<user>/<id>.png, models/<user>/<id>.glb (served via signed /api/files URLs)
data/models/     worker: Hugging Face cache (diffusion weights) + rembg
data/worker-jobs/ worker: per-job scratch, TTL-purged
```

In Docker, mount the folder: `-v "$PWD/../data:/data"` (the web container resolves `../data` to `/data`).

## Modes: `APP_ENV=local` vs `APP_ENV=prod`

| | `local` (personal use) | `prod` (public SaaS, default) |
|---|---|---|
| Credits, costs, balance | off / hidden | on |
| Concurrent-job limit | off | `MAX_ACTIVE_JOBS_PER_USER` |
| Billing page, VietQR orders | 404 / hidden | on (when `VIETQR_*` set) |
| Landing page `/` | redirects to `/app` | marketing + pricing |
| EU/UK/KR geo-block | off | on |
| `CRON_SECRET` | optional | required |

Auth stays on in both modes.

## Local development

Requires Node 20.9+, pnpm and Postgres. Files are stored in `data/outputs`.

```bash
pnpm install
cp .env.example .env.local        # fill DATABASE_URL, FILE_URL_SECRET, FIREBASE_* / NEXT_PUBLIC_FIREBASE_*, HUNYUAN_WORKER_*
pnpm db:migrate
pnpm dev
```

Generation needs the Hunyuan3D worker running (`../start.sh` starts it, on CUDA when the machine has an NVIDIA GPU, else on Apple Silicon: see `../worker/README.md`). Sign-in needs a Firebase project (Auth only).

## Production checklist

1. **Postgres** (Neon, Supabase, RDS). Run `pnpm db:migrate` (or the `migrate` Docker target) on deploy.
2. **Storage**: back up `data/outputs` (uploaded inputs + generated models).
3. **Hunyuan3D worker**: deploy `../worker` on a GPU (≥16 GB VRAM), set `HUNYUAN_WORKER_URL` + `HUNYUAN_WORKER_TOKEN`.
4. **Auth (Firebase)**: create a project, enable the Email/Password (and optionally Google) providers, add your
   domain under Authentication → Settings → Authorized domains. Web app config → `NEXT_PUBLIC_FIREBASE_*`; a service
   account key → `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`. `NEXT_PUBLIC_*` values are
   baked in at build time. `FILE_URL_SECRET` (`openssl rand -base64 32`) signs file URLs.
5. **Payments (VietQR)**: `VIETQR_BANK_ID` (BIN or short name from https://api.vietqr.io/v2/banks),
   `VIETQR_ACCOUNT_NO`, `VIETQR_ACCOUNT_NAME`. Confirm incoming transfers in Admin → Payments. Packs and VND prices
   live in `src/lib/config.ts`.
6. **Cron**: `CRON_SECRET`. `vercel.json` calls `/api/cron/sweep` every minute (per-minute crons need Vercel Pro;
   elsewhere, any scheduler: `curl -H "Authorization: Bearer $CRON_SECRET" https://.../api/cron/sweep`).
7. **Geo**: requests from EU/UK/KR are blocked in `src/proxy.ts` using `x-vercel-ip-country` / `cf-ipcountry`.
   If you're not behind Vercel or Cloudflare, have your edge set `x-country-code`.
8. **Legal**: set `NEXT_PUBLIC_OPERATOR_NAME`; have counsel review `/terms` and `/privacy` (templates).

Deploy: Vercel (zero config), or `docker build -t forma3d .` → `docker run -p 3000:3000 --env-file .env forma3d`.

## Hunyuan3D license (Tencent Hunyuan 3D 2.0 Community License) — what this app already handles

| Obligation | Where |
|---|---|
| Not licensed in EU, UK, South Korea (§1.l, §5.c) | `src/proxy.ts` geo-block, `/unavailable`, Terms §2 |
| Give users a copy of the license (§3.a) | `/HUNYUAN3D_LICENSE.txt`, linked in footer |
| Notice on modified files (§3.b) | `../worker/server.py` header |
| Disclose operator, state Tencent is not affiliated (§3.e) | footer, Terms §1 |
| Pass on AUP + "no training other models" restrictions (§5.a–b) | Terms §3 |
| >1M MAU needs a separate license from Tencent (§4) | business decision — email hunyuan3d@tencent.com |

## Scripts

`pnpm dev` · `pnpm build` · `pnpm lint` · `pnpm typecheck` · `pnpm db:generate` · `pnpm db:migrate`

## Next steps worth doing

- Prompt/image moderation (e.g. an LLM or vision safety classifier) before submitting jobs — AUP compliance.
- Error monitoring (Sentry) and product analytics.
- Public share links / embeddable viewer, API keys for developers, subscriptions.
- Multi-view input (Hunyuan3D-2mv) for higher-fidelity scans.
