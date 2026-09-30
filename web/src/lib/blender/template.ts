import { Bone, Matrix4, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, type Object3D } from "three";
import type { RigPlan } from "../rig/rig";
import { addWeaponSockets } from "../rig/attachments";
import { rigConfigSchema, type TemplateRigConfig } from "./config";

/** Preset placement remains the single source of truth; Blender handles controls and binding. */
export function templateRigConfig(plan: RigPlan, species: string | null): TemplateRigConfig {
  return rigConfigSchema.parse({
    preset: "template", category: plan.category, species,
    skeleton: plan.bones.map(b => ({
      name: b.name, parent: b.parent, head: b.head.toArray(), tail: b.tail.toArray(), deform: b.deform,
      ...(b.rigid ? { rigid: true } : {}),
      ...(b.crisp ? { crisp: true } : {}),
      ...(b.reach ? { reach: { center: b.reach.center.toArray(), radius: b.reach.radius,
        ...(b.reach.plane ? { plane: { origin: b.reach.plane.origin.toArray(), dir: b.reach.plane.dir.toArray() } } : {}) } } : {}),
      ...(b.cap ? { cap: { origin: b.cap.origin.toArray(), dir: b.cap.dir.toArray() } } : {}),
      ...(b.gate ? { gate: { origin: b.gate.origin.toArray(), dir: b.gate.dir.toArray(), ...(b.gate.fade !== undefined ? { fade: b.gate.fade } : {}),
        ...(b.gate.planes ? { planes: b.gate.planes.map(p => ({ origin: p.origin.toArray(), dir: p.dir.toArray() })) } : {}),
      } } : {}),
    })),
  }) as TemplateRigConfig;
}

/** Preserve Blender weights, but restore the preset's identity rest rotations for existing animation clips. */
export function restoreTemplateRig(loaded: Object3D, plan: RigPlan) {
  const group = new Scene();
  group.name = "Model";
  group.userData = { ...loaded.userData, rigProvider: "blender-rigify-template" };
  loaded.traverse(o => {
    if (o.userData.rig_config) group.userData.rig_config = o.userData.rig_config;
    if (o.userData.rigify_warnings) group.userData.rigify_warnings = o.userData.rigify_warnings;
  });
  const bones = plan.bones.map(b => Object.assign(new Bone(), { name: b.name }));
  const index = new Map(plan.bones.map((b, i) => [b.name, i]));
  plan.bones.forEach((b, i) => {
    const parent = b.parent === null ? undefined : index.get(b.parent);
    bones[i].position.copy(parent === undefined ? b.head : b.head.clone().sub(plan.bones[parent].head));
    (parent === undefined ? group : bones[parent]).add(bones[i]);
  });
  addWeaponSockets(plan, bones);
  group.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);
  loaded.updateMatrixWorld(true);
  let count = 0;
  loaded.traverse(o => {
    const source = o as SkinnedMesh;
    if (!source.isSkinnedMesh) return;
    const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld);
    const original = geometry.getAttribute("skinIndex");
    const weights = geometry.getAttribute("skinWeight");
    const mapped = new Uint16Array(original.count * 4);
    for (let v = 0; v < original.count; v++) for (let slot = 0; slot < 4; slot++) {
      if (weights.getComponent(v, slot) <= 0) continue;
      const bone = source.skeleton.bones[original.getComponent(v, slot)];
      const target = index.get(bone?.name.replace(/^DEF-/, ""));
      if (target === undefined) throw new Error(`Blender returned an unknown weighted bone: ${bone?.name}`);
      mapped[v * 4 + slot] = target;
    }
    geometry.setAttribute("skinIndex", new Uint16BufferAttribute(mapped, 4));
    const mesh = new SkinnedMesh(geometry, source.material);
    mesh.name = source.name;
    mesh.userData = { ...source.userData };
    group.add(mesh);
    mesh.bind(skeleton, new Matrix4());
    count++;
  });
  if (!count) throw new Error("Blender returned no skinned meshes");
  return { group, bones };
}
