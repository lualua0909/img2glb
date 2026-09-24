import { z } from "zod";
import { MAX_PROMPT_LENGTH } from "@/lib/config";
import { createRefinement, toDTO } from "@/server/generations";
import { jsonError, withUser } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const body = z.object({
  prompt: z.string().trim().min(3).max(MAX_PROMPT_LENGTH),
  keepShape: z.boolean().default(false),
  strength: z.enum(["subtle", "balanced", "strong"]).default("balanced"),
});

// Starts a refined version of a finished model; returns the new generation.
export const POST = withUser<Ctx>(async (req, user, { params }) => {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const gen = await createRefinement(user.id, id, parsed.data);
  return Response.json(await toDTO(gen), { status: 201 });
});
