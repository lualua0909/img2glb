import { advanceGeneration, deleteGeneration, getUserGeneration, toDTO } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

// Polled by the client while a job runs; each poll also advances the job.
export const GET = withUser<Ctx>(async (_req, user, { params }) => {
  const { id } = await params;
  let gen = await getUserGeneration(user.id, id);
  if (!gen) return jsonError("Not found", 404);
  if (gen.status === "queued" || gen.status === "processing") {
    await advanceGeneration(id);
    gen = (await getUserGeneration(user.id, id))!;
  }
  return Response.json(await toDTO(gen), { headers: { "Cache-Control": "no-store" } });
});

export const DELETE = withUser<Ctx>(async (_req, user, { params }) => {
  const { id } = await params;
  const ok = await deleteGeneration(user.id, id);
  return ok ? new Response(null, { status: 204 }) : jsonError("Not found", 404);
});
