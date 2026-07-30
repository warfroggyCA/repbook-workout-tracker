DO $$
DECLARE
  conflict_count integer;
BEGIN
  SELECT count(*) INTO conflict_count
  FROM recommendation_decision_repair_preview;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'Recommendation/quick-log contract blocked: % repair preview item(s) require explicit review',
      conflict_count;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_prescriptions_active_slot_uq"
  ON "exercise_prescriptions" USING btree ("template_exercise_id")
  WHERE "exercise_prescriptions"."superseded_by_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "session_exercises_order_uq"
  ON "session_exercises" USING btree ("session_id", "order_idx");
--> statement-breakpoint
CREATE UNIQUE INDEX "adaptation_events_recommendation_uq"
  ON "adaptation_events" USING btree ("recommendation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "user_decisions_recommendation_uq"
  ON "user_decisions" USING btree ("recommendation_id");
