import { and, desc, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { recordVersions } from "@/db/schema";
import type { RoutineWarmupSet } from "@/db/schema/user";
import { KG_TO_LB, type LoadUnit } from "@/lib/units";
import {
  eligiblePrescriptionOutcomeSql,
  restoredTargetMetSql,
} from "@/lib/set-metric-semantics-sql";
import {
  SET_CORRECTION_EVIDENCE_KEY,
  SET_CORRECTION_EVIDENCE_SCHEMA_VERSION,
  SET_CORRECTION_WRITER_VERSION,
  type SetCorrectionCategory,
} from "@/lib/set-correction";
import type { NormalizedActivity } from "@/services/activities";
import { historyRevisionLockSql } from "@/services/history-revision-lock";
import { restoreWorkoutTimingVersion } from "@/services/workout-timing-corrections";

export const VERSIONED_ENTITY_TYPES = [
  "health_activity",
  "workout_session",
  "completed_set",
  "session_exercise",
  "equipment_item",
  "plate_inventory",
  "barbell_config",
  "constraint",
  "program",
  "external_exercise_mapping",
  "user_profile",
] as const;

export type VersionedEntityType = (typeof VERSIONED_ENTITY_TYPES)[number];

export type VersionedEditResult =
  | {
      ok: true;
      id: string;
      changed: boolean;
      versionId: string | null;
      historyRevision?: number;
    }
  | { ok: false; reason: string };

export type SetVersionUpdate = {
  weight?: number | null;
  weightUnit?: LoadUnit | null;
  reps?: number | null;
  distanceKm?: number | null;
  durationSeconds?: number | null;
  rpe?: number | null;
  note?: string | null;
};

export type SetVersionExpected = {
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
  rpe: number | null;
  note: string | null;
};

export type SetCorrectionAction =
  | "set.active_correction"
  | "set.completed_correction";

export type SetCorrectionRequestEvidence = {
  category: SetCorrectionCategory;
  reasonNote: string | null;
  source: "active_workout" | "workout_history";
};

export type SessionExerciseVersionUpdate = {
  notes?: string | null;
  exerciseId?: string;
  modificationType?: "as_planned" | "substituted" | "added" | "skipped";
  skipReason?: "time" | "pain" | "fatigue" | "equipment" | "other" | null;
  substitutedForExerciseId?: string | null;
  substitutionReason?: "variety" | "equipment_busy" | "discomfort" | "other" | null;
  substitutedAt?: Date | null;
  targetLoad?: number | null;
  targetLoadUnit?: LoadUnit | null;
  warmupNotes?: string | null;
  warmupSets?: RoutineWarmupSet[];
  setNotes?: Array<string | null>;
};

export type SessionExerciseVersionAction =
  | "session_exercise.note_update"
  | "session_exercise.skip"
  | "session_exercise.unskip"
  | "session_exercise.substitute";

function editResult(result: unknown, notFound: string): VersionedEditResult {
  const row = resultRows(result)[0];
  if (!row) return { ok: false, reason: notFound };
  return {
    ok: true,
    id: String(row.id),
    changed: Boolean(row.changed),
    versionId: row.version_id ? String(row.version_id) : null,
  };
}

export async function updateActivityWithVersion(
  db: Db,
  userId: string,
  activityId: string,
  values: NormalizedActivity
): Promise<VersionedEditResult> {
  const versionId = randomUUID();
  const query = sql`
    WITH current_record AS MATERIALIZED (
      SELECT ha.*, to_jsonb(ha) AS before_data
      FROM health_activities ha
      WHERE ha.id = ${activityId}::uuid
        AND ha.user_id = ${userId}::uuid
        AND ha.source = 'manual'
        AND ha.archived_at IS NULL
      FOR UPDATE
    ), updated AS (
      UPDATE health_activities ha
      SET activity_type = ${values.activityType},
          title = ${values.title},
          started_at = ${values.startedAt.toISOString()}::timestamptz,
          timezone = ${values.timezone},
          duration_seconds = ${values.durationSeconds},
          distance_km = ${values.distanceKm},
          average_pace_seconds_per_km = ${values.averagePaceSecondsPerKm},
          intensity = ${values.intensity},
          elevation_gain_m = ${values.elevationGainM},
          average_heart_rate_bpm = ${values.averageHeartRateBpm},
          energy_kcal = ${values.energyKcal},
          notes = ${values.notes},
          source_metadata = ${JSON.stringify(values.sourceMetadata)}::jsonb,
          original_metrics = ${JSON.stringify(values.originalMetrics)}::jsonb,
          fingerprint = ${values.fingerprint},
          updated_at = now()
      FROM current_record current
      WHERE ha.id = current.id
        AND ROW(
          current.activity_type,
          current.title,
          current.started_at,
          current.timezone,
          current.duration_seconds,
          current.distance_km,
          current.average_pace_seconds_per_km,
          current.intensity,
          current.elevation_gain_m,
          current.average_heart_rate_bpm,
          current.energy_kcal,
          current.notes,
          current.source_metadata,
          current.original_metrics,
          current.fingerprint
        ) IS DISTINCT FROM ROW(
          ${values.activityType},
          ${values.title},
          ${values.startedAt.toISOString()}::timestamptz,
          ${values.timezone},
          ${values.durationSeconds},
          ${values.distanceKm},
          ${values.averagePaceSecondsPerKm},
          ${values.intensity},
          ${values.elevationGainM},
          ${values.averageHeartRateBpm},
          ${values.energyKcal},
          ${values.notes},
          ${JSON.stringify(values.sourceMetadata)}::jsonb,
          ${JSON.stringify(values.originalMetrics)}::jsonb,
          ${values.fingerprint}
        )
      RETURNING ha.*
    ), versioned AS (
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${versionId}::uuid,
        ${userId}::uuid,
        'health_activity',
        current.id,
        'activity.update',
        current.before_data,
        to_jsonb(updated),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(current.before_data) old_value
          JOIN jsonb_each(to_jsonb(updated)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
            AND old_value.key <> 'updated_at'
          ORDER BY old_value.key
        )
      FROM current_record current
      JOIN updated ON updated.id = current.id
      RETURNING id, changed_fields
    ), audited AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid,
        'user',
        'activity.update',
        'health_activity',
        current.id::text,
        'Updated activity and retained the previous values',
        jsonb_build_object('versionId', versioned.id, 'changedFields', versioned.changed_fields)
      FROM current_record current
      JOIN versioned ON TRUE
    )
    SELECT
      current.id,
      (updated.id IS NOT NULL) AS changed,
      versioned.id AS version_id
    FROM current_record current
    LEFT JOIN updated ON updated.id = current.id
    LEFT JOIN versioned ON TRUE
  `;
  return editResult(await db.execute(query), "Activity not found.");
}

export async function updateSetWithVersion(
  db: Db,
  userId: string,
  setId: string,
  values: SetVersionUpdate,
  action:
    | "set.update"
    | "set.retry_update"
    | SetCorrectionAction = "set.update",
  options: {
    activeOnly?: boolean;
    expected?: SetVersionExpected;
    expectedHistoryRevision?: number;
    clientMutationId?: string;
    correctionEvidence?: SetCorrectionRequestEvidence;
  } = {}
): Promise<VersionedEditResult> {
  const correction =
    action === "set.active_correction" ||
    action === "set.completed_correction";
  const correctionOptions = options;
  if (
    correction &&
    (correctionOptions.expectedHistoryRevision == null ||
      !correctionOptions.clientMutationId ||
      !correctionOptions.expected ||
      !correctionOptions.correctionEvidence)
  ) {
    throw new Error(
      "Set corrections require reviewed evidence, a stable mutation identity, and the expected workout revision.",
    );
  }
  if (
    action === "set.active_correction" &&
    correctionOptions.correctionEvidence?.source !== "active_workout"
  ) {
    throw new Error("An active-set correction needs active-workout provenance.");
  }
  if (
    action === "set.completed_correction" &&
    correctionOptions.correctionEvidence?.source !== "workout_history"
  ) {
    throw new Error("A historical set correction needs workout-history provenance.");
  }
  const versionId = correctionOptions.clientMutationId ?? randomUUID();
  const progressionJobId = randomUUID();
  const hasWeight = Object.hasOwn(values, "weight");
  const hasWeightUnit = Object.hasOwn(values, "weightUnit");
  const hasReps = Object.hasOwn(values, "reps");
  const hasDistanceKm = Object.hasOwn(values, "distanceKm");
  const hasDurationSeconds = Object.hasOwn(values, "durationSeconds");
  const hasRpe = Object.hasOwn(values, "rpe");
  const hasNote = Object.hasOwn(values, "note");
  const changesMeasurements =
    hasWeight || hasWeightUnit || hasReps || hasDistanceKm || hasDurationSeconds;
  if (
    correction &&
    !(
      hasWeight &&
      hasWeightUnit &&
      hasReps &&
      hasDistanceKm &&
      hasDurationSeconds &&
      hasRpe &&
      hasNote
    )
  ) {
    throw new Error("Set corrections must review the complete performed assertion.");
  }
  const candidateSemantics = {
    recordedMetricType: sql`candidate.metric_type`,
    performedSemanticsVersion: sql`candidate.performed_semantics_version`,
    performedLoadType: sql`candidate.performed_load_type`,
    performedLoadSemantics: sql`candidate.performed_load_semantics`,
    exerciseMetricType: sql`candidate.exercise_metric_type`,
    loadType: sql`candidate.exercise_load_type`,
    loadSemantics: sql`candidate.exercise_load_semantics`,
    loadEntryMeaning: sql`candidate.load_entry_meaning`,
    weight: sql`candidate.next_weight`,
    reps: sql`candidate.next_reps`,
    excludeFromAnalytics: sql`candidate.exclude_from_analytics`,
  };
  const query = sql`
    WITH history_revision_lock AS MATERIALIZED (
      ${historyRevisionLockSql(userId)}
    ), existing_version AS MATERIALIZED (
      SELECT version.*
      FROM record_versions version
      WHERE version.id = ${versionId}::uuid
        AND ${correction}::boolean
    ), current_record AS MATERIALIZED (
      SELECT
        cs.*,
        to_jsonb(cs) AS before_data,
        se.target_reps_min,
        se.target_load,
        se.target_load_unit,
        se.source_slot_lineage_id,
        se.modification_type,
        exercise.metric_type AS exercise_metric_type,
        exercise.load_type AS exercise_load_type,
        exercise.load_semantics AS exercise_load_semantics,
        ws.id AS workout_session_id,
        ws.status AS workout_status,
        ws.history_revision,
        ws.timezone AS workout_timezone,
        ws.local_date AS workout_local_date,
        COALESCE((
          SELECT max(
            CASE
              WHEN version.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'resultLedgerRevision'] ~ '^[0-9]+$'
                THEN (version.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'resultLedgerRevision'])::integer
              ELSE NULL
            END
          )
          FROM record_versions version
          WHERE version.user_id = ${userId}::uuid
            AND version.entity_type = 'completed_set'
            AND version.entity_id = cs.id
        ), 0) AS correction_ledger_revision
      FROM completed_sets cs
      CROSS JOIN history_revision_lock
      JOIN session_exercises se ON se.id = cs.session_exercise_id
      JOIN exercises exercise ON exercise.id = se.exercise_id
      JOIN workout_sessions ws ON ws.id = se.session_id
      WHERE cs.id = ${setId}::uuid
        AND ws.user_id = ${userId}::uuid
        AND cs.archived_at IS NULL
        AND ws.archived_at IS NULL
        AND (
          NOT ${correction}::boolean
          OR EXISTS (
            SELECT 1
            FROM session_occurrences occurrence
            WHERE occurrence.completed_set_id = cs.id
              AND occurrence.session_id = ws.id
              AND occurrence.session_exercise_id = cs.session_exercise_id
              AND occurrence.kind = 'working_set'
              AND occurrence.outcome = 'completed'
          )
        )
        AND NOT EXISTS (SELECT 1 FROM existing_version)
        -- Generic/retry edits are an active-workout capability. Every edit to
        -- a completed parent must enter through the reviewed correction
        -- contract below so it cannot bypass the parent revision fence.
        AND (
          (${action === "set.active_correction"}::boolean AND ws.status = 'in_progress')
          OR (
            ${action === "set.completed_correction"}::boolean
            AND ws.status IN ('completed', 'abandoned')
          )
          OR (NOT ${correction}::boolean AND ws.status = 'in_progress')
        )
        AND (NOT ${options.activeOnly ?? false}::boolean OR ws.status = 'in_progress')
        AND (
          NOT ${correction}::boolean
          OR (
            ws.history_revision = ${correctionOptions.expectedHistoryRevision ?? null}::integer
          )
        )
        AND (
          NOT ${options.expected != null}::boolean
          OR ROW(
            cs.weight,
            cs.weight_unit,
            cs.reps,
            cs.distance_km,
            cs.duration_seconds,
            cs.rpe,
            cs.note
          )
            IS NOT DISTINCT FROM ROW(
              ${options.expected?.weight ?? null}::double precision,
              ${options.expected?.weightUnit ?? null}::unit,
              ${options.expected?.reps ?? null}::integer,
              ${options.expected?.distanceKm ?? null}::real,
              ${options.expected?.durationSeconds ?? null}::integer,
              ${options.expected?.rpe ?? null}::real,
              ${options.expected?.note ?? null}::text
            )
        )
      FOR UPDATE OF cs, ws
    ), candidate AS (
      SELECT
        current.*,
        CASE WHEN ${hasWeight}::boolean THEN ${values.weight ?? null}::double precision ELSE current.weight END AS next_weight,
        CASE
          WHEN ${hasWeight}::boolean AND ${values.weight ?? null}::double precision IS NULL THEN NULL
          WHEN ${hasWeightUnit}::boolean THEN ${values.weightUnit ?? null}::unit
          ELSE current.weight_unit
        END AS next_weight_unit,
        CASE WHEN ${hasReps}::boolean THEN ${values.reps ?? null}::integer ELSE current.reps END AS next_reps,
        CASE WHEN ${hasDistanceKm}::boolean THEN ${values.distanceKm ?? null}::real ELSE current.distance_km END AS next_distance_km,
        CASE WHEN ${hasDurationSeconds}::boolean THEN ${values.durationSeconds ?? null}::integer ELSE current.duration_seconds END AS next_duration_seconds,
        CASE WHEN ${hasRpe}::boolean THEN ${values.rpe ?? null}::real ELSE current.rpe END AS next_rpe,
        CASE WHEN ${hasNote}::boolean THEN ${values.note ?? null}::text ELSE current.note END AS next_note
      FROM current_record current
    ), next_state AS (
      SELECT
        candidate.*,
        CASE
          WHEN candidate.is_warmup THEN NULL
          WHEN ${changesMeasurements}::boolean
            AND candidate.modification_type = 'as_planned'
            AND ${eligiblePrescriptionOutcomeSql(candidateSemantics)}
            THEN
            CASE
              WHEN candidate.target_reps_min IS NULL OR candidate.next_reps IS NULL THEN NULL
              WHEN candidate.metric_type::text = 'reps'
                THEN candidate.next_reps >= candidate.target_reps_min
              ELSE candidate.next_reps >= candidate.target_reps_min
                AND (
                  candidate.target_load IS NULL
                  OR (
                    candidate.next_weight IS NOT NULL
                    AND candidate.next_weight_unit IS NOT NULL
                    AND candidate.target_load_unit IS NOT NULL
                    AND CASE candidate.next_weight_unit
                      WHEN 'kg' THEN candidate.next_weight * ${KG_TO_LB}
                      ELSE candidate.next_weight
                    END >= CASE candidate.target_load_unit
                      WHEN 'kg' THEN candidate.target_load * ${KG_TO_LB}
                      ELSE candidate.target_load
                    END
                  )
                )
            END
          WHEN ${changesMeasurements}::boolean THEN NULL
          ELSE candidate.target_met
        END AS next_target_met
      FROM candidate
      WHERE (candidate.next_weight IS NULL) = (candidate.next_weight_unit IS NULL)
        AND (
          NOT ${changesMeasurements}::boolean
          OR CASE candidate.metric_type::text
            WHEN 'weight_reps' THEN
              candidate.next_weight IS NOT NULL
              AND candidate.next_weight_unit IS NOT NULL
              AND candidate.next_reps IS NOT NULL
              AND candidate.next_distance_km IS NULL
              AND candidate.next_duration_seconds IS NULL
            WHEN 'reps' THEN
              candidate.next_weight IS NULL
              AND candidate.next_weight_unit IS NULL
              AND candidate.next_reps IS NOT NULL
              AND candidate.next_distance_km IS NULL
              AND candidate.next_duration_seconds IS NULL
            WHEN 'assisted_reps' THEN
              candidate.next_weight IS NOT NULL
              AND candidate.next_weight_unit IS NOT NULL
              AND candidate.next_reps IS NOT NULL
              AND candidate.next_distance_km IS NULL
              AND candidate.next_duration_seconds IS NULL
            WHEN 'duration' THEN
              candidate.next_weight IS NULL
              AND candidate.next_weight_unit IS NULL
              AND candidate.next_reps IS NULL
              AND candidate.next_distance_km IS NULL
              AND candidate.next_duration_seconds IS NOT NULL
            WHEN 'distance_duration' THEN
              candidate.next_weight IS NULL
              AND candidate.next_weight_unit IS NULL
              AND candidate.next_reps IS NULL
              AND candidate.next_distance_km IS NOT NULL
            ELSE false
          END
        )
        AND (candidate.next_weight IS NULL OR candidate.next_weight BETWEEN 0 AND 2000)
        AND (candidate.next_reps IS NULL OR candidate.next_reps BETWEEN 0 AND 100)
        AND (candidate.next_distance_km IS NULL OR candidate.next_distance_km BETWEEN 0 AND 10000)
        AND (candidate.next_duration_seconds IS NULL OR candidate.next_duration_seconds BETWEEN 0 AND 604800)
    ), updated AS (
      UPDATE completed_sets cs
      SET weight = next.next_weight,
          weight_unit = next.next_weight_unit,
          reps = next.next_reps,
          distance_km = next.next_distance_km,
          duration_seconds = next.next_duration_seconds,
          rpe = next.next_rpe,
          note = next.next_note,
          target_met = next.next_target_met
      FROM next_state next
      WHERE cs.id = next.id
        AND (
          NOT ${correction}::boolean
          OR ROW(
            next.weight,
            next.weight_unit,
            next.reps,
            next.distance_km,
            next.duration_seconds,
            next.rpe,
            next.note
          ) IS DISTINCT FROM ROW(
            next.next_weight,
            next.next_weight_unit,
            next.next_reps,
            next.next_distance_km,
            next.next_duration_seconds,
            next.next_rpe,
            next.next_note
          )
        )
        AND ROW(
          next.weight,
          next.weight_unit,
          next.reps,
          next.distance_km,
          next.duration_seconds,
          next.rpe,
          next.note,
          next.target_met
        )
          IS DISTINCT FROM
          ROW(
            next.next_weight,
            next.next_weight_unit,
            next.next_reps,
            next.next_distance_km,
            next.next_duration_seconds,
            next.next_rpe,
            next.next_note,
            next.next_target_met
          )
      RETURNING cs.*
    ), revised_session AS (
      UPDATE workout_sessions session
      SET history_revision = session.history_revision + 1
      FROM current_record current
      JOIN updated ON updated.id = current.id
      WHERE ${correction}::boolean
        AND session.id = current.workout_session_id
        AND session.history_revision = current.history_revision
      RETURNING session.id, session.user_id, session.history_revision
    ), reconciled_recommendations AS (
      UPDATE recommendations recommendation
      SET status = 'expired',
          reconciled_at = statement_timestamp(),
          reconciliation_reason =
            'The completed workout evidence was corrected, so this suggestion no longer reflects the current history revision.'
      FROM current_record current
      JOIN revised_session revised ON revised.id = current.workout_session_id
      WHERE recommendation.user_id = ${userId}::uuid
        AND current.workout_status = 'completed'
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND current.source_slot_lineage_id IS NOT NULL
        AND recommendation.source_slot_lineage_id = current.source_slot_lineage_id
      RETURNING recommendation.id
    ), queued_progression AS (
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision,
        coaching_prefs, next_attempt_at
      )
      SELECT
        ${progressionJobId}::uuid,
        revised.user_id,
        revised.id,
        revised.history_revision,
        profile.coaching_prefs,
        statement_timestamp()
      FROM revised_session revised
      JOIN current_record current
        ON current.workout_session_id = revised.id
       AND current.workout_status = 'completed'
      JOIN user_profiles profile ON profile.user_id = revised.user_id
      ON CONFLICT (session_id, source_session_revision) DO NOTHING
      RETURNING id
    ), versioned AS (
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${versionId}::uuid,
        ${userId}::uuid,
        'completed_set',
        current.id,
        ${action},
        current.before_data,
        CASE
          WHEN ${correction}::boolean THEN
            to_jsonb(updated) || jsonb_build_object(
              ${SET_CORRECTION_EVIDENCE_KEY}::text,
              jsonb_build_object(
                'schemaVersion', ${SET_CORRECTION_EVIDENCE_SCHEMA_VERSION}::integer,
                'writerVersion', ${SET_CORRECTION_WRITER_VERSION}::text,
                'category', ${correctionOptions.correctionEvidence?.category ?? null}::text,
                'reasonNote', ${correctionOptions.correctionEvidence?.reasonNote ?? null}::text,
                'actorType', 'owner',
                'source', ${correctionOptions.correctionEvidence?.source ?? null}::text,
                'decidedAt', statement_timestamp(),
                'decisionTimezone', current.workout_timezone,
                'decisionLocalDate', timezone(current.workout_timezone, statement_timestamp())::date,
                'sourceHistoryRevision', current.history_revision,
                'resultHistoryRevision', revised.history_revision,
                'sourceLedgerRevision', current.correction_ledger_revision,
                'resultLedgerRevision', current.correction_ledger_revision + 1,
                'dependentConclusions', CASE current.workout_status
                  WHEN 'in_progress' THEN 'not_created_while_active'
                  WHEN 'completed' THEN 'recompute_queued'
                  ELSE 'abandoned_session_excluded'
                END,
                'expiredRecommendationCount', (SELECT count(*) FROM reconciled_recommendations),
                'progressionJobId', (SELECT id FROM queued_progression),
                'restoredFromVersionId', NULL,
                'restoredFromSnapshotId', NULL
              )
            )
          ELSE to_jsonb(updated)
        END,
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(current.before_data) old_value
          JOIN jsonb_each(to_jsonb(updated)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
          ORDER BY old_value.key
        )
      FROM current_record current
      JOIN updated ON updated.id = current.id
      LEFT JOIN revised_session revised
        ON revised.id = current.workout_session_id
      RETURNING id, changed_fields, after_data
    ), audited AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid,
        'user',
        ${action},
        'completed_set',
        current.id::text,
        'Updated a logged set and retained the previous values',
        jsonb_build_object(
          'versionId', versioned.id,
          'changedFields', versioned.changed_fields,
          'historyRevision',
          CASE WHEN ${correction}::boolean
            THEN (SELECT history_revision FROM revised_session)
            ELSE NULL
          END,
          'correctionCategory',
          CASE WHEN ${correction}::boolean
            THEN ${correctionOptions.correctionEvidence?.category ?? null}::text
            ELSE NULL
          END,
          'progressionJobId',
          CASE WHEN ${correction}::boolean
            THEN (SELECT id FROM queued_progression)
            ELSE NULL
          END
        )
      FROM current_record current
      JOIN versioned ON TRUE
    )
    SELECT
      coalesce(current.id, existing.entity_id) AS id,
      (updated.id IS NOT NULL) AS changed,
      coalesce(versioned.id, existing.id) AS version_id,
      (existing.id IS NOT NULL) AS replayed,
      coalesce(
        (versioned.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'resultHistoryRevision'])::integer,
        (existing.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'resultHistoryRevision'])::integer
      ) AS result_history_revision,
      (
        current.id IS NOT NULL
        AND ${changesMeasurements}::boolean
        AND next_state.id IS NULL
      ) AS shape_rejected,
      (
        existing.id IS NOT NULL
        AND NOT (
          existing.user_id = ${userId}::uuid
          AND existing.entity_type = 'completed_set'
          AND existing.entity_id = ${setId}::uuid
          AND existing.action = ${action}
          AND ROW(
            (existing.after_data->>'weight')::double precision,
            (existing.after_data->>'weight_unit')::unit,
            (existing.after_data->>'reps')::integer,
            (existing.after_data->>'distance_km')::real,
            (existing.after_data->>'duration_seconds')::integer,
            (existing.after_data->>'rpe')::real,
            existing.after_data->>'note',
            existing.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'category'],
            existing.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'reasonNote'],
            existing.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'source'],
            (existing.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'sourceHistoryRevision'])::integer,
            (existing.before_data->>'weight')::double precision,
            (existing.before_data->>'weight_unit')::unit,
            (existing.before_data->>'reps')::integer,
            (existing.before_data->>'distance_km')::real,
            (existing.before_data->>'duration_seconds')::integer,
            (existing.before_data->>'rpe')::real,
            existing.before_data->>'note'
          ) IS NOT DISTINCT FROM ROW(
            ${hasWeight ? values.weight ?? null : null}::double precision,
            ${hasWeightUnit ? values.weightUnit ?? null : null}::unit,
            ${hasReps ? values.reps ?? null : null}::integer,
            ${hasDistanceKm ? values.distanceKm ?? null : null}::real,
            ${hasDurationSeconds ? values.durationSeconds ?? null : null}::integer,
            ${hasRpe ? values.rpe ?? null : null}::real,
            ${hasNote ? values.note ?? null : null}::text,
            ${correctionOptions.correctionEvidence?.category ?? null}::text,
            ${correctionOptions.correctionEvidence?.reasonNote ?? null}::text,
            ${correctionOptions.correctionEvidence?.source ?? null}::text,
            ${correctionOptions.expectedHistoryRevision ?? null}::integer,
            ${options.expected?.weight ?? null}::double precision,
            ${options.expected?.weightUnit ?? null}::unit,
            ${options.expected?.reps ?? null}::integer,
            ${options.expected?.distanceKm ?? null}::real,
            ${options.expected?.durationSeconds ?? null}::integer,
            ${options.expected?.rpe ?? null}::real,
            ${options.expected?.note ?? null}::text
          )
        )
      ) AS replay_conflict
    FROM (SELECT 1) singleton
    LEFT JOIN current_record current ON TRUE
    LEFT JOIN next_state ON next_state.id = current.id
    LEFT JOIN updated ON updated.id = current.id
    LEFT JOIN versioned ON TRUE
    LEFT JOIN existing_version existing ON TRUE
  `;
  const row = resultRows(await db.execute(query))[0];
  if (row?.replay_conflict) {
    return {
      ok: false,
      reason: "That correction identity already belongs to different values.",
    };
  }
  if (row?.shape_rejected) {
    return {
      ok: false,
      reason:
        "That edit does not match this set's recorded metric or performed measurement shape. Reload the workout and review the applicable fields.",
    };
  }
  if (row?.replayed) {
    return {
      ok: true,
      id: String(row.id),
      changed: false,
      versionId: String(row.version_id),
      ...(row.result_history_revision == null
        ? {}
        : { historyRevision: Number(row.result_history_revision) }),
    };
  }
  if (correction && row?.id && !row.changed) {
    return {
      ok: false,
      reason: "A correction must change at least one saved value.",
    };
  }
  if (!row?.id) {
    return {
      ok: false,
      reason:
        options.expected || correction
          ? "This set changed after the correction form opened. Reload the workout and review the latest values before trying again."
          : "Set not found.",
    };
  }
  const result = editResult(
      [row].filter(Boolean),
      options.expected || correction
        ? "This set changed after the correction form opened. Reload the workout and review the latest values before trying again."
        : "Set not found.",
    );
  if (!result.ok || row.result_history_revision == null) return result;
  return {
    ...result,
    historyRevision: Number(row.result_history_revision),
  };
}

export async function updateSessionExerciseWithVersion(
  db: Db,
  userId: string,
  sessionExerciseId: string,
  values: SessionExerciseVersionUpdate,
  action: SessionExerciseVersionAction,
  options: {
    activeOnly?: boolean;
    expectedExerciseId?: string;
    versionId?: string;
  } = {}
): Promise<VersionedEditResult> {
  const versionId = options.versionId ?? randomUUID();
  const occurrenceMutationClientKey = randomUUID();
  const changesOccurrenceState =
    action === "session_exercise.skip" || action === "session_exercise.unskip";
  const occurrenceOperation = action === "session_exercise.skip" ? "skip" : "restore";
  const occurrenceReason = action === "session_exercise.skip"
    ? `exercise:${values.skipReason ?? "other"}`
    : null;
  const occurrencePayloadHash = createHash("sha256")
    .update(JSON.stringify({
      operation: occurrenceOperation,
      reason: occurrenceReason,
      source: "exercise_state",
    }))
    .digest("hex");
  const hasNotes = Object.hasOwn(values, "notes");
  const hasExerciseId = Object.hasOwn(values, "exerciseId");
  const hasModificationType = Object.hasOwn(values, "modificationType");
  const hasSkipReason = Object.hasOwn(values, "skipReason");
  const hasSubstitutedFor = Object.hasOwn(values, "substitutedForExerciseId");
  const hasSubstitutionReason = Object.hasOwn(values, "substitutionReason");
  const hasSubstitutedAt = Object.hasOwn(values, "substitutedAt");
  const hasTargetLoad = Object.hasOwn(values, "targetLoad");
  const hasTargetLoadUnit = Object.hasOwn(values, "targetLoadUnit");
  const hasWarmupNotes = Object.hasOwn(values, "warmupNotes");
  const hasWarmupSets = Object.hasOwn(values, "warmupSets");
  const hasSetNotes = Object.hasOwn(values, "setNotes");
  const requiresEmptyExercise = action === "session_exercise.substitute";
  const summary =
    action === "session_exercise.note_update"
      ? "Updated a workout exercise note and retained the previous value"
      : action === "session_exercise.skip"
        ? "Skipped a workout exercise and retained the previous state"
        : action === "session_exercise.unskip"
          ? "Returned a skipped workout exercise and retained the previous state"
          : "Substituted a workout exercise and retained the previous state";
  const query = sql`
    WITH existing_version AS MATERIALIZED (
      SELECT rv.id, rv.after_data
      FROM record_versions rv
      WHERE rv.id = ${versionId}::uuid
        AND rv.user_id = ${userId}::uuid
        AND rv.entity_type = 'session_exercise'
        AND rv.entity_id = ${sessionExerciseId}::uuid
        AND rv.action = ${action}
    ), current_record AS MATERIALIZED (
      SELECT se.*, to_jsonb(se) AS before_data
      FROM session_exercises se
      JOIN workout_sessions ws ON ws.id = se.session_id
      WHERE se.id = ${sessionExerciseId}::uuid
        AND ws.user_id = ${userId}::uuid
        AND ws.archived_at IS NULL
        AND (NOT ${options.activeOnly ?? false}::boolean OR ws.status = 'in_progress')
      FOR UPDATE OF se, ws
    ), candidate AS (
      SELECT
        current.*,
        CASE WHEN ${hasNotes}::boolean THEN ${values.notes ?? null}::text ELSE current.notes END AS next_notes,
        CASE WHEN ${hasExerciseId}::boolean THEN ${values.exerciseId ?? null}::uuid ELSE current.exercise_id END AS next_exercise_id,
        CASE WHEN ${hasModificationType}::boolean THEN ${values.modificationType ?? null}::modification_type ELSE current.modification_type END AS next_modification_type,
        CASE WHEN ${hasSkipReason}::boolean THEN ${values.skipReason ?? null}::skip_reason ELSE current.skip_reason END AS next_skip_reason,
        CASE WHEN ${hasSubstitutedFor}::boolean THEN ${values.substitutedForExerciseId ?? null}::uuid ELSE current.substituted_for_exercise_id END AS next_substituted_for_exercise_id,
        CASE WHEN ${hasSubstitutionReason}::boolean THEN ${values.substitutionReason ?? null}::substitution_reason ELSE current.substitution_reason END AS next_substitution_reason,
        CASE WHEN ${hasSubstitutedAt}::boolean THEN ${values.substitutedAt?.toISOString() ?? null}::timestamptz ELSE current.substituted_at END AS next_substituted_at,
        CASE WHEN ${hasTargetLoad}::boolean THEN ${values.targetLoad ?? null}::numeric(7,2) ELSE current.target_load END AS next_target_load,
        CASE
          WHEN ${hasTargetLoad}::boolean AND ${values.targetLoad ?? null}::numeric(7,2) IS NULL THEN NULL
          WHEN ${hasTargetLoadUnit}::boolean THEN ${values.targetLoadUnit ?? null}::unit
          ELSE current.target_load_unit
        END AS next_target_load_unit,
        CASE WHEN ${hasWarmupNotes}::boolean THEN ${values.warmupNotes ?? null}::text ELSE current.warmup_notes END AS next_warmup_notes,
        CASE WHEN ${hasWarmupSets}::boolean THEN ${JSON.stringify(values.warmupSets ?? [])}::jsonb ELSE current.warmup_sets END AS next_warmup_sets,
        CASE WHEN ${hasSetNotes}::boolean THEN ${JSON.stringify(values.setNotes ?? [])}::jsonb ELSE current.set_notes END AS next_set_notes
      FROM current_record current
    ), valid_candidate AS (
      SELECT candidate.*
      FROM candidate
      JOIN exercises next_exercise ON next_exercise.id = candidate.next_exercise_id
      WHERE (next_exercise.user_id IS NULL OR next_exercise.user_id = ${userId}::uuid)
        AND (
          (
            NOT EXISTS (SELECT 1 FROM existing_version)
            AND (
              ${options.expectedExerciseId ?? null}::uuid IS NULL
              OR candidate.exercise_id = ${options.expectedExerciseId ?? null}::uuid
            )
          )
          OR EXISTS (
            SELECT 1
            FROM existing_version
            WHERE candidate.exercise_id =
              (existing_version.after_data->>'exercise_id')::uuid
              AND (
                ${values.exerciseId ?? null}::uuid IS NULL
                OR existing_version.after_data->>'exercise_id' =
                  ${values.exerciseId ?? null}::text
              )
              AND (
                ${values.substitutionReason ?? null}::text IS NULL
                OR existing_version.after_data->>'substitution_reason' =
                  ${values.substitutionReason ?? null}::text
              )
          )
        )
        AND (candidate.next_target_load IS NULL) = (candidate.next_target_load_unit IS NULL)
        AND (
          NOT ${requiresEmptyExercise}::boolean
          OR NOT EXISTS (
            SELECT 1 FROM completed_sets cs
            WHERE cs.session_exercise_id = candidate.id
          )
        )
    ), updated AS (
      UPDATE session_exercises se
      SET notes = next.next_notes,
          exercise_id = next.next_exercise_id,
          modification_type = next.next_modification_type,
          skip_reason = next.next_skip_reason,
          substituted_for_exercise_id = next.next_substituted_for_exercise_id,
          substitution_reason = next.next_substitution_reason,
          substituted_at = next.next_substituted_at,
          target_load = next.next_target_load,
          target_load_unit = next.next_target_load_unit,
          warmup_notes = next.next_warmup_notes,
          warmup_sets = next.next_warmup_sets,
          set_notes = next.next_set_notes,
          current_equipment_snapshot_id = CASE
            WHEN ${action === "session_exercise.substitute"}::boolean THEN NULL
            ELSE next.current_equipment_snapshot_id
          END
      FROM valid_candidate next
      WHERE se.id = next.id
        AND ROW(
          next.notes,
          next.exercise_id,
          next.modification_type,
          next.skip_reason,
          next.substituted_for_exercise_id,
          next.substitution_reason,
          next.substituted_at,
          next.target_load,
          next.target_load_unit,
          next.warmup_notes,
          next.warmup_sets,
          next.set_notes
        ) IS DISTINCT FROM ROW(
          next.next_notes,
          next.next_exercise_id,
          next.next_modification_type,
          next.next_skip_reason,
          next.next_substituted_for_exercise_id,
          next.next_substitution_reason,
          next.next_substituted_at,
          next.next_target_load,
          next.next_target_load_unit,
          next.next_warmup_notes,
          next.next_warmup_sets,
          next.next_set_notes
        )
        AND NOT EXISTS (SELECT 1 FROM existing_version)
      RETURNING se.*
    ), cleared_equipment_occurrences AS (
      UPDATE session_occurrences occurrence
      SET equipment_snapshot_id = NULL,
          revision = occurrence.revision + 1
      FROM updated
      WHERE ${action === "session_exercise.substitute"}::boolean
        AND occurrence.session_exercise_id = updated.id
        AND occurrence.session_id = updated.session_id
        AND occurrence.outcome = 'pending'
        AND occurrence.equipment_snapshot_id IS NOT NULL
      RETURNING occurrence.id
    ), updated_occurrences AS (
      UPDATE session_occurrences occurrence
      SET outcome = CASE
            WHEN ${action === "session_exercise.skip"}::boolean THEN 'skipped'
            ELSE 'pending'
          END,
          outcome_reason = ${occurrenceReason},
          outcome_note = CASE
            WHEN ${action === "session_exercise.unskip"}::boolean THEN NULL
            ELSE occurrence.outcome_note
          END,
          revision = occurrence.revision + 1,
          resolved_at = CASE
            WHEN ${action === "session_exercise.skip"}::boolean THEN now()
            ELSE NULL
          END,
          completed_set_id = NULL
      FROM updated
      WHERE ${changesOccurrenceState}::boolean
        AND occurrence.session_exercise_id = updated.id
        AND (
          (${action === "session_exercise.skip"}::boolean AND occurrence.outcome = 'pending')
          OR (
            ${action === "session_exercise.unskip"}::boolean
            AND occurrence.outcome = 'skipped'
            AND occurrence.outcome_reason LIKE 'exercise:%'
          )
        )
      RETURNING occurrence.id, occurrence.revision - 1 AS expected_revision,
                occurrence.revision AS resulting_revision
    ), occurrence_receipts AS (
      INSERT INTO session_occurrence_mutations (
        occurrence_id, client_key, operation, canonical_payload_hash,
        expected_revision, resulting_revision, result_code
      )
      SELECT occurrence.id, ${occurrenceMutationClientKey}::uuid,
             ${occurrenceOperation}, ${occurrencePayloadHash},
             occurrence.expected_revision, occurrence.resulting_revision, 'applied'
      FROM updated_occurrences occurrence
      RETURNING id
    ), versioned AS (
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${versionId}::uuid,
        ${userId}::uuid,
        'session_exercise',
        current.id,
        ${action},
        current.before_data,
        to_jsonb(updated),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(current.before_data) old_value
          JOIN jsonb_each(to_jsonb(updated)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
          ORDER BY old_value.key
        )
      FROM current_record current
      JOIN updated ON updated.id = current.id
      WHERE NOT EXISTS (SELECT 1 FROM existing_version)
      RETURNING id, changed_fields
    ), audited AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid,
        'user',
        ${action},
        'session_exercise',
        current.id::text,
        ${summary},
        jsonb_build_object('versionId', versioned.id, 'changedFields', versioned.changed_fields)
      FROM current_record current
      JOIN versioned ON TRUE
    )
    SELECT
      current.id,
      EXISTS (SELECT 1 FROM valid_candidate) AS candidate_valid,
      EXISTS (SELECT 1 FROM existing_version) AS has_existing_version,
      EXISTS (
        SELECT 1
        FROM existing_version
        WHERE (
          ${values.exerciseId ?? null}::uuid IS NULL
          OR existing_version.after_data->>'exercise_id' =
            ${values.exerciseId ?? null}::text
        )
          AND (
            ${values.substitutionReason ?? null}::text IS NULL
            OR existing_version.after_data->>'substitution_reason' =
              ${values.substitutionReason ?? null}::text
          )
      ) AS replay_matches_request,
      EXISTS (
        SELECT 1 FROM completed_sets cs
        WHERE cs.session_exercise_id = current.id
      ) AS has_logged_sets,
      (
        ${options.expectedExerciseId ?? null}::uuid IS NULL
        OR current.exercise_id = ${options.expectedExerciseId ?? null}::uuid
      ) AS expected_exercise_matches,
      (updated.id IS NOT NULL) AS changed,
      COALESCE(versioned.id, (SELECT id FROM existing_version)) AS version_id,
      (SELECT count(*)::integer FROM occurrence_receipts) AS occurrence_changes
    FROM current_record current
    LEFT JOIN updated ON updated.id = current.id
    LEFT JOIN versioned ON TRUE
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) return { ok: false, reason: "Workout exercise not found." };
  if (!row.candidate_valid) {
    return {
      ok: false,
      reason: row.has_existing_version && !row.replay_matches_request
        ? "That replacement request identity was already used for a different choice."
        : row.has_existing_version
          ? "This exercise changed after replacement opened. Review the current exercise before trying again."
        : requiresEmptyExercise && row.has_logged_sets
          ? "This exercise already has logged sets and cannot be substituted."
          : options.expectedExerciseId && !row.expected_exercise_matches
            ? "This exercise changed after replacement opened. Review the current exercise before trying again."
            : "The workout exercise is no longer compatible with this change.",
    };
  }
  return {
    ok: true,
    id: String(row.id),
    changed: Boolean(row.changed),
    versionId: row.version_id ? String(row.version_id) : null,
  };
}

export async function listRecordVersions(
  db: Db,
  userId: string,
  entityType?: VersionedEntityType
) {
  return db.query.recordVersions.findMany({
    where: and(
      eq(recordVersions.userId, userId),
      ...(entityType ? [eq(recordVersions.entityType, entityType)] : [])
    ),
    orderBy: desc(recordVersions.createdAt),
    limit: 100,
  });
}

async function restoreActivityVersion(
  db: Db,
  userId: string,
  versionId: string,
  options: { clientMutationId?: string } = {},
): Promise<VersionedEditResult> {
  const rollbackVersionId = options.clientMutationId ?? randomUUID();
  const query = sql`
    WITH selected_version AS MATERIALIZED (
      SELECT *
      FROM record_versions
      WHERE id = ${versionId}::uuid
        AND user_id = ${userId}::uuid
        AND entity_type = 'health_activity'
    ), current_record AS MATERIALIZED (
      SELECT ha.*, to_jsonb(ha) AS before_data
      FROM health_activities ha
      JOIN selected_version version ON version.entity_id = ha.id
      WHERE ha.user_id = ${userId}::uuid
        AND ha.source = 'manual'
        AND ha.archived_at IS NULL
        AND version.before_data->>'id' = ha.id::text
      FOR UPDATE OF ha
    ), duplicate AS (
      SELECT other.id
      FROM selected_version version
      JOIN health_activities other
        ON other.user_id = ${userId}::uuid
       AND other.source = 'manual'
       AND other.fingerprint = version.before_data->>'fingerprint'
       AND other.id <> version.entity_id
      LIMIT 1
    ), restored AS (
      UPDATE health_activities ha
      SET activity_type = version.before_data->>'activity_type',
          title = version.before_data->>'title',
          started_at = (version.before_data->>'started_at')::timestamptz,
          timezone = version.before_data->>'timezone',
          duration_seconds = (version.before_data->>'duration_seconds')::integer,
          distance_km = (version.before_data->>'distance_km')::double precision,
          average_pace_seconds_per_km = (version.before_data->>'average_pace_seconds_per_km')::double precision,
          intensity = version.before_data->>'intensity',
          elevation_gain_m = (version.before_data->>'elevation_gain_m')::double precision,
          average_heart_rate_bpm = (version.before_data->>'average_heart_rate_bpm')::integer,
          energy_kcal = (version.before_data->>'energy_kcal')::double precision,
          notes = version.before_data->>'notes',
          source_metadata = version.before_data->'source_metadata',
          original_metrics = version.before_data->'original_metrics',
          fingerprint = version.before_data->>'fingerprint',
          updated_at = now()
      FROM selected_version version
      JOIN current_record current ON current.id = version.entity_id
      WHERE ha.id = current.id
        AND NOT EXISTS (SELECT 1 FROM duplicate)
        AND ROW(
          current.activity_type,
          current.title,
          current.started_at,
          current.timezone,
          current.duration_seconds,
          current.distance_km,
          current.average_pace_seconds_per_km,
          current.intensity,
          current.elevation_gain_m,
          current.average_heart_rate_bpm,
          current.energy_kcal,
          current.notes,
          current.source_metadata,
          current.original_metrics,
          current.fingerprint
        ) IS DISTINCT FROM ROW(
          version.before_data->>'activity_type',
          version.before_data->>'title',
          (version.before_data->>'started_at')::timestamptz,
          version.before_data->>'timezone',
          (version.before_data->>'duration_seconds')::integer,
          (version.before_data->>'distance_km')::double precision,
          (version.before_data->>'average_pace_seconds_per_km')::double precision,
          version.before_data->>'intensity',
          (version.before_data->>'elevation_gain_m')::double precision,
          (version.before_data->>'average_heart_rate_bpm')::integer,
          (version.before_data->>'energy_kcal')::double precision,
          version.before_data->>'notes',
          version.before_data->'source_metadata',
          version.before_data->'original_metrics',
          version.before_data->>'fingerprint'
        )
      RETURNING ha.*
    ), versioned AS (
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields, source_version_id
      )
      SELECT
        ${rollbackVersionId}::uuid,
        ${userId}::uuid,
        'health_activity',
        current.id,
        'activity.version_restore',
        current.before_data,
        to_jsonb(restored),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(current.before_data) old_value
          JOIN jsonb_each(to_jsonb(restored)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
            AND old_value.key <> 'updated_at'
          ORDER BY old_value.key
        ),
        selected.id
      FROM selected_version selected
      JOIN current_record current ON current.id = selected.entity_id
      JOIN restored ON restored.id = current.id
      RETURNING id, changed_fields
    ), audited AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid,
        'user',
        'activity.version_restore',
        'health_activity',
        current.id::text,
        'Restored earlier activity values and retained the replaced values',
        jsonb_build_object(
          'versionId', versioned.id,
          'sourceVersionId', selected.id,
          'changedFields', versioned.changed_fields
        )
      FROM selected_version selected
      JOIN current_record current ON current.id = selected.entity_id
      JOIN versioned ON TRUE
    )
    SELECT
      selected.entity_id AS id,
      (restored.id IS NOT NULL) AS changed,
      versioned.id AS version_id,
      EXISTS (SELECT 1 FROM current_record) AS record_found,
      EXISTS (SELECT 1 FROM duplicate) AS duplicate_found
    FROM selected_version selected
    LEFT JOIN restored ON restored.id = selected.entity_id
    LEFT JOIN versioned ON TRUE
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) return { ok: false, reason: "Version not found." };
  if (!row.record_found) {
    return {
      ok: false,
      reason: "Restore the activity from Archive before restoring an earlier edit.",
    };
  }
  if (row.duplicate_found) {
    return {
      ok: false,
      reason: "Those earlier activity details now match another record. Nothing was changed.",
    };
  }
  if (!row.changed) {
    return { ok: false, reason: "The activity already matches that earlier version." };
  }
  return {
    ok: true,
    id: String(row.id),
    changed: true,
    versionId: String(row.version_id),
  };
}

