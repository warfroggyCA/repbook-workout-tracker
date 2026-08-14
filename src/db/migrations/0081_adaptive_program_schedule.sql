-- Add versioned future Program intent without changing existing Programs or
-- historical workouts. The wrapper below integrates the new durable graph
-- with full and History recovery in the same additive migration.

CREATE TABLE "program_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "program_id" uuid NOT NULL,
  "current_version_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "program_schedules_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade,
  CONSTRAINT "program_schedules_program_owner_fk"
    FOREIGN KEY ("program_id", "user_id")
    REFERENCES "public"."programs"("id", "user_id")
    ON DELETE cascade
);
--> statement-breakpoint

CREATE UNIQUE INDEX "program_schedules_program_uq"
  ON "program_schedules" USING btree ("program_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "program_schedules_id_user_program_uq"
  ON "program_schedules" USING btree ("id", "user_id", "program_id");
--> statement-breakpoint

CREATE TABLE "program_schedule_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "program_id" uuid NOT NULL,
  "schedule_id" uuid NOT NULL,
  "version_no" integer NOT NULL,
  "parent_version_id" uuid,
  "source_program_version_id" uuid NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "document" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "activated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "program_schedule_versions_parent_version_id_program_schedule_versions_id_fk"
    FOREIGN KEY ("parent_version_id")
    REFERENCES "public"."program_schedule_versions"("id")
    ON DELETE no action,
  CONSTRAINT "program_schedule_versions_schedule_owner_fk"
    FOREIGN KEY ("schedule_id", "user_id", "program_id")
    REFERENCES "public"."program_schedules"("id", "user_id", "program_id")
    ON DELETE cascade,
  CONSTRAINT "program_schedule_versions_source_program_fk"
    FOREIGN KEY ("source_program_version_id", "program_id")
    REFERENCES "public"."program_versions"("id", "program_id")
    ON DELETE no action,
  CONSTRAINT "program_schedule_versions_number_positive"
    CHECK ("version_no" >= 1),
  CONSTRAINT "program_schedule_versions_parent_distinct"
    CHECK ("parent_version_id" IS NULL OR "parent_version_id" <> "id"),
  CONSTRAINT "program_schedule_versions_document_valid"
    CHECK (
      "schema_version" = 1
      AND jsonb_typeof("document") = 'object'
      AND jsonb_typeof("document"->'schemaVersion') = 'string'
      AND "document"->>'schemaVersion' = 'program-schedule/1'
    ),
  CONSTRAINT "program_schedule_versions_hash_valid"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint

CREATE UNIQUE INDEX "program_schedule_versions_schedule_number_uq"
  ON "program_schedule_versions" USING btree ("schedule_id", "version_no");
--> statement-breakpoint
CREATE UNIQUE INDEX "program_schedule_versions_identity_root_uq"
  ON "program_schedule_versions" USING btree (
    "id", "schedule_id", "user_id", "program_id"
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "program_schedule_versions_event_source_uq"
  ON "program_schedule_versions" USING btree (
    "id", "schedule_id", "user_id", "program_id", "source_program_version_id"
  );
--> statement-breakpoint

ALTER TABLE "program_schedule_versions"
  ADD CONSTRAINT "program_schedule_versions_parent_root_fk"
  FOREIGN KEY ("parent_version_id", "schedule_id", "user_id", "program_id")
  REFERENCES "public"."program_schedule_versions"(
    "id", "schedule_id", "user_id", "program_id"
  )
  ON DELETE no action;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_program_schedule_current_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.current_version_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM program_schedule_versions version
      WHERE version.id = NEW.current_version_id
        AND version.schedule_id = NEW.id
        AND version.user_id = NEW.user_id
        AND version.program_id = NEW.program_id
    )
  THEN
    RAISE EXCEPTION 'Current Program schedule version must belong to the same root.'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER program_schedules_current_version_root_guard
BEFORE INSERT OR UPDATE OF current_version_id, id, user_id, program_id
ON program_schedules
FOR EACH ROW
EXECUTE FUNCTION guard_program_schedule_current_version();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION initialize_program_schedule_current_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.version_no = 1 AND NEW.parent_version_id IS NULL THEN
    UPDATE program_schedules schedule
    SET current_version_id = NEW.id
    WHERE schedule.id = NEW.schedule_id
      AND schedule.user_id = NEW.user_id
      AND schedule.program_id = NEW.program_id
      AND schedule.current_version_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'The first Program schedule version could not initialize its root.'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER program_schedule_versions_initialize_current
AFTER INSERT ON program_schedule_versions
FOR EACH ROW
EXECUTE FUNCTION initialize_program_schedule_current_version();
--> statement-breakpoint

CREATE TABLE "scheduled_program_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "program_id" uuid NOT NULL,
  "schedule_id" uuid NOT NULL,
  "schedule_version_id" uuid NOT NULL,
  "source_program_version_id" uuid NOT NULL,
  "source_phase_id" uuid NOT NULL,
  "source_phase_name" text NOT NULL,
  "source_event_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "schedule_kind" text NOT NULL,
  "routine_lineage_id" uuid,
  "intent_snapshot" jsonb NOT NULL,
  "sequence_no" integer NOT NULL,
  "cycle_position" integer NOT NULL,
  "program_week" integer NOT NULL,
  "original_local_date" date NOT NULL,
  "current_local_date" date NOT NULL,
  "timezone" text NOT NULL,
  "status" text DEFAULT 'scheduled' NOT NULL,
  "adjustment_kind" text,
  "revision" integer DEFAULT 0 NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scheduled_program_events_exact_version_fk"
    FOREIGN KEY (
      "schedule_version_id", "schedule_id", "user_id", "program_id",
      "source_program_version_id"
    )
    REFERENCES "public"."program_schedule_versions"(
      "id", "schedule_id", "user_id", "program_id",
      "source_program_version_id"
    )
    ON DELETE cascade,
  CONSTRAINT "scheduled_program_events_routine_lineage_fk"
    FOREIGN KEY ("source_program_version_id", "routine_lineage_id")
    REFERENCES "public"."workout_templates"("program_version_id", "lineage_id")
    ON DELETE no action,
  CONSTRAINT "scheduled_program_events_phase_name_valid"
    CHECK (length(btrim("source_phase_name")) > 0),
  CONSTRAINT "scheduled_program_events_kind_valid"
    CHECK ("kind" IN ('resistance', 'cardio', 'recovery', 'rest')),
  CONSTRAINT "scheduled_program_events_schedule_kind_valid"
    CHECK ("schedule_kind" IN ('fixed_7_day', 'rolling')),
  CONSTRAINT "scheduled_program_events_routine_lineage_shape"
    CHECK (
      ("kind" = 'resistance' AND "routine_lineage_id" IS NOT NULL)
      OR ("kind" <> 'resistance' AND "routine_lineage_id" IS NULL)
    ),
  CONSTRAINT "scheduled_program_events_intent_snapshot_valid"
    CHECK (
      jsonb_typeof("intent_snapshot") = 'object'
      AND "intent_snapshot" ?& ARRAY['id', 'kind']
      AND jsonb_typeof("intent_snapshot"->'id') = 'string'
      AND jsonb_typeof("intent_snapshot"->'kind') = 'string'
      AND "intent_snapshot"->>'id' = "source_event_id"::text
      AND "intent_snapshot"->>'kind' = "kind"
      AND (
        (
          "kind" = 'resistance'
          AND jsonb_typeof(
            "intent_snapshot"->'routineLineageId'
          ) = 'string'
          AND "intent_snapshot"->>'routineLineageId' =
            "routine_lineage_id"::text
        )
        OR (
          "kind" <> 'resistance'
          AND NOT "intent_snapshot" ? 'routineLineageId'
        )
      )
    ),
  CONSTRAINT "scheduled_program_events_position_valid"
    CHECK (
      "sequence_no" >= 1
      AND "cycle_position" >= 1
      AND "program_week" >= 1
    ),
  CONSTRAINT "scheduled_program_events_timezone_valid"
    CHECK (length(btrim("timezone")) > 0),
  CONSTRAINT "scheduled_program_events_status_valid"
    CHECK (
      "status" IN (
        'scheduled', 'started', 'completed', 'skipped', 'superseded',
        'abandoned'
      )
    ),
  CONSTRAINT "scheduled_program_events_adjustment_valid"
    CHECK (
      "adjustment_kind" IS NULL
      OR "adjustment_kind" IN ('shift', 'manual')
    ),
  CONSTRAINT "scheduled_program_events_revision_valid"
    CHECK ("revision" >= 0),
  CONSTRAINT "scheduled_program_events_resolution_valid"
    CHECK (
      (
        "status" IN ('scheduled', 'started')
        AND "resolved_at" IS NULL
      )
      OR (
        "status" IN ('completed', 'skipped', 'superseded', 'abandoned')
        AND "resolved_at" IS NOT NULL
      )
    )
);
--> statement-breakpoint

