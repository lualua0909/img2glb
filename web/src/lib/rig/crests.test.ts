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

/** Beast facing -X with a thin sail along its back (y = 1.05 to 1.6). */
const sailback = () =>
  buildModelData([
    box(0, 0.8, 0, 2.2, 0.5, 0.7, 6),
    box(-1.3, 0.95, 0, 0.45, 0.4, 0.4),
    box(1.5, 0.85, 0, 0.8, 0.15, 0.15),
    box(0, 1.325, 0, 1.6, 0.55, 0.04, 12),
    ...[-0.8, 0.8].flatMap((x) => [0.25, -0.25].map((z) => box(x, 0.3, z, 0.15, 0.6, 0.15))),
  ]);

test("crest sections: roots on the back, tips on the sail, swaying while the body stays put", async () => {
  const o = { ...DEFAULT_RIG_OPTIONS, crests: 3 };
  const model = sailback();
  const k = guessMarkers("quadruped", model, o);
  const ids = markerIds("quadruped", o).ids;
  for (let i = 1; i <= 3; i++) {
    assert.ok(ids.includes(`crestRoot${i}`) && ids.includes(`crestTip${i}`));
    assert.ok(k[`crestTip${i}`].y > 1.5, `tip ${i} at ${k[`crestTip${i}`].y}`);
    assert.ok(Math.abs(k[`crestRoot${i}`].y - 1.05) < 0.1, `root ${i} at ${k[`crestRoot${i}`].y}`);
  }
  assert.ok(k.crestTip1.x < k.crestTip2.x && k.crestTip2.x < k.crestTip3.x, "sections spread along the back");

  const plan = planRig("quadruped", model, k, o);
  const names = plan.bones.map((b) => b.name);
  for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) assert.ok(names.includes(`Crest${i}_${j}`));
  assert.ok(["Hips", "Spine", "Chest"].includes(plan.bones.find((b) => b.name === "Crest2_1")!.parent!));

  const clips = buildClips(plan);
  const walk = clips.find((c) => c.clip.name === "Walk")!.clip;
  assert.ok(walk.tracks.some((t) => t.name === "Crest2_3.quaternion"), "the walk sways the crest");
  for (const { clip } of clips) for (const t of clip.tracks) assert.ok(Array.from(t.values).every(Number.isFinite), clip.name);

  const skin = await computeSkin(model, plan);
  const weightOn = (i: number) => {
    let w = 0;
    for (let slot = 0; slot < 4; slot++) if (plan.bones[skin.index[i * 4 + slot]].name.startsWith("Crest")) w += skin.weight[i * 4 + slot];
    return w;
  };
  let [sail, body] = [0, 0];
  for (let i = 0; i < model.count; i++) {
    const p = vertexAt(model, i);
    if (p.y > 1.4) {
      sail++;
      assert.ok(weightOn(i) > 0.85, `sail at ${p.toArray()}`);
    }
    if (p.y < 0.95) {
      body++;
      assert.equal(weightOn(i), 0, `crest weight on the body at ${p.toArray()}`);
    }
  }
  assert.ok(sail > 20 && body > 20, `checked ${sail} sail, ${body} body vertices`);
});
