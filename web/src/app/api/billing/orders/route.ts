import { z } from "zod";
import { CREDIT_PACKS } from "@/lib/config";
import { billingEnabled, isLocal } from "@/lib/env";
import { getOrCreateOrder } from "@/server/billing";
import { jsonError, withUser } from "@/server/http";

const body = z.object({ packId: z.enum(CREDIT_PACKS.map((p) => p.id) as [(typeof CREDIT_PACKS)[number]["id"]]) });

/** Creates (or reuses) a pending VietQR bank-transfer order for a credit pack. */
export const POST = withUser(async (req, user) => {
  if (isLocal()) return jsonError("Not found", 404);
  if (!billingEnabled()) return jsonError("Billing is not configured", 503);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid pack", 400);
  const order = await getOrCreateOrder(user.id, parsed.data.packId);
  return Response.json({ id: order.id });
});
