import { z } from "zod";
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_FACE_COUNT,
  MAX_PROMPT_LENGTH,
  MAX_UPLOAD_BYTES,
  MIN_FACE_COUNT,
  QUALITY_PRESETS,
  TEXTURE_SIZES,
  USE_CASES,
} from "@/lib/config";
import { PROVIDERS } from "@/lib/settings";
import { createGeneration, toDTO } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";

const fields = z.object({
  mode: z.enum(["image", "text"]),
  prompt: z.string().trim().min(3).max(MAX_PROMPT_LENGTH).optional(),
  textured: z.enum(["true", "false"]).transform((v) => v === "true"),
  quality: z.enum(Object.keys(QUALITY_PRESETS) as [keyof typeof QUALITY_PRESETS]),
  useCase: z.enum(USE_CASES.map((u) => u.id) as [(typeof USE_CASES)[number]["id"]]),
  seed: z.coerce.number().int().min(0).max(2 ** 31 - 1).optional(),
  faceCount: z.coerce.number().int().min(MIN_FACE_COUNT).max(MAX_FACE_COUNT).optional(),
  textureSize: z.coerce
    .number()
    .refine((v) => (TEXTURE_SIZES as readonly number[]).includes(v), "Invalid texture size")
    .optional(),
  flatShading: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  engine: z.enum(PROVIDERS).optional(),
});

export const POST = withUser(async (req, user) => {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) return jsonError("Image too large (max 4 MB)", 413);

  const form = await req.formData();
  const raw = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string" && v !== ""));
  const parsed = fields.safeParse(raw);
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const input = parsed.data;

  let image: { bytes: Uint8Array; contentType: string } | undefined;
  if (input.mode === "image") {
    const file = form.get("image");
    if (!(file instanceof File)) return jsonError("Image is required", 400);
    if (file.size > MAX_UPLOAD_BYTES) return jsonError("Image too large (max 4 MB)", 413);
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type))
      return jsonError("Unsupported image type", 415);
    image = { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type };
  } else if (!input.prompt) {
    return jsonError("Prompt is required", 400);
  }

  const gen = await createGeneration(user.id, {
    mode: input.mode,
    prompt: input.mode === "text" ? input.prompt : undefined,
    image,
    textured: input.textured,
    quality: input.quality,
    useCase: input.useCase,
    seed: input.seed,
    faceCount: input.faceCount,
    textureSize: input.textureSize,
    flatShading: input.flatShading,
    engine: input.engine,
  });
  return Response.json(await toDTO(gen), { status: 201 });
});
