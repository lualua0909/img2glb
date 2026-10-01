"""
Membrane wings as thin, double-sided sheets textured straight from a reference view.

The shape model builds wings (and other membranes: fins, sails) as slabs: two close surfaces facing opposite ways,
which the texture model paints blurry. Here they are found as large connected regions where the surface has an
opposite-facing surface within a small distance, removed from the body (which is painted as usual), and replaced by
one of their two surfaces: the one facing the reference view that sees them best. That sheet keeps the generated
wing's shape and is textured by projecting that view onto it, its alpha cutting the drawn outline (glTF alphaMode
MASK, double-sided).
"""
import logging

import cv2
import numpy as np
import scipy.sparse as sp
import trimesh
from PIL import Image
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

import multiview as mv

log = logging.getLogger("worker")


def thickness(mesh: trimesh.Trimesh, k: int = 32) -> np.ndarray:
    """Per vertex: distance along its normal to the nearest of its k nearest vertices facing the opposite way
    (inf when none does, i.e. inside a thick part)."""
    v, n = mesh.vertices, mesh.vertex_normals
    _, idx = cKDTree(v).query(v, k=min(k, len(v)))
    opposite = np.einsum("ij,ikj->ik", n, n[idx]) < -0.3
    along = np.abs(np.einsum("ikj,ij->ik", v[idx] - v[:, None], n))
    return np.where(opposite, along, np.inf).min(1)


def symmetry_axis(mesh: trimesh.Trimesh, n: int = 4000) -> tuple[np.ndarray, np.ndarray]:
    """(center, unit normal) of the vertical plane the mesh is most mirror-symmetric about: creatures are, and their
    wings sit on either side of it."""
    pts = mesh.sample(n, seed=0) if hasattr(mesh, "sample") else mesh.vertices
    center = (pts.min(0) + pts.max(0)) / 2
    tree = cKDTree(pts)
    best = None
    for a in np.radians(np.arange(0, 180, 3)):
        normal = np.array([np.cos(a), 0.0, -np.sin(a)])
        mirrored = pts - 2 * np.outer((pts - center) @ normal, normal)
        err = tree.query(mirrored)[0].mean()
        if best is None or err < best[0]:
            best = (err, normal)
    return center, best[1]


def find_membranes(mesh: trimesh.Trimesh, max_thickness: float = 0.015, min_area: float = 0.03,
                   max_area: float = 0.45, midline: float = 0.12, min_span: float = 0.25,
                   max_bend: float = 0.2) -> list[np.ndarray]:
    """Face indices of each thin sheet (thickness < max_thickness x the bounding box diagonal) off the midline,
    covering min_area..max_area of the surface and spanning at least min_span of the bounding box diagonal, largest
    first (layered plates of a mane are thin too, but short), and roughly flat: their least principal spread at most
    max_bend of the largest (curled plates and bundles of strands are not). Faces within `midline` of the half span from the
    symmetry plane belong to the body (a thin body would join both wings; fins and crests on the midline stay), and
    a sheet bigger than max_area is the object itself (a leaf, a blade), not a membrane. `mesh` must be welded."""
    diag = np.linalg.norm(mesh.extents)
    thin = (thickness(mesh) < max_thickness * diag)[mesh.faces].all(1)
    center, normal = symmetry_axis(mesh)
    side = (mesh.triangles_center - center) @ normal
    thin &= np.abs(side) > midline * np.abs(side).max()
    adj = mesh.face_adjacency[thin[mesh.face_adjacency].all(1)]
    f = len(mesh.faces)
    graph = sp.coo_matrix((np.ones(len(adj)), (adj[:, 0], adj[:, 1])), shape=(f, f))
    _, labels = connected_components(graph, directed=False)
    areas = np.bincount(labels[thin], weights=mesh.area_faces[thin], minlength=labels.max() + 1)
    out = []
    for c in np.argsort(-areas):
        if not min_area * mesh.area <= areas[c] <= max_area * mesh.area:
            continue
        faces = np.flatnonzero(thin & (labels == c))
        centers = mesh.triangles_center[faces] - mesh.triangles_center[faces].mean(0)
        spread = np.linalg.svd(centers, compute_uv=False)
        if np.linalg.norm(np.ptp(centers, 0)) >= min_span * diag and spread[2] <= max_bend * spread[0]:
            out.append(faces)
    log.info("wings: %d membrane(s), %s%% of the surface", len(out),
             [round(100 * mesh.area_faces[faces].sum() / mesh.area, 1) for faces in out])
    return out


def _camera_dir(elev: float, azim: float) -> np.ndarray:
    """Unit vector from the object towards the camera."""
    right, up = mv.camera(elev, azim)
    return np.cross(right, up)


# Views whose cameras map pixels to the same surface whichever way the heading resolves (mv.resolve_heading picks
# between h and h + 180 later, by color): the main view, both flanks of a side view, and the top view.
SHEET_VIEWS = ("main", "side", "top")


