import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NodeIO } from "@gltf-transform/core";
import { rigConfigSchema } from "./config";
import { blenderModel, blenderStatus, runBlender, runRig, startBlenderRig } from "./runner";

test("RigConfig defaults and rejects unsupported/unsafe settings", () => {
  assert.equal(rigConfigSchema.parse({}).preset, "humanoid");
  assert.equal(rigConfigSchema.parse({}).weightFallback, "error");
  for (const config of [{ preset: "quadruped" }, { widthScale: 0 }, { forward: "X" }, { executable: "bad" }, { bones: { spine: { head: [0, 0, 0], tail: [0, 1, Infinity] } } }])
    assert.equal(rigConfigSchema.safeParse(config).success, false);
});

test("Blender Rigify exports a weighted skin and editable blend; failures propagate", { skip: !process.env.BLENDER_INTEGRATION, timeout: 180000 }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "rigify-test-"));
  const previousRoot = process.env.BLENDER_RIG_DIR;
  process.env.BLENDER_RIG_DIR = path.join(folder, "jobs");
  try {
    const input = path.join(folder, "fixture.glb");
    // A connected, manifold humanoid from overlapping ellipsoids and voxel remesh.
    await runBlender(["--python-expr", `
import bpy
from mathutils import Vector
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
parts=[]
def ellipsoid(loc, scale):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=12, location=loc)
    o=bpy.context.object
    o.scale=scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    parts.append(o)
ellipsoid((0,0,1.3),(.23,.14,.37))
ellipsoid((0,0,1.79),(.14,.13,.19))
ellipsoid((0,0,1.6),(.08,.08,.18))
for s in [-1,1]:
    ellipsoid((s*.11,0,.57),(.1,.11,.55))
    ellipsoid((s*.11,-.055,.075),(.095,.16,.075))
    a=Vector((s*.18,0,1.57)); b=Vector((s*.70,.04,1.26))
    ellipsoid((a+b)*.5,(.085,.085,(b-a).length*.6))
    parts[-1].rotation_euler=(b-a).to_track_quat('Z','Y').to_euler()
bpy.ops.object.select_all(action='DESELECT')
for o in parts: o.select_set(True)
bpy.context.view_layer.objects.active=parts[0]
bpy.ops.object.join()
obj=bpy.context.object
obj.data.remesh_voxel_size=.035
bpy.ops.object.voxel_remesh()
bpy.ops.export_scene.gltf(filepath=${JSON.stringify(input)}, export_format='GLB')
`]);
    const jobId = await startBlenderRig(input, rigConfigSchema.parse({ weightFallback: "nearest" }), "fixture-user");
    assert.ok(jobId);
    assert.equal(await startBlenderRig(input, rigConfigSchema.parse({}), "fixture-user"), null);
    assert.equal((await blenderModel(jobId)).status, 409);
    const deadline = Date.now() + 60000;
    while (true) {
      const status = await blenderStatus(jobId);
      assert.ok(status, "status remains readable during atomic updates");
      assert.notEqual(status.status, "failed", status.error);
      if (status.status === "completed") break;
      assert.ok(Date.now() < deadline, "queue completes before deadline");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await blenderModel(jobId)).status, 200);
    const job = path.join(process.env.BLENDER_RIG_DIR, jobId);
    const glb = await readFile(path.join(job, "rigged.glb"));
    const jsonLength = glb.readUInt32LE(12);
    const doc = JSON.parse(glb.toString("utf8", 20, 20 + jsonLength));
    assert.ok(doc.skins?.[0].joints.length > 20, "deform skeleton exists");
    for (const [side, suffix] of [["Left", "L"], ["Right", "R"]]) {
      const index = doc.nodes.findIndex((n: { name: string }) => n.name === `WeaponSocket${side}`);
      assert.ok(index >= 0, `export retains ${side} socket`);
      assert.equal(doc.nodes[index].extras.attachmentType, "weapon");
      assert.ok(doc.nodes.find((n: { name: string }) => n.name === `DEF-hand.${suffix}`).children.includes(index));
      assert.ok(!doc.skins[0].joints.includes(index), "socket does not alter skin");
    }
    assert.ok(doc.meshes.some((m: { primitives: { attributes: Record<string, number> }[] }) => m.primitives.some(p => p.attributes.WEIGHTS_0 !== undefined && p.attributes.JOINTS_0 !== undefined)));
    assert.ok((await readFile(path.join(job, "rig.blend"))).length > 1000);
    const document = await new NodeIO().read(path.join(job, "rigged.glb"));
    for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      const weights = primitive.getAttribute("WEIGHTS_0");
      assert.ok(weights);
      for (let i = 0; i < weights.getCount(); i++) {
        const values = weights.getElement(i, []);
        assert.ok(values.every(v => Number.isFinite(v) && v >= 0));
        assert.ok(Math.abs(values.reduce((a, b) => a + b, 0) - 1) < 0.001);
      }
    }
    // Round-trip into Blender and verify the exported skin actually deforms.
    await runBlender(["--python-expr", `
import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=${JSON.stringify(path.join(job, "rigged.glb"))})
rig=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
mesh=next(o for o in bpy.context.scene.objects if o.type=='MESH')
def positions():
    graph=bpy.context.evaluated_depsgraph_get()
    obj=mesh.evaluated_get(graph)
    return [obj.matrix_world @ v.co for v in obj.data.vertices]
before=positions()
bone=next(b for b in rig.pose.bones if 'upper_arm.L' in b.name)
bone.rotation_mode='XYZ'
bone.rotation_euler.y=0.7
bpy.context.view_layer.update()
after=positions()
assert max((a-b).length for a,b in zip(before,after)) > 0.001, 'Skin did not deform'
`]);
    await assert.rejects(runRig(path.join(folder, "invalid"), input, rigConfigSchema.parse({ bones: { unknown: { head: [0, 0, 0], tail: [0, 1, 0] } } })), /Unknown metarig bone/);
    await assert.rejects(runBlender(["--python-expr", "import time; time.sleep(10)"], undefined, 200), /timed out/);
  } finally {
    if (previousRoot === undefined) delete process.env.BLENDER_RIG_DIR;
    else process.env.BLENDER_RIG_DIR = previousRoot;
    await rm(folder, { recursive: true, force: true });
  }
});
