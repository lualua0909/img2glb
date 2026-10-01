import type { RigCategory } from "./categories";
import type { RigOptions } from "./rig";

// Animal asset convention: Species -> Body type (archetype) -> Locomotion -> Attack organ -> Attack type -> Required
// bones -> Required animations. A preset picks the template and the rig options that give the attack organs their own
// bones (a trunk, a jaw, horns, wings); the attack clips name the bones that deal the damage (see `RigClip.attack`).

/** Skeleton families, each with its own bone and animation requirements. */
export type Archetype =
  | "biped"
  | "quadruped"
  | "largeBeast"
  | "wingedQuadruped"
  | "bird"
  | "serpent"
  | "longDragon"
  | "fish"
  | "cetacean"
  | "ray"
  | "insect"
  | "other";

export type Species = {
  id: string;
  archetype: Archetype;
  category: RigCategory;
  options: Partial<RigOptions>;
  /** Movement clips the asset needs. */
  locomotion: string[];
  /** Attack clips the asset needs. */
  attacks: string[];
};

export const SPECIES: Species[] = [
  {
    id: "elephant",
    archetype: "largeBeast",
    category: "quadruped",
    options: { trunk: true, horns: 2 },
    locomotion: ["Walk", "Run"],
    attacks: ["Attack_TrunkSweep", "Attack_TrunkToss", "Attack_Charge", "Attack_Stomp"],
  },
  {
    id: "bovine",
    archetype: "largeBeast",
    category: "quadruped",
    options: { horns: 2 },
    locomotion: ["Walk", "Run", "Gallop"],
    attacks: ["Attack_Charge", "Attack_Headbutt"],
  },
  {
    id: "rhino",
    archetype: "largeBeast",
    category: "quadruped",
    options: { horns: 1 },
    locomotion: ["Walk", "Run", "Gallop"],
    attacks: ["Attack_Charge", "Attack_Headbutt"],
  },
  {
    id: "sauropod",
    archetype: "largeBeast",
    category: "quadruped",
    options: { longNeck: true, tail: true },
    locomotion: ["Walk", "Run", "Idle_Look", "Interact_Eat"],
    attacks: ["Attack_Stomp", "Attack_TailSwipe"],
  },
  {
    id: "theropod",
    archetype: "biped",
    category: "quadruped",
    options: { bipedal: true, jaw: true },
    locomotion: ["Walk", "Run"],
    attacks: ["Attack_Bite", "Attack_BiteShake", "Attack_Headbutt", "Attack_TailSwipe"],
  },
  {
    id: "bird",
    archetype: "bird",
    category: "bird",
    options: {},
    locomotion: ["Hop", "Fly", "Glide", "Wings_Fold", "Wings_Spread"],
    attacks: ["Attack_Peck", "Attack_Pounce", "Attack_Dive"],
  },
  {
    id: "westernDragon",
    archetype: "wingedQuadruped",
    category: "quadruped",
    options: { wings: true, jaw: true },
    locomotion: ["Walk", "Run", "Fly", "Glide", "Wings_Fold", "Wings_Spread"],
    attacks: ["Attack_Bite", "Attack_Swipe", "Attack_TailSwipe", "Attack_Breath", "Attack_DiveBomb", "Attack_Circle"],
  },
  {
    // Two legs, the wings are its front limbs.
    id: "wyvern",
    archetype: "wingedQuadruped",
    category: "quadruped",
    options: { bipedal: true, armless: true, wings: true, jaw: true },
    locomotion: ["Walk", "Run", "Fly", "Glide", "Wings_Fold", "Wings_Spread"],
    attacks: ["Attack_Bite", "Attack_TailSwipe", "Attack_Breath", "Attack_DiveBomb", "Attack_Circle"],
  },
  {
    id: "fourWingedFlyer",
    archetype: "bird",
    category: "bird",
    options: { wingPairs: 2 },
    locomotion: ["Hop", "Fly", "Glide", "Wings_Fold", "Wings_Spread"],
    attacks: ["Attack_Peck", "Attack_Pounce", "Attack_Dive"],
  },
  {
    // Never lands: no legs, several wing pairs, a long tail that floats behind it.
    id: "skyWyrm",
    archetype: "bird",
    category: "bird",
    options: { wingPairs: 2, legless: true },
    locomotion: ["Fly", "Glide", "Wings_Fold", "Wings_Spread"],
    attacks: ["Attack_Peck", "Attack_Spin", "Attack_DiveBomb", "Attack_Circle"],
  },
  {
    id: "snake",
    archetype: "serpent",
    category: "serpent",
    options: { jaw: true },
    locomotion: ["Slither", "Slither_Fast"],
    attacks: ["Attack_Strike", "Attack_Constrict"],
  },
  {
    // Long neck, body and tail on one dense chain, four legs, a pair of long whiskers traced along the mesh (eight
    // links each); in flight the whole body swims along one wave and the whiskers stream back.
    id: "asianDragon",
    archetype: "longDragon",
    category: "serpent",
    options: { jaw: true, legs: true, feelers: 1 },
    locomotion: ["Fly", "Slither"],
    attacks: ["Attack_Strike", "Attack_Claw", "Attack_TailSwipe", "Attack_DiveBomb", "Attack_Circle"],
  },
  {
    // Six legs and two wing pairs on the thorax, the abdomen a tail chain, antennae; the wings beat fast and stiff.
    id: "insect",
    archetype: "insect",
    category: "quadruped",
    options: { insect: true, sixLegs: true, wings: true, wingPairs: 2, jaw: true, feelers: 1 },
    locomotion: ["Walk", "Run", "Fly", "Glide", "Wings_Fold", "Wings_Spread"],
    attacks: ["Attack_Bite", "Attack_Sting"],
  },
  {
    id: "bear",
    archetype: "largeBeast",
    category: "quadruped",
    options: { jaw: true },
    locomotion: ["Walk", "Run", "Stand"],
    attacks: ["Attack_Swipe", "Attack_Bite"],
  },
  {
    id: "bigCat",
    archetype: "quadruped",
    category: "quadruped",
    options: { jaw: true },
    locomotion: ["Walk", "Run", "Gallop"],
    attacks: ["Attack_Swipe", "Attack_Pounce", "Attack_Bite"],
  },
  {
    id: "canine",
    archetype: "quadruped",
    category: "quadruped",
    options: { jaw: true },
    locomotion: ["Walk", "Run", "Gallop"],
    attacks: ["Attack_Bite", "Attack_BiteShake"],
  },
  {
    id: "crocodile",
    archetype: "quadruped",
    category: "quadruped",
    options: { jaw: true },
    locomotion: ["Walk", "Swim"],
    attacks: ["Attack_Bite", "Attack_TailSwipe"],
  },
  {
    id: "horse",
    archetype: "quadruped",
    category: "quadruped",
    options: {},
    locomotion: ["Walk", "Run", "Gallop"],
    attacks: ["Attack_Buck"],
  },
  {
    id: "deer",
    archetype: "quadruped",
    category: "quadruped",
    options: { horns: 2 },
    locomotion: ["Walk", "Run", "Gallop"],
    attacks: ["Attack_Buck", "Attack_Charge"],
  },
  {
    id: "shark",
    archetype: "fish",
    category: "fish",
    options: { fins: 1, jaw: true, swim: "fish" },
    locomotion: ["Swim", "Swim_Fast", "Swim_Idle"],
    attacks: ["Attack_Bite", "Attack_Ram", "Attack_TailSlap", "Attack_DiveBomb", "Attack_Circle"],
  },
  {
    id: "dolphin",
    archetype: "cetacean",
    category: "fish",
    options: { fins: 1, swim: "whale" },
    locomotion: ["Swim", "Swim_Fast", "Swim_Idle"],
    attacks: ["Attack_Ram", "Attack_TailSlap"],
  },
  {
    id: "whale",
    archetype: "cetacean",
    category: "fish",
    options: { fins: 1, jaw: true, swim: "whale" },
    locomotion: ["Swim", "Swim_Fast", "Swim_Idle"],
    attacks: ["Attack_Bite", "Attack_TailSlap", "Attack_FinSlap", "Attack_DiveBomb", "Attack_Circle"],
  },
  {
    id: "mantaRay",
    archetype: "ray",
    category: "fish",
    // Horns: the cephalic fins in front of a manta's eyes.
    options: { fins: 1, horns: 2, swim: "ray" },
    locomotion: ["Swim", "Swim_Fast", "Swim_Idle", "Glide"],
    attacks: ["Attack_FinSlap", "Attack_TailSlap", "Attack_DiveBomb", "Attack_Circle"],
  },
];

/** Clips a species needs: idle, its locomotion and attacks, hit and death. */
export const requiredClips = (s: Species) => ["Idle", ...s.locomotion, ...s.attacks, "Hit", "Death"];

/** Body type of a rig built without a preset. */
export function archetypeOf(category: RigCategory, o: RigOptions): Archetype {
  if (category === "humanoid") return "biped";
  if (category === "quadruped") return o.insect ? "insect" : o.wings ? "wingedQuadruped" : o.bipedal ? "biped" : "quadruped";
  if (category === "serpent") return o.legs ? "longDragon" : "serpent";
  if (category === "fish") return o.swim === "whale" ? "cetacean" : o.swim === "ray" ? "ray" : "fish";
  if (category === "bird") return category;
  return "other";
}
