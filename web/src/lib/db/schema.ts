import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------- Users (id = Firebase Auth uid) ----------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  credits: integer("credits").notNull().default(0),
  ...timestamps,
});

// ---------- App tables ----------

export type RefineOptions = {
  /** User's instruction, as typed (the worker translates it to English). */
  prompt: string;
  /** Keep the parent's mesh and only repaint the texture. */
  keepShape: boolean;
  strength: "subtle" | "balanced" | "strong";
};

/** A version rigged and animated in the browser (rig editor). */
export type GenerationStats = Record<string, number>;

export type RigInfo = {
  category: string;
  /** Animation clip names baked into the GLB. */
  clips: string[];
};

export const generationMode = pgEnum("generation_mode", ["image", "text"]);
export const generationStatus = pgEnum("generation_status", ["queued", "processing", "succeeded", "failed"]);

export const generation = pgTable(
  "generation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    mode: generationMode("mode").notNull(),
    prompt: text("prompt"),
    /** Uploaded image (image mode) or generated concept image (text mode). */
    inputImageKey: text("input_image_key"),
    textured: boolean("textured").notNull(),
    quality: text("quality").notNull(),
    useCase: text("use_case").notNull(),
    seed: integer("seed").notNull(),
    /** Target face count sent to the worker; null on rows created before it was stored (use-case default). */
    faceCount: integer("face_count"),
    /** Texture size cap in px; null = engine native size. */
    textureSize: integer("texture_size"),
    /** Faceted (low poly style) shading: every face gets its own vertices and normal. */
    flatShading: boolean("flat_shading").notNull().default(false),
    status: generationStatus("status").notNull().default("queued"),
    progressMessage: text("progress_message"),
    /** Estimated percent done (0-100) reported by the worker while the job runs. */
    progress: integer("progress"),
    provider: text("provider").notNull(),
    /** Opaque provider-specific state (request ids, stage) persisted between polls. */
    providerState: jsonb("provider_state").$type<Record<string, unknown>>(),
    modelKey: text("model_key"),
    modelBytes: integer("model_bytes"),
    cost: integer("cost").notNull(),
    error: text("error"),
    /** Refinement: the version this one was refined from, and the first version of the chain (groups versions). */
    parentId: text("parent_id").references((): AnyPgColumn => generation.id, { onDelete: "set null" }),
    rootId: text("root_id"),
    refine: jsonb("refine").$type<RefineOptions>(),
    rig: jsonb("rig").$type<RigInfo>(),
    /** Worker timings (seconds per stage) and peak memory (GB), reported when the job finishes. */
    stats: jsonb("stats").$type<GenerationStats>(),
    /** Short lease so only one request advances a job at a time. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("generation_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("generation_active_idx").on(t.status).where(sql`${t.status} in ('queued', 'processing')`),
    index("generation_root_idx").on(t.rootId),
  ],
);

export const creditReason = pgEnum("credit_reason", ["signup_bonus", "purchase", "generation", "refund", "admin"]);

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    reason: creditReason("reason").notNull(),
    generationId: text("generation_id"),
    paymentOrderId: text("payment_order_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("credit_ledger_user_idx").on(t.userId, t.createdAt.desc()),
    // Idempotency: one grant per payment order, one refund per generation.
    uniqueIndex("credit_ledger_payment_order_uq").on(t.paymentOrderId),
    uniqueIndex("credit_ledger_refund_uq").on(t.generationId).where(sql`${t.reason} = 'refund'`),
  ],
);

export const paymentStatus = pgEnum("payment_status", ["pending", "paid", "cancelled"]);

/** VietQR bank-transfer order. An admin matches `code` (the transfer content) on the bank statement and confirms it. */
export const paymentOrder = pgTable(
  "payment_order",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    packId: text("pack_id").notNull(),
    credits: integer("credits").notNull(),
    /** VND */
    amount: integer("amount").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    /** Admin email that confirmed or cancelled the order. */
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("payment_order_user_idx").on(t.userId, t.createdAt.desc()),
    index("payment_order_status_idx").on(t.status, t.createdAt.desc()),
  ],
);

/** Admin-editable runtime settings (see src/lib/settings.ts). One row per key; the app uses key "app". */
export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  ...timestamps,
});

export type Generation = typeof generation.$inferSelect;
export type PaymentOrder = typeof paymentOrder.$inferSelect;
