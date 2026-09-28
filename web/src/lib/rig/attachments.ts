import { Object3D, type Bone } from "three";
import type { RigPlan } from "./rig";

/** Empty glTF nodes, not deform joints. Local axes match model axes at rest. */
export function addWeaponSockets(plan: RigPlan, bones: Bone[]) {
  if (plan.category !== "humanoid") return;
  for (const side of ["Left", "Right"] as const) {
    const index = plan.bones.findIndex(b => b.name === `${side}Hand`);
    if (index < 0) continue;
    const hand = bones[index];
    const name = `WeaponSocket${side}`;
    if (hand.children.some(child => child.name === name)) continue;
    const spec = plan.bones[index];
    const socket = new Object3D();
    socket.name = name;
    socket.position.copy(spec.tail).sub(spec.head).multiplyScalar(0.5);
    socket.userData = { attachmentType: "weapon", side: side.toLowerCase() };
    hand.add(socket);
  }
}
