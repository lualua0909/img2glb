import { getUserGeneration, listVersions } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

// The original model and all its refinements, oldest first.
export const GET = withUser<Ctx>(async (_req, user, { params }) => {
  const { id } = await params;
  const gen = await getUserGeneration(user.id, id);
  if (!gen) return jsonError("Not found", 404);
  return Response.json(await listVersions(user.id, gen), { headers: { "Cache-Control": "no-store" } });
});
