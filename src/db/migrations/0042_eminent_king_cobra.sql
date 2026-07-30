CREATE TABLE "expensive_operation_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expensive_operation_leases_kind_check" CHECK ("expensive_operation_leases"."kind" IN ('import', 'export', 'backup', 'snapshot')),
	CONSTRAINT "expensive_operation_leases_pair_check" CHECK (("expensive_operation_leases"."lease_token" IS NULL) = ("expensive_operation_leases"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "expensive_operation_leases" ADD CONSTRAINT "expensive_operation_leases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expensive_operation_leases_user_kind_uq" ON "expensive_operation_leases" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "expensive_operation_leases_expiry_idx" ON "expensive_operation_leases" USING btree ("lease_expires_at");