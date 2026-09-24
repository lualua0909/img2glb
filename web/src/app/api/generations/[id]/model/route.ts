import { replaceEditedModel, toDTO } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const MAX_MODEL_BYTES = 50 * 1024 * 1024;

// Saves a model the user edited in the browser — painted or flipped (body = binary GLB).
export const PUT = withUser<Ctx>(async (req, user, { params }) => {
  const { id } = await params;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_MODEL_BYTES) return jsonError("Model too large", 413);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_MODEL_BYTES) return jsonError("Model too large", 413);
  const gen = await replaceEditedModel(user.id, id, bytes);
  return gen ? Response.json(await toDTO(gen)) : jsonError("Not found", 404);
});
