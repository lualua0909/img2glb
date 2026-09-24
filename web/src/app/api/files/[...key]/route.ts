import { readFile } from "node:fs/promises";
import { localPath, verifyLocalUrl } from "@/server/storage";

const TYPES: Record<string, string> = {
  glb: "model/gltf-binary",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

// Serves stored files (STORAGE_DIR). Access is granted by the HMAC-signed URL from signedGetUrl().
export async function GET(req: Request, ctx: RouteContext<"/api/files/[...key]">) {
  const key = (await ctx.params).key.join("/");
  const params = new URL(req.url).searchParams;
  const file = localPath(key);
  if (!file || !verifyLocalUrl(key, params)) return new Response("Forbidden", { status: 403 });

  const body = await readFile(file).catch(() => null);
  if (!body) return new Response("Not found", { status: 404 });
  const dl = params.get("dl");
  return new Response(body, {
    headers: {
      "Content-Type": TYPES[key.split(".").pop()!] ?? "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
      ...(dl ? { "Content-Disposition": `attachment; filename="${dl.replace(/[^\w.-]/g, "_")}"` } : {}),
    },
  });
}
