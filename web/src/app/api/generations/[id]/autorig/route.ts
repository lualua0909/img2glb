import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { autorigModel, autorigStatus, autorigWorker, startAutorig } from "@/lib/providers/autorig";
import { getUserGeneration } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";
import { blenderAvailable, blenderModel, blenderStatus, startBlenderRig } from "@/lib/blender/runner";
import { rigConfigSchema } from "@/lib/blender/config";
import { localPath, signedGetUrl } from "@/server/storage";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// Auto-rig with local Blender Rigify, falling back to SkinTokens when Blender is unavailable. The
// editor previews the rigged model with animations and saves it through ../rig as a new version.
//   GET              -> { available }
//   POST             -> { job }                       start; `job` is a token bound to this user and model
//   GET ?job=…       -> { status, message, error }    status: queued | running | completed | failed
//   GET ?job=…&model -> rigged GLB (completed jobs)

const sign = (userId: string, genId: string, worker: string, jobId: string) =>
  createHmac("sha256", env().FILE_URL_SECRET).update(`autorig\n${userId}\n${genId}\n${worker}\n${jobId}`).digest("base64url");

function parseJob(token: string, userId: string, genId: string) {
  const [worker, jobId, sig] = token.split(".");
  if (!worker || !/^[0-9a-f]{32}$/.test(jobId ?? "") || !sig) return null;
  const want = Buffer.from(sign(userId, genId, worker, jobId));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? { worker, jobId } : null;
}

export const GET = withUser<Ctx>(async (req, user, { params }) => {
  const { id } = await params;
  const gen = await getUserGeneration(user.id, id);
  if (!gen) return jsonError("Not found", 404);
  const url = new URL(req.url);
  const token = url.searchParams.get("job");
  if (!token) {
    const blender = await blenderAvailable();
    return Response.json({ available: blender || (await autorigWorker()) !== null, provider: blender ? "blender" : "skintokens" });
  }

  const job = parseJob(token, user.id, id);
  if (!job) return jsonError("Not found", 404);
  if (url.searchParams.has("model")) {
    const res = job.worker === "blender" ? await blenderModel(job.jobId) : await autorigModel(job.worker, job.jobId);
    if (!res.ok) return jsonError("Model not ready", res.status);
    return new Response(res.body, { headers: { "Content-Type": "model/gltf-binary", "Cache-Control": "no-store" } });
  }
  const s = job.worker === "blender" ? await blenderStatus(job.jobId) : await autorigStatus(job.worker, job.jobId);
  if (!s) return Response.json({ status: "failed", error: "The rigging service restarted. Please try again." });
  return Response.json({
    status: s.status,
    warnings: "warnings" in s ? s.warnings : [],
    message: s.status === "queued" ? (job.worker === "blender" ? "Waiting for Blender" : `In queue (position ${(("queue_position" in s ? s.queue_position : 0) ?? 0) + 1})`) : (s.stage ?? null),
    error: s.status === "failed" ? (job.worker === "blender" ? s.error : "Auto-rig failed for this model.") : null,
  });
});

export const POST = withUser<Ctx>(async (req, user, { params }) => {
  const { id } = await params;
  const gen = await getUserGeneration(user.id, id);
  if (!gen) return jsonError("Not found", 404);
  if (gen.status !== "succeeded" || !gen.modelKey) return jsonError("Model is not ready", 409);
  let body: unknown;
  try { const text = await req.text(); body = text ? JSON.parse(text) : {}; }
  catch { return jsonError("Invalid JSON", 400); }
  const parsed = rigConfigSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message, 400);
  const worker = await blenderAvailable() ? "blender" : await autorigWorker();
  if (parsed.data.preset === "template" && worker !== "blender")
    return jsonError("Blender with Rigify is required to preserve preset markers", 503);
  if (!worker) return jsonError("Install Blender with Rigify or configure a CUDA auto-rig worker", 501);
  const input = localPath(gen.modelKey);
  if (!input) return jsonError("Invalid model path", 400);
  const jobId = worker === "blender"
    ? await startBlenderRig(input, parsed.data, user.id)
    : await startAutorig(worker, await signedGetUrl(gen.modelKey, { expiresIn: 3600 }));
  if (!jobId) return jsonError("An auto-rig job is already active, or the queue is full", 429);
  return Response.json({ job: `${worker}.${jobId}.${sign(user.id, id, worker, jobId)}` }, { status: 201 });
});
