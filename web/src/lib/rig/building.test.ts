import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxGeometry, Mesh, Quaternion, Vector3 } from "three";
import { buildClips } from "./clips";
import { buildModelData, vertexAt } from "./model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, planRig } from "./rig";
import { computeSkin } from "./skin";

for (const flip of [false, true])
  test(`building door takes only its leaf and swings out (flip=${flip})`, async () => {
    // A 2 x 2 x 2 block standing on the ground: the door is on the front face (+Z, or -Z flipped).
    const box = new BoxGeometry(2, 2, 2, 20, 20, 20).translate(0, 1, 0);
    const model = buildModelData([new Mesh(box)]);
    const options = { ...DEFAULT_RIG_OPTIONS, flip };
    const sign = flip ? -1 : 1;
    const markers = guessMarkers("building", model, options);
    assert.ok(markers.doorHinge && markers.doorTop);
    markers.doorHinge = new Vector3(-0.4, 0.2, 0);
    markers.doorTop = new Vector3(0.4, 1.4, 0);
    const plan = planRig("building", model, markers, options);
    assert.equal(plan.skin.mode, "rigid");
    const door = plan.skin.mode === "rigid" ? plan.skin.doors![0] : null;
    assert.ok(door);
    assert.ok(Math.abs(door.hinge.z - sign) < 1e-3, "door plane is the front face");

    const skin = await computeSkin(model, plan);
    const doorBone = plan.bones.findIndex((b) => b.name === "Door");
    let leaf = 0;
    for (let i = 0; i < model.count; i++) {
      const p = vertexAt(model, i);
      const onDoor = skin.index[i * 4] === doorBone;
      const inside = Math.abs(p.x) < 0.39 && p.y > 0.21 && p.y < 1.39 && Math.abs(p.z - sign) < 1e-3;
      if (inside) assert.ok(onDoor, `door vertex ${i} must swing`);
      if (onDoor) {
        leaf++;
        assert.ok(Math.abs(p.z - sign) < 1e-3, `vertex ${i} off the front face must stay`);
        assert.ok(Math.abs(p.x) <= 0.4 + 1e-6 && p.y >= 0.2 - 1e-6 && p.y <= 1.4 + 1e-6);
      }
    }
    assert.ok(leaf > 0);

    const open = buildClips(plan).find((c) => c.clip.name === "Door_Open");
    assert.ok(open);
    const track = open.clip.tracks.find((t) => t.name === "Door.quaternion")!;
    const q = new Quaternion().fromArray(track.values, track.values.length - 4);
    // The opening edge ends up in front of the building.
    const edge = door.width.clone().applyQuaternion(q);
    assert.ok(edge.dot(door.normal) > 0.9 * door.width.length(), "door opens outward, about 90 degrees");
  });
