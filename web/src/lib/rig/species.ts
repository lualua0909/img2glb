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
    attacks: ["Attack_Bite", "Attack_Swipe", "Attack_TailSwipe", "Attack_Breath"],
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
    id: "asianDragon",
    archetype: "longDragon",
    category: "serpent",
    options: { jaw: true, legs: true },
    locomotion: ["Fly", "Slither"],
    attacks: ["Attack_Strike", "Attack_Claw", "Attack_TailSwipe"],
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
    options: { fins: true, jaw: true, swim: "fish" },
    locomotion: ["Swim", "Swim_Fast", "Swim_Idle"],
    attacks: ["Attack_Bite", "Attack_Ram", "Attack_TailSlap"],
  },
  {
    id: "dolphin",
    archetype: "cetacean",
    category: "fish",
    options: { fins: true, swim: "whale" },
    locomotion: ["Swim", "Swim_Fast", "Swim_Idle"],
    attacks: ["Attack_Ram", "Attack_TailSlap"],
  },
  {
    id: "whale",
    archetype: "cetacean",
    category: "fish",
    options: { fins: true, jaw: true, swim: "whale" },
    locomotion: ["Swim", "Swim_Fast", "Swim_Idle"],
    attacks: ["Attack_Bite", "Attack_TailSlap", "Attack_FinSlap"],
  },
  {
    id: "mantaRay",
    archetype: "ray",
    category: "fish",
    // Horns: the cephalic fins in front of a manta's eyes.
    options: { fins: true, horns: 2, swim: "ray" },
    locomotion: ["Swim", "Swim_Fast", "Swim_Idle", "Glide"],
    attacks: ["Attack_FinSlap", "Attack_TailSlap"],
  },
];

/** Clips a species needs: idle, its locomotion and attacks, hit and death. */
export const requiredClips = (s: Species) => ["Idle", ...s.locomotion, ...s.attacks, "Hit", "Death"];

/** Body type of a rig built without a preset. */
export function archetypeOf(category: RigCategory, o: RigOptions): Archetype {
  if (category === "humanoid") return "biped";
  if (category === "quadruped") return o.wings ? "wingedQuadruped" : o.bipedal ? "biped" : "quadruped";
  if (category === "serpent") return o.legs ? "longDragon" : "serpent";
  if (category === "fish") return o.swim === "whale" ? "cetacean" : o.swim === "ray" ? "ray" : "fish";
  if (category === "bird") return category;
  return "other";
}
