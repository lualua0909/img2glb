import { AnimationClip, type KeyframeTrack, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from "three";
import type { RigCategory, RigPlan } from "./rig";

// Procedural animation clips baked at 30 fps. Motions are written against the rig frame (forward / lateral / up)
// and scaled by the model's size, so the same clip fits any model of a category.

/** Movement ids from the product spec: 01 Translate … 12 Environmental, plus game clips: 13 Attack, 14 Hit / death, 15 Shooting. */
export type Movement = "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12" | "13" | "14" | "15";
export type RigClip = { clip: AnimationClip; movement: Movement };

const TAU = Math.PI * 2;
const smooth = (x: number) => x * x * (3 - 2 * x);

/** Smooth interpolation through [time, value] keys. */
function keys(t: number, k: [number, number][]) {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 0; i < k.length - 1; i++)
    if (t <= k[i + 1][0]) return k[i][1] + (k[i + 1][1] - k[i][1]) * smooth((t - k[i][0]) / (k[i + 1][0] - k[i][0]));
  return k[k.length - 1][1];
}

type Rig = {
  plan: RigPlan;
  names: string[];
  index: Map<string, number>;
  parents: number[];
  /** Rest position relative to the parent joint (bones have no rest rotation). */
  rest: Vector3[];
  /** Rest direction head -> tail, world space. */
  restDir: Vector3[];
};

function rigOf(plan: RigPlan): Rig {
  const index = new Map(plan.bones.map((b, i) => [b.name, i]));
  return {
    plan,
    names: plan.bones.map((b) => b.name),
    index,
    parents: plan.bones.map((b) => (b.parent ? index.get(b.parent)! : -1)),
    rest: plan.bones.map((b) => (b.parent ? b.head.clone().sub(plan.bones[index.get(b.parent)!].head) : b.head.clone())),
    restDir: plan.bones.map((b) => {
      const d = b.tail.clone().sub(b.head);
      return d.lengthSq() > 1e-12 ? d.normalize() : new Vector3(0, 1, 0);
    }),
  };
}

/** One frame's pose. Rotations and offsets are given in world axes and converted to each bone's parent space. */
class Poser {
  q: Quaternion[];
  p: Vector3[];
  s: Vector3[];
  constructor(private r: Rig) {
    this.q = r.names.map(() => new Quaternion());
    this.p = r.rest.map((v) => v.clone());
    this.s = r.names.map(() => new Vector3(1, 1, 1));
  }
  reset() {
    this.r.rest.forEach((v, i) => {
      this.q[i].identity();
      this.p[i].copy(v);
      this.s[i].set(1, 1, 1);
    });
  }
  private parentWorld(i: number) {
    const chain: number[] = [];
    for (let a = this.r.parents[i]; a >= 0; a = this.r.parents[a]) chain.push(a);
    const w = new Quaternion();
    for (let k = chain.length - 1; k >= 0; k--) w.multiply(this.q[chain[k]]);
    return w;
  }
  /** Rotates a bone about a world axis through its joint (applied after earlier rotations of the same bone). */
  rot(name: string, axis: Vector3, angle: number) {
    const i = this.r.index.get(name);
    if (i === undefined || angle === 0) return;
    const pw = this.parentWorld(i);
    const world = new Quaternion().setFromAxisAngle(axis, angle);
    this.q[i].premultiply(pw.clone().invert().multiply(world).multiply(pw));
  }
  move(name: string, offset: Vector3) {
    const i = this.r.index.get(name);
    if (i !== undefined) this.p[i].add(offset.clone().applyQuaternion(this.parentWorld(i).invert()));
  }
  scale(name: string, x: number, y = x, z = x) {
    const i = this.r.index.get(name);
    if (i !== undefined) this.s[i].multiply(new Vector3(x, y, z));
  }
  /** Current world direction of a bone. */
  dir(name: string) {
    const i = this.r.index.get(name)!;
    return this.r.restDir[i].clone().applyQuaternion(this.parentWorld(i).multiply(this.q[i]));
  }
}

function bake(r: Rig, name: string, duration: number, pose: (t: number, P: Poser) => void): AnimationClip {
  const frames = Math.max(2, Math.round(duration * 30) + 1);
  const times = new Float32Array(frames);
  const n = r.names.length;
  const qs = Array.from({ length: n }, () => new Float32Array(frames * 4));
  const ps = Array.from({ length: n }, () => new Float32Array(frames * 3));
  const ss = Array.from({ length: n }, () => new Float32Array(frames * 3));
  const moved = new Array<boolean>(n).fill(false);
  const turned = new Array<boolean>(n).fill(false);
  const scaled = new Array<boolean>(n).fill(false);
  const P = new Poser(r);
  const eps = 1e-6 * Math.max(r.plan.height, r.plan.length);
  for (let f = 0; f < frames; f++) {
    const t = (f / (frames - 1)) * duration;
    times[f] = t;
    P.reset();
    pose(t, P);
    for (let i = 0; i < n; i++) {
      P.q[i].toArray(qs[i], f * 4);
      P.p[i].toArray(ps[i], f * 3);
      P.s[i].toArray(ss[i], f * 3);
      turned[i] ||= Math.abs(P.q[i].w) < 1 - 1e-7;
      moved[i] ||= P.p[i].distanceTo(r.rest[i]) > eps;
      scaled[i] ||= P.s[i].distanceTo(new Vector3(1, 1, 1)) > 1e-6;
    }
  }
  const tracks: KeyframeTrack[] = [];
  r.names.forEach((b, i) => {
    if (turned[i]) tracks.push(new QuaternionKeyframeTrack(`${b}.quaternion`, times, qs[i]));
    if (moved[i]) tracks.push(new VectorKeyframeTrack(`${b}.position`, times, ps[i]));
    if (scaled[i]) tracks.push(new VectorKeyframeTrack(`${b}.scale`, times, ss[i]));
  });
  return new AnimationClip(name, duration, tracks);
}

type Kit = {
  r: Rig;
  F: Vector3;
  L: Vector3;
  U: Vector3;
  H: number;
  len: number;
  /** Positive leans the top forward (a hanging limb swings back). */
  pitch(P: Poser, b: string, a: number): void;
  /** Positive raises the left side. */
  roll(P: Poser, b: string, a: number): void;
  /** Positive turns left. */
  yaw(P: Poser, b: string, a: number): void;
  up(k: number): Vector3;
  fwd(k: number): Vector3;
  clip(movement: Movement, name: string, duration: number, pose: (t: number, P: Poser, phase: number) => void): RigClip;
};

function kit(r: Rig): Kit {
  const { forward: F, lateral: L, up: U } = r.plan.frame;
  return {
    r,
    F,
    L,
    U,
    H: r.plan.height,
    len: r.plan.length,
    pitch: (P, b, a) => P.rot(b, L, a),
    roll: (P, b, a) => P.rot(b, F, a),
    yaw: (P, b, a) => P.rot(b, U, a),
    up: (k) => U.clone().multiplyScalar(k),
    fwd: (k) => F.clone().multiplyScalar(k),
    clip: (movement, name, duration, pose) => ({
      movement,
      clip: bake(r, name, duration, (t, P) => pose(t, P, (TAU * t) / duration)),
    }),
  };
}

// ---------------------------------------------------------------- every category (moves the Root)

