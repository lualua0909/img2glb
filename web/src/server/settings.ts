import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { defaultSettings, mergeSettings, settingsSchema, type AppSettings } from "@/lib/settings";

const KEY = "app";
// Short in-process cache: settings are read on every generation/poll. Other instances pick up edits within TTL.
const TTL_MS = 5_000;
const g = globalThis as unknown as { __settings?: { value: AppSettings; at: number } };

export function settingsDefaults(): AppSettings {
  const e = env();
  return defaultSettings({
    signupBonus: e.SIGNUP_CREDITS,
    maxActiveJobsPerUser: e.MAX_ACTIVE_JOBS_PER_USER,
    jobTimeoutMinutes: e.JOB_TIMEOUT_MINUTES,
  });
}

export async function getSettings(): Promise<AppSettings> {
  const hit = g.__settings;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const row = await db.query.appSetting.findFirst({ where: eq(schema.appSetting.key, KEY) });
  const parsed = settingsSchema.safeParse(mergeSettings(settingsDefaults(), row?.value));
  if (!parsed.success) console.error("[settings] stored settings invalid, using defaults", parsed.error.issues);
  const value = parsed.success ? parsed.data : settingsDefaults();
  g.__settings = { value, at: Date.now() };
  return value;
}

export async function saveSettings(value: AppSettings, userId: string) {
  await db
    .insert(schema.appSetting)
    .values({ key: KEY, value, updatedBy: userId })
    .onConflictDoUpdate({ target: schema.appSetting.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
  g.__settings = undefined;
}
