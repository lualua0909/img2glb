import { AnimationClip, type KeyframeTrack, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from "three";
import type { RigCategory, RigPlan, Weapon } from "./rig";

// Procedural animation clips baked at 30 fps. Motions are written against the rig frame (forward / lateral / up)
// and scaled by the model's size, so the same clip fits any model of a category.

/** Movement ids from the product spec: 01 Translate … 12 Environmental, plus game clips: 13 Attack, 14 Hit / death, 15 Shooting. */
export type Movement = "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12" | "13" | "14" | "15";
/** Body part that deals the damage in an attack. */
export type AttackOrgan =
  | "jaw"
  | "beak"
  | "head"
  | "horn"
  | "trunk"
  | "claw"
  | "talon"
  | "hoof"
  | "tail"
  | "wing"
  | "body"
  | "breath"
  | "hand"
  | "foot"
  | "weapon";
/**
 * Attack clips: the bones whose hitboxes deal damage and when (seconds into the clip). Ranged attacks have no hitbox
 * but a `projectile`: it leaves from `at` (fraction of the bone from its head to its tail: the middle of a bow, a
 * muzzle) at each of `times`, toward the character's forward direction.
 */
export type Attack = {
  organ: AttackOrgan;
  bones: string[];
  active: [number, number];
  projectile?: { bone: string; at: number; times: number[] };
};
export type RigClip = { clip: AnimationClip; movement: Movement; attack?: Attack };

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

const otherSide = (name: string) => name.replace(/Left|Right/, (x) => (x === "Left" ? "Right" : "Left"));

/** One frame's pose. Rotations and offsets are given in world axes and converted to each bone's parent space. */
class Poser {
  q: Quaternion[];
  p: Vector3[];
  s: Vector3[];
  /**
   * Plays a pose written for one side on the other (a left-handed weapon): bone names swap Left and Right, and
   * rotations, offsets and directions are reflected across the body's mid-plane. Positions (`pos`) are not.
   */
  mirror = false;
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
  private id(name: string) {
    return this.r.index.get(this.mirror ? otherSide(name) : name);
  }
  /** Reflection across the mid-plane when mirrored. */
  private flip(v: Vector3) {
    const L = this.r.plan.frame.lateral;
    return this.mirror ? v.clone().addScaledVector(L, -2 * v.dot(L)) : v.clone();
  }
  /** Rotates a bone about a world axis through its joint (applied after earlier rotations of the same bone). */
  rot(name: string, axis: Vector3, angle: number) {
    const i = this.id(name);
    if (i === undefined || angle === 0) return;
    const pw = this.parentWorld(i);
    // An axis is a pseudo-vector: its reflection is reversed.
    const world = new Quaternion().setFromAxisAngle(this.mirror ? this.flip(axis).negate() : axis, angle);
    this.q[i].premultiply(pw.clone().invert().multiply(world).multiply(pw));
  }
  move(name: string, offset: Vector3) {
    const i = this.id(name);
    if (i !== undefined) this.p[i].add(this.flip(offset).applyQuaternion(this.parentWorld(i).invert()));
  }
  scale(name: string, x: number, y = x, z = x) {
    const i = this.id(name);
    if (i !== undefined) this.s[i].multiply(new Vector3(x, y, z));
  }
  has(name: string) {
    return this.id(name) !== undefined;
  }
  /** Current world direction of a bone. */
  dir(name: string) {
    const i = this.id(name)!;
    return this.flip(this.r.restDir[i].clone().applyQuaternion(this.parentWorld(i).multiply(this.q[i])));
  }
  /** Current world position of a bone's joint (scale ignored). */
  pos(name: string) {
    const chain: number[] = [];
    for (let a = this.r.index.get(name)!; a >= 0; a = this.r.parents[a]) chain.push(a);
    const q = new Quaternion();
    const p = new Vector3();
    for (let k = chain.length - 1; k >= 0; k--) {
      p.add(this.p[chain[k]].clone().applyQuaternion(q));
      q.multiply(this.q[chain[k]]);
    }
    return p;
  }
}

const TRUNK = ["Trunk1", "Trunk2", "Trunk3"];

/**
 * Soft chain that trails the motion: its links (base first), natural frequencies (Hz), damping ratio and the most a
 * link may turn off its pose (radians).
 */
type Chain = { bones: string[]; hz: number[]; zeta: number; swing: number };

/** The trunk (stiffer at the base, looser toward the tip) and every feeler (softer: it only follows the motion). */
function chainsOf(r: Rig): Chain[] {
  const out: Chain[] = [];
  if (r.index.has(TRUNK[0])) out.push({ bones: TRUNK, hz: [2.4, 1.8, 1.4], zeta: 0.3, swing: Math.PI / 4 });
  for (const name of r.names) {
    const f = /^Feeler(\d+)_1([LR])$/.exec(name);
    if (f) out.push({ bones: [1, 2, 3].map((j) => `Feeler${f[1]}_${j}${f[2]}`), hz: [1.8, 1.3, 1], zeta: 0.35, swing: 0.6 });
  }
  return out;
}

/**
 * Follow-through for soft chains (a trunk, feelers): each link is a damped spring pulled toward its posed direction
 * and flung by the acceleration of the chain's base, so it lags, swings and settles whenever the body moves. Returns
 * the simulated world direction of each link of each chain per frame ([frame][chain][link]).
 */
function simulateChains(r: Rig, chains: Chain[], duration: number, frames: number, pose: (t: number, P: Poser) => void) {
  const P = new Poser(r);
  const sample = (t: number) => {
    P.reset();
    pose(t, P);
    return chains.map((c) => ({ dirs: c.bones.map((b) => P.dir(b)), base: P.pos(c.bones[0]) }));
  };
  const rest = sample(0);
  const end = sample(duration);
  const loops = chains.every(
    (_, c) =>
      end[c].base.distanceTo(rest[c].base) < 1e-3 * r.plan.height && end[c].dirs.every((d, i) => d.dot(rest[c].dirs[i]) > 0.999),
  );
  const state = chains.map((c, ci) => {
    const links = c.bones.map((b) => r.plan.bones[r.index.get(b)!]);
    return {
      // Distance from the base to the middle of each link (turns the base's acceleration into a swing).
      reach: links.map((b) => Math.max(b.head.clone().add(b.tail).multiplyScalar(0.5).distanceTo(links[0].head), 1e-3)),
      w0: c.hz.map((hz) => 2 * Math.PI * hz),
      d: rest[ci].dirs.map((v) => v.clone()),
      w: c.bones.map(() => new Vector3()),
      prev: rest[ci].base.clone(),
      vel: new Vector3(),
    };
  });
  const steps = 4;
  const dt = 1 / (30 * steps);
  const run = (record: boolean) => {
    const out: Vector3[][][] = [];
    for (let f = 0; f < frames; f++) {
      const t0 = (f / (frames - 1)) * duration;
      if (record) out.push(state.map((c) => c.d.map((v) => v.clone())));
      if (f === frames - 1) break;
      const t1 = ((f + 1) / (frames - 1)) * duration;
      for (let s = 1; s <= steps; s++) {
        const now = sample(t0 + ((t1 - t0) * s) / steps);
        const h = (t1 - t0) / steps || dt;
        state.forEach((c, ci) => {
          const { dirs, base } = now[ci];
          const v = base.clone().sub(c.prev).divideScalar(h);
          const acc = v.clone().sub(c.vel).divideScalar(h);
          c.prev = base;
          c.vel = v;
          c.d.forEach((di, i) => {
            const pull = dirs[i].clone().sub(di).multiplyScalar(c.w0[i] ** 2);
            const fling = acc.clone().addScaledVector(di, -acc.dot(di)).multiplyScalar(-1 / c.reach[i]);
            c.w[i].add(pull.add(fling).addScaledVector(c.w[i], -2 * chains[ci].zeta * c.w0[i]).multiplyScalar(h));
            di.addScaledVector(c.w[i], h).normalize();
            c.w[i].addScaledVector(di, -c.w[i].dot(di));
            // Never more than `swing` off the pose: back onto that cone around the posed direction.
            const cos = di.dot(dirs[i]);
            if (cos < Math.cos(chains[ci].swing)) {
              const side = di.addScaledVector(dirs[i], -cos).normalize();
              di.copy(dirs[i]).multiplyScalar(Math.cos(chains[ci].swing)).addScaledVector(side, Math.sin(chains[ci].swing)).normalize();
            }
          });
        });
      }
    }
    return out;
  };
  // A looping clip is run for a few seconds first so its start picks up where its end leaves off.
  if (loops) for (let k = 0; k < Math.ceil(3 / duration); k++) run(false);
  else
    state.forEach((c, ci) => {
      c.prev = rest[ci].base.clone();
      c.vel = new Vector3();
    });
  return run(true);
}

/** Turns each link of a chain from its posed direction to the simulated one, base first. */
function applyChain(P: Poser, bones: string[], dirs: Vector3[]) {
  bones.forEach((b, i) => {
    const cur = P.dir(b);
    const axis = new Vector3().crossVectors(cur, dirs[i]);
    const len = axis.length();
    if (len > 1e-6) P.rot(b, axis.divideScalar(len), Math.atan2(len, cur.dot(dirs[i])));
  });
}

/** Turns a bone toward a world direction, `amount` of the way, whatever its rest pose (no-op without the bone). */
function aim(P: Poser, b: string, target: Vector3, amount = 1) {
  if (!P.has(b) || amount === 0) return;
  const cur = P.dir(b);
  const t = target.clone().normalize();
  const axis = new Vector3().crossVectors(cur, t);
  const len = axis.length();
  if (len > 1e-6) P.rot(b, axis.divideScalar(len), amount * Math.atan2(len, cur.dot(t)));
}

function bake(r: Rig, name: string, duration: number, pose: (t: number, P: Poser) => void, mirror = false): AnimationClip {
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
  P.mirror = mirror;
  const eps = 1e-6 * Math.max(r.plan.height, r.plan.length);
  const chains = chainsOf(r);
  const soft = chains.length ? simulateChains(r, chains, duration, frames, pose) : null;
  for (let f = 0; f < frames; f++) {
    const t = (f / (frames - 1)) * duration;
    times[f] = t;
    P.reset();
    pose(t, P);
    if (soft) chains.forEach((c, ci) => applyChain(P, c.bones, soft[f][ci]));
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
  /** `mirror`: the pose is written for the other side (see `Poser.mirror`). */
  clip(movement: Movement, name: string, duration: number, pose: (t: number, P: Poser, phase: number) => void, mirror?: boolean): RigClip;
  /** Names of the bones matching `re`, in rig order. */
  bones(re: RegExp): string[];
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
    clip: (movement, name, duration, pose, mirror) => ({
      movement,
      clip: bake(r, name, duration, (t, P) => pose(t, P, (TAU * t) / duration), mirror),
    }),
    bones: (re) => r.names.filter((n) => re.test(n)),
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

/** Attack clip name -> the body part and bones that deal the damage, and when (seconds). */
type AttackTable = Record<string, [organ: AttackOrgan, bones: string[] | RegExp, active: [number, number]]>;
/** Marks the attack clips found in `table` (only the bones the rig has count), unless they already have one. */
const marked = (k: Kit, clips: RigClip[], table: AttackTable): RigClip[] =>
  clips.map((c) => {
    const a = table[c.clip.name];
    if (!a || c.attack) return c;
    const bones = a[1] instanceof RegExp ? k.bones(a[1]) : a[1].filter((b) => k.r.index.has(b));
    return { ...c, attack: { organ: a[0], bones, active: a[2] } };
  });

// ---------------------------------------------------------------- wings (birds, dragons)

const WING = ["WingUpper", "WingFore", "WingHand"];
type WingPose = (i: number, out: Vector3) => Vector3;
/** Wings open straight out to the sides. */
const spreadPose =
  (k: Kit): WingPose =>
  (i, out) =>
    out
      .clone()
      .addScaledVector(k.U, [0.15, 0.05, 0][i])
      .addScaledVector(k.F, [0, 0, -0.15][i]);
/** Wings folded along the body in a Z: upper arm back, forearm forward, hand back. */
const foldPose =
  (k: Kit): WingPose =>
  (i, out) =>
    [
    k.F.clone().multiplyScalar(-0.8).addScaledVector(out, 0.5).addScaledVector(k.U, 0.1),
    k.F.clone().multiplyScalar(0.7).addScaledVector(out, 0.4).addScaledVector(k.U, 0.2),
    k.F.clone().multiplyScalar(-1).addScaledVector(out, 0.15),
  ][i];
/** Poses both wings, `amount` of the way from where they are, shoulder first. */
function aimWings(k: Kit, P: Poser, pose: WingPose, amount: number) {
  for (const [s, sign] of [
    ["L", 1],
    ["R", -1],
  ] as const)
    WING.forEach((b, i) => aim(P, b + s, pose(i, k.L.clone().multiplyScalar(sign)), amount));
}
/** Flapping about the body axis, each joint lagging behind the one before it (up when `sin(ph)` > 0). */
function flap(k: Kit, P: Poser, ph: number, amp: number) {
  WING.forEach((b, i) => {
    const a = [1, 0.5, 0.35][i] * amp * Math.sin(ph - 0.6 * i);
    k.roll(P, `${b}L`, a);
    k.roll(P, `${b}R`, -a);
  });
}

const tap = (k: Kit) =>
  k.clip("11", "Interact_Tap", 1, (t, P) => {
    const s = Math.exp(-5 * t) * Math.sin(TAU * 2.5 * t);
    P.scale("Root", 1 + 0.12 * s, 1 - 0.16 * s, 1 + 0.12 * s);
  });

// ---------------------------------------------------------------- humanoid

type Side = "Left" | "Right";

function humanoid(k: Kit): RigClip[] {
  const { r, F, L, U, H, pitch, roll, yaw } = k;
  // Rest arm angle in the frontal plane: 0 = T-pose, -90° = hanging. Motions start from arms ~15° off the body.
  const armAngle = (side: "Left" | "Right") => {
    const d = r.restDir[r.index.get(`${side}UpperArm`)!];
    return Math.atan2(d.dot(U), d.dot(side === "Left" ? L : L.clone().negate()));
  };
  const [aL, aR] = [armAngle("Left"), armAngle("Right")];
  // Arms come down to ~15° off the body, or less when bulky arms would sink into the legs.
  const floor = r.plan.armFloor ?? { Left: -1.3, Right: -1.3 };
  const rest = { Left: aL, Right: aR };
  // A mirrored pose (see `Poser.mirror`) moves the other arm: it uses that arm's rest angle and floor.
  const real = (P: Poser, side: Side): Side => (P.mirror ? (side === "Left" ? "Right" : "Left") : side);
  const armsDown = (P: Poser, amount = 1) => {
    roll(P, "LeftUpperArm", (floor[real(P, "Left")] - rest[real(P, "Left")]) * amount);
    roll(P, "RightUpperArm", -(floor[real(P, "Right")] - rest[real(P, "Right")]) * amount);
  };
  /** After `armsDown`: raises an arm sideways toward `target` (frontal angle, 0 = T-pose), by `amount` of the way. */
  const armTo = (P: Poser, side: Side, target: number, amount = 1) =>
    roll(P, `${side}UpperArm`, (side === "Left" ? 1 : -1) * (target - floor[real(P, side)]) * amount);
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
  /**
   * Turns the weapon in that hand (its end -> tip) toward `target`, `amount` of the way, as a wrist does: mostly by
   * twisting the hand about the forearm (up to ~100°), then bending it a little (up to ~30°). However the weapon was
   * modelled in the hand, the blade, head or muzzle leads the strike, and the wrist never looks broken. The arm pose
   * does the rest. No-op without a weapon.
   */
  const point = (P: Poser, side: Side, target: Vector3, amount = 1) => {
    const [w, hand] = [`Weapon${side}`, `${side}Hand`];
    if (!P.has(w) || amount <= 0) return;
    const t = target.clone().normalize();
    const axis = P.dir(hand);
    const across = (v: Vector3) => v.clone().addScaledVector(axis, -v.dot(axis));
    const [a, b] = [across(P.dir(w)), across(t)];
    if (a.lengthSq() > 1e-6 && b.lengthSq() > 1e-6) {
      const twist = Math.atan2(a.clone().cross(b).dot(axis), a.dot(b));
      P.rot(hand, axis, amount * Math.max(-1.75, Math.min(1.75, twist)));
    }
    const cur = P.dir(w);
    const bend = new Vector3().crossVectors(cur, t);
    const len = bend.length();
    if (len > 1e-6) P.rot(hand, bend.divideScalar(len), amount * Math.min(Math.atan2(len, cur.dot(t)), 0.5));
  };
  /** Up for a bow or shield, whichever way its markers were placed (both ends are alike). */
  const up = (P: Poser, side: Side) => (P.has(`Weapon${side}`) && P.dir(`Weapon${side}`).dot(U) < 0 ? U.clone().negate() : U.clone());
  const weapons = r.plan.weapons ?? { Left: "none", Right: "none" };
  const unarmed = weapons.Left === "none" && weapons.Right === "none";
  /**
   * The hand holding one of `kinds` (`home` first). Poses are written for `home`: `mirror` plays them on the other
   * hand, and `bones` names the bones of the hand that actually moves.
   */
  const holding = (kinds: Weapon[], home: Side) => {
    const side = [home, home === "Left" ? "Right" : "Left"].find((x) => kinds.includes(weapons[x as Side])) as Side | undefined;
    if (!side) return null;
    const mirror = side !== home;
    return { kind: weapons[side], mirror, bones: (...b: string[]) => b.map((x) => (mirror ? otherSide(x) : x)) };
  };
  const MELEE: Weapon[] = ["sword", "axe", "hammer", "spear"];
  const GUNS: Weapon[] = ["pistol", "rifle", "crossbow"];
  /** Weapons carried at the ready (idle, walking): blades up and forward, bows and shields upright, guns low. */
  const carry = (P: Poser) => {
    for (const side of ["Left", "Right"] as const) {
      const w = weapons[side];
      if (w === "none") continue;
      point(P, side, MELEE.includes(w) ? U.clone().addScaledVector(F, 0.5) : GUNS.includes(w) ? F.clone().addScaledVector(U, -0.8) : up(P, side));
    }
  };
  // What strikes in whole-body attacks (spin, leap): melee weapons and shields, and the empty hands.
  const strikers = (["Left", "Right"] as const).flatMap((S) =>
    weapons[S] === "none" ? [`${S}Hand`] : [...MELEE, "shield"].includes(weapons[S]) ? [`Weapon${S}`] : [],
  );
  const hits = (c: RigClip, organ: AttackOrgan, bones: string[], active: [number, number]): RigClip => ({
    ...c,
    attack: { organ, bones: bones.filter((b) => r.index.has(b)), active },
  });
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
    carry(P);
    legs(P, "Left", -o.leg * s, 0.1 + o.knee * Math.max(0, c));
    legs(P, "Right", o.leg * s, 0.1 + o.knee * Math.max(0, -c));
    tail(P, ph, 0.25);
  };
  // ---- weapon attacks, posed for the weapon's usual hand (`mirror` plays them on the other one) ----
  const out = L.clone().negate();
  // Right hand: sword, axe, hammer, spear, guns.
  const slash = (mirror = false) =>
    k.clip("13", "Attack_Slash", 1.3, (t, P) => {
      const raise = keys(t, [[0, 0], [0.35, 1], [0.5, 0.3], [0.62, 0]]);
      const swing = keys(t, [[0.35, 0], [0.55, 1], [0.8, 1], [1.25, 0]]);
      P.move("Hips", k.up(-0.04 * H * swing).add(k.fwd(0.03 * H * swing)));
      yaw(P, "Spine", -0.35 * raise + 0.4 * swing);
      pitch(P, "Spine", -0.08 * raise + 0.25 * swing);
      armsDown(P);
      armTo(P, "Right", 0.8, raise);
      pitch(P, "RightUpperArm", 0.3 * raise - 0.8 * swing);
      elbow(P, "Right", 0.3 + 0.9 * raise);
      // Blade up and back over the shoulder, then down and across the body.
      point(P, "Right", U.clone().addScaledVector(F, -0.4).addScaledVector(out, 0.3), raise);
      point(P, "Right", F.clone().addScaledVector(U, -0.7).addScaledVector(L, 0.4), swing);
      pitch(P, "LeftUpperArm", -0.4 * swing);
      elbow(P, "Left", 0.4);
      legs(P, "Left", -0.45 * swing, 0.5 * swing);
      legs(P, "Right", 0.3 * swing, 0.1 * swing);
    }, mirror);
  const sweep = (mirror = false) =>
    k.clip("13", "Attack_Sweep", 1.2, (t, P) => {
      const load = keys(t, [[0, 0], [0.35, 1], [0.5, 0]]);
      const swing = keys(t, [[0.35, 0], [0.52, 1], [0.8, 1], [1.15, 0]]);
      const stance = keys(t, [[0, 0], [0.3, 1], [0.85, 1], [1.15, 0]]);
      P.move("Hips", k.up(-0.03 * H * stance));
      yaw(P, "Spine", -0.5 * load + 0.55 * swing);
      armsDown(P);
      armTo(P, "Right", -0.2, stance);
      yaw(P, "RightUpperArm", -0.9 * load + 2.0 * swing);
      elbow(P, "Right", 0.3 + 0.8 * load);
      // Blade level: out behind the hip, then across the front.
      point(P, "Right", out.clone().addScaledVector(F, -0.3), load);
      point(P, "Right", L.clone().multiplyScalar(0.7).addScaledVector(F, 0.7), swing);
      pitch(P, "LeftUpperArm", -0.4 * stance);
      elbow(P, "Left", 0.3 + 0.8 * stance);
      legs(P, "Left", -0.35 * stance, 0.4 * stance);
      legs(P, "Right", 0.25 * stance, 0.15 * stance);
    }, mirror);
  const thrust = (mirror = false) =>
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
      point(P, "Right", F, stance);
      pitch(P, "LeftUpperArm", 0.3 * stance);
      elbow(P, "Left", 0.3 + 0.5 * stance);
      legs(P, "Left", -0.6 * stance, 0.7 * stance);
      legs(P, "Right", 0.35 * stance, 0.1 * stance);
    }, mirror);
  // One-handed overhead smash (hammer, axe): raised above the head, then brought down in front.
  const smash = (mirror = false) =>
    k.clip("13", "Attack_Smash", 1.4, (t, P) => {
      const raise = keys(t, [[0, 0], [0.45, 1], [0.6, 0]]);
      const slam = keys(t, [[0.45, 0], [0.62, 1], [0.95, 1], [1.35, 0]]);
      P.move("Hips", k.up(0.02 * H * raise - 0.07 * H * slam));
      pitch(P, "Spine", -0.15 * raise + 0.4 * slam);
      yaw(P, "Spine", -0.2 * raise + 0.15 * slam);
      armsDown(P);
      pitch(P, "RightUpperArm", -3.0 * raise - 1.2 * slam);
      elbow(P, "Right", 0.3 + 0.9 * raise + 0.1 * slam);
      point(P, "Right", U.clone().addScaledVector(F, -0.6), raise);
      point(P, "Right", F.clone().addScaledVector(U, -0.8), slam);
      pitch(P, "LeftUpperArm", -0.3 * slam);
      elbow(P, "Left", 0.4 + 0.4 * slam);
      legs(P, "Left", -0.45 * slam, 0.6 * slam);
      legs(P, "Right", 0.3 * slam, 0.15 * slam);
    }, mirror);
  // Two-handed hammer: raised high overhead, then slammed down to the ground in a crouch.
  const hammer = (mirror = false) =>
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
      point(P, "Right", U.clone().addScaledVector(F, -0.6), raise);
      point(P, "Right", F.clone().addScaledVector(U, -0.8), slam);
    }, mirror);
  /** Long gun (rifle, crossbow) at the shoulder: right hand on the grip, left hand forward under the barrel. */
  const shoulder = (P: Poser, e: number) => {
    armsDown(P);
    pitch(P, "RightUpperArm", -0.7 * e);
    yaw(P, "RightUpperArm", 0.5 * e);
    elbow(P, "Right", 0.3 + 1.2 * e);
    pitch(P, "LeftUpperArm", -1.2 * e);
    yaw(P, "LeftUpperArm", -0.85 * e);
    elbow(P, "Left", 0.3 + 0.2 * e);
    yaw(P, "Chest", -0.15 * e);
    // Muzzle straight ahead.
    point(P, "Right", F, e);
    pitch(P, "Head", 0.08 * e);
    legs(P, "Left", -0.15 * e, 0.15 * e);
    legs(P, "Right", 0.1 * e, 0.1 * e);
  };
  /** Recoil pulse per shot at `shots` times. */
  const recoil = (t: number, shots: number[]) => shots.reduce((a, s) => a + (t >= s ? Math.exp(-18 * (t - s)) : 0), 0);
  const aimLong = (name: string, mirror = false) =>
    k.clip("15", `Aim_${name}`, 3, (_t, P, ph) => {
      shoulder(P, 1);
      P.move("Hips", k.up(-0.004 * H * (1 - Math.cos(ph))));
      pitch(P, "Chest", 0.015 * Math.sin(ph));
    }, mirror);
  const shootLong = (name: string, shots: number[], mirror = false) =>
    k.clip("15", `Shoot_${name}`, 1, (t, P) => {
      const kick = recoil(t, shots);
      shoulder(P, 1);
      pitch(P, "Chest", -0.1 * kick);
      pitch(P, "RightUpperArm", 0.2 * kick);
      pitch(P, "LeftUpperArm", 0.2 * kick);
      pitch(P, "Head", -0.04 * kick);
    }, mirror);
  const pistol = (mirror = false) =>
    k.clip("15", "Shoot_Pistol", 1.2, (t, P) => {
      const e = keys(t, [[0, 0], [0.2, 1], [0.95, 1], [1.2, 0]]);
      const kick = recoil(t, [0.35, 0.7]);
      armsDown(P);
      pitch(P, "RightUpperArm", -1.45 * e);
      yaw(P, "RightUpperArm", 0.65 * e);
      elbow(P, "Right", 0.3 * (1 - e) + 0.05 + 0.35 * kick);
      point(P, "Right", F, e);
      pitch(P, "LeftUpperArm", -1.3 * e);
      yaw(P, "LeftUpperArm", -0.85 * e);
      elbow(P, "Left", 0.3 + 0.3 * e);
      pitch(P, "Chest", -0.03 * kick);
      legs(P, "Left", -0.15 * e, 0.15 * e);
      legs(P, "Right", 0.1 * e, 0.1 * e);
    }, mirror);
  const reload = (mirror = false) =>
    k.clip("15", "Reload", 2, (t, P) => {
      // Gun lowered and tilted, left hand drops to the belt for a magazine and slaps it in.
      const down = keys(t, [[0, 0], [0.3, 1], [1.6, 1], [1.9, 0]]);
      const reach = keys(t, [[0.3, 0], [0.7, 1], [1.0, 1], [1.35, 0]]);
      const slap = recoil(t, [1.35]);
      shoulder(P, 1);
      pitch(P, "RightUpperArm", 0.35 * down);
      pitch(P, "LeftUpperArm", 1.2 * reach + 0.3 * down);
      elbow(P, "Left", 0.6 * reach);
      pitch(P, "Chest", 0.08 * down + 0.05 * slap);
      pitch(P, "Head", 0.25 * down);
    }, mirror);
  // Left hand: shield, bow.
  /** Shield raised in front of the chest, face forward (upright). */
  const guard = (P: Poser, e: number) => {
    armsDown(P);
    pitch(P, "LeftUpperArm", -1.0 * e);
    yaw(P, "LeftUpperArm", -0.5 * e);
    elbow(P, "Left", 0.3 + 1.1 * e);
    point(P, "Left", up(P, "Left").addScaledVector(F, 0.15), e);
  };
  const block = (mirror = false) =>
    k.clip("13", "Block", 1.6, (t, P) => {
      const e = keys(t, [[0, 0], [0.2, 1], [1.3, 1], [1.6, 0]]);
      P.move("Hips", k.up(-0.04 * H * e));
      pitch(P, "Spine", 0.1 * e);
      guard(P, e);
      pitch(P, "RightUpperArm", -0.3 * e);
      elbow(P, "Right", 0.3 + 0.5 * e);
      legs(P, "Left", -0.4 * e, 0.5 * e);
      legs(P, "Right", 0.3 * e, 0.15 * e);
    }, mirror);
  const bash = (mirror = false) =>
    k.clip("13", "Attack_ShieldBash", 1.1, (t, P) => {
      const load = keys(t, [[0, 0], [0.3, 1], [0.4, 0]]);
      const hit = keys(t, [[0.3, 0], [0.42, 1], [0.65, 1], [1.05, 0]]);
      const e = keys(t, [[0, 0], [0.2, 1], [0.8, 1], [1.05, 0]]);
      P.move("Hips", k.fwd(0.1 * H * hit - 0.02 * H * load).add(k.up(-0.04 * H * e)));
      // Left shoulder drawn back, then driven forward behind the shield.
      yaw(P, "Spine", 0.3 * load - 0.25 * hit);
      guard(P, e);
      pitch(P, "LeftUpperArm", -0.4 * hit);
      elbow(P, "Left", -0.8 * hit);
      pitch(P, "RightUpperArm", 0.3 * hit);
      elbow(P, "Right", 0.3 + 0.5 * e);
      legs(P, "Left", -0.5 * e, 0.6 * e);
      legs(P, "Right", 0.35 * e, 0.1 * e);
    }, mirror);
  /** Bow held out straight ahead in the left hand, upright; the right hand draws the string from the bow (0) to the chin (1). */
  const bowPose = (P: Poser, e: number, draw: number) => {
    armsDown(P);
    pitch(P, "LeftUpperArm", -1.5 * e);
    yaw(P, "LeftUpperArm", -0.15 * e);
    elbow(P, "Left", 0.3 * (1 - e));
    point(P, "Left", up(P, "Left").addScaledVector(F, 0.1), e);
    // Drawing elbow out at shoulder height, the forearm folds in toward the face.
    armTo(P, "Right", 0, e);
    yaw(P, "RightUpperArm", (-0.25 + 1.5 * (1 - draw)) * e);
    elbow(P, "Right", 0.3 * (1 - e) + (0.4 + 2.4 * draw) * e);
    pitch(P, "Head", 0.05 * e);
    legs(P, "Left", -0.15 * e, 0.15 * e);
    legs(P, "Right", 0.1 * e, 0.1 * e);
  };
  const aimBow = (mirror = false) =>
    k.clip("15", "Aim_Bow", 3, (_t, P, ph) => {
      bowPose(P, 1, 1);
      P.move("Hips", k.up(-0.004 * H * (1 - Math.cos(ph))));
      pitch(P, "Chest", 0.015 * Math.sin(ph));
    }, mirror);
  // Nock, draw, hold, release at 0.8 s (the drawing hand flies back), lower.
  const BOW_RELEASE = 0.8;
  const shootBow = (mirror = false) =>
    k.clip("15", "Shoot_Bow", 1.5, (t, P) => {
      const e = keys(t, [[0, 0], [0.25, 1], [1.2, 1], [1.5, 0]]);
      const draw = keys(t, [[0.25, 0], [0.65, 1], [BOW_RELEASE, 1], [BOW_RELEASE + 0.06, 1.2], [1.2, 0.8]]);
      bowPose(P, e, draw);
      pitch(P, "Chest", -0.03 * recoil(t, [BOW_RELEASE]));
    }, mirror);
  /** A ranged clip: `times` are when its projectile leaves the weapon (`at` along its bone). */
  const shot = (c: RigClip, bone: string, at: number, times: number[]): RigClip => ({
    ...c,
    attack: { organ: "weapon", bones: [], active: [times[0], times[times.length - 1]], projectile: { bone, at, times } },
  });

  /** No weapon set up: every weapon clip, on the hands (a weapon modelled into a hand follows the Hand bone). */
  const unarmedWeaponClips = () => [slash(), sweep(), thrust(), hammer(), aimLong("Rifle"), shootLong("Rifle", [0.1, 0.35, 0.6]), pistol(), reload()];
  /** The clips of the weapons held, with the weapon bones as their hitboxes (the striking part of them). */
  const weaponClips = () => {
    const list: RigClip[] = [];
    const melee = holding(MELEE, "Right");
    if (melee) {
      const { kind, mirror } = melee;
      const w = melee.bones("WeaponRight");
      if (kind === "sword" || kind === "axe") list.push(hits(slash(mirror), "weapon", w, [0.4, 0.6]));
      if (kind === "hammer" || kind === "axe") list.push(hits(smash(mirror), "weapon", w, [0.5, 0.68]));
      // Two-handed smash only with the other hand free.
      if (kind === "hammer" && weapons[mirror ? "Right" : "Left"] === "none") list.push(hits(hammer(mirror), "weapon", w, [0.55, 0.72]));
      if (kind === "sword" || kind === "spear") list.push(hits(thrust(mirror), "weapon", w, [0.33, 0.5]));
      list.push(hits(sweep(mirror), "weapon", w, [0.38, 0.58]));
    }
    const shield = holding(["shield"], "Left");
    if (shield) list.push(block(shield.mirror), hits(bash(shield.mirror), "weapon", shield.bones("WeaponLeft"), [0.32, 0.5]));
    const bow = holding(["bow"], "Left");
    if (bow) list.push(aimBow(bow.mirror), shot(shootBow(bow.mirror), bow.bones("WeaponLeft")[0], 0.5, [BOW_RELEASE]));
    const gun = holding(GUNS, "Right");
    if (gun) {
      const bone = gun.bones("WeaponRight")[0];
      if (gun.kind === "pistol") list.push(shot(pistol(gun.mirror), bone, 1, [0.35, 0.7]));
      else {
        const [name, times]: [string, number[]] = gun.kind === "rifle" ? ["Rifle", [0.1, 0.35, 0.6]] : ["Crossbow", [0.3]];
        list.push(aimLong(name, gun.mirror), shot(shootLong(name, times, gun.mirror), bone, 1, times));
      }
      list.push(reload(gun.mirror));
    }
    return list;
  };
  return marked(k, [
    k.clip("04", "Idle", 3, (_t, P, ph) => {
      P.move("Hips", k.up(-0.004 * H * (1 - Math.cos(ph))));
      pitch(P, "Chest", 0.03 * Math.sin(ph));
      yaw(P, "Head", 0.12 * Math.sin(ph));
      armsDown(P);
      pitch(P, "LeftUpperArm", 0.04 * Math.sin(ph));
      pitch(P, "RightUpperArm", 0.04 * Math.sin(ph));
      elbow(P, "Left", 0.15);
      elbow(P, "Right", 0.15);
      carry(P);
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
      armTo(P, "Left", 0, raise);
      armTo(P, "Right", 0, raise);
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
      armTo(P, "Right", 1.0);
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
    ...(weapons.Right === "none"
      ? [
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
            point(P, "Left", up(P, "Left"), guard);
            legs(P, "Left", -0.3 * guard, 0.25 * guard);
            legs(P, "Right", 0.2 * guard, 0.1 * guard);
          }),
        ]
      : []),
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
    ...(unarmed
      ? [
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
        ]
      : []),
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
    (() => {
      const c = k.clip("13", "Attack_Leap", 1.5, (t, P) => {
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
          // Blades up over the head in the air, down onto the target at the landing.
          if (MELEE.includes(weapons[side])) {
            point(P, side, U.clone().addScaledVector(F, -0.3), air);
            point(P, side, F.clone().addScaledVector(U, -0.8), Math.max(0, slam));
          }
        }
      });
      return unarmed ? c : hits(c, "weapon", strikers, [0.8, 1.1]);
    })(),
    (() => {
      const c = spinAttack(k, (P, e) => {
        P.move("Hips", k.up(-0.05 * H * e));
        armsDown(P, 1 - e);
        elbow(P, "Left", 0.2);
        elbow(P, "Right", 0.2);
        // Blades held straight out, so they sweep the circle.
        for (const side of ["Left", "Right"] as const)
          if (MELEE.includes(weapons[side])) point(P, side, side === "Left" ? L : L.clone().negate(), e);
        for (const side of ["Left", "Right"] as const) legs(P, side, -0.3 * e, 0.5 * e);
      });
      return unarmed ? c : hits(c, "weapon", strikers, [0.2, 0.75]);
    })(),
    ...(unarmed ? unarmedWeaponClips() : weaponClips()),
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
  ], HUMANOID_ATTACKS);
}

