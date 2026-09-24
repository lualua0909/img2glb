import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { CREDIT_PACKS, type CreditPackId } from "@/lib/config";
import { env } from "@/lib/env";
import { grantCredits } from "./credits";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Transfer content: letters/digits only so every bank keeps it intact. */
function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "F3D" + Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** Returns the user's pending order for this pack, or creates one. */
export async function getOrCreateOrder(userId: string, packId: CreditPackId) {
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) throw new Error("Unknown pack");
  const existing = await db.query.paymentOrder.findFirst({
    where: and(
      eq(schema.paymentOrder.userId, userId),
      eq(schema.paymentOrder.packId, packId),
      eq(schema.paymentOrder.status, "pending"),
      eq(schema.paymentOrder.amount, pack.priceVnd),
    ),
  });
  if (existing) return existing;
  const [order] = await db
    .insert(schema.paymentOrder)
    .values({ id: crypto.randomUUID(), code: newCode(), userId, packId, credits: pack.credits, amount: pack.priceVnd })
    .returning();
  return order;
}

export async function getOrder(userId: string, id: string) {
  return db.query.paymentOrder.findFirst({
    where: and(eq(schema.paymentOrder.id, id), eq(schema.paymentOrder.userId, userId)),
  });
}

export async function listOrders(userId: string, limit = 10) {
  return db.query.paymentOrder.findMany({
    where: eq(schema.paymentOrder.userId, userId),
    orderBy: desc(schema.paymentOrder.createdAt),
    limit,
  });
}

/** VietQR quick-link image (https://www.vietqr.io) with amount and transfer content pre-filled. */
export function vietQrImageUrl(order: { amount: number; code: string }) {
  const e = env();
  const url = new URL(`https://img.vietqr.io/image/${e.VIETQR_BANK_ID}-${e.VIETQR_ACCOUNT_NO}-compact2.png`);
  url.searchParams.set("amount", String(order.amount));
  url.searchParams.set("addInfo", order.code);
  if (e.VIETQR_ACCOUNT_NAME) url.searchParams.set("accountName", e.VIETQR_ACCOUNT_NAME);
  return url.toString();
}

export function bankInfo() {
  const e = env();
  return { bankId: e.VIETQR_BANK_ID!, accountNo: e.VIETQR_ACCOUNT_NO!, accountName: e.VIETQR_ACCOUNT_NAME ?? "" };
}

// ---------- Admin ----------

export async function listOrdersForAdmin(status: "pending" | "paid", limit = 100) {
  return db
    .select({ order: schema.paymentOrder, email: schema.user.email })
    .from(schema.paymentOrder)
    .innerJoin(schema.user, eq(schema.user.id, schema.paymentOrder.userId))
    .where(eq(schema.paymentOrder.status, status))
    .orderBy(desc(schema.paymentOrder.createdAt))
    .limit(limit);
}

/**
 * Confirm (grant credits) or cancel a pending order. Idempotent: the status guard plus the
 * unique credit_ledger.payment_order_id make a double click a no-op. Returns false if not pending.
 */
export async function resolveOrder(id: string, action: "confirm" | "cancel", adminEmail: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .update(schema.paymentOrder)
      .set({ status: action === "confirm" ? "paid" : "cancelled", resolvedBy: adminEmail, resolvedAt: new Date() })
      .where(and(eq(schema.paymentOrder.id, id), eq(schema.paymentOrder.status, "pending")))
      .returning();
    if (!order) return false;
    if (action === "confirm")
      await grantCredits({ userId: order.userId, amount: order.credits, reason: "purchase", paymentOrderId: order.id }, tx);
    return true;
  });
}
