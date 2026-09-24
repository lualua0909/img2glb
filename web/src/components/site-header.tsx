import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getT } from "@/lib/i18n/server";
import { LanguageSwitcher } from "./language-switcher";
import { Logo } from "./logo";

/** Marketing header for public pages. Section links point at the landing page. */
export async function SiteHeader() {
  const t = await getT();
  const links = [
    { href: "/#features", label: t.site.features },
    { href: "/#how", label: t.site.howItWorks },
    { href: "/#pricing", label: t.site.pricing },
    { href: "/#faq", label: t.site.faq },
  ];
  return (
    <header className="glass sticky top-0 z-30 border-b border-black/5">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Logo />
        <nav className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-full px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">
          <LanguageSwitcher />
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/sign-in">{t.site.signIn}</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/sign-up">{t.site.startFree}</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
