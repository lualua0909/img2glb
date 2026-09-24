// Shared (client + server) without three.js.
export const RIG_CATEGORIES = ["humanoid", "quadruped", "bird", "fish", "vehicle", "aircraft", "plant", "fluid", "prop"] as const;
export type RigCategory = (typeof RIG_CATEGORIES)[number];
