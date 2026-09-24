"use client";

import {
  CoinsIcon,
  CreditCardIcon,
  LayoutGridIcon,
  Loader2Icon,
  LogOutIcon,
  Settings2Icon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LOCALE_TAGS } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useI18n } from "./i18n-provider";
import { LanguageSwitcher } from "./language-switcher";
import { Logo } from "./logo";

type NavProps = { credits: number | null; admin: boolean };
type NavLink = { href: string; label: string; icon: LucideIcon; spin?: boolean };

const POLL_MS = 5000;

/** `credits` is null in local mode: billing link and balance are hidden. `busy`: a job is queued/running. */
function useLinks({ credits, admin, busy }: NavProps & { busy: boolean }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const links: NavLink[] = [
    { href: "/app", label: t.nav.create, icon: SparklesIcon },
    { href: "/app/library", label: t.nav.library, icon: busy ? Loader2Icon : LayoutGridIcon, spin: busy },
    ...(credits !== null ? [{ href: "/app/billing", label: t.nav.billing, icon: CreditCardIcon }] : []),
    ...(admin ? [{ href: "/app/admin", label: t.nav.admin, icon: Settings2Icon }] : []),
  ];
  const isActive = (href: string) => (href === "/app" ? pathname === "/app" : pathname.startsWith(href));
  return { links, isActive };
}

export function AppNav({
  credits,
  admin,
  activeIds,
  name,
  email,
}: NavProps & { activeIds: string[]; name: string; email: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { links, isActive } = useLinks({ credits, admin, busy: activeIds.length > 0 });

  // Poll active jobs (which also advances them); re-render the layout once any finishes.
  const activeKey = activeIds.join(",");
  useEffect(() => {
    if (!activeKey) return;
    const timer = setInterval(async () => {
      const done = await Promise.all(
        activeKey.split(",").map(async (id) => {
          const res = await fetch(`/api/generations/${id}`, { cache: "no-store" }).catch(() => null);
          if (!res) return false;
          if (res.status === 404) return true;
          const { status } = await res.json().catch(() => ({}));
          return status !== undefined && status !== "queued" && status !== "processing";
        }),
      );
      if (done.some(Boolean)) router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [activeKey, router]);

  async function signOut() {
    await fetch("/api/auth/session", { method: "DELETE" });
    router.push("/");
    router.refresh();
  }

  return (
    <header className="glass sticky top-0 z-30 border-b border-black/5">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Logo href="/app" />
        <nav className="ml-4 hidden items-center gap-0.5 rounded-full bg-secondary p-1 md:flex">
          {links.map(({ href, label, icon: Icon, spin }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-all",
                isActive(href)
                  ? "bg-card text-foreground shadow-[0_2px_6px_rgba(0,0,0,0.1)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4", spin && "animate-spin")} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          {credits !== null ? (
            <Link
              href="/app/billing"
              className="flex h-8 items-center gap-1.5 rounded-full bg-primary/10 px-3 text-[13px] font-semibold text-primary tabular-nums transition-colors hover:bg-primary/15"
            >
              <CoinsIcon className="size-4" />
              {credits.toLocaleString(LOCALE_TAGS[locale])}
            </Link>
          ) : null}
          <LanguageSwitcher />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={email}
              className="grid size-9 place-items-center rounded-full bg-linear-to-br from-[#5ac8fa] to-[#0071e3] text-sm font-bold text-white uppercase shadow-sm outline-none focus-visible:ring-4 focus-visible:ring-ring/25"
            >
              {(name || email).charAt(0)}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="flex flex-col px-2.5 py-2">
                <span className="truncate text-sm font-semibold text-foreground">{name}</span>
                <span className="truncate text-xs font-normal text-muted-foreground">{email}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {links.slice(2).map(({ href, label, icon: Icon }) => (
                <DropdownMenuItem key={href} asChild>
                  <Link href={href}>
                    <Icon />
                    {label}
                  </Link>
                </DropdownMenuItem>
              ))}
              {links.length > 2 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem variant="destructive" onSelect={signOut}>
                <LogOutIcon />
                {t.nav.signOut}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

/** iOS-style bottom tab bar on small screens. */
export function MobileTabBar(props: NavProps & { busy: boolean }) {
  const { links, isActive } = useLinks(props);
  return (
    <nav className="glass fixed inset-x-0 bottom-0 z-30 border-t border-black/5 pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="mx-auto grid max-w-md auto-cols-fr grid-flow-col">
        {links.map(({ href, label, icon: Icon, spin }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex flex-col items-center gap-1 pt-2 pb-1.5 text-[10px] font-semibold",
              isActive(href) ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Icon className={cn("size-6", spin && "animate-spin")} strokeWidth={isActive(href) ? 2.2 : 1.8} />
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