/** Drop and bounce: height and a squash pulse at each impact. */
function bounce(t: number, h0: number) {
  const t1 = 0.45;
  const g = (2 * h0) / (t1 * t1);
  const impacts = [t1];
  let v = g * t1 * 0.5;
  let y = t < t1 ? h0 - 0.5 * g * t * t : 0;
  for (let start = t1; v > 0.03 * g * t1; v *= 0.5) {
    const dur = (2 * v) / g;
    if (t >= start && t < start + dur) y = v * (t - start) - 0.5 * g * (t - start) ** 2;
    start += dur;
    impacts.push(start);
  }
  const squash = impacts.reduce((a, ti, i) => a + 0.5 ** i * Math.exp(-(((t - ti) / 0.05) ** 2)), 0);
  return { y, squash };
}

function common(k: Kit): RigClip[] {
  const size = Math.max(k.H, k.len);
  return [
    k.clip("01", "Translate", 3, (_t, P, ph) => P.move("Root", k.fwd(0.35 * k.len * Math.sin(ph)))),
    k.clip("02", "Rotate", 4, (_t, P, ph) => k.yaw(P, "Root", ph)),
    k.clip("03", "Scale_Pulse", 1.2, (_t, P, ph) => P.scale("Root", 1 + 0.12 * (0.5 - 0.5 * Math.cos(ph)))),
    k.clip("03", "Scale_PopIn", 1.2, (t, P) => P.scale("Root", Math.max(0.001, 1 - Math.exp(-6 * t) * Math.cos(9 * t)))),
    k.clip("10", "Physics_Bounce", 2.4, (t, P) => {
      const { y, squash } = bounce(t, 0.6 * size);
      P.move("Root", k.up(y));
      P.scale("Root", 1 + 0.12 * squash, 1 - 0.2 * squash, 1 + 0.12 * squash);
    }),
    k.clip("10", "Physics_Wobble", 2, (t, P) => {
      const decay = Math.exp(-2.5 * t);
      k.pitch(P, "Root", 0.16 * decay * Math.sin(TAU * 2.2 * t));
      k.roll(P, "Root", 0.1 * decay * Math.sin(TAU * 2.2 * t + 1.3));
      const s = 0.06 * Math.exp(-3 * t) * Math.sin(TAU * 3 * t);
      P.scale("Root", 1 + s, 1 - s, 1 + s);
    }),
  ];
}

/** Spin attack: one full turn on the spot with a small hop; `extra` adds the category's own pose. */
const spinAttack = (k: Kit, extra?: (P: Poser, e: number) => void) =>
  k.clip("13", "Attack_Spin", 1, (t, P) => {
    const e = keys(t, [[0, 0], [0.2, 1], [0.75, 1], [1, 0]]);
    // Body parts first: rotations are about world axes, so they must be set before the Root turns.
    extra?.(P, e);
    k.yaw(P, "Root", TAU * keys(t, [[0.15, 0], [0.7, 1]]));
    P.move("Root", k.up(0.05 * k.H * Math.max(0, Math.sin((Math.PI * (t - 0.2)) / 0.5)) * (t > 0.2 && t < 0.7 ? 1 : 0)));
  });

const tap = (k: Kit) =>
  k.clip("11", "Interact_Tap", 1, (t, P) => {
    const s = Math.exp(-5 * t) * Math.sin(TAU * 2.5 * t);
    P.scale("Root", 1 + 0.12 * s, 1 - 0.16 * s, 1 + 0.12 * s);
  });

// ---------------------------------------------------------------- humanoid

