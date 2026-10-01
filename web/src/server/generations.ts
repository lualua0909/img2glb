import "server-only";
import { and, asc, count, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  type CompressLevel,
  generationCost,
  MAX_TEXTURE_SIZE,
  type Quality,
  type TextureCleanLevel,
  type UseCase,
  type ViewName,
} from "@/lib/config";
import { db, schema } from "@/lib/db";
import type {
  CompressInfo,
  Generation,
  GenerationStats,
  MultiViewOptions,
  RefineOptions,
  RigInfo,
  TextureCleanInfo,
} from "@/lib/db/schema";
import { isLocal } from "@/lib/env";
import { getProvider, PROVIDER } from "@/lib/providers";
import { generationTimeoutMinutes } from "@/lib/generation-timeout";
import type { StartInput } from "@/lib/providers/types";
import type { AppSettings } from "@/lib/settings";
import { debitCredits, grantCredits } from "./credits";
import { getSettings } from "./settings";
import { compressGlb } from "./compress";
import { cleanGlbTextures } from "./texture-clean";
import { copyObject, deleteObjects, fetchBytes, keys, putObject, readObject, signedFileUrl, signedGetUrl } from "./storage";

export class UserFacingError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const ACTIVE = ["queued", "processing"] as const;
const LEASE_SECONDS = 90;

export type CreateInput = {
  mode: "image" | "text";
  prompt?: string;
  image?: { bytes: Uint8Array; contentType: string };
  textured: boolean;
  quality: Quality;
  useCase: UseCase;
  seed?: number;
  faceCount?: number;
  /** Texture size cap in px; omitted or MAX_TEXTURE_SIZE = engine native size. */
  textureSize?: number;
  flatShading?: boolean;
  /** Extra views of the object in `image` (image mode only). */
  views?: Partial<Record<ViewName, { bytes: Uint8Array; contentType: string }>>;
  multiview?: Omit<MultiViewOptions, "keys">;
};

export function sniffImageType(b: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return null;
}

export async function createGeneration(userId: string, input: CreateInput): Promise<Generation> {
  const settings = await getSettings();
  if (settings.generation.paused) throw new UserFacingError(settings.generation.pausedMessage, 503);
  const id = crypto.randomUUID();

  let inputImageKey: string | null = null;
  if (input.mode === "image") {
    const kind = input.image && sniffImageType(input.image.bytes);
    if (!input.image || !kind) throw new UserFacingError("Upload a PNG, JPEG or WebP image");
    inputImageKey = keys.input(userId, id, kind === "jpeg" ? "jpg" : kind);
    await putObject(inputImageKey, input.image.bytes);
  }

  let multiview: MultiViewOptions | null = null;
  const views = Object.entries(input.views ?? {}) as [ViewName, { bytes: Uint8Array }][];
  if (views.length || input.multiview?.wingSheets) {
    if (input.mode !== "image") throw new UserFacingError("Extra views and wing sheets need an image");
    const viewKeys: MultiViewOptions["keys"] = {};
    for (const [name, view] of views) {
      const kind = sniffImageType(view.bytes);
      if (!kind) throw new UserFacingError("Upload a PNG, JPEG or WebP image");
      viewKeys[name] = keys.view(userId, id, name, kind === "jpeg" ? "jpg" : kind);
      await putObject(viewKeys[name], view.bytes);
    }
    multiview = { candidates: 1, omni: false, paintAllViews: false, ...input.multiview, keys: viewKeys };
    if (!views.length) Object.assign(multiview, { candidates: 1, omni: false, paintAllViews: false });
  }

  return submitGeneration(settings, {
    id,
    userId,
    mode: input.mode,
    prompt: input.prompt ?? null,
    inputImageKey,
    textured: input.textured,
    quality: input.quality,
    useCase: input.useCase,
    seed: input.seed ?? Math.floor(Math.random() * 2 ** 31),
    faceCount: input.faceCount ?? settings.faceCount[input.useCase],
    textureSize: input.textureSize && input.textureSize < MAX_TEXTURE_SIZE ? input.textureSize : null,
    flatShading: input.flatShading ?? false,
    multiview,
    cost: isLocal() ? 0 : generationCost({ ...input, multiview }, settings.credits),
    provider: PROVIDER,
  });
}

