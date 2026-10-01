import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxGeometry, Mesh } from "three";
import { buildClips } from "./clips";
import { buildModelData, vertexAt } from "./model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, markerIds, planRig } from "./rig";
import { computeSkin } from "./skin";

const box = (x: number, y: number, z: number, w: number, h: number, d: number, seg = 3) => {
  const mesh = new Mesh(new BoxGeometry(w, h, d, seg, seg, seg));
  mesh.position.set(x, y, z);
  mesh.updateMatrixWorld();
  return mesh;
};

/** Beast facing -X: a long body on three pairs of legs (at x = -0.8, 0, 0.8), a head in front and a tail behind. */
const hexapod = () =>
  buildModelData([
    box(0, 0.8, 0, 2.2, 0.5, 0.7, 6),
    box(-1.3, 0.95, 0, 0.45, 0.4, 0.4),
    box(1.5, 0.85, 0, 0.8, 0.15, 0.15),
    ...[-0.8, 0, 0.8].flatMap((x) => [0.25, -0.25].map((z) => box(x, 0.3, z, 0.15, 0.6, 0.15))),
  ]);

test("six legs: a middle pair of legs found under the middle of the body and rigged", () => {
  const o = { ...DEFAULT_RIG_OPTIONS, sixLegs: true };
  const model = hexapod();
  const k = guessMarkers("quadruped", model, o);
  const ids = markerIds("quadruped", o).ids;
  for (const id of ["midKneeL", "midKneeR", "midFootL", "midFootR"]) assert.ok(ids.includes(id), id);
  // Feet land on their legs: front near x = -0.8, middle near 0, rear near 0.8.
  assert.ok(Math.abs(k.frontFootL.x + 0.8) < 0.15, `front foot at ${k.frontFootL.x}`);
  assert.ok(Math.abs(k.midFootL.x) < 0.15, `middle foot at ${k.midFootL.x}`);
  assert.ok(Math.abs(k.rearFootL.x - 0.8) < 0.15, `rear foot at ${k.rearFootL.x}`);
  assert.ok(Math.abs(Math.abs(k.midFootL.z) - 0.25) < 0.1 && k.midFootL.z * k.midFootR.z < 0, "middle feet on both sides");

  const plan = planRig("quadruped", model, k, o);
  const names = plan.bones.map((b) => b.name);
  for (const s of ["L", "R"])
    for (const b of ["UpperLeg", "LowerLeg", "Foot"]) assert.ok(names.includes(`Mid${b}${s}`), `Mid${b}${s}`);
  assert.equal(plan.bones.find((b) => b.name === "MidUpperLegL")!.parent, "Spine");

  // The walk moves the middle legs too.
  const walk = buildClips(plan).find((c) => c.clip.name === "Walk")!.clip;
  const index = names.indexOf("MidUpperLegL");
  assert.ok(walk.tracks.some((t) => t.name.startsWith(`${plan.bones[index].name}.`)), "walk animates the middle legs");
});

test("four legs by default: no middle pair", () => {
  const model = hexapod();
  const ids = markerIds("quadruped", DEFAULT_RIG_OPTIONS).ids;
  assert.ok(!ids.some((id) => id.startsWith("mid")));
  const plan = planRig("quadruped", model, guessMarkers("quadruped", model, DEFAULT_RIG_OPTIONS), DEFAULT_RIG_OPTIONS);
  assert.ok(!plan.bones.some((b) => b.name.startsWith("Mid")));
});

test("six legs: the middle legs start under the body, so the back and flanks stay off them", async () => {
  const o = { ...DEFAULT_RIG_OPTIONS, sixLegs: true };
  const model = hexapod();
  const plan = planRig("quadruped", model, guessMarkers("quadruped", model, o), o);
  // Body from y = 0.55 to 1.05: the hip is near its underside, not up at the back.
  const hip = plan.bones.find((b) => b.name === "MidUpperLegL")!.head;
  assert.ok(hip.y < 0.7, `middle hip at ${hip.y}`);
  const skin = await computeSkin(model, plan);
  const weightOn = (i: number, pattern: RegExp) => {
    let w = 0;
    for (let slot = 0; slot < 4; slot++) if (pattern.test(plan.bones[skin.index[i * 4 + slot]].name)) w += skin.weight[i * 4 + slot];
    return w;
  };
  let [trunk, leg] = [0, 0];
  for (let i = 0; i < model.count; i++) {
    const p = vertexAt(model, i);
    if (Math.abs(p.x) < 0.3 && p.y > 0.75) {
      trunk++;
      assert.equal(weightOn(i, /^Mid/), 0, `middle leg weight on the trunk at ${p.toArray()}`);
    }
    if (Math.abs(p.x) < 0.1 && p.y < 0.4) {
      leg++;
      assert.ok(weightOn(i, /^Mid/) > 0.9, `middle leg at ${p.toArray()}`);
    }
  }
  assert.ok(trunk > 8 && leg > 20, `checked ${trunk} trunk, ${leg} leg vertices`);
});
