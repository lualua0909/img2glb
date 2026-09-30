import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimationMixer, Bone, BoxGeometry, Group, Mesh, Vector3 } from "three";
import { buildClips } from "./clips";
import { buildModelData } from "./model";
import { requiredClips, SPECIES } from "./species";
import { DEFAULT_RIG_OPTIONS, guessMarkers, markerIds, planRig, type RigCategory, type RigOptions, type RigPlan } from "./rig";

const box = (x: number, y: number, z: number, w: number, h: number, d: number, seg = 3) => {
  const mesh = new Mesh(new BoxGeometry(w, h, d, seg, seg, seg));
  mesh.position.set(x, y, z);
  mesh.updateMatrixWorld();
  return mesh;
};

/** Flyer facing -X: a thick head, a long body, two pairs of thin wings spread along Z and thin tail flukes. */
const flyer = () =>
  buildModelData([
    box(0, 0, 0, 2, 0.25, 0.25, 6),
    box(-1.15, 0.05, 0, 0.3, 0.3, 0.3),
    box(-0.4, 0, 0, 0.3, 0.02, 2.2, 6),
    box(0.35, 0, 0, 0.3, 0.02, 2.0, 6),
    box(1.2, 0, 0, 0.4, 0.4, 0.02),
  ]);

const plan = (category: RigCategory, options: Partial<RigOptions>) => {
  const o = { ...DEFAULT_RIG_OPTIONS, ...options };
  const model = flyer();
  return { plan: planRig(category, model, guessMarkers(category, model, o), o), ids: markerIds(category, o).ids };
};

/** World position of a bone's tail at `fraction` of a clip. */
function tipAt(p: RigPlan, name: string, bone: string, fraction: number) {
  const clip = buildClips(p).find((c) => c.clip.name === name)!.clip;
  const group = new Group();
  const bones = new Map<string, Bone>();
  for (const spec of p.bones) {
    const b = new Bone();
    b.position.copy(spec.head);
    if (spec.parent) b.position.sub(p.bones.find((x) => x.name === spec.parent)!.head);
    b.name = spec.name;
    (spec.parent ? bones.get(spec.parent)! : group).add(b);
    bones.set(spec.name, b);
  }
  const mixer = new AnimationMixer(group);
  mixer.clipAction(clip).play();
  mixer.setTime(clip.duration * fraction);
  group.updateMatrixWorld(true);
  const spec = p.bones.find((b) => b.name === bone)!;
  return bones.get(bone)!.localToWorld(spec.tail.clone().sub(spec.head));
}

test("legless bird with two wing pairs: head at the solid end, one pair behind the other, no legs", () => {
  const { plan: p, ids } = plan("bird", { wingPairs: 2, legless: true });
  assert.ok(!ids.some((id) => id.startsWith("foot")), "no foot markers");
  assert.ok(ids.includes("wing2TipL") && ids.includes("wing2TipR"));
  const names = p.bones.map((b) => b.name);
  assert.ok(!names.some((n) => /^(Leg|Foot)[LR]$/.test(n)), "no leg bones");
  for (const n of ["WingUpperL", "WingHandR", "Wing2UpperL", "Wing2HandR"]) assert.ok(names.includes(n), n);
  assert.ok(p.frame.forward.x < -0.9, `faces the head, not the flukes: ${p.frame.forward.toArray()}`);
  const bone = (n: string) => p.bones.find((b) => b.name === n)!;
  assert.ok(bone("WingHandL").tail.x < bone("Wing2HandL").tail.x, "front pair ahead of the second");
  assert.ok(Math.abs(bone("WingHandL").tail.z) > 0.8 && Math.abs(bone("Wing2HandL").tail.z) > 0.8, "tips at the wing tips");

  const clips = buildClips(p);
  for (const { clip } of clips) for (const t of clip.tracks) assert.ok(Array.from(t.values).every(Number.isFinite), clip.name);
  const names2 = clips.map((c) => c.clip.name);
  assert.ok(names2.includes("Fly") && names2.includes("Attack_Peck"));
  assert.ok(!names2.includes("Attack_Pounce") && !names2.includes("Attack_Dive"), "talon attacks need feet");
  // Both pairs beat, the second a little after the first.
  const height = (b: string) => [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875].map((f) => tipAt(p, "Fly", b, f).y);
  const [front, back] = [height("WingHandL"), height("Wing2HandL")];
  assert.ok(Math.max(...back) - Math.min(...back) > 0.2, "second pair flaps");
  assert.notEqual(front.indexOf(Math.max(...front)), back.indexOf(Math.max(...back)), "second pair lags");
});

test("animal on two legs without front limbs, with two wing pairs", () => {
  const { plan: p, ids } = plan("quadruped", { bipedal: true, armless: true, wings: true, wingPairs: 2 });
  assert.ok(!ids.some((id) => /^(elbow|wrist|frontKnee|frontFoot)[LR]$/.test(id)), "no front limb markers");
  const names = p.bones.map((b) => b.name);
  assert.ok(!names.some((n) => /^(UpperArm|LowerArm|Hand|FrontUpperLeg)[LR]$/.test(n)), "no front limbs");
  for (const n of ["RearUpperLegL", "WingUpperL", "Wing2UpperR"]) assert.ok(names.includes(n), n);
  const clips = buildClips(p);
  assert.ok(!clips.some((c) => c.clip.name === "Attack_Swipe"), "no claw swipe without front limbs");
  for (const { clip } of clips) for (const t of clip.tracks) assert.ok(Array.from(t.values).every(Number.isFinite), clip.name);
  assert.ok(clips.find((c) => c.clip.name === "Fly")!.clip.tracks.some((t) => t.name === "Wing2UpperL.quaternion"));
  assert.ok(new Vector3().copy(tipAt(p, "Fly", "Wing2HandL", 0.3)).distanceTo(tipAt(p, "Fly", "Wing2HandL", 0.7)) > 0.05);
});

test("wyvern, four-winged and legless flyer presets get every clip they need", () => {
  for (const id of ["wyvern", "fourWingedFlyer", "skyWyrm"]) {
    const species = SPECIES.find((s) => s.id === id)!;
    const { plan: p } = plan(species.category, species.options);
    const clips = buildClips(p);
    for (const name of requiredClips(species)) assert.ok(clips.some((c) => c.clip.name === name), `${id}: ${name}`);
    for (const c of clips) if (c.attack) assert.ok(c.attack.bones.length, `${id}: ${c.clip.name} has its organ`);
  }
});
