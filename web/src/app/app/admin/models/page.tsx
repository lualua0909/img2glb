import { AdminModels } from "@/components/admin-models";
import { env } from "@/lib/env";
import { configuredProviders } from "@/lib/providers";
import { requireAdmin } from "@/server/auth";

export default async function AdminModelsPage() {
  await requireAdmin();
  const e = env();
  return <AdminModels configured={Boolean(e.HUNYUAN_WORKER_URL && e.HUNYUAN_WORKER_TOKEN)} engines={configuredProviders()} />;
}
