import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Mesh, Vector3 } from "three";
import { buildModelData, vertexAt } from "./model";
import { DEFAULT_RIG_OPTIONS, planRig, type Markers } from "./rig";
import { computeSkin } from "./skin";

// Mask-headed chibi in T-pose: a head wider than the shoulders sits right on the arms, feathers hang beside it and a
// sash flies out from the hips.
test("big head and hanging decorations stay off the arms and legs", async () => {
  const pieces: Mesh[] = [];
  const box = (x: number, y: number, w: number, h: number) => {
    const mesh = new Mesh(new BoxGeometry(w, h, 0.4, 8, 8, 4));
    mesh.position.set(x, y, 0);
    mesh.updateMatrixWorld(true);
    pieces.push(mesh);
  };
  box(0, 0.8, 0.5, 0.6); // torso
  box(0, 1.6, 1.2, 1); // head
  for (const sign of [-1, 1]) {
    box(sign * 0.6, 1.02, 0.7, 0.16); // arm
    box(sign * 0.5, 1.3, 0.12, 0.3); // feather hanging beside the head, above the arm
    box(sign * 0.15, 0.25, 0.18, 0.5); // leg
  }
  box(0.55, 0.45, 0.5, 0.08); // sash
  const model = buildModelData(pieces);
  const markers: Markers = { groin: new Vector3(0, 0.5, 0), chin: new Vector3(0, 1.3, 0) };
  for (const [side, sign] of [["L", 1], ["R", -1]] as const)
    for (const [joint, x, y] of [["shoulder", 0.3, 1.02], ["elbow", 0.6, 1.02], ["wrist", 0.9, 1.02], ["knee", 0.15, 0.3], ["ankle", 0.15, 0.05]] as const)
      markers[joint + side] = new Vector3(sign * x, y, 0);
  const plan = planRig("humanoid", model, markers, DEFAULT_RIG_OPTIONS);
  const skin = await computeSkin(model, plan);
  const weightOn = (i: number, pattern: RegExp) => {
    let w = 0;
    for (let slot = 0; slot < 4; slot++) if (pattern.test(plan.bones[skin.index[i * 4 + slot]].name)) w += skin.weight[i * 4 + slot];
    return w;
  };
  let [head, sash, arm] = [0, 0, 0];
  for (let i = 0; i < model.count; i++) {
    const p = vertexAt(model, i);
    if (p.y > 1.2) {
      head++;
      assert.equal(weightOn(i, /(Shoulder|UpperArm|LowerArm|Hand)$/), 0, `arm weight on head at ${p.toArray()}`);
    }
    if (p.x > 0.45 && p.y < 0.5 && p.y > 0.4) {
      sash++;
      assert.equal(weightOn(i, /(UpperLeg|LowerLeg|Foot)$/), 0, `leg weight on sash at ${p.toArray()}`);
    }
    if (Math.abs(p.x) > 0.7 && Math.abs(p.y - 1.02) < 0.08) {
      arm++;
      assert.ok(weightOn(i, /(UpperArm|LowerArm|Hand)$/) > 0.9);
    }
  }
  assert.ok(head > 50 && sash > 10 && arm > 20);
});
