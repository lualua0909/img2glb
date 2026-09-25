// Shared (client + server) product configuration.

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Forma3D";
/** Legal entity operating the service. Hunyuan3D license §3(e) requires disclosing it to end users. */
export const OPERATOR_NAME = process.env.NEXT_PUBLIC_OPERATOR_NAME ?? "Your Company LLC";

export const QUALITY_PRESETS = {
  fast: { label: "Fast", steps: 30, octreeResolution: 256, hint: "Drafts & previews" },
  standard: { label: "Standard", steps: 30, octreeResolution: 256, hint: "Balanced detail" },
  high: { label: "High", steps: 50, octreeResolution: 380, hint: "Max geometry detail" },
} as const;
export type Quality = keyof typeof QUALITY_PRESETS;

export const CREDIT_COST = {
  shape: 1,
  textured: 3,
  textPrompt: 1, // extra: text -> concept image stage
} as const;

/** `costs` comes from admin settings; CREDIT_COST is the default. */
export function generationCost(
  opts: { mode: "image" | "text"; textured: boolean },
  costs: { shape: number; textured: number; textPrompt: number } = CREDIT_COST,
) {
  return (opts.textured ? costs.textured : costs.shape) + (opts.mode === "text" ? costs.textPrompt : 0);
}

/** Prices in VND, paid by VietQR bank transfer. */
export const CREDIT_PACKS = [
  { id: "starter", name: "Starter", credits: 50, priceVnd: 229_000, blurb: "~16 textured models" },
  { id: "pro", name: "Pro", credits: 200, priceVnd: 729_000, blurb: "~66 textured models", featured: true },
  { id: "studio", name: "Studio", credits: 1000, priceVnd: 2_990_000, blurb: "~333 textured models" },
] as const;

export const formatVnd = (amount: number) => `${amount.toLocaleString("vi-VN")}₫`;
export type CreditPackId = (typeof CREDIT_PACKS)[number]["id"];

export const USE_CASES = [
  { id: "game", label: "Game asset", faceCount: 20000, textured: true },
  { id: "print", label: "3D printing", faceCount: 200000, textured: false },
  { id: "ar", label: "AR / Web", faceCount: 40000, textured: true },
  { id: "prototype", label: "Concept / prototype", faceCount: 40000, textured: false },
] as const;
export type UseCase = (typeof USE_CASES)[number]["id"];
/** Bounds for the target face count (mesh reduction cap); matches the worker's validation. */
export const MIN_FACE_COUNT = 1000;
export const MAX_FACE_COUNT = 500_000;

/** Studio shortcuts for the face count; `flat` also switches on faceted (low poly) shading. */
export const MESH_DETAIL_PRESETS = [
  { id: "lowpoly", faceCount: 2_000, flat: true },
  { id: "light", faceCount: 10_000, flat: false },
  { id: "medium", faceCount: 40_000, flat: false },
  { id: "high", faceCount: 150_000, flat: false },
  { id: "max", faceCount: MAX_FACE_COUNT, flat: false },
] as const;
export type MeshDetail = (typeof MESH_DETAIL_PRESETS)[number]["id"];

/** Texture size caps (px); the largest keeps the engine's native size (2.0: 2048, 2.1: 4096). */
export const TEXTURE_SIZES = [512, 1024, 2048, 4096] as const;
export type TextureSize = (typeof TEXTURE_SIZES)[number];
export const MAX_TEXTURE_SIZE: TextureSize = 4096;

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // client downsizes to 1024px before upload
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_PROMPT_LENGTH = 300;

/** "Compress model" levels, lightest loss first (presets in src/server/compress.ts). */
export const COMPRESS_LEVELS = ["light", "balanced", "strong"] as const;
export type CompressLevel = (typeof COMPRESS_LEVELS)[number];
