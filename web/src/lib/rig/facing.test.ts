import assert from "node:assert/strict";
import { test } from "node:test";
import { Bone, Group, Vector3 } from "three";
import { modelForward } from "./facing";

const near = (a: Vector3, b: Vector3) => assert.ok(a.distanceTo(b) < 1e-6, `${a.toArray()} != ${b.toArray()}`);

/** Root > Hips > (Spine > Head, Tail1), laid out along `dir` like a side-on animal. */
function animal(dir: Vector3, upright = false) {
  const root = new Group();
  const bone = (name: string, parent: Group | Bone, p: Vector3) => {
    const b = Object.assign(new Bone(), { name });
    b.position.copy(p);
    parent.add(b);
    return b;
  };
  const hips = bone("Hips", bone("Root", root, new Vector3(0.4, -0.6, 0)), new Vector3(0.3, 0.6, 0));
  if (upright) bone("Head", bone("Spine", hips, new Vector3(0, 0.4, 0)), dir.clone().multiplyScalar(0.05).setY(0.5));
  else bone("Head", bone("Spine", hips, dir.clone().multiplyScalar(0.6)), dir.clone().multiplyScalar(0.5).setY(0.2));
  bone("Tail1", hips, dir.clone().multiplyScalar(-0.3));
  return root;
}

test("stored forward in scene extras wins", () => {
  const root = animal(new Vector3(-1, 0, 0));
  root.userData.forward = [0, 0, -1];
  near(modelForward(root), new Vector3(0, 0, -1));
});

for (const dir of [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)])
  test(`side-on animal facing ${dir.toArray()} is read from the skeleton`, () => {
    near(modelForward(animal(dir)), dir);
  });

test("upright skeleton (head above hips) falls back to +Z", () => {
  near(modelForward(animal(new Vector3(-1, 0, 0), true)), new Vector3(0, 0, 1));
});

test("no rig falls back to +Z", () => {
  near(modelForward(new Group()), new Vector3(0, 0, 1));
});
