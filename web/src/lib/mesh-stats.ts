import type { InstancedMesh, Mesh } from "three";

/** Counts model geometry, independently of lighting, wireframe overlays and render passes. */
export function countMeshGeometry(meshes: readonly Mesh[]) {
  let vertices = 0;
  let bufferVertices = 0;
  let triangles = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    if (!position) continue;
    const instances = (mesh as InstancedMesh).isInstancedMesh ? (mesh as InstancedMesh).count : 1;
    const index = geometry.getIndex();
    const available = index?.count ?? position.count;
    const start = Math.max(0, Math.floor(geometry.drawRange.start));
    const end = Math.min(available, start + geometry.drawRange.count);
    const triangleCount = Math.max(0, Math.floor((end - start) / 3));
    // Exact local positions: collapse UV/normal splits without merging nearby detail
    // or overlapping but separate mesh objects. This is a geometric position count,
    // not a reconstruction of the source application's topological vertex IDs.
    const positions = new Set<string>();
    const referenced = new Set<number>();
    for (let i = start; i < start + triangleCount * 3; i++) {
      const vertex = index ? index.getX(i) : i;
      referenced.add(vertex);
      positions.add(`${position.getX(vertex)},${position.getY(vertex)},${position.getZ(vertex)}`);
    }
    vertices += positions.size * instances;
    bufferVertices += referenced.size * instances;
    triangles += triangleCount * instances;
  }
  return { vertices, bufferVertices, triangles };
}