CREATE INDEX "scheduled_program_events_version_source_event_idx"
  ON "scheduled_program_events" USING btree (
    "schedule_version_id", "source_event_id"
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_program_events_version_sequence_uq"
  ON "scheduled_program_events" USING btree (
    "schedule_version_id", "sequence_no"
  );
--> statement-breakpoint
CREATE INDEX "scheduled_program_events_owner_date_status_idx"
  ON "scheduled_program_events" USING btree (
    "user_id", "current_local_date", "status"
  );
--> statement-breakpoint

ALTER TABLE "workout_sessions"
  ADD COLUMN "program_schedule_snapshot" jsonb;
--> statement-breakpoint

ALTER TABLE "workout_sessions"
  ADD CONSTRAINT "workout_sessions_program_schedule_snapshot_check"
  CHECK (
    "program_schedule_snapshot" IS NULL
    OR (
      jsonb_typeof("program_schedule_snapshot") = 'object'
      AND "source_program_id" IS NOT NULL
      AND "source_program_version_id" IS NOT NULL
      AND "source_day_lineage_id" IS NOT NULL
      AND "program_schedule_snapshot" ?& ARRAY[
        'schemaVersion', 'scheduledProgramEventId', 'programScheduleId',
        'programScheduleVersionId', 'programScheduleVersionHash',
        'scheduleSourceProgramVersionId', 'resolvedProgramVersionId',
        'sourcePhaseId', 'sourcePhaseName', 'scheduleKind', 'eventKind',
        'sourceEventId', 'eventRevision', 'originalLocalDate',
        'currentLocalDate', 'timezone', 'nominalProgramWeek',
        'cyclePosition', 'routineLineageId'
      ]
      AND jsonb_typeof("program_schedule_snapshot"->'schemaVersion') = 'number'
      AND jsonb_typeof("program_schedule_snapshot"->'scheduledProgramEventId') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'programScheduleId') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'programScheduleVersionId') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'programScheduleVersionHash') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'scheduleSourceProgramVersionId') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'resolvedProgramVersionId') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'sourcePhaseId') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'sourcePhaseName') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'scheduleKind') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'eventKind') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'sourceEventId') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'eventRevision') = 'number'
      AND jsonb_typeof("program_schedule_snapshot"->'originalLocalDate') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'currentLocalDate') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'timezone') = 'string'
      AND jsonb_typeof("program_schedule_snapshot"->'nominalProgramWeek') = 'number'
      AND jsonb_typeof("program_schedule_snapshot"->'cyclePosition') = 'number'
      AND jsonb_typeof("program_schedule_snapshot"->'routineLineageId') = 'string'
      AND "program_schedule_snapshot"->>'schemaVersion' = '1'
      AND "program_schedule_snapshot"->>'scheduleKind'
        IN ('fixed_7_day', 'rolling')
      AND "program_schedule_snapshot"->>'eventKind' = 'resistance'
      AND "program_schedule_snapshot"->>'resolvedProgramVersionId' =
        "source_program_version_id"::text
      AND "program_schedule_snapshot"->>'routineLineageId' =
        "source_day_lineage_id"::text
      AND "program_schedule_snapshot"->>'scheduledProgramEventId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "program_schedule_snapshot"->>'programScheduleId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "program_schedule_snapshot"->>'programScheduleVersionId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "program_schedule_snapshot"->>'scheduleSourceProgramVersionId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "program_schedule_snapshot"->>'resolvedProgramVersionId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "program_schedule_snapshot"->>'sourcePhaseId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "program_schedule_snapshot"->>'sourceEventId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "program_schedule_snapshot"->>'routineLineageId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "program_schedule_snapshot"->>'programScheduleVersionHash'
        ~ '^[0-9a-f]{64}$'
      AND length(btrim(
        "program_schedule_snapshot"->>'sourcePhaseName'
      )) > 0
      AND length(btrim("program_schedule_snapshot"->>'timezone')) > 0
      AND "program_schedule_snapshot"->>'originalLocalDate'
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND "program_schedule_snapshot"->>'currentLocalDate'
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND "program_schedule_snapshot"->>'eventRevision' ~ '^[0-9]+$'
      AND "program_schedule_snapshot"->>'nominalProgramWeek'
        ~ '^[1-9][0-9]*$'
      AND "program_schedule_snapshot"->>'cyclePosition' ~ '^[1-9][0-9]*$'
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_workout_session_program_schedule_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.program_schedule_snapshot IS DISTINCT FROM
      OLD.program_schedule_snapshot
    AND current_setting('workout_tracker.authorized_delete', true)
      IS DISTINCT FROM 'snapshot_restore'
  THEN
    RAISE EXCEPTION 'Retained workout Program schedule evidence is immutable.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER workout_sessions_program_schedule_snapshot_guard
