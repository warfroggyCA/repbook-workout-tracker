import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  PERFORMED_LOAD_SEMANTICS,
  PERFORMED_METRIC_TYPES,
  SUPPORTED_SET_WRITER_METRICS,
  isSupportedSetWriterSemanticDefinition,
  type PerformedLoadSemantics,
  type PerformedMetricType,
  type SetLoadEntryMeaning,
  type SupportedSetWriterMetric,
} from "@/lib/set-metric-semantics";
import {
  comparePreviousPerformedSet,
  type ComparableSetSemantics,
} from "@/lib/previous-set-comparison";
import type { LoadUnit } from "@/lib/units";
import {
  HISTORY_SET_CORRECTION_ACTIONS,
  classifyHistoryCorrectionFacet,
  type HistoryCorrectionFacet,
} from "@/lib/history-workout-evidence";

export const PREVIOUS_COMPARABLE_SET_UNAVAILABLE =
  "Previous comparable set unavailable.";

export type PreviousComparableSetRequest = {
  sessionExerciseId: string;
  /**
   * The load meaning acknowledged at the current logging point. Weighted
   * comparisons remain unavailable until this is known.
   */
  loadEntryMeaning: SetLoadEntryMeaning | null;
  targetLoadUnit?: LoadUnit | null;
};

export type PreviousComparableSetEvidence = {
  setId: string;
  setNo: number;
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
  rpe: number | null;
  rir: number | null;
  observedCompletedAtISO: string | null;
  observedCompletionProvenance:
    | "live_client"
    | "manual_explicit"
    | "import_source"
    | "unknown";
  observedCompletionQuality: "trustworthy" | "owner_reported" | "unknown";
  hasPainOrLimitation?: boolean;
  correctionProvenance: {
    state: HistoryCorrectionFacet;
    count: number;
  };
};

export type PreviousComparableRestEvidence = {
  setId: string;
  workoutId: string;
  restTakenSec: number;
};

export type PreviousComparableSetResult =
  | {
      status: "available";
      currentSessionExerciseId: string;
      exerciseId: string;
      semantics: {
        version: 1;
        metricType: SupportedSetWriterMetric;
        loadType: string;
        loadSemantics: PerformedLoadSemantics;
        loadEntryMeaning: SetLoadEntryMeaning | null;
      };
      source: {
        workoutId: string;
        localDate: string;
        startedAtISO: string;
        finishedAtISO: string;
        historyHref: string;
        workoutSource: string;
      };
      sets: PreviousComparableSetEvidence[];
      usualRestSamples?: PreviousComparableRestEvidence[];
    }
  | {
      status: "unavailable";
      currentSessionExerciseId: string;
      message: typeof PREVIOUS_COMPARABLE_SET_UNAVAILABLE;
      previousRecorded?: {
        workoutId: string;
        localDate: string;
        historyHref: string;
        weight: number | null;
        weightUnit: LoadUnit | null;
        reps: number | null;
      };
      reason:
        | "current_exercise_unavailable"
        | "unsupported_current_semantics"
        | "load_entry_meaning_unavailable"
        | "no_comparable_history";
    };

type ComparisonRow = {
  current_session_exercise_id: string;
  exercise_id: string;
  current_metric_type: string;
  current_load_type: string | null;
  current_load_semantics: string | null;
  requested_load_entry_meaning: string | null;
  current_equipment_profile_kind: string | null;
  current_equipment_configuration_hash: string | null;
  source_workout_id: string | null;
  source_workout_source: string | null;
  source_local_date: string | null;
  source_started_at: Date | string | null;
  source_finished_at: Date | string | null;
  source_set_id: string | null;
  source_set_no: number | null;
  source_weight: number | null;
  source_weight_unit: string | null;
  source_reps: number | null;
  source_distance_km: number | null;
  source_duration_seconds: number | null;
  source_rpe: number | null;
  source_rir: number | null;
  source_metric_type: string | null;
  source_performed_semantics_version: number | null;
  source_performed_load_type: string | null;
  source_performed_load_semantics: string | null;
  source_load_entry_meaning: string | null;
  source_equipment_profile_kind: string | null;
  source_equipment_configuration_hash: string | null;
  source_observed_completed_at: Date | string | null;
  source_observed_completion_provenance: string | null;
  source_observed_completion_quality: string | null;
  source_has_pain_or_limitation: boolean | null;
  source_correction_count: number | null;
  source_correction_actions: unknown;
  compatible_rest_samples: unknown;
  recorded_workout_id: string | null;
  recorded_local_date: string | null;
  recorded_weight: number | null;
  recorded_weight_unit: string | null;
  recorded_reps: number | null;
};

