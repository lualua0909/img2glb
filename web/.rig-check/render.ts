import sharp from "sharp";
import { Vector3 } from "three";

/** Flat-shaded z-buffer render of triangles (positions xyz per vertex), camera looking along -dir. */
export async function render(file: string, views: { pos: Float32Array; index: Uint32Array; colors?: Float32Array; dir: Vector3; label?: string }[], size = 360, box?: { min: Vector3; max: Vector3 }) {
  const W = size * views.length, H = size;
  const img = new Uint8Array(W * H * 3).fill(245);
  views.forEach((v, vi) => {
    const zb = new Float32Array(size * size).fill(Infinity);
    const f = v.dir.clone().normalize();
    const up = Math.abs(f.y) > 0.9 ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
    const r = new Vector3().crossVectors(up, f).normalize();
    const u = new Vector3().crossVectors(f, r);
    const n = v.pos.length / 3;
    const P = new Float32Array(n * 3);
    let [minx, maxx, miny, maxy] = [Infinity, -Infinity, Infinity, -Infinity];
    const p = new Vector3();
    for (let i = 0; i < n; i++) {
      p.fromArray(v.pos, i * 3);
      P[i * 3] = p.dot(r); P[i * 3 + 1] = p.dot(u); P[i * 3 + 2] = -p.dot(f);
    }
    if (box) {
      const c0 = box.min.clone().add(box.max).multiplyScalar(0.5), h = box.max.clone().sub(box.min).multiplyScalar(0.5);
      const e = Math.max(Math.abs(h.x * r.x) + Math.abs(h.y * r.y) + Math.abs(h.z * r.z), Math.abs(h.x * u.x) + Math.abs(h.y * u.y) + Math.abs(h.z * u.z)) * 0.8;
      minx = c0.dot(r) - e; maxx = c0.dot(r) + e; miny = c0.dot(u) - e; maxy = c0.dot(u) + e;
    } else for (let i = 0; i < n; i++) { minx = Math.min(minx, P[i * 3]); maxx = Math.max(maxx, P[i * 3]); miny = Math.min(miny, P[i * 3 + 1]); maxy = Math.max(maxy, P[i * 3 + 1]); }
    const s = (0.9 * size) / Math.max(maxx - minx, maxy - miny);
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    const L = new Vector3(0.4, 0.7, 0.6).normalize();
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), nn = new Vector3();
    for (let t = 0; t < v.index.length; t += 3) {
      const [i0, i1, i2] = [v.index[t], v.index[t + 1], v.index[t + 2]];
      a.set(P[i0 * 3], P[i0 * 3 + 1], P[i0 * 3 + 2]); b.set(P[i1 * 3], P[i1 * 3 + 1], P[i1 * 3 + 2]); c.set(P[i2 * 3], P[i2 * 3 + 1], P[i2 * 3 + 2]);
      nn.subVectors(b, a).cross(c.clone().sub(a)).normalize();
      const shade = 0.25 + 0.75 * Math.abs(nn.dot(L));
      const col = v.colors ? [v.colors[t / 3 * 3], v.colors[t / 3 * 3 + 1], v.colors[t / 3 * 3 + 2]] : [0.72, 0.72, 0.76];
      const X = [a, b, c].map((q) => (q.x - cx) * s + size / 2), Y = [a, b, c].map((q) => size / 2 - (q.y - cy) * s), Z = [a.z, b.z, c.z];
      const x0 = Math.max(0, Math.floor(Math.min(...X))), x1 = Math.min(size - 1, Math.ceil(Math.max(...X)));
      const y0 = Math.max(0, Math.floor(Math.min(...Y))), y1 = Math.min(size - 1, Math.ceil(Math.max(...Y)));
      const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((X[1] - px) * (Y[2] - py) - (X[2] - px) * (Y[1] - py)) / area;
        const w1 = ((X[2] - px) * (Y[0] - py) - (X[0] - px) * (Y[2] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = -(w0 * Z[0] + w1 * Z[1] + w2 * Z[2]);
        if (z >= zb[y * size + x]) continue;
        zb[y * size + x] = z;
        const o = (y * W + vi * size + x) * 3;
        for (let k = 0; k < 3; k++) img[o + k] = Math.min(255, col[k] * shade * 255);
      }
    }
  });
  await sharp(Buffer.from(img), { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
}
