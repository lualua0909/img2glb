import { z } from "zod";
import { TEXTURE_CLEAN_LEVELS } from "@/lib/config";
import { createTextureCleanVersion, toDTO } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const body = z.object({ level: z.enum(TEXTURE_CLEAN_LEVELS) });

// Saves a copy of a finished model with cleaned textures (no smears or blotches) as a new version.
export const POST = withUser<Ctx>(async (req, user, { params }) => {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const gen = await createTextureCleanVersion(user.id, id, parsed.data.level);
  return gen ? Response.json(await toDTO(gen), { status: 201 }) : jsonError("Not found", 404);
});