const HUMANOID_ATTACKS: AttackTable = {
  Attack_Punch: ["hand", ["RightHand", "RightLowerArm"], [0.33, 0.55]],
  Attack_Slash: ["weapon", ["RightHand"], [0.45, 0.8]],
  Attack_Kick: ["foot", ["RightFoot", "RightLowerLeg"], [0.38, 0.65]],
  Attack_Palm: ["hand", ["LeftHand", "RightHand"], [0.45, 0.8]],
  Attack_Stomp: ["foot", ["RightFoot"], [0.5, 0.7]],
  Attack_Leap: ["hand", ["LeftHand", "RightHand"], [0.8, 1.1]],
  Attack_Spin: ["hand", ["LeftHand", "RightHand"], [0.2, 0.75]],
  Attack_Sweep: ["weapon", ["RightHand"], [0.45, 0.8]],
  Attack_Thrust: ["weapon", ["RightHand"], [0.4, 0.6]],
  Attack_Hammer: ["weapon", ["LeftHand", "RightHand"], [0.64, 1.05]],
};

// ---------------------------------------------------------------- quadruped

function quadruped(k: Kit): RigClip[] {
  const { r, H, len, pitch, roll, yaw } = k;
  const has = (b: string) => r.index.has(b);
  const tails = k.bones(/^Tail\d+$/);
  /** Tail sway: the same overall swing whatever the number of links. */
  const tail = (P: Poser, ph: number, a: number) =>
    tails.forEach((b, i) => yaw(P, b, ((3 * a) / tails.length) * Math.sin(ph - (2.4 * i) / tails.length)));
  /** Bends the neck (over both links of a long one): positive lowers the head. */
  const neck = (P: Poser, a: number) => {
    if (!has("Neck2")) return pitch(P, "Neck", a);
    pitch(P, "Neck", a / 2);
    pitch(P, "Neck2", a / 2);
  };
  /** Opens the jaw (models rigged with one): 1 = wide open. */
  const jaw = (P: Poser, open: number) => pitch(P, "Jaw", 0.5 * open);
  /** Short arms of an animal on two legs, swinging opposite each other. */
  const arms = (P: Poser, a: number) => {
    pitch(P, "UpperArmL", a);
    pitch(P, "UpperArmR", -a);
  };
  /** Trunk sway (models rigged with one): a wave from the base to the tip, `curl` bends it back toward the mouth. */
  const trunk = (P: Poser, ph: number, a: number, curl = 0) =>
    ["Trunk1", "Trunk2", "Trunk3"].forEach((b, i) => {
      yaw(P, b, a * Math.sin(ph - 0.7 * i));
      pitch(P, b, curl + 0.5 * a * Math.sin(ph - 0.7 * i + 1));
    });
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
  /** Legs folded for flight: front paws under the chest, hind legs trailing. */
  const tuck = (P: Poser) => {
    for (const side of ["L", "R"]) {
      pitch(P, `FrontUpperLeg${side}`, 0.5);
      pitch(P, `FrontLowerLeg${side}`, -1.0);
      pitch(P, `RearUpperLeg${side}`, 0.8);
      pitch(P, `RearLowerLeg${side}`, 0.3);
    }
  };
  const fourLegs = has("FrontUpperLegL");
  return marked(
    k,
    [
      k.clip("04", "Idle", 3, (_t, P, ph) => {
        pitch(P, "Spine", 0.02 * Math.sin(ph));
        neck(P, 0.05 * Math.sin(2 * ph));
        yaw(P, "Head", 0.3 * Math.sin(ph));
        tail(P, 3 * ph, 0.25);
        trunk(P, ph, 0.25);
        arms(P, 0.05 * Math.sin(ph));
      }),
      k.clip("04", "Walk", 1.2, (_t, P, ph) => {
        P.move("Hips", k.up(0.01 * H * Math.cos(2 * ph)));
        roll(P, "Spine", 0.03 * Math.sin(ph));
        neck(P, 0.05 * Math.cos(2 * ph));
        legs(P, ph, [0, Math.PI, Math.PI, 0], 0.35, 0.6);
        tail(P, ph, 0.25);
        trunk(P, ph, 0.3);
        arms(P, 0.15 * Math.sin(ph));
      }),
      // Fast trot: left and right legs of each pair half a cycle apart (a gallop moves them almost together,
      // which reads as hopping on two-legged characters rigged with this template).
      k.clip("04", "Run", 0.55, (_t, P, ph) => {
        P.move("Root", k.up(0.04 * H * Math.max(0, Math.sin(2 * ph))));
        pitch(P, "Spine", 0.04 * Math.sin(2 * ph));
        roll(P, "Spine", 0.05 * Math.sin(ph));
        neck(P, 0.1 * Math.sin(2 * ph + 1));
        legs(P, ph, [0, Math.PI, Math.PI + 0.3, 0.3], 0.7, 1.2);
        pitch(P, "Tail1", -0.3);
        tail(P, ph, 0.15);
        trunk(P, 2 * ph, 0.2, -0.2);
        arms(P, 0.25 * Math.sin(ph));
      }),
      // Gallop (phi nước đại): the front legs land together, then the hind legs, the back flexing between them.
      ...(fourLegs
        ? [
            k.clip("04", "Gallop", 0.5, (_t, P, ph) => {
              P.move("Root", k.up(0.05 * H * Math.max(0, Math.sin(ph))));
              pitch(P, "Spine", 0.08 * Math.sin(ph));
              neck(P, 0.12 * Math.sin(ph + 1));
              legs(P, ph, [0, 0.3, Math.PI, Math.PI + 0.3], 0.8, 1.3);
              pitch(P, "Tail1", -0.4);
              tail(P, ph, 0.1);
              trunk(P, 2 * ph, 0.2, -0.2);
            }),
            // Stand up on the hind legs (a bear), sway there, come back down.
            k.clip("04", "Stand", 3, (t, P, ph) => {
              const e = keys(t, [[0, 0], [0.6, 1], [2.4, 1], [3, 0]]);
              pitch(P, "Hips", -0.9 * e);
              for (const side of ["L", "R"]) {
                pitch(P, `RearUpperLeg${side}`, 0.9 * e);
                pitch(P, `FrontUpperLeg${side}`, 0.7 * e);
                pitch(P, `FrontLowerLeg${side}`, 0.5 * e);
              }
              neck(P, 0.5 * e);
              pitch(P, "Head", 0.3 * e);
              roll(P, "Spine", 0.05 * e * Math.sin(2 * ph));
              pitch(P, "Tail1", 0.3 * e);
              trunk(P, ph, 0.2 * e, -0.3 * e);
            }),
          ]
        : []),
      // Swim: legs paddling slowly, the tail sculling side to side.
      k.clip("08", "Swim", 1.6, (_t, P, ph) => {
        yaw(P, "Spine", 0.05 * Math.sin(ph));
        neck(P, -0.1);
        legs(P, ph, [0, Math.PI, Math.PI, 0], 0.4, 0.7);
        tail(P, ph, 0.5);
        trunk(P, ph, 0.1, -0.4);
      }),
      k.clip("06", "Jump", 1.4, (t, P) => {
        const crouch = keys(t, [[0, 0], [0.3, 1], [0.4, 0], [0.9, 0], [1.05, 0.7], [1.35, 0]]);
        const air = t > 0.38 && t < 1.0 ? Math.sin((Math.PI * (t - 0.38)) / 0.62) : 0;
        P.move("Root", k.up(0.3 * H * air));
        P.move("Hips", k.up(-0.08 * H * crouch));
        pitch(P, "Hips", -0.2 * air);
        crouchLegs(P, crouch + 0.6 * air);
        pitch(P, "Tail1", -0.3 * air);
        trunk(P, 0, 0, 0.2 * crouch - 0.3 * air);
      }),
      k.clip("06", "Fall", 2, (t, P) => {
        const e = keys(t, [[0, 0], [0.25, 0.05], [0.9, 1], [1.0, 0.94], [1.12, 1]]);
        P.move("Root", k.up(0.18 * H * e));
        roll(P, "Root", (Math.PI / 2) * e);
        crouchLegs(P, 0.4 * e);
      }),
      // Wings (dragons): flight, and the fold / spread poses. Flying spreads them first, whatever their rest pose.
      ...(has("WingUpperL")
        ? [
            k.clip("07", "Fly", 1, (_t, P, ph) => {
              P.move("Root", k.up(0.3 * H + 0.04 * H * Math.cos(ph)));
              neck(P, -0.1);
              tuck(P);
              aimWings(k, P, spreadPose(k), 1);
              flap(k, P, ph, 0.7);
              tail(P, ph, 0.15);
            }),
            k.clip("07", "Glide", 3, (_t, P, ph) => {
              P.move("Root", k.up(0.3 * H));
              neck(P, -0.1);
              tuck(P);
              aimWings(k, P, spreadPose(k), 1);
              flap(k, P, 2 * ph, 0.06);
              tail(P, ph, 0.1);
              roll(P, "Root", 0.15 * Math.sin(ph));
            }),
            k.clip("07", "Wings_Fold", 1, (t, P) => aimWings(k, P, foldPose(k), keys(t, [[0, 0], [0.5, 1]]))),
            k.clip("07", "Wings_Spread", 1, (t, P) => aimWings(k, P, spreadPose(k), keys(t, [[0, 0], [0.5, 1]]))),
          ]
        : []),
      k.clip("11", "Interact_Eat", 2.4, (t, P) => {
        const e = keys(t, [[0, 0], [0.6, 1], [1.8, 1], [2.4, 0]]);
        pitch(P, "Spine", 0.05 * e);
        neck(P, 0.9 * e);
        pitch(P, "Head", (0.4 + 0.08 * Math.sin(TAU * 3 * t)) * e);
        jaw(P, 0.3 * e * Math.max(0, Math.sin(TAU * 3 * t)));
        tail(P, TAU * t, 0.2);
        trunk(P, TAU * 3 * t, 0.05 * e, 0.3 * e);
      }),
      // Bite: open wide while winding up, lunge, snap the jaw shut (twice).
      k.clip("13", "Attack_Bite", 1, (t, P) => {
        const load = keys(t, [[0, 0], [0.3, 1], [0.4, 0]]);
        const lunge = keys(t, [[0.3, 0], [0.42, 1], [0.6, 1], [0.95, 0]]);
        const snap = keys(t, [[0.38, 0], [0.45, 1], [0.52, 0.2], [0.58, 1], [0.8, 0]]);
        P.move("Root", k.fwd(len * (0.1 * lunge - 0.04 * load)));
        P.move("Hips", k.up(-0.04 * H * load));
        pitch(P, "Spine", 0.06 * lunge);
        neck(P, -0.35 * load + 0.25 * lunge);
        pitch(P, "Head", -0.2 * load + 0.35 * snap);
        jaw(P, keys(t, [[0, 0], [0.3, 1], [0.44, 0], [0.51, 0.6], [0.58, 0]]));
        crouchLegs(P, 0.5 * load);
        pitch(P, "Tail1", -0.4 * (load + lunge));
        trunk(P, 0, 0, 0.25 * load - 0.35 * lunge);
      }),
      // Bite and shake (ngoạm, giằng): lunge, clamp the jaw, shake the head side to side, let go.
      ...(has("Jaw")
        ? [
            k.clip("13", "Attack_BiteShake", 1.6, (t, P) => {
              const lunge = keys(t, [[0, 0], [0.3, 1], [1.2, 1], [1.55, 0]]);
              const shake = t > 0.35 && t < 1.2 ? Math.sin(TAU * 4 * (t - 0.35)) * Math.sin((Math.PI * (t - 0.35)) / 0.85) : 0;
              P.move("Root", k.fwd(0.08 * len * lunge));
              P.move("Hips", k.up(-0.03 * H * lunge));
              yaw(P, "Spine", -0.1 * shake);
              neck(P, 0.2 * lunge);
              yaw(P, "Neck", 0.35 * shake);
              yaw(P, "Head", 0.25 * shake);
              roll(P, "Head", 0.2 * shake);
              jaw(P, keys(t, [[0, 0], [0.2, 1], [0.32, 0], [1.3, 0], [1.4, 0.6], [1.55, 0]]));
              crouchLegs(P, 0.3 * lunge);
              tail(P, TAU * 2 * t, 0.2 * lunge);
            }),
          ]
        : []),
      k.clip("13", "Attack_Swipe", 1.3, (t, P) => {
        const rear = keys(t, [[0, 0], [0.4, 1], [0.8, 1], [1.25, 0]]);
        const raise = keys(t, [[0.1, 0], [0.4, 1], [0.55, 0], [1.25, 0]]);
        const swipe = keys(t, [[0.4, 0], [0.55, 1], [0.8, 1], [1.25, 0]]);
        // Rear up on the hind legs, then strike down with the left front paw (or the left hand, on two legs).
        pitch(P, "Hips", -0.35 * rear);
        pitch(P, "RearUpperLegL", 0.35 * rear);
        pitch(P, "RearUpperLegR", 0.35 * rear);
        neck(P, 0.2 * rear);
        pitch(P, "FrontUpperLegL", -1.3 * raise - 0.2 * swipe);
        pitch(P, "FrontLowerLegL", 0.9 * raise);
        pitch(P, "FrontUpperLegR", -0.3 * rear);
        pitch(P, "FrontLowerLegR", 0.6 * rear);
        pitch(P, "UpperArmL", -1.2 * raise - 0.2 * swipe);
        pitch(P, "LowerArmL", 0.6 * raise);
        pitch(P, "Tail1", -0.3 * rear);
        trunk(P, 0, 0, -0.4 * rear + 0.2 * swipe);
      }),
      // Pounce (nhảy tới): crouch, leap forward with the front paws reaching out, land, walk back to the spot.
      k.clip("13", "Attack_Pounce", 1.5, (t, P) => {
        const crouch = keys(t, [[0, 0], [0.3, 1], [0.4, 0], [0.85, 0], [0.95, 0.7], [1.45, 0]]);
        const air = t > 0.38 && t < 0.9 ? Math.sin((Math.PI * (t - 0.38)) / 0.52) : 0;
        const ahead = keys(t, [[0.35, 0], [0.9, 1], [1.1, 1], [1.45, 0]]);
        P.move("Root", k.up(0.25 * H * air).add(k.fwd(0.35 * len * ahead)));
        P.move("Hips", k.up(-0.08 * H * crouch));
        pitch(P, "Hips", -0.25 * air);
        crouchLegs(P, crouch);
        for (const side of ["L", "R"]) {
          pitch(P, `FrontUpperLeg${side}`, -0.9 * air);
          pitch(P, `RearUpperLeg${side}`, 0.6 * air);
        }
        neck(P, 0.2 * air);
        jaw(P, air);
        pitch(P, "Tail1", -0.4 * air);
        trunk(P, 0, 0, 0.2 * crouch - 0.35 * air);
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
        neck(P, 0.25 * impact);
        pitch(P, "Tail1", -0.3 * (rear + impact));
        trunk(P, 0, 0, -0.45 * rear + 0.25 * impact);
      }),
      k.clip("13", "Attack_Headbutt", 1.2, (t, P) => {
        const lower = keys(t, [[0, 0], [0.35, 1], [0.8, 1], [1.15, 0]]);
        const charge = keys(t, [[0.3, -0.3], [0.45, 1], [0.65, 1], [1.15, 0]]);
        P.move("Root", k.fwd(0.18 * len * charge * lower));
        neck(P, 0.5 * lower);
        pitch(P, "Head", 0.35 * lower);
        crouchLegs(P, 0.4 * lower * Math.max(0, -charge / 0.3));
        pitch(P, "Tail1", -0.3 * lower);
        trunk(P, 0, 0, 0.2 * lower);
      }),
      // Horn charge (húc): lower the head, run at the target, hit it with the horns (or tusks) and toss them up.
      ...(k.bones(/^Horn/).length
        ? [
            k.clip("13", "Attack_Charge", 1.8, (t, P) => {
              const lower = keys(t, [[0, 0], [0.4, 1], [1.2, 1], [1.75, 0]]);
              const dash = keys(t, [[0.4, 0], [1.0, 1], [1.3, 1], [1.75, 0]]);
              const run = keys(t, [[0.4, 0], [0.5, 1], [0.9, 1], [1.0, 0]]);
              const impact = keys(t, [[0.95, 0], [1.0, 1], [1.2, 0]]);
              P.move("Root", k.fwd(0.5 * len * dash - 0.05 * len * impact));
              P.move("Hips", k.up(-0.03 * H * lower));
              neck(P, 0.45 * lower);
              pitch(P, "Head", 0.3 * lower - 0.6 * impact);
              legs(P, (TAU * t) / 0.3, [0, 0.3, Math.PI, Math.PI + 0.3], 0.6 * run, 1.0 * run);
              crouchLegs(P, 0.25 * lower * (1 - run));
              pitch(P, "Tail1", -0.3 * lower);
              trunk(P, 0, 0, -0.3 * lower);
            }),
          ]
        : []),
      // Tail swipe (quật đuôi): wind up to one side, then turn the body and whip the tail across.
      k.clip("13", "Attack_TailSwipe", 1.4, (t, P) => {
        const turn = keys(t, [[0, 0], [0.4, -0.5], [0.7, 1], [0.95, 1], [1.35, 0]]);
        tails.forEach((b, i) =>
          yaw(P, b, (-1.2 / tails.length) * keys(t - 0.04 * i, [[0, 0], [0.4, -0.5], [0.72, 1.2], [0.95, 1], [1.35, 0]])),
        );
        yaw(P, "Neck", 0.3 * turn);
        crouchLegs(P, 0.3 * Math.abs(turn));
        // The Root last, so the parts above are posed in the body's own axes.
        yaw(P, "Root", -0.6 * turn);
      }),
      // Buck (đá hậu): weight onto the front legs, head down, both hind legs kick out backwards.
      ...(fourLegs
        ? [
            k.clip("13", "Attack_Buck", 1.2, (t, P) => {
              const load = keys(t, [[0, 0], [0.35, 1], [0.45, 0]]);
              const kick = keys(t, [[0.38, 0], [0.5, 1], [0.7, 1], [1.1, 0]]);
              P.move("Hips", k.up(-0.03 * H * load));
              pitch(P, "Hips", 0.15 * kick);
              neck(P, 0.3 * (load + kick));
              for (const side of ["L", "R"]) {
                pitch(P, `RearUpperLeg${side}`, -0.3 * load + 1.1 * kick);
                pitch(P, `RearLowerLeg${side}`, 0.7 * load - 0.3 * kick);
                pitch(P, `FrontUpperLeg${side}`, -0.15 * kick);
              }
              pitch(P, "Tail1", -0.4 * kick);
            }),
          ]
        : []),
      // Breath (phun lửa, dragons): rear the head back to draw breath, then thrust it forward jaw wide open, sweeping.
      ...(has("Jaw") && has("WingUpperL")
        ? [
            k.clip("13", "Attack_Breath", 2.4, (t, P) => {
              const inhale = keys(t, [[0, 0], [0.6, 1], [0.75, 0]]);
              const blast = keys(t, [[0.65, 0], [0.8, 1], [1.8, 1], [2.3, 0]]);
              pitch(P, "Spine", -0.05 * inhale);
              neck(P, -0.5 * inhale + 0.2 * blast);
              yaw(P, "Neck", 0.3 * blast * Math.sin(Math.PI * (t - 0.8)));
              pitch(P, "Head", -0.3 * inhale + 0.1 * blast);
              jaw(P, 0.3 * inhale + 1.2 * blast);
              aimWings(k, P, spreadPose(k), 0.4 * (inhale + blast));
              crouchLegs(P, 0.2 * blast);
              pitch(P, "Tail1", -0.3 * blast);
            }),
          ]
        : []),
      // Trunk attacks, only for animals rigged with a trunk (elephants).
      ...(has("Trunk1")
        ? [
            // Sweep (quét vòi): swing the trunk out to the right, then whip it across to the left and back.
            k.clip("13", "Attack_TrunkSweep", 1.5, (t, P) => {
              const side = keys(t, [[0, 0], [0.4, -1], [0.62, 1.2], [0.8, 1], [1.45, 0]]);
              const reach = keys(t, [[0, 0], [0.4, 1], [0.8, 1], [1.45, 0]]);
              yaw(P, "Spine", 0.05 * side);
              yaw(P, "Neck", 0.15 * side);
              yaw(P, "Head", 0.15 * side);
              neck(P, 0.15 * reach);
              ["Trunk1", "Trunk2", "Trunk3"].forEach((b, i) => {
                yaw(P, b, (0.35 + 0.1 * i) * side);
                pitch(P, b, -0.2 * reach);
              });
              pitch(P, "Tail1", -0.2 * reach);
            }),
            // Toss (hất vòi): lower the head and curl the trunk under, then fling it up and forward with the head.
            k.clip("13", "Attack_TrunkToss", 1.3, (t, P) => {
              const load = keys(t, [[0, 0], [0.4, 1], [0.5, 0]]);
              const toss = keys(t, [[0.4, 0], [0.55, 1], [0.8, 1], [1.25, 0]]);
              P.move("Hips", k.up(-0.03 * H * load));
              neck(P, 0.35 * load - 0.3 * toss);
              pitch(P, "Head", 0.15 * load - 0.2 * toss);
              ["Trunk1", "Trunk2", "Trunk3"].forEach((b, i) => pitch(P, b, (0.35 + 0.1 * i) * load - (0.5 + 0.15 * i) * toss));
              crouchLegs(P, 0.3 * load);
              pitch(P, "FrontUpperLegL", -0.25 * toss);
              pitch(P, "FrontUpperLegR", -0.25 * toss);
              pitch(P, "Tail1", -0.3 * toss);
            }),
          ]
        : []),
      spinAttack(k, (P, e) => {
        crouchLegs(P, 0.3 * e);
        pitch(P, "Tail1", -0.3 * e);
        tail(P, Math.PI / 2, 0.5 * e);
      }),
      k.clip("14", "Hit", 0.7, (t, P) => {
        const e = keys(t, [[0, 0], [0.08, 1], [0.25, 0.8], [0.7, 0]]);
        P.move("Root", k.fwd(-0.05 * len * e));
        P.move("Hips", k.up(-0.04 * H * e));
        pitch(P, "Spine", -0.08 * e);
        neck(P, -0.35 * e);
        pitch(P, "Head", -0.2 * e);
        jaw(P, 0.4 * e);
        crouchLegs(P, 0.3 * e);
        pitch(P, "Tail1", 0.4 * e);
        trunk(P, 0, 0, 0.3 * e);
      }),
      // Death: sag, legs give way, roll onto the side; ends lying there.
      k.clip("14", "Death", 2.2, (t, P) => {
        const sag = keys(t, [[0, 0], [0.5, 1]]);
        const e = keys(t, [[0.4, 0], [1.2, 1], [1.3, 0.95], [1.42, 1]]);
        P.move("Hips", k.up(-0.08 * H * sag * (1 - e)));
        crouchLegs(P, 0.6 * sag * (1 - e) + 0.3 * e);
        neck(P, 0.5 * sag - 0.3 * e);
        pitch(P, "Head", 0.2 * sag);
        jaw(P, 0.3 * e);
        pitch(P, "Tail1", 0.3 * sag);
        trunk(P, 0, 0, 0.3 * sag - 0.2 * e);
        P.move("Root", k.up(0.18 * H * e));
        roll(P, "Root", (Math.PI / 2) * e);
      }),
      ...common(k),
    ],
    QUADRUPED_ATTACKS,
  );
}

