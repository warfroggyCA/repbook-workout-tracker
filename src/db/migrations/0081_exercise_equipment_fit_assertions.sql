-- Retain explicit owner-reviewed truth for one stable exercise and one exact
-- owned equipment item. Absence remains unknown; no display-name or catalog
-- backfill is performed.

CREATE TABLE "exercise_equipment_fit_assertions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "exercise_id" uuid NOT NULL,
  "equipment_item_id" uuid NOT NULL,
  "verdict" text NOT NULL,
  "reason_code" text NOT NULL,
  "reason_note" text,
  "provenance" text DEFAULT 'owner_review' NOT NULL,
  "semantics_version" integer DEFAULT 1 NOT NULL,
  "evidence_revision" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "exercise_equipment_fit_assertions_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "exercise_equipment_fit_assertions_exercise_fk"
    FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade,
  CONSTRAINT "exercise_equipment_fit_assertions_item_owner_fk"
    FOREIGN KEY ("equipment_item_id", "user_id")
    REFERENCES "public"."equipment_items"("id", "user_id") ON DELETE cascade,
  CONSTRAINT "exercise_equipment_fit_assertions_verdict_check"
    CHECK ("verdict" IN ('compatible', 'incompatible')),
  CONSTRAINT "exercise_equipment_fit_assertions_reason_code_check"
    CHECK ("reason_code" IN (
      'owner_verified', 'geometry_limit', 'missing_capability',
      'attachment_limit', 'range_of_motion_limit', 'space_limit',
      'safety_constraint', 'other'
    )),
  CONSTRAINT "exercise_equipment_fit_assertions_state_check"
    CHECK (
      ("verdict" = 'compatible' AND "reason_code" = 'owner_verified')
      OR ("verdict" = 'incompatible' AND "reason_code" <> 'owner_verified')
    ),
  CONSTRAINT "exercise_equipment_fit_assertions_reason_note_check"
    CHECK (
      "reason_note" IS NULL
      OR length(btrim("reason_note")) BETWEEN 1 AND 500
    ),
  CONSTRAINT "exercise_equipment_fit_assertions_other_note_check"
    CHECK ("reason_code" <> 'other' OR "reason_note" IS NOT NULL),
  CONSTRAINT "exercise_equipment_fit_assertions_provenance_check"
    CHECK ("provenance" = 'owner_review'),
  CONSTRAINT "exercise_equipment_fit_assertions_semantics_version_check"
    CHECK ("semantics_version" = 1),
  CONSTRAINT "exercise_equipment_fit_assertions_evidence_revision_check"
    CHECK ("evidence_revision" ~ '^[0-9a-f]{32}$'),
  CONSTRAINT "exercise_equipment_fit_assertions_revision_check"
    CHECK ("revision" >= 1),
  CONSTRAINT "exercise_equipment_fit_assertions_timestamps_check"
    CHECK ("created_at" <= "updated_at" AND "reviewed_at" <= "updated_at")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "exercise_equipment_fit_assertions_owner_exercise_item_uq"
  ON "exercise_equipment_fit_assertions" ("user_id", "exercise_id", "equipment_item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_equipment_fit_assertions_id_user_uq"
  ON "exercise_equipment_fit_assertions" ("id", "user_id");
--> statement-breakpoint
CREATE INDEX "exercise_equipment_fit_assertions_owner_exercise_idx"
  ON "exercise_equipment_fit_assertions" ("user_id", "exercise_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_exercise_equipment_fit_assertion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_exercise_owner uuid;
BEGIN
  SELECT exercise.user_id
    INTO v_exercise_owner
  FROM exercises exercise
  WHERE exercise.id = NEW.exercise_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exercise-equipment fit exercise does not exist.'
      USING ERRCODE = '23503';
  END IF;
  IF v_exercise_owner IS NOT NULL AND v_exercise_owner <> NEW.user_id THEN
    RAISE EXCEPTION 'Exercise-equipment fit exercise belongs to another account.'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(OLD.id, OLD.user_id, OLD.exercise_id, OLD.equipment_item_id)
    IS DISTINCT FROM ROW(NEW.id, NEW.user_id, NEW.exercise_id, NEW.equipment_item_id)
  THEN
    RAISE EXCEPTION 'Exercise-equipment fit identity is immutable.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- This volatile lookup is intentionally invoked only after the owner-profile
-- row lock. Under PostgreSQL Read Committed it takes a fresh command snapshot,
-- so an overlapping exact retry sees the first request's committed receipt
-- after waiting instead of reusing the mutation identity or returning stale.
CREATE OR REPLACE FUNCTION exercise_equipment_fit_receipt_after_owner_lock(
  p_user_id uuid,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  SELECT log.cause_ref
  FROM audit_logs log
  WHERE log.user_id = p_user_id
    AND log.idempotency_key = p_idempotency_key
  LIMIT 1
$$;
--> statement-breakpoint

-- Fresh post-lock inventory snapshot for stale/concurrent CAS gates. Callers
-- must reference the already-locked owner-profile row so this VOLATILE query
-- runs only after any overlapping inventory writer commits.
CREATE OR REPLACE FUNCTION equipment_inventory_revision_after_owner_lock(
  p_user_id uuid
)
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  SELECT md5(
    coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)::text
              FROM equipment_items e WHERE e.user_id = p_user_id), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)::text
              FROM plate_inventory p WHERE p.user_id = p_user_id), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id)::text
              FROM barbell_configs b WHERE b.user_id = p_user_id), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id)::text
              FROM plate_loaded_machine_profiles m WHERE m.user_id = p_user_id), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(mp) ORDER BY mp.machine_profile_id, mp.plate_inventory_id)::text
              FROM plate_loaded_machine_compatible_plates mp WHERE mp.user_id = p_user_id), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)::text
              FROM cable_machine_profiles c WHERE c.user_id = p_user_id), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(cs) ORDER BY cs.cable_profile_id, cs.stack_index, cs.step_index)::text
              FROM cable_stack_steps cs WHERE cs.user_id = p_user_id), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)::text
              FROM cable_attachment_profiles a WHERE a.user_id = p_user_id), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(ca) ORDER BY ca.cable_profile_id, ca.attachment_profile_id)::text
              FROM cable_attachment_compatibilities ca WHERE ca.user_id = p_user_id), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(fit) ORDER BY fit.exercise_id, fit.equipment_item_id)::text
              FROM exercise_equipment_fit_assertions fit WHERE fit.user_id = p_user_id), '[]')
  )
