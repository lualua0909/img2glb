import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxGeometry, Mesh, Vector3 } from "three";
import { buildModelData, vertexAt } from "./model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, planRig } from "./rig";
import { computeSkin } from "./skin";

for (const flip of [false, true]) test(`jaw weights stay below the mouth (flip=${flip})`, async () => {
  // A connected surface deliberately lets heat travel from chin to skull.
  const model = buildModelData([new Mesh(new BoxGeometry(2, 2, 2, 8, 8, 8))]);
  const options = { ...DEFAULT_RIG_OPTIONS, jaw: true, flip };
  const markers = guessMarkers("quadruped", model, options);
  const sign = flip ? -1 : 1;
  markers.head = new Vector3(0, 0.5, -0.5 * sign);
  markers.nose = new Vector3(0, 0.5, 0.9 * sign);
  markers.jawTip = new Vector3(0, -0.5, 0.9 * sign);
  const plan = planRig("quadruped", model, markers, options);
  // Isolate head/jaw diffusion from unrelated limbs in this synthetic fixture.
  plan.bones = plan.bones.filter((bone) => ["Head", "Jaw"].includes(bone.name));
  plan.bones[0].parent = null;
  const jawIndex = plan.bones.findIndex((bone) => bone.name === "Jaw");
  const gate = plan.bones[jawIndex].gate!;
  const skin = await computeSkin(model, plan);
  let skullVertices = 0;
  let movingChinVertices = 0;
  for (let i = 0; i < model.count; i++) {
    const point = vertexAt(model, i);
    let jawWeight = 0;
    let sum = 0;
    for (let j = 0; j < 4; j++) {
      const weight = skin.weight[i * 4 + j];
      assert.ok(Number.isFinite(weight));
      sum += weight;
      if (skin.index[i * 4 + j] === jawIndex) jawWeight += weight;
    }
    assert.ok(Math.abs(sum - 1) < 1e-5);
    if (point.clone().sub(gate.origin).dot(gate.dir) < 0) {
      skullVertices++;
      assert.equal(jawWeight, 0, `skull vertex ${i} must not move with the jaw`);
    }
    if (point.y < -0.5 && point.z * sign > 0.5 && jawWeight > 0.5) movingChinVertices++;
  }
  assert.ok(skullVertices > 0);
  assert.ok(movingChinVertices > 0, "lower jaw must still open");
});
