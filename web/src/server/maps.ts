import "server-only";
import { and, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { type CompressLevel, MAP_COST } from "@/lib/config";
import { db, schema } from "@/lib/db";
import type { MapGeneration, MapStats } from "@/lib/db/schema";
import { env, isLocal, mapsEnabled } from "@/lib/env";
import { compressGlb, countMapProps, removeMapProps } from "./compress";
import { debitCredits, grantCredits } from "./credits";
import { sniffImageType, UserFacingError } from "./generations";
import { getSettings } from "./settings";
import { deleteObjects, fetchBytes, keys, objectExists, putObject, readObject, signedFileUrl, signedGetUrl } from "./storage";

// Game maps: separate from single-object generations (own table, worker and pages). The map worker
// (worker/map) builds the terrain itself and asks the Hunyuan3D worker for every prop variant.

const ACTIVE = ["queued", "processing"] as const;
const LEASE_SECONDS = 90;
/** A map runs a dozen Hunyuan3D jobs back to back; on a Mac that is a couple of hours. */
const TIMEOUT_MINUTES = 6 * 60;

type WorkerJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  stage?: string | null;
  progress?: number;
  queue_position?: number;
  error?: string | null;
  timings?: Record<string, number>;
  stats?: Record<string, number>;
  props?: { done: number; total: number };
};

function worker() {
  const e = env();
  if (!e.MAP_WORKER_URL) throw new UserFacingError("Map generation is not set up on this server", 503);
  const base = e.MAP_WORKER_URL.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${e.MAP_WORKER_TOKEN ?? e.HUNYUAN_WORKER_TOKEN}` };
  const call = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, "Content-Type": "application/json", ...init?.headers },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  return { base, headers, call };
}

export async function createMap(userId: string, image: { bytes: Uint8Array }, name?: string): Promise<MapGeneration> {
  if (!mapsEnabled()) throw new UserFacingError("Map generation is not set up on this server", 503);
  const settings = await getSettings();
  if (settings.generation.paused) throw new UserFacingError(settings.generation.pausedMessage, 503);
  const kind = sniffImageType(image.bytes);
  if (!kind) throw new UserFacingError("Upload a PNG, JPEG or WebP image");

  const id = crypto.randomUUID();
  const inputImageKey = keys.mapInput(userId, id, kind === "jpeg" ? "jpg" : kind);
  await putObject(inputImageKey, image.bytes);
  const cost = isLocal() ? 0 : MAP_COST;

  await db
    .transaction(async (tx) => {
      if (!isLocal()) {
        if (cost > 0) await debitCredits(tx, userId, cost, id);
        const [{ active }] = await tx
          .select({ active: count() })
          .from(schema.mapGeneration)
          .where(and(eq(schema.mapGeneration.userId, userId), inArray(schema.mapGeneration.status, ACTIVE)));
        if (active >= 2) throw new UserFacingError("You can build up to 2 maps at once", 429);
      }
      await tx.insert(schema.mapGeneration).values({ id, userId, name: name ?? null, inputImageKey, cost, progressMessage: "Submitting" });
    })
    .catch(async (err) => {
      await deleteObjects([inputImageKey]).catch(() => {});
      throw err;
    });

  try {
    const res = await worker().call("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({ image_url: await signedGetUrl(inputImageKey, { expiresIn: 24 * 3600 }) }),
    });
    if (!res.ok) throw new Error(`Map worker rejected job: ${res.status} ${await res.text()}`);
    const job = (await res.json()) as WorkerJob;
    const [started] = await db
      .update(schema.mapGeneration)
      .set({ status: "processing", providerState: { jobId: job.id }, progressMessage: "In queue" })
      .where(eq(schema.mapGeneration.id, id))
      .returning();
    return started;
  } catch (err) {
    console.error(`[map ${id}] worker start failed`, err);
    await failMap(id, "Map service unavailable.");
    throw new UserFacingError(`Map service is unavailable right now.${cost > 0 ? " Credits refunded —" : ""} Please retry.`, 503);
  }
}

/** Mark failed and refund exactly once (paid jobs only). */
async function failMap(id: string, reason: string) {
  const error = sql`${reason} || case when ${schema.mapGeneration.cost} > 0 then ' Your credits were refunded.' else '' end`;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.mapGeneration)
      .set({ status: "failed", error, leaseUntil: null, completedAt: new Date(), progressMessage: null })
      .where(and(eq(schema.mapGeneration.id, id), inArray(schema.mapGeneration.status, ACTIVE)))
      .returning({ userId: schema.mapGeneration.userId, cost: schema.mapGeneration.cost });
    if (row && row.cost > 0) await grantCredits({ userId: row.userId, amount: row.cost, reason: "refund", generationId: id }, tx);
  });
}

async function acquireLease(id: string) {
  const [row] = await db
    .update(schema.mapGeneration)
    .set({ leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})` })
    .where(
      and(
        eq(schema.mapGeneration.id, id),
        inArray(schema.mapGeneration.status, ACTIVE),
        or(isNull(schema.mapGeneration.leaseUntil), lt(schema.mapGeneration.leaseUntil, sql`now()`)),
      ),
    )
    .returning();
  return row;
}

