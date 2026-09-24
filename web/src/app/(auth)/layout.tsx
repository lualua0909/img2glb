import Link from "next/link";
import { Suspense } from "react";
import { GradientBackdrop } from "@/components/backdrop";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Logo } from "@/components/logo";
import { getT } from "@/lib/i18n/server";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  const t = await getT();
  return (
    <main className="relative isolate flex min-h-screen flex-col items-center justify-center px-4 py-16">
      <GradientBackdrop />
      <LanguageSwitcher className="absolute top-4 right-4" />
      <Logo className="mb-8 text-lg" />
      <Suspense>{children}</Suspense>
      <nav className="mt-8 flex gap-5 text-xs font-medium text-muted-foreground">
        <Link href="/terms" className="hover:text-foreground">
          {t.site.terms}
        </Link>
        <Link href="/privacy" className="hover:text-foreground">
          {t.site.privacy}
        </Link>
      </nav>
    </main>
  );
}