/** Storage keys of a generation's uploaded files (input image and extra views). */
function inputKeys(g: Pick<Generation, "inputImageKey" | "multiview">): string[] {
  return [g.inputImageKey, ...Object.values(g.multiview?.keys ?? {})].filter((k): k is string => Boolean(k));
}

/** Retry a failed job using its stored input and settings. Keep the failed attempt for history. */
export async function retryGeneration(userId: string, generationId: string): Promise<Generation> {
  const source = await getUserGeneration(userId, generationId);
  if (!source) throw new UserFacingError("Not found", 404);
  if (source.status !== "failed") throw new UserFacingError("Only failed generations can be retried", 409);
  if (source.refine) {
    if (!source.parentId) throw new UserFacingError("Original model is missing", 409);
    return createRefinement(userId, source.parentId, source.refine);
  }

  const settings = await getSettings();
  if (settings.generation.paused) throw new UserFacingError(settings.generation.pausedMessage, 503);
  if (source.mode === "image" && !source.inputImageKey)
    throw new UserFacingError("Reference image is missing", 409);
  const id = crypto.randomUUID();
  const inputImageKey = source.inputImageKey ? keys.input(userId, id, source.inputImageKey.split(".").pop()!) : null;
  if (source.inputImageKey && inputImageKey) await copyObject(source.inputImageKey, inputImageKey);
  let multiview: MultiViewOptions | null = null;
  if (source.multiview) {
    const viewKeys: MultiViewOptions["keys"] = {};
    for (const [name, key] of Object.entries(source.multiview.keys) as [ViewName, string][]) {
      viewKeys[name] = keys.view(userId, id, name, key.split(".").pop()!);
      await copyObject(key, viewKeys[name]);
    }
    multiview = { ...source.multiview, keys: viewKeys };
  }

  return submitGeneration(settings, {
    id,
    userId,
    mode: source.mode,
    prompt: source.prompt,
    inputImageKey,
    textured: source.textured,
    quality: source.quality,
    useCase: source.useCase,
    seed: source.seed,
    faceCount: source.faceCount,
    textureSize: source.textureSize,
    flatShading: source.flatShading,
    multiview,
    cost: isLocal() ? 0 : generationCost(source, settings.credits),
    parentId: source.id,
    rootId: source.rootId ?? source.id,
    provider: PROVIDER,
  });
}

/** Image guidance for the edit per strength: lower lets the instruction change more of the reference image. */
const EDIT_IMAGE_GUIDANCE: Record<RefineOptions["strength"], number> = { subtle: 2.5, balanced: 2.0, strong: 1.5 };

/**
 * New version of a finished model: the worker edits its reference image with the user's instruction, then
 * rebuilds the model from it (same seed and settings), or only repaints the texture when `keepShape` is set.
 */
