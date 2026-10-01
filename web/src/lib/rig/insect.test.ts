import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimationMixer, Bone, BoxGeometry, Group, Mesh, Vector3 } from "three";
import { buildClips } from "./clips";
import { buildModelData } from "./model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, planRig, type RigPlan } from "./rig";
import { requiredClips, SPECIES } from "./species";

const box = (x: number, y: number, z: number, w: number, h: number, d: number, seg = 4) => {
  const mesh = new Mesh(new BoxGeometry(w, h, d, seg, seg, seg));
  mesh.position.set(x, y, z);
  mesh.updateMatrixWorld();
  return mesh;
};

/**
 * Dragonfly facing -X: a head, a short thorax (x -1.1 … -0.5) carrying six thin legs and two pairs of flat wings
 * spread along Z (front pair at x = -0.9, hind pair at -0.6), a long thin abdomen behind it to x = 1.55, and two
 * antennae sticking out in front of the head to x = -1.75.
 */
const dragonfly = () =>
  buildModelData([
    box(-1.25, 1.0, 0, 0.3, 0.3, 0.4),
    box(-0.8, 1.0, 0, 0.6, 0.36, 0.32, 6),
    box(0.5, 1.0, 0, 2.1, 0.12, 0.12, 10),
    ...[1, -1].map((side) => box(-1.55, 1.12, side * 0.1, 0.4, 0.03, 0.03)),
    ...[1, -1].flatMap((side) => [box(-0.9, 1.17, side * 0.95, 0.24, 0.02, 1.6, 8), box(-0.6, 1.17, side * 0.95, 0.24, 0.02, 1.6, 8)]),
    ...[-0.95, -0.8, -0.65].flatMap((x) => [1, -1].map((side) => box(x, 0.6, side * 0.13, 0.05, 0.7, 0.05))),
  ]);

const insect = SPECIES.find((s) => s.id === "insect")!;
const rig = () => {
  const o = { ...DEFAULT_RIG_OPTIONS, ...insect.options };
  const model = dragonfly();
  return planRig("quadruped", model, guessMarkers("quadruped", model, o), o);
};

/** World tail position of each of `bones` through a clip, `n` samples a second. */
function track(p: RigPlan, name: string, bones: string[], n: number) {
  const clip = buildClips(p).find((c) => c.clip.name === name)!.clip;
  const group = new Group();
  const objects = new Map<string, Bone>();
  for (const spec of p.bones) {
    const b = new Bone();
    b.position.copy(spec.head);
    if (spec.parent) b.position.sub(p.bones.find((x) => x.name === spec.parent)!.head);
    b.name = spec.name;
    (spec.parent ? objects.get(spec.parent)! : group).add(b);
    objects.set(spec.name, b);
  }
  const mixer = new AnimationMixer(group);
  mixer.clipAction(clip).play();
  const frames = Math.round(clip.duration * n);
  return Array.from({ length: frames }, (_, f) => {
    mixer.setTime((clip.duration * f) / frames);
    group.updateMatrixWorld(true);
    return bones.map((name) => {
      const spec = p.bones.find((b) => b.name === name)!;
      const o = objects.get(name)!;
      return { head: o.getWorldPosition(new Vector3()), tail: o.localToWorld(spec.tail.clone().sub(spec.head)) };
    });
  });
}

/** Correlation of two series: 1 in step, -1 opposite. */
function corr(a: number[], b: number[]) {
  const [ma, mb] = [a, b].map((x) => x.reduce((s, y) => s + y, 0) / x.length);
  let [ab, aa, bb] = [0, 0, 0];
  a.forEach((_, i) => {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  });
  return ab / Math.sqrt(aa * bb);
}

test("insect: legs and wings on the thorax, the abdomen is the tail", () => {
  const p = rig();
  const bone = (n: string) => p.bones.find((b) => b.name === n)!;
  for (const pos of ["Front", "Mid", "Rear"])
    for (const s of ["L", "R"]) {
      const foot = bone(`${pos}LowerLeg${s}`).tail;
      assert.ok(foot.x > -1.1 && foot.x < -0.5, `${pos} foot ${s} under the thorax: ${foot.x}`);
    }
  assert.ok(bone("FrontLowerLegL").tail.x < bone("MidLowerLegL").tail.x && bone("MidLowerLegL").tail.x < bone("RearLowerLegL").tail.x);
  // Each pair's tip on its own wing, both tips out at the wing ends.
  assert.ok(Math.abs(bone("WingHandL").tail.x + 0.9) < 0.08, `front tip at ${bone("WingHandL").tail.x}`);
  assert.ok(Math.abs(bone("Wing2HandL").tail.x + 0.6) < 0.08, `hind tip at ${bone("Wing2HandL").tail.x}`);
  assert.ok(bone("WingHandL").tail.z > 1.6 && bone("Wing2HandR").tail.z < -1.6);
  for (const w of ["WingUpperL", "Wing2UpperL"]) assert.ok(bone(w).head.x > -1.1 && bone(w).head.x < -0.5, `${w} roots on the thorax`);
  // Five abdomen links from the back of the thorax to the tip.
  const tails = p.bones.filter((b) => /^Tail\d+$/.test(b.name));
  assert.equal(tails.length, 5);
  assert.ok(tails[0].head.x < -0.3, `abdomen starts at ${tails[0].head.x}`);
  assert.ok(tails.at(-1)!.tail.x > 1.5);
  assert.ok(p.insect);
  // Antennae on the antennae, not on a wing tip or the end of the abdomen, which stick out farther from the head.
  for (const s of ["L", "R"]) {
    const feeler = p.bones.filter((b) => b.name.startsWith("Feeler1") && b.name.endsWith(s));
    assert.ok(feeler.length && feeler.at(-1)!.tail.x < -1.6, `antenna ${s} tip at ${feeler.at(-1)?.tail.toArray()}`);
  }
});

