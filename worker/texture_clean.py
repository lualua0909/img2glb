"""
Texture cleanup ("Làm sạch texture") for baked Hunyuan3D-Paint textures.

Hunyuan3D-2.1 bakes 6-9 generated views onto a dense xatlas atlas: overlapping views are blended by angle (soft,
ghosted edges), and texels no view saw are filled by vertex propagation + Navier-Stokes inpainting (streaks and
smears). This cleans the base color (and metallic-roughness) map in place, per UV chart, so nothing bleeds between
unrelated charts that sit next to each other in the atlas:

  1. edge-preserving smoothing (bilateral, in Lab) removes noise and blotches but keeps color edges sharp;
  2. "balanced" / "strong": texels are grouped into a small palette (k-means in Lab, near-duplicate colors merged)
     and a majority filter removes specks and thin streaks, so every region gets one clean color (hue and
     saturation of its palette color) while the smoothed lightness is kept, so shading gradients do not band into
     patches. "balanced" keeps a little of the color variation, "strong" none, with fewer colors and more smoothing;
  3. metallic-roughness is median-filtered and pulled toward one value per palette region; the empty gutter between charts is refilled with the nearest
     chart color, so mipmaps and bilinear sampling do not pull in stray colors at UV seams.

Pure OpenCV / NumPy / SciPy on the CPU: no model, runs next to GPU jobs.
"""
from dataclasses import dataclass
from typing import Literal, Optional

import cv2
import numpy as np
from scipy.ndimage import find_objects
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

Level = Literal["light", "balanced", "strong"]


@dataclass(frozen=True)
class Preset:
    smooth_passes: int
    sigma_color: float  # bilateral range sigma in Lab units (L 0-100)
    palette: int  # max palette colors; 0 = keep the smoothed colors
    merge_delta_e: float  # palette colors closer than this are merged
    keep_lightness: float  # share of the texel's lightness deviation from its palette color that is kept
    keep_chroma: float  # same for color (a, b), capped at MAX_CHROMA_DETAIL
    mode_passes: int  # majority filter passes on the palette labels
    mode_window: int  # majority filter window (px at 2048)
    keep_material: float  # share of metallic-roughness variation kept around each palette region's median


PRESETS: dict[str, Preset] = {
    "light": Preset(2, 12, 0, 0, 1.0, 1.0, 0, 0, 1.0),
    "balanced": Preset(3, 16, 24, 7, 1.0, 0.25, 2, 5, 0.5),
    "strong": Preset(5, 24, 12, 14, 1.0, 0.0, 3, 9, 0.25),
}
MAX_CHROMA_DETAIL = 6.0
# Lightness counts half in the palette distance: shading differences should not split a region in two.
L_WEIGHT = 0.5


