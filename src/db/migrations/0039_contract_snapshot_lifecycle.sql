DO $$
DECLARE
  conflict_count integer;
BEGIN
  SELECT count(*) INTO conflict_count FROM snapshot_lifecycle_repair_preview;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'Snapshot lifecycle contract blocked: % repair preview item(s) require explicit review',
      conflict_count;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "data_snapshots" ALTER COLUMN "snapshot_kind" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "data_snapshots_lifecycle_idx" ON "data_snapshots" USING btree ("snapshot_kind","pinned","deletion_status","created_at");--> statement-breakpoint
CREATE INDEX "data_snapshots_deletion_lease_idx" ON "data_snapshots" USING btree ("deletion_status","deletion_lease_expires_at");--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD CONSTRAINT "data_snapshots_kind_valid" CHECK ("data_snapshots"."snapshot_kind" in ('user', 'automatic'));--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD CONSTRAINT "data_snapshots_deletion_status_valid" CHECK ("data_snapshots"."deletion_status" is null or "data_snapshots"."deletion_status" in ('deleting', 'delete_failed'));--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD CONSTRAINT "data_snapshots_deletion_attempts_nonnegative" CHECK ("data_snapshots"."deletion_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD CONSTRAINT "data_snapshots_deletion_state_valid" CHECK ((
  "data_snapshots"."deletion_status" is null
  and "data_snapshots"."deletion_requested_at" is null
  and "data_snapshots"."deletion_failure_reason" is null
  and "data_snapshots"."deletion_lease_id" is null
  and "data_snapshots"."deletion_lease_expires_at" is null
) or (
  "data_snapshots"."deletion_status" = 'deleting'
  and "data_snapshots"."deletion_requested_at" is not null
  and "data_snapshots"."deletion_failure_reason" is null
  and "data_snapshots"."deletion_lease_id" is not null
  and "data_snapshots"."deletion_lease_expires_at" is not null
) or (
  "data_snapshots"."deletion_status" = 'delete_failed'
  and "data_snapshots"."deletion_requested_at" is not null
  and "data_snapshots"."deletion_failure_reason" is not null
  and "data_snapshots"."deletion_lease_id" is null
  and "data_snapshots"."deletion_lease_expires_at" is null
));--> statement-breakpoint
ALTER TABLE "data_snapshots" ADD CONSTRAINT "data_snapshots_retention_protection" CHECK (("data_snapshots"."snapshot_kind" = 'automatic' or "data_snapshots"."deletion_status" is null)
  and (not "data_snapshots"."pinned" or "data_snapshots"."deletion_status" is null));
