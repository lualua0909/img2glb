"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useI18n } from "./i18n-provider";

export function AdminTabs() {
  const { t } = useI18n();
  const pathname = usePathname();
  const tabs = [
    { href: "/app/admin", label: t.admin.tabs.settings },
    { href: "/app/admin/models", label: t.admin.tabs.models },
    { href: "/app/admin/payments", label: t.admin.tabs.payments },
  ];
  return (
    <nav className="inline-flex h-9 items-center rounded-[10px] bg-secondary p-[2px]">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={cn(
            "flex h-full items-center rounded-[8px] px-3.5 text-[13px] font-semibold transition-all",
            pathname === tab.href
              ? "bg-card text-foreground shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