export async function createRefinement(userId: string, parentId: string, refine: RefineOptions): Promise<Generation> {
  const settings = await getSettings();
  if (settings.generation.paused) throw new UserFacingError(settings.generation.pausedMessage, 503);
  const parent = await getUserGeneration(userId, parentId);
  if (!parent) throw new UserFacingError("Not found", 404);
  if (parent.status !== "succeeded" || !parent.modelKey) throw new UserFacingError("Model is not ready", 409);
  if (!parent.inputImageKey) throw new UserFacingError("This model has no reference image to refine", 409);

  // Start from a copy of the parent's reference image; the worker's edited image replaces it when done.
  const id = crypto.randomUUID();
  const inputImageKey = keys.input(userId, id, parent.inputImageKey.split(".").pop()!);
  await copyObject(parent.inputImageKey, inputImageKey);
  const textured = parent.textured || refine.keepShape; // keeping the shape only changes the texture

  return submitGeneration(
    settings,
    {
      id,
      userId,
      mode: parent.mode,
      prompt: parent.prompt,
      inputImageKey,
      textured,
      quality: parent.quality,
      useCase: parent.useCase,
      seed: parent.seed,
      faceCount: parent.faceCount,
      textureSize: parent.textureSize,
      flatShading: parent.flatShading,
      cost: isLocal() ? 0 : generationCost({ mode: "image", textured }, settings.credits),
      parentId: parent.id,
      rootId: parent.rootId ?? parent.id,
      refine,
      provider: PROVIDER,
    },
    {
      prompt: refine.prompt,
      imageGuidance: EDIT_IMAGE_GUIDANCE[refine.strength],
      meshUrl: refine.keepShape ? await signedGetUrl(parent.modelKey, { expiresIn: 7 * 24 * 3600 }) : undefined,
    },
  );
}

type NewGeneration = Omit<typeof schema.generation.$inferInsert, "status" | "progressMessage"> & {
  id: string;
  cost: number;
};

/** Debit credits, insert the row and hand the job to the provider. Deletes the row's input files if the insert fails. */
async function submitGeneration(settings: AppSettings, row: NewGeneration, refine?: StartInput["refine"]) {
  const { id, userId, cost } = row;
  const provider = getProvider(row.provider);

  let timeoutMinutes = settings.limits.jobTimeoutMinutes;
  await db.transaction(async (tx) => {
    if (!isLocal()) {
      // Debit first: the row lock on `user` serialises concurrent requests from the same user,
      // so the active-job count below is accurate.
      await debitCredits(tx, userId, cost, id);
      const [{ active }] = await tx
        .select({ active: count() })
        .from(schema.generation)
        .where(and(eq(schema.generation.userId, userId), inArray(schema.generation.status, ACTIVE)));
      const { maxActiveJobsPerUser } = settings.limits;
      if (active >= maxActiveJobsPerUser)
        throw new UserFacingError(`You can run up to ${maxActiveJobsPerUser} generations at once`, 429);
    }

    const [{ ahead }] = await tx.select({ ahead: count() }).from(schema.generation)
      .where(and(eq(schema.generation.provider, provider.name), inArray(schema.generation.status, ACTIVE)));
    timeoutMinutes *= ahead + 1;
    await tx.insert(schema.generation).values({ ...row, provider: provider.name, progressMessage: "Submitting" });
  }).catch(async (err) => {
    await deleteObjects(inputKeys({ inputImageKey: row.inputImageKey ?? null, multiview: row.multiview ?? null })).catch(() => {});
    throw err;
  });

  try {
    const preset = settings.quality[row.quality as Quality];
    const state = await provider.start({
      imageUrl: row.inputImageKey ? await signedGetUrl(row.inputImageKey, { expiresIn: 7 * 24 * 3600 }) : undefined,
      // Text mode sends the prompt; once a reference image exists (refinement), the image is the input.
      prompt: row.inputImageKey ? undefined : (row.prompt ?? undefined),
      textured: row.textured,
      steps: preset.steps,
      octreeResolution: preset.octreeResolution,
      faceCount: row.faceCount ?? settings.faceCount[row.useCase as UseCase],
      textureSize: row.textureSize ?? undefined,
      flatShading: row.flatShading ?? false,
      seed: row.seed,
      guidanceScale: settings.generation.guidanceScale ?? undefined,
      refine,
      multiview: row.multiview
        ? {
            viewUrls: Object.fromEntries(
              await Promise.all(
                Object.entries(row.multiview.keys).map(async ([name, key]) => [
                  name,
                  await signedGetUrl(key, { expiresIn: 7 * 24 * 3600 }),
                ]),
              ),
            ),
            candidates: row.multiview.candidates,
            omni: row.multiview.omni,
            paintAllViews: row.multiview.paintAllViews,
            wingSheets: row.multiview.wingSheets ?? false,
          }
        : undefined,
    });
    const [started] = await db
      .update(schema.generation)
      .set({ status: "processing", providerState: { ...state, timeoutMinutes: generationTimeoutMinutes(settings.limits.jobTimeoutMinutes, { ...state, timeoutMinutes }) }, progressMessage: "In queue" })
      .where(eq(schema.generation.id, id))
      .returning();
    return started;
  } catch (err) {
    console.error(`[generation ${id}] provider start failed`, err);
    await failGeneration(id, "Generation service unavailable.");
    throw new UserFacingError(
      `Generation service is unavailable right now.${cost > 0 ? " Credits refunded —" : ""} Please retry.`,
      503,
    );
  }
}

