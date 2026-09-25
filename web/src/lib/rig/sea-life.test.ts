import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimationMixer, Bone, BoxGeometry, Group, LoopOnce, Mesh } from "three";
import { buildClips } from "./clips";
import { buildModelData } from "./model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, markerIds, planRig, type RigOptions, type RigPlan } from "./rig";
import { computeSkin } from "./skin";
import { archetypeOf } from "./species";

const box = (x: number, y: number, z: number, w: number, h: number, d: number, seg = 3) => {
  const mesh = new Mesh(new BoxGeometry(w, h, d, seg, seg, seg));
  mesh.position.set(x, y, z);
  mesh.updateMatrixWorld();
  return mesh;
};

/** Manta facing +Z: a flat disc, wide flat fins out to ±1.2 and a thin tail behind. */
const manta = () =>
  buildModelData([
    box(0, 0.5, 0, 0.6, 0.25, 1),
    box(0.75, 0.5, 0, 0.9, 0.06, 0.6),
    box(-0.75, 0.5, 0, 0.9, 0.06, 0.6),
    box(0, 0.5, -0.9, 0.06, 0.06, 0.8, 1),
  ]);

/** Dolphin facing +Z: a long body with two small fins low on its front half. */
const dolphin = () =>
  buildModelData([
    box(0, 0.5, 0, 0.3, 0.3, 2, 4),
    box(0.3, 0.4, 0.3, 0.3, 0.04, 0.2, 2),
    box(-0.3, 0.4, 0.3, 0.3, 0.04, 0.2, 2),
  ]);

function rig(model: ReturnType<typeof manta>, options: RigOptions) {
  const markers = guessMarkers("fish", model, options);
  for (const id of markerIds("fish", options).ids) assert.ok(markers[id]?.toArray().every(Number.isFinite), id);
  return { markers, plan: planRig("fish", model, markers, options) };
}

/** World position of a bone's tail at `fraction` of a clip. */
function sample(plan: RigPlan, name: string, bone: string, fractions: number[]) {
  const clip = buildClips(plan).find((c) => c.clip.name === name)!.clip;
  const group = new Group();
  const bones = new Map<string, Bone>();
  for (const spec of plan.bones) {
    const b = new Bone();
    b.position.copy(spec.head);
    if (spec.parent) b.position.sub(plan.bones.find((x) => x.name === spec.parent)!.head);
    b.name = spec.name;
    (spec.parent ? bones.get(spec.parent)! : group).add(b);
    bones.set(spec.name, b);
  }
  const mixer = new AnimationMixer(group);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.play();
  const spec = plan.bones.find((b) => b.name === bone)!;
  const tip = spec.tail.clone().sub(spec.head);
  return fractions.map((f) => {
    mixer.setTime(clip.duration * f);
    group.updateMatrixWorld(true);
    return bones.get(bone)!.localToWorld(tip.clone());
  });
}

test("manta ray: fins with three joints each, fin beat, glide and fin slap", async () => {
  const model = manta();
  const options = { ...DEFAULT_RIG_OPTIONS, fins: true, swim: "ray" as const };
  const { markers, plan } = rig(model, options);
  assert.ok(markers.head.z > 0.4, "head at the heavy end");
  assert.ok(markers.finTipL.x > 1 && markers.finTipR.x < -1, "fin tips at the widest points");
  for (const s of ["L", "R"]) for (const j of [1, 2, 3]) assert.ok(plan.bones.some((b) => b.name === `Fin${j}${s}`));
  assert.match(plan.bones.find((b) => b.name === "Fin1L")!.parent!, /^Spine/);
  assert.equal(plan.swim, "ray");
  assert.equal(archetypeOf("fish", options), "ray");

  const clips = buildClips(plan);
  for (const name of ["Swim", "Swim_Fast", "Swim_Idle", "Glide", "Attack_FinSlap", "Attack_TailSlap"])
    assert.ok(clips.some((c) => c.clip.name === name), name);
  for (const { clip } of clips) for (const track of clip.tracks) assert.ok(Array.from(track.values).every(Number.isFinite));
  const slap = clips.find((c) => c.clip.name === "Attack_FinSlap")!.attack!;
  assert.equal(slap.organ, "wing");
  assert.deepEqual(slap.bones, ["Fin2L", "Fin3L", "Fin2R", "Fin3R"]);

  // Swim: both fin tips rise and fall together.
  const [upL, downL] = sample(plan, "Swim", "Fin3L", [0.25, 0.75]);
  const [upR, downR] = sample(plan, "Swim", "Fin3R", [0.25, 0.75]);
  assert.ok(upL.y - downL.y > 0.3, "left fin beats");
  assert.ok(Math.abs(upL.y - upR.y) < 1e-4 && Math.abs(downL.y - downR.y) < 1e-4, "fins beat together");

  const skin = await computeSkin(model, plan);
  let tips = 0;
  for (let i = 0; i < model.count; i++) {
    const x = model.positions[i * 3];
    let fin = 0;
    let sum = 0;
    for (let j = 0; j < 4; j++) {
      const w = skin.weight[i * 4 + j];
      sum += w;
      if (plan.bones[skin.index[i * 4 + j]].name.startsWith("Fin")) fin += w;
    }
    assert.ok(Math.abs(sum - 1) < 1e-5);
    if (Math.abs(x) > 0.9) {
      tips++;
      assert.ok(fin > 0.99, `fin vertex ${i} follows the fin: ${fin}`);
    }
    if (Math.abs(x) < 0.05) assert.equal(fin, 0, `midline vertex ${i} stays on the body`);
  }
  assert.ok(tips > 0);
});

test("dolphin beats its tail up and down, a fish side to side", () => {
  const model = dolphin();
  for (const swim of ["whale", "fish"] as const) {
    const { markers, plan } = rig(model, { ...DEFAULT_RIG_OPTIONS, fins: true, swim });
    assert.ok(markers.finTipL.x > 0.2 && markers.finTipL.z > 0, "fin on the front half");
    const [a, b] = sample(plan, "Swim", "Spine6", [0.25, 0.75]);
    const vertical = Math.abs(a.y - b.y);
    const lateral = Math.abs(a.x - b.x);
    if (swim === "whale") assert.ok(vertical > 4 * lateral, `flukes beat up and down: ${vertical} vs ${lateral}`);
    else assert.ok(lateral > 4 * vertical, `tail beats sideways: ${lateral} vs ${vertical}`);
    assert.equal(buildClips(plan).some((c) => c.clip.name === "Swim_Dolphin"), swim === "fish");
  }
});

test("plain fish keeps the chain skin; a jaw adds Head and Jaw bones", () => {
  const model = dolphin();
  const plain = rig(model, DEFAULT_RIG_OPTIONS).plan;
  assert.equal(plain.skin.mode, "chain");
  assert.ok(!plain.bones.some((b) => b.name === "Head"));
  const jawed = rig(model, { ...DEFAULT_RIG_OPTIONS, jaw: true }).plan;
  assert.equal(jawed.skin.mode, "heat");
  assert.equal(jawed.bones.find((b) => b.name === "Jaw")!.parent, "Head");
  const bite = buildClips(jawed).find((c) => c.clip.name === "Attack_Bite")!;
  assert.deepEqual(bite.attack!.bones, ["Jaw", "Head"]);
  assert.ok(bite.clip.tracks.some((t) => t.name === "Jaw.quaternion"));
});