$$;
--> statement-breakpoint

-- One review revision covers the complete owner-visible equipment-fit
-- semantics, not only physical inventory rows. A catalog or custom-exercise
-- requirement change therefore invalidates a one-publication attestation even
-- when the owner's equipment itself did not change.
CREATE OR REPLACE FUNCTION owner_equipment_fit_review_revision(
  p_user_id uuid
)
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  SELECT md5(
    equipment_inventory_revision_after_owner_lock(p_user_id)
    || coalesce((
      SELECT jsonb_agg(
        to_jsonb(requirement)
        || jsonb_build_object(
          'definitionKey', definition.key,
          'definitionCategory', definition.category
        )
        ORDER BY requirement.exercise_id, requirement.id
      )::text
      FROM exercise_equipment_requirements requirement
      JOIN exercises exercise ON exercise.id = requirement.exercise_id
      LEFT JOIN equipment_definitions definition
        ON definition.id = requirement.equipment_definition_id
      WHERE exercise.user_id IS NULL OR exercise.user_id = p_user_id
    ), '[]')
    || coalesce((
      SELECT jsonb_agg(
        to_jsonb(requirement)
        || jsonb_build_object(
          'equipmentDefinitionKey', equipment_definition.key,
          'equipmentDefinitionCategory', equipment_definition.category,
          'attachmentDefinitionKey', attachment_definition.key,
          'attachmentDefinitionCategory', attachment_definition.category
        )
        ORDER BY requirement.exercise_id, requirement.id
      )::text
      FROM exercise_execution_requirements requirement
      JOIN exercises exercise ON exercise.id = requirement.exercise_id
      LEFT JOIN equipment_definitions equipment_definition
        ON equipment_definition.id = requirement.required_equipment_definition_id
      LEFT JOIN equipment_definitions attachment_definition
        ON attachment_definition.id = requirement.required_attachment_definition_id
      WHERE exercise.user_id IS NULL OR exercise.user_id = p_user_id
    ), '[]')
    || coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'itemId', item.id,
        'definitionId', definition.id,
        'definitionKey', definition.key,
        'definitionCategory', definition.category
      ) ORDER BY item.id)::text
      FROM equipment_items item
      JOIN equipment_definitions definition ON definition.id = item.definition_id
      WHERE item.user_id = p_user_id
    ), '[]')
  )