/** Mark failed and refund exactly once (paid jobs only). */
export async function failGeneration(id: string, reason: string) {
  const error = sql`${reason} || case when ${schema.generation.cost} > 0 then ' Your credits were refunded.' else '' end`;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.generation)
      .set({ status: "failed", error, leaseUntil: null, completedAt: new Date(), progressMessage: null })
      .where(and(eq(schema.generation.id, id), inArray(schema.generation.status, ACTIVE)))
      .returning({ userId: schema.generation.userId, cost: schema.generation.cost });
    if (row && row.cost > 0) await grantCredits({ userId: row.userId, amount: row.cost, reason: "refund", generationId: id }, tx);
  });
}

/** User cancel: fail + refund right away, then stop the worker job (best effort, it is dropped either way). */
export async function cancelGeneration(userId: string, id: string) {
  const gen = await getUserGeneration(userId, id);
  if (!gen) return null;
  if (!ACTIVE.includes(gen.status as (typeof ACTIVE)[number]))
    throw new UserFacingError("This generation is no longer running", 409);
  await failGeneration(id, "Cancelled.");
  if (gen.providerState) {
    try {
      await getProvider(gen.provider).cancel(gen.providerState);
    } catch (err) {
      console.warn(`[generation ${id}] worker cancel failed`, err);
    }
  }
  return (await getUserGeneration(userId, id))!;
}

