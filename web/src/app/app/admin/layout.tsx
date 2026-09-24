import type { Metadata } from "next";
import { AdminTabs } from "@/components/admin-tabs";
import { getT } from "@/lib/i18n/server";
import { requireAdmin } from "@/server/auth";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.admin };
}

export default async function AdminLayout({ children }: LayoutProps<"/app/admin">) {
  await requireAdmin();
  const t = await getT();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">{t.admin.title}</h1>
        <AdminTabs />
      </div>
      {children}
    </div>
  );
}
