import { cookies } from "next/headers";
import { z } from "zod";
import { AuthError, createSession, SESSION_COOKIE } from "@/server/auth";
import { jsonError } from "@/server/http";

const body = z.object({ idToken: z.string().min(1) });

/** Sign in: exchange a Firebase ID token for an httpOnly session cookie. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Missing idToken", 400);
  try {
    const { value, options } = await createSession(parsed.data.idToken);
    (await cookies()).set(SESSION_COOKIE, value, options);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return jsonError(err.message, err.status);
    console.error("[auth] session", err);
    return jsonError("Internal server error", 500);
  }
}

/** Sign out. */
export async function DELETE() {
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
