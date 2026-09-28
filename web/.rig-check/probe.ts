import { loadMeshes } from "./load";
import { buildModelData } from "../src/lib/rig/model";
const M = "../data/outputs/models/DDI0uzwbCfhM6RBvmRWAKLwW83c2/";
for (const id of process.argv.slice(2)) {
  const meshes = await loadMeshes(M + id + ".glb");
  const m = buildModelData(meshes);
  console.log(id, meshes.length, m.count, m.index.length / 3, m.size.toArray().map((x) => x.toFixed(3)), m.center.toArray().map((x) => x.toFixed(3)));
}
