import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, InstancedMesh, Mesh, MeshBasicMaterial } from "three";
import { countMeshGeometry } from "./mesh-stats";

test("indexed and expanded cubes have 8 positions and 12 triangles despite normal/UV splits", () => {
  const cube = new BoxGeometry();
  assert.deepEqual(countMeshGeometry([new Mesh(cube)]), { vertices: 8, bufferVertices: 24, triangles: 12 });
  assert.deepEqual(countMeshGeometry([new Mesh(cube.toNonIndexed())]), { vertices: 8, bufferVertices: 36, triangles: 12 });
});

test("separate meshes and instances are counted independently", () => {
  const cube = new BoxGeometry();
  assert.equal(countMeshGeometry([new Mesh(cube), new Mesh(cube)]).vertices, 16);
  assert.deepEqual(countMeshGeometry([new InstancedMesh(cube, new MeshBasicMaterial(), 3)]), {
    vertices: 24, bufferVertices: 72, triangles: 36,
  });
});

test("only complete triangles in the draw range and their referenced vertices count", () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 1,1,0, 9,9,9], 3));
  geometry.setIndex([0,1,2, 1,3,2, 4]);
  assert.deepEqual(countMeshGeometry([new Mesh(geometry)]), { vertices: 4, bufferVertices: 4, triangles: 2 });
  geometry.setDrawRange(3, 3);
  assert.deepEqual(countMeshGeometry([new Mesh(geometry)]), { vertices: 3, bufferVertices: 3, triangles: 1 });
});

test("nearby distinct positions are not welded by a tolerance", () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([0,0,0, 0.000001,0,0, 0,1,0], 3));
  assert.equal(countMeshGeometry([new Mesh(geometry)]).vertices, 3);
});
