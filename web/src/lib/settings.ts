// Admin-editable runtime settings (client + server safe). Stored in the `app_setting` table and
// edited at /app/admin; built-in values from config.ts / env are the defaults.
import { z } from "zod";
import { CREDIT_COST, MAX_FACE_COUNT, MIN_FACE_COUNT, QUALITY_PRESETS, USE_CASES, type Quality, type UseCase } from "./config";

const QUALITY_IDS = Object.keys(QUALITY_PRESETS) as [Quality, ...Quality[]];
const USE_CASE_IDS = USE_CASES.map((u) => u.id) as [UseCase, ...UseCase[]];
export const PROVIDERS = ["hunyuan", "hunyuan21"] as const;

const credit = z.int().min(0).max(1000);
const preset = z.object({
  label: z.string().trim().min(1).max(20),
  hint: z.string().trim().max(60),
  steps: z.int().min(1).max(100),
  octreeResolution: z.int().min(64).max(512),
});

export const settingsSchema = z.object({
  generation: z.object({
    /** Maintenance switch: reject new generations with `pausedMessage`. */
    paused: z.boolean(),
    pausedMessage: z.string().trim().max(200),
    provider: z.enum(PROVIDERS),
    /** null = worker default (5.0). */
    guidanceScale: z.number().min(1).max(20).nullable(),
  }),
  quality: z.record(z.enum(QUALITY_IDS), preset),
  faceCount: z.record(z.enum(USE_CASE_IDS), z.int().min(MIN_FACE_COUNT).max(MAX_FACE_COUNT)),
  credits: z.object({
    shape: credit,
    textured: credit,
    textPrompt: credit,
    signupBonus: z.int().min(0).max(100_000),
  }),
  limits: z.object({
    maxActiveJobsPerUser: z.int().min(1).max(50),
    jobTimeoutMinutes: z.int().min(1).max(24 * 60),
  }),
});

export type AppSettings = z.infer<typeof settingsSchema>;
export type CreditCosts = Pick<AppSettings["credits"], "shape" | "textured" | "textPrompt">;

/** Defaults that come from env on the server. */
export type EnvDefaults = {
  signupBonus: number;
  maxActiveJobsPerUser: number;
  jobTimeoutMinutes: number;
};

export const DEFAULT_PAUSED_MESSAGE = "Generation is paused for maintenance. Please try again later.";

export function defaultSettings(e: EnvDefaults): AppSettings {
  return {
    generation: {
      paused: false,
      pausedMessage: DEFAULT_PAUSED_MESSAGE,
      provider: "hunyuan",
      guidanceScale: null,
    },
    quality: Object.fromEntries(
      QUALITY_IDS.map((q) => {
        const { label, hint, steps, octreeResolution } = QUALITY_PRESETS[q];
        return [q, { label, hint, steps, octreeResolution }];
      }),
    ) as AppSettings["quality"],
    faceCount: Object.fromEntries(USE_CASES.map((u) => [u.id, u.faceCount])) as AppSettings["faceCount"],
    credits: { ...CREDIT_COST, signupBonus: e.signupBonus },
    limits: { maxActiveJobsPerUser: e.maxActiveJobsPerUser, jobTimeoutMinutes: e.jobTimeoutMinutes },
  };
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/** Stored values over defaults, so settings added later get their default. */
export function mergeSettings<T>(defaults: T, stored: unknown): T {
  if (!isPlain(defaults) || !isPlain(stored)) return (stored === undefined ? defaults : stored) as T;
  const out: Plain = { ...defaults };
  for (const [k, v] of Object.entries(stored)) if (k in out) out[k] = mergeSettings(out[k], v);
  return out as T;
}
