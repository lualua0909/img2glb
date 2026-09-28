import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { BoxGeometry, Mesh, Vector3, type SkinnedMesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildModelData } from "../rig/model";
import { DEFAULT_RIG_OPTIONS, planRig, type Markers } from "../rig/rig";
import { templateRigConfig, restoreTemplateRig } from "./template";
import { needsSurfaceBinding, surfaceBinding } from "./surface";
import { runRig } from "./runner";

async function fixture(file: string, flip: boolean) {
  const meshes: Mesh[] = [];
  const box = (x: number, y: number, z: number, w: number, h: number, d: number) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d, 4, 4, 4));
    mesh.position.set(x, y, z);
    mesh.updateMatrixWorld(true);
    meshes.push(mesh);
  };
  box(0, 1.1, 0, 0.4, 0.8, 0.3);
  // Broad hair overlaps the wings in front view, but is a separate depth layer.
  box(0, 1.8, 0, 0.72, 0.4, 0.3);
  const markers: Markers = { chin: new Vector3(0, 1.6, 0), groin: new Vector3(0, 0.8, 0) };
  for (const [side, sign] of [["L", 1], ["R", -1]] as const) {
    box(sign * 0.12, 0.4, 0, 0.17, 0.8, 0.2);
    box(sign * 0.36, 1.15, 0.04, 0.15, 0.6, 0.15);
    box(sign * 0.8, 1.85, -0.3, 1.1, 1.1, 0.08);
    for (const [id, v] of Object.entries({
      shoulder: [sign * 0.25, 1.45, 0], elbow: [sign * 0.36, 1.2, 0.04], wrist: [sign * 0.36, 0.9, 0.04],
      knee: [sign * 0.12, 0.4, 0], ankle: [sign * 0.12, 0.08, 0],
      wingRoot: [sign * 0.25, 1.45, -0.3], wingElbow: [sign * 0.55, 1.75, -0.3],
      wingWrist: [sign * 0.9, 2, -0.3], wingTip: [sign * 1.3, 2.35, -0.3],
    })) markers[id + side] = new Vector3(v[0], v[1], v[2]);
  }
  const model = buildModelData(meshes);
  const plan = planRig("humanoid", model, markers, { ...DEFAULT_RIG_OPTIONS, wings: true });
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = model.positions.slice();
  if (flip) for (let i = 0; i < positions.length; i += 3) {
    positions[i] = -positions[i];
    positions[i + 1] = 4 - positions[i + 1];
  }
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setBuffer(buffer).setType("VEC3").setArray(positions))
    .setIndices(document.createAccessor().setBuffer(buffer).setType("SCALAR").setArray(new Uint32Array(model.index)));
  const node = document.createNode().setMesh(document.createMesh().addPrimitive(primitive));
  const scene = document.createScene();
  scene.addChild(flip ? document.createNode().setRotation([0, 0, 1, 0]).setTranslation([0, 4, 0]).addChild(node) : node);
  await new NodeIO().write(file, document);
  return { plan, config: templateRigConfig(plan, null) };
}

for (const flip of [false, true]) test(`surface binding isolates hair/arms from wings with parent correction=${flip}`, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "wing-surface-"));
  try {
    const input = path.join(folder, "input.glb");
    const { config } = await fixture(input, flip);
    assert.equal(needsSurfaceBinding(config), true);
    assert.equal(needsSurfaceBinding({ ...config, category: "bird" }), false);
    const skin = await surfaceBinding(input, config);
    let body = 0, wings = 0;
    for (let i = 0; i < skin.positions.length / 3; i++) {
      let sum = 0, wing = 0;
      for (let j = 0; j < 4; j++) {
        const w = skin.weight[i * 4 + j];
        assert.ok(Number.isFinite(w) && w >= 0);
        sum += w;
        if (skin.bones[skin.index[i * 4 + j]].startsWith("DEF-Wing")) wing += w;
      }
      assert.ok(Math.abs(sum - 1) < 1e-5);
      if (skin.positions[i * 3 + 2] > -0.2) {
        body++;
        assert.equal(wing, 0, "hair and human body must not flap");
      } else if (Math.abs(skin.positions[i * 3]) > 0.6) {
        wings++;
        assert.ok(wing > 0.99, "outer feathers must follow the wing");
      }
    }
    assert.ok(body > 0 && wings > 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Blender surface binding keeps hair stationary when wings rotate after GLB restoration", {
  skip: !process.env.BLENDER_INTEGRATION, timeout: 180000,
}, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "wing-blender-surface-"));
  try {
    const input = path.join(folder, "source.glb");
    const { plan, config } = await fixture(input, true);
    const job = path.join(folder, "job");
    await runRig(job, input, config);
    const report = JSON.parse(await readFile(path.join(job, "report.json"), "utf8"));
    assert.equal(report.weightMethod, "surface");
    assert.deepEqual(report.warnings, []);
    const bytes = await readFile(path.join(job, "rigged.glb"));
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
    const { group } = restoreTemplateRig(gltf.scene, plan);
    const meshes: SkinnedMesh[] = [];
    group.traverse(o => { if ((o as SkinnedMesh).isSkinnedMesh) meshes.push(o as SkinnedMesh); });
    const positions = () => {
      group.updateMatrixWorld(true);
      return meshes.flatMap(mesh => {
        mesh.skeleton.update();
        return Array.from({ length: mesh.geometry.getAttribute("position").count }, (_, i) => mesh.getVertexPosition(i, new Vector3()));
      });
    };
    const before = positions();
    group.getObjectByName("WingUpperL")!.rotation.z = -0.8;
    group.getObjectByName("WingUpperR")!.rotation.z = 0.8;
    const after = positions();
    let body = 0, wings = 0;
    before.forEach((p, i) => {
      if (p.z > -0.2) { body++; assert.ok(p.distanceTo(after[i]) < 1e-5); }
      else if (Math.abs(p.x) > 0.6) { wings++; assert.ok(p.distanceTo(after[i]) > 0.1); }
    });
    assert.ok(body > 0 && wings > 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
