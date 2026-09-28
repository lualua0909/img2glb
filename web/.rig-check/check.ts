import { writeFileSync } from "node:fs";
import { AnimationMixer, Bone, Matrix4, Object3D, Vector3 } from "three";
import { loadMeshes, MODELS } from "./load";
import { render } from "./render";
import { buildModelData, type ModelData } from "../src/lib/rig/model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, planRig, syncMirror, type RigOptions, type RigPlan } from "../src/lib/rig/rig";
import { computeSkin, type Skin } from "../src/lib/rig/skin";
import { buildClips, type RigClip } from "../src/lib/rig/clips";

export async function rigModel(id: string, opts: Partial<RigOptions> = {}) {
  const meshes = await loadMeshes(MODELS + id + ".glb");
  const m = buildModelData(meshes);
  const o = { ...DEFAULT_RIG_OPTIONS, ...opts };
  const k = syncMirror("humanoid", m, guessMarkers("humanoid", m, o), o);
  const plan = planRig("humanoid", m, k, o);
  if (process.env.NOCRISP) plan.bones.forEach((b) => delete b.crisp);
  if (process.env.NOREACH) plan.bones.forEach((b) => delete b.reach);
  if (process.env.NOCOLLAR) {
    plan.bones = plan.bones.filter((b) => !/^(Left|Right)Shoulder$/.test(b.name));
    plan.bones.forEach((b) => { if (/^(Left|Right)UpperArm$/.test(b.name)) b.parent = "Chest"; });
  }
  const skin = await computeSkin(m, plan);
  return { m, o, k, plan, skin, clips: buildClips(plan) };
}

/** Bone objects posed like stage.applyRig; returns sampler giving skinned positions at time t of clip. */
export function sampler(plan: RigPlan, m: ModelData, skin: Skin) {
  const root = new Object3D();
  const bones = plan.bones.map((b) => Object.assign(new Bone(), { name: b.name }));
  plan.bones.forEach((b, i) => {
    const p = b.parent ? plan.bones.findIndex((x) => x.name === b.parent) : -1;
    bones[i].position.copy(p >= 0 ? b.head.clone().sub(plan.bones[p].head) : b.head);
    (p >= 0 ? bones[p] : root).add(bones[i]);
  });
  const mixer = new AnimationMixer(root);
  const inv = plan.bones.map((b) => new Matrix4().makeTranslation(-b.head.x, -b.head.y, -b.head.z));
  const mats = plan.bones.map(() => new Matrix4());
  const out = new Float32Array(m.count * 3);
  const v = new Vector3(), q = new Vector3();
  return {
    bones,
    pose(clip: RigClip | null, t: number) {
      mixer.stopAllAction();
      bones.forEach((b, i) => { b.quaternion.identity(); b.scale.set(1, 1, 1); const p = plan.bones[i].parent ? plan.bones.findIndex((x) => x.name === plan.bones[i].parent) : -1; b.position.copy(p >= 0 ? plan.bones[i].head.clone().sub(plan.bones[p].head) : plan.bones[i].head); });
      if (clip) { const a = mixer.clipAction(clip.clip); a.reset().play(); mixer.setTime(t); }
      root.updateMatrixWorld(true);
      bones.forEach((b, i) => mats[i].multiplyMatrices(b.matrixWorld, inv[i]));
      for (let i = 0; i < m.count; i++) {
        v.fromArray(m.positions, i * 3);
        let x = 0, y = 0, z = 0;
        for (let s = 0; s < 4; s++) {
          const w = skin.weight[i * 4 + s];
          if (!w) continue;
          q.copy(v).applyMatrix4(mats[skin.index[i * 4 + s]]);
          x += w * q.x; y += w * q.y; z += w * q.z;
        }
        out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
      }
      return out;
    },
    mats,
  };
}

export function edges(m: ModelData) {
  const set = new Set<number>();
  const list: number[] = [];
  for (let t = 0; t < m.index.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = m.index[t + k], b = m.index[t + ((k + 1) % 3)];
      const key = Math.min(a, b) * m.count + Math.max(a, b);
      if (!set.has(key)) { set.add(key); list.push(Math.min(a, b), Math.max(a, b)); }
    }
  return new Uint32Array(list);
}

const dominant = (skin: Skin, i: number) => skin.index[i * 4];

