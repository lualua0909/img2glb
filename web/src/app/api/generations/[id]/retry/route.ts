import { retryGeneration, toDTO } from "@/server/generations";
import { withUser } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withUser<Ctx>(async (_req, user, { params }) => {
  const { id } = await params;
  const gen = await retryGeneration(user.id, id);
  return Response.json(await toDTO(gen), { status: 201 });
});