function humanoid(k: Kit): RigClip[] {
  const { r, F, L, U, H, pitch, roll, yaw } = k;
  // Rest arm angle in the frontal plane: 0 = T-pose, -90° = hanging. Motions start from arms ~15° off the body.
  const armAngle = (side: "Left" | "Right") => {
    const d = r.restDir[r.index.get(`${side}UpperArm`)!];
    return Math.atan2(d.dot(U), d.dot(side === "Left" ? L : L.clone().negate()));
  };
  const [aL, aR] = [armAngle("Left"), armAngle("Right")];
  const armsDown = (P: Poser, amount = 1) => {
    roll(P, "LeftUpperArm", (-1.3 - aL) * amount);
    roll(P, "RightUpperArm", -(-1.3 - aR) * amount);
  };
  /** Elbow flexion (forearm forward), whatever the upper arm's current direction. */
  const elbow = (P: Poser, side: "Left" | "Right", a: number) => {
    const axis = P.dir(`${side}UpperArm`).cross(F);
    P.rot(`${side}LowerArm`, axis.lengthSq() > 1e-6 ? axis.normalize() : L.clone().negate(), a);
  };
  const legs = (P: Poser, side: "Left" | "Right", thigh: number, knee: number) => {
    pitch(P, `${side}UpperLeg`, thigh);
    pitch(P, `${side}LowerLeg`, knee);
  };
  /** Tail sway (no-op without the optional tail). */
  const tail = (P: Poser, ph: number, a: number) =>
    ["Tail1", "Tail2", "Tail3"].forEach((b, i) => yaw(P, b, a * Math.sin(ph - 0.8 * i)));
  const gait = (P: Poser, ph: number, o: { leg: number; knee: number; arm: number; bob: number; lean: number; bend: number }) => {
    const [s, c] = [Math.sin(ph), Math.cos(ph)];
    P.move("Hips", k.up(o.bob * H * Math.cos(2 * ph)));
    yaw(P, "Hips", -0.06 * s);
    pitch(P, "Spine", o.lean);
    yaw(P, "Chest", 0.1 * s);
    armsDown(P);
    pitch(P, "LeftUpperArm", o.arm * s);
    pitch(P, "RightUpperArm", -o.arm * s);
    elbow(P, "Left", o.bend + 0.2 * Math.max(0, -s));
    elbow(P, "Right", o.bend + 0.2 * Math.max(0, s));
    legs(P, "Left", -o.leg * s, 0.1 + o.knee * Math.max(0, c));
    legs(P, "Right", o.leg * s, 0.1 + o.knee * Math.max(0, -c));
    tail(P, ph, 0.25);
  };
  return [
    k.clip("04", "Idle", 3, (_t, P, ph) => {
      P.move("Hips", k.up(-0.004 * H * (1 - Math.cos(ph))));
      pitch(P, "Chest", 0.03 * Math.sin(ph));
      yaw(P, "Head", 0.12 * Math.sin(ph));
      armsDown(P);
      pitch(P, "LeftUpperArm", 0.04 * Math.sin(ph));
      pitch(P, "RightUpperArm", 0.04 * Math.sin(ph));
      elbow(P, "Left", 0.15);
      elbow(P, "Right", 0.15);
      tail(P, 2 * ph, 0.2);
    }),
    k.clip("04", "Walk", 1.1, (_t, P, ph) => gait(P, ph, { leg: 0.45, knee: 0.8, arm: 0.4, bob: 0.012, lean: 0.05, bend: 0.3 })),
    k.clip("04", "Run", 0.7, (_t, P, ph) => gait(P, ph, { leg: 0.8, knee: 1.4, arm: 0.7, bob: 0.03, lean: 0.25, bend: 1.3 })),
    k.clip("06", "Jump", 1.6, (t, P) => {
      const crouch = keys(t, [[0, 0], [0.3, 1], [0.42, 0], [0.95, 0], [1.12, 0.8], [1.45, 0]]);
      const air = t > 0.4 && t < 1.1 ? Math.sin((Math.PI * (t - 0.4)) / 0.7) : 0;
      const tuck = keys(t, [[0.42, 0], [0.7, 1], [1.0, 0]]);
      const raise = keys(t, [[0.3, 0], [0.55, 1], [0.9, 1], [1.2, 0]]);
      P.move("Root", k.up(0.25 * H * air));
      P.move("Hips", k.up(-0.12 * H * crouch));
      pitch(P, "Spine", 0.35 * crouch);
      armsDown(P);
      roll(P, "LeftUpperArm", 1.3 * raise);
      roll(P, "RightUpperArm", -1.3 * raise);
      pitch(P, "LeftUpperArm", 0.6 * crouch);
      pitch(P, "RightUpperArm", 0.6 * crouch);
      for (const side of ["Left", "Right"] as const) legs(P, side, -0.9 * crouch - 0.5 * tuck, 1.6 * crouch + 0.9 * tuck);
    }),
    k.clip("06", "Fall", 2.2, (t, P) => {
      const e = keys(t, [[0, 0], [0.3, 0.06], [1.0, 1], [1.12, 0.95], [1.25, 1]]);
      P.move("Root", k.up(0.12 * H * e));
      pitch(P, "Root", (-Math.PI / 2) * e);
      armsDown(P, 1 - 0.7 * e);
      pitch(P, "Neck", 0.3 * e);
      for (const side of ["Left", "Right"] as const) legs(P, side, -0.35 * e, 0.6 * e);
    }),
    k.clip("11", "Interact_Wave", 2, (_t, P, ph) => {
      armsDown(P);
      roll(P, "RightUpperArm", -2.3);
      roll(P, "RightLowerArm", -0.5 + 0.35 * Math.sin(4 * ph));
      elbow(P, "Left", 0.2);
      roll(P, "Head", -0.1);
    }),
    k.clip("11", "Interact_PickUp", 2.4, (t, P) => {
      const e = keys(t, [[0, 0], [0.8, 1], [1.4, 1], [2.2, 0]]);
      P.move("Hips", k.up(-0.16 * H * e));
      pitch(P, "Spine", 0.6 * e);
      pitch(P, "Chest", 0.3 * e);
      armsDown(P);
      pitch(P, "LeftUpperArm", -0.5 * e);
      pitch(P, "RightUpperArm", -0.5 * e);
      for (const side of ["Left", "Right"] as const) legs(P, side, -0.9 * e, 1.3 * e);
    }),
    k.clip("11", "Interact_Push", 1.6, (t, P) => {
      const e = keys(t, [[0, 0], [0.5, 1], [1.0, 1], [1.6, 0]]);
      pitch(P, "Spine", 0.2 * e);
      armsDown(P);
      pitch(P, "LeftUpperArm", -1.4 * e);
      pitch(P, "RightUpperArm", -1.4 * e);
      elbow(P, "Left", 1.2 * (1 - e) + 0.1);
      elbow(P, "Right", 1.2 * (1 - e) + 0.1);
      legs(P, "Left", -0.35 * e, 0.2 * e);
      legs(P, "Right", 0.25 * e, 0);
    }),
    // Attacks: wind-up, fast strike, short hold, back to rest (so they blend with Idle).
    k.clip("13", "Attack_Punch", 1, (t, P) => {
      const load = keys(t, [[0, 0], [0.25, 1], [0.35, 0]]);
      const hit = keys(t, [[0.25, 0], [0.35, 1], [0.55, 1], [0.95, 0]]);
      const guard = keys(t, [[0, 0], [0.2, 1], [0.7, 1], [1, 0]]);
      P.move("Hips", k.fwd(0.03 * H * hit - 0.015 * H * load));
      yaw(P, "Spine", -0.25 * load + 0.3 * hit);
      pitch(P, "Chest", 0.12 * hit);
      armsDown(P);
      pitch(P, "RightUpperArm", 0.35 * load - 1.45 * hit);
      elbow(P, "Right", 1.9 * load + 0.1 * hit + 0.3 * (1 - load - hit));
      pitch(P, "LeftUpperArm", -0.9 * guard);
      elbow(P, "Left", 0.3 + 1.5 * guard);
      legs(P, "Left", -0.3 * guard, 0.25 * guard);
      legs(P, "Right", 0.2 * guard, 0.1 * guard);
    }),
    k.clip("13", "Attack_Slash", 1.3, (t, P) => {
      const raise = keys(t, [[0, 0], [0.35, 1], [0.5, 0.3], [0.62, 0]]);
      const swing = keys(t, [[0.35, 0], [0.55, 1], [0.8, 1], [1.25, 0]]);
      P.move("Hips", k.up(-0.04 * H * swing).add(k.fwd(0.03 * H * swing)));
      yaw(P, "Spine", -0.35 * raise + 0.4 * swing);
      pitch(P, "Spine", -0.08 * raise + 0.25 * swing);
      armsDown(P);
      roll(P, "RightUpperArm", -2.1 * raise);
      pitch(P, "RightUpperArm", 0.3 * raise - 0.8 * swing);
      elbow(P, "Right", 0.3 + 0.9 * raise);
      pitch(P, "LeftUpperArm", -0.4 * swing);
      elbow(P, "Left", 0.4);
      legs(P, "Left", -0.45 * swing, 0.5 * swing);
      legs(P, "Right", 0.3 * swing, 0.1 * swing);
    }),
    k.clip("13", "Attack_Kick", 1.1, (t, P) => {
      const e = keys(t, [[0, 0], [0.2, 1], [0.8, 1], [1.05, 0]]);
      const thigh = keys(t, [[0, 0], [0.3, -1.1], [0.42, -1.4], [0.65, -1.4], [1.05, 0]]);
      const knee = keys(t, [[0, 0], [0.3, 1.7], [0.42, 0.05], [0.65, 0.05], [0.82, 1.2], [1.05, 0]]);
      P.move("Hips", k.up(-0.02 * H * e));
      pitch(P, "Spine", -0.2 * e);
      armsDown(P);
      pitch(P, "LeftUpperArm", -0.7 * e);
      pitch(P, "RightUpperArm", 0.3 * e);
      elbow(P, "Left", 0.3 + 1.4 * e);
      elbow(P, "Right", 0.3 + 1.2 * e);
      legs(P, "Right", thigh, knee);
      legs(P, "Left", -0.1 * e, 0.25 * e);
    }),
    // Palm strike (chưởng): both palms drawn to the hips, then thrust forward from a wide stance.
    k.clip("13", "Attack_Palm", 1.2, (t, P) => {
      const load = keys(t, [[0, 0], [0.35, 1], [0.45, 0]]);
      const hit = keys(t, [[0.35, 0], [0.47, 1], [0.8, 1], [1.15, 0]]);
      const stance = load + hit;
      P.move("Hips", k.up(-0.05 * H * stance).add(k.fwd(0.04 * H * hit)));
      pitch(P, "Spine", -0.1 * load + 0.15 * hit);
      armsDown(P);
      for (const side of ["Left", "Right"] as const) {
        pitch(P, `${side}UpperArm`, 0.45 * load - 1.5 * hit);
        elbow(P, side, 1.7 * load + 0.1 * hit + 0.3 * (1 - stance));
      }
      legs(P, "Left", -0.45 * stance, 0.5 * stance);
      legs(P, "Right", 0.35 * stance, 0.15 * stance);
    }),
    k.clip("13", "Attack_Stomp", 1.1, (t, P) => {
      const lift = keys(t, [[0, 0], [0.4, 1], [0.52, 0]]);
      const impact = keys(t, [[0.45, 0], [0.52, 1], [0.7, 1], [1.05, 0]]);
      P.move("Hips", k.up(0.02 * H * lift - 0.025 * H * impact));
      pitch(P, "Spine", -0.1 * lift + 0.2 * impact);
      armsDown(P, 1 - 0.3 * lift - 0.4 * impact);
      elbow(P, "Left", 0.3 + 0.6 * impact);
      elbow(P, "Right", 0.3 + 0.6 * impact);
      legs(P, "Right", -1.0 * lift - 0.3 * impact, 1.4 * lift + 0.4 * impact);
      legs(P, "Left", -0.3 * impact, 0.1 * lift + 0.6 * impact);
    }),
    // Leap forward (nhảy tới) and land in a crouch, then settle back on the spot.
    k.clip("13", "Attack_Leap", 1.5, (t, P) => {
      const crouch = keys(t, [[0, 0], [0.3, 1], [0.4, 0], [0.8, 0], [0.9, 1], [1.45, 0]]);
      const air = t > 0.38 && t < 0.85 ? Math.sin((Math.PI * (t - 0.38)) / 0.47) : 0;
      const ahead = keys(t, [[0.35, 0], [0.85, 1], [1.1, 1], [1.45, 0]]);
      const slam = keys(t, [[0.4, 0], [0.7, -1], [0.85, 1], [1.1, 1], [1.45, 0]]);
      P.move("Root", k.up(0.3 * H * air).add(k.fwd(0.35 * H * ahead)));
      P.move("Hips", k.up(-0.12 * H * crouch));
      pitch(P, "Spine", 0.3 * crouch + 0.15 * Math.max(0, slam));
      armsDown(P);
      for (const side of ["Left", "Right"] as const) {
        pitch(P, `${side}UpperArm`, -1.2 * air - 0.9 * Math.max(0, slam) + 0.4 * crouch);
        elbow(P, side, 0.3 + 0.5 * air);
        legs(P, side, -0.9 * crouch - 0.6 * air, 1.6 * crouch + 1.0 * air);
      }
    }),
    spinAttack(k, (P, e) => {
      P.move("Hips", k.up(-0.05 * H * e));
      armsDown(P, 1 - e);
      elbow(P, "Left", 0.2);
      elbow(P, "Right", 0.2);
      for (const side of ["Left", "Right"] as const) legs(P, side, -0.3 * e, 0.5 * e);
    }),
    // Weapons held in the right hand (a sword or hammer modelled into the hand follows the Hand bone).
    k.clip("13", "Attack_Sweep", 1.2, (t, P) => {
      const load = keys(t, [[0, 0], [0.35, 1], [0.5, 0]]);
      const swing = keys(t, [[0.35, 0], [0.52, 1], [0.8, 1], [1.15, 0]]);
      const stance = keys(t, [[0, 0], [0.3, 1], [0.85, 1], [1.15, 0]]);
      P.move("Hips", k.up(-0.03 * H * stance));
      yaw(P, "Spine", -0.5 * load + 0.55 * swing);
      armsDown(P);
      roll(P, "RightUpperArm", -1.1 * stance);
      yaw(P, "RightUpperArm", -0.9 * load + 2.0 * swing);
      elbow(P, "Right", 0.3 + 0.8 * load);
      pitch(P, "LeftUpperArm", -0.4 * stance);
      elbow(P, "Left", 0.3 + 0.8 * stance);
      legs(P, "Left", -0.35 * stance, 0.4 * stance);
      legs(P, "Right", 0.25 * stance, 0.15 * stance);
    }),
    k.clip("13", "Attack_Thrust", 1, (t, P) => {
      const load = keys(t, [[0, 0], [0.3, 1], [0.4, 0]]);
      const hit = keys(t, [[0.3, 0], [0.42, 1], [0.6, 1], [0.95, 0]]);
      const stance = keys(t, [[0, 0], [0.25, 1], [0.7, 1], [0.95, 0]]);
      P.move("Hips", k.fwd(0.08 * H * hit - 0.02 * H * load).add(k.up(-0.04 * H * stance)));
      yaw(P, "Spine", -0.3 * load + 0.2 * hit);
      pitch(P, "Chest", 0.1 * hit);
      armsDown(P);
      pitch(P, "RightUpperArm", 0.4 * load - 1.4 * hit);
      elbow(P, "Right", 1.6 * load + 0.05 * hit + 0.3 * (1 - load - hit));
      pitch(P, "LeftUpperArm", 0.3 * stance);
      elbow(P, "Left", 0.3 + 0.5 * stance);
      legs(P, "Left", -0.6 * stance, 0.7 * stance);
      legs(P, "Right", 0.35 * stance, 0.1 * stance);
    }),
    // Two-handed hammer: raised high overhead, then slammed down to the ground in a crouch.
    k.clip("13", "Attack_Hammer", 1.6, (t, P) => {
      const raise = keys(t, [[0, 0], [0.5, 1], [0.66, 0]]);
      const slam = keys(t, [[0.5, 0], [0.68, 1], [1.05, 1], [1.55, 0]]);
      P.move("Hips", k.up(0.02 * H * raise - 0.08 * H * slam));
      pitch(P, "Spine", -0.15 * raise + 0.45 * slam);
      armsDown(P);
      for (const side of ["Left", "Right"] as const) {
        pitch(P, `${side}UpperArm`, -3.4 * raise - 1.3 * slam);
        elbow(P, side, 0.3 + 0.7 * raise);
        legs(P, side, -0.5 * slam, 0.9 * slam);
      }
      yaw(P, "LeftUpperArm", -0.35 * (raise + slam));
      yaw(P, "RightUpperArm", 0.35 * (raise + slam));
    }),
    ...(() => {
      /** Right-handed long gun at the shoulder: right hand on the grip, left hand forward under the barrel. */
      const rifle = (P: Poser, e: number) => {
        armsDown(P);
        pitch(P, "RightUpperArm", -0.7 * e);
        yaw(P, "RightUpperArm", 0.5 * e);
        elbow(P, "Right", 0.3 + 1.2 * e);
        pitch(P, "LeftUpperArm", -1.2 * e);
        yaw(P, "LeftUpperArm", -0.85 * e);
        elbow(P, "Left", 0.3 + 0.2 * e);
        yaw(P, "Chest", -0.15 * e);
        pitch(P, "Head", 0.08 * e);
        legs(P, "Left", -0.15 * e, 0.15 * e);
        legs(P, "Right", 0.1 * e, 0.1 * e);
      };
      /** Recoil pulse per shot at `shots` times. */
      const recoil = (t: number, shots: number[]) => shots.reduce((a, s) => a + (t >= s ? Math.exp(-18 * (t - s)) : 0), 0);
      return [
        k.clip("15", "Aim_Rifle", 3, (_t, P, ph) => {
          rifle(P, 1);
          P.move("Hips", k.up(-0.004 * H * (1 - Math.cos(ph))));
          pitch(P, "Chest", 0.015 * Math.sin(ph));
        }),
        k.clip("15", "Shoot_Rifle", 1, (t, P) => {
          const kick = recoil(t, [0.1, 0.35, 0.6]);
          rifle(P, 1);
          pitch(P, "Chest", -0.1 * kick);
          pitch(P, "RightUpperArm", 0.2 * kick);
          pitch(P, "LeftUpperArm", 0.2 * kick);
          pitch(P, "Head", -0.04 * kick);
        }),
        k.clip("15", "Shoot_Pistol", 1.2, (t, P) => {
          const e = keys(t, [[0, 0], [0.2, 1], [0.95, 1], [1.2, 0]]);
          const kick = recoil(t, [0.35, 0.7]);
          armsDown(P);
          pitch(P, "RightUpperArm", -1.45 * e);
          yaw(P, "RightUpperArm", 0.65 * e);
          elbow(P, "Right", 0.3 * (1 - e) + 0.05 + 0.35 * kick);
          pitch(P, "LeftUpperArm", -1.3 * e);
          yaw(P, "LeftUpperArm", -0.85 * e);
          elbow(P, "Left", 0.3 + 0.3 * e);
          pitch(P, "Chest", -0.03 * kick);
          legs(P, "Left", -0.15 * e, 0.15 * e);
          legs(P, "Right", 0.1 * e, 0.1 * e);
        }),
        k.clip("15", "Reload", 2, (t, P) => {
          // Gun lowered and tilted, left hand drops to the belt for a magazine and slaps it in.
          const down = keys(t, [[0, 0], [0.3, 1], [1.6, 1], [1.9, 0]]);
          const reach = keys(t, [[0.3, 0], [0.7, 1], [1.0, 1], [1.35, 0]]);
          const slap = recoil(t, [1.35]);
          rifle(P, 1);
          pitch(P, "RightUpperArm", 0.35 * down);
          pitch(P, "LeftUpperArm", 1.2 * reach + 0.3 * down);
          elbow(P, "Left", 0.6 * reach);
          pitch(P, "Chest", 0.08 * down + 0.05 * slap);
          pitch(P, "Head", 0.25 * down);
        }),
      ];
    })(),
    // Hit reaction: a jolt backwards from a blow to the chest, then recover.
    k.clip("14", "Hit", 0.7, (t, P) => {
      const e = keys(t, [[0, 0], [0.08, 1], [0.25, 0.8], [0.7, 0]]);
      P.move("Hips", k.fwd(-0.03 * H * e).add(k.up(-0.015 * H * e)));
      pitch(P, "Spine", -0.2 * e);
      pitch(P, "Chest", -0.15 * e);
      pitch(P, "Head", -0.3 * e);
      armsDown(P, 1 - 0.25 * e);
      pitch(P, "LeftUpperArm", 0.3 * e);
      pitch(P, "RightUpperArm", 0.3 * e);
      elbow(P, "Left", 0.3 + 0.4 * e);
      elbow(P, "Right", 0.3 + 0.4 * e);
      legs(P, "Left", -0.15 * e, 0.3 * e);
      legs(P, "Right", 0.1 * e, 0.2 * e);
    }),
    // Death: knees buckle, then a limp fall forward onto the ground; ends lying there.
    k.clip("14", "Death", 2.2, (t, P) => {
      const buckle = keys(t, [[0, 0], [0.5, 1]]);
      const e = keys(t, [[0.4, 0], [1.2, 1], [1.3, 0.95], [1.42, 1]]);
      P.move("Hips", k.up(-0.08 * H * buckle * (1 - e)));
      pitch(P, "Spine", 0.25 * buckle * (1 - e));
      pitch(P, "Head", -0.4 * e);
      armsDown(P, 1 - 0.6 * e);
      pitch(P, "LeftUpperArm", -0.4 * buckle * (1 - e));
      pitch(P, "RightUpperArm", -0.4 * buckle * (1 - e));
      elbow(P, "Left", 0.3 + 0.5 * e);
      elbow(P, "Right", 0.3 + 0.3 * e);
      legs(P, "Left", -0.5 * buckle * (1 - e), 0.9 * buckle * (1 - e) + 0.3 * e);
      legs(P, "Right", -0.3 * buckle * (1 - e), 0.6 * buckle * (1 - e) + 0.6 * e);
      // The Root last, so the limbs above are posed in the body's own axes.
      P.move("Root", k.up(0.09 * H * e));
      pitch(P, "Root", (Math.PI / 2) * e);
    }),
    ...common(k),
  ];
}

