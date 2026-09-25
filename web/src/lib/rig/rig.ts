import { Line3, Vector3 } from "three";
import type { RigCategory } from "./categories";
import { midDepth, type ModelData, nearestDepth, raycastAll, thickness, vertexAt } from "./model";
import { adjacency, MinHeap } from "./skin";

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
  /** Bendable trunk from the head to the nose, e.g. an elephant's (animals). */
  trunk: boolean;
  /** Hinged lower jaw that opens and closes (animals, serpents). */
  jaw: boolean;
  /** Horns, tusks or antlers on the head: 0, 1 (a rhino's) or 2 (a pair) (animals). */
  horns: number;
  /** Two wings with shoulder, elbow and wrist joints, e.g. an angel or a western dragon. */
  wings: boolean;
  /** Walks on the hind legs, the front limbs are arms, e.g. a carnivorous dinosaur (animals). */
  bipedal: boolean;
  /** Four short legs along the body, e.g. an Asian dragon (serpents). */
  legs: boolean;
  /** Pair of pectoral fins with three joints each: a fish's or a dolphin's fins, a manta ray's wings (sea life). */
  fins: boolean;
  /** How it swims (sea life): see `SwimStyle`. */
  swim: SwimStyle;
  /**
   * Pairs of soft feelers: whiskers, antennae, tentacles, frills, floppy ears (characters, animals, birds, serpents,
   * sea life). Each is a three-link chain from its root to its tip that trails the body's motion; no hitbox.
   */
  feelers: number;
  /** Weapon held in each hand (characters): it gets its own bone, so attacks swing, aim and hit with it. */
  weaponRight: Weapon;
  weaponLeft: Weapon;
};
export const DEFAULT_RIG_OPTIONS: RigOptions = {
  symmetry: true,
  flip: false,
  wheels: 2,
  tail: false,
  trunk: false,
  jaw: false,
  horns: 0,
  wings: false,
  bipedal: false,
  legs: false,
  fins: false,
  swim: "fish",
  feelers: 0,
  weaponRight: "none",
  weaponLeft: "none",
};

export const WEAPONS = ["none", "sword", "axe", "hammer", "spear", "shield", "bow", "crossbow", "pistol", "rifle"] as const;
export type Weapon = (typeof WEAPONS)[number];
/** Part of a weapon bone (fractions from its end marker to its tip) that deals damage: a blade, a hammer's head. */
const STRIKE: Partial<Record<Weapon, [number, number]>> = {
  sword: [0.25, 1],
  axe: [0.65, 1],
  hammer: [0.65, 1],
  spear: [0.7, 1],
  shield: [0, 1],
};

/**
 * Sea life: "fish" beats its tail side to side, "whale" up and down (whales, dolphins: horizontal flukes), "ray" flaps
 * its fins like wings and trails its tail (manta rays, stingrays).
 */
export const SWIM_STYLES = ["fish", "whale", "ray"] as const;
export type SwimStyle = (typeof SWIM_STYLES)[number];

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
   * one, so short limbs close to the body (cartoon characters) don't claim the torso, the head or a tail. With `fade`,
   * the bone has no weight at all beyond that distance behind the plane, and mixes only with its parent among the
   * trunk bones: a flapping wing then leaves the head, the midline and the other wing alone.
   */
  gate?: { origin: Vector3; dir: Vector3; fade?: number };
  /** Rigid part (a weapon): vertices that take it as their nearest bone follow only it, so it never bends. */
  rigid?: boolean;
  /** Part of the bone that deals damage (fractions head -> tail), for its hitbox. Default: all of it. */
  strike?: [number, number];
};

export type SkinPlan =
  /** Heat diffusion from the nearest visible bone (characters). */
  | { mode: "heat" }
  /** Linear blend along one axis (fish spines, plant stems). */
  | { mode: "chain"; bones: string[]; start: Vector3; end: Vector3 }
  /** Several vertical chains blended by horizontal distance (water, smoke). */
  | { mode: "lattice"; chains: { bones: string[]; base: Vector3 }[]; minY: number; height: number; sigma: number }
  /** Rigid parts: wheels spin, doors swing, everything else follows `body`. */
  | { mode: "rigid"; body: string; wheels: { bone: string; center: Vector3; radius: number; halfWidth: number }[]; doors?: Door[] };

/**
 * Door leaf (buildings): the part of the surface within `depth` of the door plane, in the rectangle from `hinge` (its
 * bottom corner on the hinge side) across `width` (horizontal, to the opening edge) and up `height`. `normal` points out.
 */
export type Door = { bone: string; hinge: Vector3; width: Vector3; height: number; normal: Vector3; depth: number };

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
  /**
   * Humanoids: lowest upper-arm angle in the frontal plane (as in the clips: 0 = T-pose, -π/2 = hanging) at which the
   * forearm and hand still clear the leg on their side. Bulky arms must stay out from the body.
   */
  armFloor?: { Left: number; Right: number };
  /** Humanoids: what each hand holds ("Weapon" + side is its bone). */
  weapons?: { Left: Weapon; Right: Weapon };
  /** Sea life: how it swims. */
  swim?: SwimStyle;
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
  /** Initial marker positions from the mesh shape (plus hidden helper markers the build may use, not in `markers`). */
  guess(m: ModelData, o: RigOptions): Markers;
  build(m: ModelData, k: Markers, o: RigOptions, fr: Frame): Pick<RigPlan, "bones" | "skin" | "armFloor" | "weapons" | "swim">;
  /** False when left and right can't be mirrored across one plane (a coiled serpent). */
  mirror?: false;
  /** "…R" markers placed on their own even while symmetry is on. */
  unmirrored?(o: RigOptions): string[];
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

/** Limb radius at `p` (inside the mesh): median distance to the surface across the limb running along `axis`. */
function radiusAt(m: ModelData, p: Vector3, axis: Vector3) {
  const a = axis.clone().normalize();
  const u = new Vector3().crossVectors(a, Math.abs(a.y) < 0.9 ? UP : X).normalize();
  const w = new Vector3().crossVectors(a, u);
  const d = Array.from({ length: 8 }, (_, i) => {
    const t = (i / 8) * 2 * Math.PI;
    const dir = u.clone().multiplyScalar(Math.cos(t)).addScaledVector(w, Math.sin(t));
    return raycastAll(m, p, dir)[0]?.distance ?? 0;
  }).sort((x, y) => x - y);
  return (d[3] + d[4]) / 2;
}

/** Distance between segments ab and cd in the plane (points given as [x, y]). */
function segDist2(a: number[], b: number[], c: number[], d: number[]) {
  const pt = (p: number[], s: number[], e: number[]) => {
    const [dx, dy] = [e[0] - s[0], e[1] - s[1]];
    const t = Math.min(1, Math.max(0, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / Math.max(dx * dx + dy * dy, 1e-12)));
    return Math.hypot(p[0] - s[0] - t * dx, p[1] - s[1] - t * dy);
  };
  const cross = (o: number[], p: number[], q: number[]) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b));
}
const SIDES = [
  ["L", "Left"],
  ["R", "Right"],
] as const;

/**
 * Wing chain from `root` through the elbow and wrist markers to the tip: fold, spread and flap need all three joints.
 * `mid` (a point on the body's mid-plane, and its lateral axis) gates the wing sideways, off the half of the body
 * between its root and the mid-plane.
 */
function wingBones(k: Markers, s: string, parent: string, root: Vector3, mid?: { at: Vector3; lateral: Vector3 }) {
  const [elbow, wrist, tip] = ["wingElbow", "wingWrist", "wingTip"].map((j) => k[j + s]);
  const wing = (b: BoneSpec): BoneSpec => {
    if (!mid) return gated(b, root, elbow);
    const dir = mid.lateral.clone().multiplyScalar(Math.sign(elbow.clone().sub(root).dot(mid.lateral)) || 1);
    return { ...b, gate: { origin: root, dir, fade: 0.5 * root.clone().sub(mid.at).dot(dir) } };
  };
  return [
    wing(bone(`WingUpper${s}`, parent, root, elbow)),
    wing(bone(`WingFore${s}`, `WingUpper${s}`, elbow, wrist)),
    wing(bone(`WingHand${s}`, `WingFore${s}`, wrist, tip)),
  ];
}

/** Jaw from a hinge under the skull to the chin, gated below the mouth line so the upper jaw stays on the head. */
function jawBone(k: Markers, fr: Frame, upperLip: Vector3) {
  const { forward: F, lateral: L } = fr;
  const hinge = at(
    fr,
    k.head.dot(F) - 0.15 * (k.jawTip.dot(F) - k.head.dot(F)),
    k.head.dot(L),
    k.head.y - 0.5 * (k.head.y - k.jawTip.y),
  );
  const jaw = gated(bone("Jaw", "Head", hinge, k.jawTip), lerp(upperLip, k.jawTip, 0.5), k.jawTip);
  // Enforce the mouth boundary during diffusion too, not only nearest-bone seeding.
  // Without this, jaw heat spreads into the skull and neck and opening the mouth stretches the face.
  return { ...jaw, gate: { ...jaw.gate!, fade: 0 } };
}

/** Horns, tusks or antlers ("hornTip", "hornTipL", "hornTipR" markers): rigid links from the head to each tip. */
const hornBones = (k: Markers) =>
  Object.keys(k)
    .filter((id) => id.startsWith("hornTip"))
    .map((id) => {
      const base = lerp(k[id], k.head, 0.5);
      return gated(bone(`Horn${id.slice(7)}`, "Head", base, k[id]), base, k[id]);
    });

