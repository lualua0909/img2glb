import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { AnimationMixer, BoxGeometry, Mesh, Vector3, type SkinnedMesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildModelData } from "../rig/model";
import { buildClips } from "../rig/clips";
import { DEFAULT_RIG_OPTIONS, guessMarkers, LONG_NECK_MARKERS, markerIds, planRig, type RigPlan } from "../rig/rig";
import { requiredClips, SPECIES } from "../rig/species";
import { markerLinks } from "../rig/marker-links";
import { rigConfigSchema } from "./config";
import { templateRigConfig, restoreTemplateRig } from "./template";
import { runRig } from "./runner";

function fixture(kind: "dragon" | "bird" | "longNeck") {
  const pieces: Mesh[] = [];
  const box = (size: number[], at: number[]) => {
    const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2], 4, 4, 4));
    mesh.position.set(at[0], at[1], at[2]);
    mesh.updateMatrixWorld(true);
    pieces.push(mesh);
  };
  box([1, 1, 2], [0, 1, 0]);
  box([0.5, kind === "longNeck" ? 2 : 0.6, 0.5], [0, kind === "longNeck" ? 2 : 1.5, 0.8]);
  box([0.7, 0.5, 0.8], [0, kind === "longNeck" ? 3 : 1.8, 1.1]);
  box([0.7, 0.2, 0.8], [0, kind === "longNeck" ? 2.6 : 1.4, 1.1]);
  box([0.25, 0.25, 1.5], [0, 1, -1.5]);
  for (const x of [-0.4, 0.4]) {
    for (const z of [-0.7, 0.7]) box([0.25, 0.8, 0.3], [x, 0.4, z]);
    if (kind !== "longNeck") box([1.7, 0.12, 0.8], [Math.sign(x) * 1.1, 1.55, 0]);
  }
  const model = buildModelData(pieces);
  const species = SPECIES.find(s => s.id === (kind === "dragon" ? "westernDragon" : kind === "longNeck" ? "sauropod" : "bird"))!;
  const category = kind === "bird" ? "bird" : "quadruped";
  const options = { ...DEFAULT_RIG_OPTIONS, ...species.options };
  const markers = guessMarkers(category, model, options);
  if (category === "quadruped") {
    markers.head.set(0, kind === "longNeck" ? 3 : 1.8, 1);
    markers.nose.set(0, kind === "longNeck" ? 3 : 1.8, 1.5);
    markers.shoulders.set(0, 1.35, 0.6);
    if (kind === "dragon") markers.jawTip.set(0, 1.4, 1.5);
  }
  return { model, markers, options, plan: planRig(category, model, markers, options), species: species.id };
}

test("preset bridge preserves dragon jaw/wings, bird wings and sauropod neck", () => {
  for (const kind of ["dragon", "bird", "longNeck"] as const) {
    const { plan, species } = fixture(kind);
    const config = templateRigConfig(plan, species);
    assert.equal(config.skeleton.length, plan.bones.length);
    assert.deepEqual(config.skeleton.map(b => b.head), plan.bones.map(b => b.head.toArray()));
    const names = new Set(config.skeleton.map(b => b.name));
    if (kind === "dragon") {
      assert.ok(names.has("Jaw"));
      assert.equal(config.skeleton.find(b => b.name === "Jaw")?.gate?.fade, 0);
    }
    if (kind !== "longNeck") for (const name of ["WingUpperL", "WingForeL", "WingHandL", "WingHandR"]) assert.ok(names.has(name));
    else assert.ok(names.has("Neck5"));
    assert.equal(rigConfigSchema.safeParse({ ...config, skeleton: [...config.skeleton, config.skeleton[0]] }).success, false);
    assert.equal(rigConfigSchema.safeParse({ ...config, skeleton: config.skeleton.map((b, i) => i ? b : { ...b, parent: "missing" }) }).success, false);
  }
});

