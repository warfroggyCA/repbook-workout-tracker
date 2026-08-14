ALTER TABLE "programs" DROP CONSTRAINT "programs_current_version_state_check";
--> statement-breakpoint
ALTER TABLE "programs" DROP CONSTRAINT "programs_status_valid";
--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_status_valid"
CHECK ("status" IN ('active', 'inactive', 'archived'));
--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_current_version_state_check"
CHECK (
  ("status" IN ('active', 'inactive') AND "archived_at" IS NULL AND "current_version_id" IS NOT NULL)
  OR ("status" = 'archived' AND "archived_at" IS NOT NULL)
);