const releaseLease = (id: string) =>
  db.update(schema.mapGeneration).set({ leaseUntil: null }).where(eq(schema.mapGeneration.id, id));

/** Advance a map job one step by polling the map worker. Lease-guarded: safe from client polls and the cron sweeper. */
export async function advanceMap(id: string): Promise<void> {
  const map = await acquireLease(id);
  if (!map) return;
  const ageMin = (Date.now() - map.createdAt.getTime()) / 60_000;
  const jobId = map.providerState?.jobId;
  if (!jobId) {
    if (ageMin > 2) await failMap(id, "Map could not be submitted.");
    else await releaseLease(id);
    return;
  }
  if (!mapsEnabled()) {
    await failMap(id, "Map generation was turned off.");
    return;
  }

  try {
    const w = worker();
    const res = await w.call(`/v1/jobs/${encodeURIComponent(String(jobId))}`);
    if (res.status === 404) return void (await failMap(id, "Map worker lost the job (restarted?)."));
    if (!res.ok) throw new Error(`Map worker status error: ${res.status}`);
    const job = (await res.json()) as WorkerJob;

    if (job.status === "queued" || job.status === "running") {
      if (ageMin > TIMEOUT_MINUTES) return void (await failMap(id, "Map generation timed out."));
      const message =
        job.status === "queued"
          ? `In queue (position ${(job.queue_position ?? 0) + 1})`
          : job.stage === "Generating props" && job.props?.total
            ? `Generating props (${job.props.done}/${job.props.total})`
            : (job.stage ?? "Starting");
      await db
        .update(schema.mapGeneration)
        .set({ progressMessage: message, progress: job.progress ?? null, leaseUntil: null })
        .where(eq(schema.mapGeneration.id, id));
      return;
    }
    if (job.status === "failed") {
      console.warn(`[map ${id}] worker failed: ${job.error}`);
      return void (await failMap(id, "Map generation failed. Try an isometric map image on a plain background."));
    }

    const model = await fetchBytes(`${w.base}/v1/jobs/${jobId}/model`, { headers: w.headers }, 400 * 1024 * 1024);
    if (String.fromCharCode(...model.bytes.slice(0, 4)) !== "glTF") return void (await failMap(id, "Map worker returned an invalid scene."));
    const modelKey = keys.mapModel(map.userId, id);
    await putObject(modelKey, model.bytes);
    const stats: MapStats = { ...(job.stats ?? {}), ...Object.fromEntries(Object.entries(job.timings ?? {}).map(([k, v]) => [`t:${k}`, v])) };
    await db
      .update(schema.mapGeneration)
      .set({
        status: "succeeded",
        modelKey,
        modelBytes: model.bytes.byteLength,
        stats,
        progress: 100,
        progressMessage: null,
        leaseUntil: null,
        completedAt: new Date(),
      })
      .where(and(eq(schema.mapGeneration.id, id), inArray(schema.mapGeneration.status, ACTIVE)));
  } catch (err) {
    // Transient (network, worker restart, storage): the next poll retries; the timeout eventually fails it.
    console.error(`[map ${id}] advance error`, err);
    if (ageMin > TIMEOUT_MINUTES) await failMap(id, "Map generation timed out.");
    else await releaseLease(id);
  }
}

