import { DoubleSide, Ray, Vector3 } from "three";
import { type ModelData, vertexAt } from "./model";
import type { RigPlan } from "./rig";

/** Up to four bone influences per welded vertex (bone indices into `plan.bones`). */
export type Skin = { index: Uint16Array; weight: Float32Array };

type Influence = [bone: number, weight: number];

const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));
const smooth = (x: number) => x * x * (3 - 2 * x);

function pack(skin: Skin, i: number, list: Influence[]) {
  const top = list.filter(([, w]) => w > 1e-3).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = top.reduce((a, [, w]) => a + w, 0);
  for (let k = 0; k < 4; k++) {
    skin.index[i * 4 + k] = top[k]?.[0] ?? 0;
    skin.weight[i * 4 + k] = top[k] && sum > 0 ? top[k][1] / sum : 0;
  }
}

const _ab = new Vector3();
const _ap = new Vector3();

function closestOnSegment(p: Vector3, a: Vector3, b: Vector3, out: Vector3) {
  const ab = _ab.copy(b).sub(a);
  const t = Math.min(1, Math.max(0, _ap.copy(p).sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-12)));
  return out.copy(a).addScaledVector(ab, t);
}

/** Interpolates along sorted bone centers `c` at parameter `t`: the two nearest bones share the weight. */
function alongChain(t: number, centers: number[], bones: number[]): Influence[] {
  if (t <= centers[0]) return [[bones[0], 1]];
  const last = centers.length - 1;
  if (t >= centers[last]) return [[bones[last], 1]];
  let k = 0;
  while (t > centers[k + 1]) k++;
  const u = smooth((t - centers[k]) / Math.max(centers[k + 1] - centers[k], 1e-9));
  return [
    [bones[k], 1 - u],
    [bones[k + 1], u],
  ];
}

/** Vertex adjacency (CSR, deduplicated) from the welded triangles. */
function adjacency(m: ModelData) {
  const n = m.count;
  const count = new Uint32Array(n + 1);
  const tri = m.index;
  for (let t = 0; t < tri.length; t += 3) for (let k = 0; k < 3; k++) count[tri[t + k]] += 2;
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + count[i];
  const fill = start.slice(0, n);
  const list = new Uint32Array(start[n]);
  for (let t = 0; t < tri.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = tri[t + k];
      list[fill[a]++] = tri[t + ((k + 1) % 3)];
      list[fill[a]++] = tri[t + ((k + 2) % 3)];
    }
  // Deduplicate each vertex's neighbors in place.
  const offs = new Uint32Array(n + 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    offs[i] = out.length;
    const nb = Array.from(new Set(list.subarray(start[i], start[i + 1])));
    for (const j of nb) out.push(j);
  }
  offs[n] = out.length;
  return { offs, adj: new Uint32Array(out) };
}

/**
 * Bone heat (Baran & Popović, "Automatic Rigging and Animation of 3D Characters"): each vertex is heated by its
 * nearest bone that it can "see" from inside the mesh, and heat diffuses over the surface, giving smooth weights
 * that don't leak between limbs close in space (an arm resting against the torso).
 */
