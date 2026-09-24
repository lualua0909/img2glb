import "server-only";
import { eq } from "drizzle-orm";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { db, schema } from "@/lib/db";
import { env, firebaseEnabled, isLocal } from "@/lib/env";
import { grantCredits } from "./credits";
import { getSettings } from "./settings";

export const SESSION_COOKIE = "__session";
const SESSION_MAX_AGE_S = 14 * 24 * 60 * 60; // Firebase maximum

export class AuthError extends Error {
  constructor(
    message: string,
    public status = 401,
  ) {
    super(message);
  }
}

function adminAuth() {
  if (!firebaseEnabled()) throw new AuthError("Firebase Auth is not configured", 503);
  const e = env();
  const app =
    getApps()[0] ??
    initializeApp({
      credential: cert({
        projectId: e.FIREBASE_PROJECT_ID,
        clientEmail: e.FIREBASE_CLIENT_EMAIL,
        privateKey: e.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
      }),
    });
  return getAuth(app);
}

/**
 * Exchanges a fresh Firebase ID token for a session cookie value and upserts the user row
 * (id = Firebase uid). New users get the sign-up bonus.
 */
export async function createSession(idToken: string) {
  const auth = adminAuth();
  const t = await auth.verifyIdToken(idToken).catch(() => {
    throw new AuthError("Invalid token");
  });
  // Only mint a session cookie from a recent sign-in.
  if (Date.now() / 1000 - t.auth_time > 5 * 60) throw new AuthError("Sign in again");
  if (!t.email) throw new AuthError("Account has no email", 400);
  if (!t.email_verified) throw new AuthError("Verify your email first — check your inbox.", 403);

  const profile = {
    email: t.email.toLowerCase(),
    name: (t.name as string | undefined) ?? t.email.split("@")[0],
    image: (t.picture as string | undefined) ?? null,
    emailVerified: true,
  };
  const inserted = await db
    .insert(schema.user)
    .values({ id: t.uid, ...profile })
    .onConflictDoNothing()
    .returning({ id: schema.user.id });
  if (inserted.length > 0) {
    const { signupBonus } = (await getSettings()).credits;
    if (!isLocal() && signupBonus > 0) await grantCredits({ userId: t.uid, amount: signupBonus, reason: "signup_bonus" });
  } else {
    await db.update(schema.user).set(profile).where(eq(schema.user.id, t.uid));
  }

  const value = await auth.createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_S * 1000 });
  return {
    value,
    options: {
      httpOnly: true,
      secure: env().APP_URL.startsWith("https://"),
      sameSite: "lax" as const,
      path: "/",
      maxAge: SESSION_MAX_AGE_S,
    },
  };
}

export const getSession = cache(async () => {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value; // opt into dynamic rendering before touching env/db
  if (!cookie || !firebaseEnabled()) return null;
  const claims = await adminAuth()
    .verifySessionCookie(cookie)
    .catch(() => null);
  if (!claims) return null;
  const user = await db.query.user.findFirst({ where: eq(schema.user.id, claims.uid) });
  return user ? { user } : null;
});

/** For server components/pages: returns the user or redirects to sign-in. */
export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session.user;
}

/** Admins are listed in ADMIN_EMAILS (verified emails only). */
export function isAdmin(user: { email: string; emailVerified: boolean }) {
  return env().ADMIN_EMAILS.includes(user.email.toLowerCase()) && user.emailVerified;
}

/** For admin pages: 404 for everyone else, so the CMS isn't discoverable. */
export async function requireAdmin() {
  const user = await requireUser();
  if (!isAdmin(user)) notFound();
  return user;
}
