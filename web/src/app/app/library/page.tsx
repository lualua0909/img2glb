import { BoneIcon, BoxIcon, ImageOffIcon, PlusIcon, TypeIcon, WandSparklesIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DeleteGenerationButton } from "@/components/delete-generation-button";
import { Button } from "@/components/ui/button";
import type { Generation } from "@/lib/db/schema";
import { LOCALE_TAGS } from "@/lib/i18n";
import { getLocale, getT } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth";
import { toDTO } from "@/server/generations";
import { listGenerations } from "@/server/queries";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.library };
}

const STATUS_DOT: Record<string, string> = {
  queued: "bg-muted-foreground/60",
  processing: "bg-primary animate-pulse",
  succeeded: "bg-success",
  failed: "bg-destructive",
};

export default async function LibraryPage() {
  const user = await requireUser();
  const [t, locale] = [await getT(), await getLocale()];
  // One card per model: versions share a rootId; rows are newest first, so the first of each chain is its latest.
  const chains = new Map<string, Generation[]>();
  for (const g of await listGenerations(user.id)) {
    const root = g.rootId ?? g.id;
    chains.set(root, [...(chains.get(root) ?? []), g]);
  }
  const items = await Promise.all(
    [...chains.values()].map(async (chain) => ({ ...(await toDTO(chain[0])), versionCount: chain.length })),
  );

  if (items.length === 0)
    return (
      <div className="grid min-h-[60vh] place-items-center text-center">
        <div className="flex max-w-sm flex-col items-center">
          <span className="grid size-16 place-items-center rounded-[1.25rem] bg-card text-primary shadow-float ring-1 ring-black/5">
            <BoxIcon className="size-8" strokeWidth={1.6} />
          </span>
          <h1 className="mt-5 text-xl font-bold tracking-tight">{t.library.emptyTitle}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{t.library.emptyBody}</p>
          <Button asChild size="lg" className="mt-6">
            <Link href="/app">
              <PlusIcon />
              {t.library.createModel}
            </Link>
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t.library.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.library.count(items.length)}</p>
        </div>
        <Button asChild>
          <Link href="/app">
            <PlusIcon />
            {t.library.newModel}
          </Link>
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((g) => (
          <div key={g.id} className="group relative transition-transform duration-200 hover:-translate-y-0.5">
            <Link
              href={`/app/generations/${g.id}`}
              className="block overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-black/[0.04] transition-shadow duration-200 hover:shadow-float"
            >
              <div className="relative aspect-square bg-stage">
                {g.inputImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={g.inputImageUrl}
                    alt=""
                    className="size-full object-contain p-4 transition-transform duration-300 group-hover:scale-105"
                  />
                ) : (
                  <span className="absolute inset-0 grid place-items-center text-muted-foreground/50">
                    {g.mode === "image" ? <ImageOffIcon className="size-8" /> : <TypeIcon className="size-8" />}
                  </span>
                )}
                <span className="glass absolute top-2 left-2 flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ring-black/5">
                  <span className={cn("size-1.5 rounded-full", STATUS_DOT[g.status])} />
                  {t.library.status[g.status] ?? g.status}
                </span>
                {g.rig ? (
                  <span className="glass absolute top-2 right-2 flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold text-primary ring-1 ring-black/5">
                    <BoneIcon className="size-3" />
                    {t.rig.badge}
                  </span>
                ) : g.refine ? (
                  <span
                    title={g.refine.prompt}
                    className="glass absolute top-2 right-2 flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold text-primary ring-1 ring-black/5"
                  >
                    <WandSparklesIcon className="size-3" />
                    {t.gen.refinedWith}
                  </span>
                ) : null}
              </div>
              <div className="p-3 pr-12">
                <p className="truncate text-sm font-semibold">{g.prompt ?? t.gen.imageTo3d}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {new Date(g.createdAt).toLocaleDateString(LOCALE_TAGS[locale], {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                  {" · "}
                  {g.textured ? t.gen.textured : t.gen.shapeOnly}
                  {g.versionCount > 1 && ` · ${t.library.versionCount(g.versionCount)}`}
                </p>
              </div>
            </Link>
            {g.status !== "queued" && g.status !== "processing" && (
              <DeleteGenerationButton
                id={g.id}
                compact
                className="absolute right-2.5 bottom-3 opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