test("insect flight: stiff wings beat fast up and down, the pairs half a beat apart", () => {
  const p = rig();
  const fly = buildClips(p).find((c) => c.clip.name === "Fly")!.clip;
  assert.ok(fly.tracks[0].times.length >= 60 * fly.duration, "keyed fast enough for the wingbeat");
  const frames = track(p, "Fly", ["WingUpperL", "WingForeL", "WingHandL", "Wing2HandL", "WingHandR"], 240);
  const front = frames.map((f) => f[2].tail.y - f[0].head.y);
  const hind = frames.map((f) => f[3].tail.y);
  // Ten strokes a second: the tip crosses its mean height twenty times.
  const mean = front.reduce((a, y) => a + y, 0) / front.length;
  let crossings = 0;
  for (let i = 1; i < front.length; i++) if ((front[i - 1] - mean) * (front[i] - mean) < 0) crossings++;
  assert.ok(crossings >= 18 / fly.duration, `${crossings} crossings in ${fly.duration}s`);
  assert.ok(Math.max(...front) - Math.min(...front) > 1.5, `stroke height ${Math.max(...front) - Math.min(...front)}`);
  // One stiff piece: the forewing and hand stay in line with the upper wing.
  for (const f of frames) {
    const dir = (i: number) => f[i].tail.clone().sub(f[i].head).normalize();
    assert.ok(dir(0).dot(dir(1)) > 0.99 && dir(0).dot(dir(2)) > 0.99, "the wing doesn't bend");
  }
  // Both sides together, the hind pair against the front one.
  const right = frames.map((f) => f[4].tail.y);
  const tipsY = frames.map((f) => f[2].tail.y);
  assert.ok(corr(tipsY, right) > 0.95, "left and right beat together");
  assert.ok(corr(tipsY, hind) < -0.8, "hind pair counter-strokes");
});

test("insect: the sting curls the abdomen tip under and forward", () => {
  const p = rig();
  const sting = buildClips(p).find((c) => c.clip.name === "Attack_Sting")!;
  assert.deepEqual(sting.attack?.bones, ["Tail4", "Tail5"]);
  assert.equal(sting.attack?.organ, "stinger");
  const tip = track(p, "Attack_Sting", ["Tail5"], 30).map((f) => f[0].tail);
  const rest = p.bones.find((b) => b.name === "Tail5")!.tail;
  const strike = tip[Math.round(0.6 * 30)];
  assert.ok(strike.x < rest.x - 1, `tip comes forward: ${strike.x} from ${rest.x}`);
  assert.ok(strike.y < rest.y - 0.3, `tip goes under: ${strike.y} from ${rest.y}`);
});

test("insect preset gets every clip it needs, with finite tracks", () => {
  const clips = buildClips(rig());
  for (const name of requiredClips(insect)) assert.ok(clips.some((c) => c.clip.name === name), name);
  for (const c of clips) {
    if (c.attack) assert.ok(c.attack.bones.length, `${c.clip.name} has its organ`);
    for (const t of c.clip.tracks) assert.ok(Array.from(t.values).every(Number.isFinite), c.clip.name);
  }
});

test("six legs walk in alternating tripods", () => {
  const p = rig();
  const legs = ["FrontLowerLegL", "MidLowerLegR", "RearLowerLegL", "FrontLowerLegR", "MidLowerLegL", "RearLowerLegR"];
  const x = track(p, "Walk", legs, 30).map((f) => f.map((b) => b.tail.x));
  const swing = (i: number) => x.map((f) => f[i]);
  const same = (i: number, j: number) => corr(swing(i), swing(j)) > 0.95;
  assert.ok(same(0, 1) && same(0, 2), "front and hind left step with the middle right");
  assert.ok(same(3, 4) && same(3, 5), "and the other tripod together");
  assert.ok(corr(swing(0), swing(3)) < -0.9, "the two tripods alternate");
});
