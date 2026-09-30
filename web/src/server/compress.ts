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
 * is Draco-compressed. "strong" halves the face count, "ultra" keeps a quarter and "max" a tenth of it (faceted models,
 * where every face has its own vertices, cannot be reduced and keep theirs); "ultra" and "max" also quantize vertices
 * coarser. "max" is where further cuts stop paying off: 128 px textures or 10-bit positions save only a few KB more.
 */
const PRESETS: Record<
  CompressLevel,
  { textureSize: number; quality: number; faceRatio: number; simplifyError?: number; draco?: Parameters<typeof draco>[0] }
> = {
  light: { textureSize: 2048, quality: 90, faceRatio: 1 },
  balanced: { textureSize: 1024, quality: 80, faceRatio: 1 },
  strong: { textureSize: 512, quality: 75, faceRatio: 0.5 },
  ultra: {
    textureSize: 512,
    quality: 60,
    faceRatio: 0.25,
    simplifyError: 0.02,
    draco: { quantizePosition: 12, quantizeNormal: 8, quantizeTexcoord: 10 },
  },
  max: {
    textureSize: 256,
    quality: 50,
    faceRatio: 0.1,
    simplifyError: 0.05,
    draco: { quantizePosition: 11, quantizeNormal: 7, quantizeTexcoord: 10 },
  },
};

let io: Promise<NodeIO> | undefined;

export function getIO() {
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
      ? [weld(), simplify({ simplifier: MeshoptSimplifier, ratio: preset.faceRatio, error: preset.simplifyError ?? 0.01 })]
      : []),
    textureCompress({
      encoder: sharp,
      targetFormat: "webp",
      quality: preset.quality,
      resize: [preset.textureSize, preset.textureSize],
    }),
    draco(preset.draco),
  );
  return io.writeBinary(doc);
}

/**
 * Map scene edit: drops the given top-level prop nodes (glTF node indices, as the browser's GLTFLoader reports them)
 * and prunes meshes/textures no prop uses any more. Draco and WebP survive the round trip. Returns the prop counts left.
 */
export async function removeMapProps(glb: Uint8Array, nodeIndices: number[]) {
  const io = await getIO();
  const doc = await io.readBinary(glb);
  const nodes = doc.getRoot().listNodes();
  for (const i of new Set(nodeIndices)) {
    const node = nodes[i];
    if (node?.getName().startsWith("Props")) node.dispose(); // never terrain, water or collision
  }
  await doc.transform(prune());
  return { bytes: await io.writeBinary(doc), ...mapPropCounts(doc.getRoot().listNodes().map((n) => n.getName())) };
}

/** Prop counts of a map scene. */
export async function countMapProps(glb: Uint8Array) {
  const doc = await (await getIO()).readBinary(glb);
  return mapPropCounts(doc.getRoot().listNodes().map((n) => n.getName()));
}

/** Prop instances ("Props/<variant>#n") and distinct variants among node names. */
function mapPropCounts(names: string[]) {
  const props = names.filter((n) => n.startsWith("Props"));
  return { props: props.length, variants: new Set(props.map((n) => n.split("#")[0])).size };
}