def chart_ids(uv: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """UV chart index per face: faces connected through shared UV positions (unwelded vertices, e.g. flat shaded
    meshes, are joined by position so a chart is not split into single faces)."""
    key = np.round(uv * 65536).astype(np.int64)
    _, vid = np.unique(key[:, 0] * (1 << 20) + key[:, 1], return_inverse=True)
    f = vid.reshape(-1)[faces]
    n = int(vid.max()) + 1
    rows = np.concatenate([f[:, 0], f[:, 1], f[:, 2]])
    cols = np.concatenate([f[:, 1], f[:, 2], f[:, 0]])
    graph = coo_matrix((np.ones(len(rows), np.int8), (rows, cols)), shape=(n, n))
    _, comp = connected_components(graph, directed=False)
    return comp[f[:, 0]]


def rasterize_charts(uv: np.ndarray, faces: np.ndarray, charts: np.ndarray, h: int, w: int) -> np.ndarray:
    """Chart index + 1 per texel (0 = gutter). glTF UV (0, 0) is the image's top-left corner."""
    shift = 4
    px = np.round((uv * [w, h] - 0.5) * (1 << shift)).astype(np.int32)
    out = np.zeros((h, w), np.int32)
    tris = px[faces]
    order = np.argsort(charts, kind="stable")
    bounds = np.flatnonzero(np.diff(charts[order])) + 1
    for group in np.split(order, bounds):
        cv2.fillPoly(out, list(tris[group]), int(charts[group[0]]) + 1, lineType=cv2.LINE_8, shift=shift)
    return out


def nearest_fill(img: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Every texel outside `mask` takes the value of the nearest texel inside it."""
    if mask.all() or not mask.any():
        return img
    _, labels = cv2.distanceTransformWithLabels(
        (~mask).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL
    )
    lut = np.zeros((labels.max() + 1,) + img.shape[2:], img.dtype)
    lut[labels[mask]] = img[mask]
    return lut[labels]


def chart_boxes(chart_map: np.ndarray, margin: int):
    """(chart id, y0, y1, x0, x1) crop per chart, padded by `margin`."""
    h, w = chart_map.shape
    for i, sl in enumerate(find_objects(chart_map)):
        if sl is None:
            continue
        ys, xs = sl
        yield i + 1, max(ys.start - margin, 0), min(ys.stop + margin, h), max(xs.start - margin, 0), min(xs.stop + margin, w)


def per_chart(img: np.ndarray, chart_map: np.ndarray, margin: int, fn) -> np.ndarray:
    """Applies `fn` to each chart's crop with the other charts replaced by this chart's nearest colors, so filters
    never mix colors of unrelated charts; writes back only the chart's own texels."""
    out = img.copy()
    for cid, y0, y1, x0, x1 in chart_boxes(chart_map, margin):
        own = chart_map[y0:y1, x0:x1] == cid
        if own.sum() < 16:  # a few texels: nothing to filter
            continue
        crop = nearest_fill(img[y0:y1, x0:x1], own)
        res = fn(crop)
        out[y0:y1, x0:x1][own] = res[own]
    return out


def to_lab(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)


def to_rgb(lab: np.ndarray) -> np.ndarray:
    return np.clip(cv2.cvtColor(lab.astype(np.float32), cv2.COLOR_LAB2RGB) * 255 + 0.5, 0, 255).astype(np.uint8)


def palette(lab: np.ndarray, k: int, merge: float, seed: int = 0) -> np.ndarray:
    """Up to `k` Lab colors covering `lab` (N x 3): k-means, then colors closer than `merge` are merged and
    clusters under 0.1% of the texels are dropped."""
    rng = np.random.default_rng(seed)
    sample = lab[rng.choice(len(lab), min(len(lab), 200_000), replace=False)].astype(np.float32)
    k = min(k, len(sample))
    cv2.setRNGSeed(seed)
    _, labels, centers = cv2.kmeans(
        sample, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.2), 3, cv2.KMEANS_PP_CENTERS
    )
    counts = np.bincount(labels.ravel(), minlength=k).astype(np.float64)
    centers, counts = centers[counts > 0.001 * len(sample)], counts[counts > 0.001 * len(sample)]
    # Greedy merge of the closest pair until all pairs are at least `merge` apart (count-weighted means).
    while len(centers) > 1:
        d = np.linalg.norm(centers[:, None] - centers[None], axis=-1)
        np.fill_diagonal(d, np.inf)
        i, j = np.unravel_index(np.argmin(d), d.shape)
        if d[i, j] >= merge:
            break
        centers[i] = (centers[i] * counts[i] + centers[j] * counts[j]) / (counts[i] + counts[j])
        counts[i] += counts[j]
        centers, counts = np.delete(centers, j, 0), np.delete(counts, j)
    return centers


def nearest_label(lab: np.ndarray, centers: np.ndarray) -> np.ndarray:
    out = np.empty(len(lab), np.int32)
    for s in range(0, len(lab), 1 << 20):  # chunks: N x K distances
        d = ((lab[s : s + (1 << 20), None, :] - centers[None]) ** 2).sum(-1)
        out[s : s + (1 << 20)] = d.argmin(1)
    return out


def mode_filter(labels: np.ndarray, win: int) -> np.ndarray:
    """Majority label in a win x win window."""
    best, best_n = labels.copy(), np.zeros(labels.shape, np.float32)
    for c in np.unique(labels):
        n = cv2.boxFilter((labels == c).astype(np.float32), -1, (win, win), normalize=False, borderType=cv2.BORDER_REPLICATE)
        take = n > best_n
        best[take], best_n[take] = c, n[take]
    return best


def clean_texture(
    base_color: np.ndarray,
    uv: np.ndarray,
    faces: np.ndarray,
    level: Level,
    metallic_roughness: Optional[np.ndarray] = None,
) -> tuple[np.ndarray, Optional[np.ndarray]]:
    """Cleans a base color map (H x W x 3 or 4, uint8; alpha is kept) and optionally its metallic-roughness map
    (same UVs, any size). `uv` (V x 2) and `faces` (F x 3) are the primitive's TEXCOORD and triangle indices."""
    p = PRESETS[level]
    h, w = base_color.shape[:2]
    scale = max(h, w) / 2048  # filter sizes are tuned at 2048 px
    charts = chart_ids(uv, faces)
    chart_map = rasterize_charts(uv, faces, charts, h, w)
    inside = chart_map > 0
    if not inside.any():
        raise ValueError("the texture's UVs cover no texels")

    rgb = np.ascontiguousarray(base_color[..., :3])
    lab = to_lab(rgb)
    d = max(5, int(round(7 * scale)) | 1)
    margin = d

    def smooth(crop: np.ndarray) -> np.ndarray:
        for _ in range(p.smooth_passes):
            crop = cv2.bilateralFilter(crop, d, p.sigma_color, 3 * scale)
        return crop

    lab = per_chart(lab, chart_map, margin, smooth)

    labels_map = None
    if p.palette:
        feats = lab[inside] * [L_WEIGHT, 1, 1]
        centers = palette(feats, p.palette, p.merge_delta_e)
        labels_map = np.full((h, w), -1, np.int32)
        labels_map[inside] = nearest_label(feats, centers)
        win = max(3, int(round(p.mode_window * scale)) | 1)
        for _ in range(p.mode_passes):
            labels_map = per_chart(labels_map, chart_map, win, lambda c: mode_filter(c, win))
        flat = centers[labels_map[inside]] / [L_WEIGHT, 1, 1]
        dev = lab[inside] - flat
        dev[:, 0] *= p.keep_lightness
        ab = dev[:, 1:] * p.keep_chroma
        ab *= np.minimum(1, MAX_CHROMA_DETAIL / np.maximum(np.linalg.norm(ab, axis=1, keepdims=True), 1e-6))
        dev[:, 1:] = ab
        lab[inside] = flat + dev

    out = to_rgb(lab)
    out = nearest_fill(out, inside)
    if base_color.shape[2] == 4:
        out = np.dstack([out, base_color[..., 3]])

    mr_out = None
    if metallic_roughness is not None:
        mh, mw = metallic_roughness.shape[:2]
        mr_charts = chart_map if (mh, mw) == (h, w) else cv2.resize(chart_map, (mw, mh), interpolation=cv2.INTER_NEAREST)
        mr_inside = mr_charts > 0
        mr = np.ascontiguousarray(metallic_roughness[..., :3]).copy()
        ksize = max(3, int(round(5 * max(mh, mw) / 2048)) | 1)
        mr = per_chart(mr, mr_charts, ksize, lambda c: cv2.medianBlur(np.ascontiguousarray(c), ksize))
        if labels_map is not None:
            lm = labels_map if (mh, mw) == (h, w) else cv2.resize(labels_map, (mw, mh), interpolation=cv2.INTER_NEAREST)
            region = mr_inside & (lm >= 0)
            vals = mr[region].astype(np.float32)
            lbl = lm[region]
            med = np.zeros((lbl.max() + 1, 3), np.float32)
            for c in np.unique(lbl):
                med[c] = np.median(vals[lbl == c], axis=0)
            mr[region] = np.clip(med[lbl] + p.keep_material * (vals - med[lbl]) + 0.5, 0, 255).astype(np.uint8)
        mr = nearest_fill(mr, mr_inside)
        mr_out = mr if metallic_roughness.shape[2] == 3 else np.dstack([mr, metallic_roughness[..., 3:]])
    return out, mr_out
