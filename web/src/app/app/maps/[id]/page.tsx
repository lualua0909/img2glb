import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DeleteGenerationButton } from "@/components/delete-generation-button";
import { MapView } from "@/components/map-view";
import { Button } from "@/components/ui/button";
import { getT } from "@/lib/i18n/server";
import { requireUser } from "@/server/auth";
import { getUserMap, toMapDTO } from "@/server/maps";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.map };
}

export default async function MapPage({ params }: PageProps<"/app/maps/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const t = await getT();
  const map = await getUserMap(user.id, id);
  if (!map) notFound();
  const dto = await toMapDTO(map);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="ghost" className="-ml-3 text-primary hover:text-primary">
          <Link href="/app/maps">
            <ChevronLeftIcon className="size-5" />
            {t.maps.back}
          </Link>
        </Button>
        <p className="min-w-0 flex-1 truncate text-center font-semibold">{dto.name}</p>
        <DeleteGenerationButton id={dto.id} kind="map" disabled={dto.status === "queued" || dto.status === "processing"} />
      </div>
      <div className="h-[76vh] min-h-[480px] rounded-3xl bg-card p-2 shadow-soft ring-1 ring-black/[0.04]">
        <MapView key={dto.id} initial={dto} />
      </div>
    </div>
  );
}
