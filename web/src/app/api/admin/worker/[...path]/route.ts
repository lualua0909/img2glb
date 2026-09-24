import { env } from "@/lib/env";
import { jsonError, withAdmin } from "@/server/http";

type Ctx = RouteContext<"/api/admin/worker/[...path]">;

// Forwards admin calls to the GPU worker's /v1/admin/* API (model downloads, config, status),
// so the worker token never reaches the browser. `X-Engine: hunyuan21` targets the Hunyuan3D-2.1 worker.
const forward = withAdmin<Ctx>(async (req, _user, ctx) => {
  const e = env();
  const token = e.HUNYUAN_WORKER_TOKEN;
  const base = req.headers.get("x-engine") === "hunyuan21" ? e.HUNYUAN21_WORKER_URL : e.HUNYUAN_WORKER_URL;
  if (!base || !token) return jsonError("GPU worker not configured (set HUNYUAN_WORKER_URL and HUNYUAN_WORKER_TOKEN)", 503);

  const { path } = await ctx.params;
  if (!path.every((p) => /^[\w.-]+$/.test(p) && p !== "..")) return jsonError("Invalid path", 400);
  const url = `${base.replace(/\/$/, "")}/v1/admin/${path.join("/")}${new URL(req.url).search}`;
  const hasBody = req.method !== "GET" && req.method !== "DELETE";

  try {
    const res = await fetch(url, {
      method: req.method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: hasBody ? await req.text() : undefined,
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return jsonError(`GPU worker unreachable: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
});

export { forward as GET, forward as POST, forward as PUT, forward as DELETE };
