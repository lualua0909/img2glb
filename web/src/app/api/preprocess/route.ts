import { ACCEPTED_IMAGE_TYPES, MAX_UPLOAD_BYTES } from "@/lib/config";
import { getProvider } from "@/lib/providers";
import { jsonError, withUser } from "@/server/http";
import { getSettings } from "@/server/settings";

/** Preprocess an upload with the active provider's worker; the studio previews the result and submits it. */
export const POST = withUser(async (req) => {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) return jsonError("Image too large (max 4 MB)", 413);

  const file = (await req.formData()).get("image");
  if (!(file instanceof File)) return jsonError("Image is required", 400);
  if (file.size > MAX_UPLOAD_BYTES) return jsonError("Image too large (max 4 MB)", 413);
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) return jsonError("Unsupported image type", 415);

  const settings = await getSettings();
  const provider = getProvider(settings.generation.provider);
  if (!provider.preprocess) return new Response(file, { headers: { "Content-Type": file.type } });
  const png = await provider.preprocess(file);
  if (!png) return jsonError("No object found in this image", 422);
  return new Response(png, { headers: { "Content-Type": "image/png" } });
});
