import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { BufferAttribute, BufferGeometry, Matrix4, Mesh, Vector3 } from "three";
import { buildModelData } from "../rig/model";
import { computeSkin } from "../rig/skin";
import type { RigPlan } from "../rig/rig";
import type { RigConfig, TemplateRigConfig } from "./config";

export function needsSurfaceBinding(config: RigConfig): config is TemplateRigConfig {
  return config.preset === "template" && config.category === "humanoid" &&
    ["WingUpperL", "WingUpperR"].every(name => config.skeleton.some(b => b.name === name));
}

/** Use the same surface connectivity and limb isolation as the browser for overlapping human/wing layers. */
export async function surfaceBinding(input: string, config: TemplateRigConfig) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(input);
  if (document.getRoot().listSkins().length) throw new Error("Input is already rigged; use the original unrigged model");
  const meshes: Mesh[] = [];
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  let count = 0;
  scene?.traverse(node => {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const position = primitive.getAttribute("POSITION");
      if (!position) continue;
      if (primitive.getMode() !== 4) throw new Error("Surface binding requires triangle meshes");
      count += position.getCount();
      if (count > 500000) throw new Error("Mesh exceeds 500000 vertices; simplify it first");
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(new Float32Array(position.getArray()!), 3));
      const indices = primitive.getIndices();
      if (indices) geometry.setIndex(new BufferAttribute(new Uint32Array(indices.getArray()!), 1));
      const mesh = new Mesh(geometry);
      mesh.matrixWorld.copy(new Matrix4().fromArray(node.getWorldMatrix()));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(mesh.matrixWorld);
      meshes.push(mesh);
    }
  });
  if (!count) throw new Error("Input contains no mesh");
  const model = buildModelData(meshes);
  try {
    const bones = config.skeleton.map(b => ({
      ...b, head: new Vector3(...b.head), tail: new Vector3(...b.tail),
      gate: b.gate ? { ...b.gate, origin: new Vector3(...b.gate.origin), dir: new Vector3(...b.gate.dir),
        planes: b.gate.planes?.map(p => ({ origin: new Vector3(...p.origin), dir: new Vector3(...p.dir) })),
      } : undefined,
    }));
    const plan: RigPlan = {
      category: config.category, bones, skin: { mode: "heat" },
      frame: { forward: new Vector3(0, 0, 1), lateral: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0) },
      height: model.size.y, length: model.size.z, wheelRadius: {},
    };
    const skin = await computeSkin(model, plan);
    return {
      bones: bones.map(b => `DEF-${b.name}`), tolerance: Math.max(model.size.length(), 1e-6) * 2e-5,
      positions: Array.from(model.positions), index: Array.from(skin.index), weight: Array.from(skin.weight),
    };
  } finally {
    model.bvh.geometry.dispose();
    for (const mesh of meshes) mesh.geometry.dispose();
  }
}