function performedMetricType(value: string | null): PerformedMetricType | null {
  return value != null &&
    PERFORMED_METRIC_TYPES.includes(value as PerformedMetricType)
    ? (value as PerformedMetricType)
    : null;
}

function supportedMetricType(
  value: string | null,
): SupportedSetWriterMetric | null {
  return value != null &&
    SUPPORTED_SET_WRITER_METRICS.includes(value as SupportedSetWriterMetric)
    ? (value as SupportedSetWriterMetric)
    : null;
}

function loadSemantics(value: string | null): PerformedLoadSemantics | null {
  return value != null &&
    PERFORMED_LOAD_SEMANTICS.includes(value as PerformedLoadSemantics)
    ? (value as PerformedLoadSemantics)
    : null;
}

function loadEntryMeaning(value: string | null): SetLoadEntryMeaning | null {
  return value === "total_system" ||
    value === "per_loading_point" ||
    value === "displayed_stack" ||
    value === "per_stack" ||
    value === "combined_stacks" ||
    value === "legacy_unknown"
    ? value
    : null;
}

function loadUnit(value: string | null): LoadUnit | null {
  return value === "lb" || value === "kg" ? value : null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function correctionActions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((action): action is string => typeof action === "string")
    : [];
}

function compatibleRestSamples(value: unknown): PreviousComparableRestEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((sample) => {
    if (
      sample == null ||
      typeof sample !== "object" ||
      !("setId" in sample) ||
      typeof sample.setId !== "string" ||
      !("workoutId" in sample) ||
      typeof sample.workoutId !== "string" ||
      !("restTakenSec" in sample) ||
      typeof sample.restTakenSec !== "number" ||
      !Number.isInteger(sample.restTakenSec) ||
      sample.restTakenSec < 0 ||
      sample.restTakenSec > 86_400
    ) {
      return [];
    }
    return [{
      setId: sample.setId,
      workoutId: sample.workoutId,
      restTakenSec: sample.restTakenSec,
    }];
  });
}

function unavailable(
  currentSessionExerciseId: string,
  reason: Extract<PreviousComparableSetResult, { status: "unavailable" }>["reason"],
  row?: ComparisonRow,
): PreviousComparableSetResult {
  return {
    status: "unavailable",
    currentSessionExerciseId,
    message: PREVIOUS_COMPARABLE_SET_UNAVAILABLE,
    reason,
    ...(row?.recorded_workout_id && row.recorded_local_date ? {
      previousRecorded: {
        workoutId: row.recorded_workout_id,
        localDate: row.recorded_local_date,
        historyHref: `/history/${row.recorded_workout_id}`,
        weight: row.recorded_weight,
        weightUnit: loadUnit(row.recorded_weight_unit),
        reps: row.recorded_reps,
      },
    } : {}),
  };
}

/**
 * Returns the newest historical workout with one or more safely comparable
 * performed sets for each current session exercise.
 *
 * The database proof is intentionally independent of Program slots and names:
 * exact `exercise_id`, a complete v1 performed-semantics tuple, compatible
 * metric shape, and (for numeric load) the same acknowledged load-entry
 * meaning are all required. Ranking happens only after those checks, so a
 * newer unsafe row cannot hide older safe evidence.
 */
