import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { sweepActiveGenerations } from "@/server/generations";

export const maxDuration = 60;

function authorized(req: Request) {
  const secret = env().CRON_SECRET;
  if (!secret) return env().NODE_ENV !== "production" || env().APP_ENV === "local";
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Any scheduler can call it the same way.
export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  const processed = await sweepActiveGenerations();
  return Response.json({ processed });
}
