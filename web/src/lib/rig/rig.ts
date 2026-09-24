import { Vector3 } from "three";
import type { RigCategory } from "./categories";
import { midDepth, type ModelData, raycastAll, thickness, vertexAt } from "./model";

export { RIG_CATEGORIES, type RigCategory } from "./categories";

// Template rigs: the user picks what the model is, joint markers are guessed from the mesh and can be dragged,
// then a skeleton and a skinning plan are built from them.

export type RigOptions = {
  /** Mirror left markers to the right. Vehicles: wheels on both sides (off = one row, e.g. a motorbike). */
  symmetry: boolean;
  /** Reverse the forward direction (characters, vehicles, aircraft). */
  flip: boolean;
  /** Wheels per side (vehicles). */
  wheels: number;
  /** Add a tail chain (characters). */
  tail: boolean;
};
export const DEFAULT_RIG_OPTIONS: RigOptions = { symmetry: true, flip: false, wheels: 2, tail: false };

export type Markers = Record<string, Vector3>;
/** Object axes in world space: forward = the way it faces or travels, lateral = its left side, up = +Y. */
export type Frame = { forward: Vector3; lateral: Vector3; up: Vector3 };
export type BoneSpec = {
  name: string;
  parent: string | null;
  head: Vector3;
  tail: Vector3;
  deform: boolean;
  /**
   * Heat skinning: only vertices on the `dir` side of the plane through `origin` may take this bone as their nearest
   * one, so short limbs close to the body (cartoon characters) don't claim the torso, the head or a tail.
   */
  gate?: { origin: Vector3; dir: Vector3 };
};

export type SkinPlan =
  /** Heat diffusion from the nearest visible bone (characters). */
  | { mode: "heat" }
  /** Linear blend along one axis (fish spines, plant stems). */
  | { mode: "chain"; bones: string[]; start: Vector3; end: Vector3 }
  /** Several vertical chains blended by horizontal distance (water, smoke). */
  | { mode: "lattice"; chains: { bones: string[]; base: Vector3 }[]; minY: number; height: number; sigma: number }
  /** Rigid parts: wheels spin, everything else follows `body`. */
  | { mode: "rigid"; body: string; wheels: { bone: string; center: Vector3; radius: number; halfWidth: number }[] };

export type RigPlan = {
  category: RigCategory;
  frame: Frame;
  bones: BoneSpec[];
  skin: SkinPlan;
  /** Model height and length along `frame.forward`, used to scale motions. */
  height: number;
  length: number;
  /** Wheel bone -> radius (vehicles). */
  wheelRadius: Record<string, number>;
};

const UP = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);

function frameOf(forward: Vector3): Frame {
  const f = forward.clone().setY(0);
  if (f.lengthSq() < 1e-10) f.copy(Z);
  f.normalize();
  return { forward: f, lateral: UP.clone().cross(f).normalize(), up: UP.clone() };
}

/** Horizontal axis (X or Z) along which the model is longest. */
const longAxis = (m: ModelData) => (m.size.x >= m.size.z ? X.clone() : Z.clone());

const lerp = (a: Vector3, b: Vector3, t: number) => a.clone().lerp(b, t);

/** Point from frame coordinates: `s` along forward, `lat` along lateral, `y` height. */
const at = (fr: Frame, s: number, lat: number, y: number) =>
  fr.forward.clone().multiplyScalar(s).addScaledVector(fr.lateral, lat).setY(y);