test("sauropod has editable connected neck links, five tail links and usable required clips", () => {
  const { model, markers, options } = fixture("longNeck");
  for (const flip of [false, true]) {
    const guessed = guessMarkers("quadruped", model, { ...options, flip });
    for (const id of LONG_NECK_MARKERS) assert.ok(guessed[id].toArray().every(Number.isFinite));
    const config = templateRigConfig(planRig("quadruped", model, guessed, { ...options, flip }), "sauropod");
    assert.equal(config.species, "sauropod");
  }
  markers.neckMid.x += 0.17;
  const plan = planRig("quadruped", model, markers, options);
  const neck = plan.bones.filter(b => /^Neck\d*$/.test(b.name));
  assert.equal(neck.length, 5);
  assert.equal(plan.bones.filter(b => /^Tail\d+$/.test(b.name)).length, 5);
  assert.equal(plan.bones.find(b => b.name === "Head")?.parent, "Neck5");
  assert.deepEqual(neck[2].head, markers.neckMid);
  for (let i = 1; i < neck.length; i++) {
    assert.equal(neck[i].parent, neck[i - 1].name);
    assert.deepEqual(neck[i].head, neck[i - 1].tail);
  }
  const links = markerLinks("quadruped", markerIds("quadruped", options).ids);
  const chain = ["shoulders", ...LONG_NECK_MARKERS, "head"];
  for (let i = 1; i < chain.length; i++) assert.ok(links.some(([a, b]) => a === chain[i - 1] && b === chain[i]));
  const config = templateRigConfig(plan, "sauropod");
  assert.deepEqual(config.skeleton.find(b => b.name === "Neck3")?.head, markers.neckMid.toArray());
  const clips = buildClips(plan);
  for (const name of requiredClips(SPECIES.find(s => s.id === "sauropod")!)) assert.ok(clips.some(c => c.clip.name === name), name);
  const walk = clips.find(c => c.clip.name === "Walk")!.clip;
  for (const b of neck) {
    const track = walk.tracks.find(t => t.name === `${b.name}.quaternion`);
    assert.ok(track, `${b.name} is animated`);
    assert.ok(Array.from(track.values).every(Number.isFinite));
    assert.ok(Array.from(track.values).some((v, i, values) => i >= 4 && Math.abs(v - values[i % 4]) > 1e-6));
  }
  const legacy = planRig("quadruped", model, guessMarkers("quadruped", model, DEFAULT_RIG_OPTIONS), DEFAULT_RIG_OPTIONS);
  assert.ok(legacy.bones.filter(b => /^Neck\d*$/.test(b.name)).length <= 2);
});

test("all existing species presets serialize without losing their bone hierarchy", () => {
  const { model } = fixture("dragon");
  for (const species of SPECIES) {
    const options = { ...DEFAULT_RIG_OPTIONS, ...species.options };
    const markers = guessMarkers(species.category, model, options);
    const plan = planRig(species.category, model, markers, options);
    const config = templateRigConfig(plan, species.id);
    assert.equal(config.species, species.id);
    assert.equal(config.skeleton.length, plan.bones.length, species.id);
  }
});

async function writeFixture(file: string, model: ReturnType<typeof buildModelData>, flippedParent = false) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType("VEC3").setArray(new Float32Array(model.positions)).setBuffer(buffer);
  const indices = doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(model.index)).setBuffer(buffer);
  const primitive = doc.createPrimitive().setAttribute("POSITION", position).setIndices(indices);
  const mesh = doc.createMesh().addPrimitive(primitive);
  const node = doc.createNode().setMesh(mesh);
  if (flippedParent) {
    // Same world geometry, stored upside down beneath the inspector's 180-degree pivot.
    const positions = position.getArray()!;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = -positions[i];
      positions[i + 1] = 4 - positions[i + 1];
    }
    doc.createScene().addChild(doc.createNode("OrientationPivot").setRotation([0, 0, 1, 0]).setTranslation([0, 4, 0]).addChild(node));
  } else doc.createScene().addChild(node);
  await new NodeIO().write(file, doc);
}

