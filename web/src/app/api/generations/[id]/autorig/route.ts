import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { autorigModel, autorigStatus, autorigWorker, startAutorig } from "@/lib/providers/autorig";
import { getUserGeneration } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";
import { signedGetUrl } from "@/server/storage";

type Ctx = { params: Promise<{ id: string }> };

// AI auto-rig of a finished model (SkinTokens on a CUDA worker), used by the rig editor. Nothing is saved here: the
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
  if (!token) return Response.json({ available: (await autorigWorker()) !== null });

  const job = parseJob(token, user.id, id);
  if (!job) return jsonError("Not found", 404);
  if (url.searchParams.has("model")) {
    const res = await autorigModel(job.worker, job.jobId);
    return new Response(res.body, { headers: { "Content-Type": "model/gltf-binary", "Cache-Control": "no-store" } });
  }
  const s = await autorigStatus(job.worker, job.jobId);
  if (!s) return Response.json({ status: "failed", error: "The rigging service restarted. Please try again." });
  return Response.json({
    status: s.status,
    message: s.status === "queued" ? `In queue (position ${(s.queue_position ?? 0) + 1})` : (s.stage ?? null),
    error: s.status === "failed" ? "Auto-rig failed for this model." : null,
  });
});

export const POST = withUser<Ctx>(async (_req, user, { params }) => {
  const { id } = await params;
  const gen = await getUserGeneration(user.id, id);
  if (!gen) return jsonError("Not found", 404);
  if (gen.status !== "succeeded" || !gen.modelKey) return jsonError("Model is not ready", 409);
  const worker = await autorigWorker();
  if (!worker) return jsonError("Auto-rig needs a CUDA worker", 501);
  const jobId = await startAutorig(worker, await signedGetUrl(gen.modelKey, { expiresIn: 3600 }));
  return Response.json({ job: `${worker}.${jobId}.${sign(user.id, id, worker, jobId)}` }, { status: 201 });
});
