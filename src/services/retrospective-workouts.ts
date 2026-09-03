import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { databaseConstraint, resultRows } from "@/db/result";
import {
  normalizeRetrospectiveWorkout,
  type RetrospectiveWorkoutInput,
} from "@/lib/retrospective-workout";
import { historyRevisionLockSql } from "@/services/history-revision-lock";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import { workoutReplacementUnavailableReason } from "@/lib/exercise-replacements";
import { getExerciseDiscoveryLibrary } from "@/services/exercise-discovery";
import { actionableProgramDayWarmupItemsSql } from "@/services/program-warmup-compatibility";
import { SESSION_COMPLETION_SEMANTICS_VERSION } from "@/lib/session-completion-semantics";

export type RetrospectiveWorkoutDependencies = {
  now?: () => Date;
  /** Test-only: a non-null value makes the final write gate fail atomically. */
  failureAt?: string;
};

export type RetrospectiveWorkoutResult =
  | { ok: true; outcome: "created" | "replayed"; sessionId: string }
  | {
      ok: false;
      code:
        | "conflict"
        | "stale_program"
        | "invalid_reference"
        | "count_mismatch"
        | "duplicate_warning_required"
        | "failed";
      reason: string;
      sessionId?: string;
    };

type PreparedExercise = {
  id: string;
  exerciseId: string;
  sourceTemplateExerciseId: string | null;
  substitutionReason: string | null;
  outcomes: Array<Record<string, unknown>>;
};

function payloadHash(value: unknown) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

async function reconcileRetrospectiveIdentity(
  db: Db,
  userId: string,
  requestId: string,
  hash: string,
): Promise<RetrospectiveWorkoutResult | null> {
  const row = resultRows(
    await db.execute(sql`
      SELECT session.id,
             audit.cause_ref->>'payloadHash' AS payload_hash
      FROM workout_sessions session
      JOIN audit_logs audit
        ON audit.user_id = session.user_id
       AND audit.idempotency_key =
          'history-manual:' || session.source_workout_key
      WHERE session.user_id = ${userId}::uuid
        AND session.source = 'history_manual'
        AND session.source_workout_key = ${requestId}
      LIMIT 1
    `),
  )[0];
  if (!row?.id) return null;
  if (row.payload_hash === hash) {
    return {
      ok: true,
      outcome: "replayed",
      sessionId: String(row.id),
    };
  }
  return {
    ok: false,
    code: "conflict",
    reason: "This request identity was already used for different workout facts.",
    sessionId: String(row.id),
  };
}