async function acquireLease(id: string) {
  const [row] = await db
    .update(schema.generation)
    .set({ leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})` })
    .where(
      and(
        eq(schema.generation.id, id),
        inArray(schema.generation.status, ACTIVE),
        or(isNull(schema.generation.leaseUntil), lt(schema.generation.leaseUntil, sql`now()`)),
      ),
    )
    .returning();
  return row;
}

/**
 * Advance a job one step by polling its provider. Safe to call concurrently (lease-guarded)
 * and from anywhere: the status endpoint on each client poll, and the cron sweeper.
 */
export async function advanceGeneration(id: string): Promise<void> {
  const gen = await acquireLease(id);
  if (!gen) return;

  const settings = await getSettings();
  const ageMin = (Date.now() - gen.createdAt.getTime()) / 60_000;
  const timeoutMinutes = generationTimeoutMinutes(settings.limits.jobTimeoutMinutes, gen.providerState);
  if (gen.provider !== PROVIDER) {
    // Job from a removed engine (Hunyuan3D-2.0): never poll a worker that does not know it.
    await failGeneration(id, "Generation provider changed.");
    return;
  }
  if (!gen.providerState) {
    // Crashed between insert and provider submit.
    if (ageMin > 2) await failGeneration(id, "Generation could not be submitted.");
    else await releaseLease(id);
    return;
  }

  try {
    const result = await getProvider(gen.provider).poll(gen.providerState);
    if (result.type === "running") {
      const nextTimeout = generationTimeoutMinutes(settings.limits.jobTimeoutMinutes, {
        ...result.state,
        timeoutMinutes,
      });
      if (ageMin > nextTimeout) {
        await failGeneration(id, "Generation timed out.");
        return;
      }
      await db
        .update(schema.generation)
        .set({
          providerState: { ...result.state, timeoutMinutes: nextTimeout },
          progressMessage: result.message,
          progress: result.progress ?? null,
          leaseUntil: null,
        })
        .where(eq(schema.generation.id, id));
      return;
    }
    if (result.type === "failed") {
      console.warn(`[generation ${id}] provider failed: ${result.error}`);
      await failGeneration(id, "Generation failed. Try a clearer image or another prompt.");
      return;
    }

    const model = await fetchBytes(result.model.url, { headers: result.model.headers });
    if (String.fromCharCode(...model.bytes.slice(0, 4)) !== "glTF") {
      await failGeneration(id, "Provider returned an invalid model.");
      return;
    }
    const modelKey = keys.model(gen.userId, id);
    await putObject(modelKey, model.bytes);

    // Text mode: the concept image becomes the input image. Refinement: the edited image replaces the parent's copy.
    let inputImageKey = gen.inputImageKey;
    if (result.conceptImage && (!inputImageKey || gen.refine)) {
      try {
        const img = await fetchBytes(result.conceptImage.url, { headers: result.conceptImage.headers }, 20 * 1024 * 1024);
        const kind = sniffImageType(img.bytes);
        if (kind) {
          const key = keys.input(gen.userId, id, kind === "jpeg" ? "jpg" : kind);
          await putObject(key, img.bytes);
          if (inputImageKey && inputImageKey !== key) await deleteObjects([inputImageKey]);
          inputImageKey = key;
        }
      } catch (err) {
        console.warn(`[generation ${id}] concept image copy failed`, err); // non-fatal
      }
    }

    await db
      .update(schema.generation)
      .set({
        status: "succeeded",
        modelKey,
        modelBytes: model.bytes.byteLength,
        inputImageKey,
        stats: result.stats ?? null,
        progressMessage: null,
        leaseUntil: null,
        completedAt: new Date(),
      })
      .where(and(eq(schema.generation.id, id), inArray(schema.generation.status, ACTIVE)));
  } catch (err) {
    // Transient (network, provider 5xx, storage): keep job alive; the next poll retries and the
    // timeout above eventually fails + refunds it.
    console.error(`[generation ${id}] advance error`, err);
    if (ageMin > timeoutMinutes) await failGeneration(id, "Generation timed out.");
    else await releaseLease(id);
  }
}

async function releaseLease(id: string) {
  await db.update(schema.generation).set({ leaseUntil: null }).where(eq(schema.generation.id, id));
}

export async function getUserGeneration(userId: string, id: string) {
  return db.query.generation.findFirst({
    where: and(eq(schema.generation.id, id), eq(schema.generation.userId, userId)),
  });
}

/** Saves a model rigged and animated in the browser as a new version (no provider job, no credits). */
export async function createRiggedVersion(userId: string, parentId: string, bytes: Uint8Array, rig: RigInfo) {
  const parent = await getUserGeneration(userId, parentId);
  if (!parent) return null;
  if (parent.status !== "succeeded" || !parent.modelKey) throw new UserFacingError("Model is not ready", 409);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "glTF") throw new UserFacingError("Invalid GLB file");
  return insertVersion(parent, bytes, { rig });
}

/** The stored GLB of a finished model. */
async function readModel(gen: Generation) {
  if (gen.status !== "succeeded" || !gen.modelKey) throw new UserFacingError("Model is not ready", 409);
  return readObject(gen.modelKey).catch((err) => {
    if (err?.code === "ENOENT") throw new UserFacingError("Model file is missing on the server", 404);
    throw err;
  });
}

/** Saves a smaller, lossy copy of a finished model as a new version (no provider job, no credits). */
export async function createCompressedVersion(userId: string, parentId: string, level: CompressLevel) {
  const parent = await getUserGeneration(userId, parentId);
  if (!parent) return null;
  const original = await readModel(parent);
  const bytes = await compressGlb(original, level);
  if (bytes.byteLength >= original.byteLength) throw new UserFacingError("This model is already compressed", 409);
  return insertVersion(parent, bytes, { rig: parent.rig, compress: { level, fromBytes: original.byteLength } });
}

/**
 * Saves a copy of a finished model with cleaned textures (smears, blotches and seam bleeding removed by the worker,
 * see worker/texture_clean.py) as a new version (no credits). Runs on the worker's CPU, next to any GPU job.
 */
export async function createTextureCleanVersion(userId: string, parentId: string, level: TextureCleanLevel) {
  const parent = await getUserGeneration(userId, parentId);
  if (!parent) return null;
  const original = await readModel(parent);
  let bytes: Uint8Array | null;
  try {
    bytes = await cleanGlbTextures(original, level);
  } catch (err) {
    console.error(`[generation ${parentId}] texture clean failed`, err);
    throw new UserFacingError("Texture cleaning service is unavailable right now. Please retry.", 503);
  }
  if (!bytes) throw new UserFacingError("This model has no texture to clean", 409);
  return insertVersion(parent, bytes, { rig: parent.rig, textureClean: { level } });
}

/** Insert a finished version of `parent` holding `bytes` as its model. */
async function insertVersion(
  parent: Generation,
  bytes: Uint8Array,
  extra: { rig: RigInfo | null; compress?: CompressInfo; textureClean?: TextureCleanInfo },
) {
  const { userId } = parent;
  const id = crypto.randomUUID();
  const modelKey = keys.model(userId, id);
  const inputImageKey = parent.inputImageKey ? keys.input(userId, id, parent.inputImageKey.split(".").pop()!) : null;
  await putObject(modelKey, bytes);
  if (parent.inputImageKey && inputImageKey) await copyObject(parent.inputImageKey, inputImageKey);
  try {
    const [row] = await db
      .insert(schema.generation)
      .values({
        id,
        userId,
        mode: parent.mode,
        prompt: parent.prompt,
        inputImageKey,
        textured: parent.textured,
        quality: parent.quality,
        useCase: parent.useCase,
        seed: parent.seed,
        faceCount: parent.faceCount,
        textureSize: parent.textureSize,
        flatShading: parent.flatShading,
        status: "succeeded",
        provider: parent.provider,
        cost: 0,
        modelKey,
        modelBytes: bytes.byteLength,
        parentId: parent.id,
        rootId: parent.rootId ?? parent.id,
        ...extra,
        completedAt: new Date(),
      })
      .returning();
    return row;
  } catch (err) {
    await deleteObjects([modelKey, inputImageKey].filter((k): k is string => Boolean(k))).catch(() => {});
    throw err;
  }
}

/** Replace a finished model with the user's edited copy (hand-painted vertex colors, or flipped upright). */
export async function replaceEditedModel(userId: string, id: string, bytes: Uint8Array) {
  const gen = await getUserGeneration(userId, id);
  if (!gen) return null;
  if (gen.status !== "succeeded" || !gen.modelKey) throw new UserFacingError("Model is not ready", 409);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "glTF") throw new UserFacingError("Invalid GLB file");
  await putObject(gen.modelKey, bytes);
  const [row] = await db
    .update(schema.generation)
    .set({ modelBytes: bytes.byteLength, compress: null }) // the browser re-exports it uncompressed
    .where(eq(schema.generation.id, id))
    .returning();
  return row;
}

export async function deleteGeneration(userId: string, id: string) {
  const gen = await getUserGeneration(userId, id);
  if (!gen) return false;
  if (ACTIVE.includes(gen.status as (typeof ACTIVE)[number]))
    throw new UserFacingError("Wait for the generation to finish before deleting it", 409);
  await deleteObjects([...inputKeys(gen), gen.modelKey].filter((k): k is string => Boolean(k)));
  await db.delete(schema.generation).where(eq(schema.generation.id, id));
  return true;
}

export type GenerationDTO = {
  id: string;
  mode: "image" | "text";
  prompt: string | null;
  status: Generation["status"];
  progressMessage: string | null;
  progress: number | null;
  textured: boolean;
  quality: string;
  useCase: string;
  seed: number;
  cost: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  inputImageUrl: string | null;
  modelUrl: string | null;
  modelDownloadUrl: string | null;
  modelBytes: number | null;
  parentId: string | null;
  rootId: string | null;
  refine: RefineOptions | null;
  rig: RigInfo | null;
  compress: CompressInfo | null;
  textureClean: TextureCleanInfo | null;
  stats: GenerationStats | null;
  /** Extra views it was generated from, with the multi-view options. */
  multiview: (Omit<MultiViewOptions, "keys"> & { viewUrls: Partial<Record<ViewName, string>> }) | null;
};

export function modelBaseName(g: Pick<Generation, "id" | "prompt">) {
  const slug = (g.prompt ?? "model").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${slug || "model"}-${g.id.slice(0, 8)}`;
}

