"""
Extra reference views (front / back / side / top) of the object in the main image: used to pick the best shape among
candidates, fix its proportions, build a visual hull (the Hunyuan3D-Omni voxel condition) and project the views'
colors onto the painted texture.

Frames. Meshes are in the shape model's frame: Y up, the main image is the view from +Z (image right = +X). A camera
is (elev, azim) as in Hunyuan3D-Paint's MeshRender: elev 0, azim a looks from (sin a, 0, cos a) with image right
(cos a, 0, -sin a) and up +Y; elev 90 looks down with image up -(sin a, 0, cos a). The object faces `heading`: the
azim of the camera that sees its front. Concept views are orthographic and may be mirrored (a side view shows either
flank, a top view may have the head up or down), so each view is matched with the image transforms it allows.
"""
import logging
from dataclasses import dataclass, field

import cv2
import numpy as np
import trimesh
from PIL import Image

log = logging.getLogger("worker")

VIEW_NAMES = ("front", "back", "side", "top")
# Image transforms each view may need to line up with its camera (see `transform`).
OPTIONS = {"main": ("id",), "front": ("id", "flip"), "back": ("id", "flip"), "side": ("id", "flip"),
           "top": ("id", "flip", "rot180", "flip_rot180")}
NORM = 128  # side of the normalized silhouettes compared by IoU


@dataclass
class View:
    name: str  # "main" or one of VIEW_NAMES
    image: Image.Image  # RGBA, cropped to the object
    mask: np.ndarray = field(init=False)  # bool, same size as image

    def __post_init__(self):
        self.mask = np.asarray(self.image.getchannel("A")) > 127