test("Blender keeps a saved 180-degree parent flip through binding and preset restoration", { skip: !process.env.BLENDER_INTEGRATION, timeout: 180000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rigify-orientation-"));
  try {
    const { plan, model, species } = fixture("dragon");
    const input = path.join(dir, "flipped.glb");
    await writeFixture(input, model, true);
    await runRig(path.join(dir, "job"), input, { ...templateRigConfig(plan, species), weightFallback: "nearest" });
    const bytes = await readFile(path.join(dir, "job", "rigged.glb"));
    const loaded = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
    const restored = restoreTemplateRig(loaded.scene, plan);
    const expected = Array.from({ length: model.count }, (_, i) => new Vector3().fromArray(model.positions, i * 3));
    for (const group of [loaded.scene, restored.group]) {
      group.updateMatrixWorld(true);
      let checked = 0;
      group.traverse(o => {
        const mesh = o as SkinnedMesh;
        if (!mesh.isSkinnedMesh) return;
        mesh.skeleton.update();
        for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) {
          const p = mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld);
          assert.ok(expected.some(v => v.distanceTo(p) < 1e-4), `Rest vertex ${p.toArray()} lost the saved orientation`);
          checked++;
        }
      });
      assert.ok(checked >= model.count);
    }
    checkAnimation(restored.group, plan, "Fly", "WingUpperL");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Blender humanoid template keeps weapon nodes through raw export and browser restoration", { skip: !process.env.BLENDER_INTEGRATION, timeout: 180000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rigify-sockets-"));
  try {
    const { model } = fixture("dragon");
    const plan = planRig("humanoid", model, guessMarkers("humanoid", model, DEFAULT_RIG_OPTIONS), DEFAULT_RIG_OPTIONS);
    const input = path.join(dir, "input-fixture.glb");
    await writeFixture(input, model);
    await runRig(path.join(dir, "job"), input, { ...templateRigConfig(plan, null), weightFallback: "nearest" });
    const bytes = await readFile(path.join(dir, "job", "rigged.glb"));
    const loaded = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
    const restored = restoreTemplateRig(loaded.scene, plan);
    for (const side of ["Left", "Right"]) {
      const raw = loaded.scene.getObjectByName(`WeaponSocket${side}`);
      const socket = restored.group.getObjectByName(`WeaponSocket${side}`);
      assert.ok(raw && socket);
      assert.equal(raw.parent?.name, `DEF-${side}Hand`);
      assert.equal(socket.parent?.name, `${side}Hand`);
      assert.ok(raw.getWorldPosition(new Vector3()).distanceTo(socket.getWorldPosition(new Vector3())) < 1e-5);
      const before = socket.getWorldPosition(new Vector3());
      socket.parent!.rotation.z = 0.7;
      assert.ok(before.distanceTo(socket.getWorldPosition(new Vector3())) > 0.001);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function checkAnimation(group: ReturnType<typeof restoreTemplateRig>["group"], plan: RigPlan, clipName: string, boneName: string) {
  const clip = buildClips(plan).find(c => c.clip.name === clipName)?.clip.clone();
  assert.ok(clip, clipName);
  clip.tracks = clip.tracks.filter(track => track.name === `${boneName}.quaternion`);
  assert.ok(clip.tracks.length, `${clipName} drives ${boneName}`);
  const meshes: SkinnedMesh[] = [];
  group.traverse(o => { if ((o as SkinnedMesh).isSkinnedMesh) meshes.push(o as SkinnedMesh); });
  const positions = () => {
    group.updateMatrixWorld(true);
    return meshes.flatMap(mesh => {
      mesh.skeleton.update();
      return Array.from({ length: mesh.geometry.getAttribute("position").count }, (_, i) => mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
    });
  };
  const mixer = new AnimationMixer(group);
  mixer.clipAction(clip).play();
  mixer.setTime(0);
  const before = positions();
  let moved = 0;
  for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
    mixer.setTime(clip.duration * fraction);
    positions().forEach((p, i) => { assert.ok(p.toArray().every(Number.isFinite)); moved = Math.max(moved, p.distanceTo(before[i])); });
  }
  assert.ok(moved > 0.001, `${clipName} must deform the imported Blender mesh`);
  mixer.stopAllAction();
}

test("real Blender preserves preset bones, jaw mask and usable animation after export", { skip: !process.env.BLENDER_INTEGRATION, timeout: 180000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rigify-presets-"));
  try {
    for (const kind of ["dragon", "bird", "longNeck"] as const) {
      const { plan, model, species } = fixture(kind);
      const input = path.join(dir, `${kind}.glb`);
      await writeFixture(input, model);
      const job = path.join(dir, kind);
      await runRig(job, input, { ...templateRigConfig(plan, species), weightFallback: "nearest" });
      const bytes = await readFile(path.join(job, "rigged.glb"));
      const loaded = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
      const restored = restoreTemplateRig(loaded.scene, plan);
      assert.deepEqual(restored.bones.map(b => b.name), plan.bones.map(b => b.name));
      const jaw = plan.bones.findIndex(b => b.name === "Jaw");
      let jawWeighted = 0;
      restored.group.traverse(o => {
        const mesh = o as SkinnedMesh;
        if (!mesh.isSkinnedMesh) return;
        const weights = mesh.geometry.getAttribute("skinWeight");
        const indices = mesh.geometry.getAttribute("skinIndex");
        const points = mesh.geometry.getAttribute("position");
        for (let i = 0; i < weights.count; i++) {
          let sum = 0;
          for (let slot = 0; slot < 4; slot++) {
            const w = weights.getComponent(i, slot);
            sum += w;
            if (indices.getComponent(i, slot) === jaw && w > 0) {
              jawWeighted++;
              const gate = plan.bones[jaw].gate!;
              assert.ok(new Vector3().fromBufferAttribute(points, i).sub(gate.origin).dot(gate.dir) >= -1e-5, "jaw weights cannot cross into upper skull");
            }
          }
          assert.ok(Math.abs(sum - 1) < 0.001);
        }
      });
      if (kind === "dragon") assert.ok(jawWeighted > 0, "jaw has moving vertices");
      checkAnimation(restored.group, plan, kind === "dragon" ? "Attack_Bite" : kind === "bird" ? "Fly" : "Walk", kind === "dragon" ? "Jaw" : kind === "bird" ? "WingUpperL" : "Neck2");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
