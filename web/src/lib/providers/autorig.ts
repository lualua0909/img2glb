import "server-only";
import { env } from "@/lib/env";

// Auto-rigging on a self-hosted worker (SkinTokens, CUDA hosts only): a worker job with `rig_url` returns the model
// with a predicted skeleton and skin weights. Workers report whether they can do it in /healthz ("autorig").

export type AutorigJob = {
  status: "queued" | "running" | "completed" | "failed";
  stage?: string | null;
  queue_position?: number;
  error?: string | null;
};

function workers() {
  const e = env();
  const token = e.HUNYUAN_WORKER_TOKEN;
  if (!token) return [];
  return (
    [
      ["hunyuan", e.HUNYUAN_WORKER_URL],
      ["hunyuan21", e.HUNYUAN21_WORKER_URL],
    ] as const
  ).flatMap(([name, url]) => (url ? [{ name, base: url.replace(/\/$/, ""), auth: { Authorization: `Bearer ${token}` } }] : []));
}

const workerByName = (name: string) => workers().find((w) => w.name === name) ?? null;

const g = globalThis as unknown as { __autorig?: { name: string | null; at: number } };

/** Name of a configured worker that can auto-rig, or null (checked at most every 30 s). */
export async function autorigWorker(): Promise<string | null> {
  if (g.__autorig && Date.now() - g.__autorig.at < 30_000) return g.__autorig.name;
  let name: string | null = null;
  for (const w of workers()) {
    try {
      const res = await fetch(`${w.base}/healthz`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
      if (res.ok && (await res.json()).autorig === true) {
        name = w.name;
        break;
      }
    } catch {
      // worker down: try the next one
    }
  }
  g.__autorig = { name, at: Date.now() };
  return name;
}

export async function startAutorig(worker: string, modelUrl: string): Promise<string> {
  const w = workerByName(worker);
  if (!w) throw new Error(`Unknown worker: ${worker}`);
  const res = await fetch(`${w.base}/v1/jobs`, {
    method: "POST",
    headers: { ...w.auth, "Content-Type": "application/json" },
    body: JSON.stringify({ rig_url: modelUrl }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Worker rejected auto-rig job: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** Job status, or null when the worker no longer knows the job (restarted). */
export async function autorigStatus(worker: string, jobId: string): Promise<AutorigJob | null> {
  const w = workerByName(worker);
  if (!w) return null;
  const res = await fetch(`${w.base}/v1/jobs/${encodeURIComponent(jobId)}`, {
    headers: w.auth,
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Worker status error: ${res.status}`);
  return (await res.json()) as AutorigJob;
}

/** The rigged GLB of a completed job. */
export async function autorigModel(worker: string, jobId: string): Promise<Response> {
  const w = workerByName(worker);
  if (!w) throw new Error(`Unknown worker: ${worker}`);
  const res = await fetch(`${w.base}/v1/jobs/${encodeURIComponent(jobId)}/model`, {
    headers: w.auth,
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Worker model error: ${res.status}`);
  return res;
}