def cut_out(image: Image.Image, min_part: float = 0.1) -> Image.Image:
    """An RGBA view cropped to its object. Drops detached bits smaller than `min_part` of the largest part (pieces of
    neighbouring drawings when the view was cut from a concept sheet)."""
    rgba = image.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A")).copy()
    n, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > 127).astype(np.uint8), connectivity=8)
    if n <= 1:
        raise ValueError("no object found in the view")
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = 1 + np.flatnonzero(areas >= min_part * areas.max())
    # Soft edges belong to the part they touch: grow the kept parts a little before cutting.
    kept = cv2.dilate(np.isin(labels, keep).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    alpha[~kept] = 0
    rgba.putalpha(Image.fromarray(alpha))
    return rgba.crop(Image.fromarray((alpha > 127).astype(np.uint8) * 255).getbbox())


def transform(a: np.ndarray, option: str) -> np.ndarray:
    """Apply an image transform (rows x cols [x channels]) from OPTIONS."""
    if "flip" in option:
        a = a[:, ::-1]
    if "rot180" in option:
        a = a[::-1, ::-1]
    return np.ascontiguousarray(a)


def camera(elev: float, azim: float) -> tuple[np.ndarray, np.ndarray]:
    """Image right and up vectors of an orthographic camera (MeshRender convention, see module docstring)."""
    a = np.radians(azim)
    right = np.array([np.cos(a), 0.0, -np.sin(a)])
    toward = np.array([np.sin(a), 0.0, np.cos(a)])  # from the object to the camera, horizontally
    if elev == 0:
        return right, np.array([0.0, 1.0, 0.0])
    return right, (-toward if elev > 0 else toward)


def view_cameras(name: str, heading: float) -> list[tuple[float, float, bool]]:
    """(elev, azim, mirrored) cameras a view is seen from. A side view also stands for the other flank, mirrored."""
    if name == "main":
        return [(0, 0, False)]
    if name == "front":
        return [(0, heading, False)]
    if name == "back":
        return [(0, heading + 180, False)]
    if name == "side":
        return [(0, heading + 90, False), (0, heading - 90, True)]
    return [(90, heading + 180, False)]  # top: head towards image up


def rasterize(verts: np.ndarray, faces: np.ndarray, right: np.ndarray, up: np.ndarray, res: int = 256):
    """Orthographic silhouette, fitted into res x res. Returns (mask, (u0, v0, scale)) with pixel = (u - u0) * scale."""
    u, v = verts @ right, verts @ up
    u0, v0 = u.min(), v.max()
    scale = (res - 1) / max(np.ptp(u), np.ptp(v), 1e-9)
    px = np.stack([(u - u0) * scale, (v0 - v) * scale], 1)
    canvas = np.zeros((res, res), np.uint8)
    cv2.fillPoly(canvas, np.round(px[faces] * 4).astype(np.int32), 1, lineType=cv2.LINE_8, shift=2)
    return canvas > 0, (u0, v0, scale)


def normalize(mask: np.ndarray, n: int = NORM, stretch: bool = False) -> np.ndarray:
    """Crop a mask to its bounding box and pad it square (aspect kept) or stretch it square, n x n."""
    ys, xs = np.nonzero(mask)
    if not len(ys):
        return np.zeros((n, n), bool)
    m = mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    if stretch:
        return cv2.resize(m.astype(np.uint8) * 255, (n, n), interpolation=cv2.INTER_AREA) > 127
    h, w = m.shape
    side = max(h, w)
    out = np.zeros((side, side), np.uint8)
    out[(side - h) // 2 : (side - h) // 2 + h, (side - w) // 2 : (side - w) // 2 + w] = m * 255
    return cv2.resize(out, (n, n), interpolation=cv2.INTER_AREA) > 127


def iou(a: np.ndarray, b: np.ndarray) -> float:
    return float((a & b).sum() / max((a | b).sum(), 1))


@dataclass
class Fit:
    """How a mesh lines up with the views: heading, per-view image transform and silhouette IoU, and the per-axis
    scale (along the heading, up, sideways) that matches the views' proportions best."""

    heading: float
    options: dict
    ious: dict
    scale: tuple = (1.0, 1.0, 1.0)

    @property
    def score(self) -> float:
        return float(np.mean(list(self.ious.values())))

    def matrix(self) -> np.ndarray:
        """4x4 transform applying `scale` in the object's frame."""
        a = np.radians(self.heading)
        h, lat = np.array([np.sin(a), 0, np.cos(a)]), np.array([np.cos(a), 0, -np.sin(a)])
        basis = np.stack([h, [0, 1, 0], lat], 1)  # columns: heading, up, sideways
        m = np.eye(4)
        m[:3, :3] = basis @ np.diag(self.scale) @ basis.T
        return m


class Matcher:
    """Silhouette matching of one mesh against the views (normalized masks are cached per view and transform)."""

    def __init__(self, views: list[View], max_faces: int = 8000):
        self.views = views
        # Aspect kept (proportions count) and stretched square (shape only, for the heading search).
        self.targets = {
            (v.name, o, st): normalize(transform(v.mask, o), stretch=st)
            for v in views for o in OPTIONS[v.name] for st in (False, True)
        }
        self.max_faces = max_faces

    def _mesh(self, mesh: trimesh.Trimesh):
        if len(mesh.faces) > self.max_faces:  # silhouettes only: a simplified mesh is enough and much faster
            mesh = mesh.simplify_quadric_decimation(face_count=self.max_faces)
        return np.asarray(mesh.vertices, np.float64), mesh.faces

    def view_iou(self, verts, faces, view: View, heading: float, options=None, stretch=False) -> tuple[float, str]:
        """Best IoU of a view's first camera over its allowed transforms (or the given ones)."""
        best, best_o = -1.0, None
        e, a, _ = view_cameras(view.name, heading)[0]
        render = normalize(rasterize(verts, faces, *camera(e, a))[0], stretch=stretch)
        for o in options or OPTIONS[view.name]:
            s = iou(render, self.targets[(view.name, o, stretch)])
            if s > best:
                best, best_o = s, o
        return best, best_o

    def fit(self, mesh: trimesh.Trimesh, step: float = 5) -> Fit:
        """Heading by a coarse-to-fine search, then the per-axis scale. Headings h and h + 180 match equally (the
        silhouettes are mirror images and every view may be mirrored): `resolve_heading` picks one by color."""
        verts, faces = self._mesh(mesh)
        aux = [v for v in self.views if v.name != "main"]

        def total(h):  # stretched: a mesh with wrong proportions still finds its heading
            return sum(self.view_iou(verts, faces, v, h, stretch=True)[0] for v in aux)

        if aux:
            coarse = np.arange(0, 180, step)  # h and h + 180 are equivalent
            h = max(coarse, key=total)
            fine = np.arange(h - step + 1, h + step, 1.0)
            heading = float(max(fine, key=total)) % 360
        else:
            heading = 0.0
        options = {v.name: self.view_iou(verts, faces, v, heading, stretch=True)[1] for v in self.views}
        ious = {v.name: self.view_iou(verts, faces, v, heading, (options[v.name],))[0] for v in self.views}
        fit = Fit(heading, options, ious)
        self._fit_scale(verts, faces, fit)
        return fit

    def _fit_scale(self, verts, faces, fit: Fit, span: float = 0.3, n: int = 13, slack: float = 0.02):
        """Per-axis scale (along the heading and sideways; up stays 1) maximizing the summed IoU over a grid of
        +-30%. A scale must not make any view more than `slack` worse: views drawn in different poses (wings spread
        in the top view, raised in the side view) pull the proportions apart, and that is not a proportion error."""
        if len(self.views) < 2:
            return

        def ious(s):
            fit.scale = s
            v = verts @ fit.matrix()[:3, :3].T
            return np.array([self.view_iou(v, faces, view, fit.heading, (fit.options[view.name],))[0]
                             for view in self.views])

        base = ious((1.0, 1.0, 1.0))
        grid = np.exp(np.linspace(-span, span, n))
        best, best_s = base, (1.0, 1.0, 1.0)
        for sh in grid:
            for sl in grid:
                cur = ious((float(sh), 1.0, float(sl)))
                if cur.sum() > best.sum() and (cur >= base - slack).all():
                    best, best_s = cur, (float(sh), 1.0, float(sl))
        gain = (best.sum() - base.sum()) / len(self.views)
        fit.scale = best_s if gain > 0.01 else (1.0, 1.0, 1.0)
        if fit.scale != (1.0, 1.0, 1.0):
            fit.ious = {view.name: float(x) for view, x in zip(self.views, best)}
        log.info("multiview: heading %.0f°, scale %s (mean IoU +%.3f), IoU %s", fit.heading,
                 tuple(round(s, 2) for s in fit.scale), max(gain, 0), {k: round(x, 3) for k, x in fit.ious.items()})


def apply_scale(mesh: trimesh.Trimesh, fit: Fit) -> trimesh.Trimesh:
    if fit.scale != (1.0, 1.0, 1.0):
        mesh.apply_transform(fit.matrix())
    return mesh


def flipped(fit: Fit) -> Fit:
    """The equivalent fit with the heading turned 180°: every non-top view's mirror flips, the top view turns."""
    swap = {"id": "flip", "flip": "id", "rot180": "flip_rot180", "flip_rot180": "rot180"}
    turn = {"id": "rot180", "rot180": "id", "flip": "flip_rot180", "flip_rot180": "flip"}
    options = {k: (o if k == "main" else turn[o] if k == "top" else swap[o]) for k, o in fit.options.items()}
    return Fit((fit.heading + 180) % 360, options, dict(fit.ious), fit.scale)


def placed_mask(view: View, fit: Fit, verts: np.ndarray, faces: np.ndarray, elev, azim, mirrored, res: int):
    """The view's mask and RGBA, transformed and scaled so its bounding box lands on the mesh silhouette's bounding box
    in a res x res render of camera (elev, azim) fitted like `rasterize`. Returns (rgba, render mask, (u0, v0, scale))."""
    sil, frame = rasterize(verts, faces, *camera(elev, azim), res)
    option = fit.options[view.name]
    rgba = transform(np.asarray(view.image), option)
    if mirrored:
        rgba = rgba[:, ::-1]
    return warp_to_bbox(rgba, sil), sil, frame


def warp_to_bbox(rgba: np.ndarray, sil: np.ndarray) -> np.ndarray:
    """Resize an RGBA image (cropped to its object) onto the bounding box of a silhouette, in a canvas of its size."""
    ys, xs = np.nonzero(sil)
    out = np.zeros(sil.shape + (4,), np.uint8)
    if not len(ys):
        return out
    y0, x0, y1, x1 = ys.min(), xs.min(), ys.max() + 1, xs.max() + 1
    out[y0:y1, x0:x1] = cv2.resize(rgba, (x1 - x0, y1 - y0), interpolation=cv2.INTER_AREA)
    return out


def visual_hull(mesh: trimesh.Trimesh, views: list[View], fit: Fit, res: int = 64, tolerance: float = 0.03):
    """Occupancy grid (res^3 over the mesh's padded bounds) of points whose projection falls inside every view's mask,
    each mask placed on the mesh's silhouette bounding box for its camera (so the mesh fixes position and size, the
    views the shape). Masks are dilated by `tolerance` of their size to forgive small misalignments.
    Returns (occupancy, grid points (res^3 x 3))."""
    verts, faces = np.asarray(mesh.vertices, np.float64), mesh.faces
    lo, hi = mesh.bounds
    pad = 0.05 * (hi - lo).max()
    axes = [np.linspace(lo[i] - pad, hi[i] + pad, res) for i in range(3)]
    pts = np.stack(np.meshgrid(*axes, indexing="ij"), -1).reshape(-1, 3)
    occ = np.ones(len(pts), bool)
    r = 512
    for view in views:
        for elev, azim, mirrored in view_cameras(view.name, fit.heading):
            rgba, sil, (u0, v0, scale) = placed_mask(view, fit, verts, faces, elev, azim, mirrored, r)
            mask = (rgba[..., 3] > 127).astype(np.uint8)
            k = max(3, int(tolerance * r) | 1)
            mask = cv2.dilate(mask, np.ones((k, k), np.uint8)) > 0
            right, up = camera(elev, azim)
            px = np.round((pts @ right - u0) * scale).astype(int)
            py = np.round((v0 - pts @ up) * scale).astype(int)
            inside = (px >= 0) & (px < r) & (py >= 0) & (py < r)
            hit = np.zeros(len(pts), bool)
            hit[inside] = mask[py[inside], px[inside]]
            occ &= hit
    return occ.reshape(res, res, res), pts.reshape(res, res, res, 3)


def hull_points(occ: np.ndarray, pts: np.ndarray, n: int = 81920) -> np.ndarray:
    """Surface points of a hull (occupied cells with an empty 6-neighbour), with jitter inside their cell, n x 3."""
    padded = np.pad(occ, 1)
    interior = occ.copy()
    for ax in range(3):
        for d in (-1, 1):
            interior &= np.roll(padded, d, ax)[1:-1, 1:-1, 1:-1]
    surface = pts[occ & ~interior]
    if not len(surface):
        raise ValueError("the views leave an empty visual hull")
    cell = (pts[1, 1, 1] - pts[0, 0, 0])
    rng = np.random.default_rng(0)
    idx = rng.integers(0, len(surface), n)
    return surface[idx] + (rng.random((n, 3)) - 0.5) * cell


def omni_normalize(points: np.ndarray, scale: float = 0.9999) -> tuple[np.ndarray, np.ndarray, float]:
    """Center points on their bounding box and fit the longest side to [-scale, scale] (Hunyuan3D-Omni's input
    normalization). Returns (points, center, factor) so results map back with p / factor + center."""
    lo, hi = points.min(0), points.max(0)
    center = (lo + hi) / 2
    factor = 2 * scale / (hi - lo).max()
    return (points - center) * factor, center, factor


def _base_texture(render):
    import torch

    base = render.tex if isinstance(render.tex, torch.Tensor) else torch.as_tensor(np.asarray(render.tex))
    base = base.float()
    return base / 255.0 if base.max() > 1.5 else base


def back_projections(render, views: list[View], fit: Fit, exp: float = 4, min_iou: float = 0.5) -> list[tuple]:
    """Each view placed on the mesh silhouette of each of its cameras and back-projected to UV space:
    [(label, texture (H, W, 3), weight (H, W, 1))], weight = cos^exp of the viewing angle x the view's eroded alpha.
    Cameras whose silhouette disagrees with the mesh (IoU < min_iou, e.g. a view drawn in another pose) are skipped."""
    import torch

    res = render.default_resolution[0]
    out = []
    for view in views:
        for elev, azim, mirrored in view_cameras(view.name, fit.heading):
            label = f"{view.name}@{int(elev)}/{int(azim) % 360}"
            sil = render.render_alpha(elev, azim, return_type="np").squeeze() > 0
            rgba = transform(np.asarray(view.image), fit.options[view.name])
            if mirrored:
                rgba = rgba[:, ::-1]
            placed = warp_to_bbox(np.ascontiguousarray(rgba), sil)
            vmask = placed[..., 3] > 127
            agreement = iou(vmask, sil)
            if agreement < min_iou:
                log.info("multiview: %s skipped, silhouette IoU %.2f", label, agreement)
                continue
            # Edges of a drawing (outlines, anti-aliasing) and of the mesh silhouette are unreliable: erode both.
            k = max(3, res // 128) | 1
            trust = cv2.erode((vmask & sil).astype(np.uint8), np.ones((k, k), np.uint8)).astype(np.float32)
            rgb = placed[..., :3].astype(np.float32) / 255.0
            tex, cos, _ = render.back_project(torch.from_numpy(rgb), elev, azim)
            tex_trust, _, _ = render.back_project(torch.from_numpy(trust[..., None]), elev, azim)
            out.append((label, tex[..., :3], (cos**exp) * tex_trust[..., :1]))
    return out


def color_error(render, projections: list[tuple]) -> float:
    """Mean RGB distance between the projected views and the painted texture, over texels a view faces well."""
    base = _base_texture(render)[..., :3]
    err, n = 0.0, 0
    for _, tex, w in projections:
        sel = w[..., 0] > 0.5
        if sel.sum() < 100:
            continue
        err += float((tex[sel] - base[sel]).norm(dim=-1).mean())
        n += 1
    return err / n if n else float("inf")


def resolve_heading(render, views: list[View], fit: Fit) -> tuple[Fit, list[tuple]]:
    """Pick between `fit` and `flipped(fit)` (equal silhouettes, so only colors can tell): the one whose projected
    views agree better with the painted texture. Returns it with its back-projections (for `blend_projections`)."""
    aux = [v for v in views if v.name != "main"]
    main = [v for v in views if v.name == "main"]
    if not aux:
        return fit, back_projections(render, main, fit)
    cands = []
    for cand in (fit, flipped(fit)):
        proj = back_projections(render, aux, cand)
        cands.append((color_error(render, proj), cand, proj))
    log.info("multiview: color error heading %.0f° %.3f vs %.0f° %.3f",
             cands[0][1].heading, cands[0][0], cands[1][1].heading, cands[1][0])
    _, best, proj = min(cands, key=lambda c: c[0])
    return best, back_projections(render, main, best) + proj


def blend_projections(render, projections: list[tuple], base_weight: float = 0.15) -> list[str]:
    """Blend back-projected views into MeshRender's albedo; the painted texture keeps `base_weight` everywhere, so it
    shows through on surfaces no view faces. Returns the labels used."""
    import torch

    if not projections:
        return []
    base = _base_texture(render)[..., :3]
    acc = base * base_weight
    wsum = torch.full(base.shape[:2] + (1,), base_weight, device=base.device)
    for _, tex, w in projections:
        acc = acc + tex * w
        wsum = wsum + w
    render.set_texture(acc / wsum, force_set=True)
    used = [label for label, _, _ in projections]
    log.info("multiview: projected %s", used)
    return used


def square(rgba: Image.Image, fill: float = 0.85) -> Image.Image:
    """An object crop centered on a transparent square canvas, the object taking `fill` of the side (as the upload
    preprocessing frames the main image)."""
    side = int(max(rgba.size) / fill)
    canvas = Image.new("RGBA", (side, side))
    canvas.paste(rgba, ((side - rgba.width) // 2, (side - rgba.height) // 2))
    return canvas