export async function getPreviousComparableSets(
  db: Db,
  userId: string,
  requests: PreviousComparableSetRequest[],
): Promise<Record<string, PreviousComparableSetResult>> {
  if (requests.length === 0) return {};
  const distinctRequests = [...new Map(
    requests.map((request) => [request.sessionExerciseId, request]),
  ).values()];
  const requestById = new Map(
    distinctRequests.map((request) => [request.sessionExerciseId, request]),
  );
  const values = sql.join(
    distinctRequests.map((request, index) => sql`(
      ${request.sessionExerciseId}::uuid,
      ${request.loadEntryMeaning}::text,
      ${index}::integer
    )`),
    sql`, `,
  );
  const correctionActionList = sql.join(
    [...HISTORY_SET_CORRECTION_ACTIONS].map((action) => sql`${action}`),
    sql`, `,
  );
  const executed = await db.execute(sql`
    WITH requested(session_exercise_id, load_entry_meaning, request_order) AS (
      VALUES ${values}
    ), current_context AS MATERIALIZED (
      SELECT
        requested.session_exercise_id AS current_session_exercise_id,
        requested.load_entry_meaning AS requested_load_entry_meaning,
        requested.request_order,
        current_exercise.exercise_id,
        current_session.started_at AS current_started_at,
        CASE
          WHEN authoritative.metric_type = 'weight_reps'::metric_type
            AND authoritative.load_semantics = 'resistance_band'::load_semantics
            THEN 'reps'::metric_type
          ELSE authoritative.metric_type
        END AS current_metric_type,
        authoritative.load_type AS current_load_type,
        authoritative.load_semantics AS current_load_semantics,
        current_equipment.profile_kind AS current_equipment_profile_kind,
        current_equipment.configuration_hash
          AS current_equipment_configuration_hash
      FROM requested
      JOIN session_exercises current_exercise
        ON current_exercise.id = requested.session_exercise_id
      JOIN workout_sessions current_session
        ON current_session.id = current_exercise.session_id
       AND current_session.user_id = ${userId}::uuid
       AND current_session.status IN ('in_progress', 'completed')
       AND current_session.archived_at IS NULL
      JOIN exercises catalog_exercise
        ON catalog_exercise.id = current_exercise.exercise_id
       AND (catalog_exercise.user_id IS NULL OR catalog_exercise.user_id = ${userId}::uuid)
      LEFT JOIN session_equipment_snapshots current_equipment
        ON current_equipment.id = current_exercise.current_equipment_snapshot_id
       AND current_equipment.session_exercise_id = current_exercise.id
       AND current_equipment.session_id = current_exercise.session_id
       AND current_equipment.user_id = ${userId}::uuid
      CROSS JOIN LATERAL (
        SELECT
          CASE
            WHEN current_exercise.prescribed_semantics_version = 1
              AND current_exercise.modification_type NOT IN ('substituted', 'added')
              THEN current_exercise.prescribed_metric_type
            ELSE catalog_exercise.metric_type
          END AS metric_type,
          CASE
            WHEN current_exercise.prescribed_semantics_version = 1
              AND current_exercise.modification_type NOT IN ('substituted', 'added')
              THEN current_exercise.prescribed_load_type
            ELSE catalog_exercise.load_type
          END AS load_type,
          CASE
            WHEN current_exercise.prescribed_semantics_version = 1
              AND current_exercise.modification_type NOT IN ('substituted', 'added')
              THEN current_exercise.prescribed_load_semantics
            ELSE catalog_exercise.load_semantics
          END AS load_semantics
      ) authoritative
    ), ranked_safe_sets AS MATERIALIZED (
      SELECT
        current.current_session_exercise_id,
        historical_session.id AS source_workout_id,
        historical_session.source::text AS source_workout_source,
        historical_session.local_date AS source_local_date,
        historical_session.started_at AS source_started_at,
        historical_session.finished_at AS source_finished_at,
        historical_set.id AS source_set_id,
        historical_set.set_no AS source_set_no,
        historical_set.weight AS source_weight,
        historical_set.weight_unit AS source_weight_unit,
        historical_set.reps AS source_reps,
        historical_set.distance_km AS source_distance_km,
        historical_set.duration_seconds AS source_duration_seconds,
        historical_set.rpe AS source_rpe,
        historical_set.rir AS source_rir,
        historical_set.rest_taken_sec AS source_rest_taken_sec,
        historical_set.metric_type AS source_metric_type,
        historical_set.performed_semantics_version
          AS source_performed_semantics_version,
        historical_set.performed_load_type AS source_performed_load_type,
        historical_set.performed_load_semantics
          AS source_performed_load_semantics,
        historical_set.load_entry_meaning AS source_load_entry_meaning,
        historical_equipment.profile_kind AS source_equipment_profile_kind,
        historical_equipment.configuration_hash
          AS source_equipment_configuration_hash,
        historical_set.observed_completed_at AS source_observed_completed_at,
        historical_set.observed_completion_provenance
          AS source_observed_completion_provenance,
        historical_set.observed_completion_quality
          AS source_observed_completion_quality,
        (
          historical_set.technique_issue IS NOT NULL
          OR historical_set.limitation_cause IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM pain_logs historical_pain
            WHERE historical_pain.user_id = ${userId}::uuid
              AND historical_pain.session_id = historical_session.id
              AND historical_pain.severity > 0
              AND historical_pain.archived_at IS NULL
              AND (
                historical_pain.completed_set_id = historical_set.id
                OR historical_pain.exercise_id = historical_exercise.exercise_id
                OR (
                  historical_pain.completed_set_id IS NULL
                  AND historical_pain.exercise_id IS NULL
                )
              )
          )
        ) AS source_has_pain_or_limitation,
        (
          SELECT count(*)::integer
          FROM record_versions correction
          WHERE correction.user_id = ${userId}::uuid
            AND correction.entity_type = 'completed_set'
            AND correction.entity_id = historical_set.id
            AND correction.action IN (${correctionActionList})
        ) AS source_correction_count,
        (
          SELECT coalesce(
            jsonb_agg(
              correction.action
              ORDER BY correction.created_at DESC, correction.id DESC
            ),
            '[]'::jsonb
          )
          FROM record_versions correction
          WHERE correction.user_id = ${userId}::uuid
            AND correction.entity_type = 'completed_set'
            AND correction.entity_id = historical_set.id
            AND correction.action IN (${correctionActionList})
        ) AS source_correction_actions,
        dense_rank() OVER (
          PARTITION BY current.current_session_exercise_id
          ORDER BY historical_session.started_at DESC, historical_session.id DESC
        ) AS source_rank
      FROM current_context current
      JOIN session_exercises historical_exercise
        ON historical_exercise.exercise_id = current.exercise_id
      JOIN workout_sessions historical_session
        ON historical_session.id = historical_exercise.session_id
       AND historical_session.user_id = ${userId}::uuid
       AND historical_session.status = 'completed'
       AND historical_session.finished_at IS NOT NULL
       AND historical_session.archived_at IS NULL
       AND historical_session.started_at < current.current_started_at
      JOIN completed_sets historical_set
        ON historical_set.session_exercise_id = historical_exercise.id
       AND historical_set.archived_at IS NULL
       AND historical_set.is_warmup = false
       AND historical_set.exclude_from_analytics = false
      LEFT JOIN session_equipment_snapshots historical_equipment
        ON historical_equipment.id = historical_set.equipment_snapshot_id
       AND historical_equipment.session_exercise_id = historical_exercise.id
       AND historical_equipment.session_id = historical_session.id
       AND historical_equipment.user_id = ${userId}::uuid
      WHERE historical_set.performed_semantics_version = 1
        AND historical_set.metric_type = current.current_metric_type
        AND historical_set.performed_load_type = current.current_load_type
        AND historical_set.performed_load_semantics = current.current_load_semantics
        AND 1 = (
          SELECT count(*)
          FROM session_occurrences historical_occurrence
          WHERE historical_occurrence.completed_set_id = historical_set.id
            AND historical_occurrence.session_exercise_id = historical_exercise.id
            AND historical_occurrence.kind = 'working_set'
            AND historical_occurrence.outcome = 'completed'
        )
        AND (
          historical_session.source::text <> 'hevy'
          OR (
            historical_exercise.source_exercise_name IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM external_exercise_mappings reviewed_mapping
              WHERE reviewed_mapping.user_id = ${userId}::uuid
                AND reviewed_mapping.source = 'hevy'
                AND reviewed_mapping.source_name =
                  historical_exercise.source_exercise_name
                AND reviewed_mapping.exercise_id = historical_exercise.exercise_id
            )
          )
        )
        AND CASE current.current_metric_type::text
          WHEN 'weight_reps' THEN
            historical_set.weight IS NOT NULL
            AND historical_set.weight_unit IS NOT NULL
            AND historical_set.reps IS NOT NULL
            AND historical_set.distance_km IS NULL
            AND historical_set.duration_seconds IS NULL
          WHEN 'reps' THEN
            historical_set.weight IS NULL
            AND historical_set.weight_unit IS NULL
            AND historical_set.reps IS NOT NULL
            AND historical_set.distance_km IS NULL
            AND historical_set.duration_seconds IS NULL
          WHEN 'assisted_reps' THEN
            historical_set.weight IS NOT NULL
            AND historical_set.weight_unit IS NOT NULL
            AND historical_set.reps IS NOT NULL
            AND historical_set.distance_km IS NULL
            AND historical_set.duration_seconds IS NULL
          WHEN 'duration' THEN
            historical_set.weight IS NULL
            AND historical_set.weight_unit IS NULL
            AND historical_set.reps IS NULL
            AND historical_set.distance_km IS NULL
            AND historical_set.duration_seconds IS NOT NULL
          WHEN 'distance_duration' THEN
            historical_set.weight IS NULL
            AND historical_set.weight_unit IS NULL
            AND historical_set.reps IS NULL
            AND historical_set.distance_km IS NOT NULL
          ELSE false
        END
        AND (
          current.current_metric_type::text NOT IN ('weight_reps', 'assisted_reps')
          OR (
            current.requested_load_entry_meaning IS NOT NULL
            AND current.requested_load_entry_meaning <> 'legacy_unknown'
            AND historical_set.load_entry_meaning::text =
              current.requested_load_entry_meaning
          )
        )
        AND (
          (
            current.current_load_semantics::text <> 'machine_stack'
            AND coalesce(current.current_equipment_profile_kind, '') NOT IN (
              'cable_machine', 'plate_loaded_machine'
            )
            AND
            historical_set.performed_load_semantics::text <> 'machine_stack'
            AND coalesce(historical_equipment.profile_kind, '') NOT IN (
              'cable_machine', 'plate_loaded_machine'
            )
          )
          OR (
            current.current_equipment_profile_kind IS NOT NULL
            AND current.current_equipment_configuration_hash IS NOT NULL
            AND current.current_equipment_profile_kind =
              historical_equipment.profile_kind
            AND current.current_equipment_configuration_hash =
              historical_equipment.configuration_hash
          )
        )
    )
    SELECT
      current.current_session_exercise_id,
      current.exercise_id,
      current.current_metric_type,
      current.current_load_type,
      current.current_load_semantics,
      current.requested_load_entry_meaning,
      current.current_equipment_profile_kind,
      current.current_equipment_configuration_hash,
      candidate.source_workout_id,
      candidate.source_workout_source,
      candidate.source_local_date,
      candidate.source_started_at,
      candidate.source_finished_at,
      candidate.source_set_id,
      candidate.source_set_no,
      candidate.source_weight,
      candidate.source_weight_unit,
      candidate.source_reps,
      candidate.source_distance_km,
      candidate.source_duration_seconds,
      candidate.source_rpe,
      candidate.source_rir,
      candidate.source_metric_type,
      candidate.source_performed_semantics_version,
      candidate.source_performed_load_type,
      candidate.source_performed_load_semantics,
      candidate.source_load_entry_meaning,
      candidate.source_equipment_profile_kind,
      candidate.source_equipment_configuration_hash,
      candidate.source_observed_completed_at,
      candidate.source_observed_completion_provenance,
      candidate.source_observed_completion_quality,
      candidate.source_has_pain_or_limitation,
      candidate.source_correction_count,
      candidate.source_correction_actions,
      recorded.workout_id AS recorded_workout_id,
      recorded.local_date AS recorded_local_date,
      recorded.weight AS recorded_weight,
      recorded.weight_unit AS recorded_weight_unit,
      recorded.reps AS recorded_reps,
      (
        SELECT coalesce(jsonb_agg(recent_rest.sample), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object(
            'setId', rest_source.source_set_id,
            'workoutId', rest_source.source_workout_id,
            'restTakenSec', rest_source.source_rest_taken_sec
          ) AS sample
          FROM ranked_safe_sets rest_source
          WHERE rest_source.current_session_exercise_id =
              current.current_session_exercise_id
            AND rest_source.source_rest_taken_sec IS NOT NULL
            AND rest_source.source_observed_completion_quality IN (
              'trustworthy', 'owner_reported'
            )
            AND NOT rest_source.source_has_pain_or_limitation
            AND rest_source.source_rank <= 8
          ORDER BY
            rest_source.source_started_at DESC,
            rest_source.source_set_no DESC,
            rest_source.source_set_id DESC
          LIMIT 24
        ) recent_rest
      ) AS compatible_rest_samples
    FROM current_context current
    LEFT JOIN ranked_safe_sets candidate
      ON candidate.current_session_exercise_id =
        current.current_session_exercise_id
     AND candidate.source_rank = 1
    LEFT JOIN LATERAL (
      SELECT history.id AS workout_id, history.local_date,
        recorded_set.weight, recorded_set.weight_unit, recorded_set.reps
      FROM session_exercises recorded_exercise
      JOIN workout_sessions history ON history.id = recorded_exercise.session_id
      JOIN completed_sets recorded_set ON recorded_set.session_exercise_id = recorded_exercise.id
      WHERE recorded_exercise.exercise_id = current.exercise_id
        AND history.user_id = ${userId}::uuid
        AND history.status = 'completed' AND history.archived_at IS NULL
        AND history.finished_at IS NOT NULL
        AND history.started_at < current.current_started_at
        AND NOT recorded_set.is_warmup
      ORDER BY history.started_at DESC, history.id DESC,
        recorded_set.set_no DESC, recorded_set.id DESC
      LIMIT 1
    ) recorded ON true
    ORDER BY current.request_order, candidate.source_set_no, candidate.source_set_id
  `);
  const rows = resultRows<ComparisonRow>(executed);
  const rowsByRequest = new Map<string, ComparisonRow[]>();
  for (const row of rows) {
    const grouped = rowsByRequest.get(row.current_session_exercise_id) ?? [];
    grouped.push(row);
    rowsByRequest.set(row.current_session_exercise_id, grouped);
  }

  const output: Record<string, PreviousComparableSetResult> = {};
  for (const request of distinctRequests) {
    const matchingRows = rowsByRequest.get(request.sessionExerciseId);
    if (!matchingRows?.length) {
      output[request.sessionExerciseId] = unavailable(
        request.sessionExerciseId,
        "current_exercise_unavailable",
      );
      continue;
    }
    const first = matchingRows[0];
    const metricType = supportedMetricType(first.current_metric_type);
    const currentLoadSemantics = loadSemantics(first.current_load_semantics);
    if (
      metricType == null ||
      first.current_load_type == null ||
      first.current_load_type.trim().length === 0 ||
      currentLoadSemantics == null ||
      !isSupportedSetWriterSemanticDefinition({
        metricType,
        loadSemantics: currentLoadSemantics,
      })
    ) {
      output[request.sessionExerciseId] = unavailable(
        request.sessionExerciseId,
        "unsupported_current_semantics",
        first,
      );
      continue;
    }
    const currentMeaning = loadEntryMeaning(
      first.requested_load_entry_meaning,
    );
    if (
      (metricType === "weight_reps" || metricType === "assisted_reps") &&
      (currentMeaning == null || currentMeaning === "legacy_unknown")
    ) {
      output[request.sessionExerciseId] = unavailable(
        request.sessionExerciseId,
        "load_entry_meaning_unavailable",
        first,
      );
      continue;
    }
    const target: ComparableSetSemantics = {
      exerciseId: first.exercise_id,
      performedSemanticsVersion: 1,
      metricType,
      performedLoadType: first.current_load_type,
      performedLoadSemantics: currentLoadSemantics,
      loadEntryMeaning: currentMeaning,
      equipmentProfileKind: first.current_equipment_profile_kind,
      equipmentConfigurationHash:
        first.current_equipment_configuration_hash,
    };
    const safeRows = matchingRows.filter((row) => {
      const sourceMetricType = performedMetricType(row.source_metric_type);
      if (sourceMetricType == null || row.source_set_id == null) return false;
      return comparePreviousPerformedSet({
        target,
        targetLoadUnit: requestById.get(request.sessionExerciseId)?.targetLoadUnit,
        candidate: {
          exerciseId: row.exercise_id,
          performedSemanticsVersion: row.source_performed_semantics_version,
          metricType: sourceMetricType,
          performedLoadType: row.source_performed_load_type,
          performedLoadSemantics: loadSemantics(
            row.source_performed_load_semantics,
          ),
          loadEntryMeaning: loadEntryMeaning(row.source_load_entry_meaning),
          equipmentProfileKind: row.source_equipment_profile_kind,
          equipmentConfigurationHash:
            row.source_equipment_configuration_hash,
          weight: row.source_weight,
          weightUnit: loadUnit(row.source_weight_unit),
          reps: row.source_reps,
          distanceKm: row.source_distance_km,
          durationSeconds: row.source_duration_seconds,
        },
      }).comparable;
    });
    const sourceRow = safeRows[0];
    if (
      sourceRow == null ||
      sourceRow.source_workout_id == null ||
      sourceRow.source_local_date == null ||
      sourceRow.source_started_at == null ||
      sourceRow.source_finished_at == null
    ) {
      output[request.sessionExerciseId] = unavailable(
        request.sessionExerciseId,
        "no_comparable_history",
        first,
      );
      continue;
    }
    output[request.sessionExerciseId] = {
      status: "available",
      currentSessionExerciseId: request.sessionExerciseId,
      exerciseId: sourceRow.exercise_id,
      semantics: {
        version: 1,
        metricType,
        loadType: first.current_load_type,
        loadSemantics: currentLoadSemantics,
        loadEntryMeaning: currentMeaning,
      },
      source: {
        workoutId: sourceRow.source_workout_id,
        localDate: sourceRow.source_local_date,
        startedAtISO: iso(sourceRow.source_started_at),
        finishedAtISO: iso(sourceRow.source_finished_at),
        historyHref: `/history/${sourceRow.source_workout_id}`,
        workoutSource: sourceRow.source_workout_source ?? "unknown",
      },
      sets: safeRows.flatMap((row): PreviousComparableSetEvidence[] => {
        if (row.source_set_id == null || row.source_set_no == null) return [];
        return [{
          setId: row.source_set_id,
          setNo: row.source_set_no,
          weight: row.source_weight,
          weightUnit: loadUnit(row.source_weight_unit),
          reps: row.source_reps,
          distanceKm: row.source_distance_km,
          durationSeconds: row.source_duration_seconds,
          rpe: row.source_rpe,
          rir: row.source_rir,
          observedCompletedAtISO: row.source_observed_completed_at == null
            ? null
            : iso(row.source_observed_completed_at),
          observedCompletionProvenance:
            row.source_observed_completion_provenance === "live_client" ||
            row.source_observed_completion_provenance === "manual_explicit" ||
            row.source_observed_completion_provenance === "import_source"
              ? row.source_observed_completion_provenance
              : "unknown",
          observedCompletionQuality:
            row.source_observed_completion_quality === "trustworthy" ||
            row.source_observed_completion_quality === "owner_reported"
              ? row.source_observed_completion_quality
              : "unknown",
          hasPainOrLimitation:
            row.source_has_pain_or_limitation === true,
          correctionProvenance: {
            state: classifyHistoryCorrectionFacet(
              correctionActions(row.source_correction_actions),
            ),
            count: row.source_correction_count ?? 0,
          },
        }];
      }),
      usualRestSamples: compatibleRestSamples(
        sourceRow.compatible_rest_samples,
      ),
    };
  }
  return output;
}
