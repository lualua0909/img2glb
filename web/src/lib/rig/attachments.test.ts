import assert from "node:assert/strict";
import test from "node:test";
import { Bone, Scene, Vector3 } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { addWeaponSockets } from "./attachments";
import type { RigPlan } from "./rig";

test("weapon sockets follow both hands, export as child nodes and never become deform joints", async () => {
  const bones = [new Bone(), new Bone()];
  const specs = ["Left", "Right"].map((side, i) => ({
    name: `${side}Hand`, parent: null, head: new Vector3(i ? -1 : 1, 1, 0),
    tail: new Vector3(i ? -1.4 : 1.4, 1, 0), deform: true,
  }));
  const plan = { category: "humanoid", bones: specs } as RigPlan;
  const scene = new Scene();
  bones.forEach((b, i) => { b.name = specs[i].name; b.position.copy(specs[i].head); scene.add(b); });
  addWeaponSockets(plan, bones);
  addWeaponSockets(plan, bones);
  for (const [i, hand] of bones.entries()) {
    assert.equal(hand.children.length, 1, "idempotent");
    const socket = hand.children[0];
    assert.equal((socket as Bone).isBone, undefined);
    assert.deepEqual(socket.getWorldPosition(new Vector3()).toArray(), specs[i].head.clone().lerp(specs[i].tail, 0.5).toArray());
    const before = socket.getWorldPosition(new Vector3());
    hand.rotation.z = Math.PI / 2;
    assert.ok(before.distanceTo(socket.getWorldPosition(new Vector3())) > 0.1);
  }
  // JSON glTF uses the same node serialization as binary GLB without needing browser FileReader.
  const gltf = await new GLTFExporter().parseAsync(scene, { binary: false });
  assert.ok(!(gltf instanceof ArrayBuffer));
  const nodes = gltf.nodes as { name: string; children?: number[]; extras?: Record<string, string> }[];
  for (const side of ["Left", "Right"]) {
    const index = nodes.findIndex(n => n.name === `WeaponSocket${side}`);
    assert.ok(index >= 0);
    assert.ok(nodes.find(n => n.name === `${side}Hand`)?.children?.includes(index));
    assert.equal(nodes[index].extras?.attachmentType, "weapon");
  }
  const other = [new Bone(), new Bone()];
  addWeaponSockets({ ...plan, category: "quadruped" }, other);
  assert.ok(other.every(b => b.children.length === 0));
});
