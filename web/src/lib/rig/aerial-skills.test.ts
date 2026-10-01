import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimationMixer, Bone, BoxGeometry, Group, LoopOnce, Mesh } from "three";
import { buildClips } from "./clips";
import { buildModelData } from "./model";
import { DEFAULT_RIG_OPTIONS, guessMarkers, planRig, type RigCategory, type RigOptions, type RigPlan } from "./rig";
import { requiredClips, SPECIES } from "./species";

const box = (x: number, y: number, z: number, w: number, h: number, d: number, seg = 3) => {
  const mesh = new Mesh(new BoxGeometry(w, h, d, seg, seg, seg));
  mesh.position.set(x, y, z);
  mesh.updateMatrixWorld();
  return mesh;
};

/** Flyer facing -X: a thick head, a long body, two pairs of thin wings spread along Z and thin tail flukes. */
const flyer = () =>
  buildModelData([
    box(0, 0, 0, 2, 0.25, 0.25, 6),
    box(-1.15, 0.05, 0, 0.3, 0.3, 0.3),
    box(-0.4, 0, 0, 0.3, 0.02, 2.2, 6),
    box(0.35, 0, 0, 0.3, 0.02, 2.0, 6),
    box(1.2, 0, 0, 0.4, 0.4, 0.02),
  ]);

/** Fish facing +Z: a long body, a bigger head, three pairs of small fins low on the body. */
const fish = () =>
  buildModelData([
    box(0, 0.5, 0, 0.3, 0.3, 2, 4),
    box(0, 0.5, 0.8, 0.36, 0.36, 0.4, 2),
    ...[0.5, 0, -0.4].flatMap((z) => [box(0.3, 0.4, z, 0.3, 0.04, 0.2, 2), box(-0.3, 0.4, z, 0.3, 0.04, 0.2, 2)]),
  ]);

/** Snake lying along X, head (thicker) at -X. */
const snake = () => buildModelData([box(0, 0.1, 0, 3, 0.15, 0.15, 12), box(-1.6, 0.12, 0, 0.3, 0.22, 0.22)]);

const plan = (category: RigCategory, model: ReturnType<typeof flyer>, options: Partial<RigOptions>) => {
  const o = { ...DEFAULT_RIG_OPTIONS, ...options };
  return planRig(category, model, guessMarkers(category, model, o), o);
};

/** World position of each bone's tail at each time (seconds) of a clip. */
function sample(p: RigPlan, name: string, bones: string[], times: number[]) {
  const clip = buildClips(p).find((c) => c.clip.name === name)!.clip;
  const group = new Group();
  const map = new Map<string, Bone>();
  for (const spec of p.bones) {
    const b = new Bone();
    b.position.copy(spec.head);
    if (spec.parent) b.position.sub(p.bones.find((x) => x.name === spec.parent)!.head);
    b.name = spec.name;
    (spec.parent ? map.get(spec.parent)! : group).add(b);
    map.set(spec.name, b);
  }
  const mixer = new AnimationMixer(group);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.play();
  return times.map((t) => {
    mixer.setTime(t);
    group.updateMatrixWorld(true);
    return Object.fromEntries(
      bones.map((n) => {
        const spec = p.bones.find((b) => b.name === n)!;
        return [n, map.get(n)!.localToWorld(spec.tail.clone().sub(spec.head))];
      }),
    );
  });
}

/** Both skills exist, are finite and deal damage with an organ the rig has. */
function checkClips(p: RigPlan, label: string) {
  const clips = buildClips(p);
  for (const name of ["Attack_DiveBomb", "Attack_Circle"]) {
    const c = clips.find((x) => x.clip.name === name);
    assert.ok(c, `${label}: ${name}`);
    assert.equal(c.movement, "13");
    assert.ok(c.attack?.bones.length, `${label}: ${name} has its organ`);
    for (const t of c.clip.tracks) assert.ok(Array.from(t.values).every(Number.isFinite), `${label}: ${name} ${t.name}`);
  }
}

test("winged dragon dives from high up straight onto the ground, wings spread, hind wings and crest quivering", () => {
  const p = plan("quadruped", flyer(), { wings: true, wingPairs: 2, jaw: true, crests: 1 });
  checkClips(p, "dragon");
  const H = p.height;
  const S = Math.max(p.height, p.length);
  const ground = p.bones[0].head.y;
  // (Sampled just short of the end: a finished one-shot action lets go of the bones.)
  const [start, top, plunge, impact, end] = sample(p, "Attack_DiveBomb", ["Head", "Hips", "WingHandL", "WingHandR"], [0, 1.2, 1.55, 1.75, 2.9999]);
  assert.ok(top.Head.y - start.Head.y > S, `soars up high: ${top.Head.y - start.Head.y}`);
  // Plunging straight down: the head far below the hips.
  assert.ok(plunge.Hips.y - plunge.Head.y > 0.25 * p.length, `nose down: ${plunge.Hips.y - plunge.Head.y}`);
  // The lowest point of the body (not the spread wings) lands on the ground, not through it.
  const body = p.bones.map((b) => b.name).filter((n) => !n.startsWith("Wing"));
  const [landed] = sample(p, "Attack_DiveBomb", body, [1.75]);
  const low = Math.min(...Object.values(landed).map((v) => v.y)) - ground;
  assert.ok(Math.abs(low) < 0.1 * H, `lands on the ground: ${low}`);
  assert.ok(impact.Head.y < impact.Hips.y, "lands head first");
  assert.ok(start.Head.distanceTo(end.Head) < 1e-3, "back where it started");
  // Wings spread as wide as in a glide all the way.
  const [glide] = sample(p, "Glide", ["WingHandL", "WingHandR"], [1]);
  const span = glide.WingHandL.distanceTo(glide.WingHandR);
  for (const f of [top, plunge, impact]) {
    const s = f.WingHandL.distanceTo(f.WingHandR);
    assert.ok(s > 0.95 * span, `wings spread: ${s} vs ${span}`);
  }

  // Quivering: the hind wing tip and the crest tip jump between frames 1/24 s apart (half a 12 Hz shiver); the main
  // wing tip barely moves relative to the body.
  const quiver = (bone: string) => {
    const [a, b] = sample(p, "Attack_DiveBomb", [bone, "Hips"], [1.5, 1.5 + 1 / 24]);
    return a[bone].clone().sub(a.Hips).distanceTo(b[bone].clone().sub(b.Hips));
  };
  assert.ok(p.bones.some((b) => b.name === "Crest1_3"), "crest rigged");
  assert.ok(quiver("Wing2HandL") > 0.05, `hind wing quivers: ${quiver("Wing2HandL")}`);
  const crestLength = [1, 2, 3].map((j) => p.bones.find((b) => b.name === `Crest1_${j}`)!).reduce((a, b) => a + b.head.distanceTo(b.tail), 0);
  assert.ok(quiver("Crest1_3") > 0.1 * crestLength, `crest quivers: ${quiver("Crest1_3")} (length ${crestLength})`);
  assert.ok(quiver("WingHandL") < 0.5 * quiver("Wing2HandL"), `main wing held: ${quiver("WingHandL")}`);
});

