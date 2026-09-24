import type { Metadata } from "next";
import { Studio } from "@/components/studio";
import { isLocal } from "@/lib/env";
import { configuredProviders } from "@/lib/providers";
import { getT } from "@/lib/i18n/server";
import { requireUser } from "@/server/auth";
import { getCredits } from "@/server/queries";
import { getSettings } from "@/server/settings";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.create };
}

export default async function CreatePage() {
  const user = await requireUser();
  const [credits, { generation, quality, faceCount, credits: costs }] = await Promise.all([
    isLocal() ? null : getCredits(user.id),
    getSettings(),
  ]);
  return (
    <Studio
      credits={credits}
      options={{
        quality,
        faceCount,
        costs,
        pausedMessage: generation.paused ? generation.pausedMessage : null,
        engines: configuredProviders(),
        defaultEngine: generation.provider,
      }}
    />
  );
}
