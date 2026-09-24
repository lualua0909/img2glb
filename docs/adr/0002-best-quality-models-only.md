# 0002. Use only the highest-quality model variants

- Status: Accepted
- Date: 2026-09-23

## Context

The worker used to default to step- or guidance-distilled variants (`*-turbo`, `*-fast`, `*-mini`,
`HunyuanDiT-*-Distilled`) and `u2net` for background removal. They're faster but give worse results. The admin
catalog offered all of them, so a weaker model could be picked by mistake.

## Decision

Every stage uses the strongest available model. Don't switch to a faster or smaller variant unless the owner
asks for it explicitly.

| Stage | Model | Notes |
|---|---|---|
| Shape | `tencent/Hunyuan3D-2` / `hunyuan3d-dit-v2-0` | full DiT with its own VAE, 30–50 steps (quality presets) |
| Texture | `tencent/Hunyuan3D-2` / `hunyuan3d-paint-v2-0` | full Paint model |
| Delight | `tencent/Hunyuan3D-2` / `hunyuan3d-delight-v2-0` | required by Paint |
| Text → image | `Tencent-Hunyuan/HunyuanDiT-v1.2-Diffusers` | full (non-distilled), `T2I_STEPS=50`. Off on MPS until tested |
| Background removal | rembg `birefnet-general` (BiRefNet, MIT) | `REMBG_MODEL`. Picked over RMBG-2.0 (CC BY-NC), BEN2, BiRefNet-massive and IS-Net in the 2026-09-23 benchmark below |
| Refine: image edit | `timbrooks/instruct-pix2pix` | stronger editors (e.g. Qwen-Image-Edit, 20B) don't fit 32 GB next to Hunyuan |
| Refine: translation | `Helsinki-NLP/opus-mt-vi-en` | VI → EN for the edit prompt |
| 2.1 shape | `tencent/Hunyuan3D-2.1` / `hunyuan3d-dit-v2-1` + `hunyuan3d-vae-v2-1` | 3.3B, see [0003](0003-hunyuan3d-2.1-side-by-side.md) |
| 2.1 texture | `tencent/Hunyuan3D-2.1` / `hunyuan3d-paintpbr-v2-1` + DINOv2-giant + Real-ESRGAN x4plus | PBR. 9 views × 768 px on CUDA; on the 32 GB Mac 6 × 512 (9 × 768 swaps) |

- The worker's `CATALOG` lists only the full models. Turbo, fast and mini variants were removed from the
  catalog, and their weights were removed from `data/models`.
- Admin → Models shows a "Running pipeline" card with every model in use, read from `/v1/admin/status`
  (`pipeline`).

## Consequences

- Jobs are slower than with the turbo models (shape took about 25 s on the M4 with MPS). Job timeouts and quality
  presets are sized for the full models.
- Hunyuan3D-2.1 now runs next to 2.0 for comparison ([0003](0003-hunyuan3d-2.1-side-by-side.md)).
- Check licenses before commercial use: every auxiliary model must allow commercial use. Hunyuan3D has
  its own Tencent license with territory limits.

## Background removal benchmark (2026-09-23, M4 CPU/CoreML via onnxruntime, 6 photos, 1024 px)

| Model | License | Time per image | Result |
|---|---|---|---|
| BRIA RMBG-2.0 | CC BY-NC 4.0 | 8.0 s | good, but kept the chillies next to the shoes. Not allowed commercially |
| **BiRefNet-general** | MIT | 7.3 s | best: kept the cat's whiskers, solid white chair seat, clean shoes |
| BiRefNet-massive | MIT | 6.1 s | background (a red pole) leaked into the cat photo |
| BEN2 base | MIT | 5.4 s | white chair seat turned semi-transparent, cut off whiskers |
| IS-Net general | Apache-2.0 | 0.7 s | cut into objects and left background patches |

`withoutbg` in rembg calls a cloud API, so it was not considered (the app is local-only).
