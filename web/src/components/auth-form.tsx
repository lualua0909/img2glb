"use client";

import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from "firebase/auth";
import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { createServerSession, firebaseAuth, firebaseConfigured } from "@/lib/firebase-client";
import type { Dictionary } from "@/lib/i18n";
import { useI18n } from "./i18n-provider";

type Mode = "sign-in" | "sign-up" | "forgot";

function errorMessage(err: unknown, t: Dictionary) {
  const code = (err as { code?: string })?.code;
  if (code && t.auth.errors[code]) return t.auth.errors[code];
  return err instanceof Error ? err.message : t.common.somethingWrong;
}

function safeNext(next: string | null) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/app";
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}

function Field({ id, label, aside, children }: { id: string; label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <Label htmlFor={id} className="text-[13px] text-muted-foreground">
          {label}
        </Label>
        {aside}
      </div>
      {children}
    </div>
  );
}

export function AuthForm({ mode }: { mode: Mode }) {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  const done = () => {
    router.push(next);
    router.refresh();
  };
  // Firebase's hosted email action pages send the user back here.
  const continueUrl = () => ({ url: `${window.location.origin}/sign-in` });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void run(async () => {
      const auth = await firebaseAuth();
      if (mode === "sign-in") {
        const { user } = await signInWithEmailAndPassword(auth, email, password);
        if (!user.emailVerified) {
          await sendEmailVerification(user, continueUrl());
          await signOut(auth);
          throw new Error(t.auth.verifyFirst);
        }
        await createServerSession(user);
        done();
      } else if (mode === "sign-up") {
        const { user } = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(user, { displayName: name });
        await sendEmailVerification(user, continueUrl());
        await signOut(auth);
        setNotice(t.auth.checkInbox);
      } else {
        await sendPasswordResetEmail(auth, email, continueUrl()).catch((err) => {
          // Don't reveal whether an account exists.
          if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
        });
        setNotice(t.auth.resetSent);
      }
    });
  }

  function google() {
    void run(async () => {
      const { user } = await signInWithPopup(await firebaseAuth(), new GoogleAuthProvider());
      await createServerSession(user);
      done();
    });
  }

  const header = (
    <div className="text-center">
      <h1 className="text-2xl font-bold tracking-tight">{t.auth.titles[mode]}</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">{t.auth.subtitles[mode]}</p>
    </div>
  );

  if (!firebaseConfigured) {
    return (
      <div className="w-full max-w-[400px] rounded-3xl bg-card p-7 shadow-float ring-1 ring-black/5">
        {header}
        <p className="mt-5 rounded-xl bg-destructive/10 px-3.5 py-3 text-sm text-destructive">{t.auth.notConfigured}</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[400px] rounded-3xl bg-card p-7 shadow-float ring-1 ring-black/5">
      {header}

      {mode === "sign-in" || mode === "sign-up" ? (
        <>
          <Button variant="outline" size="lg" className="mt-6 w-full" disabled={busy} onClick={google}>
            <GoogleIcon />
            {t.auth.google}
          </Button>
          <div className="my-5 flex items-center gap-3 text-xs font-medium text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> {t.auth.or} <span className="h-px flex-1 bg-border" />
          </div>
        </>
      ) : (
        <div className="mt-6" />
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {mode === "sign-up" ? (
          <Field id="name" label={t.auth.name}>
            <Input id="name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        ) : null}
        <Field id="email" label={t.auth.email}>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        {mode !== "forgot" ? (
          <Field
            id="password"
            label={t.auth.password}
            aside={
              mode === "sign-in" ? (
                <Link href="/forgot-password" className="text-xs font-semibold text-primary hover:underline">
                  {t.auth.forgot}
                </Link>
              ) : null
            }
          >
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        ) : null}

        {error ? (
          <p className="flex gap-2 rounded-xl bg-destructive/10 px-3.5 py-3 text-sm text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="flex gap-2 rounded-xl bg-success/10 px-3.5 py-3 text-sm text-success-foreground">
            <CircleCheckIcon className="mt-0.5 size-4 shrink-0" />
            {notice}
          </p>
        ) : null}

        <Button type="submit" size="lg" disabled={busy} className="mt-1 w-full">
          {busy ? <Spinner /> : null}
          {t.auth.submit[mode]}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        {mode === "sign-in" ? (
          <>
            {t.auth.noAccount}{" "}
            <Link href={`/sign-up?next=${encodeURIComponent(next)}`} className="font-semibold text-primary hover:underline">
              {t.auth.signUpFree}
            </Link>
          </>
        ) : (
          <>
            {t.auth.haveAccount}{" "}
            <Link href="/sign-in" className="font-semibold text-primary hover:underline">
              {t.auth.signIn}
            </Link>
          </>
        )}
      </p>
      {mode === "sign-up" ? (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          {t.auth.agreeBefore}
          <Link href="/terms" className="underline">
            {t.auth.agreeLink}
          </Link>
          {t.auth.agreeAfter}
        </p>
      ) : null}
    </div>
  );
}
