import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class InsufficientCreditsError extends Error {
  constructor() {
    super("Not enough credits");
  }
}

/** Atomically debit credits inside an existing transaction. Throws if balance too low. */
export async function debitCredits(tx: Tx, userId: string, amount: number, generationId: string) {
  const rows = await tx
    .update(schema.user)
    .set({ credits: sql`${schema.user.credits} - ${amount}` })
    .where(and(eq(schema.user.id, userId), gte(schema.user.credits, amount)))
    .returning({ credits: schema.user.credits });
  if (rows.length === 0) throw new InsufficientCreditsError();
  await tx.insert(schema.creditLedger).values({
    id: crypto.randomUUID(),
    userId,
    delta: -amount,
    reason: "generation",
    generationId,
  });
  return rows[0].credits;
}

/**
 * Credit a user. Idempotent when `paymentOrderId` (purchase) or `generationId` with reason
 * "refund" is supplied — relies on the unique indexes on credit_ledger.
 * Returns false if the grant was already applied.
 */
export async function grantCredits(
  input: {
    userId: string;
    amount: number;
    reason: "signup_bonus" | "purchase" | "refund" | "admin";
    paymentOrderId?: string;
    generationId?: string;
  },
  tx?: Tx,
): Promise<boolean> {
  const run = async (t: Tx) => {
    const inserted = await t
      .insert(schema.creditLedger)
      .values({
        id: crypto.randomUUID(),
        userId: input.userId,
        delta: input.amount,
        reason: input.reason,
        paymentOrderId: input.paymentOrderId,
        generationId: input.generationId,
      })
      .onConflictDoNothing()
      .returning({ id: schema.creditLedger.id });
    if (inserted.length === 0) return false;
    await t
      .update(schema.user)
      .set({ credits: sql`${schema.user.credits} + ${input.amount}` })
      .where(eq(schema.user.id, input.userId));
    return true;
  };
  return tx ? run(tx) : db.transaction(run);
}
