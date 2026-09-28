import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import { BufferAttribute, BufferGeometry, Matrix4, Mesh } from "three";

export async function loadMeshes(file: string): Promise<Mesh[]> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(),
    "meshopt.decoder": MeshoptDecoder,
  });
  const doc = await io.read(file);
  const out: Mesh[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = new Matrix4().fromArray(node.getWorldMatrix());
    for (const p of mesh.listPrimitives()) {
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(p.getAttribute("POSITION")!.getArray()!), 3));
      const idx = p.getIndices();
      if (idx) g.setIndex(new BufferAttribute(new Uint32Array(idx.getArray()!), 1));
      const m = new Mesh(g);
      m.applyMatrix4(world);
      m.updateMatrixWorld(true);
      out.push(m);
    }
  }
  return out;
}
export const MODELS = "../data/outputs/models/DDI0uzwbCfhM6RBvmRWAKLwW83c2/";
