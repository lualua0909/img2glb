import "server-only";
import { and, asc, count, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { type CompressLevel, generationCost, MAX_TEXTURE_SIZE, type Quality, type UseCase } from "@/lib/config";
import { db, schema } from "@/lib/db";
import type { CompressInfo, Generation, GenerationStats, RefineOptions, RigInfo } from "@/lib/db/schema";
import { isLocal } from "@/lib/env";
import { configuredProviders, getProvider } from "@/lib/providers";
import type { StartInput } from "@/lib/providers/types";
import type { AppSettings } from "@/lib/settings";
import { debitCredits, grantCredits } from "./credits";
import { getSettings } from "./settings";
import { compressGlb } from "./compress";
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
  /** Engine for this job (studio picker); omitted = admin default. */
  engine?: AppSettings["generation"]["provider"];
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
    cost: isLocal() ? 0 : generationCost(input, settings.credits),
    provider: pickEngine(input.engine ?? settings.generation.provider),
  });
}

function pickEngine(name: string) {
  if (!configuredProviders().includes(name as AppSettings["generation"]["provider"]))
    throw new UserFacingError(`Engine "${name}" is not configured`, 400);
  return name;
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
      provider: pickEngine(parent.provider), // a refinement runs on the engine that made the parent
    },
    {
      prompt: refine.prompt,
      imageGuidance: EDIT_IMAGE_GUIDANCE[refine.strength],
      meshUrl: refine.keepShape ? await signedGetUrl(parent.modelKey, { expiresIn: 6 * 3600 }) : undefined,
    },
  );
}

type NewGeneration = Omit<typeof schema.generation.$inferInsert, "status" | "progressMessage"> & {
  id: string;
  cost: number;
};

/** Debit credits, insert the row and hand the job to the provider. Deletes `row.inputImageKey` if the insert fails. */
async function submitGeneration(settings: AppSettings, row: NewGeneration, refine?: StartInput["refine"]) {
  const { id, userId, cost } = row;
  const provider = getProvider(row.provider);

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

    await tx.insert(schema.generation).values({ ...row, provider: provider.name, progressMessage: "Submitting" });
  }).catch(async (err) => {
    if (row.inputImageKey) await deleteObjects([row.inputImageKey]).catch(() => {});
    throw err;
  });

  try {
    const preset = settings.quality[row.quality as Quality];
    const state = await provider.start({
      imageUrl: row.inputImageKey ? await signedGetUrl(row.inputImageKey, { expiresIn: 6 * 3600 }) : undefined,
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
    });
    const [started] = await db
      .update(schema.generation)
      .set({ status: "processing", providerState: state, progressMessage: "In queue" })
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
  if (ageMin > settings.limits.jobTimeoutMinutes) {
    await failGeneration(id, "Generation timed out.");
    return;
  }
  if (!(configuredProviders() as string[]).includes(gen.provider)) {
    // Job from a removed or unconfigured engine: never poll a worker that is not configured.
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
      await db
        .update(schema.generation)
        .set({
          providerState: result.state,
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
    await releaseLease(id);
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

/** Saves a smaller, lossy copy of a finished model as a new version (no provider job, no credits). */
export async function createCompressedVersion(userId: string, parentId: string, level: CompressLevel) {
  const parent = await getUserGeneration(userId, parentId);
  if (!parent) return null;
  if (parent.status !== "succeeded" || !parent.modelKey) throw new UserFacingError("Model is not ready", 409);
  const original = await readObject(parent.modelKey).catch((err) => {
    if (err?.code === "ENOENT") throw new UserFacingError("Model file is missing on the server", 404);
    throw err;
  });
  const bytes = await compressGlb(original, level);
  if (bytes.byteLength >= original.byteLength) throw new UserFacingError("This model is already compressed", 409);
  return insertVersion(parent, bytes, { rig: parent.rig, compress: { level, fromBytes: original.byteLength } });
}

/** Insert a finished version of `parent` holding `bytes` as its model. */
async function insertVersion(parent: Generation, bytes: Uint8Array, extra: { rig: RigInfo | null; compress?: CompressInfo }) {
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
  await deleteObjects([gen.inputImageKey, gen.modelKey].filter((k): k is string => Boolean(k)));
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
  engine: string;
  stats: GenerationStats | null;
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
    engine: g.provider,
    stats: g.stats,
  };
}

export type VersionDTO = Pick<GenerationDTO, "id" | "status" | "inputImageUrl" | "refine" | "rig" | "compress" | "createdAt">;

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
