import { settingsSchema } from "@/lib/settings";
import { jsonError, withAdmin } from "@/server/http";
import { getSettings, saveSettings, settingsDefaults } from "@/server/settings";

export const GET = withAdmin(async () =>
  Response.json({ settings: await getSettings(), defaults: settingsDefaults() }),
);

export const PUT = withAdmin(async (req, user) => {
  const parsed = settingsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid settings", 400);
  }
  await saveSettings(parsed.data, user.id);
  return Response.json({ settings: await getSettings() });
});