def membrane_sheet(mesh: trimesh.Trimesh, faces: np.ndarray, views: list["mv.View"], fit: "mv.Fit",
                   min_iou: float = 0.5, min_cover: float = 0.85, res: int = 1024):
    """A textured, double-sided single sheet for one membrane, or None when no view sees it well. The view is the
    camera (of SHEET_VIEWS whose silhouette matches the mesh) whose direction the membrane faces most, by area. The
    drawing must cover at least `min_cover` of the sheet's projection: otherwise the generated wing does not line
    up with the drawn one (e.g. a perspective three-quarter view) and its alpha would punch holes in it."""
    normals, areas = mesh.face_normals[faces], mesh.area_faces[faces]
    best = None
    for view in views:
        if view.name not in SHEET_VIEWS or fit.ious.get(view.name, 0) < min_iou:
            continue
        for elev, azim, mirrored in mv.view_cameras(view.name, fit.heading):
            d = _camera_dir(elev, azim)
            score = float((np.clip(normals @ d, 0, None) * areas).sum())
            if best is None or score > best[0]:
                best = (score, view, elev, azim, mirrored, d)
    if best is None or best[0] < 0.3 * areas.sum():
        return None
    _, view, elev, azim, mirrored, d = best
    front = faces[normals @ d > 0.05]  # the surface facing the camera; the back surface and rim are dropped
    if not len(front):
        return None

    # Place the view on the whole mesh's silhouette for that camera (as `back_projections` does).
    verts = np.asarray(mesh.vertices, np.float64)
    sil, (u0, v0, scale) = mv.rasterize(verts, mesh.faces, *mv.camera(elev, azim), res)
    rgba = mv.transform(np.asarray(view.image), fit.options[view.name])
    if mirrored:
        rgba = rgba[:, ::-1]
    rgba = np.ascontiguousarray(rgba)
    ys, xs = np.nonzero(sil)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1

    sheet = trimesh.Trimesh(mesh.vertices, mesh.faces[front], process=False)
    sheet.remove_unreferenced_vertices()
    right, up = mv.camera(elev, azim)
    px = (sheet.vertices @ right - u0) * scale  # pixel in the res x res silhouette canvas
    py = (v0 - sheet.vertices @ up) * scale
    h, w = rgba.shape[:2]
    ix = (px - x0) * w / (x1 - x0)  # pixel in the view image
    iy = (py - y0) * h / (y1 - y0)

    projected = np.zeros((h, w), np.uint8)
    cv2.fillPoly(projected, np.round(np.stack([ix, iy], 1)[sheet.faces] * 4).astype(np.int32), 1, shift=2)
    projected = projected > 0
    cover = (projected & (rgba[..., 3] > 127)).sum() / max(projected.sum(), 1)
    if cover < min_cover:
        log.info("wings: %s covers only %.0f%% of the sheet, keeping the generated membrane", view.name, 100 * cover)
        return None

    # Crop the texture to the sheet (plus a margin) to keep it small.
    m = 4
    cx0, cy0 = max(int(ix.min()) - m, 0), max(int(iy.min()) - m, 0)
    cx1, cy1 = min(int(np.ceil(ix.max())) + m, w), min(int(np.ceil(iy.max())) + m, h)
    if cx1 - cx0 < 8 or cy1 - cy0 < 8:
        return None
    crop = Image.fromarray(rgba[cy0:cy1, cx0:cx1])
    uv = np.stack([(ix - cx0) / (cx1 - cx0), 1 - (iy - cy0) / (cy1 - cy0)], 1)
    material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=crop, metallicFactor=0.0, roughnessFactor=0.8, alphaMode="MASK", alphaCutoff=0.5,
        doubleSided=True,
    )
    sheet.visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
    log.info("wings: sheet of %d faces textured from %s (camera %s/%s%s), %dx%d px", len(front), view.name,
             int(elev), int(azim) % 360, ", mirrored" if mirrored else "", crop.width, crop.height)
    return sheet


def membrane_sheets(mesh: trimesh.Trimesh, views: list["mv.View"], fit: "mv.Fit"):
    """(mesh without the membranes that got a sheet, their sheets). The mesh is returned unchanged when none did."""
    welded = trimesh.Trimesh(mesh.vertices, mesh.faces)  # process=True merges duplicate vertices
    keep = np.ones(len(welded.faces), bool)
    sheets = []
    for faces in find_membranes(welded):
        sheet = membrane_sheet(welded, faces, views, fit)
        if sheet is not None:
            sheets.append(sheet)
            keep[faces] = False
    if not sheets:
        return mesh, []
    body = trimesh.Trimesh(welded.vertices, welded.faces[keep])
    body.remove_unreferenced_vertices()
    return body, sheets
