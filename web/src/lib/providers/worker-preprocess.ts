import "server-only";

/** POST /v1/preprocess on a self-hosted worker (Hunyuan worker). */
export async function workerPreprocess(base: string, auth: Record<string, string>, image: Blob) {
  const res = await fetch(`${base}/v1/preprocess`, {
    method: "POST",
    headers: { ...auth, "Content-Type": image.type || "application/octet-stream" },
    body: image,
    signal: AbortSignal.timeout(120_000), // first call loads the background-removal model
    cache: "no-store",
  });
  if (res.status === 422) return null; // unreadable image or no object left after background removal
  if (!res.ok) throw new Error(`Worker preprocess failed: ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}
