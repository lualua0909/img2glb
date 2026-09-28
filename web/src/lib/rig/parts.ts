import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";

type Bary = [number, number, number];

/** Clip each triangle where interpolated skin weights are equal, rather than assigning whole triangles. */
export function splitWeightedParts(source: BufferGeometry, boneIndex = (i: number) => i) {
  const pos = source.getAttribute("position");
  const normal = source.getAttribute("normal");
  const joints = source.getAttribute("skinIndex");
  const weights = source.getAttribute("skinWeight");
  const index = source.index;
  const output = new Map<number, { positions: number[]; normals: number[] }>();
  const vertexWeights = Array.from({ length: pos.count }, (_, i) => {
    const map = new Map<number, number>();
    let total = 0;
    for (let slot = 0; slot < weights.itemSize; slot++) {
      const value = weights.getComponent(i, slot);
      if (!Number.isFinite(value) || value <= 0) continue;
      const bone = boneIndex(joints.getComponent(i, slot));
      map.set(bone, (map.get(bone) ?? 0) + value); total += value;
    }
    if (!total) return new Map([[-1, 1]]);
    for (const [bone, value] of map) map.set(bone, value / total);
    return map;
  });
  const blend = (p: Bary, values: number[]) => p[0] * values[0] + p[1] * values[1] + p[2] * values[2];
  for (let t = 0; t + 2 < (index?.count ?? pos.count); t += 3) {
    const vertices = [0, 1, 2].map(i => index ? index.getX(t + i) : t + i);
    const ws = vertices.map(i => vertexWeights[i]);
    const candidates = [...new Set(ws.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
    const points = vertices.map(i => new Vector3().fromBufferAttribute(pos, i));
    const normals = normal ? vertices.map(i => new Vector3().fromBufferAttribute(normal, i)) : [];
    const face = new Vector3().subVectors(points[1], points[0]).cross(new Vector3().subVectors(points[2], points[0])).normalize();
    for (const bone of candidates) {
      let polygon: Bary[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (const other of candidates) {
        if (other === bone) continue;
        const difference = ws.map(m => (m.get(bone) ?? 0) - (m.get(other) ?? 0));
        // Identical fields cover the whole face; deterministic tie-break prevents duplicate surfaces.
        if (difference.every(v => Math.abs(v) < 1e-12)) {
          if (other < bone) { polygon = []; break; }
          continue;
        }
        const clipped: Bary[] = [];
        for (let i = 0; i < polygon.length; i++) {
          const a = polygon[i], b = polygon[(i + 1) % polygon.length];
          const da = blend(a, difference), db = blend(b, difference);
          if (da >= 0) clipped.push(a);
          if ((da >= 0) !== (db >= 0)) {
            const ratio = da / (da - db);
            clipped.push(a.map((v, axis) => v + ratio * (b[axis] - v)) as Bary);
          }
        }
        polygon = clipped;
        if (polygon.length < 3) break;
      }
      if (polygon.length < 3) continue;
      const point = (b: Bary, values: Vector3[]) => new Vector3().addScaledVector(values[0], b[0]).addScaledVector(values[1], b[1]).addScaledVector(values[2], b[2]);
      for (let i = 1; i + 1 < polygon.length; i++) {
        const corners = [polygon[0], polygon[i], polygon[i + 1]];
        const ps = corners.map(b => point(b, points));
        if (new Vector3().subVectors(ps[1], ps[0]).cross(new Vector3().subVectors(ps[2], ps[0])).lengthSq() < 1e-24) continue;
        let part = output.get(bone);
        if (!part) output.set(bone, part = { positions: [], normals: [] });
        corners.forEach((b, j) => {
          part.positions.push(...ps[j].toArray());
          part.normals.push(...(normal ? point(b, normals).normalize() : face).toArray());
        });
      }
    }
  }
  return new Map([...output].map(([bone, data]) => [bone, new BufferGeometry()
    .setAttribute("position", new Float32BufferAttribute(data.positions, 3))
    .setAttribute("normal", new Float32BufferAttribute(data.normals, 3))]));
}
