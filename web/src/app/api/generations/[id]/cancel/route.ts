import { cancelGeneration, toDTO } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withUser<Ctx>(async (_req, user, { params }) => {
  const { id } = await params;
  const gen = await cancelGeneration(user.id, id);
  return gen ? Response.json(await toDTO(gen)) : jsonError("Not found", 404);
});
