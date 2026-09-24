import { AppNav, MobileTabBar } from "@/components/app-nav";
import { isLocal } from "@/lib/env";
import { isAdmin, requireUser } from "@/server/auth";
import { getCredits, listActiveGenerationIds } from "@/server/queries";

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const user = await requireUser();
  const local = isLocal();
  const credits = local ? null : await getCredits(user.id);
  const admin = isAdmin(user);
  const activeIds = await listActiveGenerationIds(user.id);
  return (
    <div className="flex min-h-screen flex-col">
      <AppNav credits={credits} admin={admin} activeIds={activeIds} name={user.name} email={user.email} />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 pb-28 sm:px-6 md:pb-10">{children}</main>
      <MobileTabBar credits={credits} admin={admin} busy={activeIds.length > 0} />
    </div>
  );
}
