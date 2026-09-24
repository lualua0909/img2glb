import { z } from "zod";
import { RIG_CATEGORIES } from "@/lib/rig/categories";
import { createRiggedVersion, toDTO } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const MAX_MODEL_BYTES = 80 * 1024 * 1024;

const meta = z.object({
  category: z.enum([...RIG_CATEGORIES, "auto"]), // "auto" = skeleton and skin from the AI auto-rigger
  clips: z.array(z.string().trim().min(1).max(60)).max(100),
});

// Saves a model rigged and animated in the browser (form fields: model = GLB, meta = JSON) as a new version.
export const POST = withUser<Ctx>(async (req, user, { params }) => {
  const { id } = await params;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_MODEL_BYTES + 64 * 1024) return jsonError("Model too large", 413);
  const form = await req.formData();
  const file = form.get("model");
  if (!(file instanceof File)) return jsonError("Model is required", 400);
  if (file.size > MAX_MODEL_BYTES) return jsonError("Model too large", 413);
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("meta") ?? "null"));
  } catch {
    return jsonError("Invalid meta", 400);
  }
  const parsed = meta.safeParse(raw);
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const gen = await createRiggedVersion(user.id, id, new Uint8Array(await file.arrayBuffer()), parsed.data);
  return gen ? Response.json(await toDTO(gen), { status: 201 }) : jsonError("Not found", 404);
});