// ---------------------------------------------------------------- quadruped

function quadruped(k: Kit): RigClip[] {
  const { H, pitch, roll, yaw } = k;
  const tail = (P: Poser, ph: number, a: number) =>
    ["Tail1", "Tail2", "Tail3"].forEach((b, i) => yaw(P, b, a * Math.sin(ph - 0.8 * i)));
  /** Legs with gait phase offsets [FL, FR, RL, RR]. */
  const legs = (P: Poser, ph: number, offs: number[], amp: number, knee: number) =>
    (["FrontL", "FrontR", "RearL", "RearR"] as const).forEach((leg, i) => {
      const [pos, side] = [leg.slice(0, -1), leg.slice(-1)];
      const [s, c] = [Math.sin(ph + offs[i]), Math.cos(ph + offs[i])];
      pitch(P, `${pos}UpperLeg${side}`, -amp * s);
      pitch(P, `${pos}LowerLeg${side}`, knee * Math.max(0, c));
    });
  const crouchLegs = (P: Poser, e: number) =>
    (["FrontL", "FrontR", "RearL", "RearR"] as const).forEach((leg) => {
      const [pos, side] = [leg.slice(0, -1), leg.slice(-1)];
      pitch(P, `${pos}UpperLeg${side}`, (pos === "Front" ? -0.4 : 0.4) * e);
      pitch(P, `${pos}LowerLeg${side}`, (pos === "Front" ? 0.8 : -0.8) * e);
    });
  return [
    k.clip("04", "Idle", 3, (_t, P, ph) => {
      pitch(P, "Spine", 0.02 * Math.sin(ph));
      pitch(P, "Neck", 0.05 * Math.sin(2 * ph));
      yaw(P, "Head", 0.3 * Math.sin(ph));
      tail(P, 3 * ph, 0.25);
    }),
    k.clip("04", "Walk", 1.2, (_t, P, ph) => {
      P.move("Hips", k.up(0.01 * H * Math.cos(2 * ph)));
      roll(P, "Spine", 0.03 * Math.sin(ph));
      pitch(P, "Neck", 0.05 * Math.cos(2 * ph));
      legs(P, ph, [0, Math.PI, Math.PI, 0], 0.35, 0.6);
      tail(P, ph, 0.25);
    }),
    // Fast trot: left and right legs of each pair half a cycle apart (a gallop moves them almost together,
    // which reads as hopping on two-legged characters rigged with this template).
    k.clip("04", "Run", 0.55, (_t, P, ph) => {
      P.move("Root", k.up(0.04 * H * Math.max(0, Math.sin(2 * ph))));
      pitch(P, "Spine", 0.04 * Math.sin(2 * ph));
      roll(P, "Spine", 0.05 * Math.sin(ph));
      pitch(P, "Neck", 0.1 * Math.sin(2 * ph + 1));
      legs(P, ph, [0, Math.PI, Math.PI + 0.3, 0.3], 0.7, 1.2);
      pitch(P, "Tail1", -0.3);
      tail(P, ph, 0.15);
    }),
    k.clip("06", "Jump", 1.4, (t, P) => {
      const crouch = keys(t, [[0, 0], [0.3, 1], [0.4, 0], [0.9, 0], [1.05, 0.7], [1.35, 0]]);
      const air = t > 0.38 && t < 1.0 ? Math.sin((Math.PI * (t - 0.38)) / 0.62) : 0;
      P.move("Root", k.up(0.3 * H * air));
      P.move("Hips", k.up(-0.08 * H * crouch));
      pitch(P, "Hips", -0.2 * air);
      crouchLegs(P, crouch + 0.6 * air);
      pitch(P, "Tail1", -0.3 * air);
    }),
    k.clip("06", "Fall", 2, (t, P) => {
      const e = keys(t, [[0, 0], [0.25, 0.05], [0.9, 1], [1.0, 0.94], [1.12, 1]]);
      P.move("Root", k.up(0.18 * H * e));
      roll(P, "Root", (Math.PI / 2) * e);
      crouchLegs(P, 0.4 * e);
    }),
    k.clip("11", "Interact_Eat", 2.4, (t, P) => {
      const e = keys(t, [[0, 0], [0.6, 1], [1.8, 1], [2.4, 0]]);
      pitch(P, "Spine", 0.05 * e);
      pitch(P, "Neck", 0.9 * e);
      pitch(P, "Head", (0.4 + 0.08 * Math.sin(TAU * 3 * t)) * e);
      tail(P, TAU * t, 0.2);
    }),
    k.clip("13", "Attack_Bite", 1, (t, P) => {
      const load = keys(t, [[0, 0], [0.3, 1], [0.4, 0]]);
      const lunge = keys(t, [[0.3, 0], [0.42, 1], [0.6, 1], [0.95, 0]]);
      const snap = keys(t, [[0.38, 0], [0.45, 1], [0.52, 0.2], [0.58, 1], [0.8, 0]]);
      P.move("Root", k.fwd(k.len * (0.1 * lunge - 0.04 * load)));
      P.move("Hips", k.up(-0.04 * H * load));
      pitch(P, "Spine", 0.06 * lunge);
      pitch(P, "Neck", -0.35 * load + 0.25 * lunge);
      pitch(P, "Head", -0.2 * load + 0.35 * snap);
      crouchLegs(P, 0.5 * load);
      pitch(P, "Tail1", -0.4 * (load + lunge));
    }),
    k.clip("13", "Attack_Swipe", 1.3, (t, P) => {
      const rear = keys(t, [[0, 0], [0.4, 1], [0.8, 1], [1.25, 0]]);
      const raise = keys(t, [[0.1, 0], [0.4, 1], [0.55, 0], [1.25, 0]]);
      const swipe = keys(t, [[0.4, 0], [0.55, 1], [0.8, 1], [1.25, 0]]);
      // Rear up on the hind legs, then strike down with the left front paw.
      pitch(P, "Hips", -0.35 * rear);
      pitch(P, "RearUpperLegL", 0.35 * rear);
      pitch(P, "RearUpperLegR", 0.35 * rear);
      pitch(P, "Neck", 0.2 * rear);
      pitch(P, "FrontUpperLegL", -1.3 * raise - 0.2 * swipe);
      pitch(P, "FrontLowerLegL", 0.9 * raise);
      pitch(P, "FrontUpperLegR", -0.3 * rear);
      pitch(P, "FrontLowerLegR", 0.6 * rear);
      pitch(P, "Tail1", -0.3 * rear);
    }),
    // Pounce (nhảy tới): crouch, leap forward with the front paws reaching out, land, walk back to the spot.
    k.clip("13", "Attack_Pounce", 1.5, (t, P) => {
      const crouch = keys(t, [[0, 0], [0.3, 1], [0.4, 0], [0.85, 0], [0.95, 0.7], [1.45, 0]]);
      const air = t > 0.38 && t < 0.9 ? Math.sin((Math.PI * (t - 0.38)) / 0.52) : 0;
      const ahead = keys(t, [[0.35, 0], [0.9, 1], [1.1, 1], [1.45, 0]]);
      P.move("Root", k.up(0.25 * H * air).add(k.fwd(0.35 * k.len * ahead)));
      P.move("Hips", k.up(-0.08 * H * crouch));
      pitch(P, "Hips", -0.25 * air);
      crouchLegs(P, crouch);
      for (const side of ["L", "R"]) {
        pitch(P, `FrontUpperLeg${side}`, -0.9 * air);
        pitch(P, `RearUpperLeg${side}`, 0.6 * air);
      }
      pitch(P, "Neck", 0.2 * air);
      pitch(P, "Tail1", -0.4 * air);
    }),
    k.clip("13", "Attack_Stomp", 1.2, (t, P) => {
      const rear = keys(t, [[0, 0], [0.4, 1], [0.52, 0]]);
      const impact = keys(t, [[0.45, 0], [0.52, 1], [0.75, 1], [1.15, 0]]);
      pitch(P, "Hips", -0.4 * rear);
      for (const side of ["L", "R"]) {
        pitch(P, `RearUpperLeg${side}`, 0.4 * rear);
        pitch(P, `FrontUpperLeg${side}`, -0.9 * rear);
        pitch(P, `FrontLowerLeg${side}`, 1.0 * rear);
      }
      crouchLegs(P, 0.5 * impact);
      pitch(P, "Neck", 0.25 * impact);
      pitch(P, "Tail1", -0.3 * (rear + impact));
    }),
    k.clip("13", "Attack_Headbutt", 1.2, (t, P) => {
      const lower = keys(t, [[0, 0], [0.35, 1], [0.8, 1], [1.15, 0]]);
      const charge = keys(t, [[0.3, -0.3], [0.45, 1], [0.65, 1], [1.15, 0]]);
      P.move("Root", k.fwd(0.18 * k.len * charge * lower));
      pitch(P, "Neck", 0.5 * lower);
      pitch(P, "Head", 0.35 * lower);
      crouchLegs(P, 0.4 * lower * Math.max(0, -charge / 0.3));
      pitch(P, "Tail1", -0.3 * lower);
    }),
    spinAttack(k, (P, e) => {
      crouchLegs(P, 0.3 * e);
      pitch(P, "Tail1", -0.3 * e);
      tail(P, Math.PI / 2, 0.5 * e);
    }),
    k.clip("14", "Hit", 0.7, (t, P) => {
      const e = keys(t, [[0, 0], [0.08, 1], [0.25, 0.8], [0.7, 0]]);
      P.move("Root", k.fwd(-0.05 * k.len * e));
      P.move("Hips", k.up(-0.04 * H * e));
      pitch(P, "Spine", -0.08 * e);
      pitch(P, "Neck", -0.35 * e);
      pitch(P, "Head", -0.2 * e);
      crouchLegs(P, 0.3 * e);
      pitch(P, "Tail1", 0.4 * e);
    }),
    // Death: sag, legs give way, roll onto the side; ends lying there.
    k.clip("14", "Death", 2.2, (t, P) => {
      const sag = keys(t, [[0, 0], [0.5, 1]]);
      const e = keys(t, [[0.4, 0], [1.2, 1], [1.3, 0.95], [1.42, 1]]);
      P.move("Hips", k.up(-0.08 * H * sag * (1 - e)));
      crouchLegs(P, 0.6 * sag * (1 - e) + 0.3 * e);
      pitch(P, "Neck", 0.5 * sag - 0.3 * e);
      pitch(P, "Head", 0.2 * sag);
      pitch(P, "Tail1", 0.3 * sag);
      P.move("Root", k.up(0.18 * H * e));
      roll(P, "Root", (Math.PI / 2) * e);
    }),
    ...common(k),
  ];
}