async function heatSkin(m: ModelData, plan: RigPlan, skin: Skin, onProgress?: (p: number) => void) {
  const n = m.count;
  const deform = plan.bones.map((b, i) => ({ b, i })).filter(({ b }) => b.deform);
  const nb = deform.length;
  const { offs, adj } = adjacency(m);

  let edgeSum = 0;
  let edgeCount = 0;
  const [a, b] = [new Vector3(), new Vector3()];
  for (let t = 0; t < m.index.length; t += 3)
    for (let k = 0; k < 3; k++) {
      edgeSum += vertexAt(m, m.index[t + k], a).distanceTo(vertexAt(m, m.index[t + ((k + 1) % 3)], b));
      edgeCount++;
    }
  const edge = Math.max(edgeSum / Math.max(edgeCount, 1), 1e-6);

  // Heat is capped at this distance: vertices far from every bone (chubby cartoon bodies) otherwise get almost no
  // heat of their own, and the torso's weights are taken over by the limbs and the head around it.
  const reach = 0.05 * m.size.length();
  // Nearest visible bone per vertex -> heat source strength H.
  const nearest = new Int32Array(n);
  const H = new Float64Array(n);
  const v = new Vector3();
  const q = new Vector3();
  const dir = new Vector3();
  const ray = new Ray();
  const dist = new Float64Array(nb);
  const order = Array.from({ length: nb }, (_, j) => j);
  for (let i = 0; i < n; i++) {
    vertexAt(m, i, v);
    for (let j = 0; j < nb; j++) {
      const g = deform[j].b.gate;
      dist[j] =
        g && q.copy(v).sub(g.origin).dot(g.dir) < 0
          ? Infinity
          : v.distanceTo(closestOnSegment(v, deform[j].b.head, deform[j].b.tail, q));
    }
    order.sort((x, y) => dist[x] - dist[y]);
    let chosen = order[0];
    for (const j of order) {
      if (dist[j] > 1.6 * dist[order[0]] + 0.5 * edge) break;
      closestOnSegment(v, deform[j].b.head, deform[j].b.tail, q);
      const len = dir.copy(v).sub(q).length();
      if (len < 1e-9) {
        chosen = j;
        break;
      }
      ray.set(q, dir.divideScalar(len));
      const hit = m.bvh.raycastFirst(ray, DoubleSide);
      if (!hit || hit.distance >= len * 0.97 - 1e-6) {
        chosen = j;
        break;
      }
    }
    nearest[i] = chosen;
    H[i] = 1 / Math.max(Math.min(dist[chosen], reach) / edge, 1) ** 2;
  }
  await yieldToUi();

  // Solve (L + H) w_j = H p_j per bone by Jacobi-preconditioned conjugate gradients (L = graph Laplacian).
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) diag[i] = offs[i + 1] - offs[i] + H[i];
  const mul = (x: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) {
      let s = diag[i] * x[i];
      for (let e = offs[i]; e < offs[i + 1]; e++) s -= x[adj[e]];
      out[i] = s;
    }
  };
  const dot = (x: Float64Array, y: Float64Array) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i] * y[i];
    return s;
  };
  const weights = new Float32Array(n * nb);
  const [x, r, z, p, Ap, rhs] = Array.from({ length: 6 }, () => new Float64Array(n));
  for (let j = 0; j < nb; j++) {
    for (let i = 0; i < n; i++) {
      x[i] = nearest[i] === j ? 1 : 0;
      rhs[i] = H[i] * x[i];
    }
    const bNorm = Math.sqrt(dot(rhs, rhs));
    if (bNorm > 0) {
      mul(x, Ap);
      for (let i = 0; i < n; i++) {
        r[i] = rhs[i] - Ap[i];
        z[i] = r[i] / diag[i];
        p[i] = z[i];
      }
      let rz = dot(r, z);
      for (let it = 0; it < 600 && Math.sqrt(dot(r, r)) > 1e-5 * bNorm; it++) {
        mul(p, Ap);
        const alpha = rz / dot(p, Ap);
        for (let i = 0; i < n; i++) {
          x[i] += alpha * p[i];
          r[i] -= alpha * Ap[i];
          z[i] = r[i] / diag[i];
        }
        const rzNext = dot(r, z);
        const beta = rzNext / rz;
        rz = rzNext;
        for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
      }
      for (let i = 0; i < n; i++) weights[j * n + i] = Math.min(1, Math.max(0, x[i]));
    }
    onProgress?.((j + 1) / nb);
    await yieldToUi();
  }

  for (let i = 0; i < n; i++) {
    const list: Influence[] = [];
    for (let j = 0; j < nb; j++) list.push([deform[j].i, weights[j * n + i]]);
    if (!list.some(([, w]) => w > 1e-3)) list.push([deform[nearest[i]].i, 1]);
    pack(skin, i, list);
  }
}

export async function computeSkin(m: ModelData, plan: RigPlan, onProgress?: (p: number) => void): Promise<Skin> {
  const skin: Skin = { index: new Uint16Array(m.count * 4), weight: new Float32Array(m.count * 4) };
  const idx = new Map(plan.bones.map((b, i) => [b.name, i]));
  const s = plan.skin;
  const v = new Vector3();

  if (s.mode === "heat") {
    await heatSkin(m, plan, skin, onProgress);
  } else if (s.mode === "chain") {
    const axis = s.end.clone().sub(s.start);
    const len2 = Math.max(axis.lengthSq(), 1e-12);
    const heads = s.bones.map((n) => plan.bones[idx.get(n)!].head.clone().sub(s.start).dot(axis) / len2);
    const centers = heads.map((t, k) => (t + (heads[k + 1] ?? 1)) / 2);
    const bones = s.bones.map((n) => idx.get(n)!);
    for (let i = 0; i < m.count; i++)
      pack(skin, i, alongChain(vertexAt(m, i, v).sub(s.start).dot(axis) / len2, centers, bones));
  } else if (s.mode === "lattice") {
    const per = s.chains[0].bones.length;
    const centers = Array.from({ length: per }, (_, k) => (k + 0.5) / per);
    for (let i = 0; i < m.count; i++) {
      vertexAt(m, i, v);
      const g = s.chains.map((c) => Math.exp(-((v.x - c.base.x) ** 2 + (v.z - c.base.z) ** 2) / (2 * s.sigma ** 2)));
      const total = g.reduce((a, b) => a + b, 0) || 1;
      const t = (v.y - s.minY) / s.height;
      const list: Influence[] = [];
      s.chains.forEach((c, ci) => {
        for (const [b, w] of alongChain(t, centers, c.bones.map((n) => idx.get(n)!))) list.push([b, (w * g[ci]) / total]);
      });
      pack(skin, i, list);
    }
  } else {
    const L = plan.frame.lateral;
    const body = idx.get(s.body)!;
    const rel = new Vector3();
    for (let i = 0; i < m.count; i++) {
      vertexAt(m, i, v);
      const wheel = s.wheels.find((w) => {
        const axial = rel.copy(v).sub(w.center).dot(L);
        return Math.abs(axial) <= w.halfWidth && rel.addScaledVector(L, -axial).length() <= w.radius * 1.08;
      });
      pack(skin, i, [[wheel ? idx.get(wheel.bone)! : body, 1]]);
    }
  }
  onProgress?.(1);
  return skin;
}
