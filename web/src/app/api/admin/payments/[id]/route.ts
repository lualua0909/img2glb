import { z } from "zod";
import { resolveOrder } from "@/server/billing";
import { jsonError, withAdmin } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const body = z.object({ action: z.enum(["confirm", "cancel"]) });

/** Confirm (grant credits) or cancel a pending bank-transfer order. */
export const POST = withAdmin<Ctx>(async (req, user, { params }) => {
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid action", 400);
  const ok = await resolveOrder(id, parsed.data.action, user.email);
  return ok ? Response.json({ ok: true }) : jsonError("Order is not pending", 409);
});