// ---------------------------------------------------------------- humanoid

/**
 * Follows an arm's center line out from the shoulder on the `sgn` side (+X or -X), one cross-section at a
 * time (rays across the arm from the current point: the middle of each opposite pair of hits), until it leaves the
 * mesh (the finger tips, the fist). The wrist is the narrowest section between the forearm and the hand (the widest
 * section near the end), the elbow the middle of the traced line up to it. Null when the trace is too short to trust.
 */
function traceArm(m: ModelData, shoulder: Vector3, sgn: 1 | -1, groinY: number, forward = Z, bodyHeight = m.size.y, accept: (v: Vector3) => boolean = () => true) {
  const h = bodyHeight;
  const step = 0.02 * h;
  // First direction: toward the arm a little way out from the shoulder (a ring around it, off the torso).
  const start = centroid(m, (v) => {
    const d = v.distanceTo(shoulder);
    return accept(v) && d > 0.1 * h && d < 0.18 * h && sgn * (v.x - shoulder.x) > 0.05 * h && v.y > groinY;
  });
  if (!start) return null;
  const dir = start.setZ(shoulder.z).sub(shoulder).normalize();
  const path = [shoulder.clone()];
  const radii = [Infinity];
  const p = midDepth(m, shoulder, forward);
  for (let i = 0; i < 100; i++) {
    const q = p.clone().addScaledVector(dir, step);
    const u = new Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? UP : X).normalize();
    const w = new Vector3().crossVectors(dir, u);
    const mids: Vector3[] = [];
    const halves: number[] = [];
    for (let k = 0; k < 6; k++) {
      const t = (k / 6) * Math.PI;
      const a = u.clone().multiplyScalar(Math.cos(t)).addScaledVector(w, Math.sin(t));
      const [h1, h2] = [raycastAll(m, q, a)[0], raycastAll(m, q, a.clone().negate())[0]];
      // Both sides hit (inside a limb) and not across a gap to another part.
      if (!h1 || !h2 || h1.distance + h2.distance > 0.3 * h) continue;
      mids.push(h1.point.clone().add(h2.point).multiplyScalar(0.5));
      halves.push((h1.distance + h2.distance) / 2);
    }
    if (mids.length < 4) {
      // Next to the shoulder the rays across run down the torso: keep going out.
      if (path.length === 1 && q.distanceTo(shoulder) < 0.25 * h) {
        p.copy(q);
        continue;
      }
      break;
    }
    const c = mids.reduce((acc, x) => acc.add(x), new Vector3()).divideScalar(mids.length);
    if (!accept(c)) break;
    dir.lerp(c.clone().sub(p).normalize(), 0.5).normalize();
    p.copy(c);
    path.push(c.clone());
    radii.push(halves.sort((x, y) => x - y)[halves.length >> 1]);
  }
  const n = path.length;
  if (n < 6) return null;
  // Hand: the widest section in the last third; wrist: the narrowest one between the middle and it.
  let hand = n - 1;
  for (let i = Math.floor(0.66 * n); i < n; i++) if (radii[i] > radii[hand]) hand = i;
  let wrist = Math.floor(0.8 * n);
  let best = Infinity;
  for (let i = Math.floor(0.45 * n); i < hand; i++) if (radii[i] < best) [best, wrist] = [radii[i], i];
  // Elbow: halfway along the arm to the wrist.
  const along = [0];
  for (let i = 1; i <= wrist; i++) along.push(along[i - 1] + path[i].distanceTo(path[i - 1]));
  const half = along[wrist] / 2;
  const e = along.findIndex((x) => x >= half);
  const t = (half - along[e - 1]) / Math.max(along[e] - along[e - 1], 1e-9);
  // The shoulder joint sits on the arm's center line, not on top of the shoulder.
  return { elbow: lerp(path[e - 1], path[e], t), wrist: path[wrist].clone(), shoulderY: path[Math.min(2, wrist)].y };
}

const weaponOf = (o: RigOptions, side: "Left" | "Right") => (side === "Left" ? o.weaponLeft : o.weaponRight);

/**
 * Weapon held in the hand at `wrist`: the mesh reached over the surface from the fist without going back up the
 * forearm. Its tip is the far end of it seen from the fist (blade tip, hammer head, muzzle, top of a bow or shield),
 * its end the opposite one (pommel, handle end, stock). Both are the middle of the last few percent at each end. A
 * weapon fused to the body elsewhere floods into it: then the guess is a short stick along the forearm, to drag.
 */
function guessWeapon(m: ModelData, elbow: Vector3, wrist: Vector3) {
  const h = m.size.y;
  const fore = wrist.clone().sub(elbow);
  const d = fore.clone().normalize();
  // The hand, as its bone runs (see the humanoid build).
  const fist = wrist.clone().addScaledVector(fore, 0.18);
  const knuckles = wrist.clone().addScaledVector(fore, 0.35);
  // Forearm radius: the widest of two samples (a shield in front of the wrist cuts the rays short there).
  const armR = Math.max(radiusAt(m, lerp(elbow, wrist, 0.7), d), radiusAt(m, lerp(elbow, wrist, 0.4), d), 0.01 * h);
  const fallback = { end: wrist.clone(), tip: wrist.clone().addScaledVector(d, 0.3 * h) };
  const v = new Vector3();
  const q = new Vector3();
  // The forearm, from a bit behind the wrist (the wrist marker is a guess, a handle can pass right at it) back to the
  // elbow: the flood may not cross it.
  const cut = lerp(wrist, elbow, 0.25);
  const blocked = (i: number) => {
    vertexAt(m, i, v);
    if (q.copy(v).sub(cut).dot(d) >= 0) return false;
    const t = Math.min(1, Math.max(0, q.copy(v).sub(elbow).dot(fore) / fore.lengthSq()));
    return v.distanceTo(q.copy(elbow).addScaledVector(fore, t)) < 2 * armR;
  };
  const { offs, adj } = adjacency(m);
  const dist = new Float64Array(m.count).fill(Infinity);
  const heap = new MinHeap();
  // Seeds all around the hand: a handle modelled as its own part only touches the fist somewhere.
  const seed = Math.max(1.5 * armR, 0.03 * h);
  for (let i = 0; i < m.count; i++) {
    vertexAt(m, i, v);
    const t = Math.min(1, Math.max(0, q.copy(v).sub(wrist).dot(d) / knuckles.distanceTo(wrist)));
    if (v.distanceTo(q.copy(wrist).lerp(knuckles, t)) < seed && !blocked(i)) heap.push(0, i, 0);
  }
  const region: number[] = [];
  const w = new Vector3();
  while (heap.size) {
    const [g, i] = heap.pop();
    if (g >= dist[i]) continue;
    dist[i] = g;
    region.push(i);
    vertexAt(m, i, v);
    for (let e = offs[i]; e < offs[i + 1]; e++) {
      const j = adj[e];
      const gj = g + v.distanceTo(vertexAt(m, j, w));
      if (gj < dist[j] && gj < 0.9 * h && !blocked(j)) heap.push(gj, j, 0);
    }
  }
  if (region.length < 3 || region.length > 0.3 * m.count) return fallback;
  const pts = region.map((i) => vertexAt(m, i, new Vector3()));
  const far = (from: Vector3) => pts.reduce((a, p) => (p.distanceToSquared(from) > a.distanceToSquared(from) ? p : a));
  let tip = far(fist);
  let end = far(tip);
  if (tip.distanceTo(end) < 0.05 * h) return fallback;
  // The farthest points are corners (of a hammer's head): re-center both ends on the slabs across the axis, a few
  // times, so the axis runs down the middle.
  for (let it = 0; it < 4; it++) {
    const axis = tip.clone().sub(end);
    const len2 = axis.lengthSq();
    const slab = (lo: number, hi: number, keep: Vector3) => {
      const sum = new Vector3();
      let n = 0;
      for (const p of pts) {
        const s = q.copy(p).sub(end).dot(axis) / len2;
        if (s >= lo && s <= hi) {
          sum.add(p);
          n++;
        }
      }
      return n ? sum.divideScalar(n) : keep;
    };
    [end, tip] = [slab(-Infinity, 0.06, end), slab(0.94, Infinity, tip)];
  }
  return { end, tip };
}

