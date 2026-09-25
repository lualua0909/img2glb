import type { RigClip } from "./clips";
import type { ModelData } from "./model";
import { boneRadius, type RigPlan } from "./rig";
import type { Archetype } from "./species";

const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** Capsule following a bone: from `start` along `axis` (bone space, from the bone's origin) for `length`. */
export type Hitbox = { bone: string; shape: "capsule"; radius: number; start: number; length: number; axis: number[] };

/**
 * glTF scene extras for game engines: the body type, the weapons held and a capsule for every bone that deals damage
 * in `clips`. It runs from `start` along `axis` (bone space, from the bone's origin) for `length`, so it follows the
 * jaw, horn, paw, tail or weapon it belongs to (only the striking part of a weapon: its blade, its head). Which of them
 * hit, and when, goes on each attack animation (`attackExtras`).
 */
export function hitboxExtras(m: ModelData, plan: RigPlan, clips: RigClip[], info: { archetype: Archetype; species: string | null }) {
  const attacks = clips.flatMap((c) => (c.attack?.bones.length ? [c.attack] : []));
  const organs: Record<string, string[]> = {};
  for (const a of attacks) organs[a.organ] = [...new Set([...(organs[a.organ] ?? []), ...a.bones])];
  const hitboxes = [...new Set(attacks.flatMap((a) => a.bones))].map((name): Hitbox => {
    const b = plan.bones.find((x) => x.name === name)!;
    const axis = b.tail.clone().sub(b.head);
    const [from, to] = b.strike ?? [0, 1];
    return {
      bone: name,
      shape: "capsule",
      radius: round(boneRadius(m, b)),
      start: round(from * axis.length()),
      length: round((to - from) * axis.length()),
      axis: axis.normalize().toArray().map(round),
    };
  });
  return {
    rig: { ...info, category: plan.category, ...(plan.weapons && { weapons: plan.weapons }), attackOrgans: organs, hitboxes },
  };
}

/** Animation extras of an attack clip (set as `clip.userData`, which the exporter writes out). */
export const attackExtras = (c: RigClip) => (c.attack?.bones.length || c.attack?.projectile ? { attack: c.attack } : {});