export async function createRetrospectiveWorkout(
  db: Db,
  userId: string,
  input: RetrospectiveWorkoutInput,
  dependencies: RetrospectiveWorkoutDependencies = {},
): Promise<RetrospectiveWorkoutResult> {
  const now = (dependencies.now ?? (() => new Date()))();
  const normalized = normalizeRetrospectiveWorkout(input, now);
  const { parsed } = normalized;
  const hash = payloadHash(parsed);
  const existingIdentity = await reconcileRetrospectiveIdentity(
    db,
    userId,
    parsed.requestId,
    hash,
  );
  if (existingIdentity) return existingIdentity;
  const discoveryLibrary = await getExerciseDiscoveryLibrary(db, userId);
  const discoveryById = new Map(
    discoveryLibrary.map((exercise) => [exercise.id, exercise]),
  );
  const unsupportedSubstitution = parsed.exercises.find((exercise) => {
    if (!exercise.substitutionReason) return false;
    const performed = discoveryById.get(exercise.exerciseId);
    return !performed || workoutReplacementUnavailableReason(performed) != null;
  });
  if (unsupportedSubstitution) {
    return {
      ok: false,
      code: "invalid_reference",
      reason:
        "That performed substitution is not supported by the workout exercise-entry contract.",
    };
  }
  const exercises: PreparedExercise[] = parsed.exercises.map((exercise) => ({
    id: exercise.id,
    exerciseId: exercise.exerciseId,
    sourceTemplateExerciseId: exercise.sourceTemplateExerciseId,
    substitutionReason: exercise.substitutionReason,
    outcomes: exercise.outcomes.map((outcome) => ({
      ...outcome,
      completedSet:
        outcome.outcome === "completed"
          ? {
              ...outcome.completedSet,
              observedCompletionProvenance: outcome.completedSet.observedCompletedAtISO
                ? "manual_explicit"
                : "unknown",
              observedCompletionQuality: outcome.completedSet.observedCompletedAtISO
                ? "owner_reported"
                : "unknown",
            }
          : null,
    })),
  }));
  const exercisesJson = canonicalJson(exercises);
  const link = parsed.link.kind === "program_day" ? parsed.link : null;
  const semanticIdentityBase = [
    "history-manual-date",
    parsed.localDate,
    link?.dayLineageId ?? "unlinked",
  ].join(":");
  const expectedExercises = exercises.length;
  const expectedSets = exercises.reduce(
    (sum, exercise) =>
      sum +
      exercise.outcomes.filter((outcome) => outcome.outcome === "completed").length,
    0,
  );
  const expectedOccurrences = exercises.reduce(
    (sum, exercise) => sum + exercise.outcomes.length,
    0,
  );

  const query = sql`
    WITH owner_lock AS MATERIALIZED (
      ${historyRevisionLockSql(userId)}
    ), existing AS MATERIALIZED (
      SELECT session.id, audit.cause_ref->>'payloadHash' AS payload_hash
      FROM workout_sessions session
      LEFT JOIN audit_logs audit
        ON audit.user_id = session.user_id
       AND audit.idempotency_key =
          'history-manual:' || session.source_workout_key
      WHERE session.user_id = ${userId}::uuid
        AND session.source = 'history_manual'
        AND session.source_workout_key = ${parsed.requestId}
      LIMIT 1
    ), profile AS MATERIALIZED (
      SELECT account.id AS user_id, profile.coaching_prefs
      FROM users account
      JOIN user_profiles profile ON profile.user_id = account.id
      CROSS JOIN owner_lock
      WHERE account.id = ${userId}::uuid
    ), reviewed_exercises AS MATERIALIZED (
      SELECT value, ordinality::integer - 1 AS order_idx
      FROM jsonb_array_elements(${exercisesJson}::jsonb)
        WITH ORDINALITY AS item(value, ordinality)
    ), reviewed_outcomes AS MATERIALIZED (
      SELECT exercise.value AS exercise,
             exercise.order_idx,
             outcome.value AS outcome
      FROM reviewed_exercises exercise
      CROSS JOIN LATERAL jsonb_array_elements(exercise.value->'outcomes')
        AS outcome(value)
    ), owned_program AS MATERIALIZED (
      SELECT
        program.id AS program_id,
        version.id AS version_id,
        template.id AS template_id,
        template.lineage_id AS day_lineage_id,
        template.name,
        template.warmup_notes,
        template.warmup_items,
        ${actionableProgramDayWarmupItemsSql({
          lineageId: sql`template.lineage_id`,
          fallbackItemKey: sql`template.id`,
          warmupNotes: sql`template.warmup_notes`,
          warmupItems: sql`template.warmup_items`,
        })} AS effective_warmup_items
      FROM programs program
      JOIN program_versions version ON version.program_id = program.id
      JOIN workout_templates template ON template.program_version_id = version.id
      WHERE ${link?.programId ?? null}::uuid IS NOT NULL
        AND program.id = ${link?.programId ?? null}::uuid
        AND version.id = ${link?.programVersionId ?? null}::uuid
        AND template.id = ${link?.templateId ?? null}::uuid
        AND template.lineage_id = ${link?.dayLineageId ?? null}::uuid
        AND program.user_id = ${userId}::uuid
        AND program.archived_at IS NULL
        AND program.status = 'active'
        AND program.current_version_id = version.id
      FOR SHARE OF program
    ), validation AS MATERIALIZED (
      SELECT
        (${link == null} OR EXISTS (SELECT 1 FROM owned_program))
          AS program_valid,
        NOT EXISTS (
          SELECT 1
          FROM reviewed_exercises reviewed
          LEFT JOIN exercises exercise
            ON exercise.id = (reviewed.value->>'exerciseId')::uuid
           AND (exercise.user_id IS NULL OR exercise.user_id = ${userId}::uuid)
          WHERE exercise.id IS NULL
        ) AS exercises_valid,
        NOT EXISTS (
          SELECT 1
          FROM reviewed_outcomes reviewed
          JOIN exercises exercise
            ON exercise.id = (reviewed.exercise->>'exerciseId')::uuid
          WHERE reviewed.outcome->>'outcome' = 'completed'
            AND (
              (
                reviewed.outcome->'completedSet'->>'weight' IS NOT NULL
                AND exercise.metric_type NOT IN ('weight_reps', 'assisted_reps')
              )
              OR (
                reviewed.outcome->'completedSet'->>'reps' IS NOT NULL
                AND exercise.metric_type NOT IN (
                  'weight_reps', 'reps', 'assisted_reps', 'activity'
                )
              )
              OR (
                reviewed.outcome->'completedSet'->>'distanceKm' IS NOT NULL
                AND exercise.metric_type NOT IN ('distance_duration', 'activity')
              )
              OR (
                reviewed.outcome->'completedSet'->>'durationSeconds' IS NOT NULL
                AND exercise.metric_type NOT IN (
                  'duration', 'distance_duration', 'activity'
                )
              )
              OR (
                exercise.metric_type IN ('weight_reps', 'reps', 'assisted_reps')
                AND reviewed.outcome->'completedSet'->>'reps' IS NULL
              )
              OR (
                exercise.metric_type = 'duration'
                AND reviewed.outcome->'completedSet'->>'durationSeconds' IS NULL
              )
              OR (
                exercise.metric_type = 'distance_duration'
                AND reviewed.outcome->'completedSet'->>'distanceKm' IS NULL
                AND reviewed.outcome->'completedSet'->>'durationSeconds' IS NULL
              )
              OR (
                exercise.metric_type = 'activity'
                AND reviewed.outcome->'completedSet'->>'reps' IS NULL
                AND reviewed.outcome->'completedSet'->>'distanceKm' IS NULL
                AND reviewed.outcome->'completedSet'->>'durationSeconds' IS NULL
              )
            )
        ) AS set_metrics_valid,
        (
          ${link == null}
          OR NOT EXISTS (
            SELECT 1
            FROM reviewed_exercises reviewed
            LEFT JOIN workout_template_exercises slot
              ON slot.id =
                 (reviewed.value->>'sourceTemplateExerciseId')::uuid
             AND slot.workout_template_id = ${link?.templateId ?? null}::uuid
            WHERE reviewed.value->>'sourceTemplateExerciseId' IS NULL
               OR slot.id IS NULL
          )
        ) AS slots_valid,
        (
          ${link == null}
          OR NOT EXISTS (
            SELECT 1
            FROM reviewed_exercises reviewed
            JOIN workout_template_exercises slot
              ON slot.id =
                 (reviewed.value->>'sourceTemplateExerciseId')::uuid
             AND slot.workout_template_id = ${link?.templateId ?? null}::uuid
            JOIN exercises performed
              ON performed.id = (reviewed.value->>'exerciseId')::uuid
            WHERE (
              performed.id = slot.exercise_id
              AND reviewed.value->>'substitutionReason' IS NOT NULL
            ) OR (
              performed.id <> slot.exercise_id
              AND (
                reviewed.value->>'substitutionReason' IS NULL
                OR reviewed.value->>'substitutionReason'
                   NOT IN (
                     'variety',
                     'equipment_busy',
                     'equipment_unavailable_incompatible',
                     'discomfort',
                     'other'
                   )
                OR performed.activity_class <> 'strength'
                OR performed.metric_type
                   NOT IN ('weight_reps', 'reps', 'assisted_reps')
                OR performed.movement_pattern
                   IN ('conditioning', 'locomotion', 'mobility', 'stretch')
              )
            )
          )
        ) AS substitutions_valid,
        (
          ${link == null}
          OR (
            SELECT count(DISTINCT reviewed.value->>'sourceTemplateExerciseId')
            FROM reviewed_exercises reviewed
          ) = (
            SELECT count(*)
            FROM workout_template_exercises slot
            WHERE slot.workout_template_id = ${link?.templateId ?? null}::uuid
          )
        ) AS slot_set_valid,
        (
          ${link == null}
          OR (
            SELECT count(*) FROM reviewed_exercises
          ) = (
            SELECT count(*)
            FROM workout_template_exercises slot
            WHERE slot.workout_template_id = ${link?.templateId ?? null}::uuid
          )
        ) AS exercise_count_valid,
        (
          ${link == null}
          OR NOT EXISTS (
            SELECT 1
            FROM reviewed_exercises reviewed
            JOIN workout_template_exercises slot
              ON slot.id =
                 (reviewed.value->>'sourceTemplateExerciseId')::uuid
            LEFT JOIN LATERAL (
              SELECT prescription.sets
              FROM exercise_prescriptions prescription
              WHERE prescription.template_exercise_id = slot.id
                AND prescription.superseded_by_id IS NULL
              ORDER BY prescription.created_at DESC, prescription.id DESC
              LIMIT 1
            ) target ON true
            WHERE jsonb_array_length(reviewed.value->'outcomes')
                  < coalesce(target.sets, 0)
          )
        ) AS occurrence_count_valid,
        (
          ${parsed.recordAnotherWorkout}
          OR NOT EXISTS (
            SELECT 1
            FROM workout_sessions duplicate
            WHERE duplicate.user_id = ${userId}::uuid
              AND duplicate.status = 'completed'
              AND duplicate.archived_at IS NULL
              AND duplicate.local_date = ${parsed.localDate}::date
              AND (
                (${link?.dayLineageId ?? null}::uuid IS NULL
                  AND duplicate.source_day_lineage_id IS NULL)
                OR duplicate.source_day_lineage_id =
                   ${link?.dayLineageId ?? null}::uuid
              )
          )
        ) AS duplicate_confirmed
    ), duplicate_reservation AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT
        profile.user_id,
        'user',
        'history.workout.reserve_duplicate_identity',
        'history_manual_request',
        ${parsed.requestId},
        'Reserved a reviewed retrospective workout identity',
        jsonb_build_object(
          'requestId', ${parsed.requestId}::text,
          'localDate', ${parsed.localDate}::text,
          'dayLineageId', ${link?.dayLineageId ?? null}::text
        ),
        ${semanticIdentityBase} || ':' || (
          SELECT (count(*) + 1)::text
          FROM audit_logs prior
          WHERE prior.user_id = ${userId}::uuid
            AND prior.idempotency_key LIKE ${semanticIdentityBase} || ':%'
        )
      FROM profile
      CROSS JOIN validation
      WHERE NOT ${parsed.recordAnotherWorkout}
        AND NOT EXISTS (SELECT 1 FROM existing)
        AND validation.program_valid
        AND validation.exercises_valid
        AND validation.set_metrics_valid
        AND validation.slots_valid
        AND validation.substitutions_valid
        AND validation.slot_set_valid
        AND validation.exercise_count_valid
        AND validation.occurrence_count_valid
        AND validation.duplicate_confirmed
      ON CONFLICT (user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING id
    ), eligible AS MATERIALIZED (
      SELECT profile.*
      FROM profile
      CROSS JOIN validation
      WHERE NOT EXISTS (SELECT 1 FROM existing)
        AND validation.program_valid
        AND validation.exercises_valid
        AND validation.set_metrics_valid
        AND validation.slots_valid
        AND validation.substitutions_valid
        AND validation.slot_set_valid
        AND validation.exercise_count_valid
        AND validation.occurrence_count_valid
        AND validation.duplicate_confirmed
        AND (
          ${parsed.recordAnotherWorkout}
          OR EXISTS (SELECT 1 FROM duplicate_reservation)
        )
    ), completion_classification AS MATERIALIZED (
      SELECT
        EXISTS (
          SELECT 1
          FROM reviewed_outcomes reviewed
          WHERE reviewed.outcome->>'outcome' = 'legacy_unrecorded'
        )
        OR EXISTS (
          SELECT 1
          FROM owned_program
          WHERE jsonb_array_length(owned_program.effective_warmup_items) > 0
        )
        OR EXISTS (
          SELECT 1
          FROM reviewed_exercises reviewed
          JOIN workout_template_exercises slot
            ON slot.id =
               (reviewed.value->>'sourceTemplateExerciseId')::uuid
          WHERE jsonb_array_length(slot.warmup_sets) > 0
        ) AS has_unknown_outcomes,
        EXISTS (
          SELECT 1
          FROM reviewed_outcomes reviewed
          WHERE reviewed.outcome->>'outcome' = 'skipped'
        )
        OR EXISTS (
          SELECT 1
          FROM reviewed_exercises reviewed
          LEFT JOIN workout_template_exercises slot
            ON slot.id =
               (reviewed.value->>'sourceTemplateExerciseId')::uuid
           AND slot.workout_template_id = ${link?.templateId ?? null}::uuid
          LEFT JOIN LATERAL (
            SELECT active.sets
            FROM exercise_prescriptions active
            WHERE active.template_exercise_id = slot.id
              AND active.superseded_by_id IS NULL
            ORDER BY active.created_at DESC, active.id DESC
            LIMIT 1
          ) target ON true
          WHERE slot.id IS NULL
             OR slot.exercise_id <>
                (reviewed.value->>'exerciseId')::uuid
             OR jsonb_array_length(reviewed.value->'outcomes') >
                coalesce(target.sets, 0)
        ) AS has_plan_changes
    ), inserted_session AS (
      INSERT INTO workout_sessions (
        id, user_id, template_id, template_name, day_warmup_notes,
        day_warmup_items, source, source_workout_key, history_revision,
        performed_time_precision, source_program_id, source_program_version_id,
        source_day_lineage_id, data_quality_flags,
        exclude_duration_from_analytics, status, started_at, timezone,
        local_date, finished_at, completion_semantics_version,
        completion_state, completion_reason
      )
      SELECT
        ${parsed.sessionId}::uuid,
        eligible.user_id,
        ${link?.templateId ?? null}::uuid,
        CASE WHEN ${link == null} THEN 'Retrospective workout'
             ELSE owned_program.name END,
        owned_program.warmup_notes,
        coalesce(owned_program.effective_warmup_items, '[]'::jsonb),
        'history_manual',
        ${parsed.requestId},
        0,
        ${normalized.performedTimePrecision},
        ${link?.programId ?? null}::uuid,
        ${link?.programVersionId ?? null}::uuid,
        ${link?.dayLineageId ?? null}::uuid,
        CASE WHEN ${normalized.performedTimePrecision} = 'date_only'
             THEN '["unknown_time"]'::jsonb ELSE '[]'::jsonb END,
        ${normalized.excludeDurationFromAnalytics},
        'completed',
        ${normalized.startedAt.toISOString()}::timestamptz,
        ${parsed.timezone},
        ${parsed.localDate}::date,
        ${normalized.finishedAt?.toISOString() ?? null}::timestamptz,
        CASE WHEN completion_classification.has_unknown_outcomes
          THEN NULL::integer
          ELSE ${SESSION_COMPLETION_SEMANTICS_VERSION}::integer
        END,
        CASE
          WHEN completion_classification.has_unknown_outcomes THEN NULL::text
          WHEN ${link == null}::boolean
            THEN 'completed_without_prescription'
          WHEN completion_classification.has_plan_changes
            THEN 'completed_with_changes'
          ELSE 'completed_as_prescribed'
        END,
        NULL::text
      FROM eligible
      CROSS JOIN completion_classification
      LEFT JOIN owned_program ON true
      RETURNING id, user_id
    ), inserted_groups AS (
      INSERT INTO session_exercise_groups (
        id, session_id, source_group_id, lineage_id, provenance, name,
        order_idx, planned_rounds, member_count, rest_between_members_sec,
        rest_between_rounds_sec
      )
      SELECT
        md5(${parsed.sessionId} || ':group:' || source.id::text)::uuid,
        inserted_session.id,
        source.id,
        source.lineage_id,
        CASE
          WHEN stats.minimum_sets = stats.maximum_sets THEN 'program'
          ELSE 'legacy'
        END,
        source.name,
        source.order_idx,
        CASE WHEN stats.minimum_sets = stats.maximum_sets
             THEN coalesce(source.planned_rounds, stats.minimum_sets) END,
        stats.member_count,
        coalesce(source.rest_between_members_sec, 0),
        source.rest_after_round_sec
      FROM inserted_session
      JOIN superset_groups source
        ON source.workout_template_id = ${link?.templateId ?? null}::uuid
      JOIN LATERAL (
        SELECT count(*)::integer AS member_count,
               min(target.sets)::integer AS minimum_sets,
               max(target.sets)::integer AS maximum_sets
        FROM workout_template_exercises member
        JOIN exercise_prescriptions target
          ON target.template_exercise_id = member.id
         AND target.superseded_by_id IS NULL
        WHERE member.superset_group_id = source.id
      ) stats ON true
      RETURNING id, source_group_id, rest_between_members_sec,
                rest_between_rounds_sec
    ), inserted_exercises AS (
      INSERT INTO session_exercises (
        id, session_id, exercise_id, planned_from_template_exercise_id,
        source_slot_lineage_id, modification_type, substituted_for_exercise_id,
        substitution_reason, substituted_at, order_idx, superset_key,
        group_snapshot_id, group_member_order_idx, rest_sec, target_sets,
        target_reps_min, target_reps_max, target_load, target_load_unit,
        notes, warmup_notes, warmup_sets, set_notes
      )
      SELECT
        (reviewed.value->>'id')::uuid,
        inserted_session.id,
        (reviewed.value->>'exerciseId')::uuid,
        slot.id,
        slot.lineage_id,
        CASE WHEN slot.id IS NULL THEN 'added'::modification_type
             WHEN slot.exercise_id <> (reviewed.value->>'exerciseId')::uuid
               THEN 'substituted'::modification_type
             ELSE 'as_planned'::modification_type END,
        CASE
          WHEN slot.exercise_id <> (reviewed.value->>'exerciseId')::uuid
            THEN slot.exercise_id
          ELSE NULL::uuid
        END,
        (reviewed.value->>'substitutionReason')::substitution_reason,
        CASE
          WHEN slot.exercise_id <> (reviewed.value->>'exerciseId')::uuid
            THEN statement_timestamp()
          ELSE NULL::timestamptz
        END,
        coalesce(slot.order_idx, reviewed.order_idx),
        slot.superset_group_id::text,
        session_group.id,
        CASE WHEN session_group.id IS NULL THEN NULL ELSE
          coalesce(
            slot.group_member_order_idx,
            row_number() OVER (
              PARTITION BY slot.superset_group_id
              ORDER BY slot.order_idx, slot.id
            )::integer - 1
          )
        END,
        coalesce(slot.rest_sec, 0),
        target.sets,
        target.rep_range_min,
        target.rep_range_max,
        CASE
          WHEN slot.exercise_id <> (reviewed.value->>'exerciseId')::uuid
            THEN NULL::numeric
          ELSE target.target_load
        END,
        CASE
          WHEN slot.exercise_id <> (reviewed.value->>'exerciseId')::uuid
            THEN NULL::unit
          ELSE target.target_load_unit
        END,
        CASE
          WHEN slot.exercise_id <> (reviewed.value->>'exerciseId')::uuid
            THEN NULL::text
          ELSE slot.notes
        END,
        CASE
          WHEN slot.exercise_id <> (reviewed.value->>'exerciseId')::uuid
            THEN NULL::text
          ELSE slot.warmup_notes
        END,
        CASE
          WHEN slot.exercise_id <> (reviewed.value->>'exerciseId')::uuid
            THEN '[]'::jsonb
          ELSE coalesce(slot.warmup_sets, '[]'::jsonb)
        END,
        CASE
          WHEN slot.exercise_id <> (reviewed.value->>'exerciseId')::uuid
            THEN '[]'::jsonb
          ELSE coalesce(slot.set_notes, '[]'::jsonb)
        END
      FROM reviewed_exercises reviewed
      CROSS JOIN inserted_session
      LEFT JOIN workout_template_exercises slot
        ON slot.id = (reviewed.value->>'sourceTemplateExerciseId')::uuid
       AND slot.workout_template_id = ${link?.templateId ?? null}::uuid
      LEFT JOIN LATERAL (
        SELECT active.*
        FROM exercise_prescriptions active
        WHERE active.template_exercise_id = slot.id
          AND active.superseded_by_id IS NULL
        ORDER BY active.created_at DESC, active.id DESC
        LIMIT 1
      ) target ON true
      LEFT JOIN inserted_groups session_group
        ON session_group.source_group_id = slot.superset_group_id
      RETURNING *
    ), inserted_sets AS (
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit,
        equipment_snapshot_id, load_entry_meaning, reps, metric_type,
        performed_semantics_version, performed_load_type,
        performed_load_semantics,
        distance_km, duration_seconds, rpe, target_met, rest_taken_sec,
        note, client_key, logged_at, observed_completed_at,
        observed_completion_provenance, observed_completion_quality
      )
      SELECT
        (reviewed.outcome->'completedSet'->>'id')::uuid,
        exercise.id,
        (reviewed.outcome->'completedSet'->>'setNo')::integer,
        (reviewed.outcome->'completedSet'->>'weight')::double precision,
        (reviewed.outcome->'completedSet'->>'weightUnit')::unit,
        NULL::uuid,
        'legacy_unknown',
        (reviewed.outcome->'completedSet'->>'reps')::integer,
        definition.metric_type,
        1,
        definition.load_type,
        definition.load_semantics,
        (reviewed.outcome->'completedSet'->>'distanceKm')::real,
        (reviewed.outcome->'completedSet'->>'durationSeconds')::integer,
        (reviewed.outcome->'completedSet'->>'rpe')::real,
        NULL::boolean,
        (reviewed.outcome->'completedSet'->>'restTakenSec')::integer,
        reviewed.outcome->'completedSet'->>'note',
        reviewed.outcome->'completedSet'->>'clientKey',
        statement_timestamp(),
        (reviewed.outcome->'completedSet'->>'observedCompletedAtISO')::timestamptz,
        reviewed.outcome->'completedSet'->>'observedCompletionProvenance',
        reviewed.outcome->'completedSet'->>'observedCompletionQuality'
      FROM reviewed_outcomes reviewed
      JOIN inserted_exercises exercise
        ON exercise.id = (reviewed.exercise->>'id')::uuid
      JOIN exercises definition ON definition.id = exercise.exercise_id
      WHERE reviewed.outcome->>'outcome' = 'completed'
      RETURNING id, session_exercise_id, weight, weight_unit, reps
    ), day_warmup_occurrences AS MATERIALIZED (
      SELECT
        md5(${parsed.sessionId} || ':day-warmup:' ||
            (item.ordinality::integer - 1)::text)::uuid AS id,
        'day_warmup'::text AS kind,
        NULL::uuid AS session_exercise_id,
        NULL::uuid AS planned_exercise_id,
        item.value->>'label' AS label,
        (item.value->>'reps')::integer AS planned_reps_min,
        (item.value->>'reps')::integer AS planned_reps_max,
        (item.value->>'load')::numeric AS planned_load,
        CASE WHEN item.value->>'load' IS NULL THEN NULL::unit
             ELSE (item.value->>'loadUnit')::unit END AS planned_load_unit,
        (item.value->>'loadPercent')::numeric AS planned_load_percent,
        item.value->>'loadText' AS planned_load_text,
        item.value->>'notes' AS planned_note,
        item.ordinality::integer - 1 AS kind_ordinal,
        item.ordinality::integer - 1 AS sequence_idx
      FROM owned_program
      CROSS JOIN LATERAL jsonb_array_elements(
        owned_program.effective_warmup_items
      )
        WITH ORDINALITY AS item(value, ordinality)
      WHERE EXISTS (SELECT 1 FROM inserted_session)
    ), exercise_warmup_source AS MATERIALIZED (
      SELECT
        exercise.id AS session_exercise_id,
        slot.exercise_id AS planned_exercise_id,
        exercise.order_idx,
        item.ordinality::integer - 1 AS local_order,
        item.value
      FROM inserted_exercises exercise
      JOIN workout_template_exercises slot
        ON slot.id = exercise.planned_from_template_exercise_id
      CROSS JOIN LATERAL jsonb_array_elements(slot.warmup_sets)
        WITH ORDINALITY AS item(value, ordinality)
    ), exercise_warmup_occurrences AS MATERIALIZED (
      SELECT
        md5(${parsed.sessionId} || ':exercise-warmup:' ||
            source.session_exercise_id::text || ':' ||
            (row_number() OVER (
              PARTITION BY source.session_exercise_id
              ORDER BY source.local_order
            )::integer - 1)::text)::uuid AS id,
        'exercise_warmup'::text AS kind,
        source.session_exercise_id,
        source.planned_exercise_id,
        source.value->>'label' AS label,
        (source.value->>'reps')::integer AS planned_reps_min,
        (source.value->>'reps')::integer AS planned_reps_max,
        (source.value->>'load')::numeric AS planned_load,
        CASE WHEN source.value->>'load' IS NULL THEN NULL::unit
             ELSE (source.value->>'loadUnit')::unit END AS planned_load_unit,
        (source.value->>'loadPercent')::numeric AS planned_load_percent,
        source.value->>'loadText' AS planned_load_text,
        source.value->>'notes' AS planned_note,
        row_number() OVER (
          PARTITION BY source.session_exercise_id
          ORDER BY source.local_order
        )::integer - 1 AS kind_ordinal,
        (SELECT count(*) FROM day_warmup_occurrences)
          + row_number() OVER (
              ORDER BY source.order_idx, source.local_order,
                       source.session_exercise_id
            )::integer - 1 AS sequence_idx
      FROM exercise_warmup_source source
    ), warmup_occurrences AS MATERIALIZED (
      SELECT * FROM day_warmup_occurrences
      UNION ALL
      SELECT * FROM exercise_warmup_occurrences
    ), working_occurrence_source AS MATERIALIZED (
      SELECT
        reviewed.outcome,
        exercise.*,
        completed.id AS completed_set_id,
        completed.weight AS performed_load,
        completed.weight_unit AS performed_load_unit,
        completed.reps AS performed_reps,
        planned_slot.exercise_id AS source_planned_exercise_id,
        planned_target.rep_range_min AS source_planned_reps_min,
        planned_target.rep_range_max AS source_planned_reps_max,
        planned_target.target_load AS source_planned_load,
        planned_target.target_load_unit AS source_planned_load_unit,
        planned_slot.set_notes AS source_set_notes,
        (reviewed.outcome->>'ordinal')::integer + 1 AS round_number,
        CASE
          WHEN (reviewed.outcome->>'ordinal')::integer
                 >= coalesce(exercise.target_sets, 0)
            THEN 1000000 + exercise.order_idx
          ELSE coalesce(group_anchor.first_order_idx, exercise.order_idx)
        END
          AS unit_order_idx,
        CASE
          WHEN (reviewed.outcome->>'ordinal')::integer
                 >= coalesce(exercise.target_sets, 0)
            THEN NULL::uuid
          ELSE exercise.group_snapshot_id
        END AS occurrence_group_snapshot_id,
        CASE
          WHEN (reviewed.outcome->>'ordinal')::integer
                 >= coalesce(exercise.target_sets, 0)
            THEN NULL::integer
          ELSE exercise.group_member_order_idx
        END AS occurrence_group_member_order_idx,
        session_group.rest_between_members_sec,
        session_group.rest_between_rounds_sec
      FROM reviewed_outcomes reviewed
      JOIN inserted_exercises exercise
        ON exercise.id = (reviewed.exercise->>'id')::uuid
      LEFT JOIN inserted_sets completed
        ON completed.id =
           (reviewed.outcome->'completedSet'->>'id')::uuid
      LEFT JOIN workout_template_exercises planned_slot
        ON planned_slot.id = exercise.planned_from_template_exercise_id
      LEFT JOIN LATERAL (
        SELECT active.*
        FROM exercise_prescriptions active
        WHERE active.template_exercise_id = planned_slot.id
          AND active.superseded_by_id IS NULL
        ORDER BY active.created_at DESC, active.id DESC
        LIMIT 1
      ) planned_target ON true
      LEFT JOIN LATERAL (
        SELECT min(member.order_idx)::integer AS first_order_idx
        FROM inserted_exercises member
        WHERE member.group_snapshot_id = exercise.group_snapshot_id
      ) group_anchor ON exercise.group_snapshot_id IS NOT NULL
      LEFT JOIN inserted_groups session_group
        ON session_group.id = exercise.group_snapshot_id
    ), ordered_working_occurrences AS MATERIALIZED (
      SELECT source.*,
        lag(source.performed_reps) OVER (
          PARTITION BY source.id ORDER BY source.round_number
        ) AS previous_performed_reps,
        lag(source.performed_load) OVER (
          PARTITION BY source.id ORDER BY source.round_number
        ) AS previous_performed_load,
        lag(source.performed_load_unit) OVER (
          PARTITION BY source.id ORDER BY source.round_number
        ) AS previous_performed_load_unit,
        row_number() OVER (
          ORDER BY source.unit_order_idx, source.round_number,
                   coalesce(source.occurrence_group_member_order_idx, 0),
                   source.order_idx, source.id
        )::integer - 1 AS global_ordinal,
        lead(source.occurrence_group_snapshot_id) OVER (
          ORDER BY source.unit_order_idx, source.round_number,
                   coalesce(source.occurrence_group_member_order_idx, 0),
                   source.order_idx, source.id
        ) AS next_group_snapshot_id,
        lead(source.round_number) OVER (
          ORDER BY source.unit_order_idx, source.round_number,
                   coalesce(source.occurrence_group_member_order_idx, 0),
                   source.order_idx, source.id
        ) AS next_round_number
      FROM working_occurrence_source source
    ), inserted_occurrences AS (
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, label, planned_exercise_id, planned_reps_min,
        planned_reps_max, planned_load, planned_load_unit,
        planned_load_percent, planned_load_text, planned_rest_sec,
        planned_note, group_snapshot_id, group_round,
        group_member_order_idx, outcome, outcome_reason,
        resolution_semantics_version, resolution_reason_code, outcome_note,
        resolved_at, completed_set_id
      )
      SELECT
        warmup.id,
        inserted_session.id,
        warmup.session_exercise_id,
        warmup.kind,
        'planned',
        warmup.sequence_idx,
        warmup.kind_ordinal,
        warmup.label,
        warmup.planned_exercise_id,
        warmup.planned_reps_min,
        warmup.planned_reps_max,
        warmup.planned_load,
        warmup.planned_load_unit,
        warmup.planned_load_percent,
        warmup.planned_load_text,
        NULL::integer,
        warmup.planned_note,
        NULL::uuid,
        NULL::integer,
        NULL::integer,
        'legacy_unrecorded',
        NULL::text,
        NULL::integer,
        NULL::text,
        NULL::text,
        NULL::timestamptz,
        NULL::uuid
      FROM warmup_occurrences warmup
      CROSS JOIN inserted_session
      UNION ALL
      SELECT
        (source.outcome->>'occurrenceId')::uuid,
        inserted_session.id,
        source.id,
        'working_set',
        CASE
          WHEN source.planned_from_template_exercise_id IS NULL
            OR source.round_number > coalesce(source.target_sets, 0)
             THEN 'ad_hoc' ELSE 'planned' END,
        (SELECT count(*) FROM warmup_occurrences)
          + source.global_ordinal,
        source.round_number - 1,
        NULL::text,
        CASE
          WHEN source.planned_from_template_exercise_id IS NULL
            OR source.round_number > coalesce(source.target_sets, 0)
            THEN source.exercise_id
          ELSE source.source_planned_exercise_id
        END,
        CASE
          WHEN source.planned_from_template_exercise_id IS NULL THEN NULL
          WHEN source.round_number > coalesce(source.target_sets, 0)
            THEN coalesce(
              source.previous_performed_reps,
              source.source_planned_reps_min
            )
          ELSE source.source_planned_reps_min
        END,
        CASE
          WHEN source.planned_from_template_exercise_id IS NULL THEN NULL
          WHEN source.round_number > coalesce(source.target_sets, 0)
            THEN coalesce(
              source.previous_performed_reps,
              source.source_planned_reps_max
            )
          ELSE source.source_planned_reps_max
        END,
        CASE
          WHEN source.planned_from_template_exercise_id IS NULL THEN NULL
          WHEN source.round_number > coalesce(source.target_sets, 0)
            THEN coalesce(
              source.previous_performed_load,
              source.source_planned_load
            )
          ELSE source.source_planned_load
        END,
        CASE
          WHEN source.planned_from_template_exercise_id IS NULL THEN NULL
          WHEN source.round_number > coalesce(source.target_sets, 0)
            THEN coalesce(
              source.previous_performed_load_unit,
              source.source_planned_load_unit
            )
          ELSE source.source_planned_load_unit
        END,
        NULL::numeric,
        NULL::text,
        CASE
          WHEN source.planned_from_template_exercise_id IS NULL
            THEN NULL::integer
          WHEN source.round_number > coalesce(source.target_sets, 0)
            THEN source.rest_sec
          WHEN source.occurrence_group_snapshot_id IS NULL THEN source.rest_sec
          WHEN source.next_group_snapshot_id
               IS DISTINCT FROM source.occurrence_group_snapshot_id THEN 0
          WHEN source.next_round_number = source.round_number
            THEN source.rest_between_members_sec
          ELSE source.rest_between_rounds_sec
        END,
        CASE
          WHEN source.planned_from_template_exercise_id IS NULL THEN NULL::text
          WHEN source.round_number > coalesce(source.target_sets, 0)
            THEN 'Added during this workout'
          ELSE source.source_set_notes->>(source.round_number - 1)
        END,
        source.occurrence_group_snapshot_id,
        CASE WHEN source.occurrence_group_snapshot_id IS NULL THEN NULL::integer
             ELSE source.round_number END,
        source.occurrence_group_member_order_idx,
        source.outcome->>'outcome',
        CASE WHEN source.outcome->>'outcome' = 'skipped'
          THEN coalesce(
            source.outcome->>'reasonCode',
            source.outcome->>'reason'
          )
          ELSE NULL::text
        END,
        (source.outcome->>'resolutionSemanticsVersion')::integer,
        source.outcome->>'reasonCode',
        source.outcome->>'note',
        CASE WHEN source.outcome->>'outcome' = 'legacy_unrecorded'
             THEN NULL::timestamptz ELSE statement_timestamp() END,
        source.completed_set_id
      FROM ordered_working_occurrences source
      CROSS JOIN inserted_session
      RETURNING id
    ), inserted_note AS (
      INSERT INTO session_notes (id, session_id, text)
      SELECT md5(${parsed.sessionId} || ':session-note')::uuid,
             inserted_session.id, ${parsed.sessionNote}
      FROM inserted_session
      WHERE ${parsed.sessionNote}::text IS NOT NULL
      RETURNING id
    ), counts AS MATERIALIZED (
      SELECT
        ${expectedExercises}::integer AS expected_exercises,
        (SELECT count(*)::integer FROM inserted_exercises) AS actual_exercises,
        ${expectedSets}::integer AS expected_sets,
        (SELECT count(*)::integer FROM inserted_sets) AS actual_sets,
        ${expectedOccurrences}::integer
          + (SELECT count(*)::integer FROM warmup_occurrences)
          AS expected_occurrences,
        (SELECT count(*)::integer FROM inserted_occurrences) AS actual_occurrences
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT
        CASE WHEN counts.expected_exercises = counts.actual_exercises
               AND counts.expected_sets = counts.actual_sets
               AND counts.expected_occurrences = counts.actual_occurrences
               AND ${dependencies.failureAt ?? null}::text IS NULL
             THEN inserted_session.user_id ELSE NULL::uuid END,
        'user',
        'history.workout.create',
        'workout_session',
        inserted_session.id::text,
        'Recorded a retrospective completed workout',
        jsonb_build_object(
          'requestId', ${parsed.requestId}::text,
          'payloadHash', ${hash}::text,
          'timePrecision', ${normalized.performedTimePrecision}::text,
          'programLinked', ${link != null}::boolean,
          'exerciseCount', counts.actual_exercises,
          'setCount', counts.actual_sets,
          'occurrenceCount', counts.actual_occurrences
        ),
        'history-manual:' || ${parsed.requestId}
      FROM inserted_session
      CROSS JOIN counts
      RETURNING id
    ), queued_progression AS (
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision,
        coaching_prefs, next_attempt_at
      )
      SELECT
        ${parsed.progressionJobId}::uuid,
        inserted_session.user_id,
        inserted_session.id,
        0,
        eligible.coaching_prefs,
        statement_timestamp()
      FROM inserted_session
      JOIN eligible ON eligible.user_id = inserted_session.user_id
      WHERE ${link != null}
        AND EXISTS (SELECT 1 FROM recorded_audit)
      ON CONFLICT (session_id, source_session_revision)
      DO UPDATE SET coaching_prefs = progression_jobs.coaching_prefs
      RETURNING id
    )
    SELECT
      CASE
        WHEN EXISTS (SELECT 1 FROM existing)
          AND (SELECT payload_hash FROM existing) = ${hash}
          THEN 'replayed'
        WHEN EXISTS (SELECT 1 FROM existing) THEN 'conflict'
        WHEN EXISTS (SELECT 1 FROM recorded_audit) THEN 'created'
        WHEN ${link != null} AND NOT EXISTS (SELECT 1 FROM owned_program)
          THEN 'stale_program'
        WHEN NOT EXISTS (SELECT 1 FROM profile) THEN 'invalid_reference'
        WHEN NOT (SELECT exercises_valid FROM validation)
          OR NOT (SELECT set_metrics_valid FROM validation)
          OR NOT (SELECT slots_valid FROM validation)
          OR NOT (SELECT substitutions_valid FROM validation)
          THEN 'invalid_reference'
        WHEN NOT (SELECT exercise_count_valid FROM validation)
          OR NOT (SELECT slot_set_valid FROM validation)
          OR NOT (SELECT occurrence_count_valid FROM validation)
          THEN 'count_mismatch'
        WHEN NOT (SELECT duplicate_confirmed FROM validation)
          THEN 'duplicate_warning_required'
        WHEN NOT ${parsed.recordAnotherWorkout}
          AND NOT EXISTS (SELECT 1 FROM duplicate_reservation)
          THEN 'duplicate_warning_required'
        ELSE 'failed'
      END AS outcome,
      coalesce(
        (SELECT id FROM inserted_session),
        (SELECT id FROM existing)
      ) AS session_id
  `;

  let row: Record<string, unknown> | undefined;
  try {
    row = resultRows(await db.execute(query))[0];
  } catch (error) {
    if (dependencies.failureAt) {
      return {
        ok: false,
        code:
          dependencies.failureAt === "count-mismatch"
            ? "count_mismatch"
            : "failed",
        reason:
          dependencies.failureAt === "count-mismatch"
            ? "Nothing was saved because the workout graph count did not match the reviewed payload."
            : "Nothing was saved because the database write did not complete.",
      };
    }
    const constraint = databaseConstraint(error);
    if (
      constraint === "workout_sessions_history_manual_source_uq" ||
      constraint === "audit_logs_idempotency_uq"
    ) {
      const reconciled = await reconcileRetrospectiveIdentity(
        db,
        userId,
        parsed.requestId,
        hash,
      );
      if (reconciled) return reconciled;
    }
    throw error;
  }
  const outcome = String(row?.outcome ?? "failed");
  const sessionId = row?.session_id ? String(row.session_id) : undefined;
  if (outcome === "created" || outcome === "replayed") {
    return { ok: true, outcome, sessionId: sessionId! };
  }
  if (outcome === "conflict") {
    return {
      ok: false,
      code: "conflict",
      reason: "This request identity was already used for different workout facts.",
      sessionId,
    };
  }
  if (outcome === "duplicate_warning_required") {
    const reconciled = await reconcileRetrospectiveIdentity(
      db,
      userId,
      parsed.requestId,
      hash,
    );
    if (reconciled) return reconciled;
  }
  if (outcome === "stale_program") {
    return {
      ok: false,
      code: "stale_program",
      reason: "The reviewed Program day is no longer current. Review the workout again.",
    };
  }
  if (outcome === "duplicate_warning_required") {
    return {
      ok: false,
      code: "duplicate_warning_required",
      reason: "A similar workout already exists on this date. Confirm recording another workout.",
    };
  }
  return {
    ok: false,
    code:
      outcome === "invalid_reference"
        ? "invalid_reference"
        : outcome === "count_mismatch"
          ? "count_mismatch"
          : "failed",
    reason:
      outcome === "count_mismatch"
        ? "Nothing was saved because the reviewed workout graph is incomplete."
        : "Nothing was saved because the reviewed workout no longer matches current owned evidence.",
  };
}