// ---------------------------------------------------------------- bird

function bird(k: Kit): RigClip[] {
  const { H, pitch, roll, yaw } = k;
  const wings = (P: Poser, ph: number, amp: number) => {
    roll(P, "Wing1L", amp * Math.sin(ph));
    roll(P, "Wing2L", 0.55 * amp * Math.sin(ph - 0.7));
    roll(P, "Wing1R", -amp * Math.sin(ph));
    roll(P, "Wing2R", -0.55 * amp * Math.sin(ph - 0.7));
  };
  const tuckLegs = (P: Poser) => ["LegL", "LegR"].forEach((b) => pitch(P, b, 0.9));
  return [
    k.clip("07", "Fly", 0.6, (_t, P, ph) => {
      P.move("Root", k.up(0.15 * H + 0.03 * H * Math.sin(ph)));
      wings(P, ph, 0.9);
      pitch(P, "Tail", -0.1 * Math.sin(ph));
      tuckLegs(P);
    }),
    k.clip("07", "Glide", 3, (_t, P, ph) => {
      P.move("Root", k.up(0.15 * H));
      roll(P, "Root", 0.2 * Math.sin(ph));
      wings(P, 2 * ph, 0.08);
      tuckLegs(P);
    }),
    k.clip("04", "Idle", 3, (_t, P, ph) => {
      pitch(P, "Neck", 0.08 * Math.sin(2 * ph));
      yaw(P, "Head", 0.5 * Math.sin(ph));
      pitch(P, "Tail", 0.1 * Math.sin(3 * ph));
    }),
    k.clip("06", "Hop", 0.8, (t, P) => {
      const air = t < 0.5 ? Math.sin((Math.PI * t) / 0.5) : 0;
      P.move("Root", k.up(0.12 * H * air));
      ["LegL", "LegR"].forEach((b) => pitch(P, b, 0.3 * air));
      wings(P, (TAU * t) / 0.5, 0.25 * air);
    }),
    k.clip("11", "Interact_Peck", 1.2, (_t, P, ph) => {
      const e = Math.max(0, Math.sin(3 * ph)) ** 2;
      pitch(P, "Neck", 0.9 * e);
      pitch(P, "Head", 0.3 * e);
    }),
    k.clip("13", "Attack_Peck", 1, (t, P) => {
      const load = keys(t, [[0, 0], [0.3, 1], [0.4, 0]]);
      const strike = keys(t, [[0.3, 0], [0.42, 1], [0.6, 1], [0.95, 0]]);
      const flare = keys(t, [[0, 0], [0.3, 1], [0.6, 1], [0.95, 0]]);
      P.move("Root", k.fwd(k.len * (0.08 * strike - 0.03 * load)));
      pitch(P, "Hips", 0.2 * strike);
      pitch(P, "Neck", -0.5 * load + 0.8 * strike);
      pitch(P, "Head", 0.3 * strike);
      wings(P, Math.PI / 2, 0.7 * flare);
      pitch(P, "Tail", -0.3 * flare);
    }),
    // Talon pounce: a flapping hop forward with the feet thrown out in front.
    k.clip("13", "Attack_Pounce", 1.2, (t, P) => {
      const air = t > 0.2 && t < 0.8 ? Math.sin((Math.PI * (t - 0.2)) / 0.6) : 0;
      const ahead = keys(t, [[0.15, 0], [0.8, 1], [0.9, 1], [1.2, 0]]);
      P.move("Root", k.up(0.2 * H * air).add(k.fwd(0.3 * k.len * ahead)));
      pitch(P, "Hips", -0.3 * air);
      ["LegL", "LegR"].forEach((b) => pitch(P, b, -0.8 * air));
      wings(P, (TAU * t) / 0.3, 0.8 * air);
    }),
    spinAttack(k, (P, e) => wings(P, Math.PI / 2, 0.6 * e)),
    k.clip("14", "Hit", 0.7, (t, P) => {
      const e = keys(t, [[0, 0], [0.08, 1], [0.25, 0.8], [0.7, 0]]);
      P.move("Root", k.fwd(-0.06 * k.len * e));
      pitch(P, "Hips", -0.15 * e);
      pitch(P, "Neck", -0.4 * e);
      wings(P, Math.PI / 2, 0.5 * e);
    }),
    // Death: a last weak flap, then topple onto the side with the wings limp; ends lying there.
    k.clip("14", "Death", 2, (t, P) => {
      const flap = t < 0.6 ? Math.sin((Math.PI * t) / 0.6) : 0;
      const e = keys(t, [[0.4, 0], [1.1, 1], [1.2, 0.95], [1.32, 1]]);
      wings(P, (TAU * t) / 0.3, 0.3 * flap);
      wings(P, -Math.PI / 2, 0.3 * e);
      pitch(P, "Neck", 0.6 * e);
      ["LegL", "LegR"].forEach((b) => pitch(P, b, 0.9 * e));
      P.move("Root", k.up(0.12 * H * e));
      roll(P, "Root", (Math.PI / 2) * e);
    }),
    ...common(k),
  ];
}

