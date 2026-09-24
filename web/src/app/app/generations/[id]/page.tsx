import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DeleteGenerationButton } from "@/components/delete-generation-button";
import { GenerationView } from "@/components/generation-view";
import { Button } from "@/components/ui/button";
import { getT } from "@/lib/i18n/server";
import { requireUser } from "@/server/auth";
import { getUserGeneration, toDTO } from "@/server/generations";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.model };
}

export default async function GenerationPage({ params }: PageProps<"/app/generations/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const t = await getT();
  const gen = await getUserGeneration(user.id, id);
  if (!gen) notFound();
  const dto = await toDTO(gen);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" className="-ml-3 text-primary hover:text-primary">
          <Link href="/app/library">
            <ChevronLeftIcon className="size-5" />
            {t.detail.back}
          </Link>
        </Button>
        <DeleteGenerationButton id={dto.id} disabled={dto.status === "queued" || dto.status === "processing"} />
      </div>
      <div className="h-[72vh] min-h-[440px] rounded-3xl bg-card p-2 shadow-soft ring-1 ring-black/[0.04]">
        <GenerationView key={dto.id} initial={dto} syncUrl />
      </div>
    </div>
  );
}
