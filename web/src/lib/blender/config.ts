import { z } from "zod";

const point = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
/** Coordinates for overrides are normalized mesh bounds in glTF axes (X right, Y up, Z front). */
const humanoidConfigSchema = z.object({
  version: z.literal(1).default(1),
  preset: z.literal("humanoid").default("humanoid"),
  forward: z.enum(["+Z", "-Z"]).default("+Z"),
  widthScale: z.number().min(0.25).max(4).default(1),
  depthScale: z.number().min(0.25).max(4).default(1),
  weightFallback: z.enum(["error", "nearest"]).default("error"),
  bones: z.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/), z.object({ head: point, tail: point }).strict()).default({}),
}).strict();

export const BLENDER_TEMPLATE_CATEGORIES = ["humanoid", "quadruped", "bird", "serpent", "fish"] as const;
const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/);
const templateBone = z.object({
  name,
  parent: name.nullable(),
  head: point,
  tail: point,
  deform: z.boolean(),
  rigid: z.boolean().optional(),
  gate: z.object({
    origin: point, dir: point, fade: z.number().finite().nonnegative().optional(),
    planes: z.array(z.object({ origin: point, dir: point.refine(p => Math.hypot(...p) >= 1e-8, "Plane direction must be nonzero") }).strict()).max(4).optional(),
  }).strict().optional(),
}).strict();
const templateConfigSchema = z.object({
  version: z.literal(1).default(1),
  preset: z.literal("template"),
  category: z.enum(BLENDER_TEMPLATE_CATEGORIES),
  species: z.string().max(64).nullable().default(null),
  weightFallback: z.enum(["error", "nearest"]).default("error"),
  // Absolute glTF world coordinates, including user-edited markers. Do not fit or flip again.
  skeleton: z.array(templateBone).min(2).max(256),
}).strict().superRefine((config, ctx) => {
  const seen = new Set<string>();
  for (const [i, bone] of config.skeleton.entries()) {
    if (seen.has(bone.name) || (bone.parent !== null && !seen.has(bone.parent)))
      ctx.addIssue({ code: "custom", path: ["skeleton", i], message: "Unique bones must be ordered parent before child" });
    if (bone.deform && bone.head.every((n, axis) => Math.abs(n - bone.tail[axis]) < 1e-8))
      ctx.addIssue({ code: "custom", path: ["skeleton", i], message: "Deform bone must have nonzero length" });
    if (bone.gate && Math.hypot(...bone.gate.dir) < 1e-8)
      ctx.addIssue({ code: "custom", path: ["skeleton", i, "gate"], message: "Gate direction must be nonzero" });
    seen.add(bone.name);
  }
  if (!config.skeleton.some(b => b.deform)) ctx.addIssue({ code: "custom", message: "At least one deform bone is required" });
});
export const rigConfigSchema = z.union([humanoidConfigSchema, templateConfigSchema]);
export type RigConfig = z.infer<typeof rigConfigSchema>;
export type TemplateRigConfig = Extract<RigConfig, { preset: "template" }>;
