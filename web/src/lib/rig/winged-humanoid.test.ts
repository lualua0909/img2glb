import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimationMixer, Bone, BoxGeometry, Group, LoopOnce, Mesh, Quaternion, Vector3 } from "three";
import { buildModelData, midDepth, nearestDepth } from "./model";
import { buildClips } from "./clips";
import { DEFAULT_RIG_OPTIONS, guessMarkers, markerIds, planRig, syncMirror, type Markers } from "./rig";
import { computeSkin } from "./skin";

function fixture(flip = false, curved = false) {
  const depth = flip ? -1 : 1;
  const box = (x: number, y: number, z: number, w: number, h: number, d: number) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d, 3, 3, 2));
    if (curved && w > 1) {
      const positions = mesh.geometry.getAttribute("position");
      // A feather fan bows forward of the root plane, as real generated wings do.
      for (let i = 0; i < positions.count; i++) {
        const outward = Math.abs(positions.getX(i) + x);
        positions.setZ(i, positions.getZ(i) + depth * 0.45 * Math.max(0, (outward - 0.25) / 1.1));
      }
    }
    mesh.position.set(x, y, z * depth);
    mesh.updateMatrixWorld();
    return mesh;
  };
  const meshes = [box(0, 1.1, 0, 0.4, 0.8, 0.3), box(0, 1.75, 0, 0.3, 0.4, 0.3)];
  for (const sign of [1, -1]) meshes.push(
    box(sign * 0.12, 0.4, 0, 0.17, 0.8, 0.2),
    box(sign * 0.36, 1.15, 0.04, 0.15, 0.6, 0.15),
    box(sign * 0.8, 1.85, -0.3, 1.1, 1.1, 0.08),
  );
  const model = buildModelData(meshes);
  const options = { ...DEFAULT_RIG_OPTIONS, wings: true, flip };
  const p = (x: number, y: number, z = 0) => new Vector3(x * depth, y, z * depth);
  const markers: Markers = { chin: p(0, 1.55), groin: p(0, 0.8) };
  for (const [side, sign] of [["L", 1], ["R", -1]] as const) {
    markers[`shoulder${side}`] = p(sign * 0.25, 1.45);
    markers[`elbow${side}`] = p(sign * 0.36, 1.2, 0.04);
    markers[`wrist${side}`] = p(sign * 0.36, 0.9, 0.04);
    markers[`knee${side}`] = p(sign * 0.12, 0.4);
    markers[`ankle${side}`] = p(sign * 0.12, 0.08);
    markers[`wingRoot${side}`] = p(sign * 0.25, 1.45, -0.3);
    markers[`wingElbow${side}`] = p(sign * 0.55, 1.75, -0.3);
    markers[`wingWrist${side}`] = p(sign * 0.9, 2, -0.3);
    markers[`wingTip${side}`] = p(sign * 1.3, 2.35, -0.3);
  }
  return { model, options, markers };
}

for (const flip of [false, true]) test(`winged humanoid hierarchy, clips and skin (flip=${flip})`, async () => {
  const { model, options, markers } = fixture(flip);
  const plan = planRig("humanoid", model, markers, options);
  assert.equal(plan.bones.filter((b) => b.name.startsWith("Wing")).length, 6);
  assert.equal(plan.bones.find((b) => b.name === "WingUpperL")!.parent, "Chest");
  assert.ok(plan.bones.find((b) => b.name === "Head")!.tail.y < 2);
  const clips = buildClips(plan);
  for (const name of ["Fly", "Glide", "Wings_Fold", "Wings_Spread"])
    assert.ok(clips.some((c) => c.clip.name === name));
  for (const { clip } of clips) for (const track of clip.tracks)
    assert.ok(Array.from(track.values).every(Number.isFinite));
  const skin = await computeSkin(model, plan);
  let wingVertices = 0;
  for (let i = 0; i < model.count; i++) {
    let sum = 0;
    for (let j = 0; j < 4; j++) {
      const w = skin.weight[i * 4 + j];
      sum += w;
      if (plan.bones[skin.index[i * 4 + j]].name.startsWith("Wing") && w > 0) {
        wingVertices++;
        assert.ok(model.positions[i * 3 + 2] * (flip ? -1 : 1) < -0.2);
      }
    }
    assert.ok(Math.abs(sum - 1) < 1e-5);
  }
  assert.ok(wingVertices > 0);
});

test("wing markers can be mirrored or edited independently; disabling wings removes flight", () => {
  const { model, options, markers } = fixture();
  const guessed = guessMarkers("humanoid", model, options);
  for (const id of markerIds("humanoid", options).ids) assert.ok(guessed[id]?.toArray().every(Number.isFinite), id);
  assert.ok(guessed.chin.y < 1.95);
  markers.wingTipL.x = 1.5;
  assert.equal(syncMirror("humanoid", model, markers, options).wingTipR.x, -1.5);
  assert.equal(markerIds("humanoid", { ...options, symmetry: false }).derived.size, 0);
  const plain = { ...options, wings: false };
  assert.ok(!markerIds("humanoid", plain).ids.some((id) => id.startsWith("wing")));
  const plan = planRig("humanoid", model, markers, plain);
  assert.ok(!plan.bones.some((b) => b.name.startsWith("Wing")));
  assert.ok(!buildClips(plan).some((c) => c.clip.name === "Fly"));
});


