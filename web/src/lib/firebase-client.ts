import { getApps, initializeApp } from "firebase/app";
import { getAuth, inMemoryPersistence, setPersistence, type User } from "firebase/auth";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

export const firebaseConfigured = Boolean(config.apiKey && config.authDomain && config.projectId);

/** Browser Firebase Auth. The server session cookie is the source of truth, so nothing is persisted client-side. */
export async function firebaseAuth() {
  const auth = getAuth(getApps()[0] ?? initializeApp(config));
  await setPersistence(auth, inMemoryPersistence);
  return auth;
}

/** Exchange the signed-in Firebase user for the app's session cookie. */
export async function createServerSession(user: User) {
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: await user.getIdToken() }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Sign-in failed");
}