export async function toDTO(g: Generation): Promise<GenerationDTO> {
  return {
    id: g.id,
    mode: g.mode,
    prompt: g.prompt,
    status: g.status,
    progressMessage: g.progressMessage,
    progress: g.progress,
    textured: g.textured,
    quality: g.quality,
    useCase: g.useCase,
    seed: g.seed,
    cost: g.cost,
    error: g.error,
    createdAt: g.createdAt.toISOString(),
    completedAt: g.completedAt?.toISOString() ?? null,
    // Null when the stored file is gone (e.g. deleted from STORAGE_DIR), so the UI shows it as missing.
    inputImageUrl: await signedFileUrl(g.inputImageKey),
    modelUrl: await signedFileUrl(g.modelKey),
    modelDownloadUrl: await signedFileUrl(g.modelKey, { downloadName: `${modelBaseName(g)}.glb` }),
    modelBytes: g.modelBytes,
    parentId: g.parentId,
    rootId: g.rootId,
    refine: g.refine,
    rig: g.rig,
    compress: g.compress,
    textureClean: g.textureClean,
    stats: g.stats,
    multiview: g.multiview
      ? {
          candidates: g.multiview.candidates,
          omni: g.multiview.omni,
          paintAllViews: g.multiview.paintAllViews,
          wingSheets: g.multiview.wingSheets,
          viewUrls: Object.fromEntries(
            (
              await Promise.all(
                Object.entries(g.multiview.keys).map(async ([name, key]) => [name, await signedFileUrl(key)] as const),
              )
            ).filter(([, url]) => url),
          ),
        }
      : null,
  };
}

