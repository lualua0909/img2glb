import { Box3, BufferAttribute, BufferGeometry, DoubleSide, type Intersection, type Mesh, Ray, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";

/** World-space, welded copy of a model's meshes: used to guess joints, raycast and compute skin weights. */
export type ModelData = {
  /** Welded vertex positions (x, y, z per vertex). */
  positions: Float32Array;
  /** Welded triangles. */
  index: Uint32Array;
  count: number;
  /** Per source mesh: its vertex index -> welded vertex index (UV seams share one welded vertex). */
  maps: Uint32Array[];
  box: Box3;
  size: Vector3;
  center: Vector3;
  bvh: MeshBVH;
};

export function buildModelData(meshes: Mesh[]): ModelData {
  const box = new Box3();
  for (const m of meshes) box.expandByObject(m);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const quantum = Math.max(size.length(), 1e-6) * 1e-5;

  const ids = new Map<string, number>();
  const positions: number[] = [];
  const index: number[] = [];
  const maps: Uint32Array[] = [];
  const v = new Vector3();
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute("position");
    const map = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const key = `${Math.round(v.x / quantum)},${Math.round(v.y / quantum)},${Math.round(v.z / quantum)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = positions.length / 3;
        ids.set(key, id);
        positions.push(v.x, v.y, v.z);
      }
      map[i] = id;
    }
    maps.push(map);
    const src = mesh.geometry.index;
    const n = src ? src.count : pos.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => map[src ? src.getX(t + k) : t + k]);
      if (a !== b && b !== c && a !== c) index.push(a, b, c);
    }
  }

  const geometry = new BufferGeometry();
  const posArray = new Float32Array(positions);
  const indexArray = new Uint32Array(index);
  geometry.setAttribute("position", new BufferAttribute(posArray, 3));
  geometry.setIndex(new BufferAttribute(indexArray, 1));
  return {
    positions: posArray,
    index: indexArray,
    count: posArray.length / 3,
    maps,
    box,
    size,
    center,
    bvh: new MeshBVH(geometry),
  };
}

export function vertexAt(m: ModelData, i: number, out = new Vector3()) {
  return out.set(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]);
}

const thicknessCache = new WeakMap<ModelData, (i: number) => number>();

/**
 * Local thickness at a welded vertex (shape diameter): median distance through the mesh along a cone of rays around
 * the inward normal, averaged over the vertex's triangles. Low on thin sheets such as leaves, fins or ears. Computed
 * on demand per vertex, since only a few candidates are usually asked for.
 */
export function thickness(m: ModelData): (i: number) => number {
  const cached = thicknessCache.get(m);
  if (cached) return cached;
  const tri = m.index;
  const normals = new Float32Array(m.count * 3);
  const start = new Uint32Array(m.count + 1);
  const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
  for (let t = 0; t < tri.length; t += 3) {
    vertexAt(m, tri[t], a);
    b.subVectors(vertexAt(m, tri[t + 1], b), a);
    c.subVectors(vertexAt(m, tri[t + 2], c), a);
    b.cross(c);
    for (let k = 0; k < 3; k++) {
      const v = tri[t + k];
      normals[v * 3] += b.x;
      normals[v * 3 + 1] += b.y;
      normals[v * 3 + 2] += b.z;
      start[v + 1]++;
    }
  }
  // Triangles around each vertex (CSR).
  for (let i = 0; i < m.count; i++) start[i + 1] += start[i];
  const fill = start.slice(0, m.count);
  const around = new Uint32Array(tri.length);
  for (let t = 0; t < tri.length; t++) around[fill[tri[t]]++] = t - (t % 3);

  const raw = new Float32Array(m.count).fill(-1);
  const [dir, u, w, r, v] = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  const ray = new Ray();
  const spread = 0.5;
  const samples: number[] = [];
  const diameter = (i: number) => {
    if (raw[i] >= 0) return raw[i];
    dir.set(-normals[i * 3], -normals[i * 3 + 1], -normals[i * 3 + 2]).normalize();
    u.set(Math.abs(dir.x) < 0.9 ? 1 : 0, Math.abs(dir.x) < 0.9 ? 0 : 1, 0).cross(dir).normalize();
    w.crossVectors(dir, u);
    samples.length = 0;
    for (let k = 0; k < 9; k++) {
      const angle = (k / 8) * 2 * Math.PI;
      r.copy(dir);
      if (k < 8)
        r.multiplyScalar(Math.cos(spread))
          .addScaledVector(u, Math.sin(spread) * Math.cos(angle))
          .addScaledVector(w, Math.sin(spread) * Math.sin(angle));
      ray.set(vertexAt(m, i, v).addScaledVector(r, 1e-4 * m.size.length()), r);
      samples.push(m.bvh.raycastFirst(ray, DoubleSide)?.distance ?? 0);
    }
    return (raw[i] = samples.sort((x, y) => x - y)[4]);
  };
  const at = (i: number) => {
    if (start[i + 1] === start[i]) return diameter(i);
    let sum = 0;
    for (let e = start[i]; e < start[i + 1]; e++) for (let k = 0; k < 3; k++) sum += diameter(tri[around[e] + k]);
    return sum / (3 * (start[i + 1] - start[i]));
  };
  thicknessCache.set(m, at);
  return at;
}

/** All mesh hits of a ray, nearest first. */
export function raycastAll(m: ModelData, origin: Vector3, dir: Vector3): Intersection[] {
  return (m.bvh.raycast(new Ray(origin, dir), DoubleSide) as Intersection[]).sort((a, b) => a.distance - b.distance);
}

/** A ray on a triangle seam may report the same surface twice; it is one crossing. */
function depthHits(m: ModelData, origin: Vector3, direction: Vector3) {
  const hits = raycastAll(m, origin, direction);
  const epsilon = Math.max(m.size.length() * 1e-7, 1e-9);
  return hits.filter((hit, i) => i === 0 || hit.distance - hits[i - 1].distance > epsilon);
}

/**
 * Moves `p` along `axis` to the middle of the first solid part hit when looking from the +axis side (the near
 * side in a view looking down -axis). Used to put joints inside the mesh from a 2D marker position.
 */
export function midDepth(m: ModelData, p: Vector3, axis: Vector3): Vector3 {
  const far = m.size.length() * 2;
  const origin = p.clone().addScaledVector(axis, m.center.dot(axis) + far - p.dot(axis));
  const hits = depthHits(m, origin, axis.clone().negate());
  if (hits.length === 0) return p.clone();
  const depth = hits.length > 1 ? (hits[0].point.dot(axis) + hits[1].point.dot(axis)) / 2 : hits[0].point.dot(axis);
  return p.clone().addScaledVector(axis, depth - p.dot(axis));
}

/** Snap to the solid interval nearest the existing depth, preserving overlapping back-mounted parts. */
export function nearestDepth(m: ModelData, p: Vector3, axis: Vector3): Vector3 {
  const far = m.size.length() * 2;
  const origin = p.clone().addScaledVector(axis, m.center.dot(axis) + far - p.dot(axis));
  const hits = depthHits(m, origin, axis.clone().negate());
  let best = Infinity;
  let depth = p.dot(axis);
  for (let i = 0; i < hits.length; i += 2) {
    const a = hits[i].point.dot(axis);
    const b = (hits[i + 1] ?? hits[i]).point.dot(axis);
    const candidate = (a + b) / 2;
    const distance = Math.abs(candidate - p.dot(axis));
    if (distance < best) { best = distance; depth = candidate; }
  }
  return p.clone().addScaledVector(axis, depth - p.dot(axis));
}
