import "server-only";
import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // local = personal use: no credits, limits, billing or geo-block. prod = public SaaS.
    APP_ENV: z.enum(["local", "prod"]).default("prod"),
    APP_URL: z.url(),

    DATABASE_URL: z.url(),

    // HMAC key for signed /api/files URLs. openssl rand -base64 32
    FILE_URL_SECRET: z.string().min(32, "FILE_URL_SECRET must be at least 32 chars"),

    // Firebase Auth (Admin SDK service account). Client config is in NEXT_PUBLIC_FIREBASE_* (src/lib/firebase-client.ts).
    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),

    // Comma-separated emails allowed into the admin CMS (/app/admin).
    ADMIN_EMAILS: z
      .string()
      .default("")
      .transform((v) => v.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)),

    // Uploaded inputs + generated models: plain files under STORAGE_DIR, served by /api/files.
    STORAGE_DIR: z.string().default("../data/outputs"),

    // Generation backend
    HUNYUAN_WORKER_URL: z.url().optional(),
    HUNYUAN_WORKER_TOKEN: z.string().optional(),
    // Second worker running Hunyuan3D-2.1 (ENGINE=2.1, same token), selectable per job in the studio.
    HUNYUAN21_WORKER_URL: z.url().optional(),

    // Billing: VietQR bank transfer, confirmed by an admin. BIN or short code (e.g. 970436 / VCB), see https://api.vietqr.io/v2/banks
    VIETQR_BANK_ID: z.string().optional(),
    VIETQR_ACCOUNT_NO: z.string().optional(),
    VIETQR_ACCOUNT_NAME: z.string().optional(),

    SIGNUP_CREDITS: z.coerce.number().int().min(0).default(10),
    MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().int().min(1).default(2),
    JOB_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(30),

    CRON_SECRET: z.string().min(16).optional(),
  })
  .superRefine((e, ctx) => {
    if (!e.HUNYUAN_WORKER_URL || !e.HUNYUAN_WORKER_TOKEN)
      ctx.addIssue({
        code: "custom",
        path: ["HUNYUAN_WORKER_URL"],
        message: "HUNYUAN_WORKER_URL and HUNYUAN_WORKER_TOKEN are required",
      });
    if (e.APP_ENV === "prod" && e.NODE_ENV === "production" && !e.CRON_SECRET)
      ctx.addIssue({ code: "custom", path: ["CRON_SECRET"], message: "required in production" });
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated server env. Parsed lazily so `next build` works without secrets. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid environment variables:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const isLocal = () => env().APP_ENV === "local";
export const firebaseEnabled = () =>
  Boolean(env().FIREBASE_PROJECT_ID && env().FIREBASE_CLIENT_EMAIL && env().FIREBASE_PRIVATE_KEY);
export const billingEnabled = () => !isLocal() && Boolean(env().VIETQR_BANK_ID && env().VIETQR_ACCOUNT_NO);