/** Distortion report of every clip. */
export function report(plan: RigPlan, m: ModelData, skin: Skin, clips: RigClip[], only?: RegExp) {
  const E = edges(m);
  const rest = new Float32Array(E.length / 2);
  const P = m.positions;
  const len = (A: Float32Array, a: number, b: number) => Math.hypot(A[a * 3] - A[b * 3], A[a * 3 + 1] - A[b * 3 + 1], A[a * 3 + 2] - A[b * 3 + 2]);
  for (let e = 0; e < rest.length; e++) rest[e] = len(P, E[e * 2], E[e * 2 + 1]);
  const S = sampler(plan, m, skin);
  const rows: { clip: string; worst: number; bad: number; t: number; where: string; collapse: number; energy: number }[] = [];
  let total = 0;
  for (let e = 0; e < rest.length; e++) total += rest[e];
  const triArea = (A: Float32Array, t: number) => {
    const [a, b, c] = [m.index[t], m.index[t + 1], m.index[t + 2]];
    const ux = A[b * 3] - A[a * 3], uy = A[b * 3 + 1] - A[a * 3 + 1], uz = A[b * 3 + 2] - A[a * 3 + 2];
    const vx = A[c * 3] - A[a * 3], vy = A[c * 3 + 1] - A[a * 3 + 1], vz = A[c * 3 + 2] - A[a * 3 + 2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  };
  const restArea = new Float32Array(m.index.length / 3);
  for (let t = 0; t < m.index.length; t += 3) restArea[t / 3] = triArea(P, t);
  const minEdge = 0.002 * m.size.y;
  for (const c of clips) {
    if (only && !only.test(c.clip.name)) continue;
    let worst = 0, bad = 0, bt = 0, collapse = 0, energy = 0, frames = 0;
    let where = new Map<string, number>();
    for (let t = 0; t <= c.clip.duration + 1e-6; t += 1 / 15) {
      const A = S.pose(c, t);
      let fb = 0, fw = 0, en = 0; const wm = new Map<string, number>();
      for (let e = 0; e < rest.length; e++) {
        if (rest[e] < minEdge) continue;
        const r = len(A, E[e * 2], E[e * 2 + 1]) / rest[e];
        const s = Math.abs(Math.log(r));
        en += rest[e] * s * s;
        if (s > fw) fw = s;
        if (s > Math.log(1.6)) {
          fb++;
          const names = [...new Set([dominant(skin, E[e * 2]), dominant(skin, E[e * 2 + 1])].map((i) => plan.bones[i].name))].sort().join("+");
          wm.set(names, (wm.get(names) ?? 0) + 1);
        }
      }
      let col = 0;
      for (let t3 = 0; t3 < m.index.length; t3 += 3) if (restArea[t3 / 3] > minEdge * minEdge && triArea(A, t3) < 0.15 * restArea[t3 / 3]) col++;
      if (fb > bad) { bad = fb; bt = t; where = wm; }
      worst = Math.max(worst, fw); collapse = Math.max(collapse, col); energy += en / total; frames++;
    }
    rows.push({ clip: c.clip.name, worst: Math.exp(worst), bad, t: bt, collapse, energy: (1000 * energy) / frames, where: [...where].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}:${v}`).join(" ") });
  }
  return rows;
}

export async function snap(file: string, plan: RigPlan, m: ModelData, skin: Skin, clip: RigClip | null, times: number[], dirs = [new Vector3(0, 0, 1)], focus?: { c: Vector3; r: number }) {
  const S = sampler(plan, m, skin);
  const views = [];
  const pad = m.size.y * 0.3;
  const box = focus ? { min: focus.c.clone().addScalar(-focus.r), max: focus.c.clone().addScalar(focus.r) } : { min: m.box.min.clone().addScalar(-pad), max: m.box.max.clone().addScalar(pad) };
  const P = m.positions;
  const L = (A: Float32Array, a: number, b: number) => Math.hypot(A[a * 3] - A[b * 3], A[a * 3 + 1] - A[b * 3 + 1], A[a * 3 + 2] - A[b * 3 + 2]);
  for (const t of times) {
    const A = S.pose(clip, t).slice();
    const colors = new Float32Array(m.index.length);
    for (let t3 = 0; t3 < m.index.length; t3 += 3) {
      let s = 0;
      for (let k = 0; k < 3; k++) {
        const a = m.index[t3 + k], b = m.index[t3 + ((k + 1) % 3)];
        const r = Math.log(L(A, a, b) / Math.max(L(P, a, b), 1e-9));
        if (Math.abs(r) > Math.abs(s)) s = r;
      }
      const x = Math.min(1, Math.abs(s) / Math.log(2));
      const c = s > 0 ? [0.75 + 0.25 * x, 0.75 - 0.6 * x, 0.75 - 0.6 * x] : [0.75 - 0.6 * x, 0.75 - 0.4 * x, 0.75 + 0.25 * x];
      colors.set(c, t3);
    }
    for (const d of dirs) views.push({ pos: A, index: m.index, dir: d, colors });
  }
  await render(file, views, 480, box);
}

if (process.argv[1]?.endsWith("check.ts")) {
  (async () => {
    const [id, json, filter] = process.argv.slice(2);
    const r = await rigModel(id, json ? JSON.parse(json) : {});
    const rows = report(r.plan, r.m, r.skin, r.clips, filter ? new RegExp(filter) : undefined);
    const edgesN = edges(r.m).length / 2;
    console.log(`edges ${edgesN}`);
    for (const x of rows) console.log(`${x.clip.padEnd(20)} E ${x.energy.toFixed(2).padStart(6)} worst ${x.worst.toFixed(2)} bad ${String(x.bad).padStart(4)} @${x.t.toFixed(2)} col ${String(x.collapse).padStart(4)}  ${x.where}`);
    writeFileSync("/private/tmp/claude-502/-Users-duyna-Desktop-Img-to-3D/31a54945-396b-4ac6-8c43-1a0c65d69d10/scratchpad/last.json", JSON.stringify(rows));
  })();
}
