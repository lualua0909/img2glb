CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'cancelled');--> statement-breakpoint
CREATE TABLE "payment_order" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"user_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"credits" integer NOT NULL,
	"amount" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_order_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "payment_order_id" text;--> statement-breakpoint
ALTER TABLE "payment_order" ADD CONSTRAINT "payment_order_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_order_user_idx" ON "payment_order" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_order_status_idx" ON "payment_order" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_payment_order_uq" ON "credit_ledger" USING btree ("payment_order_id");