// ---------------------------------------------------------------- fish

function fish(k: Kit): RigClip[] {
  const { H, pitch, yaw } = k;
  const amps = [0.04, 0.06, 0.08, 0.11, 0.14, 0.18];
  const wave = (P: Poser, ph: number, scale: number, turn: typeof yaw) =>
    amps.forEach((a, i) => turn(P, `Spine${i + 1}`, scale * a * Math.sin(ph - 0.9 * i)));
  return [
    k.clip("08", "Swim", 1.2, (_t, P, ph) => wave(P, ph, 1, yaw)),
    k.clip("08", "Swim_Fast", 0.6, (_t, P, ph) => wave(P, ph, 1.4, yaw)),
    // Whales and dolphins beat their tail up and down.
    k.clip("08", "Swim_Dolphin", 1.4, (_t, P, ph) => {
      P.move("Root", k.up(0.04 * H * Math.sin(ph)));
      wave(P, ph, 1, pitch);
    }),
    k.clip("08", "Swim_Idle", 3, (_t, P, ph) => {
      P.move("Root", k.up(0.03 * H * Math.sin(ph)));
      wave(P, ph, 0.4, yaw);
    }),
    k.clip("13", "Attack_Bite", 1, (t, P) => {
      // Curl back, then a tail beat drives a lunge forward.
      const load = keys(t, [[0, 0], [0.3, 1], [0.4, 0]]);
      const lunge = keys(t, [[0.3, 0], [0.45, 1], [0.6, 1], [0.95, 0]]);
      P.move("Root", k.fwd(k.len * (0.25 * lunge - 0.05 * load)));
      amps.forEach((a, i) => yaw(P, `Spine${i + 1}`, 2.5 * a * (load - lunge * Math.sin(TAU * 2 * t - 0.9 * i))));
      pitch(P, "Spine1", -0.15 * lunge);
    }),
    spinAttack(k, (P, e) => amps.forEach((a, i) => yaw(P, `Spine${i + 1}`, 2 * a * e))),
    k.clip("14", "Hit", 0.8, (t, P) => {
      const e = keys(t, [[0, 0], [0.08, 1], [0.3, 0.6], [0.8, 0]]);
      P.move("Root", k.fwd(-0.1 * k.len * e));
      amps.forEach((a, i) => yaw(P, `Spine${i + 1}`, 3 * a * e * Math.sin(TAU * 3 * t - 0.9 * i)));
    }),
    // Death: go limp and roll belly-up, drifting up a little; ends floating there.
    k.clip("14", "Death", 2.4, (t, P) => {
      const e = keys(t, [[0, 0], [1.4, 1]]);
      const twitch = Math.exp(-3 * t) * Math.sin(TAU * 4 * t);
      amps.forEach((a, i) => yaw(P, `Spine${i + 1}`, 2 * a * twitch + 0.5 * a * e));
      // Flipping about the Root (on the ground) puts the body below it: lift by the body height, plus the drift.
      P.move("Root", k.up(1.15 * H * e));
      k.roll(P, "Root", Math.PI * e);
    }),
    tap(k),
    ...common(k),
  ];
}