const QUADRUPED_ATTACKS: AttackTable = {
  Attack_Bite: ["jaw", ["Jaw", "Head"], [0.4, 0.6]],
  Attack_BiteShake: ["jaw", ["Jaw", "Head"], [0.3, 1.2]],
  Attack_Swipe: ["claw", ["FrontFootL", "FrontLowerLegL", "HandL", "LowerArmL"], [0.48, 0.8]],
  Attack_Pounce: ["claw", ["FrontFootL", "FrontFootR", "HandL", "HandR"], [0.55, 0.95]],
  Attack_Stomp: ["foot", ["FrontFootL", "FrontFootR"], [0.48, 0.75]],
  Attack_Headbutt: ["head", ["Head", "Horn", "HornL", "HornR"], [0.42, 0.65]],
  Attack_Charge: ["horn", ["Horn", "HornL", "HornR", "Head"], [0.95, 1.2]],
  Attack_TailSwipe: ["tail", ["Tail2", "Tail3", "Tail4", "Tail5"], [0.55, 0.95]],
  Attack_Buck: ["hoof", ["RearFootL", "RearFootR", "RearLowerLegL", "RearLowerLegR"], [0.45, 0.7]],
  Attack_Breath: ["breath", ["Jaw", "Head"], [0.8, 1.8]],
  Attack_TrunkSweep: ["trunk", ["Trunk1", "Trunk2", "Trunk3"], [0.45, 0.8]],
  Attack_TrunkToss: ["trunk", ["Trunk2", "Trunk3"], [0.45, 0.8]],
  Attack_Spin: ["tail", ["Tail2", "Tail3", "Tail4", "Tail5"], [0.2, 0.75]],
};

