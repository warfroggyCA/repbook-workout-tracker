CREATE TABLE "data_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"reason" text NOT NULL,
	"source_operation_id" uuid,
	"status" text DEFAULT 'creating' NOT NULL,
	"object_path" text NOT NULL,
	"object_etag" text,
	"app_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"record_counts" jsonb NOT NULL,
	"plaintext_checksum" text NOT NULL,
	"ciphertext_checksum" text,
	"encryption_algorithm" text NOT NULL,
	"encryption_key_version" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_snapshots_status_valid" CHECK ("data_snapshots"."status" in ('creating', 'verified', 'failed')),
	CONSTRAINT "data_snapshots_size_nonnegative" CHECK ("data_snapshots"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD CONSTRAINT "data_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD CONSTRAINT "data_snapshots_source_operation_id_archive_operations_id_fk" FOREIGN KEY ("source_operation_id") REFERENCES "public"."archive_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_snapshots_object_path_uq" ON "data_snapshots" USING btree ("object_path");--> statement-breakpoint
CREATE INDEX "data_snapshots_user_created_idx" ON "data_snapshots" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "data_snapshots_user_status_idx" ON "data_snapshots" USING btree ("user_id","status");