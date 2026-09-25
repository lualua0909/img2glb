import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimationMixer, Bone, BoxGeometry, Group, Mesh } from "three";
import { buildClips } from "./clips";
import { hitboxExtras } from "./hitbox";
import { buildModelData } from "./model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, markerIds, planRig, type RigPlan } from "./rig";
import { computeSkin } from "./skin";

const box = (x: number, y: number, z: number, w: number, h: number, d: number, seg = 3) => {
  const mesh = new Mesh(new BoxGeometry(w, h, d, seg, seg, seg));
  mesh.position.set(x, y, z);
  mesh.updateMatrixWorld();
  return mesh;
};

/** Fish facing +Z with a pair of tall thin feelers (ears, antennae) standing up from its head. */
const fish = () =>
  buildModelData([
    box(0, 0.5, 0, 0.3, 0.3, 2, 4),
    box(0.1, 0.9, 0.7, 0.06, 0.5, 0.06, 4),
    box(-0.1, 0.9, 0.7, 0.06, 0.5, 0.06, 4),
  ]);

/** World direction of a bone (head -> tail) at `fraction` of a clip. */
function dirAt(plan: RigPlan, name: string, bone: string, fraction: number) {
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
  mixer.clipAction(clip).play();
  mixer.setTime(clip.duration * fraction);
  group.updateMatrixWorld(true);
  const spec = plan.bones.find((b) => b.name === bone)!;
  const b = bones.get(bone)!;
  return b.localToWorld(spec.tail.clone().sub(spec.head)).sub(b.localToWorld(spec.head.clone().sub(spec.head))).normalize();
}

test("feelers: markers, soft three-link chains off the head, no hitbox", async () => {
  const model = fish();
  const options = { ...DEFAULT_RIG_OPTIONS, feelers: 1 };
  const ids = markerIds("fish", options);
  for (const id of ["feelerRoot1L", "feelerTip1L", "feelerRoot1R", "feelerTip1R"]) assert.ok(ids.ids.includes(id), id);
  assert.ok(ids.derived.has("feelerTip1R"), "right feeler mirrors the left one");
  assert.ok(!markerIds("vehicle", options).ids.some((id) => id.startsWith("feeler")));

  const markers = guessMarkers("fish", model, options);
  assert.ok(markers.feelerTip1L.y > 1.05 && markers.feelerTip1L.x > 0.05, `left tip on top of the left feeler: ${markers.feelerTip1L.toArray()}`);
  assert.ok(markers.feelerTip1R.x < -0.05, "right tip on the right feeler");

  const plan = planRig("fish", model, markers, options);
  assert.equal(plan.skin.mode, "heat");
  for (const s of ["L", "R"]) {
    assert.match(plan.bones.find((b) => b.name === `Feeler1_1${s}`)!.parent!, /^(Head|Spine\d)$/);
    assert.equal(plan.bones.find((b) => b.name === `Feeler1_3${s}`)!.parent, `Feeler1_2${s}`);
  }

  const clips = buildClips(plan);
  for (const { clip } of clips) for (const track of clip.tracks) assert.ok(Array.from(track.values).every(Number.isFinite));
  assert.ok(!clips.some((c) => c.attack?.bones.some((b) => b.startsWith("Feeler"))), "feelers never deal damage");
  const extras = hitboxExtras(model, plan, clips, { archetype: "fish", species: null });
  assert.ok(!extras.rig.hitboxes.some((h) => h.bone.startsWith("Feeler")), "no feeler hitbox");

  // The feeler sways with the swim: its tip link turns during the clip, only by the simulation (no posed keys).
  const swim = clips.find((c) => c.clip.name === "Swim")!.clip;
  assert.ok(swim.tracks.some((t) => t.name === "Feeler1_3L.quaternion"), "feeler is animated");
  const dirs = [0.1, 0.35, 0.6, 0.85].map((f) => dirAt(plan, "Swim", "Feeler1_3L", f));
  assert.ok(Math.max(...dirs.map((d) => d.angleTo(dirs[0]))) > 0.02, "feeler moves");
  for (const d of dirs) assert.ok(d.y > 0.5, "stays roughly upright: sways, never flops over");

  // The feeler's surface follows the feeler, the body stays off it.
  const skin = await computeSkin(model, plan);
  for (let i = 0; i < model.count; i++) {
    const y = model.positions[i * 3 + 1];
    let w = 0;
    for (let j = 0; j < 4; j++) if (plan.bones[skin.index[i * 4 + j]].name.startsWith("Feeler")) w += skin.weight[i * 4 + j];
    if (y > 1.05) assert.ok(w > 0.99, `feeler vertex ${i}: ${w}`);
    if (y < 0.6) assert.equal(w, 0, `body vertex ${i}`);
  }
});

test("feelers work on every animal template", () => {
  const model = fish();
  for (const category of ["humanoid", "quadruped", "bird", "serpent"] as const) {
    const options = { ...DEFAULT_RIG_OPTIONS, feelers: 2 };
    const markers = guessMarkers(category, model, options);
    for (const id of markerIds(category, options).ids) assert.ok(markers[id]?.toArray().every(Number.isFinite), `${category} ${id}`);
    const plan = planRig(category, model, markers, options);
    assert.equal(plan.bones.filter((b) => b.name.startsWith("Feeler")).length, 12, category);
    for (const { clip } of buildClips(plan)) for (const t of clip.tracks) assert.ok(Array.from(t.values).every(Number.isFinite), category);
  }
});
