import assert from "node:assert/strict";
import test from "node:test";
import { MeshStandardMaterial, Texture } from "three";
import { applyEmission, colorMatches, DEFAULT_EMISSION, readEmission } from "./settings";

test("emission is opt-in and turning it off preserves the map and PBR material", () => {
  const material = new MeshStandardMaterial({ metalness: 0.7, roughness: 0.3 });
  const map = new Texture();
  material.map = new Texture();
  const base = material.map;
  assert.deepEqual(readEmission(material), DEFAULT_EMISSION);
  material.emissiveMap = map;
  applyEmission(material, { enabled: true, color: "#22ff88", intensity: 5 });
  applyEmission(material, { ...readEmission(material), enabled: false });
  assert.equal(material.emissiveIntensity, 0);
  assert.equal(material.emissiveMap, map);
  assert.equal(material.map, base);
  assert.equal(material.metalness, 0.7);
  assert.equal(material.roughness, 0.3);
  assert.equal(readEmission(material).intensity, 5);
  applyEmission(material, { ...readEmission(material), enabled: true });
  assert.equal(material.emissiveIntensity, 5);
});

test("existing imported emission is recognized without metadata", () => {
  const material = new MeshStandardMaterial({ emissive: "#00ff88", emissiveIntensity: 4 });
  assert.deepEqual(readEmission(material), { enabled: true, color: "#00ff88", intensity: 4 });
});

test("color selection rejects other hues and supports a tolerance", () => {
  assert.equal(colorMatches(70, 255, 150, [65, 250, 145], 0.03), true);
  assert.equal(colorMatches(255, 60, 40, [65, 250, 145], 0.2), false);
  assert.equal(colorMatches(0, 0, 0, [0, 0, 0], 0), true);
});