const humanoid: Template = {
  markers: (o) => [
    "chin",
    "groin",
    ...(o.tail ? ["tailTip"] : []),
    ...(o.wings ? ["wingRoot", "wingElbow", "wingWrist", "wingTip"].flatMap((j) => [`${j}L`, `${j}R`]) : []),
    ...["shoulder", "elbow", "wrist", "knee", "ankle"].flatMap((j) => [`${j}L`, `${j}R`]),
    ...SIDES.flatMap(([, S]) => (weaponOf(o, S) === "none" ? [] : [`weaponEnd${S}`, `weaponTip${S}`])),
  ],
  // Holding a weapon, the arms are posed differently: each keeps its own markers.
  unmirrored: (o) => (o.weaponLeft !== "none" || o.weaponRight !== "none" ? ["elbowR", "wristR"] : []),
  // Characters face +Z; `flip` for models generated facing -Z.
  frame: (_m, _k, o) => frameOf(o.flip ? Z.clone().negate() : Z),
  guess(m, o) {
    const fr = humanoid.frame(m, {}, o);
    const minY = m.box.min.y;
    let maxY = m.box.max.y;
    const h0 = m.size.y;
    // Wings can rise above the skull: measure the central body column instead.
    if (o.wings) {
      const feet = centroid(m, (v) => v.y < minY + 0.06 * h0) ?? m.center;
      maxY = extreme(m, (v) => v.y, (v) => Math.abs(v.x - feet.x) < 0.1 * h0).y;
    }
    const h = Math.max(maxY - minY, 0.1 * h0);
    // Center line: halfway between the feet, as a weapon held out to one side widens the bounding box (and a dense
    // one pulls the median of the vertices).
    let [footMin, footMax] = [Infinity, -Infinity];
    for (let i = 0; i < m.count; i++)
      if (m.positions[i * 3 + 1] < minY + 0.06 * h) [footMin, footMax] = [Math.min(footMin, m.positions[i * 3]), Math.max(footMax, m.positions[i * 3])];
    const cx = footMin < footMax ? (footMin + footMax) / 2 : m.center.x;
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
    // Body cross-section on the center line at height y, measured with rays (sampling vertices in a thin band misses
    // the big flat faces of low-poly meshes): the middle of the thickest solid run front to back (not an arm held in
    // front of the body), and the half-width from there out to both sides.
    const across = (y: number) => {
      const hits = raycastAll(m, fr.forward.clone().multiplyScalar(m.size.length()).add(new Vector3(cx, y, m.center.z)), fr.forward.clone().negate());
      let [best, mid] = [0, m.center.z];
      for (let i = 0; i + 1 < hits.length; i += 2) {
        const d = hits[i + 1].distance - hits[i].distance;
        if (d > best) [best, mid] = [d, (hits[i].point.z + hits[i + 1].point.z) / 2];
      }
      const c = new Vector3(cx, y, mid);
      const [r, l] = [X, X.clone().negate()].map((d) => raycastAll(m, c, d)[0]?.distance ?? 0.1 * h);
      return { c, half: (r + l) / 2 };
    };

    // Crotch: lowest height where the mesh crosses the center line (legs apart below it).
    let groinY = minY + 0.42 * h;
    for (let t = 0.1; t < 0.75; t += 0.01) {
      if (xsAt(minY + t * h).some((x) => Math.abs(x - cx) < 0.015 * h)) {
        if (t > 0.13) groinY = minY + t * h;
        break;
      }
    }
    // Neck: narrowest body between the chest and the top of the head (median of three neighbors, so a stray hit
    // doesn't count) that is clearly narrower than the torso below and has a wider head above. Characters without
    // one (a head sunk between big shoulders) fall back to the narrowest run of vertices through the center line.
    const ys: number[] = [];
    for (let y = groinY; y < maxY - 0.1 * h; y += 0.01 * h) ys.push(y);
    const raw = ys.map((y) => across(y).half);
    const widths = raw.map((w, i) => [raw[i - 1] ?? w, w, raw[i + 1] ?? w].sort((a, b) => a - b)[1]);
    // Arms held out sideways (T-pose) join the body with no gap, so rows through them measure the whole arm span: a
    // thin band far wider than the body, with the head above it. The neck is above that band (the waist below it
    // would otherwise pass for one), at its top when the head sits right on the shoulders.
    const median = [...widths].sort((a, b) => a - b)[widths.length >> 1];
    let armTop = -1;
    for (let i = widths.length - 1; i >= 0; i--) {
      if (widths[i] <= 2 * median) continue;
      let bottom = i;
      while (bottom > 0 && widths[bottom - 1] > 2 * median) bottom--;
      if (ys[i] - ys[bottom] < 0.15 * h && ys[ys.length - 1] - ys[i] > 0.05 * h) armTop = i;
      break;
    }
    let neckY = NaN;
    let narrowest = Infinity;
    for (let i = Math.max(armTop, 0) + 1; i < ys.length; i++) {
      if (ys[i] < groinY + 0.3 * (maxY - groinY) || widths[i] >= narrowest) continue;
      const below = Math.max(...widths.slice(0, i));
      const above = Math.max(...widths.slice(i + 1), 0);
      if (widths[i] <= 0.8 * below && above >= 1.15 * widths[i]) [narrowest, neckY] = [widths[i], ys[i]];
    }
    if (Number.isNaN(neckY) && armTop >= 0) neckY = ys[armTop] + 0.01 * h;
    if (Number.isNaN(neckY)) {
      neckY = minY + 0.82 * h;
      for (let y = groinY + 0.3 * (maxY - groinY); y < maxY - 0.1 * h; y += 0.01 * h) {
        const s = span(y);
        if (s && s.right - s.left < narrowest) {
          narrowest = s.right - s.left;
          neckY = y;
        }
      }
    }
    const halfChest = Math.min(across(neckY - 0.08 * h).half, 0.3 * h);
    const bodyZ = across(neckY - 0.08 * h).c.z;
    const shoulderL = new Vector3(cx + halfChest * 0.85, neckY - 0.035 * h, o.wings ? bodyZ : m.center.z);
    const armSurface = (v: Vector3) => !o.wings || (v.z - bodyZ) * fr.forward.z > -0.04 * h;
    // Each arm on its own (a pose with a weapon or a pointing hand isn't symmetric), traced from the shoulder.
    const arms = ([1, -1] as const).map((sgn) => {
      const shoulder = shoulderL.clone().setX(cx + sgn * (shoulderL.x - cx));
      const traced = traceArm(m, shoulder, sgn, groinY, fr.forward, h, armSurface);
      if (traced) return traced;
      // Fallback: toward the arm point farthest from the shoulder, outside the torso.
      const far = extreme(
        m,
        (v) => Math.hypot(v.x - shoulder.x, v.y - shoulder.y),
        (v) => armSurface(v) && sgn * (v.x - cx) > halfChest && v.y > groinY && v.y < neckY,
      );
      const wrist =
        sgn * (far.x - shoulder.x) > 0
          ? lerp(shoulder, far.setZ(m.center.z), 0.85)
          : shoulder.clone().add(new Vector3(sgn * 0.05 * h, -0.3 * h, 0));
      return { elbow: lerp(shoulder, wrist, 0.5), wrist, shoulderY: shoulder.y };
    });
    shoulderL.y = (arms[0].shoulderY + arms[1].shoulderY) / 2;
    const kneeY = (minY + groinY) / 2;
    const legX = (y: number, fallback: number, near = (x: number) => x > cx) => {
      const xs = xsAt(y).filter(near);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback;
    };
    const ankleY = minY + 0.1 * (groinY - minY);
    const ankleX = legX(ankleY, cx + 0.06 * h);
    // Knee: only the leg above the ankle, not long arms hanging at knee height beside it.
    const kneeX = legX(kneeY, ankleX, (x) => x > cx && Math.abs(x - ankleX) < 0.12 * h);

    const flat: Markers = {
      chin: new Vector3(cx, neckY + 0.02 * h, m.center.z),
      groin: new Vector3(cx, groinY, m.center.z),
      shoulderL,
      elbowL: arms[0].elbow,
      wristL: arms[0].wrist,
      kneeL: new Vector3(kneeX, kneeY, m.center.z),
      ankleL: new Vector3(ankleX, ankleY, m.center.z),
    };
    const k: Markers = {};
    for (const [id, p] of Object.entries(flat)) k[id] = midDepth(m, p, fr.forward);
    // Tail tip: the point farthest behind the body, between the legs and the neck.
    if (o.tail) k.tailTip = extreme(m, (v) => -v.dot(fr.forward), (v) => v.y > groinY - 0.1 * h && v.y < neckY);
    const both = mirrorMarkers(k, fr, new Vector3(cx, 0, m.center.z));
    // The -X arm as traced, not mirrored.
    both.elbowR = midDepth(m, arms[1].elbow, fr.forward);
    both.wristR = midDepth(m, arms[1].wrist, fr.forward);
    // The guess puts "L" at +X, which is the character's right when it faces -Z.
    const out: Markers = {};
    for (const [id, p] of Object.entries(both))
      out[o.flip && /[LR]$/.test(id) ? id.slice(0, -1) + (id.endsWith("L") ? "R" : "L") : id] = p;
    for (const [s, S] of SIDES) {
      if (weaponOf(o, S) === "none") continue;
      const w = guessWeapon(m, out[`elbow${s}`], out[`wrist${s}`]);
      // Bows and shields have no tip: their top is.
      const upright = ["bow", "shield"].includes(weaponOf(o, S)) && w.end.y > w.tip.y;
      out[`weaponEnd${S}`] = upright ? w.tip : w.end;
      out[`weaponTip${S}`] = upright ? w.end : w.tip;
    }
    if (o.wings) {
      const chest = lerp(out.shoulderL, out.shoulderR, 0.5);
      for (const [s, sign] of [["L", 1], ["R", -1]] as const) {
        const root = lerp(chest, out[`shoulder${s}`], 0.65).addScaledVector(fr.forward, -0.08 * h);
        const tip = extreme(m, (v) => v.distanceToSquared(root), (v) =>
          sign * v.clone().sub(chest).dot(fr.lateral) > 0.12 * h &&
          v.y > chest.y - 0.15 * h && v.clone().sub(chest).dot(fr.forward) < 0.02 * h);
        out[`wingRoot${s}`] = root;
        out[`wingElbow${s}`] = lerp(root, tip, 0.35);
        out[`wingWrist${s}`] = lerp(root, tip, 0.7);
        out[`wingTip${s}`] = tip;
      }
    }
    return out;
  },
  build(m, k, o, fr) {
    const h = m.size.y;
    const hips = k.groin.clone().addScaledVector(UP, 0.03 * h);
    const shoulderMid = lerp(k.shoulderL, k.shoulderR, 0.5);
    const neck = shoulderMid.clone().setY(shoulderMid.y + 0.25 * Math.max(k.chin.y - shoulderMid.y, 0));
    const headY = o.wings
      ? extreme(m, (v) => v.y, (v) => Math.abs(v.x - k.chin.x) < 0.1 * h).y
      : m.box.max.y;
    const headTop = k.chin.clone().setY(Math.max(headY, k.chin.y + 0.02 * h));
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
    if (o.wings) for (const [s] of SIDES)
      bones.push(...wingBones(k, s, "Chest", k[`wingRoot${s}`], { at: chest, lateral: fr.lateral }));
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
      // A held weapon hangs off the hand: it moves with the wrist and never bends.
      const kind = weaponOf(o, S);
      if (kind !== "none") {
        const [end, tip] = [k[`weaponEnd${S}`], k[`weaponTip${S}`]];
        const origin = end.clone().addScaledVector(end.clone().sub(tip), 0.05);
        bones.push({ ...gated(bone(`Weapon${S}`, `${S}Hand`, end, tip), origin, tip), rigid: true, strike: STRIKE[kind] });
      }
    }
    // Arm floor: lower the arm from its rest angle in small steps while the forearm and hand, seen from the front
    // (forward/back swings keep that view), stay clear of the leg on their side.
    const armFloor = { Left: -1.3, Right: -1.3 };
    for (const [s, S] of SIDES) {
      const [shoulder, elbow, wrist, knee, ankle] = ["shoulder", "elbow", "wrist", "knee", "ankle"].map((j) => k[j + s]);
      const out = fr.lateral.clone().multiplyScalar(S === "Left" ? 1 : -1);
      const flat = (p: Vector3) => {
        const d = p.clone().sub(shoulder);
        return [d.dot(out), d.y];
      };
      const tip = wrist.clone().add(wrist.clone().sub(elbow).multiplyScalar(0.35));
      const armR = Math.max(radiusAt(m, elbow, wrist.clone().sub(elbow)), radiusAt(m, wrist, wrist.clone().sub(elbow)));
      const legR = Math.max(radiusAt(m, knee, UP), radiusAt(m, lerp(knee, ankle, 0.5), UP));
      const hip = flat(knee.clone().setY(k.groin.y));
      const [kn, an] = [flat(knee), flat(ankle)];
      const arm = [elbow, wrist, tip].map(flat);
      const clear = (delta: number) => {
        const [c, sn] = [Math.cos(delta), Math.sin(delta)];
        const [e, w, t] = arm.map(([x, y]) => [x * c - y * sn, x * sn + y * c]);
        const gap = Math.min(...[[e, w], [w, t]].flatMap(([a, b]) => [segDist2(a, b, hip, kn), segDist2(a, b, kn, an)]));
        return gap >= armR + legR + 0.01 * h;
      };
      const rest = Math.atan2(flat(elbow)[1], flat(elbow)[0]);
      let a = rest;
      while (a > -1.3 && clear(a - 0.02 - rest)) a -= 0.02;
      armFloor[S] = Math.max(a, -1.3);
    }
    return { bones, skin: { mode: "heat" }, armFloor, weapons: { Left: o.weaponLeft, Right: o.weaponRight } };
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
  markers: (o) => [
    "nose",
    ...(o.trunk ? ["trunkMid"] : []),
    "head",
    ...(o.jaw ? ["jawTip"] : []),
    ...(o.horns === 1 ? ["hornTip"] : o.horns >= 2 ? ["hornTipL", "hornTipR"] : []),
    "shoulders",
    "back",
    "hips",
    "belly",
    "tailTip",
    ...(o.bipedal ? ["elbow", "wrist"] : ["frontKnee", "frontFoot"]).flatMap((j) => [`${j}L`, `${j}R`]),
    ...["rearKnee", "rearFoot"].flatMap((j) => [`${j}L`, `${j}R`]),
    ...(o.wings ? ["wingElbow", "wingWrist", "wingTip"].flatMap((j) => [`${j}L`, `${j}R`]) : []),
  ],
  frame: (_m, k) => frameOf(k.nose.clone().sub(k.tailTip)),
  guess(m, o) {
    const h = m.size.y;
    const minY = m.box.min.y;
    const low: Vector3[] = [];
    const v = new Vector3();
    for (let i = 0; i < m.count; i++) if (vertexAt(m, i, v).y < minY + 0.1 * h) low.push(v.clone());
    // Spread wings can be wider than the body is long: then the body runs along the axis the feet spread along.
    let axis = longAxis(m);
    if (o.wings && low.length) {
      const spread = (a: Vector3) => Math.max(...low.map((p) => p.dot(a))) - Math.min(...low.map((p) => p.dot(a)));
      axis = spread(X) >= spread(Z) ? X.clone() : Z.clone();
    }
    // `flip` when the higher end isn't the head (an elephant's back or saddle rises above its head).
    const fr = frameOf(axis.multiplyScalar(higherEnd(m, axis) * (o.flip ? -1 : 1)));
    const { forward: F, lateral: L } = fr;
    const { min: sMin, len } = range(m, F);
    const latC = m.center.dot(L);
    // Feet: low vertices split into a front and a rear group by forward position (2-means); all of them are hind feet
    // when it walks on two legs.
    let [front, rear] = [sMin + 0.75 * len, sMin + 0.25 * len];
    if (o.bipedal) rear = low.length ? low.reduce((a, p) => a + p.dot(F), 0) / low.length : m.center.dot(F);
    else
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
    const backAt = (s: number) =>
      raycastAll(m, at(fr, s, latC, m.box.max.y + h), UP.clone().negate())[0]?.point.y ?? minY + 0.75 * h;
    // Spine height above a leg pair: a third of the way down from the back (legs continue the torso downward,
    // so the mesh's own top/bottom midpoint would land in the leg).
    const torso = (s: number) => at(fr, s, latC, backAt(s) - 0.3 * (backAt(s) - minY));
    // Head: only thick parts count, so thin sheets sticking out in front (leaves, ears, horns) aren't taken for it.
    const th = thickness(m);
    const solid = (i: number) => th(i) > 0.1 * h;
    const ahead = Float32Array.from({ length: m.count }, (_, i) => vertexAt(m, i, v).dot(F));
    const tip = Array.from(ahead.keys()).sort((a, b) => ahead[b] - ahead[a]).find(solid);
    const nose = midDepth(m, tip === undefined ? extreme(m, (p) => p.dot(F)) : vertexAt(m, tip), L);
    // On two legs the body leans forward over the hips: shoulders part way toward the head.
    if (o.bipedal) front = rear + 0.45 * (nose.dot(F) - rear);
    const shoulders = torso(front);
    const hips = torso(rear);
    // Skull center: a little behind the nose, halfway between the nose and the top of the head.
    const headS = lerp(nose, shoulders, o.trunk ? 0.45 : 0.2).dot(F);
    const skullTop =
      raycastAll(m, at(fr, headS, latC, m.box.max.y + h), UP.clone().negate()).find((hit) => hit.face && solid(hit.face.a))
        ?.point.y ?? nose.y;
    const head = midDepth(m, at(fr, headS, latC, (Math.max(skullTop, nose.y) + nose.y) / 2), L);
    // Belly: low in the torso between the leg pairs, above the underside seen from below.
    const midS = (front + rear) / 2;
    const footY = minY + 0.03 * h;
    const under = raycastAll(m, at(fr, midS, latC, minY - h), UP)[0]?.point.y ?? minY + 0.4 * h;
    const k: Markers = {
      nose,
      head,
      shoulders,
      back: lerp(hips, shoulders, 0.5),
      hips,
      belly: at(fr, midS, latC, under + 0.25 * (backAt(midS) - under)),
      tailTip: midDepth(m, extreme(m, (p) => -p.dot(F)), L),
      rearFootL: at(fr, rear, footLat(rear), footY),
      rearKneeL: at(fr, rear, footLat(rear), footY + 0.45 * (hips.y - footY)),
    };
    if (o.bipedal) {
      // Short arms hanging under the chest.
      const drop = shoulders.y - minY;
      k.elbowL = at(fr, front, footLat(rear), shoulders.y - 0.25 * drop);
      k.wristL = at(fr, front + 0.08 * len, footLat(rear), shoulders.y - 0.35 * drop);
    } else {
      k.frontFootL = at(fr, front, footLat(front), footY);
      k.frontKneeL = at(fr, front, footLat(front), footY + 0.45 * (shoulders.y - footY));
    }
    if (o.trunk) k.trunkMid = midDepth(m, lerp(head, nose, 0.5), L);
    if (o.jaw) {
      // Chin: a little above the underside of the head, part way back from the snout (under the trunk's base).
      const s = (o.trunk ? lerp(head, k.trunkMid, 0.3) : lerp(nose, head, 0.3)).dot(F);
      const top = Math.min(nose.y, head.y);
      const below = raycastAll(m, at(fr, s, latC, minY - h), UP).filter((hit) => hit.point.y < top);
      const underY = below.at(-1)?.point.y ?? top - 0.15 * h;
      k.jawTip = midDepth(m, at(fr, s, latC, underY + 0.3 * (top - underY)), L);
    }
    const onHead = (p: Vector3) => p.dot(F) > head.dot(F) - 0.12 * len;
    if (o.horns === 1) k.hornTip = extreme(m, (p) => p.y + 0.5 * p.dot(F), (p) => onHead(p) && p.y > head.y);
    if (o.horns >= 2)
      k.hornTipL = o.trunk
        ? // Tusks: forward and out to the side, below the skull (the trunk hangs in the middle).
          extreme(m, (p) => p.dot(F) + p.dot(L) - latC, (p) => onHead(p) && p.y < head.y && p.dot(L) > latC + 0.02 * h)
        : extreme(m, (p) => p.y + p.dot(L) - latC, (p) => onHead(p) && p.y > head.y - 0.1 * h && p.dot(L) > latC);
    if (o.wings) {
      const root = shoulders.clone().setY(backAt(front));
      const tip =
        halfWidth > 0.35 * len
          ? extreme(m, (p) => p.dot(L), (p) => p.y > shoulders.y)
          : at(fr, lerp(shoulders, hips, 0.8).dot(F), latC + 0.6 * halfWidth, root.y + 0.1 * h);
      k.wingTipL = tip;
      k.wingElbowL = lerp(root, tip, 0.35).addScaledVector(UP, 0.08 * h);
      k.wingWristL = lerp(root, tip, 0.7).addScaledVector(UP, 0.04 * h);
    }
    return mirrorMarkers(k, fr, m.center);
  },
  build(m, k, o, fr) {
    const h = m.size.y;
    const { forward: F, lateral: L } = fr;
    const len = range(m, F).len;
    const neck = lerp(k.shoulders, k.head, 0.45);
    // A long neck (horses, dragons, dinosaurs) gets two links so it curves instead of kinking at one joint.
    const neck2 = k.head.distanceTo(k.shoulders) > 0.3 * len ? lerp(neck, k.head, 0.5) : null;
    // Belly: a bone low in the torso that holds the underside, so the upper legs don't pull it along when they swing.
    const bellyHalf = 0.3 * Math.abs(k.shoulders.clone().sub(k.hips).dot(F));
    // Tail base: where the body thins out toward the tip (a short or hanging tail: near the tip), so wagging it
    // doesn't swing the rump.
    const tailDir = k.tailTip.clone().sub(k.hips);
    const rumpR = radiusAt(m, k.hips, tailDir);
    let tb = 0.85;
    for (let t = 0.3; t < 0.85; t += 0.05)
      if (radiusAt(m, lerp(k.hips, k.tailTip, t), tailDir) < 0.35 * rumpR) {
        tb = t;
        break;
      }
    // Long tails (crocodiles, dinosaurs, dragons) get five links, so a swipe bends smoothly.
    const links = k.tailTip.distanceTo(k.hips) * (1 - tb) > 0.25 * len ? 5 : 3;
    const tail = Array.from({ length: links + 1 }, (_, i) => lerp(k.hips, k.tailTip, tb + (i / links) * (1 - tb)));
    const bones = [
      bone("Root", null, ground(m, k.back), k.hips, false),
      bone("Hips", "Root", k.hips, k.back),
      bone("Spine", "Hips", k.back, k.shoulders),
      bone("Chest", "Spine", k.shoulders, neck),
      ...(neck2
        ? [bone("Neck", "Chest", neck, neck2), bone("Neck2", "Neck", neck2, k.head)]
        : [bone("Neck", "Chest", neck, k.head)]),
      bone("Belly", "Spine", k.belly.clone().addScaledVector(F, -bellyHalf), k.belly.clone().addScaledVector(F, bellyHalf)),
      ...Array.from({ length: links }, (_, i) =>
        gated(bone(`Tail${i + 1}`, i ? `Tail${i}` : "Hips", tail[i], tail[i + 1]), tail[0], k.tailTip),
      ),
    ];
    const headParent = neck2 ? "Neck2" : "Neck";
    let upperLip = k.nose;
    if (k.trunkMid) {
      // Trunk: the head ends where the trunk starts, then three links through the middle marker to the tip.
      const base = lerp(k.head, k.trunkMid, 0.4);
      const bend = lerp(k.trunkMid, k.nose, 0.5);
      upperLip = base;
      bones.push(
        bone("Head", headParent, k.head, base),
        bone("Trunk1", "Head", base, k.trunkMid),
        bone("Trunk2", "Trunk1", k.trunkMid, bend),
        bone("Trunk3", "Trunk2", bend, k.nose),
      );
    } else bones.push(bone("Head", headParent, k.head, k.nose));
    if (k.jawTip) bones.push(jawBone(k, fr, upperLip));
    bones.push(...hornBones(k));
    if (o.wings) for (const [s] of SIDES) bones.push(...wingBones(k, s, "Chest", lerp(k.shoulders, k[`wingElbow${s}`], 0.25)));
    if (o.bipedal)
      for (const [s] of SIDES) {
        const [elbow, wrist] = [k[`elbow${s}`], k[`wrist${s}`]];
        const shoulder = at(fr, k.shoulders.dot(F), elbow.dot(L), lerp(elbow, k.shoulders, 0.7).y);
        const arm = (b: BoneSpec) => gated(b, shoulder, elbow);
        bones.push(
          arm(bone(`UpperArm${s}`, "Chest", shoulder, elbow)),
          arm(bone(`LowerArm${s}`, `UpperArm${s}`, elbow, wrist)),
          arm(bone(`Hand${s}`, `LowerArm${s}`, wrist, wrist.clone().add(wrist.clone().sub(elbow).multiplyScalar(0.35)))),
        );
      }
    for (const [pos, top, parent] of (
      [
        ["Front", k.shoulders, "Chest"],
        ["Rear", k.hips, "Hips"],
      ] as const
    ).filter(([pos]) => !(o.bipedal && pos === "Front")))
      for (const [s] of SIDES) {
        const p = pos.toLowerCase();
        const [foot, knee] = [k[`${p}Foot${s}`], k[`${p}Knee${s}`]];
        const [ks, kl] = [knee.dot(F), knee.dot(L)];
        const midLat = lerp(k[`${p}FootL`], k[`${p}FootR`], 0.5).dot(L);
        const hipY = foot.y + 0.85 * (top.y - foot.y);
        const join = legJoin(m, fr, foot, midLat, hipY);
        const upper = at(fr, ks, kl, Math.max(Math.min(hipY, join + 0.1 * (top.y - foot.y)), knee.y + 0.05 * h));
        const paw = at(fr, foot.dot(F), foot.dot(L), foot.y + 0.05 * h);
        // Only the leg below where it leaves the body may be its own; the belly and flank above it stay with the trunk.
        const gate = at(fr, ks, kl, Math.max(Math.min(join, upper.y), knee.y + 0.02 * h));
        const leg = (b: BoneSpec) => gated(b, gate, knee);
        bones.push(
          leg(bone(`${pos}UpperLeg${s}`, parent, upper, knee)),
          leg(bone(`${pos}LowerLeg${s}`, `${pos}UpperLeg${s}`, knee, paw)),
          leg(bone(`${pos}Foot${s}`, `${pos}LowerLeg${s}`, paw, paw.clone().addScaledVector(F, 0.04 * len).setY(m.box.min.y))),
        );
      }
    return { bones, skin: { mode: "heat" } };
  },
};