test("winged dragon circles the target ahead and comes back to face it", () => {
  const p = plan("quadruped", flyer(), { wings: true, wingPairs: 2, jaw: true });
  const R = 1.2 * Math.max(p.height, p.length);
  const F = p.frame.forward;
  const L = p.frame.lateral;
  // A quarter, half and three quarters of the way round (the circle eases in and out).
  const times = [0, 1.87, 2.5, 3.13, 4.9999];
  const at = sample(p, "Attack_Circle", ["Hips", "Head"], times).map((f) => f.Hips);
  const target = at[0].clone().addScaledVector(F, R);
  // Halfway round it is on the far side of the target, a quarter round off to either side.
  assert.ok(at[2].clone().sub(at[0]).dot(F) > 1.6 * R, `far side: ${at[2].clone().sub(at[0]).dot(F)}`);
  assert.ok(Math.abs(at[1].clone().sub(at[3]).dot(L)) > 1.4 * R, "both sides");
  for (const h of at.slice(1, 4)) {
    const flat = h.clone().sub(target).addScaledVector(p.frame.up, -h.clone().sub(target).dot(p.frame.up));
    assert.ok(Math.abs(flat.length() - R) < 0.3 * R, `around the target: ${flat.length()} vs ${R}`);
  }
  assert.ok(at[0].distanceTo(at[4]) < 1e-3, "ends where it started");
  // Heading along the circle (clockwise from above): ahead on the left side, across on the far side, back on the
  // right side.
  const facing = sample(p, "Attack_Circle", ["Head", "Hips"], times.slice(1, 4)).map((f) => f.Head.clone().sub(f.Hips).normalize());
  assert.ok(facing[0].dot(F) > 0.7, `left side heads on: ${facing[0].dot(F)}`);
  assert.ok(facing[1].dot(L) < -0.7, `far side heads across: ${facing[1].dot(L)}`);
  assert.ok(facing[2].dot(F) < -0.7, `right side heads back: ${facing[2].dot(F)}`);
});

test("sea beasts, Asian dragons and many-winged flyers get both skills", () => {
  for (const swim of ["fish", "whale", "ray"] as const) checkClips(plan("fish", fish(), { fins: 3, jaw: true, swim }), swim);
  checkClips(plan("serpent", snake(), { jaw: true }), "serpent");
  checkClips(plan("bird", flyer(), { wingPairs: 2, legless: true }), "bird");
  // A fish's fins all quiver.
  const p = plan("fish", fish(), { fins: 3, jaw: true });
  const [a, b] = sample(p, "Attack_Circle", ["Fin2_3L", "Spine3"], [2, 2 + 1 / 24]);
  assert.ok(a.Fin2_3L.clone().sub(a.Spine3).distanceTo(b.Fin2_3L.clone().sub(b.Spine3)) > 0.005, "pelvic fin quivers");
  // Insects keep their stiff buzz: no soft aerial skills.
  const insect = buildClips(plan("quadruped", flyer(), { wings: true, insect: true, wingPairs: 2 }));
  assert.ok(!insect.some((c) => c.clip.name === "Attack_DiveBomb" || c.clip.name === "Attack_Circle"));
});

test("dragon and sea beast presets list the aerial skills", () => {
  for (const id of ["westernDragon", "wyvern", "asianDragon", "skyWyrm", "shark", "whale", "mantaRay"]) {
    const species = SPECIES.find((s) => s.id === id)!;
    for (const name of ["Attack_DiveBomb", "Attack_Circle"]) assert.ok(requiredClips(species).includes(name), `${id}: ${name}`);
  }
});

test("Asian dragon bends along the circle, tail on the inside of the turn", () => {
  const p = plan("serpent", snake(), { jaw: true });
  const tip = p.bones.filter((b) => /^Tail\d+$/.test(b.name)).at(-1)!.name;
  const S = p.length;
  // Halfway round, on the far side of the target and heading across (-L): the target, the inside of the turn, is
  // behind it (-F), and the tail trails that way.
  const [f] = sample(p, "Attack_Circle", ["Head", tip], [2.5]);
  const bow = f[tip].clone().sub(f.Head).dot(p.frame.forward);
  assert.ok(bow < -0.15 * S, `tail on the inside: ${bow} (length ${S})`);
});
