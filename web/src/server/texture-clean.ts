import "server-only";
import { Primitive, type Texture } from "@gltf-transform/core";
import sharp from "sharp";
import type { TextureCleanLevel } from "@/lib/config";
import { env } from "@/lib/env";
import { getIO } from "./compress";

/** Primitives that sample one base color texture through the same UV set. */
type Group = { texCoord: number; metallicRoughness: Texture | null; prims: Primitive[] };

/**
 * Copy of `glb` with every base color texture (and the metallic-roughness map on the same UVs) cleaned by the
 * worker's texture cleanup (worker/texture_clean.py): per UV chart, so colors never bleed between charts packed
 * side by side in the atlas. Geometry, skin, animations and Draco/WebP compression are kept. Null when the model
 * has no base color texture.
 */
export async function cleanGlbTextures(glb: Uint8Array, level: TextureCleanLevel): Promise<Uint8Array | null> {
  const io = await getIO();
  const doc = await io.readBinary(glb);

  const groups = new Map<Texture, Group>();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const material = prim.getMaterial();
      const texture = material?.getBaseColorTexture();
      if (!material || !texture || prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const texCoord = material.getBaseColorTextureInfo()!.getTexCoord();
      let group = groups.get(texture);
      if (!group) {
        const mr = material.getMetallicRoughnessTexture();
        const sameUv = mr && material.getMetallicRoughnessTextureInfo()!.getTexCoord() === texCoord;
        group = { texCoord, metallicRoughness: sameUv ? mr : null, prims: [] };
        groups.set(texture, group);
      }
      if (texCoord === group.texCoord && prim.getAttribute(`TEXCOORD_${texCoord}`)) group.prims.push(prim);
    }
  }

  const cleanedMr = new Set<Texture>();
  let cleaned = 0;
  for (const [texture, group] of groups) {
    if (!group.prims.length || !texture.getImage()) continue;
    const { uv, indices } = uvTriangles(group.prims, group.texCoord);
    const mr = group.metallicRoughness && !cleanedMr.has(group.metallicRoughness) ? group.metallicRoughness : null;
    const out = await workerClean({
      level,
      base_color: Buffer.from(texture.getImage()!).toString("base64"),
      metallic_roughness: mr?.getImage() ? Buffer.from(mr.getImage()!).toString("base64") : null,
      uv: Buffer.from(uv.buffer).toString("base64"),
      indices: Buffer.from(indices.buffer).toString("base64"),
    });
    await setImage(texture, Buffer.from(out.base_color, "base64"));
    if (mr && out.metallic_roughness) {
      await setImage(mr, Buffer.from(out.metallic_roughness, "base64"));
      cleanedMr.add(mr);
    }
    cleaned++;
  }
  return cleaned ? io.writeBinary(doc) : null;
}

/** UVs (float32 pairs) and triangle corners (uint32) of `prims`, concatenated. */
function uvTriangles(prims: Primitive[], texCoord: number) {
  const uvs: number[] = [];
  const tris: number[] = [];
  const el: number[] = [];
  for (const prim of prims) {
    const attr = prim.getAttribute(`TEXCOORD_${texCoord}`)!;
    const base = uvs.length / 2;
    for (let i = 0; i < attr.getCount(); i++) uvs.push(...attr.getElement(i, el)); // decodes normalized ints
    const idx = prim.getIndices();
    const n = idx ? idx.getCount() : attr.getCount();
    for (let i = 0; i < n - (n % 3); i++) tris.push(base + (idx ? idx.getScalar(i) : i));
  }
  return { uv: new Float32Array(uvs), indices: new Uint32Array(tris) };
}

/** Stores the cleaned PNG, re-encoded to the texture's own format when it was not PNG (e.g. WebP after compression). */
async function setImage(texture: Texture, png: Buffer) {
  const mime = texture.getMimeType();
  if (mime === "image/webp") texture.setImage(new Uint8Array(await sharp(png).webp({ quality: 90 }).toBuffer()));
  else if (mime === "image/jpeg") texture.setImage(new Uint8Array(await sharp(png).jpeg({ quality: 92 }).toBuffer()));
  else texture.setImage(new Uint8Array(png)).setMimeType("image/png");
}

async function workerClean(body: Record<string, string | null>) {
  const { HUNYUAN_WORKER_URL: url, HUNYUAN_WORKER_TOKEN: token } = env();
  if (!url || !token) throw new Error("HUNYUAN_WORKER_URL is not set");
  const res = await fetch(`${url.replace(/\/$/, "")}/v1/texture/clean`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60_000), // 2048 px maps take ~5 s on an M4, 4096 px up to ~20 s
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Worker texture clean failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { base_color: string; metallic_roughness: string | null };
}
