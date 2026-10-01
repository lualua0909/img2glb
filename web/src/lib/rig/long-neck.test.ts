import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimationMixer, Bone, BoxGeometry, Group, Mesh, Vector3 } from "three";
import { buildClips } from "./clips";
import { buildModelData } from "./model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, planRig, type RigOptions, type RigPlan } from "./rig";

const box = (x: number, y: number, z: number, w: number, h: number, d: number, seg = 3) => {
  const mesh = new Mesh(new BoxGeometry(w, h, d, seg, seg, seg));
  mesh.position.set(x, y, z);
  mesh.updateMatrixWorld();
  return mesh;
};

/** Four-winged flyer facing -X, its head on a slender neck `neck` long (0: the head right on the body). */
const flyer = (neck: number) => {
  const model = buildModelData([
    box(0, 0, 0, 2, 0.25, 0.25, 6),
    box(-1 - neck, 0.05, 0, 0.3, 0.3, 0.3),
    ...(neck ? [box(-1 - neck / 2, 0.02, 0, neck, 0.12, 0.12, 6)] : []),
    box(-0.4, 0, 0, 0.3, 0.02, 2.2, 6),
    box(0.35, 0, 0, 0.3, 0.02, 2.0, 6),
    box(1.2, 0, 0, 0.4, 0.4, 0.02),
  ]);
  const o: RigOptions = { ...DEFAULT_RIG_OPTIONS, wingPairs: 2, legless: true };
  return planRig("bird", model, guessMarkers("bird", model, o), o);
};

/** How far the head moves sideways over a clip. */
function headSway(p: RigPlan, name: string) {
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
  const side: number[] = [];
  for (let f = 0; f <= 40; f++) {
    mixer.setTime((clip.duration * f) / 40);
    group.updateMatrixWorld(true);
    side.push(bones.get("Head")!.getWorldPosition(new Vector3()).dot(p.frame.lateral));
  }
  return Math.max(...side) - Math.min(...side);
}

test("a long-necked flyer weaves its head from side to side in flight; a stocky one holds it still", () => {
  const long = flyer(0.8);
  const stocky = flyer(0);
  assert.ok(long.longNeck && !stocky.longNeck);
  assert.ok(headSway(long, "Fly") > 0.05 * long.length, `long neck sways: ${headSway(long, "Fly")}`);
  assert.ok(headSway(stocky, "Fly") < 1e-3, `stocky neck holds: ${headSway(stocky, "Fly")}`);
  assert.ok(headSway(long, "Idle") > headSway(stocky, "Idle"));
});
