import { advanceMap, deleteMap, getUserMap, toMapDTO } from "@/server/maps";
import { jsonError, withUser } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

// Polled by the map page while a job runs; each poll also advances the job.
export const GET = withUser<Ctx>(async (_req, user, { params }) => {
  const { id } = await params;
  let map = await getUserMap(user.id, id);
  if (!map) return jsonError("Not found", 404);
  if (map.status === "queued" || map.status === "processing") {
    await advanceMap(id);
    map = (await getUserMap(user.id, id))!;
  }
  return Response.json(await toMapDTO(map), { headers: { "Cache-Control": "no-store" } });
});

export const DELETE = withUser<Ctx>(async (_req, user, { params }) => {
  const { id } = await params;
  const ok = await deleteMap(user.id, id);
  return ok ? new Response(null, { status: 204 }) : jsonError("Not found", 404);
});
