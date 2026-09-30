import { ACCEPTED_IMAGE_TYPES, MAP_MAX_UPLOAD_BYTES } from "@/lib/config";
import { createMap, toMapDTO } from "@/server/maps";
import { jsonError, withUser } from "@/server/http";

const TOO_LARGE = `Image too large (max ${MAP_MAX_UPLOAD_BYTES / 1024 / 1024} MB)`;

export const POST = withUser(async (req, user) => {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAP_MAX_UPLOAD_BYTES + 64 * 1024) return jsonError(TOO_LARGE, 413);
  const form = await req.formData();
  const file = form.get("image");
  if (!(file instanceof File)) return jsonError("Image is required", 400);
  if (file.size > MAP_MAX_UPLOAD_BYTES) return jsonError(TOO_LARGE, 413);
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) return jsonError("Unsupported image type", 415);
  const name = String(form.get("name") ?? "").trim().slice(0, 80) || file.name.replace(/\.[^.]+$/, "").slice(0, 80);
  const map = await createMap(user.id, { bytes: new Uint8Array(await file.arrayBuffer()) }, name);
  return Response.json(await toMapDTO(map), { status: 201 });
});
