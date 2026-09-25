// Shared (client + server) without three.js.
export const RIG_CATEGORIES = ["humanoid", "quadruped", "bird", "serpent", "fish", "vehicle", "aircraft", "plant", "fluid", "building", "prop"] as const;
export type RigCategory = (typeof RIG_CATEGORIES)[number];
