import "server-only";
import type { GenerationProvider, PollResult, ProviderState } from "./types";
import { workerPreprocess } from "./worker-preprocess";

// Self-hosted GPU worker (see /worker in this repo) wrapping the Hunyuan3D-2 or Hunyuan3D-2.1 pipelines.

type WorkerJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  stage?: string;
  progress?: number;
  queue_position?: number;
  error?: string;
  has_concept_image?: boolean;
  timings?: Record<string, number>;
};

export function createHunyuanProvider(opts: { name: string; url: string; token: string }): GenerationProvider {
  const base = opts.url.replace(/\/$/, "");
  const auth = { Authorization: `Bearer ${opts.token}` };

  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...auth, "Content-Type": "application/json", ...init?.headers },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    return res;
  };

  return {
    name: opts.name,

    preprocess: (image) => workerPreprocess(base, auth, image),

    async start(input) {
      const res = await call("/v1/jobs", {
        method: "POST",
        body: JSON.stringify({
          image_url: input.imageUrl,
          prompt: input.prompt,
          texture: input.textured,
          num_inference_steps: input.steps,
          octree_resolution: input.octreeResolution,
          face_count: input.faceCount,
          texture_size: input.textureSize,
          flat_shading: input.flatShading,
          seed: input.seed,
          guidance_scale: input.guidanceScale,
          edit_prompt: input.refine?.prompt,
          edit_image_guidance: input.refine?.imageGuidance,
          mesh_url: input.refine?.meshUrl,
        }),
      });
      if (!res.ok) throw new Error(`Worker rejected job: ${res.status} ${await res.text()}`);
      const job = (await res.json()) as WorkerJob;
      return { jobId: job.id };
    },

    async poll(state: ProviderState): Promise<PollResult> {
      const jobId = String(state.jobId);
      const res = await call(`/v1/jobs/${encodeURIComponent(jobId)}`);
      if (res.status === 404) return { type: "failed", error: "Worker lost the job (restarted?)" };
      if (!res.ok) throw new Error(`Worker status error: ${res.status}`);
      const job = (await res.json()) as WorkerJob;

      switch (job.status) {
        case "queued":
          return { type: "running", state, message: `In queue (position ${(job.queue_position ?? 0) + 1})`, progress: 0 };
        case "running":
          return { type: "running", state, message: job.stage ?? "Generating", progress: job.progress };
        case "failed":
          return { type: "failed", error: job.error ?? "Worker failed" };
        case "completed":
          return {
            type: "completed",
            model: { url: `${base}/v1/jobs/${jobId}/model`, headers: auth },
            conceptImage: job.has_concept_image ? { url: `${base}/v1/jobs/${jobId}/concept`, headers: auth } : undefined,
            stats: job.timings,
          };
      }
    },
  };
}
