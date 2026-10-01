# 0005. Multi-view references, Hunyuan3D-Omni and membrane wing sheets

- Status: Accepted
- Date: 2026-10-01
- Amends: [0004](0004-hunyuan3d-2.1-only.md) (adds Hunyuan3D-Omni next to Hunyuan3D-2.1)

## Context

Users often have more than one drawing of an asset: a concept sheet with side, front and top views. Hunyuan3D-2.1
takes one image. Its shape conditioner has a multi-view encoder class, but the 2.1 weights were trained for one
view, and the texture pipeline used only the first reference image. Hunyuan3D-2mv (2.0 family) was removed in 0004.

## Decision

A job can carry extra views (`front`, `back`, `side`, `top`) of the object in its main image
(`worker/multiview.py`). They are orthographic drawings that may be mirrored; a side view stands for both flanks.

- **Matching.** Every silhouette is compared by IoU after cropping to its bounding box. The object's heading is
  searched with silhouettes stretched square (so wrong proportions don't hide it), each view's mirror/rotation is
  picked, then a per-axis scale (along the heading and sideways, +-30%) is fitted. A scale that makes any view more
  than 0.02 worse is refused: views drawn in different poses (wings raised in the side view, spread in the top
  view) would otherwise stretch the model. Headings h and h + 180 give identical silhouettes; the texture stage
  picks one by comparing projected view colors with the painted texture.
- **Shape candidates.** `shape_candidates` (1-4) Hunyuan3D-2.1 shapes with seeds `seed + i` are decoded at octree
  128, scored by mean silhouette IoU, and only the best is decoded at full resolution.
- **Hunyuan3D-Omni.** With `omni`, the views' visual hull (64^3, each mask placed on the 2.1 shape's silhouette of
  its camera, dilated 3%) is given to Hunyuan3D-Omni as its voxel condition, with the main image. The Omni and 2.1
  shapes are scored the same way and the better one is kept. Omni is vendored as `Hunyuan3D-Omni/` (package renamed
  `hy3domni` to sit next to 2.1's `hy3dshape`; changes in `worker/hunyuan3d-omni.patch`) and its EMA weights
  (~13.5 GB) download and load on the first job that asks for it.
- **Texture.** After Hunyuan3D-Paint, each view (and the main image) is placed on the mesh silhouette of its camera
  and back-projected into the UV atlas, weighted by cos^4 of the viewing angle and the view's eroded alpha; the
  painted texture keeps a weight of 0.15 everywhere so it shows where no view faces. Cameras whose silhouette IoU
  is below 0.5 are skipped. With `paint_all_views`, the views are also passed to the multiview diffusion as extra
  reference images (the UNet's reference attention takes N references; upstream passed only the first. This is out
  of its training distribution, so it is opt-in).
- **Wing sheets** (`wing_sheets`, `worker/wings.py`, works without extra views). Membranes are found as connected
  regions where the surface has an opposite-facing surface within 1.5% of the bounding box diagonal, off the
  symmetry plane (12% of the half span), 3-45% of the surface, spanning >= 25% of the diagonal and flat (third
  principal spread <= 0.2 of the first). Each is replaced by its surface facing the best main/side/top camera,
  textured by projecting that view (alpha MASK, double-sided), unless the drawing covers less than 85% of it; then
  the generated membrane stays. The GLB then has the body plus one primitive per sheet.

The web app stores the views and options in `generation.multiview` (jsonb), uploads views as `view_<name>` form
files, preprocesses each one like the main image, and charges one shape per extra candidate and for Omni.

## Consequences

- Each candidate and the Omni shape cost a full shape generation (~10 min each on the M4). Omni keeps ~6.6 GB more
  in memory once loaded.
- Views must show the same pose straight on; a view that disagrees only loses its weight (scale refused, projection
  skipped), it does not break the job.
- Projected colors include the drawing's shading.
- Hunyuan3D-Omni ships under the Tencent Hunyuan 3D Omni Community License (`web/public/HUNYUAN3D_OMNI_LICENSE.txt`,
  linked in the footer), with the same territory, AUP and MAU terms as 2.1.