// ---------------------------------------------------------------- vehicles and aircraft

function vehicle(k: Kit): RigClip[] {
  const { r, H, len, L, pitch, roll, yaw } = k;
  const wheels = Object.entries(r.plan.wheelRadius);
  const rootS = r.plan.bones[0].head.dot(k.F);
  const front = new Set(wheels.filter(([b]) => r.plan.bones[r.index.get(b)!].head.dot(k.F) > rootS).map(([b]) => b));
  /** Wheels roll `turns(radius)` whole turns per clip so the loop is seamless. */
  const spin = (P: Poser, t: number, T: number, distance: number) =>
    wheels.forEach(([b, radius]) => P.rot(b, L, (TAU * Math.max(1, Math.round(distance / (TAU * radius))) * t) / T));
  return [
    k.clip("05", "Drive", 2, (t, P, ph) => {
      spin(P, t, 2, 1.2 * len);
      P.move("Body", k.up(0.004 * H * Math.sin(6 * ph)));
      pitch(P, "Body", 0.01 * Math.sin(2 * ph));
    }),
    k.clip("05", "Drive_Loop", 6, (t, P, ph) => {
      // Circle around the rest position (starting on it, heading forward), so it stays in view.
      const R = 0.6 * len;
      spin(P, t, 6, TAU * R);
      front.forEach((b) => yaw(P, b, 0.3)); // steer (after spinning, so the wheel turns on its axle first)
      P.move("Root", k.fwd(R * Math.sin(ph)).addScaledVector(L, R * (1 - Math.cos(ph)) - R));
      yaw(P, "Root", ph);
      roll(P, "Body", -0.04);
    }),
    k.clip("05", "Engine_Idle", 1, (t, P) => {
      P.move("Body", k.up(0.002 * H * Math.sin(TAU * 8 * t)));
      roll(P, "Body", 0.003 * Math.sin(TAU * 6 * t));
    }),
    k.clip("05", "Brake", 1.6, (t, P) => {
      // Wheels decelerate to a stop by 0.8s while the body dips forward and settles.
      const u = Math.min(t, 0.8);
      wheels.forEach(([b, radius]) => P.rot(b, L, ((0.6 * len) / radius) * (u - (u * u) / 1.6)));
      pitch(P, "Body", 0.05 * keys(t, [[0, 0], [0.5, 1], [0.9, -0.3], [1.3, 0.1], [1.6, 0]]));
    }),
    tap(k),
    ...common(k),
  ];
}