// ---------------------------------------------------------------- bird

function bird(k: Kit): RigClip[] {
  const { H, pitch, roll, yaw } = k;
  const wings = (P: Poser, ph: number, amp: number) => flap(k, P, ph, amp);
  /** Flight spreads the wings first, whatever their rest pose (folded on a perched bird). */
  const spread = (P: Poser, amount = 1) => aimWings(k, P, spreadPose(k), amount);
  // Body tilt (tail -> head above the horizontal): a bird modeled upright (flying at the camera) has its wings facing
  // forward, and flapping them about the body axis would slice them edgewise. Flight levels the body first (nose a
  // little up), which turns the wings face down.
  const bone = (n: string) => k.r.plan.bones.find((b) => b.name === n);
  const [neck, tail] = [bone("Neck"), bone("Tail")];
  const axis = neck && tail ? neck.tail.clone().sub(tail.tail) : k.F.clone();
  const level = Math.max(0, Math.atan2(axis.dot(k.U), axis.dot(k.F)) - 0.2);
  const tuckLegs = (P: Poser) => ["LegL", "LegR"].forEach((b) => pitch(P, b, Math.max(0, 0.9 - level)));
  return marked(k, [
    k.clip("07", "Fly", 0.6, (_t, P, ph) => {
      P.move("Root", k.up(0.15 * H + 0.03 * H * Math.sin(ph)));
      pitch(P, "Hips", level);
      spread(P);
      wings(P, ph, 0.9);
      pitch(P, "Tail", -0.1 * Math.sin(ph));
      tuckLegs(P);
    }),
    k.clip("07", "Glide", 3, (_t, P, ph) => {
      P.move("Root", k.up(0.15 * H));
      pitch(P, "Hips", level);
      spread(P);
      wings(P, 2 * ph, 0.08);
      tuckLegs(P);
      roll(P, "Root", 0.2 * Math.sin(ph));
    }),
    k.clip("07", "Wings_Fold", 1, (t, P) => aimWings(k, P, foldPose(k), keys(t, [[0, 0], [0.5, 1]]))),
    k.clip("07", "Wings_Spread", 1, (t, P) => spread(P, keys(t, [[0, 0], [0.5, 1]]))),
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
    // Dive (lao xuống): from the air, wings half folded, nose down; pull up at the bottom and strike feet first.
    k.clip("13", "Attack_Dive", 1.4, (t, P) => {
      const height = keys(t, [[0, 1], [0.62, 0], [0.9, 0], [1.4, 1]]);
      const ahead = keys(t, [[0, 0], [0.62, 1], [0.9, 1], [1.4, 0]]);
      const dive = keys(t, [[0, 0], [0.2, 1], [0.5, 1], [0.62, 0]]);
      const strike = keys(t, [[0.5, 0], [0.62, 1], [0.85, 1], [1.2, 0]]);
      P.move("Root", k.up(0.5 * H * height).add(k.fwd(0.4 * k.len * ahead)));
      pitch(P, "Hips", 0.5 * dive - 0.4 * strike);
      aimWings(k, P, foldPose(k), 0.6 * dive);
      spread(P, strike);
      wings(P, (TAU * t) / 0.3, 0.5 * strike);
      ["LegL", "LegR"].forEach((b) => pitch(P, b, 0.9 * dive - 0.9 * strike));
      pitch(P, "Tail", 0.3 * strike);
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
  ], BIRD_ATTACKS);
}

const BIRD_ATTACKS: AttackTable = {
  Attack_Peck: ["beak", ["Head"], [0.4, 0.6]],
  Attack_Pounce: ["talon", ["FootL", "FootR"], [0.5, 0.85]],
  Attack_Dive: ["talon", ["FootL", "FootR"], [0.6, 0.85]],
  Attack_Spin: ["wing", ["WingHandL", "WingHandR"], [0.2, 0.75]],
};

// ---------------------------------------------------------------- fish

function fish(k: Kit): RigClip[] {
  const { r, H, pitch, roll, yaw } = k;
  const has = (b: string) => r.index.has(b);
  const style = r.plan.swim ?? "fish";
  const ray = style === "ray";
  const amps = [0.04, 0.06, 0.08, 0.11, 0.14, 0.18];
  /** Tail beat: side to side (fish), up and down (whales, dolphins, and a ray's trailing tail). */
  const beat = style === "fish" ? yaw : pitch;
  const wave = (P: Poser, ph: number, scale: number, turn: typeof yaw = beat) =>
    amps.forEach((a, i) => turn(P, `Spine${i + 1}`, scale * a * Math.sin(ph - 0.9 * i)));
  /**
   * Fin beat about the body axis, up when `sin(ph)` > 0: each joint lags the one before it and twists a little, so on
   * a ray the wave runs out to the tip and back along the fin.
   */
  const fins = (P: Poser, ph: number, amp: number) =>
    FIN.forEach((b, i) => {
      const a = [1, 0.8, 0.7][i] * amp * Math.sin(ph - 0.7 * i);
      roll(P, `${b}L`, a);
      roll(P, `${b}R`, -a);
      pitch(P, `${b}L`, 0.25 * amp * Math.cos(ph - 0.7 * i) * (i ? 1 : 0));
      pitch(P, `${b}R`, 0.25 * amp * Math.cos(ph - 0.7 * i) * (i ? 1 : 0));
    });
  /** Opens the jaw (rigs with one): 1 = wide open. */
  const jaw = (P: Poser, open: number) => pitch(P, "Jaw", 0.5 * open);
  /** Swimming: a ray beats its fins (the body rises on the downstroke), the others their tail. */
  const swim = (P: Poser, ph: number, scale: number) => {
    if (ray) {
      fins(P, ph, 0.7 * scale);
      wave(P, ph, 0.4 * scale);
      P.move("Root", k.up(-0.04 * H * scale * Math.sin(ph)));
      return;
    }
    wave(P, ph, scale);
    fins(P, 2 * ph, 0.12 * scale);
    if (style === "whale") P.move("Root", k.up(0.04 * H * Math.sin(ph)));
  };
  const clips = [
    k.clip("08", "Swim", ray ? 2 : 1.2, (_t, P, ph) => swim(P, ph, 1)),
    k.clip("08", "Swim_Fast", ray ? 1.2 : 0.6, (_t, P, ph) => swim(P, ph, 1.4)),
    ...(style === "fish"
      ? [
          // Whales and dolphins beat their tail up and down.
          k.clip("08", "Swim_Dolphin", 1.4, (_t, P, ph) => {
            P.move("Root", k.up(0.04 * H * Math.sin(ph)));
            wave(P, ph, 1, pitch);
          }),
        ]
      : []),
    k.clip("08", "Swim_Idle", 3, (_t, P, ph) => {
      P.move("Root", k.up(0.03 * H * Math.sin(ph)));
      wave(P, ph, 0.4);
      fins(P, ph, ray ? 0.15 : 0.08);
    }),
    // Glide (lướt): fins held out and a little up, rippling at the tips, banking gently.
    ...(ray
      ? [
          k.clip("08", "Glide", 4, (_t, P, ph) => {
            fins(P, Math.PI / 2, 0.15);
            fins(P, 3 * ph, 0.05);
            wave(P, ph, 0.2);
            roll(P, "Root", 0.12 * Math.sin(ph));
          }),
        ]
      : []),
    k.clip("13", "Attack_Bite", 1, (t, P) => {
      // Curl back, then a tail beat drives a lunge forward, jaw open until it snaps shut.
      const load = keys(t, [[0, 0], [0.3, 1], [0.4, 0]]);
      const lunge = keys(t, [[0.3, 0], [0.45, 1], [0.6, 1], [0.95, 0]]);
      P.move("Root", k.fwd(k.len * (0.25 * lunge - 0.05 * load)));
      amps.forEach((a, i) => beat(P, `Spine${i + 1}`, 2.5 * a * (load - lunge * Math.sin(TAU * 2 * t - 0.9 * i))));
      pitch(P, "Spine1", -0.15 * lunge);
      jaw(P, keys(t, [[0, 0], [0.3, 1], [0.46, 0], [0.9, 0]]));
      fins(P, Math.PI / 2, -0.3 * lunge);
    }),
    // Ram (húc): body straight and fins tucked, a burst of tail beats, head first into the target.
    k.clip("13", "Attack_Ram", 1, (t, P) => {
      const load = keys(t, [[0, 0], [0.3, 1], [0.4, 0]]);
      const burst = keys(t, [[0.25, 0], [0.45, 1], [0.6, 1], [0.95, 0]]);
      P.move("Root", k.fwd(k.len * (0.35 * burst - 0.08 * load)));
      wave(P, (TAU * t) / 0.2, 1.2 * burst);
      pitch(P, "Head", -0.15 * burst);
      fins(P, -Math.PI / 2, 0.4 * burst);
    }),
    // Tail slap (quật đuôi): a whale lifts its flukes and slams them down, a fish sweeps its tail, a ray whips its
    // tail up and over (a stingray's sting).
    k.clip("13", "Attack_TailSlap", 1.2, (t, P) => {
      const lift = keys(t, [[0, 0], [0.4, 1], [0.5, 0]]);
      const slam = keys(t, [[0.4, 0], [0.55, 1], [0.75, 1], [1.15, 0]]);
      // Positive pitch raises a tail: a ray's keeps rising (up and over), a whale's comes back down past rest.
      amps.forEach((a, i) => beat(P, `Spine${i + 1}`, (i < 2 ? 0.3 : 3) * a * (lift - (ray ? -1.5 : 1.2) * slam)));
      if (style === "whale") pitch(P, "Root", 0.25 * lift - 0.35 * slam);
    }),
    ...(has("Fin1L")
      ? [
          // Fin slap: both fins raised high, then beaten down hard (a humpback's slap, a ray's wing strike).
          k.clip("13", "Attack_FinSlap", 1, (t, P) => {
            const e = keys(t, [[0, 0], [0.35, 1], [0.45, -1], [0.65, -1], [1, 0]]);
            fins(P, Math.PI / 2, (ray ? 0.9 : 1.2) * e);
            P.move("Root", k.up(0.05 * H * Math.max(0, -e)));
          }),
        ]
      : []),
    spinAttack(k, (P, e) => {
      amps.forEach((a, i) => beat(P, `Spine${i + 1}`, 2 * a * e));
      fins(P, Math.PI / 2, 0.4 * e);
    }),
    k.clip("14", "Hit", 0.8, (t, P) => {
      const e = keys(t, [[0, 0], [0.08, 1], [0.3, 0.6], [0.8, 0]]);
      P.move("Root", k.fwd(-0.1 * k.len * e));
      amps.forEach((a, i) => beat(P, `Spine${i + 1}`, 3 * a * e * Math.sin(TAU * 3 * t - 0.9 * i)));
      fins(P, Math.PI / 2, 0.3 * e);
    }),
    // Death: go limp and roll belly-up, drifting up a little; ends floating there.
    k.clip("14", "Death", 2.4, (t, P) => {
      const e = keys(t, [[0, 0], [1.4, 1]]);
      const twitch = Math.exp(-3 * t) * Math.sin(TAU * 4 * t);
      amps.forEach((a, i) => beat(P, `Spine${i + 1}`, 2 * a * twitch + 0.5 * a * e));
      fins(P, -Math.PI / 2, 0.25 * e);
      // Flipping about the Root (on the ground) puts the body below it: lift by the body height, plus the drift.
      P.move("Root", k.up(1.15 * H * e));
      k.roll(P, "Root", Math.PI * e);
    }),
    tap(k),
    ...common(k),
  ];
  return marked(k, clips, {
    Attack_Bite: ["jaw", has("Jaw") ? ["Jaw", "Head"] : ["Spine1"], [0.4, 0.6]],
    Attack_Ram: ["head", has("Head") ? ["Head"] : ["Spine1"], [0.4, 0.65]],
    Attack_TailSlap: ["tail", ["Spine5", "Spine6"], [0.45, 0.75]],
    Attack_FinSlap: ["wing", ["Fin2L", "Fin3L", "Fin2R", "Fin3R"], [0.35, 0.6]],
    Attack_Spin: ["tail", ["Spine5", "Spine6"], [0.2, 0.75]],
  });
}

const FIN = ["Fin1", "Fin2", "Fin3"];

// ---------------------------------------------------------------- serpents: snakes, Asian dragons

function serpent(k: Kit): RigClip[] {
  const { r, H, len, U, pitch } = k;
  // Rooted mid-body: `front` runs from the middle toward the head, `back` toward the tail tip.
  const front = ["Hips", ...k.bones(/^Spine\d+$/)];
  const back = k.bones(/^Tail\d+$/);
  const n = front.length + back.length;
  /** Raises the part of the body beyond a bone's joint (about the bone's current side axis). */
  const lift = (P: Poser, b: string, a: number) => {
    if (!P.has(b) || a === 0) return;
    const side = P.dir(b).cross(U);
    P.rot(b, side.lengthSq() > 1e-6 ? side.normalize() : k.L.clone().negate(), a);
  };
  const turn = (P: Poser, b: string, a: number) => k.yaw(P, b, a);
  /**
   * Bends the whole body to the curvature `curve(s)` (radians per link at `s`, 0 = head, 1 = tail tip; positive turns
   * left going toward the tail, or up when `vertical`).
   */
  const bend = (P: Poser, curve: (s: number) => number, vertical = false) => {
    const rot = vertical ? lift : turn;
    front.forEach((b, i) => rot(P, b, -curve((front.length - i) / n)));
    back.forEach((b, i) => rot(P, b, curve((front.length + i) / n)));
  };
  /** A wave travelling from the head to the tail: `waves` crests along the body. */
  const wave = (s: number, ph: number, a: number, waves = 1.5) => a * Math.sin(TAU * waves * s - ph);
  // The head keeps looking where it was while the body swings behind it.
  const restHead = r.restDir[r.index.get("Head")!].clone();
  const steady = (P: Poser, amount = 0.7) => aim(P, "Head", restHead, amount);
  /** Opens the jaw (models rigged with one): 1 = wide open. */
  const jaw = (P: Poser, open: number) => lift(P, "Jaw", -0.6 * open);
  /** Short legs (Asian dragons) paddling, diagonal pairs together. */
  const legs = (P: Poser, ph: number, a: number) =>
    (["FrontL", "FrontR", "RearL", "RearR"] as const).forEach((leg, i) =>
      pitch(P, `${leg.slice(0, -1)}UpperLeg${leg.slice(-1)}`, a * Math.sin(ph + [0, Math.PI, Math.PI, 0][i])),
    );
  /** Legs folded back along the body in flight. */
  const tuck = (P: Poser) =>
    (["FrontL", "FrontR", "RearL", "RearR"] as const).forEach((leg) => {
      pitch(P, `${leg.slice(0, -1)}UpperLeg${leg.slice(-1)}`, 0.8);
      pitch(P, `${leg.slice(0, -1)}LowerLeg${leg.slice(-1)}`, 0.3);
    });
  /** Tilts a bone to `angle` above the horizontal, keeping its heading, `amount` of the way. */
  const tilt = (P: Poser, b: string, angle: number, amount: number) => {
    if (!P.has(b) || amount === 0) return;
    const d = P.dir(b);
    const heading = d.addScaledVector(U, -d.dot(U));
    if (heading.lengthSq() < 1e-8) return;
    aim(P, b, heading.normalize().multiplyScalar(Math.cos(angle)).addScaledVector(U, Math.sin(angle)), amount);
  };
  // Rearing up (like a cobra) stands the stretch a tenth to a third of the way from the head up at `rise`, the neck
  // beyond it at `level`: absolute angles, so it works however the body lies coiled.
  const sOf = (i: number) => (front.length - i) / n;
  const riser = front.filter((_, i) => sOf(i) > 0.1 && sOf(i) <= 0.3);
  const neck = front.filter((_, i) => sOf(i) <= 0.1);
  const rearUp = (P: Poser, amount: number, rise = 0.7, level = 0) => {
    riser.forEach((b) => tilt(P, b, rise, amount));
    neck.forEach((b) => tilt(P, b, level, amount));
  };
  return marked(
    k,
    [
      k.clip("04", "Idle", 3, (_t, P, ph) => {
        bend(P, (s) => wave(s, ph, 0.04, 1));
        lift(P, "Head", 0.08 * Math.sin(ph));
        legs(P, ph, 0.05);
      }),
      // Slither (trườn): waves run from the head down the body; the head holds its course.
      k.clip("04", "Slither", 1.4, (_t, P, ph) => {
        bend(P, (s) => wave(s, ph, 0.22));
        steady(P);
        legs(P, ph, 0.4);
      }),
      k.clip("04", "Slither_Fast", 0.8, (_t, P, ph) => {
        bend(P, (s) => wave(s, ph, 0.3, 1.2));
        steady(P);
        legs(P, ph, 0.6);
      }),
      // Flight (Asian dragons): swimming through the air, the body waving sideways and up and down.
      ...(r.index.has("FrontUpperLegL")
        ? [
            k.clip("07", "Fly", 2, (_t, P, ph) => {
              P.move("Root", k.up(0.35 * H + 0.05 * H * Math.sin(ph)));
              bend(P, (s) => wave(s, ph, 0.12, 1));
              bend(P, (s) => wave(s, ph + 1, 0.1, 1), true);
              steady(P, 0.5);
              tuck(P);
            }),
            // Claw (cào): rear the front up and rake with the left front leg.
            k.clip("13", "Attack_Claw", 1.2, (t, P) => {
              const rear = keys(t, [[0, 0], [0.35, 1], [0.85, 1], [1.15, 0]]);
              const raise = keys(t, [[0.05, 0], [0.4, 1], [0.55, 0]]);
              const rake = keys(t, [[0.4, 0], [0.55, 1], [0.8, 1], [1.15, 0]]);
              rearUp(P, rear, 0.5);
              pitch(P, "FrontUpperLegL", -1.2 * raise - 0.3 * rake);
              pitch(P, "FrontLowerLegL", 0.6 * raise);
              pitch(P, "FrontUpperLegR", -0.4 * rear);
              jaw(P, 0.4 * rear);
            }),
          ]
        : []),
      // Strike (lao cắn): coil the front into an S and rear up, then lunge, jaw open, and snap it shut.
      k.clip("13", "Attack_Strike", 1.2, (t, P) => {
        const rear = keys(t, [[0, 0], [0.35, 1], [0.9, 1], [1.15, 0]]);
        const coil = keys(t, [[0, 0], [0.4, 1], [0.52, 0]]);
        const lunge = keys(t, [[0.42, 0], [0.55, 1], [0.7, 1], [1.1, 0]]);
        P.move("Root", k.fwd(len * (0.25 * lunge - 0.05 * coil)));
        bend(P, (s) => (s < 0.5 ? 0.35 * coil * Math.sin(TAU * 2 * s) : 0));
        rearUp(P, rear, 0.7 - 0.4 * lunge, -0.3 * lunge);
        steady(P, 0.5);
        jaw(P, keys(t, [[0, 0], [0.4, 1], [0.58, 1], [0.62, 0]]));
      }),
      // Constrict (quấn siết): curl the whole body into a coil, squeeze in pulses, let go.
      k.clip("13", "Attack_Constrict", 3, (t, P) => {
        const curl = keys(t, [[0, 0], [0.8, 1], [2.4, 1], [3, 0]]);
        const squeeze = t > 0.8 && t < 2.4 ? 0.5 - 0.5 * Math.cos(TAU * 2 * (t - 0.8)) : 0;
        bend(P, () => (TAU / n) * curl * (1 + 0.08 * squeeze));
        rearUp(P, curl, 0.4);
        steady(P, 0.3);
      }),
      // Tail swipe (quật thân / đuôi): wind the tail to one side, then whip it across, the tip lagging.
      k.clip("13", "Attack_TailSwipe", 1.4, (t, P) => {
        const turnFront = keys(t, [[0, 0], [0.4, -0.4], [0.7, 1], [0.95, 1], [1.35, 0]]);
        back.forEach((b, i) =>
          turn(P, b, (2.4 / back.length) * keys(t - 0.04 * i, [[0, 0], [0.4, -0.4], [0.72, 1], [0.95, 0.8], [1.35, 0]])),
        );
        turn(P, "Hips", 0.2 * turnFront);
        steady(P, 0.5);
      }),
      k.clip("14", "Hit", 0.7, (t, P) => {
        const e = keys(t, [[0, 0], [0.08, 1], [0.25, 0.8], [0.7, 0]]);
        P.move("Root", k.fwd(-0.05 * len * e));
        bend(P, (s) => 0.2 * e * Math.sin(TAU * s));
        lift(P, "Head", 0.4 * e);
        jaw(P, 0.4 * e);
      }),
      // Death: writhe, go limp and roll belly-up; ends lying there.
      k.clip("14", "Death", 2.4, (t, P) => {
        const e = keys(t, [[0.4, 0], [1.4, 1]]);
        const twitch = Math.exp(-3 * t) * Math.sin(TAU * 4 * t);
        bend(P, (s) => 0.25 * twitch * Math.sin(TAU * s) + 0.05 * e);
        jaw(P, 0.5 * e);
        // Flipping about the Root (on the ground) puts the body below it: lift by its height.
        P.move("Root", k.up(H * e));
        k.roll(P, "Root", Math.PI * e);
      }),
      ...common(k),
    ],
    SERPENT_ATTACKS,
  );
}

const SERPENT_ATTACKS: AttackTable = {
  Attack_Strike: ["jaw", ["Jaw", "Head"], [0.5, 0.7]],
  Attack_Constrict: ["body", /^(Hips|Spine\d+|Tail\d+)$/, [0.8, 2.4]],
  Attack_TailSwipe: ["tail", ["Tail5", "Tail6", "Tail7", "Tail8"], [0.55, 0.95]],
  Attack_Claw: ["claw", ["FrontLowerLegL", "FrontUpperLegL"], [0.5, 0.8]],
};

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

// ---------------------------------------------------------------- buildings

function building(k: Kit): RigClip[] {
  const s = k.r.plan.skin;
  const door = s.mode === "rigid" ? s.doors?.[0] : undefined;
  if (!door) return [tap(k), ...common(k)];
  // Swings out: the opening edge moves toward the front.
  const open = 1.6 * (Math.sign(k.U.clone().cross(door.width).dot(door.normal)) || 1);
  const swing = (P: Poser, a: number) => k.yaw(P, door.bone, open * a);
  return [
    k.clip("11", "Door_Open", 1.5, (t, P) => swing(P, keys(t, [[0.1, 0], [1.1, 1], [1.25, 0.96], [1.4, 1]]))),
    k.clip("11", "Door_Close", 1.5, (t, P) => swing(P, keys(t, [[0.1, 1], [0.8, 0], [0.95, 0.04], [1.1, 0]]))),
    k.clip("11", "Door_OpenClose", 4, (t, P) => swing(P, keys(t, [[0.2, 0], [1.2, 1], [2.6, 1], [3.6, 0]]))),
    tap(k),
    ...common(k),
  ];
}

const BY_CATEGORY: Record<RigCategory, (k: Kit) => RigClip[]> = {
  humanoid,
  quadruped,
  bird,
  serpent,
  fish,
  vehicle,
  aircraft,
  plant,
  fluid,
  building,
  prop: (k) => [tap(k), ...common(k)],
};

export function buildClips(plan: RigPlan): RigClip[] {
  const k = kit(rigOf(plan));
  const clips = BY_CATEGORY[plan.category](k);
  if (plan.category === "humanoid" && plan.bones.some((b) => b.name === "WingUpperL")) {
    const flight = (P: Poser, t: number, glide: boolean) => {
      const ph = TAU * t / (glide ? 2 : 1);
      // Upright hovering / gently leaning glide. Keep the head looking forward and
      // bring the arms down regardless of the model's original A/T-pose.
      k.pitch(P, "Chest", glide ? 0.18 : 0.08);
      k.pitch(P, "Head", glide ? -0.18 : -0.08);
      P.move("Root", k.up(k.H * (0.12 + 0.015 * Math.sin(ph - Math.PI / 2))));
      for (const [side, suffix, sign] of [["Left", "L", 1], ["Right", "R", -1]] as const) {
        const out = k.L.clone().multiplyScalar(sign);
        aim(P, `${side}UpperArm`, k.up(-1).addScaledVector(out, 0.28).addScaledVector(k.F, 0.08), 1);
        aim(P, `${side}LowerArm`, k.up(-1).addScaledVector(out, 0.18).addScaledVector(k.F, 0.2), 1);
        aim(P, `${side}UpperLeg`, k.up(-1).addScaledVector(k.F, -0.12), 1);
        aim(P, `${side}LowerLeg`, k.up(-1).addScaledVector(k.F, -0.4), 1);
        // Absolute segment directions prevent elbow/wrist rotations accumulating
        // into an inverted wing. Both sides rise together about character-forward;
        // distal segments trail the shoulder slightly, in either facing direction.
        WING.forEach((bone, i) => {
          const elevation = 0.12 + (glide ? 0.035 : 0.65) * Math.sin(ph - i * 0.22);
          const direction = out.clone().multiplyScalar(Math.cos(elevation))
            .addScaledVector(k.U, Math.sin(elevation))
            .addScaledVector(k.F, -0.12 - i * 0.06);
          aim(P, bone + suffix, direction, 1);
        });
      }
    };
    clips.push(
      k.clip("07", "Fly", 1, (t, P) => flight(P, t, false)),
      k.clip("07", "Glide", 2, (t, P) => flight(P, t, true)),
      k.clip("07", "Wings_Fold", 1, (t, P) => aimWings(k, P, foldPose(k), keys(t, [[0, 0], [0.5, 1]]))),
      k.clip("07", "Wings_Spread", 1, (t, P) => aimWings(k, P, spreadPose(k), keys(t, [[0, 0], [0.5, 1]]))),
    );
  }
  return clips;
}
