import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Mesh, Vector3 } from "three";
import { buildModelData, vertexAt } from "./model";
import { DEFAULT_RIG_OPTIONS, planRig, type Markers } from "./rig";
import { computeSkin } from "./skin";
import { templateRigConfig } from "../blender/template";

function fixture(flip = false) {
  const pieces: Mesh[] = [];
  const box = (x: number, y: number, w: number, h: number) => {
    const mesh = new Mesh(new BoxGeometry(w, h, 0.4, 8, 8, 4));
    mesh.position.set(x, y, 0);
    mesh.updateMatrixWorld(true);
    pieces.push(mesh);
  };
  box(0, 1.1, 0.7, 1);
  box(0, 1.9, 0.6, 0.4);
  for (const sign of [-1, 1]) {
    // Sleeves touch the torso and weld at matching surface rows.
    box(sign * 0.5, 1.1, 0.3, 1);
    box(sign * 0.2, 0.3, 0.22, 0.6);
  }
  const model = buildModelData(pieces);
  const markers: Markers = { groin: new Vector3(0, 0.65, 0), chin: new Vector3(0, 1.7, 0) };
  for (const [side, sign] of [["L", flip ? -1 : 1], ["R", flip ? 1 : -1]] as const)
    for (const [joint, x, y] of [["shoulder", 0.5, 1.6], ["elbow", 0.5, 1.15], ["wrist", 0.5, 0.75], ["knee", 0.2, 0.4], ["ankle", 0.2, 0.1]] as const)
      markers[joint + side] = new Vector3(sign * x, y, 0);
  const options = { ...DEFAULT_RIG_OPTIONS, flip };
  return { model, markers, options, plan: planRig("humanoid", model, markers, options) };
}

for (const flip of [false, true]) test(`lowered arms protect torso and animate sleeves (flip=${flip})`, async () => {
  const { model, plan } = fixture(flip);
  const skin = await computeSkin(model, plan);
  let torso = 0;
  let sleeve = 0;
  for (let i = 0; i < model.count; i++) {
    const p = vertexAt(model, i);
    let sum = 0;
    let armWeight = 0;
    const posed = new Vector3();
    for (let slot = 0; slot < 4; slot++) {
      const w = skin.weight[i * 4 + slot];
      assert.ok(Number.isFinite(w) && w >= 0);
      sum += w;
      const b = plan.bones[skin.index[i * 4 + slot]];
      const q = p.clone();
      if (/^(Left|Right)(UpperArm|LowerArm|Hand)$/.test(b.name)) {
        armWeight += w;
        const shoulder = plan.bones.find(bone => bone.name === `${b.name.startsWith("Left") ? "Left" : "Right"}UpperArm`)!.head;
        q.sub(shoulder).applyAxisAngle(new Vector3(0, 0, 1), 0.8).add(shoulder);
      }
      posed.addScaledVector(q, w);
    }
    assert.ok(Math.abs(sum - 1) < 1e-5);
    if (Math.abs(p.x) < 0.34 && p.y > 0.65 && p.y < 1.3) {
      torso++;
      assert.equal(armWeight, 0, `arm weight on torso at ${p.toArray()}`);
      assert.ok(posed.distanceTo(p) < 1e-6);
    }
    if (Math.abs(p.x) > 0.6 && p.y > 0.8 && p.y < 1.1) {
      sleeve++;
      assert.ok(armWeight > 0.9);
      assert.ok(posed.distanceTo(p) > 0.1);
    }
  }
  assert.ok(torso > 20 && sleeve > 10);
  const config = templateRigConfig(plan, null);
  for (const b of plan.bones.filter(b => /^(Left|Right)(UpperArm|LowerArm|Hand)$/.test(b.name)))
    assert.deepEqual(config.skeleton.find(s => s.name === b.name)?.gate, {
      origin: b.gate!.origin.toArray(), dir: b.gate!.dir.toArray(), fade: b.gate!.fade,
    });
});

test("raised and crossed arms retain pose-aligned gates", () => {
  for (const crossed of [false, true]) {
    const { model, markers, options } = fixture();
    markers.elbowL.set(crossed ? 0.2 : 0.9, crossed ? 1.2 : 1.6, 0);
    markers.wristL.set(crossed ? -0.1 : 1.3, crossed ? 1 : 1.6, 0);
    const plan = planRig("humanoid", model, markers, options);
    assert.equal(plan.bones.find(b => b.name === "LeftUpperArm")!.gate!.fade, undefined);
  }
});