function range(m: ModelData, axis: Vector3) {
  let min = Infinity;
  let max = -Infinity;
  const v = new Vector3();
  for (let i = 0; i < m.count; i++) {
    const s = vertexAt(m, i, v).dot(axis);
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { min, max, len: Math.max(max - min, 1e-6) };
}

/** Mean of the vertices matching `pred`, or null. */
function centroid(m: ModelData, pred: (v: Vector3) => boolean) {
  const sum = new Vector3();
  const v = new Vector3();
  let n = 0;
  for (let i = 0; i < m.count; i++) {
    if (!pred(vertexAt(m, i, v))) continue;
    sum.add(v);
    n++;
  }
  return n ? sum.divideScalar(n) : null;
}

/** Vertex with the highest `score` among those matching `pred`. */
function extreme(m: ModelData, score: (v: Vector3) => number, pred: (v: Vector3) => boolean = () => true) {
  const v = new Vector3();
  const best = m.center.clone();
  let top = -Infinity;
  for (let i = 0; i < m.count; i++) {
    vertexAt(m, i, v);
    if (!pred(v)) continue;
    const s = score(v);
    if (s > top) {
      top = s;
      best.copy(v);
    }
  }
  return best;
}

/** Sign (+1/-1) of the end of `axis` whose top is higher: animals and birds usually hold their head up. */
function higherEnd(m: ModelData, axis: Vector3) {
  const { min, len } = range(m, axis);
  let front = -Infinity;
  let back = -Infinity;
  const v = new Vector3();
  for (let i = 0; i < m.count; i++) {
    const s = (vertexAt(m, i, v).dot(axis) - min) / len;
    if (s > 0.8) front = Math.max(front, v.y);
    else if (s < 0.2) back = Math.max(back, v.y);
  }
  return front >= back ? 1 : -1;
}

/** Reflects every marker ending in "L" onto its "R" twin across the lateral mid-plane of the model. */
export function mirrorMarkers(markers: Markers, frame: Frame, center: Vector3): Markers {
  const out = { ...markers };
  const c = center.dot(frame.lateral);
  for (const [id, p] of Object.entries(markers))
    if (id.endsWith("L")) out[`${id.slice(0, -1)}R`] = p.clone().addScaledVector(frame.lateral, -2 * (p.dot(frame.lateral) - c));
  return out;
}

type Template = {
  /** All marker ids; "…R" twins are derived from "…L" while symmetry is on. */
  markers(o: RigOptions): string[];
  frame(m: ModelData, k: Markers, o: RigOptions): Frame;
  /** Initial marker positions from the mesh shape. */
  guess(m: ModelData, o: RigOptions): Markers;
  build(m: ModelData, k: Markers, o: RigOptions, fr: Frame): { bones: BoneSpec[]; skin: SkinPlan };
};

const bone = (name: string, parent: string | null, head: Vector3, tail: Vector3, deform = true): BoneSpec => ({
  name,
  parent,
  head,
  tail,
  deform,
});
/** Gates a limb bone to the side of the plane through `origin` that faces `toward`. */
const gated = (b: BoneSpec, origin: Vector3, toward: Vector3): BoneSpec => ({
  ...b,
  gate: { origin, dir: toward.clone().sub(origin).normalize() },
});
const ground = (m: ModelData, p: Vector3) => p.clone().setY(m.box.min.y);
const SIDES = [
  ["L", "Left"],
  ["R", "Right"],
] as const;

// ---------------------------------------------------------------- humanoid

const humanoid: Template = {
  markers: (o) => [
    "chin",
    "groin",
    ...(o.tail ? ["tailTip"] : []),
    ...["shoulder", "elbow", "wrist", "knee", "ankle"].flatMap((j) => [`${j}L`, `${j}R`]),
  ],
  // Characters face +Z; `flip` for models generated facing -Z.
  frame: (_m, _k, o) => frameOf(o.flip ? Z.clone().negate() : Z),
  guess(m, o) {
    const fr = humanoid.frame(m, {}, o);
    const h = m.size.y;
    const minY = m.box.min.y;
    const maxY = m.box.max.y;
    const cx = m.center.x;
    const band = 0.012 * h;
    const xsAt = (y: number) => {
      const xs: number[] = [];
      for (let i = 0; i < m.count; i++) if (Math.abs(m.positions[i * 3 + 1] - y) < band) xs.push(m.positions[i * 3]);
      return xs.sort((a, b) => a - b);
    };
    // Solid span through the center line at height y (arms held away from the body are excluded).
    const span = (y: number) => {
      const xs = xsAt(y);
      const gap = 0.04 * h;
      let i = 0;
      for (let k = 1; k < xs.length; k++) if (Math.abs(xs[k] - cx) < Math.abs(xs[i] - cx)) i = k;
      if (!xs.length || Math.abs(xs[i] - cx) > gap) return null;
      let [l, r] = [i, i];
      while (l > 0 && xs[l] - xs[l - 1] < gap) l--;
      while (r < xs.length - 1 && xs[r + 1] - xs[r] < gap) r++;
      return { left: xs[l], right: xs[r] };
    };

    // Crotch: lowest height where the mesh crosses the center line (legs apart below it).
    let groinY = minY + 0.42 * h;
    for (let t = 0.1; t < 0.75; t += 0.01) {
      if (xsAt(minY + t * h).some((x) => Math.abs(x - cx) < 0.015 * h)) {
        if (t > 0.13) groinY = minY + t * h;
        break;
      }
    }
    // Neck: narrowest center span between the chest and the top of the head.
    let neckY = minY + 0.82 * h;
    let narrowest = Infinity;
    for (let y = groinY + 0.3 * (maxY - groinY); y < maxY - 0.1 * h; y += 0.01 * h) {
      const s = span(y);
      if (s && s.right - s.left < narrowest) {
        narrowest = s.right - s.left;
        neckY = y;
      }
    }
    const chest = span(neckY - 0.08 * h);
    const halfChest = chest ? Math.min((chest.right - chest.left) / 2, 0.14 * h) : 0.1 * h;
    const shoulderL = new Vector3(cx + halfChest * 0.85, neckY - 0.035 * h, m.center.z);
    // Wrist: the arm point farthest from the shoulder, outside the torso.
    const far = extreme(
      m,
      (v) => Math.hypot(v.x - shoulderL.x, v.y - shoulderL.y),
      (v) => v.x > shoulderL.x && v.y > groinY && v.y < neckY,
    );
    const wristL =
      far.x > shoulderL.x ? lerp(shoulderL, far.setZ(m.center.z), 0.85) : shoulderL.clone().add(new Vector3(0.05 * h, -0.3 * h, 0));
    const kneeY = (minY + groinY) / 2;
    const legX = (y: number, fallback: number) => {
      const xs = xsAt(y).filter((x) => x > cx);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback;
    };
    const kneeX = legX(kneeY, cx + 0.06 * h);
    const ankleY = minY + 0.1 * (groinY - minY);

    const flat: Markers = {
      chin: new Vector3(cx, neckY + 0.02 * h, m.center.z),
      groin: new Vector3(cx, groinY, m.center.z),
      shoulderL,
      elbowL: lerp(shoulderL, wristL, 0.5),
      wristL,
      kneeL: new Vector3(kneeX, kneeY, m.center.z),
      ankleL: new Vector3(legX(ankleY, kneeX), ankleY, m.center.z),
    };
    const k: Markers = {};
    for (const [id, p] of Object.entries(flat)) k[id] = midDepth(m, p, fr.forward);
    // Tail tip: the point farthest behind the body, between the legs and the neck.
    if (o.tail) k.tailTip = extreme(m, (v) => -v.dot(fr.forward), (v) => v.y > groinY - 0.1 * h && v.y < neckY);
    const both = mirrorMarkers(k, fr, m.center);
    if (!o.flip) return both;
    // The guess puts "L" at +X, which is the character's right when it faces -Z.
    const swapped: Markers = {};
    for (const [id, p] of Object.entries(both))
      swapped[/[LR]$/.test(id) ? id.slice(0, -1) + (id.endsWith("L") ? "R" : "L") : id] = p;
    return swapped;
  },
  build(m, k, _o, fr) {
    const h = m.size.y;
    const hips = k.groin.clone().addScaledVector(UP, 0.03 * h);
    const shoulderMid = lerp(k.shoulderL, k.shoulderR, 0.5);
    const neck = shoulderMid.clone().setY(shoulderMid.y + 0.25 * Math.max(k.chin.y - shoulderMid.y, 0));
    const headTop = k.chin.clone().setY(m.box.max.y);
    const spine = lerp(hips, neck, 0.35);
    const chest = lerp(hips, neck, 0.7);
    const bones = [
      bone("Root", null, ground(m, hips), hips, false),
      bone("Hips", "Root", hips, spine),
      bone("Spine", "Hips", spine, chest),
      bone("Chest", "Spine", chest, neck),
      bone("Neck", "Chest", neck, k.chin),
      bone("Head", "Neck", k.chin, headTop),
    ];
    if (k.tailTip) {
      const base = lerp(hips, k.tailTip, 0.3);
      const joints = [0, 1 / 3, 2 / 3, 1].map((t) => lerp(base, k.tailTip, t));
      ["Tail1", "Tail2", "Tail3"].forEach((n, i) =>
        bones.push(gated(bone(n, i ? `Tail${i}` : "Hips", joints[i], joints[i + 1]), base, k.tailTip)),
      );
    }
    for (const [s, S] of SIDES) {
      const [shoulder, elbow, wrist, knee, ankle] = ["shoulder", "elbow", "wrist", "knee", "ankle"].map((j) => k[j + s]);
      const hip = new Vector3(knee.x, k.groin.y + 0.01 * h, hips.z);
      const toe = ankle.clone().addScaledVector(fr.forward, 0.07 * h).setY(m.box.min.y);
      const arm = (b: BoneSpec) => gated(b, shoulder, elbow);
      const leg = (b: BoneSpec) => gated(b, hip, knee);
      bones.push(
        arm(bone(`${S}UpperArm`, "Chest", shoulder, elbow)),
        arm(bone(`${S}LowerArm`, `${S}UpperArm`, elbow, wrist)),
        arm(bone(`${S}Hand`, `${S}LowerArm`, wrist, wrist.clone().add(wrist.clone().sub(elbow).multiplyScalar(0.35)))),
        leg(bone(`${S}UpperLeg`, "Hips", hip, knee)),
        leg(bone(`${S}LowerLeg`, `${S}UpperLeg`, knee, ankle)),
        leg(bone(`${S}Foot`, `${S}LowerLeg`, ankle, toe)),
      );
    }
    return { bones, skin: { mode: "heat" } };
  },
};

// ---------------------------------------------------------------- quadruped

/**
 * Height where a leg standing at `foot` joins the body: below it the mesh has a gap between the leg and the mid-plane
 * `midLat`, above it not. `max` when there is no gap just above the foot (legs fused together, or a misplaced marker).
 */
function legJoin(m: ModelData, fr: Frame, foot: Vector3, midLat: number, max: number) {
  const [fs, fl] = [foot.dot(fr.forward), foot.dot(fr.lateral)];
  const toMid = fr.lateral.clone().multiplyScalar(Math.sign(midLat - fl) || 1);
  const gap = (y: number) => raycastAll(m, at(fr, fs, fl, y), toMid).some((hit) => hit.distance < Math.abs(midLat - fl));
  const step = 0.01 * m.size.y;
  let y = foot.y + 5 * step;
  if (!gap(y)) return max;
  while (y < max && gap(y)) y += step;
  return Math.min(y, max);
}

const quadruped: Template = {
  markers: () => ["nose", "head", "shoulders", "hips", "tailTip", "frontFootL", "rearFootL", "frontFootR", "rearFootR"],
  frame: (_m, k) => frameOf(k.nose.clone().sub(k.tailTip)),
  guess(m) {
    const axis = longAxis(m);
    const fr = frameOf(axis.multiplyScalar(higherEnd(m, axis)));
    const { forward: F, lateral: L } = fr;
    const h = m.size.y;
    const minY = m.box.min.y;
    const { min: sMin, len } = range(m, F);
    const latC = m.center.dot(L);
    // Feet: low vertices split into a front and a rear group by forward position (2-means).
    const low: Vector3[] = [];
    const v = new Vector3();
    for (let i = 0; i < m.count; i++) if (vertexAt(m, i, v).y < minY + 0.1 * h) low.push(v.clone());
    let [front, rear] = [sMin + 0.75 * len, sMin + 0.25 * len];
    for (let it = 0; it < 6; it++) {
      const f = low.filter((p) => Math.abs(p.dot(F) - front) < Math.abs(p.dot(F) - rear));
      const r = low.filter((p) => Math.abs(p.dot(F) - front) >= Math.abs(p.dot(F) - rear));
      if (f.length) front = f.reduce((a, p) => a + p.dot(F), 0) / f.length;
      if (r.length) rear = r.reduce((a, p) => a + p.dot(F), 0) / r.length;
    }
    const halfWidth = Math.abs(m.size.x * L.x + m.size.z * L.z) / 2;
    const footLat = (s: number) => {
      const side = low.filter((p) => Math.abs(p.dot(F) - s) < 0.12 * len && p.dot(L) > latC);
      return side.length ? side.reduce((a, p) => a + p.dot(L), 0) / side.length : latC + 0.5 * halfWidth;
    };
    // Spine height above a leg pair: a third of the way down from the back (legs continue the torso downward,
    // so the mesh's own top/bottom midpoint would land in the leg).
    const torso = (s: number) => {
      const back = raycastAll(m, at(fr, s, latC, m.box.max.y + h), UP.clone().negate())[0]?.point.y ?? minY + 0.75 * h;
      return at(fr, s, latC, back - 0.3 * (back - minY));
    };
    // Head: only thick parts count, so thin sheets sticking out in front (leaves, ears, horns) aren't taken for it.
    const th = thickness(m);
    const solid = (i: number) => th(i) > 0.1 * h;
    const ahead = Float32Array.from({ length: m.count }, (_, i) => vertexAt(m, i, v).dot(F));
    const tip = Array.from(ahead.keys()).sort((a, b) => ahead[b] - ahead[a]).find(solid);
    const nose = midDepth(m, tip === undefined ? extreme(m, (p) => p.dot(F)) : vertexAt(m, tip), L);
    const shoulders = torso(front);
    // Skull center: a little behind the nose, halfway between the nose and the top of the head.
    const headS = lerp(nose, shoulders, 0.2).dot(F);
    const skullTop =
      raycastAll(m, at(fr, headS, latC, m.box.max.y + h), UP.clone().negate()).find((hit) => hit.face && solid(hit.face.a))
        ?.point.y ?? nose.y;
    const k: Markers = {
      nose,
      head: midDepth(m, at(fr, headS, latC, (Math.max(skullTop, nose.y) + nose.y) / 2), L),
      shoulders,
      hips: torso(rear),
      tailTip: midDepth(m, extreme(m, (p) => -p.dot(F)), L),
      frontFootL: at(fr, front, footLat(front), minY + 0.03 * h),
      rearFootL: at(fr, rear, footLat(rear), minY + 0.03 * h),
    };
    return mirrorMarkers(k, fr, m.center);
  },
  build(m, k, _o, fr) {
    const h = m.size.y;
    const { forward: F, lateral: L } = fr;
    const len = range(m, F).len;
    const spine = lerp(k.hips, k.shoulders, 0.5);
    const neck = lerp(k.shoulders, k.head, 0.45);
    const bones = [
      bone("Root", null, ground(m, spine), k.hips, false),
      bone("Hips", "Root", k.hips, spine),
      bone("Spine", "Hips", spine, k.shoulders),
      bone("Chest", "Spine", k.shoulders, neck),
      bone("Neck", "Chest", neck, k.head),
      bone("Head", "Neck", k.head, k.nose),
      bone("Tail1", "Hips", lerp(k.hips, k.tailTip, 0.3), lerp(k.hips, k.tailTip, 0.55)),
      bone("Tail2", "Tail1", lerp(k.hips, k.tailTip, 0.55), lerp(k.hips, k.tailTip, 0.8)),
      bone("Tail3", "Tail2", lerp(k.hips, k.tailTip, 0.8), k.tailTip),
    ];
    for (const [pos, top, parent] of [
      ["Front", k.shoulders, "Chest"],
      ["Rear", k.hips, "Hips"],
    ] as const)
      for (const [s] of SIDES) {
        const foot = k[`${pos.toLowerCase()}Foot${s}`];
        const [fs, fl] = [foot.dot(F), foot.dot(L)];
        const midLat = lerp(k[`${pos.toLowerCase()}FootL`], k[`${pos.toLowerCase()}FootR`], 0.5).dot(L);
        const hipY = foot.y + 0.85 * (top.y - foot.y);
        const upper = at(fr, fs, fl, Math.min(hipY, legJoin(m, fr, foot, midLat, hipY) + 0.1 * (top.y - foot.y)));
        const lower = at(fr, fs, fl, foot.y + (0.45 / 0.85) * (upper.y - foot.y));
        const paw = at(fr, fs, fl, foot.y + 0.05 * h);
        const leg = (b: BoneSpec) => gated(b, upper, lower);
        bones.push(
          leg(bone(`${pos}UpperLeg${s}`, parent, upper, lower)),
          leg(bone(`${pos}LowerLeg${s}`, `${pos}UpperLeg${s}`, lower, paw)),
          leg(bone(`${pos}Foot${s}`, `${pos}LowerLeg${s}`, paw, paw.clone().addScaledVector(F, 0.04 * len).setY(m.box.min.y))),
        );
      }
    return { bones, skin: { mode: "heat" } };
  },
};

// ---------------------------------------------------------------- bird

const bird: Template = {
  markers: () => ["head", "chest", "tailTip", "wingTipL", "footL", "wingTipR", "footR"],
  frame: (_m, k) => frameOf(k.head.clone().sub(k.tailTip)),
  guess(m) {
    const h = m.size.y;
    const minY = m.box.min.y;
    const top = centroid(m, (v) => v.y > m.box.max.y - 0.1 * h) ?? m.center.clone();
    const axis = longAxis(m);
    const fr = frameOf(axis.multiplyScalar(Math.sign(top.clone().sub(m.center).dot(axis)) || 1));
    const { forward: F, lateral: L } = fr;
    const { len } = range(m, F);
    const latC = m.center.dot(L);
    const halfWidth = Math.abs(m.size.x * L.x + m.size.z * L.z) / 2;
    const head = midDepth(m, top, L);
    const tailTip = midDepth(m, extreme(m, (v) => -v.dot(F)), L);
    const chest = midDepth(m, at(fr, m.center.dot(F), latC, m.box.max.y), UP);
    const spread = halfWidth > 0.35 * len;
    const wingTipL = spread
      ? extreme(m, (v) => v.dot(L), (v) => v.y > minY + 0.3 * h)
      : at(fr, lerp(chest, tailTip, 0.6).dot(F), latC + 0.6 * halfWidth, chest.y);
    const foot = centroid(m, (v) => v.y < minY + 0.06 * h && v.dot(L) > latC);
    const k: Markers = {
      head,
      chest,
      tailTip,
      wingTipL,
      footL: foot ?? at(fr, chest.dot(F), latC + 0.3 * halfWidth, minY),
    };
    return mirrorMarkers(k, fr, m.center);
  },
  build(m, k, _o, fr) {
    const h = m.size.y;
    const { forward: F, lateral: L } = fr;
    const len = range(m, F).len;
    const hips = lerp(k.chest, k.tailTip, 0.3);
    const neck = lerp(k.chest, k.head, 0.5);
    const bones = [
      bone("Root", null, ground(m, k.chest), hips, false),
      bone("Hips", "Root", hips, k.chest),
      bone("Chest", "Hips", k.chest, neck),
      bone("Neck", "Chest", neck, k.head),
      bone("Head", "Neck", k.head, k.head.clone().addScaledVector(F, 0.08 * len)),
      bone("Tail", "Hips", lerp(hips, k.tailTip, 0.4), k.tailTip),
    ];
    for (const [s] of SIDES) {
      const tip = k[`wingTip${s}`];
      const out = (tip.dot(L) - k.chest.dot(L)) * 0.35;
      const shoulder = k.chest.clone().addScaledVector(L, out).addScaledVector(UP, 0.08 * h);
      const mid = lerp(shoulder, tip, 0.5).addScaledVector(UP, 0.03 * h);
      const foot = k[`foot${s}`];
      const hip = at(fr, foot.dot(F), foot.dot(L), foot.y + 0.7 * (hips.y - foot.y));
      bones.push(
        bone(`Wing1${s}`, "Chest", shoulder, mid),
        bone(`Wing2${s}`, `Wing1${s}`, mid, tip),
        bone(`Leg${s}`, "Hips", hip, foot.clone().addScaledVector(UP, 0.03 * h)),
        bone(`Foot${s}`, `Leg${s}`, foot.clone().addScaledVector(UP, 0.03 * h), foot.clone().addScaledVector(F, 0.05 * len)),
      );
    }
    return { bones, skin: { mode: "heat" } };
  },
};

// ---------------------------------------------------------------- chains: fish, plants, water/smoke

function chainBones(m: ModelData, names: string[], start: Vector3, end: Vector3, stops: number[]) {
  const joints = stops.map((t) => lerp(start, end, t));
  const bones = [bone("Root", null, ground(m, lerp(start, end, 0.5)), joints[0], false)];
  names.forEach((n, i) => bones.push(bone(n, i ? names[i - 1] : "Root", joints[i], joints[i + 1] ?? end)));
  return bones;
}

const fish: Template = {
  markers: () => ["head", "tailTip"],
  frame: (_m, k) => frameOf(k.head.clone().sub(k.tailTip)),
  guess(m) {
    const axis = longAxis(m);
    // The head end is the heavier one.
    const { min, len } = range(m, axis);
    let [front, back] = [0, 0];
    const v = new Vector3();
    for (let i = 0; i < m.count; i++) {
      const s = (vertexAt(m, i, v).dot(axis) - min) / len;
      if (s > 0.7) front++;
      else if (s < 0.3) back++;
    }
    const F = axis.multiplyScalar(front >= back ? 1 : -1);
    const L = UP.clone().cross(F).normalize();
    const mid = (p: Vector3) => midDepth(m, midDepth(m, p, L), UP);
    return { head: mid(extreme(m, (p) => p.dot(F))), tailTip: mid(extreme(m, (p) => -p.dot(F))) };
  },
  build(m, k) {
    const names = ["Spine1", "Spine2", "Spine3", "Spine4", "Spine5", "Spine6"];
    return {
      bones: chainBones(m, names, k.head, k.tailTip, [0.08, 0.25, 0.42, 0.58, 0.72, 0.86]),
      skin: { mode: "chain", bones: names, start: k.head, end: k.tailTip },
    };
  },
};

const plant: Template = {
  markers: () => ["base", "top"],
  frame: () => frameOf(Z),
  guess(m) {
    const h = m.size.y;
    const base = centroid(m, (v) => v.y < m.box.min.y + 0.05 * h) ?? m.center.clone();
    const top = centroid(m, (v) => v.y > m.box.max.y - 0.08 * h) ?? m.center.clone();
    return { base: base.setY(m.box.min.y), top };
  },
  build(m, k) {
    const names = ["Trunk1", "Trunk2", "Trunk3", "Trunk4", "Trunk5"];
    return {
      bones: chainBones(m, names, k.base, k.top, [0, 0.2, 0.4, 0.6, 0.8]),
      skin: { mode: "chain", bones: names, start: k.base, end: k.top },
    };
  },
};

const fluid: Template = {
  markers: () => [],
  frame: () => frameOf(Z),
  guess: () => ({}),
  build(m) {
    const { box, size, center } = m;
    const root = ground(m, center);
    const bones = [bone("Root", null, root, center, false)];
    const chains: { bones: string[]; base: Vector3 }[] = [];
    [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].forEach(([dx, dz], c) => {
      const base = new Vector3(center.x + dx * 0.25 * size.x, box.min.y, center.z + dz * 0.25 * size.z);
      const names = [1, 2, 3].map((j) => `Flow${c + 1}_${j}`);
      names.forEach((n, j) => {
        const head = base.clone().setY(box.min.y + (j / 3) * size.y);
        bones.push(bone(n, j ? names[j - 1] : "Root", head, head.clone().setY(box.min.y + ((j + 1) / 3) * size.y)));
      });
      chains.push({ bones: names, base });
    });
    return {
      bones,
      skin: { mode: "lattice", chains, minY: box.min.y, height: size.y, sigma: 0.35 * Math.max(size.x, size.z) },
    };
  },
};

// ---------------------------------------------------------------- rigid: vehicles, aircraft, props

const vehicle: Template = {
  markers: (o) =>
    Array.from({ length: o.wheels }, (_, i) => (o.symmetry ? [`wheel${i + 1}L`, `wheel${i + 1}R`] : [`wheel${i + 1}L`])).flat(),
  frame: (m, _k, o) => frameOf(longAxis(m).multiplyScalar(o.flip ? -1 : 1)),
  guess(m, o) {
    const fr = vehicle.frame(m, {}, o);
    const { forward: F, lateral: L } = fr;
    const h = m.size.y;
    const { min, max, len } = range(m, F);
    const r = Math.min(0.22 * h, 0.12 * len);
    const lat = o.symmetry ? range(m, L).max - 0.5 * r : m.center.dot(L);
    // Wheels touch the ground: group ground-contact vertices along the length.
    const contacts: number[] = [];
    const v = new Vector3();
    for (let i = 0; i < m.count; i++) if (vertexAt(m, i, v).y < m.box.min.y + 0.02 * h) contacts.push(v.dot(F));
    contacts.sort((a, b) => b - a);
    const groups: number[][] = [];
    for (const s of contacts)
      if (groups.length && groups[groups.length - 1].at(-1)! - s < 0.08 * len) groups[groups.length - 1].push(s);
      else groups.push([s]);
    const centers = groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
    const k: Markers = {};
    for (let i = 0; i < o.wheels; i++) {
      // wheel1 at the front: spread over the contact groups when there are enough, else evenly along the length
      const s =
        centers.length >= o.wheels
          ? centers[o.wheels === 1 ? 0 : Math.round((i / (o.wheels - 1)) * (centers.length - 1))]
          : o.wheels === 1
            ? (min + max) / 2
            : max - 0.15 * len - (i / (o.wheels - 1)) * 0.7 * len;
      const p = at(fr, s, lat, m.box.min.y + r);
      k[`wheel${i + 1}L`] = o.symmetry ? midDepth(m, p, L) : p;
    }
    return o.symmetry ? mirrorMarkers(k, fr, m.center) : k;
  },
  build(m, k, _o, fr) {
    const L = fr.lateral;
    const root = ground(m, m.center);
    const bones = [
      bone("Root", null, root, m.center, false),
      bone("Body", "Root", m.center, m.center.clone().addScaledVector(UP, 0.3 * m.size.y)),
    ];
    const wheels: Extract<SkinPlan, { mode: "rigid" }>["wheels"] = [];
    for (const [id, center] of Object.entries(k)) {
      const name = `Wheel${id.slice(5)}`;
      const radius = Math.max(center.y - m.box.min.y, 0.02 * m.size.y);
      // Wheel thickness from the side ray that placed the marker in the middle of the tyre.
      const hits = raycastAll(m, center.clone().addScaledVector(L, m.size.length()), L.clone().negate());
      const thick = hits.length > 1 ? Math.abs(hits[1].point.dot(L) - hits[0].point.dot(L)) : 0.6 * radius;
      bones.push(bone(name, "Root", center, center.clone().addScaledVector(L, 0.2 * radius)));
      wheels.push({ bone: name, center, radius, halfWidth: Math.min(Math.max(thick * 0.55, 0.1 * radius), 0.7 * radius) });
    }
    return { bones, skin: { mode: "rigid", body: "Body", wheels } };
  },
};

const rigidBody = (forward: (m: ModelData, o: RigOptions) => Vector3, rootAtCenter: boolean): Template => ({
  markers: () => [],
  frame: (m, _k, o) => frameOf(forward(m, o)),
  guess: () => ({}),
  build: (m) => ({
    bones: [
      bone("Root", null, rootAtCenter ? m.center.clone() : ground(m, m.center), m.center, false),
      bone("Body", "Root", m.center, m.center.clone().addScaledVector(UP, 0.3 * m.size.y)),
    ],
    skin: { mode: "rigid", body: "Body", wheels: [] },
  }),
});

const TEMPLATES: Record<RigCategory, Template> = {
  humanoid,
  quadruped,
  bird,
  fish,
  vehicle,
  // Aircraft pivot around their center so banking and looping look right.
  aircraft: rigidBody((m, o) => longAxis(m).multiplyScalar(o.flip ? -1 : 1), true),
  plant,
  fluid,
  prop: rigidBody(() => Z.clone(), false),
};

/** Marker ids for a category, and which of them follow their left twin while symmetry is on. */
export function markerIds(category: RigCategory, o: RigOptions) {
  const ids = TEMPLATES[category].markers(o);
  const derived = new Set(o.symmetry ? ids.filter((id) => id.endsWith("R") && ids.includes(`${id.slice(0, -1)}L`)) : []);
  return { ids, derived };
}

export const guessMarkers = (category: RigCategory, m: ModelData, o: RigOptions) => TEMPLATES[category].guess(m, o);

export const rigFrame = (category: RigCategory, m: ModelData, k: Markers, o: RigOptions) =>
  TEMPLATES[category].frame(m, k, o);

/** Re-derives mirrored markers after `k` changed. */
export function syncMirror(category: RigCategory, m: ModelData, k: Markers, o: RigOptions): Markers {
  return o.symmetry && markerIds(category, o).derived.size ? mirrorMarkers(k, rigFrame(category, m, k, o), m.center) : k;
}

/** Camera axis for placing markers: characters from the front, animals and vehicles from the side. */
export function markerView(category: RigCategory, m: ModelData, k: Markers, o: RigOptions): Vector3 {
  if (["humanoid", "plant", "fluid", "prop"].includes(category)) return Z.clone();
  return rigFrame(category, m, k, o).lateral.clone();
}

/**
 * Plan for a model rigged by the AI auto-rigger: its own skeleton stays as predicted, and a "Root" bone at the ground
 * center above it carries the whole-model clips (move, turn, scale, bounce), whatever the predicted bones are named.
 */
export function autoRigPlan(m: ModelData): RigPlan {
  const frame = frameOf(Z);
  return {
    category: "prop",
    frame,
    bones: [bone("Root", null, ground(m, m.center), m.center.clone(), false)],
    skin: { mode: "rigid", body: "Root", wheels: [] },
    height: m.size.y,
    length: range(m, frame.forward).len,
    wheelRadius: {},
  };
}

export function planRig(category: RigCategory, m: ModelData, k: Markers, o: RigOptions): RigPlan {
  const t = TEMPLATES[category];
  const frame = t.frame(m, k, o);
  const { bones, skin } = t.build(m, k, o, frame);
  const wheelRadius: Record<string, number> = {};
  if (skin.mode === "rigid") for (const w of skin.wheels) wheelRadius[w.bone] = w.radius;
  return { category, frame, bones, skin, height: m.size.y, length: range(m, frame.forward).len, wheelRadius };
}
