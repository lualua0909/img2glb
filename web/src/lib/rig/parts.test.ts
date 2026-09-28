import assert from "node:assert/strict";
import test from "node:test";
import { BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute, Vector3 } from "three";
import { splitWeightedParts } from "./parts";

function area(g: BufferGeometry) {
  const p = g.getAttribute("position");
  let sum = 0;
  for (let i = 0; i < p.count; i += 3) {
    const a = new Vector3().fromBufferAttribute(p, i);
    const b = new Vector3().fromBufferAttribute(p, i + 1);
    const c = new Vector3().fromBufferAttribute(p, i + 2);
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}
function triangle(weights: number[][]) {
  return new BufferGeometry().setAttribute("position", new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    .setAttribute("skinIndex", new Uint16BufferAttribute([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3], 4))
    .setAttribute("skinWeight", new Float32BufferAttribute(weights.flat(), 4));
}

test("parts cut inside triangles at equal weights, preserving area and source geometry", () => {
  const input = triangle([[1, 0, 0, 0], [0, 1, 0, 0], [1, 0, 0, 0]]);
  const before = Array.from(input.getAttribute("position").array);
  const parts = splitWeightedParts(input);
  assert.equal(parts.size, 2);
  assert.ok(Math.abs([...parts.values()].reduce((sum, g) => sum + area(g), 0) - 0.5) < 1e-7);
  for (const [bone, g] of parts) {
    const p = g.getAttribute("position");
    let boundary = 0;
    for (let i = 0; i < p.count; i++) {
      assert.ok(bone === 0 ? p.getX(i) <= 0.5 : p.getX(i) >= 0.5);
      if (p.getX(i) === 0.5) boundary++;
    }
    assert.ok(boundary >= 2, "boundary crosses triangle interior, not its original zigzag edges");
  }
  assert.deepEqual(Array.from(input.getAttribute("position").array), before);
  assert.ok(input.getAttribute("skinWeight"));
});

test("three-way junctions partition without holes and ties do not duplicate faces", () => {
  const triple = splitWeightedParts(triangle([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]));
  assert.equal(triple.size, 3);
  assert.ok(Math.abs([...triple.values()].reduce((sum, g) => sum + area(g), 0) - 0.5) < 1e-7);
  const ties = splitWeightedParts(triangle(Array.from({ length: 3 }, () => [0.5, 0.5, 0, 0])));
  assert.equal(ties.size, 1);
  assert.equal(area(ties.get(0)!), 0.5);
});
