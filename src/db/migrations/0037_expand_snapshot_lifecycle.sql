-- Expand first. Classification is intentionally nullable until the repair
-- preview has exposed any historical row whose origin cannot be proven.
ALTER TABLE "data_snapshots" ADD COLUMN "snapshot_kind" text;--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD COLUMN "deletion_status" text;--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD COLUMN "deletion_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD COLUMN "deletion_failure_reason" text;--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD COLUMN "deletion_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD COLUMN "deletion_lease_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE data_snapshots
SET snapshot_kind = CASE
  WHEN reason = 'manual' THEN 'user'
  WHEN name LIKE 'Safety snapshot · %' AND reason <> 'manual' THEN 'automatic'
  ELSE NULL
END;
