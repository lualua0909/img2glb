import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export async function getCredits(userId: string) {
  const row = await db.query.user.findFirst({ where: eq(schema.user.id, userId), columns: { credits: true } });
  return row?.credits ?? 0;
}

export async function listGenerations(userId: string, limit = 60) {
  return db.query.generation.findMany({
    where: eq(schema.generation.userId, userId),
    orderBy: desc(schema.generation.createdAt),
    limit,
  });
}

export async function listActiveGenerationIds(userId: string) {
  const rows = await db.query.generation.findMany({
    where: and(eq(schema.generation.userId, userId), inArray(schema.generation.status, ["queued", "processing"])),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function listLedger(userId: string, limit = 30) {
  return db.query.creditLedger.findMany({
    where: eq(schema.creditLedger.userId, userId),
    orderBy: desc(schema.creditLedger.createdAt),
    limit,
  });
}
