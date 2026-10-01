import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimationMixer, Bone, BufferGeometry, Float32BufferAttribute, Group, Line3, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { buildClips } from "./clips";
import { buildModelData } from "./model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, markerView, planRig, type RigPlan } from "./rig";
import { SPECIES } from "./species";

// An Asian dragon standing like the reference art, facing -X: S-shaped neck, long body and tail, four legs, horns and
// a pair of long whiskers that hug the jaw, then stream back above the neck. Points are [x, y] in image pixels (y down)
// with a depth and a radius; one welded marching-cubes surface, as an image-to-3D mesh would be.
type P = [x: number, y: number, z: number, r: number];
const at = (p: P) => new Vector3((p[0] - 650) / 250, (450 - p[1]) / 250, p[2] / 250);
const SPINE: P[] = [
  [105, 168, 0, 10],
  [150, 160, 0, 22],
  [195, 150, 0, 30],
  [235, 170, 0, 20],
  [250, 215, 0, 22],
  [265, 265, 0, 28],
  [300, 300, 0, 36],
  [380, 300, 0, 36],
  [460, 295, 0, 34],
  [540, 320, 0, 32],
  [620, 345, 0, 24],
  [740, 360, 0, 18],
  [880, 355, 0, 13],
  [1000, 340, 0, 9],
  [1110, 345, 0, 4],
];
const leg = (x: number, top: number, z: number): P[] => [
  [x, top, z, 20],
  [x - 15, top + 60, z, 13],
  [x + 5, 405, z, 9],
  [x - 20, 432, z, 8],
];
const LEGS = { frontFootL: leg(330, 320, 30), frontFootR: leg(370, 320, -30), rearFootL: leg(500, 320, 28), rearFootR: leg(545, 330, -28) };
const whisker = (z: number): P[] => [
  [135, 172, 0.4 * z, 10],
  [180, 185, z, 8],
  [320, 140, 2 * z, 8],
  [520, 115, 3 * z, 8],
  [740, 150, 3.5 * z, 8],
];
const WHISKERS = { L: whisker(10), R: whisker(-10) };
const horn = (z: number): P[] => [
  [200, 135, z, 8],
  [215, 100, 1.5 * z, 5],
  [225, 75, 1.8 * z, 3],
];

/** Catmull-Rom through the points, 6 steps per span. */
function smooth(pts: P[]): P[] {
  const out: P[] = [];
  for (let i = 0; i < pts.length - 1; i++)
    for (let s = 0; s < 6; s++) {
      const t = s / 6;
      const [a, b, c, d] = [pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(pts.length - 1, i + 2)]];
      out.push(
        a.map((_, k) => 0.5 * (2 * b[k] + (c[k] - a[k]) * t + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t * t + (3 * b[k] - a[k] - 3 * c[k] + d[k]) * t ** 3)) as P,
      );
    }
  return [...out, pts.at(-1)!];
}

function dragon() {
  const res = 150;
  const center = new Vector3(-0.2, 0.95, 0);
  const half = 2.4;
  const cell = (2 * half) / (res - 1);
  const mc = new MarchingCubes(res, new MeshBasicMaterial(), false, false, 500_000);
  mc.isolation = 0;
  mc.field.fill(-1);
  const [q, pa, ba] = [new Vector3(), new Vector3(), new Vector3()];
  for (const part of [SPINE, ...Object.values(LEGS), ...Object.values(WHISKERS), horn(12), horn(-12)]) {
    const c = smooth(part);
    for (let i = 0; i < c.length - 1; i++) {
      const [a, b, ra, rb] = [at(c[i]), at(c[i + 1]), c[i][3] / 250, c[i + 1][3] / 250];
      const lo = a.clone().min(b).subScalar(Math.max(ra, rb) + 2 * cell).sub(center).addScalar(half).divideScalar(cell).floor().max(new Vector3());
      const hi = a.clone().max(b).addScalar(Math.max(ra, rb) + 2 * cell).sub(center).addScalar(half).divideScalar(cell).ceil().min(new Vector3(res - 1, res - 1, res - 1));
      for (let z = lo.z; z <= hi.z; z++)
        for (let y = lo.y; y <= hi.y; y++)
          for (let x = lo.x; x <= hi.x; x++) {
            q.set(x, y, z).multiplyScalar(cell).subScalar(half).add(center);
            ba.subVectors(b, a);
            const h = Math.min(1, Math.max(0, pa.subVectors(q, a).dot(ba) / ba.lengthSq()));
            const j = x + y * res + z * res * res;
            mc.field[j] = Math.max(mc.field[j], ra + (rb - ra) * h - pa.addScaledVector(ba, -h).length());
          }
    }
  }
  mc.update();
  const pos = (mc.geometry.getAttribute("position").array as Float32Array).slice(0, mc.count * 3);
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] = pos[i + k] * half + center.getComponent(k);
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  const model = buildModelData([new Mesh(g)]);
  const species = SPECIES.find((s) => s.id === "asianDragon")!;
  const options = { ...DEFAULT_RIG_OPTIONS, ...species.options };
  const markers = guessMarkers(species.category, model, options);
  return { model, options, markers, plan: planRig(species.category, model, markers, options) };
}

const { model, options, markers, plan } = dragon();

