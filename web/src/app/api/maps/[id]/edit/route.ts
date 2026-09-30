import { z } from "zod";
import { COMPRESS_LEVELS } from "@/lib/config";
import { jsonError, withUser } from "@/server/http";
import { editMap, toMapDTO } from "@/server/maps";

type Ctx = { params: Promise<{ id: string }> };

const body = z.union([
  z.object({ removeProps: z.array(z.number().int().nonnegative()).min(1).max(10_000) }),
  z.object({ compress: z.enum(COMPRESS_LEVELS) }),
  z.object({ restore: z.literal(true) }),
]);

// Edits a finished map in place: remove props, compress, or restore the original scene.
export const POST = withUser<Ctx>(async (req, user, { params }) => {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const map = await editMap(user.id, id, parsed.data);
  return map ? Response.json(await toMapDTO(map)) : jsonError("Not found", 404);
});