for (const flip of [false, true]) for (const folded of [false, true])
  test(`flight directions and seamless loop (flip=${flip}, folded=${folded})`, () => {
    const { model, options, markers } = fixture(flip);
    if (folded) for (const side of ["L", "R"]) {
      const root = markers[`wingRoot${side}`];
      const forward = flip ? -1 : 1;
      markers[`wingElbow${side}`] = root.clone().add(new Vector3(0, -0.2, -0.3 * forward));
      markers[`wingWrist${side}`] = root.clone().add(new Vector3(0, 0.1, -0.5 * forward));
      markers[`wingTip${side}`] = root.clone().add(new Vector3(0, -0.4, -0.7 * forward));
    }
    const plan = planRig("humanoid", model, markers, options);
    const clips = buildClips(plan);
    for (const name of ["Fly", "Glide"]) {
      const clip = clips.find((c) => c.clip.name === name)!.clip;
      const group = new Group();
      const bones = new Map<string, Bone>();
      for (const spec of plan.bones) {
        const bone = new Bone();
        bone.name = spec.name;
        bone.position.copy(spec.head);
        if (spec.parent) bone.position.sub(plan.bones.find((b) => b.name === spec.parent)!.head);
        (spec.parent ? bones.get(spec.parent)! : group).add(bone);
        bones.set(spec.name, bone);
      }
      const mixer = new AnimationMixer(group);
      const action = mixer.clipAction(clip);
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      const direction = (name: string) => {
        const spec = plan.bones.find((b) => b.name === name)!;
        return spec.tail.clone().sub(spec.head).normalize()
          .applyQuaternion(bones.get(name)!.getWorldQuaternion(new Quaternion()));
      };
      const raised: number[] = [];
      for (const fraction of [0.25, 0.75]) {
        mixer.setTime(clip.duration * fraction);
        group.updateMatrixWorld(true);
        for (const part of ["Upper", "Fore", "Hand"]) {
          const left = direction(`Wing${part}L`);
          const right = direction(`Wing${part}R`);
          assert.ok(left.dot(plan.frame.lateral) > 0.65, "left wing stays outward");
          assert.ok(right.dot(plan.frame.lateral) < -0.65, "right wing stays outward");
          assert.ok(Math.abs(left.y - right.y) < 1e-5, "both wings flap together");
          assert.ok(left.dot(plan.frame.forward) < 0, "wings sweep behind the body");
          if (name === "Glide") assert.ok(Math.abs(left.y) < 0.2, "glide stays nearly level");
        }
        raised.push(direction("WingUpperL").y);
        assert.ok(direction("LeftUpperArm").y < -0.85, "arms hang naturally");
        assert.ok(direction("LeftLowerLeg").dot(plan.frame.forward) < -0.2, "knees tuck feet backward");
      }
      if (name === "Fly") assert.ok(raised[0] > 0.5 && raised[1] < -0.4, "upstroke and downstroke");
      for (const track of clip.tracks) {
        const size = track.getValueSize();
        for (let i = 0; i < size; i++) assert.ok(
          Math.abs(track.values[i] - track.values[track.values.length - size + i]) < 1e-5,
          `${track.name} loops without a jump`,
        );
      }
      mixer.stopAllAction();
      mixer.uncacheRoot(group);
    }
  });


for (const flip of [false, true]) test(`curved feather fan stays on wing across root depth plane (flip=${flip})`, async () => {
  const { model, options, markers } = fixture(flip, true);
  const plan = planRig("humanoid", model, markers, options);
  const skin = await computeSkin(model, plan);
  let checked = 0;
  for (let i = 0; i < model.count; i++) {
    if (Math.abs(model.positions[i * 3]) < 0.6) continue;
    checked++;
    let wingWeight = 0;
    for (let j = 0; j < 4; j++) if (plan.bones[skin.index[i * 4 + j]].name.startsWith("Wing"))
      wingWeight += skin.weight[i * 4 + j];
    assert.ok(wingWeight > 0.99, `feather ${i} must not stay pinned to body: ${wingWeight}`);
  }
  assert.ok(checked > 0);
});

test("dragging a wing marker behind an arm preserves the back layer", () => {
  const arm = new Mesh(new BoxGeometry(0.2, 0.5, 0.2));
  const wing = new Mesh(new BoxGeometry(1, 1, 0.08));
  wing.position.z = -0.3;
  wing.updateMatrixWorld();
  const model = buildModelData([arm, wing]);
  const point = new Vector3(0, 0, -0.3);
  assert.ok(Math.abs(midDepth(model, point, new Vector3(0, 0, 1)).z) < 0.01);
  assert.ok(Math.abs(nearestDepth(model, point, new Vector3(0, 0, 1)).z + 0.3) < 0.01);
});
