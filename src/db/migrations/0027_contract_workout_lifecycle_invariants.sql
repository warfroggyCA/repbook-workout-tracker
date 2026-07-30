DO $$
DECLARE
  unresolved integer;
BEGIN
  SELECT count(*) INTO unresolved FROM workout_lifecycle_repair_preview;
  IF unresolved > 0 THEN
    RAISE EXCEPTION
      'Workout lifecycle contract blocked: % unresolved conflict(s) remain in workout_lifecycle_repair_preview.',
      unresolved
      USING ERRCODE = '23514';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "completed_sets_client_key_uq" ON "completed_sets" USING btree ("session_exercise_id","client_key") WHERE "completed_sets"."client_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "completed_sets_active_set_no_uq" ON "completed_sets" USING btree ("session_exercise_id","set_no") WHERE "completed_sets"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workout_sessions_one_active_uq" ON "workout_sessions" USING btree ("user_id") WHERE "workout_sessions"."status" = 'in_progress' AND "workout_sessions"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_progression_job_slot_uq" ON "recommendations" USING btree ("progression_job_id","source_template_exercise_id") WHERE "recommendations"."progression_job_id" IS NOT NULL AND "recommendations"."source_template_exercise_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_idempotency_uq" ON "audit_logs" USING btree ("user_id","idempotency_key") WHERE "audit_logs"."idempotency_key" IS NOT NULL;