export type VersionDTO = Pick<
  GenerationDTO,
  "id" | "status" | "inputImageUrl" | "refine" | "rig" | "compress" | "textureClean" | "createdAt"
>;

/** Every version of a model (the original and its refinements), oldest first. */
export async function listVersions(userId: string, gen: Generation): Promise<VersionDTO[]> {
  const root = gen.rootId ?? gen.id;
  const rows = await db.query.generation.findMany({
    where: and(
      eq(schema.generation.userId, userId),
      or(eq(schema.generation.id, root), eq(schema.generation.rootId, root)),
    ),
    orderBy: asc(schema.generation.createdAt),
  });
  return Promise.all(
    rows.map(async (g) => ({
      id: g.id,
      status: g.status,
      inputImageUrl: await signedFileUrl(g.inputImageKey),
      refine: g.refine,
      rig: g.rig,
      compress: g.compress,
      textureClean: g.textureClean,
      createdAt: g.createdAt.toISOString(),
    })),
  );
}

/** Cron: advance every active job (covers users who closed the tab). */
export async function sweepActiveGenerations(limit = 50) {
  const active = await db
    .select({ id: schema.generation.id })
    .from(schema.generation)
    .where(inArray(schema.generation.status, ACTIVE))
    .orderBy(schema.generation.createdAt)
    .limit(limit);
  for (const { id } of active) await advanceGeneration(id);
  return active.length;
}
