import assert from "node:assert/strict";
import test from "node:test";
import { Bone, BoxGeometry, Group, Mesh, Object3D, Vector3 } from "three";
import { DEFAULT_POSE, findHandAnchor, holderMatrix, normalizeWeapon } from "./preview-weapon";

const close = (a: Vector3, b: Vector3) => assert.ok(a.distanceTo(b) < 1e-6, `${a.toArray()} != ${b.toArray()}`);

test("preview weapon hangs from the socket, grip in the palm, pointing where the model faces", () => {
  const root = new Group();
  const hand = new Bone();
  hand.name = "RightHand";
  hand.position.set(-1, 1, 0);
  hand.rotation.z = 0.7;
  hand.scale.setScalar(2);
  root.add(hand);
  const socket = new Object3D();
  socket.name = "WeaponSocketRight";
  socket.position.set(-0.1, 0, 0);
  hand.add(socket);
  assert.equal(findHandAnchor(root, "Right"), socket);
  assert.equal(findHandAnchor(root, "Left"), null);

  root.updateMatrixWorld(true);
  const holder = new Object3D();
  holder.matrixAutoUpdate = false;
  holder.matrix.copy(holderMatrix(socket.matrixWorld, new Vector3(1, 0, 0), 0.5, DEFAULT_POSE));
  socket.add(holder);
  root.updateMatrixWorld(true);
  const at = (p: Vector3) => p.clone().applyMatrix4(holder.matrixWorld);
  const palm = socket.getWorldPosition(new Vector3());
  close(at(new Vector3()), palm);
  close(at(new Vector3(0, 1, 0)), palm.clone().add(new Vector3(0.5, 0, 0)));
  close(at(new Vector3(0, 0, 1)), palm.clone().add(new Vector3(0, 0.5, 0)));
});

test("hand bones without a socket are found by common names", () => {
  for (const name of ["DEF-LeftHand", "mixamorig:LeftHand", "hand_l", "L_Hand"]) {
    const root = new Group();
    const b = new Bone();
    b.name = name;
    root.add(b);
    assert.equal(findHandAnchor(root, "Left"), b, name);
    assert.equal(findHandAnchor(root, "Right"), null, name);
  }
});

test("uploaded weapons are turned to lie along +Y, one unit long, gripped near one end", () => {
  const mesh = new Mesh(new BoxGeometry(4, 0.2, 0.6));
  mesh.position.set(3, 3, 3);
  const w = normalizeWeapon(mesh);
  w.updateMatrixWorld(true);
  const box = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
  mesh.geometry.computeBoundingBox();
  const b = mesh.geometry.boundingBox!;
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
    const p = new Vector3(x, y, z).applyMatrix4(mesh.matrixWorld);
    box.min.min(p);
    box.max.max(p);
  }
  close(box.min, new Vector3(-0.075, -0.15, -0.025));
  close(box.max, new Vector3(0.075, 0.85, 0.025));
});
