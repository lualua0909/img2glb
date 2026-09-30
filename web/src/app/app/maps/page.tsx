import { ImageOffIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DeleteGenerationButton } from "@/components/delete-generation-button";
import { MapUpload } from "@/components/map-upload";
import { mapsEnabled } from "@/lib/env";
import { LOCALE_TAGS } from "@/lib/i18n";
import { getLocale, getT } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth";
import { listMaps, toMapDTO } from "@/server/maps";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.maps };
}

const STATUS_DOT: Record<string, string> = {
  queued: "bg-muted-foreground/60",
  processing: "bg-primary animate-pulse",
  succeeded: "bg-success",
  failed: "bg-destructive",
};

export default async function MapsPage() {
  const user = await requireUser();
  const [t, locale] = [await getT(), await getLocale()];
  const maps = await Promise.all((await listMaps(user.id)).map(toMapDTO));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t.maps.title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t.maps.subtitle}</p>
      </div>
      <MapUpload enabled={mapsEnabled()} />
      {maps.length === 0 ? (
        <div className="py-10 text-center">
          <p className="font-semibold">{t.maps.emptyTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t.maps.emptyBody}</p>
        </div>
      ) : (
        <section className="flex flex-col gap-3">
          <p className="text-sm font-semibold text-muted-foreground">{t.maps.count(maps.length)}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
            {maps.map((m) => (
              <div key={m.id} className="group relative transition-transform duration-200 hover:-translate-y-0.5">
                <Link
                  href={`/app/maps/${m.id}`}
                  className="block overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-black/[0.04] transition-shadow duration-200 hover:shadow-float"
                >
                  <div className="relative aspect-[16/10] bg-stage">
                    {m.inputImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.inputImageUrl} alt="" className="size-full object-cover transition-transform duration-300 group-hover:scale-105" />
                    ) : (
                      <span className="absolute inset-0 grid place-items-center text-muted-foreground/50">
                        <ImageOffIcon className="size-8" />
                      </span>
                    )}
                    <span className="glass absolute top-2 left-2 flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ring-black/5">
                      <span className={cn("size-1.5 rounded-full", STATUS_DOT[m.status])} />
                      {t.library.status[m.status] ?? m.status}
                      {m.status === "processing" && m.progress !== null ? ` · ${m.progress}%` : null}
                    </span>
                  </div>
                  <div className="p-3 pr-12">
                    <p className="truncate text-sm font-semibold">{m.name ?? t.meta.map}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {new Date(m.createdAt).toLocaleDateString(LOCALE_TAGS[locale], { day: "numeric", month: "short", year: "numeric" })}
                      {m.stats?.props !== undefined ? ` · ${t.maps.stats.props}: ${m.stats.props}` : null}
                    </p>
                  </div>
                </Link>
                {m.status !== "queued" && m.status !== "processing" && (
                  <DeleteGenerationButton
                    id={m.id}
                    kind="map"
                    compact
                    className="absolute right-2.5 bottom-3 opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                  />
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