BEFORE UPDATE OF program_schedule_snapshot ON workout_sessions
FOR EACH ROW
EXECUTE FUNCTION guard_workout_session_program_schedule_snapshot();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_program_schedule_version_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Program schedule versions are immutable.'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER program_schedule_versions_immutable
BEFORE UPDATE ON program_schedule_versions
FOR EACH ROW
EXECUTE FUNCTION guard_program_schedule_version_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_scheduled_program_event_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF ROW(
    OLD.id, OLD.user_id, OLD.program_id, OLD.schedule_id,
    OLD.schedule_version_id, OLD.source_program_version_id,
    OLD.source_phase_id, OLD.source_phase_name, OLD.source_event_id,
    OLD.kind, OLD.schedule_kind, OLD.routine_lineage_id, OLD.intent_snapshot,
    OLD.sequence_no, OLD.cycle_position, OLD.program_week,
    OLD.original_local_date, OLD.timezone, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.user_id, NEW.program_id, NEW.schedule_id,
    NEW.schedule_version_id, NEW.source_program_version_id,
    NEW.source_phase_id, NEW.source_phase_name, NEW.source_event_id,
    NEW.kind, NEW.schedule_kind, NEW.routine_lineage_id, NEW.intent_snapshot,
    NEW.sequence_no, NEW.cycle_position, NEW.program_week,
    NEW.original_local_date, NEW.timezone, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'Scheduled Program event identity is immutable.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER scheduled_program_events_identity_immutable
BEFORE UPDATE ON scheduled_program_events
FOR EACH ROW
EXECUTE FUNCTION guard_scheduled_program_event_identity();
--> statement-breakpoint

CREATE TRIGGER protected_delete_guard
BEFORE DELETE ON scheduled_program_events
FOR EACH ROW
EXECUTE FUNCTION guard_protected_delete();
--> statement-breakpoint

CREATE TRIGGER protected_delete_guard
BEFORE DELETE ON program_schedule_versions
FOR EACH ROW
EXECUTE FUNCTION guard_protected_delete();
--> statement-breakpoint

CREATE TRIGGER protected_delete_guard
BEFORE DELETE ON program_schedules
FOR EACH ROW
EXECUTE FUNCTION guard_protected_delete();
--> statement-breakpoint

-- Program schedules are replaceable future intent during a full restore, but
-- are deliberately outside History restore. Remove its old rows before the
-- established restore, then rebuild roots without a current pointer so their
-- versions and occurrences can be restored before the pointer is made visible
-- atomically.
ALTER FUNCTION restore_user_snapshot(uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO restore_user_snapshot_without_program_schedule;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restore_user_snapshot(
  p_user_id uuid, p_scope text, p_expected_current jsonb, p_target_rows jsonb,
  p_dependency_rows jsonb, p_source_snapshot_id uuid, p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_expected_schedules jsonb := COALESCE(
    p_expected_current->'program_schedules', '[]'::jsonb
  );
  v_expected_versions jsonb := COALESCE(
    p_expected_current->'program_schedule_versions', '[]'::jsonb
  );
  v_expected_events jsonb := COALESCE(
    p_expected_current->'scheduled_program_events', '[]'::jsonb
  );
  v_source_schedules jsonb := COALESCE(
    p_target_rows->'program_schedules', '[]'::jsonb
  );
  v_source_versions jsonb := COALESCE(
    p_target_rows->'program_schedule_versions', '[]'::jsonb
  );
  v_source_events jsonb := COALESCE(
    p_target_rows->'scheduled_program_events', '[]'::jsonb
  );
  v_current_schedules jsonb;
  v_current_versions jsonb;
  v_current_events jsonb;
  v_base_expected jsonb;
  v_base_target jsonb;
  v_base_dependencies jsonb;
  v_result jsonb;
  v_added_schedules integer := 0;
  v_added_versions integer := 0;
  v_added_events integer := 0;
BEGIN
  IF p_scope NOT IN ('full', 'history') THEN
    RAISE EXCEPTION 'Snapshot restore scope must be full or history.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(v_expected_schedules) IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_expected_versions) IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_expected_events) IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_source_schedules) IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_source_versions) IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_source_events) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'Snapshot Program schedule data must use row arrays.'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.value->>'id'), '[]'::jsonb)
    INTO v_expected_schedules
  FROM jsonb_array_elements(v_expected_schedules) item(value);
  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.value->>'id'), '[]'::jsonb)
    INTO v_expected_versions
  FROM jsonb_array_elements(v_expected_versions) item(value);
  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.value->>'id'), '[]'::jsonb)
    INTO v_expected_events
  FROM jsonb_array_elements(v_expected_events) item(value);
  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.value->>'id'), '[]'::jsonb)
    INTO v_source_schedules
  FROM jsonb_array_elements(v_source_schedules) item(value);
  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.value->>'id'), '[]'::jsonb)
    INTO v_source_versions
  FROM jsonb_array_elements(v_source_versions) item(value);
  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.value->>'id'), '[]'::jsonb)
    INTO v_source_events
  FROM jsonb_array_elements(v_source_events) item(value);

  v_base_expected := p_expected_current
    - 'program_schedules'
    - 'program_schedule_versions'
    - 'scheduled_program_events';
  v_base_target := p_target_rows
    - 'program_schedules'
    - 'program_schedule_versions'
    - 'scheduled_program_events';
  v_base_dependencies := p_dependency_rows
    - 'program_schedules'
    - 'program_schedule_versions'
    - 'scheduled_program_events';

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 847221));
  PERFORM set_config(
    'workout_tracker.authorized_delete', 'snapshot_restore', true
  );
  LOCK TABLE program_schedules IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE program_schedule_versions IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE scheduled_program_events IN SHARE ROW EXCLUSIVE MODE;

  PERFORM 1
  FROM program_schedules schedule
  WHERE schedule.user_id = p_user_id
  ORDER BY schedule.id
  FOR UPDATE;
  PERFORM 1
  FROM program_schedule_versions version
  WHERE version.user_id = p_user_id
  ORDER BY version.id
  FOR UPDATE;
  PERFORM 1
  FROM scheduled_program_events event
  WHERE event.user_id = p_user_id
  ORDER BY event.id
  FOR UPDATE;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(schedule) ORDER BY schedule.id), '[]'::jsonb
  ) INTO v_current_schedules
  FROM program_schedules schedule
  WHERE schedule.user_id = p_user_id;
  SELECT COALESCE(
    jsonb_agg(to_jsonb(version) ORDER BY version.id), '[]'::jsonb
  ) INTO v_current_versions
  FROM program_schedule_versions version
  WHERE version.user_id = p_user_id;
  SELECT COALESCE(
    jsonb_agg(to_jsonb(event) ORDER BY event.id), '[]'::jsonb
  ) INTO v_current_events
  FROM scheduled_program_events event
  WHERE event.user_id = p_user_id;

  IF p_scope = 'full'
    AND (
      v_current_schedules IS DISTINCT FROM v_expected_schedules
      OR v_current_versions IS DISTINCT FROM v_expected_versions
      OR v_current_events IS DISTINCT FROM v_expected_events
    )
  THEN
    RAISE EXCEPTION 'Restore preview is stale for Program schedule data.'
      USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_schedules) source(value)
    WHERE source.value->>'user_id' IS DISTINCT FROM p_user_id::text
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_versions) source(value)
    WHERE source.value->>'user_id' IS DISTINCT FROM p_user_id::text
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_events) source(value)
    WHERE source.value->>'user_id' IS DISTINCT FROM p_user_id::text
  ) THEN
    RAISE EXCEPTION 'Snapshot Program schedule data belongs to another account.'
      USING ERRCODE = '42501';
  END IF;

  IF p_scope = 'full' AND (
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_source_schedules) root(value)
      WHERE root.value->>'current_version_id' IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_source_versions) version(value)
          WHERE version.value->>'id' = root.value->>'current_version_id'
            AND version.value->>'schedule_id' = root.value->>'id'
            AND version.value->>'user_id' = root.value->>'user_id'
            AND version.value->>'program_id' = root.value->>'program_id'
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_source_versions) newer(value)
          JOIN jsonb_array_elements(v_source_versions) current(value)
            ON current.value->>'id' = root.value->>'current_version_id'
          WHERE newer.value->>'schedule_id' = root.value->>'id'
            AND (newer.value->>'version_no')::integer >
              (current.value->>'version_no')::integer
        )
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_source_versions) version(value)
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_source_schedules) root(value)
        WHERE root.value->>'id' = version.value->>'schedule_id'
          AND root.value->>'user_id' = version.value->>'user_id'
          AND root.value->>'program_id' = version.value->>'program_id'
      )
      OR (
        version.value->>'parent_version_id' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_source_versions) parent(value)
          WHERE parent.value->>'id' = version.value->>'parent_version_id'
            AND parent.value->>'schedule_id' = version.value->>'schedule_id'
            AND parent.value->>'user_id' = version.value->>'user_id'
            AND parent.value->>'program_id' = version.value->>'program_id'
        )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_source_events) event(value)
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_source_versions) version(value)
        WHERE version.value->>'id' = event.value->>'schedule_version_id'
          AND version.value->>'schedule_id' = event.value->>'schedule_id'
          AND version.value->>'user_id' = event.value->>'user_id'
          AND version.value->>'program_id' = event.value->>'program_id'
          AND version.value->>'source_program_version_id' =
            event.value->>'source_program_version_id'
      )
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_source_versions) version(value)
      CROSS JOIN LATERAL (
        SELECT version.value->'document' AS value
      ) document
      CROSS JOIN LATERAL (
        SELECT document.value->'phases'->(
          jsonb_array_length(document.value->'phases') - 1
        ) AS value
      ) last_phase
      CROSS JOIN LATERAL (
        SELECT
          (document.value->>'startsOn')::date AS starts_on,
          COALESCE(
            (document.value->>'targetEndsOn')::date,
            CASE
              WHEN last_phase.value->'boundary'->>'kind' =
                'local_date_range'
              THEN (last_phase.value->'boundary'->>'endsOn')::date
              ELSE
                (document.value->>'startsOn')::date +
                (
                  (last_phase.value->'boundary'->>'endWeek')::integer * 7
                  - 1
                )
            END
          ) AS ends_on
      ) bounds
      WHERE bounds.starts_on IS NULL
        OR bounds.ends_on IS NULL
        OR bounds.ends_on < bounds.starts_on
        OR bounds.ends_on - bounds.starts_on + 1 > 3650
        OR (
          SELECT count(*)
          FROM jsonb_array_elements(v_source_events) event(value)
          WHERE event.value->>'schedule_version_id' =
            version.value->>'id'
        ) <> bounds.ends_on - bounds.starts_on + 1
        OR (
          SELECT count(DISTINCT event.value->>'timezone')
          FROM jsonb_array_elements(v_source_events) event(value)
          WHERE event.value->>'schedule_version_id' =
            version.value->>'id'
        ) <> 1
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_source_events) event(value)
          WHERE event.value->>'schedule_version_id' =
            version.value->>'id'
            AND (
              (event.value->>'sequence_no')::integer < 1
              OR (event.value->>'original_local_date')::date <>
                bounds.starts_on +
                ((event.value->>'sequence_no')::integer - 1)
              OR (event.value->>'program_week')::integer <>
                (((event.value->>'sequence_no')::integer - 1) / 7 + 1)
              OR NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  document.value->'phases'
                ) phase(value)
                CROSS JOIN LATERAL (
                  SELECT
                    CASE
                      WHEN phase.value->'boundary'->>'kind' =
                        'local_date_range'
                      THEN (phase.value->'boundary'->>'startsOn')::date
                      ELSE bounds.starts_on +
                        (
                          (
                            phase.value->'boundary'->>'startWeek'
                          )::integer - 1
                        ) * 7
                    END AS starts_on,
                    CASE
                      WHEN phase.value->'boundary'->>'kind' =
                        'local_date_range'
                      THEN (phase.value->'boundary'->>'endsOn')::date
                      ELSE bounds.starts_on +
                        (
                          (
                            phase.value->'boundary'->>'endWeek'
                          )::integer * 7 - 1
                        )
                    END AS ends_on
                ) phase_bounds
                CROSS JOIN LATERAL (
                  SELECT CASE
                    WHEN phase.value->'schedule'->>'kind' =
                      'fixed_7_day'
                    THEN extract(
                      isodow FROM
                      (event.value->>'original_local_date')::date
                    )::integer
                    ELSE
                      (
                        (
                          (event.value->>'original_local_date')::date -
                          phase_bounds.starts_on
                        ) %
                        (
                          phase.value->'schedule'->>'lengthDays'
                        )::integer
                      ) + 1
                  END AS position
                ) cycle
                CROSS JOIN LATERAL (
                  SELECT phase.value->'schedule'->'days'->
                    (cycle.position - 1)->'event' AS intent
                ) expected
                WHERE (event.value->>'original_local_date')::date
                  BETWEEN phase_bounds.starts_on AND phase_bounds.ends_on
                  AND event.value->>'source_phase_id' =
                    phase.value->>'id'
                  AND event.value->>'source_phase_name' =
                    phase.value->>'name'
                  AND event.value->>'schedule_kind' =
                    phase.value->'schedule'->>'kind'
                  AND (event.value->>'cycle_position')::integer =
                    cycle.position
                  AND event.value->>'source_event_id' =
                    expected.intent->>'id'
                  AND event.value->>'kind' =
                    expected.intent->>'kind'
                  AND event.value->'intent_snapshot' =
                    expected.intent
                  AND event.value->>'routine_lineage_id'
                    IS NOT DISTINCT FROM
                    expected.intent->>'routineLineageId'
              )
            )
        )
    )
  ) THEN
    RAISE EXCEPTION 'Snapshot Program schedule graph is cross-owner or contradictory.'
      USING ERRCODE = '23514';
  END IF;

  IF p_scope = 'full' THEN
    DELETE FROM program_schedules
    WHERE user_id = p_user_id;
  END IF;

  v_result := restore_user_snapshot_without_program_schedule(
    p_user_id,
    p_scope,
    v_base_expected,
    v_base_target,
    v_base_dependencies,
    p_source_snapshot_id,
    p_safety_snapshot_id,
    p_fail_after_table
  );

  IF p_scope = 'history' THEN
    SELECT COALESCE(
      jsonb_agg(to_jsonb(schedule) ORDER BY schedule.id), '[]'::jsonb
    ) INTO v_expected_schedules
    FROM program_schedules schedule
    WHERE schedule.user_id = p_user_id;
    SELECT COALESCE(
      jsonb_agg(to_jsonb(version) ORDER BY version.id), '[]'::jsonb
    ) INTO v_expected_versions
    FROM program_schedule_versions version
    WHERE version.user_id = p_user_id;
    SELECT COALESCE(
      jsonb_agg(to_jsonb(event) ORDER BY event.id), '[]'::jsonb
    ) INTO v_expected_events
    FROM scheduled_program_events event
    WHERE event.user_id = p_user_id;
    IF v_expected_schedules IS DISTINCT FROM v_current_schedules
      OR v_expected_versions IS DISTINCT FROM v_current_versions
      OR v_expected_events IS DISTINCT FROM v_current_events
    THEN
      RAISE EXCEPTION 'History restore changed preserved Program schedule data.'
        USING ERRCODE = '23514';
    END IF;
    RETURN v_result;
  END IF;

  INSERT INTO program_schedules (
    id, user_id, program_id, current_version_id, created_at, updated_at
  )
  SELECT
    source.id, source.user_id, source.program_id, NULL,
    source.created_at, source.updated_at
  FROM jsonb_populate_recordset(
    NULL::program_schedules, v_source_schedules
  ) source;
  GET DIAGNOSTICS v_added_schedules = ROW_COUNT;
  IF v_added_schedules <> jsonb_array_length(v_source_schedules) THEN
    RAISE EXCEPTION 'Restored Program schedule root count did not match the snapshot.'
      USING ERRCODE = '23514';
  END IF;
  IF p_fail_after_table = 'program_schedules' THEN
    RAISE EXCEPTION 'Injected restore failure after program_schedules.';
  END IF;

  INSERT INTO program_schedule_versions
  SELECT source.*
  FROM jsonb_populate_recordset(
    NULL::program_schedule_versions, v_source_versions
  ) source;
  GET DIAGNOSTICS v_added_versions = ROW_COUNT;
  IF v_added_versions <> jsonb_array_length(v_source_versions) THEN
    RAISE EXCEPTION 'Restored Program schedule version count did not match the snapshot.'
      USING ERRCODE = '23514';
  END IF;
  IF p_fail_after_table = 'program_schedule_versions' THEN
    RAISE EXCEPTION 'Injected restore failure after program_schedule_versions.';
  END IF;

  INSERT INTO scheduled_program_events
  SELECT source.*
  FROM jsonb_populate_recordset(
    NULL::scheduled_program_events, v_source_events
  ) source;
  GET DIAGNOSTICS v_added_events = ROW_COUNT;
  IF v_added_events <> jsonb_array_length(v_source_events) THEN
    RAISE EXCEPTION 'Restored scheduled Program event count did not match the snapshot.'
      USING ERRCODE = '23514';
  END IF;
  IF p_fail_after_table = 'scheduled_program_events' THEN
    RAISE EXCEPTION 'Injected restore failure after scheduled_program_events.';
  END IF;

  UPDATE program_schedules schedule
  SET current_version_id = source.current_version_id
  FROM jsonb_to_recordset(v_source_schedules) source(
    id uuid, current_version_id uuid
  )
  WHERE schedule.id = source.id
    AND schedule.user_id = p_user_id;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(schedule) ORDER BY schedule.id), '[]'::jsonb
  ) INTO v_current_schedules
  FROM program_schedules schedule
  WHERE schedule.user_id = p_user_id;
  SELECT COALESCE(
    jsonb_agg(to_jsonb(version) ORDER BY version.id), '[]'::jsonb
  ) INTO v_current_versions
  FROM program_schedule_versions version
  WHERE version.user_id = p_user_id;
  SELECT COALESCE(
    jsonb_agg(to_jsonb(event) ORDER BY event.id), '[]'::jsonb
  ) INTO v_current_events
  FROM scheduled_program_events event
  WHERE event.user_id = p_user_id;

  IF v_current_schedules IS DISTINCT FROM v_source_schedules
    OR v_current_versions IS DISTINCT FROM v_source_versions
    OR v_current_events IS DISTINCT FROM v_source_events
  THEN
    RAISE EXCEPTION 'Restored Program schedule data failed final verification.'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_set(
    v_result,
    '{restoredRecords}',
    to_jsonb(
      COALESCE((v_result->>'restoredRecords')::integer, 0)
      + v_added_schedules
      + v_added_versions
      + v_added_events
    )
  );
END;
$$;