function aircraft(k: Kit): RigClip[] {
  const { len, L, pitch, roll, yaw } = k;
  return [
    k.clip("07", "Fly_Loop", 8, (_t, P, ph) => {
      const R = 0.5 * len;
      P.move("Root", k.fwd(R * Math.sin(ph)).addScaledVector(L, R * (1 - Math.cos(ph)) - R).add(k.up(0.25 * len + 0.05 * len * Math.sin(2 * ph))));
      roll(P, "Root", -0.35); // bank into the left turn, then head along the circle
      yaw(P, "Root", ph);
    }),
    k.clip("07", "Hover", 3, (_t, P, ph) => {
      P.move("Root", k.up(0.05 * len * Math.sin(ph)));
      roll(P, "Root", 0.05 * Math.sin(2 * ph));
      pitch(P, "Root", 0.03 * Math.sin(ph));
    }),
    k.clip("07", "Takeoff", 4, (t, P) => {
      const lift = t > 2 ? ((t - 2) / 2) ** 2 * 0.8 * len : 0;
      P.move("Root", k.fwd(1.6 * len * (t / 4) ** 2).add(k.up(lift)));
      pitch(P, "Root", -0.25 * keys(t, [[1.6, 0], [2.4, 1]]));
    }),
    tap(k),
    ...common(k),
  ];
}

// ---------------------------------------------------------------- plants, water and smoke

function plant(k: Kit): RigClip[] {
  const { pitch, roll } = k;
  const trunk = ["Trunk1", "Trunk2", "Trunk3", "Trunk4", "Trunk5"];
  return [
    k.clip("09", "Sway", 4, (_t, P, ph) =>
      trunk.forEach((b, i) => {
        pitch(P, b, 0.03 * Math.sin(ph - 0.35 * i));
        roll(P, b, 0.02 * Math.sin(2 * ph - 0.35 * i + 1));
      }),
    ),
    k.clip("09", "Bend", 3, (_t, P, ph) =>
      trunk.forEach((b, i) => pitch(P, b, 0.08 * (0.5 - 0.5 * Math.cos(ph)) * (0.6 + 0.2 * i))),
    ),
    k.clip("12", "Wind", 6, (_t, P, ph) =>
      trunk.forEach((b, i) => {
        pitch(
          P,
          b,
          0.035 * (1 + Math.sin(ph - 0.3 * i)) + 0.02 * Math.sin(3 * ph + 1 - 0.5 * i) + 0.01 * Math.sin(7 * ph + 2 - 0.8 * i),
        );
        roll(P, b, 0.015 * Math.sin(2 * ph + 0.5 - 0.4 * i));
      }),
    ),
    k.clip("11", "Interact_Shake", 1.5, (t, P) => {
      const e = Math.exp(-3 * t);
      trunk.forEach((b) => {
        pitch(P, b, 0.1 * e * Math.sin(TAU * 3 * t));
        roll(P, b, 0.07 * e * Math.sin(TAU * 3 * t + 1.2));
      });
    }),
    ...common(k),
  ];
}

function fluid(k: Kit): RigClip[] {
  const { pitch, roll } = k;
  const chains = [1, 2, 3, 4].map((c) => [1, 2, 3].map((j) => `Flow${c}_${j}`));
  return [
    k.clip("12", "Flow", 4, (_t, P, ph) =>
      chains.forEach((bones, c) =>
        bones.forEach((b, j) => {
          pitch(P, b, 0.06 * Math.sin(ph + 1.3 * c + 0.8 * j));
          roll(P, b, 0.05 * Math.sin(2 * ph + 0.7 * c - j));
        }),
      ),
    ),
    k.clip("12", "Ripple", 2, (_t, P, ph) =>
      chains.forEach((bones, c) => P.scale(bones[1], 1 + 0.05 * Math.sin(2 * ph + (c * Math.PI) / 2))),
    ),
    tap(k),
    ...common(k),
  ];
}

const BY_CATEGORY: Record<RigCategory, (k: Kit) => RigClip[]> = {
  humanoid,
  quadruped,
  bird,
  fish,
  vehicle,
  aircraft,
  plant,
  fluid,
  prop: (k) => [tap(k), ...common(k)],
};

export function buildClips(plan: RigPlan): RigClip[] {
  return BY_CATEGORY[plan.category](kit(rigOf(plan)));
}