$$;
--> statement-breakpoint

-- An archived import may own a custom exercise. If permanent deletion removes
-- that exercise, its current fit assertions are visible in the reviewed scope,
-- stale-fenced by the grant, and deleted only through the exercise FK cascade.
ALTER FUNCTION permanent_delete_archive_preview(uuid, uuid)
  RENAME TO permanent_delete_archive_preview_without_fit_assertions;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanent_delete_archive_preview(
  p_user_id uuid,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH base AS (
  SELECT permanent_delete_archive_preview_without_fit_assertions(
    p_user_id,
    p_operation_id
  ) AS preview
), fit_count AS (
  SELECT count(*)::integer AS count
  FROM exercise_equipment_fit_assertions assertion
  WHERE assertion.user_id = p_user_id
    AND EXISTS (
      SELECT 1
      FROM archive_operation_records member
      WHERE member.operation_id = p_operation_id
        AND member.user_id = p_user_id
        AND member.entity_type = 'exercise'
        AND member.entity_id = assertion.exercise_id::text
    )
)
SELECT CASE
  WHEN base.preview IS NULL THEN NULL
  ELSE jsonb_set(
    base.preview,
    '{deleteCounts,exerciseEquipmentFitAssertions}',
    to_jsonb(fit_count.count),
    true
  )
END
FROM base CROSS JOIN fit_count;
$$;
--> statement-breakpoint

ALTER FUNCTION permanently_delete_archive_operation(uuid, uuid, text, text, uuid, text)
  RENAME TO permanently_delete_archive_operation_without_fit_assertions;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION permanently_delete_archive_operation(
  p_user_id uuid,
  p_operation_id uuid,
  p_token_hash text,
  p_confirmation text,
  p_safety_snapshot_id uuid,
  p_fail_after_step text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_assertion_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 847221));
  -- Match review and restore lock order before the custom-exercise cascade.
  PERFORM 1 FROM user_profiles profile
  WHERE profile.user_id = p_user_id
  FOR UPDATE;
  LOCK TABLE exercise_equipment_fit_assertions IN SHARE ROW EXCLUSIVE MODE;

  SELECT COALESCE(array_agg(assertion.id ORDER BY assertion.id), ARRAY[]::uuid[])
  INTO v_assertion_ids
  FROM exercise_equipment_fit_assertions assertion
  WHERE assertion.user_id = p_user_id
    AND EXISTS (
      SELECT 1
      FROM archive_operation_records member
      WHERE member.operation_id = p_operation_id
        AND member.user_id = p_user_id
        AND member.entity_type = 'exercise'
        AND member.entity_id = assertion.exercise_id::text
    );

  v_result := permanently_delete_archive_operation_without_fit_assertions(
    p_user_id,
    p_operation_id,
    p_token_hash,
    p_confirmation,
    p_safety_snapshot_id,
    p_fail_after_step
  );

  IF EXISTS (
    SELECT 1
    FROM exercise_equipment_fit_assertions assertion
    WHERE assertion.id = ANY(v_assertion_ids)
  ) THEN
    RAISE EXCEPTION 'Exercise-equipment fit assertion deletion scope changed.';
  END IF;
  IF p_fail_after_step = 'exercise_equipment_fit_assertions' THEN
    RAISE EXCEPTION 'Injected permanent-delete failure after exercise-equipment fit assertions.';
  END IF;

  RETURN jsonb_set(
    v_result,
    '{deleteCounts,exerciseEquipmentFitAssertions}',
    to_jsonb(cardinality(v_assertion_ids)),
    true
  );
END;
$$;
--> statement-breakpoint
CREATE TRIGGER exercise_equipment_fit_assertions_scope_and_identity_guard
BEFORE INSERT OR UPDATE OF "id", "user_id", "exercise_id", "equipment_item_id"
ON "exercise_equipment_fit_assertions"
FOR EACH ROW EXECUTE FUNCTION validate_exercise_equipment_fit_assertion();
--> statement-breakpoint