// ---------------------------------------------------------------- bird

/** Wing root on the chest: `out` of the way toward `toward` sideways, a little above the chest joint. */
const birdShoulder = (chest: Vector3, toward: Vector3, L: Vector3, h: number, out = 0.35) =>
  chest
    .clone()
    .addScaledVector(L, (toward.dot(L) - chest.dot(L)) * out)
    .addScaledVector(UP, 0.08 * h);

/**
 * Mean distance from the vertices mirrored across the mid-plane normal to `axis` (through the center) to the surface:
 * about 0 across the axis a model is left-right symmetric about.
 */
function asymmetry(m: ModelData, axis: Vector3) {
  const c = m.center.dot(axis);
  const step = Math.max(1, Math.floor(m.count / 1500));
  const v = new Vector3();
  let sum = 0;
  let n = 0;
  for (let i = 0; i < m.count; i += step, n++) {
    vertexAt(m, i, v).addScaledVector(axis, -2 * (v.dot(axis) - c));
    sum += m.bvh.closestPointToPoint(v)?.distance ?? 0;
  }
  return sum / Math.max(n, 1);
}

/** Middle of the solid part (a wing) nearest to `p` along any of `axes`: puts joints on a thin, curved part inside it. */
function inside(m: ModelData, p: Vector3, axes: Vector3[]) {
  const far = m.size.length() * 2;
  let best = p.clone();
  let bestD = Infinity;
  for (const a of axes) {
    const hits = raycastAll(m, p.clone().addScaledVector(a, -far), a);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const mid = lerp(hits[i].point, hits[i + 1].point, 0.5);
      if (mid.distanceTo(p) < bestD) [best, bestD] = [mid, mid.distanceTo(p)];
    }
  }
  return best;
}

