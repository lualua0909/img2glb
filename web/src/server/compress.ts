import "server-only";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, draco, prune, resample, simplify, textureCompress, weld } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";
import type { CompressLevel } from "@/lib/config";

/**
 * Textures dominate a generated GLB (PNG, 60-90% of the file), so every level re-encodes them as WebP; geometry
 * is Draco-compressed. "strong" also halves the face count (faceted models, where every face has its own vertices,
 * cannot be reduced and keep theirs).
 */
const PRESETS: Record<CompressLevel, { textureSize: number; quality: number; faceRatio: number }> = {
  light: { textureSize: 2048, quality: 90, faceRatio: 1 },
  balanced: { textureSize: 1024, quality: 80, faceRatio: 1 },
  strong: { textureSize: 512, quality: 75, faceRatio: 0.5 },
};

let io: Promise<NodeIO> | undefined;

function getIO() {
  io ??= (async () => {
    const [encoder, decoder] = await Promise.all([draco3d.createEncoderModule(), draco3d.createDecoderModule()]);
    await MeshoptSimplifier.ready;
    return new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ "draco3d.encoder": encoder, "draco3d.decoder": decoder });
  })();
  io.catch(() => (io = undefined)); // retry next call instead of caching the failure
  return io;
}

/** Smaller GLB of `glb`; keeps skin and animations. */
export async function compressGlb(glb: Uint8Array, level: CompressLevel): Promise<Uint8Array> {
  const preset = PRESETS[level];
  const io = await getIO();
  const doc = await io.readBinary(glb);
  await doc.transform(
    dedup(),
    prune(),
    resample(), // drop redundant animation keyframes
    ...(preset.faceRatio < 1
      ? [weld(), simplify({ simplifier: MeshoptSimplifier, ratio: preset.faceRatio, error: 0.01 })]
      : []),
    textureCompress({
      encoder: sharp,
      targetFormat: "webp",
      quality: preset.quality,
      resize: [preset.textureSize, preset.textureSize],
    }),
    draco(),
  );
  return io.writeBinary(doc);
}