async function restoreSetVersion(
  db: Db,
  userId: string,
  versionId: string,
  options: {
    expectedHistoryRevision?: number;
    clientMutationId?: string;
  } = {},
): Promise<VersionedEditResult> {
  if (
    options.clientMutationId == null ||
    options.expectedHistoryRevision == null
  ) {
    return {
      ok: false,
      reason:
        "Set restore requires a stable mutation identity and the current workout revision.",
    };
  }
  const rollbackVersionId = options.clientMutationId;
  const progressionJobId = randomUUID();
  const restoredSemantics = {
    recordedMetricType: sql`candidate.metric_type`,
    performedSemanticsVersion: sql`candidate.performed_semantics_version`,
    performedLoadType: sql`candidate.performed_load_type`,
    performedLoadSemantics: sql`candidate.performed_load_semantics`,
    exerciseMetricType: sql`candidate.exercise_metric_type`,
    loadType: sql`candidate.exercise_load_type`,
    loadSemantics: sql`candidate.exercise_load_semantics`,
    loadEntryMeaning: sql`candidate.load_entry_meaning`,
    weight: sql`candidate.next_weight`,
    weightUnit: sql`candidate.next_weight_unit`,
    reps: sql`candidate.next_reps`,
    excludeFromAnalytics: sql`candidate.exclude_from_analytics`,
    targetRepsMin: sql`candidate.target_reps_min`,
    targetLoad: sql`candidate.target_load`,
    targetLoadUnit: sql`candidate.target_load_unit`,
    isWarmup: sql`candidate.is_warmup`,
    modificationType: sql`candidate.modification_type`,
  };
  const query = sql`
    WITH history_revision_lock AS MATERIALIZED (
      ${historyRevisionLockSql(userId)}
    ), existing_rollback AS MATERIALIZED (
      SELECT rollback.*
      FROM record_versions rollback
      WHERE rollback.id = ${rollbackVersionId}::uuid
    ), selected_version AS MATERIALIZED (
      SELECT *
      FROM record_versions
      WHERE id = ${versionId}::uuid
        AND user_id = ${userId}::uuid
        AND entity_type = 'completed_set'
    ), current_record AS MATERIALIZED (
      SELECT
        cs.*,
        to_jsonb(cs) AS before_data,
        ws.id AS workout_session_id,
        ws.status AS workout_status,
        ws.history_revision,
        ws.timezone AS workout_timezone,
        ws.local_date AS workout_local_date,
        COALESCE((
          SELECT max(
            CASE
              WHEN ledger.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'resultLedgerRevision'] ~ '^[0-9]+$'
                THEN (ledger.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'resultLedgerRevision'])::integer
              ELSE NULL
            END
          )
          FROM record_versions ledger
          WHERE ledger.user_id = ${userId}::uuid
            AND ledger.entity_type = 'completed_set'
            AND ledger.entity_id = cs.id
        ), 0) AS correction_ledger_revision,
        se.source_slot_lineage_id,
        se.target_reps_min,
        se.target_load,
        se.target_load_unit,
        se.modification_type,
        exercise.metric_type AS exercise_metric_type,
        exercise.load_type AS exercise_load_type,
        exercise.load_semantics AS exercise_load_semantics
      FROM completed_sets cs
      CROSS JOIN history_revision_lock
      JOIN selected_version version ON version.entity_id = cs.id
      JOIN session_exercises se ON se.id = cs.session_exercise_id
      JOIN exercises exercise ON exercise.id = se.exercise_id
      JOIN workout_sessions ws ON ws.id = se.session_id
      WHERE ws.user_id = ${userId}::uuid
        AND cs.archived_at IS NULL
        AND ws.archived_at IS NULL
        AND (
          ${options.expectedHistoryRevision ?? null}::integer IS NULL
          OR ws.history_revision = ${options.expectedHistoryRevision ?? null}::integer
        )
        AND NOT EXISTS (SELECT 1 FROM existing_rollback)
        AND version.before_data->>'id' = cs.id::text
      FOR UPDATE OF cs, ws
    ), candidate AS (
      SELECT
        current.*,
        (version.before_data->>'weight')::double precision AS next_weight,
        (version.before_data->>'weight_unit')::unit AS next_weight_unit,
        (version.before_data->>'reps')::integer AS next_reps,
        (version.before_data->>'distance_km')::real AS next_distance_km,
        (version.before_data->>'duration_seconds')::integer AS next_duration_seconds,
        (version.before_data->>'rpe')::real AS next_rpe,
        version.before_data->>'note' AS next_note
      FROM current_record current
      JOIN selected_version version ON version.entity_id = current.id
    ), next_state AS (
      SELECT
        candidate.*,
        ${restoredTargetMetSql(restoredSemantics)} AS next_target_met
      FROM candidate
    ), restored AS (
      UPDATE completed_sets cs
      SET weight = next.next_weight,
          weight_unit = next.next_weight_unit,
          reps = next.next_reps,
          distance_km = next.next_distance_km,
          duration_seconds = next.next_duration_seconds,
          rpe = next.next_rpe,
          note = next.next_note,
          target_met = next.next_target_met
      FROM next_state next
      WHERE cs.id = next.id
        AND (
          (next.next_weight IS NULL AND next.next_weight_unit IS NULL)
          OR (next.next_weight IS NOT NULL AND next.next_weight_unit IS NOT NULL)
        )
        AND ROW(
          next.weight,
          next.weight_unit,
          next.reps,
          next.distance_km,
          next.duration_seconds,
          next.rpe,
          next.note,
          next.target_met
        )
          IS DISTINCT FROM ROW(
            next.next_weight,
            next.next_weight_unit,
            next.next_reps,
            next.next_distance_km,
            next.next_duration_seconds,
            next.next_rpe,
            next.next_note,
            next.next_target_met
          )
      RETURNING cs.*
    ), revised_session AS (
      UPDATE workout_sessions session
      SET history_revision = session.history_revision + 1
      FROM current_record current
      JOIN restored ON restored.id = current.id
      WHERE session.id = current.workout_session_id
        AND session.history_revision = current.history_revision
      RETURNING session.id, session.user_id, session.history_revision
    ), reconciled_recommendations AS (
      UPDATE recommendations recommendation
      SET status = 'expired',
          reconciled_at = statement_timestamp(),
          reconciliation_reason =
            'Completed workout evidence was restored to an earlier version, so this suggestion no longer reflects current history.'
      FROM current_record current
      JOIN revised_session revised ON revised.id = current.workout_session_id
      WHERE recommendation.user_id = ${userId}::uuid
        AND current.workout_status = 'completed'
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND current.source_slot_lineage_id IS NOT NULL
        AND recommendation.source_slot_lineage_id = current.source_slot_lineage_id
      RETURNING recommendation.id
    ), queued_progression AS (
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision,
        coaching_prefs, next_attempt_at
      )
      SELECT
        ${progressionJobId}::uuid,
        revised.user_id,
        revised.id,
        revised.history_revision,
        profile.coaching_prefs,
        statement_timestamp()
      FROM revised_session revised
      JOIN current_record current
        ON current.workout_session_id = revised.id
       AND current.workout_status = 'completed'
      JOIN user_profiles profile ON profile.user_id = revised.user_id
      ON CONFLICT (session_id, source_session_revision) DO NOTHING
      RETURNING id
    ), versioned AS (
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields, source_version_id
      )
      SELECT
        ${rollbackVersionId}::uuid,
        ${userId}::uuid,
        'completed_set',
        current.id,
        'set.version_restore',
        current.before_data,
        to_jsonb(restored) || jsonb_build_object(
          ${SET_CORRECTION_EVIDENCE_KEY}::text,
          jsonb_build_object(
            'schemaVersion', ${SET_CORRECTION_EVIDENCE_SCHEMA_VERSION}::integer,
            'writerVersion', ${SET_CORRECTION_WRITER_VERSION}::text,
            'category', 'restore_prior_version',
            'reasonNote', NULL,
            'actorType', 'owner',
            'source', 'record_version_restore',
            'decidedAt', statement_timestamp(),
            'decisionTimezone', current.workout_timezone,
            'decisionLocalDate', timezone(current.workout_timezone, statement_timestamp())::date,
            'sourceHistoryRevision', current.history_revision,
            'resultHistoryRevision', revised.history_revision,
            'sourceLedgerRevision', current.correction_ledger_revision,
            'resultLedgerRevision', current.correction_ledger_revision + 1,
            'dependentConclusions', CASE current.workout_status
              WHEN 'in_progress' THEN 'not_created_while_active'
              WHEN 'completed' THEN 'recompute_queued'
              ELSE 'abandoned_session_excluded'
            END,
            'expiredRecommendationCount', (SELECT count(*) FROM reconciled_recommendations),
            'progressionJobId', (SELECT id FROM queued_progression),
            'restoredFromVersionId', selected.id,
            'restoredFromSnapshotId', NULL
          )
        ),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(current.before_data) old_value
          JOIN jsonb_each(to_jsonb(restored)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
          ORDER BY old_value.key
        ),
        selected.id
      FROM selected_version selected
      JOIN current_record current ON current.id = selected.entity_id
      JOIN restored ON restored.id = current.id
      JOIN revised_session revised
        ON revised.id = current.workout_session_id
      RETURNING id, changed_fields, after_data
    ), audited AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid,
        'user',
        'set.version_restore',
        'completed_set',
        current.id::text,
        'Restored earlier set values and retained the replaced values',
        jsonb_build_object(
          'versionId', versioned.id,
          'sourceVersionId', selected.id,
          'changedFields', versioned.changed_fields,
          'historyRevision', (SELECT history_revision FROM revised_session),
          'progressionJobId', (SELECT id FROM queued_progression)
        )
      FROM selected_version selected
      JOIN current_record current ON current.id = selected.entity_id
      JOIN versioned ON TRUE
    )
    SELECT
      selected.entity_id AS id,
      (restored.id IS NOT NULL) AS changed,
      coalesce(versioned.id, existing.id) AS version_id,
      coalesce(
        (versioned.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'resultHistoryRevision'])::integer,
        (existing.after_data #>> ARRAY[${SET_CORRECTION_EVIDENCE_KEY}::text, 'resultHistoryRevision'])::integer
      ) AS result_history_revision,
      (
        EXISTS (SELECT 1 FROM current_record)
        OR existing.id IS NOT NULL
      ) AS record_found,
      (existing.id IS NOT NULL) AS replayed,
      (
        existing.id IS NOT NULL
        AND NOT (
          existing.user_id = ${userId}::uuid
          AND existing.entity_type = 'completed_set'
          AND existing.entity_id = selected.entity_id
          AND existing.action = 'set.version_restore'
          AND existing.source_version_id = selected.id
        )
      ) AS replay_conflict
    FROM selected_version selected
    LEFT JOIN restored ON restored.id = selected.entity_id
    LEFT JOIN versioned ON TRUE
    LEFT JOIN existing_rollback existing ON TRUE
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) return { ok: false, reason: "Version not found." };
  if (row.replay_conflict) {
    return {
      ok: false,
      reason: "That restore identity already belongs to a different operation.",
    };
  }
  if (row.replayed) {
    return {
      ok: true,
      id: String(row.id),
      changed: false,
      versionId: String(row.version_id),
      ...(row.result_history_revision == null
        ? {}
        : { historyRevision: Number(row.result_history_revision) }),
    };
  }
  if (!row.record_found) {
    return {
      ok: false,
      reason: "Restore the set and its workout from Archive before restoring an earlier edit.",
    };
  }
  if (!row.changed) {
    return { ok: false, reason: "The set already matches that earlier version." };
  }
  return {
    ok: true,
    id: String(row.id),
    changed: true,
    versionId: String(row.version_id),
    ...(row.result_history_revision == null
      ? {}
      : { historyRevision: Number(row.result_history_revision) }),
  };
}

async function restoreSessionExerciseVersion(
  db: Db,
  userId: string,
  versionId: string,
  options: {
    activeOnly?: boolean;
    expectedHistoryRevision?: number;
    clientMutationId?: string;
  } = {}
): Promise<VersionedEditResult> {
  const rollbackVersionId = options.clientMutationId ?? randomUUID();
  const query = sql`
    WITH selected_version AS MATERIALIZED (
      SELECT *
      FROM record_versions
      WHERE id = ${versionId}::uuid
        AND user_id = ${userId}::uuid
        AND entity_type = 'session_exercise'
    ), owned_record AS MATERIALIZED (
      SELECT
        se.*,
        ws.archived_at AS workout_archived_at,
        ws.status AS workout_status
      FROM session_exercises se
      JOIN workout_sessions ws ON ws.id = se.session_id
      JOIN selected_version version ON version.entity_id = se.id
      WHERE ws.user_id = ${userId}::uuid
        AND version.before_data->>'id' = se.id::text
    ), current_record AS MATERIALIZED (
      SELECT
        se.*,
        ws.archived_at AS workout_archived_at,
        ws.status AS workout_status
      FROM session_exercises se
      JOIN workout_sessions ws ON ws.id = se.session_id
      JOIN owned_record owned ON owned.id = se.id
      WHERE ws.archived_at IS NULL
        AND (NOT ${options.activeOnly ?? false}::boolean OR ws.status = 'in_progress')
      FOR UPDATE OF se, ws
    ), compatible AS MATERIALIZED (
      SELECT current.*
      FROM current_record current
      JOIN selected_version version ON version.entity_id = current.id
      JOIN exercises earlier_exercise
        ON earlier_exercise.id = (version.before_data->>'exercise_id')::uuid
       AND (earlier_exercise.user_id IS NULL OR earlier_exercise.user_id = ${userId}::uuid)
      LEFT JOIN exercises earlier_original
        ON earlier_original.id = (version.before_data->>'substituted_for_exercise_id')::uuid
       AND (earlier_original.user_id IS NULL OR earlier_original.user_id = ${userId}::uuid)
      WHERE (
          (version.before_data->>'substituted_for_exercise_id') IS NULL
          OR earlier_original.id IS NOT NULL
        )
        AND (
          to_jsonb(current)
            - 'workout_archived_at'
            - 'workout_status'
            - ARRAY[
                'notes',
                'exercise_id',
                'modification_type',
                'skip_reason',
                'substituted_for_exercise_id',
                'substitution_reason',
                'substituted_at',
                'target_load',
                'target_load_unit',
                'warmup_notes',
                'warmup_sets',
                'set_notes',
                'current_equipment_snapshot_id'
              ]::text[]
        ) = (
          version.before_data
            - ARRAY[
                'notes',
                'exercise_id',
                'modification_type',
                'skip_reason',
                'substituted_for_exercise_id',
                'substitution_reason',
                'substituted_at',
                'target_load',
                'target_load_unit',
                'warmup_notes',
                'warmup_sets',
                'set_notes',
                'current_equipment_snapshot_id'
              ]::text[]
        )
        AND (
          current.exercise_id = (version.before_data->>'exercise_id')::uuid
          OR NOT EXISTS (
            SELECT 1 FROM completed_sets cs
            WHERE cs.session_exercise_id = current.id
          )
        )
        AND (
          ((version.before_data->>'target_load') IS NULL AND (version.before_data->>'target_load_unit') IS NULL)
          OR ((version.before_data->>'target_load') IS NOT NULL AND (version.before_data->>'target_load_unit') IS NOT NULL)
        )
    ), restored AS (
      UPDATE session_exercises se
      SET notes = version.before_data->>'notes',
          exercise_id = (version.before_data->>'exercise_id')::uuid,
          modification_type = (version.before_data->>'modification_type')::modification_type,
          skip_reason = (version.before_data->>'skip_reason')::skip_reason,
          substituted_for_exercise_id = (version.before_data->>'substituted_for_exercise_id')::uuid,
          substitution_reason = (version.before_data->>'substitution_reason')::substitution_reason,
          substituted_at = (version.before_data->>'substituted_at')::timestamptz,
          target_load = (version.before_data->>'target_load')::numeric(7,2),
          target_load_unit = (version.before_data->>'target_load_unit')::unit,
          warmup_notes = version.before_data->>'warmup_notes',
          warmup_sets = version.before_data->'warmup_sets',
          set_notes = version.before_data->'set_notes',
          current_equipment_snapshot_id = CASE
            WHEN current.exercise_id IS DISTINCT FROM (version.before_data->>'exercise_id')::uuid
              THEN NULL
            ELSE current.current_equipment_snapshot_id
          END
      FROM selected_version version
      JOIN compatible current ON current.id = version.entity_id
      WHERE se.id = current.id
        AND ROW(
          current.notes,
          current.exercise_id,
          current.modification_type,
          current.skip_reason,
          current.substituted_for_exercise_id,
          current.substitution_reason,
          current.substituted_at,
          current.target_load,
          current.target_load_unit,
          current.warmup_notes,
          current.warmup_sets,
          current.set_notes
        ) IS DISTINCT FROM ROW(
          version.before_data->>'notes',
          (version.before_data->>'exercise_id')::uuid,
          (version.before_data->>'modification_type')::modification_type,
          (version.before_data->>'skip_reason')::skip_reason,
          (version.before_data->>'substituted_for_exercise_id')::uuid,
          (version.before_data->>'substitution_reason')::substitution_reason,
          (version.before_data->>'substituted_at')::timestamptz,
          (version.before_data->>'target_load')::numeric(7,2),
          (version.before_data->>'target_load_unit')::unit,
          version.before_data->>'warmup_notes',
          version.before_data->'warmup_sets',
          version.before_data->'set_notes'
        )
      RETURNING se.*
    ), cleared_equipment_occurrences AS (
      UPDATE session_occurrences occurrence
      SET equipment_snapshot_id = NULL,
          revision = occurrence.revision + 1
      FROM compatible current
      JOIN restored ON restored.id = current.id
      WHERE current.exercise_id IS DISTINCT FROM restored.exercise_id
        AND occurrence.session_exercise_id = restored.id
        AND occurrence.session_id = restored.session_id
        AND occurrence.outcome = 'pending'
        AND occurrence.equipment_snapshot_id IS NOT NULL
      RETURNING occurrence.id
    ), versioned AS (
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields, source_version_id
      )
      SELECT
        ${rollbackVersionId}::uuid,
        ${userId}::uuid,
        'session_exercise',
        current.id,
        'session_exercise.version_restore',
        to_jsonb(current) - 'workout_archived_at' - 'workout_status',
        to_jsonb(restored),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(
            to_jsonb(current) - 'workout_archived_at' - 'workout_status'
          ) old_value
          JOIN jsonb_each(to_jsonb(restored)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
          ORDER BY old_value.key
        ),
        selected.id
      FROM selected_version selected
      JOIN compatible current ON current.id = selected.entity_id
      JOIN restored ON restored.id = current.id
      RETURNING id, changed_fields
    ), audited AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${userId}::uuid,
        'user',
        'session_exercise.version_restore',
        'session_exercise',
        current.id::text,
        'Restored earlier workout exercise values and retained the replaced values',
        jsonb_build_object(
          'versionId', versioned.id,
          'sourceVersionId', selected.id,
          'changedFields', versioned.changed_fields
        )
      FROM selected_version selected
      JOIN compatible current ON current.id = selected.entity_id
      JOIN versioned ON TRUE
    )
    SELECT
      selected.entity_id AS id,
      (restored.id IS NOT NULL) AS changed,
      versioned.id AS version_id,
      EXISTS (SELECT 1 FROM owned_record) AS record_found,
      EXISTS (SELECT 1 FROM current_record) AS active_found,
      EXISTS (SELECT 1 FROM compatible) AS compatible_found
    FROM selected_version selected
    LEFT JOIN restored ON restored.id = selected.entity_id
    LEFT JOIN versioned ON TRUE
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) return { ok: false, reason: "Version not found." };
  if (!row.record_found || !row.active_found) {
    return {
      ok: false,
      reason: "Restore the workout from Archive before restoring an earlier exercise change.",
    };
  }
  if (!row.compatible_found) {
    return {
      ok: false,
      reason:
        "The workout exercise structure or provenance has changed. Nothing was restored.",
    };
  }
  if (!row.changed) {
    return {
      ok: false,
      reason: "The workout exercise already matches that earlier version.",
    };
  }
  return {
    ok: true,
    id: String(row.id),
    changed: true,
    versionId: String(row.version_id),
  };
}