const bird: Template = {
  markers: () => ["head", "chest", "tailTip", ...["wingElbow", "wingWrist", "wingTip", "foot"].flatMap((j) => [`${j}L`, `${j}R`])],
  // Left/right pairs give the lateral axis: a bird flying toward the camera stands upright, so its head is above its
  // tail and the head -> tail line says little about where it faces.
  frame(_m, k) {
    const L = new Vector3();
    for (const j of ["wingElbow", "wingWrist", "wingTip", "foot"])
      if (k[`${j}L`] && k[`${j}R`]) L.add(k[`${j}L`].clone().sub(k[`${j}R`]).setY(0));
    return L.lengthSq() > 1e-10 ? frameOf(L.normalize().cross(UP)) : frameOf(k.head.clone().sub(k.tailTip));
  },
  guess(m) {
    const h = m.size.y;
    const minY = m.box.min.y;
    // The mid-plane: the bird is mirror-symmetric across its lateral axis, which is its span when the wings are spread
    // (the longest axis then) and its width when they are folded.
    const lat = asymmetry(m, X) <= asymmetry(m, Z) ? X.clone() : Z.clone();
    const halfWidth = range(m, lat).len / 2;
    const onMid = (v: Vector3) => Math.abs(v.clone().sub(m.center).dot(lat)) < 0.15 * halfWidth;
    // Head: the top of the mid-plane (raised wings rise higher on the sides), and the side it leans to is the front.
    const top = extreme(m, (v) => v.y, onMid);
    const ahead = lat.clone().cross(UP);
    const fr = frameOf(ahead.multiplyScalar(Math.sign(top.clone().sub(m.center).dot(ahead)) || 1));
    const { forward: F, lateral: L } = fr;
    const { len } = range(m, F);
    const latC = m.center.dot(L);
    const head = midDepth(m, top, L);
    // Tail tip: the far end of the mid-plane from the head, behind it (a perched bird) or below it (an upright one).
    const tailTip = midDepth(m, extreme(m, (v) => v.distanceTo(top) - 0.3 * v.clone().sub(top).dot(F), onMid), L);
    const body = head.clone().sub(tailTip);
    const onPlane = (p: Vector3) => p.addScaledVector(L, latC - p.dot(L));
    const chest = midDepth(m, onPlane(lerp(head, tailTip, 0.4)), Math.abs(body.y) < 0.7 * body.length() ? UP : F);
    const spread = halfWidth > 0.35 * len;
    const wingTipL = spread
      ? extreme(m, (v) => v.dot(L), (v) => v.y > minY + 0.3 * h)
      : at(fr, lerp(chest, tailTip, 0.6).dot(F), latC + 0.6 * halfWidth, chest.y);
    // Feet: the lowest points on the side, away from the tail (the lowest point of an upright bird).
    const side = (v: Vector3) =>
      v.dot(L) > latC + 0.02 * halfWidth && v.dot(L) < latC + 0.4 * halfWidth && v.distanceTo(tailTip) > 0.25 * body.length();
    const low = extreme(m, (v) => -v.y, side).y;
    const foot = centroid(m, (v) => side(v) && v.y < low + 0.06 * h);
    const shoulder = birdShoulder(chest, wingTipL, L, h);
    const k: Markers = {
      head,
      chest,
      tailTip,
      wingElbowL: inside(m, lerp(shoulder, wingTipL, 0.35), [F, UP]),
      wingWristL: inside(m, lerp(shoulder, wingTipL, 0.7), [F, UP]),
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
      const foot = k[`foot${s}`];
      const hip = at(fr, foot.dot(F), foot.dot(L), foot.y + 0.7 * (hips.y - foot.y));
      bones.push(
        ...wingBones(k, s, "Chest", birdShoulder(k.chest, k[`wingElbow${s}`], L, h, 0.5), { at: k.chest, lateral: L }),
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

const FISH_SPINE = ["Spine1", "Spine2", "Spine3", "Spine4", "Spine5", "Spine6"];
const FISH_STOPS = [0.08, 0.25, 0.42, 0.58, 0.72, 0.86];
const FIN_JOINTS = ["finRoot", "finMid", "finTip"];

/**
 * Pectoral fin from its root on the body through the middle marker to the tip: three links, so a ray's wing beat
 * travels out to the tip. Gated sideways like a bird's wing (`mid`: a point on the body's mid-plane and its lateral
 * axis), so a beating fin leaves the body and the other fin alone.
 */
function finBones(k: Markers, s: string, parent: string, mid: { at: Vector3; lateral: Vector3 }) {
  const [root, elbow, tip] = FIN_JOINTS.map((j) => k[j + s]);
  const wrist = lerp(elbow, tip, 0.5);
  const dir = mid.lateral.clone().multiplyScalar(Math.sign(elbow.clone().sub(root).dot(mid.lateral)) || 1);
  const gate = { origin: root, dir, fade: 0.5 * Math.max(0, root.clone().sub(mid.at).dot(dir)) };
  return [
    bone(`Fin1${s}`, parent, root, elbow),
    bone(`Fin2${s}`, `Fin1${s}`, elbow, wrist),
    bone(`Fin3${s}`, `Fin2${s}`, wrist, tip),
  ].map((b) => ({ ...b, gate }));
}

const fish: Template = {
  markers: (o) => [
    "head",
    ...(o.jaw ? ["jawTip"] : []),
    ...(o.horns === 1 ? ["hornTip"] : o.horns >= 2 ? ["hornTipL", "hornTipR"] : []),
    "tailTip",
    ...(o.fins ? FIN_JOINTS.flatMap((j) => [`${j}L`, `${j}R`]) : []),
  ],
  frame: (_m, k) => frameOf(k.head.clone().sub(k.tailTip)),
  guess(m, o) {
    // A ray's fins span wider than it is long: its body runs across the axis it is mirror-symmetric about.
    const axis = o.swim === "ray" ? (asymmetry(m, X) <= asymmetry(m, Z) ? Z.clone() : X.clone()) : longAxis(m);
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
    const k: Markers = { head: mid(extreme(m, (p) => p.dot(F))), tailTip: mid(extreme(m, (p) => -p.dot(F))) };
    const fr = frameOf(F);
    const latC = m.center.dot(L);
    const bodyLen = Math.max(k.head.dot(F) - k.tailTip.dot(F), 1e-6);
    /** Fraction of the way from the head to the tail tip. */
    const along = (p: Vector3) => (k.head.dot(F) - p.dot(F)) / bodyLen;
    if (o.jaw) {
      // Chin: under the snout, a third of the way up from the underside.
      const p = lerp(k.head, k.tailTip, 0.04);
      const under = raycastAll(m, p, UP.clone().negate())[0]?.point.y ?? p.y - 0.05 * m.size.y;
      k.jawTip = p.clone().setY(p.y - 0.6 * (p.y - under));
    }
    const onHead = (p: Vector3) => along(p) > -0.05 && along(p) < 0.3 && p.y > k.head.y;
    const hornScore = (p: Vector3) => p.y + 0.5 * p.dot(F);
    if (o.horns === 1) k.hornTip = extreme(m, hornScore, onHead);
    else if (o.horns >= 2) k.hornTipL = extreme(m, hornScore, (p) => onHead(p) && p.dot(L) > latC + 0.02 * m.size.length());
    if (o.fins) {
      // Pectoral fin tip: a ray's widest point; a fish's or a whale's in the front half of the body, below its spine.
      const spineY = (p: Vector3) => lerp(k.head, k.tailTip, along(p)).y;
      const tip =
        o.swim === "ray"
          ? extreme(m, (p) => p.dot(L))
          : extreme(m, (p) => p.dot(L), (p) => along(p) > 0.12 && along(p) < 0.55 && p.y < spineY(p));
      // Root: out from the spine toward the tip, inside the body wall (a ray's fin starts well inside its disc).
      const spine = nearestDepth(m, lerp(k.head, k.tailTip, Math.min(Math.max(along(tip), 0), 1)), UP);
      const out = tip.clone().sub(spine);
      const wall = raycastAll(m, spine, out.clone().normalize())[0]?.distance ?? 0;
      const root = spine.clone().addScaledVector(out.clone().normalize(), Math.min(0.7 * wall, 0.3 * out.length()));
      k.finRootL = root;
      k.finMidL = inside(m, lerp(root, tip, 0.5), [UP, F]);
      k.finTipL = tip;
    }
    return mirrorMarkers(k, fr, m.center);
  },
  build(m, k, o, fr) {
    // Plain fish keep the linear blend along the body; fins, a jaw, horns or feelers need their own weights (heat
    // skinning).
    if (!o.fins && !o.jaw && !o.horns && !o.feelers)
      return {
        bones: chainBones(m, FISH_SPINE, k.head, k.tailTip, FISH_STOPS),
        skin: { mode: "chain", bones: FISH_SPINE, start: k.head, end: k.tailTip },
        swim: o.swim,
      };
    // Spine joints inside the body, height-wise (a manta's tail curls up off the straight head -> tail line). Not
    // sideways: across a ray's disc that would land in a fin.
    const joints = FISH_STOPS.map((t) => nearestDepth(m, lerp(k.head, k.tailTip, t), UP));
    const bones = [bone("Root", null, ground(m, lerp(k.head, k.tailTip, 0.5)), joints[0], false)];
    FISH_SPINE.forEach((n, i) => bones.push(bone(n, i ? FISH_SPINE[i - 1] : "Root", joints[i], joints[i + 1] ?? k.tailTip)));
    bones.push(bone("Head", "Spine1", joints[0], k.head));
    // Jaw hinge and horn bases are placed from the skull, behind the snout tip.
    const skull = { ...k, head: lerp(k.head, k.tailTip, 0.12) };
    if (k.jawTip) bones.push(jawBone(skull, fr, k.head));
    bones.push(...hornBones(skull));
    if (o.fins)
      for (const [s] of SIDES) {
        // Each fin hangs from the spine joint nearest to its root.
        const root = k[`finRoot${s}`];
        const parent = bones
          .filter((b) => FISH_SPINE.includes(b.name))
          .reduce((a, b) => (b.head.distanceTo(root) < a.head.distanceTo(root) ? b : a));
        bones.push(...finBones(k, s, parent.name, { at: parent.head, lateral: fr.lateral }));
      }
    return { bones, skin: { mode: "heat" }, swim: o.swim };
  },
};

// ---------------------------------------------------------------- serpent: snakes, Asian dragons

/**
 * Center line of a long body, however it is coiled: the two surface points farthest apart over the mesh (geodesic
 * double sweep) are the ends, the thicker one the head; `at(f)` is the middle of the ring of vertices at fraction `f`
 * of the geodesic distance from the snout tip.
 */
function bodyLine(m: ModelData) {
  const { offs, adj } = adjacency(m);
  const [v, w] = [new Vector3(), new Vector3()];
  const sweep = (from: number) => {
    const dist = new Float64Array(m.count).fill(Infinity);
    const heap = new MinHeap();
    dist[from] = 0;
    heap.push(0, from, 0);
    let far = from;
    while (heap.size) {
      const [d, i] = heap.pop();
      if (d > dist[i]) continue;
      if (d > dist[far]) far = i;
      vertexAt(m, i, v);
      for (let e = offs[i]; e < offs[i + 1]; e++) {
        const dj = d + v.distanceTo(vertexAt(m, adj[e], w));
        if (dj < dist[adj[e]]) {
          dist[adj[e]] = dj;
          heap.push(dj, adj[e], 0);
        }
      }
    }
    return { dist, far };
  };
  // Start from an end of the long axis, so the sweep runs on the body and not on a loose part (an eye).
  const axis = longAxis(m);
  let start = 0;
  for (let i = 1; i < m.count; i++) if (vertexAt(m, i, v).dot(axis) > vertexAt(m, start, w).dot(axis)) start = i;
  let end = sweep(start).far;
  let { dist, far: other } = sweep(end);
  const D = Math.max(dist[other], 1e-9);
  /** Vertices around the body at fraction `f` of the way from `end`: their middle and mean distance to it. */
  const ring = (f: number) => {
    const pts: Vector3[] = [];
    for (let i = 0; i < m.count; i++) if (Math.abs(dist[i] - f * D) < 0.02 * D) pts.push(vertexAt(m, i));
    const c = pts.reduce((a, p) => a.add(p), new Vector3()).divideScalar(Math.max(pts.length, 1));
    return { c: pts.length ? c : null, r: pts.reduce((a, p) => a + p.distanceTo(c), 0) / Math.max(pts.length, 1) };
  };
  if (ring(0.92).r > ring(0.08).r) {
    [end, other] = [other, end];
    ({ dist } = sweep(end));
  }
  const at = (f: number) => ring(f).c ?? vertexAt(m, f < 0.5 ? end : other);
  return { nose: vertexAt(m, end), tail: vertexAt(m, other), at };
}

/** `n` + 1 points evenly spaced along the polyline through `pts`. */
function resample(pts: Vector3[], n: number) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = Math.max(cum.at(-1)!, 1e-9);
  return Array.from({ length: n + 1 }, (_, j) => {
    const d = (j / n) * total;
    let i = 1;
    while (i < pts.length - 1 && cum[i] < d) i++;
    return lerp(pts[i - 1], pts[i], (d - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-9));
  });
}

/** Body links: enough that the body bends in a smooth curve instead of kinking. */
const SERPENT_LINKS = 16;
const BODY_MARKERS = ["body1", "body2", "body3", "body4"];
const SERPENT_FEET = ["frontFootL", "frontFootR", "rearFootL", "rearFootR"];
// The guessed center line is kept as hidden "path0"…"path32" markers (a few markers can't follow a tight coil); the
// head, body and tail tip markers sit on it at these points.
const PATH_POINTS = 32;
const PATH_ANCHORS = [0, 7, 14, 21, 27, PATH_POINTS];

/** Center line from the head through the body markers to the tail tip, following the guessed one where it exists. */
function serpentLine(k: Markers) {
  const ids = ["head", ...BODY_MARKERS, "tailTip"];
  if (!k.path0) return ids.map((id) => k[id]);
  // Dragging a marker moves the line around it, fading out toward the markers on either side.
  const shift = ids.map((id, j) => k[id].clone().sub(k[`path${PATH_ANCHORS[j]}`]));
  return Array.from({ length: PATH_POINTS + 1 }, (_, i) => {
    const j = PATH_ANCHORS.findIndex((a) => a >= i);
    const d = PATH_ANCHORS[j] === i ? shift[j] : lerp(shift[j - 1], shift[j], (i - PATH_ANCHORS[j - 1]) / (PATH_ANCHORS[j] - PATH_ANCHORS[j - 1]));
    return k[`path${i}`].clone().add(d);
  });
}

const serpent: Template = {
  markers: (o) => ["nose", "head", ...(o.jaw ? ["jawTip"] : []), ...BODY_MARKERS, "tailTip", ...(o.legs ? SERPENT_FEET : [])],
  frame: (_m, k) => frameOf(k.nose.clone().sub(k.head)),
  mirror: false,
  guess(m, o) {
    const line = bodyLine(m);
    const k: Markers = { nose: line.nose };
    for (let i = 0; i <= PATH_POINTS; i++) k[`path${i}`] = i < PATH_POINTS ? line.at(0.06 + (0.94 * i) / PATH_POINTS) : line.tail;
    ["head", ...BODY_MARKERS, "tailTip"].forEach((id, j) => (k[id] = k[`path${PATH_ANCHORS[j]}`].clone()));
    const fr = frameOf(k.nose.clone().sub(k.head));
    if (o.jaw) {
      // Chin: under the snout, a third of the way down to the underside of the head.
      const p = lerp(k.nose, k.head, 0.35);
      const under = raycastAll(m, p, UP.clone().negate())[0]?.point.y ?? p.y - 0.05 * m.size.y;
      k.jawTip = p.clone().setY(p.y - 0.6 * (p.y - under));
    }
    if (o.legs)
      for (const [pos, f] of [
        ["front", 0.2],
        ["rear", 0.6],
      ] as const) {
        // Beside and below the body at that point, on both sides of its local direction.
        const c = line.at(f);
        const side = UP.clone().cross(line.at(f - 0.05).sub(line.at(f + 0.05)));
        if (side.lengthSq() < 1e-12) side.copy(fr.lateral);
        side.normalize();
        const r = Math.max(raycastAll(m, c, side)[0]?.distance ?? 0.05 * m.size.y, 0.02 * m.size.y);
        for (const [s, sign] of [
          ["L", 1],
          ["R", -1],
        ] as const)
          k[`${pos}Foot${s}`] = c.clone().addScaledVector(side, 1.6 * sign * r).setY(Math.max(m.box.min.y, c.y - 1.5 * r));
      }
    return k;
  },
  build(m, k) {
    const q = resample(serpentLine(k), SERPENT_LINKS);
    // Rooted in the middle: the front half (Hips, Spine1…) runs toward the head, the back half (Tail1…) to the tail
    // tip, so the head can rear up and strike while the rest stays on the ground.
    const c = SERPENT_LINKS / 2;
    const bones = [bone("Root", null, ground(m, q[c]), q[c], false), bone("Hips", "Root", q[c], q[c - 1])];
    for (let j = 1; j < c; j++) bones.push(bone(`Spine${j}`, j > 1 ? `Spine${j - 1}` : "Hips", q[c - j], q[c - j - 1]));
    bones.push(bone("Head", `Spine${c - 1}`, k.head, k.nose));
    for (let j = 1; j <= SERPENT_LINKS - c; j++) bones.push(bone(`Tail${j}`, j > 1 ? `Tail${j - 1}` : "Root", q[c + j - 1], q[c + j]));
    if (k.jawTip) bones.push(jawBone(k, frameOf(k.nose.clone().sub(k.head)), k.nose));
    for (const id of SERPENT_FEET.filter((f) => k[f])) {
      // Each leg hangs from the body joint nearest to its foot.
      const foot = k[id];
      const body = bones.filter((b) => /^(Hips|Spine|Tail)/.test(b.name));
      const joint = body.reduce((a, b) => (b.head.distanceTo(foot) < a.head.distanceTo(foot) ? b : a));
      const hip = lerp(joint.head, foot, 0.3);
      const knee = lerp(hip, foot, 0.5).addScaledVector(UP, 0.15 * hip.distanceTo(foot));
      const name = `${id.startsWith("front") ? "Front" : "Rear"}%${id.slice(-1)}`;
      const leg = (b: BoneSpec) => gated(b, hip, knee);
      bones.push(
        leg(bone(name.replace("%", "UpperLeg"), joint.name, hip, knee)),
        leg(bone(name.replace("%", "LowerLeg"), name.replace("%", "UpperLeg"), knee, foot)),
      );
    }
    return { bones, skin: { mode: "heat" } };
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

// ---------------------------------------------------------------- buildings

const building: Template = {
  // Opposite corners of the door: bottom on the hinge side, top on the opening side.
  markers: () => ["doorHinge", "doorTop"],
  // The door faces the front (+Z, the view the model was generated from), or the back when flipped.
  frame: (_m, _k, o) => frameOf(Z.clone().multiplyScalar(o.flip ? -1 : 1)),
  guess(m, o) {
    const fr = building.frame(m, {}, o);
    const { forward: F, lateral: L } = fr;
    const c = m.center.dot(L);
    const half = 0.09 * range(m, L).len;
    const h = m.size.y;
    const corner = (lat: number, y: number) => midDepth(m, at(fr, m.center.dot(F), lat, y), F);
    return { doorHinge: corner(c - half, m.box.min.y + 0.12 * h), doorTop: corner(c + half, m.box.min.y + 0.55 * h) };
  },
  build(m, k, _o, fr) {
    const { forward: F, lateral: L } = fr;
    const [bottom, top] = [Math.min(k.doorHinge.y, k.doorTop.y), Math.max(k.doorHinge.y, k.doorTop.y)];
    const hingeLat = k.doorHinge.dot(L);
    let across = k.doorTop.dot(L) - hingeLat;
    if (Math.abs(across) < 0.02 * m.size.x) across = 0.02 * m.size.x * (Math.sign(across) || 1);
    // Door plane: the first surface hit looking at the middle of the door from the front.
    const mid = at(fr, range(m, F).max + m.size.length(), hingeLat + across / 2, (bottom + top) / 2);
    const s = raycastAll(m, mid, F.clone().negate())[0]?.point.dot(F) ?? k.doorHinge.dot(F);
    const hinge = at(fr, s, hingeLat, bottom);
    const bones = [
      bone("Root", null, ground(m, m.center), m.center, false),
      bone("Body", "Root", m.center, m.center.clone().addScaledVector(UP, 0.3 * m.size.y)),
      bone("Door", "Body", hinge, at(fr, s, hingeLat, top)),
    ];
    const door: Door = {
      bone: "Door",
      hinge,
      width: L.clone().multiplyScalar(across),
      height: Math.max(top - bottom, 0.02 * m.size.y),
      normal: F.clone(),
      depth: 0.2 * Math.abs(across),
    };
    return { bones, skin: { mode: "rigid", body: "Body", wheels: [], doors: [door] } };
  },
};

// ---------------------------------------------------------------- feelers: whiskers, antennae, tentacles

/** Categories whose rigs can carry feelers (`RigOptions.feelers`). */
export const FEELER_CATEGORIES: readonly RigCategory[] = ["humanoid", "quadruped", "bird", "serpent", "fish"];
export const MAX_FEELERS = 4;

const feelerIds = (category: RigCategory, o: RigOptions) =>
  FEELER_CATEGORIES.includes(category)
    ? Array.from({ length: o.feelers }, (_, i) => ["feelerRoot", "feelerTip"].flatMap((j) => [`${j}${i + 1}L`, `${j}${i + 1}R`])).flat()
    : [];

/**
 * Rough feeler markers, to drag: on each side, the tips are the points around the head sticking out farthest (and
 * highest), each clear of the ones found before; the roots halfway back to the head.
 */
function guessFeelers(m: ModelData, k: Markers, fr: Frame, n: number): Markers {
  const size = m.size.length();
  const head = k.head ?? k.chin ?? m.center;
  const latC = (k.groin ?? m.center).dot(fr.lateral);
  const out: Markers = {};
  for (const [s, sgn] of [["L", 1], ["R", -1]] as const) {
    const tips: Vector3[] = [];
    for (let i = 1; i <= n; i++) {
      const ok = (p: Vector3) =>
        sgn * (p.dot(fr.lateral) - latC) > 0.01 * size &&
        p.distanceTo(head) < 0.45 * size &&
        tips.every((t) => t.distanceTo(p) > 0.08 * size);
      let tip = extreme(m, (p) => p.distanceTo(head) + 0.5 * (p.y - head.y), ok);
      if (!ok(tip)) tip = head.clone().addScaledVector(UP, 0.1 * size).addScaledVector(fr.lateral, sgn * 0.04 * i * size);
      tips.push(tip);
      out[`feelerRoot${i}${s}`] = lerp(head, tip, 0.5);
      out[`feelerTip${i}${s}`] = tip;
    }
  }
  return out;
}

/**
 * Three links from each feeler's root to its tip, hanging from the body bone nearest to the root and gated to the tip
 * side of it (like a horn). No attack uses them; the clips make them trail the motion (see `simulateChains`).
 */
function feelerBones(k: Markers, n: number, bones: BoneSpec[]): BoneSpec[] {
  const body = bones.filter((b) => b.deform && !b.rigid);
  const q = new Vector3();
  const gap = (b: BoneSpec, p: Vector3) => p.distanceTo(new Line3(b.head, b.tail).closestPointToPoint(p, true, q));
  const out: BoneSpec[] = [];
  for (let i = 1; i <= n; i++)
    for (const [s] of SIDES) {
      const [root, tip] = [k[`feelerRoot${i}${s}`], k[`feelerTip${i}${s}`]];
      if (!root || !tip || !body.length) continue;
      const parent = body.reduce((a, b) => (gap(b, root) < gap(a, root) ? b : a)).name;
      const joints = [0, 1 / 3, 2 / 3, 1].map((t) => lerp(root, tip, t));
      for (let j = 0; j < 3; j++)
        out.push(gated(bone(`Feeler${i}_${j + 1}${s}`, j ? `Feeler${i}_${j}${s}` : parent, joints[j], joints[j + 1]), root, tip));
    }
  return out;
}

const TEMPLATES: Record<RigCategory, Template> = {
  humanoid,
  quadruped,
  bird,
  serpent,
  fish,
  vehicle,
  // Aircraft pivot around their center so banking and looping look right.
  aircraft: rigidBody((m, o) => longAxis(m).multiplyScalar(o.flip ? -1 : 1), true),
  plant,
  fluid,
  prop: rigidBody(() => Z.clone(), false),
  building,
};

/** Marker ids for a category, and which of them follow their left twin while symmetry is on. */
export function markerIds(category: RigCategory, o: RigOptions) {
  const ids = [...TEMPLATES[category].markers(o), ...feelerIds(category, o)];
  const own = new Set(TEMPLATES[category].unmirrored?.(o) ?? []);
  const derived = new Set(
    o.symmetry && TEMPLATES[category].mirror !== false
      ? ids.filter((id) => id.endsWith("R") && ids.includes(`${id.slice(0, -1)}L`) && !own.has(id))
      : [],
  );
  return { ids, derived };
}

export function guessMarkers(category: RigCategory, m: ModelData, o: RigOptions): Markers {
  const k = TEMPLATES[category].guess(m, o);
  if (!feelerIds(category, o).length) return k;
  return { ...k, ...guessFeelers(m, k, TEMPLATES[category].frame(m, k, o), o.feelers) };
}

export const rigFrame = (category: RigCategory, m: ModelData, k: Markers, o: RigOptions) =>
  TEMPLATES[category].frame(m, k, o);

/** Re-derives mirrored markers after `k` changed. */
export function syncMirror(category: RigCategory, m: ModelData, k: Markers, o: RigOptions): Markers {
  const { derived } = markerIds(category, o);
  if (!o.symmetry || !derived.size) return k;
  // Characters: the groin is on the mid-plane (the bounding box isn't when a weapon is held out to one side).
  const mirrored = mirrorMarkers(k, rigFrame(category, m, k, o), category === "humanoid" && k.groin ? k.groin : m.center);
  const out = { ...k };
  for (const id of derived) out[id] = mirrored[id];
  return out;
}

/**
 * Camera axis for placing markers: characters from the front, serpents from above, animals and vehicles from the side,
 * buildings facing their door.
 */
export function markerView(category: RigCategory, m: ModelData, k: Markers, o: RigOptions): Vector3 {
  if (["humanoid", "plant", "fluid", "prop"].includes(category)) return Z.clone();
  if (category === "building") return rigFrame(category, m, k, o).forward.clone();
  // Rays from above: their fins spread flat.
  if (category === "serpent" || (category === "fish" && o.swim === "ray")) return UP.clone();
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

/** Thickness of the body part around a bone (in the middle of its striking part): the radius of its hitbox capsule. */
export function boneRadius(m: ModelData, b: BoneSpec) {
  const dir = b.tail.clone().sub(b.head);
  const [from, to] = b.strike ?? [0, 1];
  // Never thinner than a sliver of its length: a bone along the surface (the top of a head) gets short rays.
  return Math.max(radiusAt(m, lerp(b.head, b.tail, (from + to) / 2), dir.lengthSq() > 1e-12 ? dir : UP), 0.15 * (to - from) * dir.length());
}

export function planRig(category: RigCategory, m: ModelData, k: Markers, o: RigOptions): RigPlan {
  const t = TEMPLATES[category];
  const frame = t.frame(m, k, o);
  const { bones, skin, armFloor, weapons, swim } = t.build(m, k, o, frame);
  if (feelerIds(category, o).length) bones.push(...feelerBones(k, o.feelers, bones));
  const wheelRadius: Record<string, number> = {};
  if (skin.mode === "rigid") for (const w of skin.wheels) wheelRadius[w.bone] = w.radius;
  return { category, frame, bones, skin, height: m.size.y, length: range(m, frame.forward).len, wheelRadius, armFloor, weapons, swim };
}
