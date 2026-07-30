ALTER TABLE "workout_sessions"
ADD CONSTRAINT "workout_sessions_time_budget_check"
CHECK (
  "workout_sessions"."time_budget_min" IS NULL
  OR "workout_sessions"."time_budget_min" BETWEEN 5 AND 600
) NOT VALID;
--> statement-breakpoint
ALTER TABLE "workout_sessions"
VALIDATE CONSTRAINT "workout_sessions_time_budget_check";