-- Full restore replaces current prospective fit truth only after exact stale
-- comparison. History-only restore preserves it. The wrapper remains atomic
-- with the established restore function and fails closed on concurrent writes.
ALTER FUNCTION restore_user_snapshot(uuid, text, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO restore_user_snapshot_without_exercise_equipment_fit_assertions;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION restore_user_snapshot(
  p_user_id uuid,
  p_scope text,
  p_expected_current jsonb,
  p_target_rows jsonb,
  p_dependency_rows jsonb,
  p_source_snapshot_id uuid,
  p_safety_snapshot_id uuid,
  p_fail_after_table text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_expected jsonb := COALESCE(
    p_expected_current->'exercise_equipment_fit_assertions',
    '[]'::jsonb
  );
  v_target jsonb := COALESCE(
    p_target_rows->'exercise_equipment_fit_assertions',
    '[]'::jsonb
  );
  v_current jsonb;
  v_result jsonb;
  v_added integer := 0;
BEGIN
  IF p_scope NOT IN ('full', 'history') THEN
    RAISE EXCEPTION 'Snapshot restore scope must be full or history.'
      USING ERRCODE = '22023';
  END IF;

  IF p_scope = 'full' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 847221));
    -- Match the management writer's owner-row-first lock order when the
    -- destination already has a profile. A fresh full-restore destination may
    -- legitimately contain only the owner row; the wrapped restore recreates
    -- that profile atomically before assertion rows are inserted.
    PERFORM 1
    FROM user_profiles profile
    WHERE profile.user_id = p_user_id
    FOR UPDATE;
    LOCK TABLE exercise_equipment_fit_assertions IN SHARE ROW EXCLUSIVE MODE;

    SELECT COALESCE(jsonb_agg(to_jsonb(assertion) ORDER BY assertion.id), '[]'::jsonb)
      INTO v_current
    FROM exercise_equipment_fit_assertions assertion
    WHERE assertion.user_id = p_user_id;

    IF v_current IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Restore preview is stale for table exercise_equipment_fit_assertions.'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  v_result := restore_user_snapshot_without_exercise_equipment_fit_assertions(
    p_user_id,
    p_scope,
    p_expected_current - 'exercise_equipment_fit_assertions',
    p_target_rows - 'exercise_equipment_fit_assertions',
    p_dependency_rows - 'exercise_equipment_fit_assertions',
    p_source_snapshot_id,
    p_safety_snapshot_id,
    p_fail_after_table
  );

  IF p_scope = 'full' THEN
    -- Do not rely on a parent-table cascade: the target may intentionally be
    -- empty, and unchanged equipment rows are not proof that old assertions
    -- belong in the restored prospective state.
    DELETE FROM exercise_equipment_fit_assertions
    WHERE user_id = p_user_id;

    IF jsonb_array_length(v_target) > 0 THEN
      INSERT INTO exercise_equipment_fit_assertions
      SELECT source.*
      FROM jsonb_populate_recordset(
        NULL::exercise_equipment_fit_assertions,
        v_target
      ) source;
      GET DIAGNOSTICS v_added = ROW_COUNT;
    END IF;
  END IF;

  IF p_fail_after_table = 'exercise_equipment_fit_assertions' THEN
    RAISE EXCEPTION 'Injected restore failure after table exercise_equipment_fit_assertions.';
  END IF;

  IF p_scope = 'full' AND EXISTS (
    SELECT 1
    FROM (
      SELECT COALESCE(
        jsonb_agg(to_jsonb(assertion) ORDER BY assertion.id),
        '[]'::jsonb
      ) AS rows
      FROM exercise_equipment_fit_assertions assertion
      WHERE assertion.user_id = p_user_id
    ) restored
    WHERE restored.rows IS DISTINCT FROM v_target
  ) THEN
    RAISE EXCEPTION 'Restored exercise-equipment fit assertions failed final verification.'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_set(
    v_result,
    '{restoredRecords}',
    to_jsonb(COALESCE((v_result->>'restoredRecords')::integer, 0) + v_added)
  );
END;
$$;