export async function getUserMap(userId: string, id: string) {
  return db.query.mapGeneration.findFirst({
    where: and(eq(schema.mapGeneration.id, id), eq(schema.mapGeneration.userId, userId)),
  });
}

export async function listMaps(userId: string, limit = 60) {
  return db.query.mapGeneration.findMany({
    where: eq(schema.mapGeneration.userId, userId),
    orderBy: desc(schema.mapGeneration.createdAt),
    limit,
  });
}

export async function deleteMap(userId: string, id: string) {
  const map = await getUserMap(userId, id);
  if (!map) return false;
  if (ACTIVE.includes(map.status as (typeof ACTIVE)[number]))
    throw new UserFacingError("Wait for the map to finish before deleting it", 409);
  await deleteObjects([map.inputImageKey, map.modelKey, keys.mapOriginal(userId, id)].filter((k): k is string => Boolean(k)));
  await db.delete(schema.mapGeneration).where(eq(schema.mapGeneration.id, id));
  return true;
}

export type MapEdit = { removeProps: number[] } | { compress: CompressLevel } | { restore: true };

/** Edits a finished map in place (no credits). The first edit keeps the worker's scene so `restore` can bring it back. */
export async function editMap(userId: string, id: string, edit: MapEdit) {
  const map = await getUserMap(userId, id);
  if (!map) return null;
  if (map.status !== "succeeded" || !map.modelKey) throw new UserFacingError("Map is not ready", 409);
  const current = await readObject(map.modelKey).catch((err) => {
    if (err?.code === "ENOENT") throw new UserFacingError("Map file is missing on the server", 404);
    throw err;
  });
  const originalKey = keys.mapOriginal(userId, id);
  const hasOriginal = await objectExists(originalKey);

  let bytes: Uint8Array;
  let counts: { props: number; variants: number } | null = null;
  if ("restore" in edit) {
    if (!hasOriginal) throw new UserFacingError("This map has no edits to undo", 409);
    bytes = await readObject(originalKey);
    counts = await countMapProps(bytes);
  } else if ("compress" in edit) {
    bytes = await compressGlb(current, edit.compress);
    if (bytes.byteLength >= current.byteLength) throw new UserFacingError("This map is already compressed", 409);
  } else {
    ({ bytes, ...counts } = await removeMapProps(current, edit.removeProps));
  }

  if (!hasOriginal) await putObject(originalKey, current);
  await putObject(map.modelKey, bytes);
  if ("restore" in edit) await deleteObjects([originalKey]);
  const [row] = await db
    .update(schema.mapGeneration)
    .set({ modelBytes: bytes.byteLength, stats: { ...map.stats, ...counts } })
    .where(eq(schema.mapGeneration.id, id))
    .returning();
  return row;
}

export type MapDTO = {
  id: string;
  name: string | null;
  status: MapGeneration["status"];
  progressMessage: string | null;
  progress: number | null;
  cost: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  inputImageUrl: string | null;
  modelUrl: string | null;
  modelDownloadUrl: string | null;
  modelBytes: number | null;
  stats: MapStats | null;
  /** Edited (props removed or compressed); the worker's scene can be restored. */
  edited: boolean;
};

export async function toMapDTO(m: MapGeneration): Promise<MapDTO> {
  const base = `map-${m.id.slice(0, 8)}`;
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    progressMessage: m.progressMessage,
    progress: m.progress,
    cost: m.cost,
    error: m.error,
    createdAt: m.createdAt.toISOString(),
    completedAt: m.completedAt?.toISOString() ?? null,
    inputImageUrl: await signedFileUrl(m.inputImageKey),
    modelUrl: await signedFileUrl(m.modelKey),
    modelDownloadUrl: await signedFileUrl(m.modelKey, { downloadName: `${base}.glb` }),
    modelBytes: m.modelBytes,
    stats: m.stats,
    edited: await objectExists(keys.mapOriginal(m.userId, m.id)),
  };
}

/** Cron: advance every active map job (covers users who closed the tab). */
export async function sweepActiveMaps(limit = 20) {
  const active = await db
    .select({ id: schema.mapGeneration.id })
    .from(schema.mapGeneration)
    .where(inArray(schema.mapGeneration.status, ACTIVE))
    .orderBy(schema.mapGeneration.createdAt)
    .limit(limit);
  for (const { id } of active) await advanceMap(id);
  return active.length;
}