export async function restoreRecordVersion(
  db: Db,
  userId: string,
  versionId: string,
  options: {
    activeOnly?: boolean;
    expectedHistoryRevision?: number;
    clientMutationId?: string;
  } = {}
): Promise<VersionedEditResult> {
  const version = await db.query.recordVersions.findFirst({
    where: and(
      eq(recordVersions.id, versionId),
      eq(recordVersions.userId, userId)
    ),
    columns: { entityType: true },
  });
  if (!version) return { ok: false, reason: "Version not found." };
  if (version.entityType === "health_activity") {
    return restoreActivityVersion(db, userId, versionId, options);
  }
  if (version.entityType === "completed_set") {
    return restoreSetVersion(db, userId, versionId, options);
  }
  if (version.entityType === "workout_session") {
    if (
      options.expectedHistoryRevision == null ||
      options.clientMutationId == null
    ) {
      return {
        ok: false,
        reason:
          "Workout timing restore requires a stable identity and current history revision.",
      };
    }
    return restoreWorkoutTimingVersion(db, userId, versionId, {
      expectedHistoryRevision: options.expectedHistoryRevision,
      clientMutationId: options.clientMutationId,
    });
  }
  if (version.entityType === "session_exercise") {
    return restoreSessionExerciseVersion(db, userId, versionId, options);
  }
  return { ok: false, reason: "That record type cannot be restored yet." };
}
