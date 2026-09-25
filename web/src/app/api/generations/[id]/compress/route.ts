import { z } from "zod";
import { COMPRESS_LEVELS } from "@/lib/config";
import { createCompressedVersion, toDTO } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const body = z.object({ level: z.enum(COMPRESS_LEVELS) });

// Saves a smaller copy of a finished model (WebP textures, Draco geometry) as a new version.
export const POST = withUser<Ctx>(async (req, user, { params }) => {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const gen = await createCompressedVersion(user.id, id, parsed.data.level);
  return gen ? Response.json(await toDTO(gen), { status: 201 }) : jsonError("Not found", 404);
});
