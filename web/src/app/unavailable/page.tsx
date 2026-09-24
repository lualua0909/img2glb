import { GlobeLockIcon } from "lucide-react";
import type { Metadata } from "next";
import { Logo } from "@/components/logo";
import { APP_NAME } from "@/lib/config";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.unavailable };
}

export default async function UnavailablePage() {
  const t = await getT();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-12 text-center">
      <Logo />
      <div className="flex max-w-md flex-col items-center rounded-3xl bg-card p-8 shadow-soft ring-1 ring-black/[0.04]">
        <span className="grid size-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">
          <GlobeLockIcon className="size-7" />
        </span>
        <h1 className="mt-5 text-2xl font-bold tracking-tight">{t.unavailable.title}</h1>
        <p className="mt-2 text-muted-foreground">{t.unavailable.body(APP_NAME)}</p>
      </div>
    </main>
  );
}