/** World positions of a bone's far end (`tip`) or joint over a clip, `n` + 1 frames. */
function track(p: RigPlan, name: string, bone: string, tip: boolean, n = 40) {
  const clip = buildClips(p).find((c) => c.clip.name === name)!.clip;
  const group = new Group();
  const bones = new Map<string, Bone>();
  for (const spec of p.bones) {
    const b = new Bone();
    b.position.copy(spec.head);
    if (spec.parent) b.position.sub(p.bones.find((x) => x.name === spec.parent)!.head);
    b.name = spec.name;
    (spec.parent ? bones.get(spec.parent)! : group).add(b);
    bones.set(spec.name, b);
  }
  const mixer = new AnimationMixer(group);
  mixer.clipAction(clip).play();
  const spec = p.bones.find((b) => b.name === bone)!;
  return Array.from({ length: n + 1 }, (_, f) => {
    mixer.setTime((clip.duration * f) / n);
    group.updateMatrixWorld(true);
    return bones.get(bone)!.localToWorld(tip ? spec.tail.clone().sub(spec.head) : new Vector3());
  });
}

test("Asian dragon: snout, tail tip and feet found on the mesh; its long whiskers don't pass for an end of the body", () => {
  assert.ok(markers.nose.distanceTo(at(SPINE[0])) < 0.1, `nose ${markers.nose.toArray()}`);
  assert.ok(markers.tailTip.distanceTo(at(SPINE.at(-1)!)) < 0.1, `tail tip ${markers.tailTip.toArray()}`);
  // The head ends where the neck narrows behind the skull, not partway along the snout.
  assert.ok(markers.head.x > at([195, 0, 0, 0]).x, `head ${markers.head.toArray()}`);
  for (const [id, pts] of Object.entries(LEGS))
    assert.ok(markers[id].distanceTo(at(pts.at(-1)!)) < 0.15, `${id} ${markers[id].toArray()}`);
  // Markers are placed from the side: the feet are under the body.
  assert.ok(Math.abs(markerView("serpent", model, markers, options).y) < 1e-6);
});

test("Asian dragon: each whisker is traced along its strand and gets eight links", () => {
  for (const [s, pts] of Object.entries(WHISKERS)) {
    assert.ok(markers[`feelerTip1${s}`].distanceTo(at(pts.at(-1)!)) < 0.15, `${s} tip ${markers[`feelerTip1${s}`].toArray()}`);
    const links = plan.bones.filter((b) => b.name.startsWith("Feeler1_") && b.name.endsWith(s));
    assert.equal(links.length, 8);
    // Every joint lies on the strand (within its thickness), so the bones follow its curve.
    const strand = smooth(pts).map(at);
    const gap = (p: Vector3) =>
      Math.min(...strand.slice(1).map((e, i) => new Line3(strand[i], e).closestPointToPoint(p, true, new Vector3()).distanceTo(p)));
    for (const b of links) assert.ok(gap(b.tail) < 0.04, `${b.name} ${gap(b.tail)} off the strand`);
  }
});

test("Asian dragon flight: neck, body, tail and whiskers all wave, sideways and up and down, in a seamless loop", () => {
  const { lateral: L, up: U, forward: F } = plan.frame;
  const range = (pts: Vector3[], axis: Vector3) => Math.max(...pts.map((p) => p.dot(axis))) - Math.min(...pts.map((p) => p.dot(axis)));
  const parts: [string, boolean][] = [
    ["Spine5", false],
    ["Hips", false],
    ["Tail4", true],
    ["Tail8", true],
    ["Feeler1_8L", true],
    ["Feeler1_8R", true],
  ];
  for (const [bone, tip] of parts) {
    const pts = track(plan, "Fly", bone, tip);
    assert.ok(range(pts, L) > 0.05 * plan.length, `${bone} sideways ${range(pts, L)}`);
    assert.ok(range(pts, U) > 0.04 * plan.length, `${bone} up and down ${range(pts, U)}`);
    assert.ok(pts[0].distanceTo(pts.at(-1)!) < 1e-3 * plan.length, `${bone} loops`);
  }
  // Laid out along the flight line, whatever the pose it was made in: the head well ahead, the tail tip well behind.
  const mean = (pts: Vector3[]) => pts.reduce((a, p) => a + p.dot(F), 0) / pts.length;
  const hips = mean(track(plan, "Fly", "Hips", false));
  assert.ok(mean(track(plan, "Fly", "Head", true)) - hips > 0.4 * plan.length);
  assert.ok(hips - mean(track(plan, "Fly", "Tail8", true)) > 0.3 * plan.length);
});

test("Asian dragon: flipping swaps the head and tail ends (a bushy tail tip can pass for the thicker end)", () => {
  const flipped = guessMarkers("serpent", model, { ...options, flip: true });
  assert.ok(flipped.nose.distanceTo(markers.tailTip) < 0.1, `nose ${flipped.nose.toArray()}`);
  assert.ok(flipped.tailTip.distanceTo(markers.nose) < 0.1, `tail tip ${flipped.tailTip.toArray()}`);
});

test("Asian dragon: it flies even without legs (legs off, or no feet found)", () => {
  const o = { ...options, legs: false };
  const legless = planRig("serpent", model, guessMarkers("serpent", model, o), o);
  assert.ok(buildClips(legless).some((c) => c.clip.name === "Fly"));
  const pts = track(legless, "Fly", "Tail8", true);
  assert.ok(pts[0].distanceTo(pts[20]) > 0.05 * legless.length, "the tail waves");
});
