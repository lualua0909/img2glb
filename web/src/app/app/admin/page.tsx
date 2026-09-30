import { AdminSettingsForm } from "@/components/admin-settings-form";
import { env, isLocal } from "@/lib/env";
import { requireAdmin } from "@/server/auth";
import { getSettings, settingsDefaults } from "@/server/settings";

export default async function AdminSettingsPage() {
  await requireAdmin();
  const e = env();
  return (
    <AdminSettingsForm
      initial={await getSettings()}
      defaults={settingsDefaults()}
      local={isLocal()}
      storage={e.STORAGE_DIR}
    />
  );
}
