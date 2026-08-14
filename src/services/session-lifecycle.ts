import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { databaseConstraint, resultRows } from "@/db/result";
import { type CoachingPrefs, workoutSessions } from "@/db/schema";
import { KG_TO_LB, type LoadUnit } from "@/lib/units";
import { sessionTimeBudgetSchema } from "@/lib/session-time-budget";
import { ADDED_WORKOUT_SET_NOTE } from "@/lib/session-occurrences";
import {
  ACTIVE_WORKOUT_REVIEW_THRESHOLD_SECONDS,
  LONG_WORKOUT_ELAPSED_FLAG,
  LONG_WORKOUT_DURATION_FLAG,
  MAX_ACTIVE_WORKOUT_DURATION_SECONDS,
  MAX_ANALYTICS_WORKOUT_DURATION_MINUTES,
  UNKNOWN_ACTIVE_WORKOUT_DURATION_FLAG,
  type WorkoutCompletionDurationDecision,
} from "@/lib/workout-duration-quality";
import {
  resolveSessionEquipmentAvailability,
  sessionEquipmentSelectionSourceRevisionExpression,
} from "@/services/session-equipment-selection";
import { sessionEquipmentRequirementsSnapshotExpression } from "@/services/session-equipment-requirements";
import { historyRevisionLockSql } from "@/services/history-revision-lock";
import {
  addWorkoutExerciseInputSchema,
  type AddWorkoutExerciseInput,
} from "@/lib/add-workout-exercise";
import { getExerciseDiscoveryLibrary } from "@/services/exercise-discovery";
import { actionableProgramDayWarmupItemsSql } from "@/services/program-warmup-compatibility";
import { workoutReplacementUnavailableReason } from "@/lib/exercise-replacements";
import { isValidIanaTimezone } from "@/lib/workout-calendar";
import {
  buildPerformedSetMeasurement,
  PERFORMED_LOAD_SEMANTICS,
  type PerformedMetricType,
  type PerformedLoadSemantics,
  type PerformedSetMeasurement,
} from "@/lib/set-metric-semantics";
import {
  LIMITATION_CAUSES,
  PAIN_BODY_PARTS,
  TECHNIQUE_ISSUES,
  type LimitationCause,
  type SetPainContext,
  type TechniqueIssue,
} from "@/lib/set-exception-context";

export type LifecycleCheckpoint = (boundary: string) => void | Promise<void>;

const noCheckpoint: LifecycleCheckpoint = () => undefined;

export type ScheduledWorkoutStartIdentity = {
  scheduledProgramEventId: string;
  expectedEventRevision: number;
  programScheduleVersionId: string;
  programScheduleVersionHash: string;
};

function deterministicRfcUuidSql(seed: SQL) {
  const digest = sql`md5(${seed})`;
  return sql`(
    substring(${digest} from 1 for 8) || '-' ||
    substring(${digest} from 9 for 4) || '-4' ||
    substring(${digest} from 14 for 3) || '-8' ||
    substring(${digest} from 18 for 3) || '-' ||
    substring(${digest} from 21 for 12)
  )::uuid`;
}

export type SessionLifecycleDependencies = {
  checkpoint?: LifecycleCheckpoint;
  evaluateStartCounts?: (expected: number, inserted: number) => boolean;
  logStartIncomplete?: () => void | Promise<void>;
  now?: () => Date;
  timezone?: string;
  startRequestKey?: string;
  scheduledStart?: ScheduledWorkoutStartIdentity;
};

export type WorkoutStartResult =
  | {
      outcome: "created" | "replayed";
      sessionId: string;
      existing: boolean;
    }
  | {
      outcome: "active_workout_exists";
      /** Compatibility alias; callers must inspect outcome before navigation. */
      sessionId: string;
      activeSessionId: string;
      existing: true;
    }
  | {
      outcome: "request_conflict";
      /** Identifies the prior request receipt, never a newly requested success. */
      sessionId: string;
      existing: true;
    };

const START_REQUEST_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function buildWorkoutStartRequestHash(input: {
  templateId: string;
  timezone: string;
  timeBudgetMin: number | null;
  scheduledStart?: ScheduledWorkoutStartIdentity;
}) {
  const payload = input.scheduledStart == null
    ? {
        templateId: input.templateId,
        timezone: input.timezone,
        timeBudgetMin: input.timeBudgetMin,
      }
    : {
        templateId: input.templateId,
        timezone: input.timezone,
        timeBudgetMin: input.timeBudgetMin,
        scheduledStart: {
          scheduledProgramEventId:
            input.scheduledStart.scheduledProgramEventId,
          expectedEventRevision: input.scheduledStart.expectedEventRevision,
          programScheduleVersionId:
            input.scheduledStart.programScheduleVersionId,
          programScheduleVersionHash:
            input.scheduledStart.programScheduleVersionHash,
        },
      };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

/** A stale Program page tried to start a template that is no longer current. */
export class StaleWorkoutTemplateError extends Error {
  readonly code = "stale_workout_template" as const;

  constructor() {
    super("This Program changed. Refresh Today before starting the workout.");
    this.name = "StaleWorkoutTemplateError";
  }
}

/** A newly-created workout failed its post-commit completeness diagnostic. */
export class IncompleteWorkoutCreationError extends Error {
  readonly code = "incomplete_workout_creation" as const;

  constructor() {
    super(
      "The workout could not be created completely. Nothing was saved — try again."
    );
    this.name = "IncompleteWorkoutCreationError";
  }
}

/** Reconciles an ambiguous start response against the one-active-workout invariant. */
export async function findOwnedActiveWorkout(db: Db, userId: string) {
  return db.query.workoutSessions.findFirst({
    where: and(
      eq(workoutSessions.userId, userId),
      eq(workoutSessions.status, "in_progress"),
      isNull(workoutSessions.archivedAt),
    ),
    orderBy: [asc(workoutSessions.startedAt), asc(workoutSessions.id)],
    columns: {
      id: true,
      templateId: true,
      templateName: true,
      startedAt: true,
    },
  });
}

/** Reconciles only the exact Start intent, including after it became terminal. */
export async function findOwnedWorkoutByStartRequest(
  db: Db,
  userId: string,
  startRequestKey: string,
) {
  return db.query.workoutSessions.findFirst({
    where: and(
      eq(workoutSessions.userId, userId),
      eq(workoutSessions.startRequestKey, startRequestKey),
    ),
    columns: {
      id: true,
      startRequestHash: true,
      status: true,
      archivedAt: true,
    },
  });
}

export async function cleanupIncompleteWorkoutCreation(
  db: Db,
  userId: string,
  sessionId: string
) {
  const query = sql`
    WITH authorized AS MATERIALIZED (
      -- The protected-delete trigger recognizes this transaction-local value.
      SELECT set_config('workout_tracker.authorized_delete', 'permanent', true)
    ), eligible AS MATERIALIZED (
      SELECT ws.id, ws.source_program_id, ws.source_day_lineage_id,
             ws.program_schedule_snapshot
      FROM workout_sessions ws
      CROSS JOIN authorized
      WHERE ws.id = ${sessionId}::uuid
        AND ws.user_id = ${userId}::uuid
        AND ws.status = 'in_progress'
        AND NOT EXISTS (
          SELECT 1
          FROM session_exercises se
          JOIN completed_sets cs ON cs.session_exercise_id = se.id
          WHERE se.session_id = ws.id
        )
    ), reopened_scheduled_event AS (
      UPDATE scheduled_program_events event
      SET status = 'scheduled',
          revision = event.revision + 1,
          resolved_at = NULL,
          updated_at = statement_timestamp()
      FROM eligible session
      JOIN program_schedule_versions schedule_version
        ON schedule_version.id =
          (session.program_schedule_snapshot->>'programScheduleVersionId')::uuid
       AND schedule_version.content_hash =
          session.program_schedule_snapshot->>'programScheduleVersionHash'
      WHERE session.program_schedule_snapshot IS NOT NULL
        AND event.id =
          (session.program_schedule_snapshot->>'scheduledProgramEventId')::uuid
        AND event.user_id = ${userId}::uuid
        AND event.program_id = session.source_program_id
        AND event.schedule_id =
          (session.program_schedule_snapshot->>'programScheduleId')::uuid
        AND event.schedule_version_id = schedule_version.id
        AND event.source_program_version_id =
          (session.program_schedule_snapshot->>'scheduleSourceProgramVersionId')::uuid
        AND event.source_phase_id =
          (session.program_schedule_snapshot->>'sourcePhaseId')::uuid
        AND event.source_event_id =
          (session.program_schedule_snapshot->>'sourceEventId')::uuid
        AND event.routine_lineage_id = session.source_day_lineage_id
        AND event.routine_lineage_id =
          (session.program_schedule_snapshot->>'routineLineageId')::uuid
        AND event.kind = 'resistance'
        AND event.schedule_kind =
          session.program_schedule_snapshot->>'scheduleKind'
        AND event.status = 'started'
        AND event.revision =
          (session.program_schedule_snapshot->>'eventRevision')::integer + 1
      RETURNING event.id
    ), cleanup_gate AS MATERIALIZED (
      SELECT eligible.*
      FROM eligible
      WHERE (
        eligible.program_schedule_snapshot IS NULL
        AND (SELECT count(*) FROM reopened_scheduled_event) = 0
      ) OR (
        eligible.program_schedule_snapshot IS NOT NULL
        AND (SELECT count(*) FROM reopened_scheduled_event) = 1
      )
    ), deleted_exercises AS (
      DELETE FROM session_exercises se
      USING cleanup_gate
      WHERE se.session_id = cleanup_gate.id
      RETURNING se.id
    ), deleted_session AS (
      DELETE FROM workout_sessions ws
      USING cleanup_gate
      WHERE ws.id = cleanup_gate.id
        AND (SELECT count(*) FROM deleted_exercises) >= 0
      RETURNING ws.id
    )
    SELECT
      (SELECT count(*)::int FROM deleted_exercises) AS deleted_exercises,
      (SELECT count(*)::int FROM deleted_session) AS deleted_sessions
  `;
  const row = resultRows(await db.execute(query))[0];
  return {
    deletedExercises: Number(row?.deleted_exercises ?? 0),
    deletedSessions: Number(row?.deleted_sessions ?? 0),
  } as const;
}

export type LogWorkoutSetInput = {
  sessionExerciseId: string;
  /** Exact occurrence fence for commands created by revision-aware clients. */
  occurrenceId?: string;
  expectedOccurrenceRevision?: number;
  /** Exact performed exercise identity observed when the command was created. */
  performedExerciseId: string;
  performedSemanticsVersion: 1;
  performedLoadType: string;
  performedLoadSemantics: PerformedLoadSemantics;
  setNo: number;
  rpe?: number | null;
  rir?: number | null;
  techniqueIssue?: TechniqueIssue | null;
  limitationCause?: LimitationCause | null;
  pain?: SetPainContext | null;
  isWarmup?: boolean;
  note?: string | null;
  clientKey: string;
  /** The exact equipment acknowledgement captured with the device command. */
  equipmentSnapshotId?: string | null;
  /** How the recorded load is interpreted under that immutable snapshot. */
  loadEntryMeaning?: EquipmentLoadEntryMeaning;
  /** Stable device observation; null denotes legacy/unknown timing evidence. */
  observedCompletedAtISO?: string | null;
} & PerformedSetMeasurement;

export type EquipmentLoadEntryMeaning =
  | "total_system"
  | "per_loading_point"
  | "displayed_stack"
  | "per_stack"
  | "combined_stacks"
  | "legacy_unknown";

export type LogWorkoutSetResult =
  | {
      outcome: "saved";
      setId: string;
      occurrenceId: string;
      occurrenceRevision: number;
    }
  | { outcome: "workout_not_active" }
  | { outcome: "retry_identity_conflict" }
  | {
      outcome: "unsupported_set_shape";
      metricType:
        | "weight_reps"
        | "reps"
        | "assisted_reps"
        | "duration"
        | "distance_duration"
        | "activity";
      reason:
        | "unsupported_metric"
        | "metric_semantics_conflict"
        | "measurement_shape_conflict"
        | "weight_reps_requires_load"
        | "reps_cannot_include_load"
        | "assisted_reps_requires_numeric_assistance"
        | "duration_requires_time"
        | "distance_duration_requires_distance";
    }
  | {
      outcome: "performed_evidence_conflict";
      reason:
        | "exercise_changed"
        | "metric_changed"
        | "semantics_changed";
    }
  | { outcome: "equipment_selection_required" }
  | { outcome: "equipment_selection_conflict" }
  | { outcome: "invalid_observed_completion" }
  | { outcome: "stale_occurrence" }
  | {
      outcome: "set_order_conflict";
      blocker: {
        occurrenceId: string;
        occurrenceRevision: number;
        sessionExerciseId: string;
        exerciseName: string;
        setNo: number;
        groupRound: number | null;
        origin: string;
        isAddedSet: boolean;
        label: string;
      };
    }
  | { outcome: "set_number_conflict" }
  | { outcome: "not_found" };

const LIVE_OBSERVED_COMPLETION_CLOCK_SKEW_SECONDS = 5 * 60;

export type MutateWorkoutOccurrenceInput = {
  occurrenceId: string;
  clientKey: string;
  expectedRevision: number;
  operation: "complete" | "skip" | "restore" | "note";
  reason?: string | null;
  note?: string | null;
};

export type MutateWorkoutOccurrenceResult =
  | {
      outcome: "saved" | "replayed";
      occurrence: {
        id: string;
        state: string;
        reason: string | null;
        note: string | null;
        revision: number;
        resolvedAt: string | null;
      };
    }
  | { outcome: "conflict" | "workout_not_active" | "not_found" };

export type AppendWorkoutSetInput = {
  sessionExerciseId: string;
  occurrenceId: string;
  expectedSetNo: number;
};

export type AppendWorkoutSetResult =
  | {
      outcome: "appended" | "replayed";
      occurrence: {
        id: string;
        sessionExerciseId: string;
        sequenceIdx: number;
        kindOrdinal: number;
        plannedExerciseId: string;
        plannedRepsMin: number | null;
        plannedRepsMax: number | null;
        plannedLoad: number | null;
        plannedLoadUnit: LoadUnit | null;
        plannedLoadPercent: number | null;
        plannedLoadText: string | null;
        plannedRestSec: number;
        plannedNote: string | null;
      };
    }
  | { outcome: "stale" | "workout_not_active" | "not_found" };

export type AddWorkoutExerciseResult =
  | {
      outcome: "added" | "replayed";
      sessionExerciseId: string;
      occurrenceIds: string[];
      sessionRevision: number;
    }
  | {
      outcome:
        | "conflict"
        | "stale"
        | "exercise_unavailable"
        | "workout_not_active"
        | "not_found"
        | "failed";
      reason?: string;
    };

export type AddWorkoutExerciseDependencies = {
  /** Test-only: forces the final audit gate to fail and roll back the statement. */
  failureAt?: string;
  /** Internal bounded retry count for a concurrent session-sequence writer. */
  sequenceConflictRetries?: number;
};

function addWorkoutExercisePayloadHash(input: AddWorkoutExerciseInput) {
  return createHash("sha256")
    .update(JSON.stringify({
      sessionId: input.sessionId,
      exerciseId: input.exerciseId,
      mutationId: input.mutationId,
      expectedSessionRevision: input.expectedSessionRevision,
      initialSetCount: input.initialSetCount,
      insertion: input.insertion,
    }))
    .digest("hex");
}

function addedExerciseResultFromAudit(
  row: Record<string, unknown>,
  payloadHash: string,
): AddWorkoutExerciseResult {
  const causeRef =
    row.cause_ref && typeof row.cause_ref === "object"
      ? (row.cause_ref as Record<string, unknown>)
      : {};
  if (causeRef.payloadHash !== payloadHash) {
    return {
      outcome: "conflict",
      reason:
        "This add-exercise request identity was already used for different workout details.",
    };
  }
  const occurrenceIds = Array.isArray(causeRef.occurrenceIds)
    ? causeRef.occurrenceIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return {
    outcome: "replayed",
    sessionExerciseId: String(row.entity_id),
    occurrenceIds,
    sessionRevision: Number(causeRef.sessionRevision),
  };
}

async function reconcileAddedWorkoutExercise(
  db: Db,
  userId: string,
  mutationId: string,
  payloadHash: string,
): Promise<AddWorkoutExerciseResult | null> {
  const row = resultRows(await db.execute(sql`
    SELECT entity_id, cause_ref
    FROM audit_logs
    WHERE user_id = ${userId}::uuid
      AND idempotency_key = ${`session-add-exercise:${mutationId}`}
    LIMIT 1
  `))[0];
  return row ? addedExerciseResultFromAudit(row, payloadHash) : null;
}

/**
 * Appends one workout-only exercise and its initial pending working occurrences.
 *
 * The immutable Program snapshot remains untouched. The workout revision is the
 * compare-and-swap boundary, while the audit identity makes a lost
 * acknowledgement replay the exact inserted graph.
 */
export async function addWorkoutExercise(
  db: Db,
  userId: string,
  input: AddWorkoutExerciseInput,
  dependencies: AddWorkoutExerciseDependencies = {},
): Promise<AddWorkoutExerciseResult> {
  const parsed = addWorkoutExerciseInputSchema.parse(input);
  const payloadHash = addWorkoutExercisePayloadHash(parsed);
  const prior = await reconcileAddedWorkoutExercise(
    db,
    userId,
    parsed.mutationId,
    payloadHash,
  );
  if (prior) return prior;

  const library = await getExerciseDiscoveryLibrary(db, userId);
  const selected = library.find((exercise) => exercise.id === parsed.exerciseId);
  const unsupportedReason = selected
    ? workoutReplacementUnavailableReason(selected)
    : "That exercise is not visible to this account.";
  if (!selected?.available || unsupportedReason) {
    return {
      outcome: "exercise_unavailable",
      reason:
        unsupportedReason ??
        selected?.unavailableReason ??
        "That exercise is not available with the current equipment and constraints.",
    };
  }

  try {
    const row = resultRows(await db.execute(sql`
      WITH existing AS MATERIALIZED (
        SELECT entity_id, cause_ref
        FROM audit_logs
        WHERE user_id = ${userId}::uuid
          AND idempotency_key =
            ${`session-add-exercise:${parsed.mutationId}`}
        LIMIT 1
      ), visible AS MATERIALIZED (
        SELECT session.id, session.status, session.archived_at,
               session.history_revision
        FROM workout_sessions session
        WHERE session.id = ${parsed.sessionId}::uuid
          AND session.user_id = ${userId}::uuid
      ), eligible_session AS MATERIALIZED (
        SELECT session.id, session.history_revision
        FROM workout_sessions session
        WHERE session.id = ${parsed.sessionId}::uuid
          AND session.user_id = ${userId}::uuid
          AND session.status = 'in_progress'
          AND session.archived_at IS NULL
          AND session.history_revision = ${parsed.expectedSessionRevision}
          AND NOT EXISTS (SELECT 1 FROM existing)
        FOR UPDATE OF session
      ), target AS MATERIALIZED (
        SELECT exercise.id
        FROM exercises exercise
        WHERE exercise.id = ${parsed.exerciseId}::uuid
          AND (exercise.user_id IS NULL OR exercise.user_id = ${userId}::uuid)
      ), insertion AS MATERIALIZED (
        SELECT eligible.id AS session_id,
               coalesce((
                 SELECT max(exercise.order_idx) + 1
                 FROM session_exercises exercise
                 WHERE exercise.session_id = eligible.id
               ), 0) AS order_idx,
               coalesce((
                 SELECT max(occurrence.sequence_idx) + 1
                 FROM session_occurrences occurrence
                 WHERE occurrence.session_id = eligible.id
               ), 0) AS sequence_idx
        FROM eligible_session eligible
      ), inserted_exercise AS (
        INSERT INTO session_exercises (
          id, session_id, exercise_id, planned_from_template_exercise_id,
          source_slot_lineage_id, modification_type, skip_reason,
          equipment_requirements_semantics_version,
          equipment_requirements_snapshot,
          substituted_for_exercise_id, substitution_reason, substituted_at,
          order_idx, superset_key, group_snapshot_id, group_member_order_idx,
          rest_sec, target_sets, target_reps_min, target_reps_max,
          target_load, target_load_unit, notes, warmup_notes, warmup_sets,
          set_notes, current_equipment_snapshot_id
        )
        SELECT
          ${deterministicRfcUuidSql(
            sql`${userId}::text || ':' || ${parsed.mutationId}::text || ':exercise'`,
          )},
          insertion.session_id,
          target.id,
          NULL::uuid,
          NULL::uuid,
          'added',
          NULL::skip_reason,
          1,
          ${sessionEquipmentRequirementsSnapshotExpression(sql`target.id`)},
          NULL::uuid,
          NULL::substitution_reason,
          NULL::timestamptz,
          insertion.order_idx,
          NULL::text,
          NULL::uuid,
          NULL::integer,
          90,
          NULL::integer,
          NULL::integer,
          NULL::integer,
          NULL::numeric,
          NULL::unit,
          NULL::text,
          NULL::text,
          '[]'::jsonb,
          '[]'::jsonb,
          NULL::uuid
        FROM insertion
        CROSS JOIN target
        ON CONFLICT (id) DO NOTHING
        RETURNING id, session_id, exercise_id, order_idx
      ), inserted_occurrences AS (
        INSERT INTO session_occurrences (
          id, session_id, session_exercise_id, kind, origin, sequence_idx,
          kind_ordinal, label, planned_exercise_id, planned_reps_min,
          planned_reps_max, planned_load, planned_load_unit,
          planned_load_percent, planned_load_text, planned_rest_sec,
          planned_note, group_snapshot_id, group_round,
          group_member_order_idx, outcome, outcome_reason, outcome_note,
          revision, resolved_at, completed_set_id, equipment_snapshot_id
        )
        SELECT
          ${deterministicRfcUuidSql(
            sql`${userId}::text || ':' || ${parsed.mutationId}::text || ':occurrence:' || generated.ordinal::text`,
          )},
          exercise.session_id,
          exercise.id,
          'working_set',
          'ad_hoc',
          insertion.sequence_idx + generated.ordinal - 1,
          generated.ordinal - 1,
          NULL::text,
          exercise.exercise_id,
          NULL::integer,
          NULL::integer,
          NULL::numeric,
          NULL::unit,
          NULL::numeric,
          NULL::text,
          90,
          NULL::text,
          NULL::uuid,
          NULL::integer,
          NULL::integer,
          'pending',
          NULL::text,
          NULL::text,
          0,
          NULL::timestamptz,
          NULL::uuid,
          NULL::uuid
        FROM inserted_exercise exercise
        JOIN insertion ON insertion.session_id = exercise.session_id
        CROSS JOIN generate_series(1, ${parsed.initialSetCount}) AS generated(ordinal)
        RETURNING id, session_exercise_id, kind_ordinal
      ), updated_session AS (
        UPDATE workout_sessions session
        SET history_revision = session.history_revision + 1
        FROM inserted_exercise exercise
        WHERE session.id = exercise.session_id
          AND (
            SELECT count(*)::integer FROM inserted_occurrences
          ) = ${parsed.initialSetCount}
        RETURNING session.id, session.user_id, session.history_revision
      ), recorded_audit AS (
        INSERT INTO audit_logs (
          user_id, actor_type, action, entity_type, entity_id, summary,
          cause_ref, idempotency_key
        )
        SELECT
          CASE WHEN ${dependencies.failureAt ?? null}::text IS NULL
               THEN updated.user_id ELSE NULL::uuid END,
          'user',
          'session_exercise.add',
          'session_exercise',
          exercise.id::text,
          'Added an exercise to an active workout',
          jsonb_build_object(
            'payloadHash', ${payloadHash}::text,
            'sessionId', updated.id::text,
            'sessionRevision', updated.history_revision,
            'exerciseId', exercise.exercise_id::text,
            'orderIdx', exercise.order_idx,
            'occurrenceIds', (
              SELECT jsonb_agg(occurrence.id ORDER BY occurrence.kind_ordinal)
              FROM inserted_occurrences occurrence
            ),
            'initialSetCount', ${parsed.initialSetCount}::integer,
            'insertion', ${parsed.insertion}::text
          ),
          ${`session-add-exercise:${parsed.mutationId}`}
        FROM updated_session updated
        JOIN inserted_exercise exercise ON exercise.session_id = updated.id
        RETURNING entity_id, cause_ref
      )
      SELECT
        CASE
          WHEN EXISTS (SELECT 1 FROM existing) THEN
            CASE
              WHEN (SELECT cause_ref->>'payloadHash' FROM existing) = ${payloadHash}
                THEN 'replayed'
              ELSE 'conflict'
            END
          WHEN EXISTS (SELECT 1 FROM recorded_audit) THEN 'added'
          WHEN EXISTS (
            SELECT 1 FROM visible
            WHERE status <> 'in_progress' OR archived_at IS NOT NULL
          ) THEN 'workout_not_active'
          WHEN EXISTS (SELECT 1 FROM visible)
            AND NOT EXISTS (SELECT 1 FROM eligible_session) THEN 'stale'
          WHEN NOT EXISTS (SELECT 1 FROM visible) THEN 'not_found'
          WHEN NOT EXISTS (SELECT 1 FROM target) THEN 'exercise_unavailable'
          ELSE 'failed'
        END AS outcome,
        coalesce(
          (SELECT entity_id FROM recorded_audit),
          (SELECT entity_id FROM existing)
        ) AS entity_id,
        coalesce(
          (SELECT cause_ref FROM recorded_audit),
          (SELECT cause_ref FROM existing)
        ) AS cause_ref
    `))[0];
    if (!row) throw new Error("The add-exercise statement returned no outcome.");
    if (row.outcome === "added") {
      const result = addedExerciseResultFromAudit(row, payloadHash);
      return result.outcome === "replayed"
        ? { ...result, outcome: "added" }
        : result;
    }
    if (row.outcome === "replayed" || row.outcome === "conflict") {
      return addedExerciseResultFromAudit(row, payloadHash);
    }
    if (row.outcome === "stale" || row.outcome === "failed") {
      const replay = await reconcileAddedWorkoutExercise(
        db,
        userId,
        parsed.mutationId,
        payloadHash,
      );
      if (replay) return replay;
    }
    if (
      row.outcome === "stale" ||
      row.outcome === "exercise_unavailable" ||
      row.outcome === "workout_not_active" ||
      row.outcome === "not_found" ||
      row.outcome === "failed"
    ) {
      return { outcome: row.outcome };
    }
    throw new Error("The add-exercise statement returned an unsupported outcome.");
  } catch (error) {
    if (dependencies.failureAt) {
      return { outcome: "failed" };
    }
    if (
      databaseConstraint(error) ===
        "session_occurrences_session_sequence_uq" &&
      (dependencies.sequenceConflictRetries ?? 0) < 2
    ) {
      return addWorkoutExercise(db, userId, parsed, {
        ...dependencies,
        sequenceConflictRetries:
          (dependencies.sequenceConflictRetries ?? 0) + 1,
      });
    }
    if (
      databaseConstraint(error) ===
      "session_occurrences_session_sequence_uq"
    ) {
      return {
        outcome: "stale",
        reason:
          "The workout set order changed while this exercise was being added.",
      };
    }
    throw error;
  }
}

function appendedWorkoutSetResult(
  outcome: "appended" | "replayed",
  row: Record<string, unknown>,
): Extract<AppendWorkoutSetResult, { outcome: "appended" | "replayed" }> {
  return {
    outcome,
    occurrence: {
      id: String(row.id),
      sessionExerciseId: String(row.session_exercise_id),
      sequenceIdx: Number(row.sequence_idx),
      kindOrdinal: Number(row.kind_ordinal),
      plannedExerciseId: String(row.planned_exercise_id),
      plannedRepsMin:
        row.planned_reps_min == null ? null : Number(row.planned_reps_min),
      plannedRepsMax:
        row.planned_reps_max == null ? null : Number(row.planned_reps_max),
      plannedLoad: row.planned_load == null ? null : Number(row.planned_load),
      plannedLoadUnit:
        row.planned_load_unit == null
          ? null
          : (String(row.planned_load_unit) as LoadUnit),
      plannedLoadPercent:
        row.planned_load_percent == null
          ? null
          : Number(row.planned_load_percent),
      plannedLoadText:
        row.planned_load_text == null ? null : String(row.planned_load_text),
      plannedRestSec: Number(row.planned_rest_sec),
      plannedNote:
        row.planned_note == null ? null : String(row.planned_note),
    },
  };
}

/**
 * Appends one durable, pending working-set occurrence.
 *
 * The caller supplies a fresh occurrence identity and the set number it observed.
 * Locking the session exercise makes the observed number a compare-and-swap:
 * concurrent activations for the same number can create at most one row, while a
 * retry with the same occurrence identity replays the original result.
 */
export async function appendWorkoutSetOccurrence(
  db: Db,
  userId: string,
  input: AppendWorkoutSetInput,
): Promise<AppendWorkoutSetResult> {
  if (!Number.isInteger(input.expectedSetNo) || input.expectedSetNo < 1) {
    throw new Error("An added set needs a valid expected set number.");
  }
  const row = resultRows(await db.execute(sql`
    WITH visible AS MATERIALIZED (
      SELECT exercise.id, exercise.session_id, exercise.exercise_id,
             exercise.rest_sec, session.status AS session_status,
             session.archived_at AS session_archived_at
      FROM session_exercises exercise
      JOIN workout_sessions session ON session.id = exercise.session_id
      WHERE exercise.id = ${input.sessionExerciseId}::uuid
        AND session.user_id = ${userId}::uuid
    ), existing AS MATERIALIZED (
      SELECT occurrence.*
      FROM session_occurrences occurrence
      JOIN visible ON visible.id = occurrence.session_exercise_id
      WHERE occurrence.id = ${input.occurrenceId}::uuid
        AND occurrence.kind = 'working_set'
        AND occurrence.kind_ordinal = ${input.expectedSetNo - 1}
    ), owned AS MATERIALIZED (
      SELECT exercise.id, exercise.session_id, exercise.exercise_id,
             exercise.rest_sec
      FROM session_exercises exercise
      JOIN workout_sessions session ON session.id = exercise.session_id
      WHERE exercise.id = ${input.sessionExerciseId}::uuid
        AND session.user_id = ${userId}::uuid
        AND session.status = 'in_progress'
        AND session.archived_at IS NULL
      FOR UPDATE OF exercise, session
    ), next_position AS MATERIALIZED (
      SELECT
        owned.*,
        (
          SELECT coalesce(max(occurrence.kind_ordinal), -1) + 2
          FROM session_occurrences occurrence
          WHERE occurrence.session_exercise_id = owned.id
            AND occurrence.kind = 'working_set'
        ) AS next_set_no,
        (
          SELECT coalesce(max(occurrence.sequence_idx), -1) + 1
          FROM session_occurrences occurrence
          WHERE occurrence.session_id = owned.session_id
        ) AS next_sequence_idx
      FROM owned
    ), preceding AS MATERIALIZED (
      SELECT occurrence.*,
             completed.id AS performed_id,
             completed.weight AS performed_load,
             completed.weight_unit AS performed_load_unit,
             completed.reps AS performed_reps
      FROM session_occurrences occurrence
      JOIN next_position position
        ON occurrence.session_exercise_id = position.id
       AND occurrence.kind = 'working_set'
       AND occurrence.kind_ordinal = ${input.expectedSetNo - 2}
      LEFT JOIN completed_sets completed
        ON completed.id = occurrence.completed_set_id
       AND completed.archived_at IS NULL
    ), inserted AS (
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, planned_reps_min, planned_reps_max,
        planned_load, planned_load_unit, planned_load_percent, planned_load_text,
        planned_rest_sec, planned_note, outcome, revision
      )
      SELECT
        ${input.occurrenceId}::uuid,
        position.session_id,
        position.id,
        'working_set',
        'ad_hoc',
        position.next_sequence_idx,
        ${input.expectedSetNo - 1},
        position.exercise_id,
        coalesce(preceding.performed_reps, preceding.planned_reps_min),
        coalesce(preceding.performed_reps, preceding.planned_reps_max),
        CASE
          WHEN preceding.performed_id IS NOT NULL THEN preceding.performed_load
          ELSE preceding.planned_load
        END,
        CASE
          WHEN preceding.performed_id IS NOT NULL THEN preceding.performed_load_unit
          ELSE preceding.planned_load_unit
        END,
        CASE
          WHEN preceding.performed_id IS NOT NULL THEN NULL
          ELSE preceding.planned_load_percent
        END,
        CASE
          WHEN preceding.performed_id IS NOT NULL THEN NULL
          ELSE preceding.planned_load_text
        END,
        coalesce(preceding.planned_rest_sec, position.rest_sec),
        ${ADDED_WORKOUT_SET_NOTE},
        'pending',
        0
      FROM next_position position
      LEFT JOIN preceding ON true
      WHERE position.next_set_no = ${input.expectedSetNo}
        AND NOT EXISTS (SELECT 1 FROM existing)
        AND NOT EXISTS (
          SELECT 1
          FROM session_occurrences unresolved
          WHERE unresolved.session_exercise_id = position.id
            AND unresolved.kind = 'working_set'
            AND unresolved.outcome = 'pending'
            AND unresolved.origin = 'ad_hoc'
            AND unresolved.planned_note = ${ADDED_WORKOUT_SET_NOTE}
        )
      ON CONFLICT DO NOTHING
      RETURNING *
    ), selected AS MATERIALIZED (
      SELECT 'appended'::text AS result, inserted.* FROM inserted
      UNION ALL
      SELECT 'replayed'::text AS result, existing.* FROM existing
      LIMIT 1
    )
    SELECT
      CASE
        WHEN EXISTS (SELECT 1 FROM selected) THEN selected.result
        WHEN EXISTS (
          SELECT 1 FROM visible
          WHERE session_status <> 'in_progress' OR session_archived_at IS NOT NULL
        ) THEN 'workout_not_active'
        WHEN EXISTS (SELECT 1 FROM owned) THEN 'stale'
        WHEN EXISTS (SELECT 1 FROM visible) THEN 'workout_not_active'
        ELSE 'not_found'
      END AS outcome,
      selected.id,
      selected.session_exercise_id,
      selected.sequence_idx,
      selected.kind_ordinal,
      selected.planned_exercise_id,
      selected.planned_reps_min,
      selected.planned_reps_max,
      selected.planned_load,
      selected.planned_load_unit,
      selected.planned_load_percent,
      selected.planned_load_text,
      selected.planned_rest_sec,
      selected.planned_note
    FROM (SELECT 1) anchor
    LEFT JOIN selected ON true
  `))[0];
  if (!row) throw new Error("The added-set statement returned no outcome.");
  if (row.outcome === "appended" || row.outcome === "replayed") {
    return appendedWorkoutSetResult(row.outcome, row);
  }
  if (row.outcome === "stale") {
    // A concurrent retry with the same fresh identity can lose the first
    // statement's snapshot while waiting on its unique conflict. A second
    // read gets a fresh READ COMMITTED snapshot and returns the canonical row.
    const replay = resultRows(await db.execute(sql`
      SELECT occurrence.id, occurrence.session_exercise_id,
             occurrence.sequence_idx, occurrence.kind_ordinal,
             occurrence.planned_exercise_id, occurrence.planned_reps_min,
             occurrence.planned_reps_max, occurrence.planned_load,
             occurrence.planned_load_unit, occurrence.planned_load_percent,
             occurrence.planned_load_text, occurrence.planned_rest_sec,
             occurrence.planned_note
      FROM session_occurrences occurrence
      JOIN session_exercises exercise
        ON exercise.id = occurrence.session_exercise_id
      JOIN workout_sessions session ON session.id = exercise.session_id
      WHERE occurrence.id = ${input.occurrenceId}::uuid
        AND occurrence.session_exercise_id = ${input.sessionExerciseId}::uuid
        AND occurrence.kind = 'working_set'
        AND occurrence.kind_ordinal = ${input.expectedSetNo - 1}
        AND session.user_id = ${userId}::uuid
    `))[0];
    if (replay) return appendedWorkoutSetResult("replayed", replay);
  }
  if (
    row.outcome === "stale" ||
    row.outcome === "workout_not_active" ||
    row.outcome === "not_found"
  ) {
    return { outcome: row.outcome };
  }
  throw new Error("The added-set statement returned an unsupported outcome.");
}

export async function mutateWorkoutOccurrence(
  db: Db,
  userId: string,
  input: MutateWorkoutOccurrenceInput,
): Promise<MutateWorkoutOccurrenceResult> {
  if (!input.clientKey.trim()) throw new Error("A stable occurrence mutation identity is required.");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("An occurrence mutation needs a valid expected revision.");
  }
  if (input.operation === "skip" && !input.reason?.trim()) {
    throw new Error("Skipping an occurrence requires a reason.");
  }
  if (input.operation === "note" && input.reason?.trim()) {
    throw new Error("A workout-item note cannot carry a skip reason.");
  }
  if (
    ["complete", "restore"].includes(input.operation) &&
    (input.reason?.trim() || input.note?.trim())
  ) {
    throw new Error(
      "Completing or restoring a workout item cannot carry note or skip fields.",
    );
  }
  const canonicalPayloadHash = createHash("sha256")
    .update(JSON.stringify({
      operation: input.operation,
      expectedRevision: input.expectedRevision,
      reason: input.reason?.trim() || null,
      note: input.note?.trim() || null,
    }))
    .digest("hex");
  const mutationId = randomUUID();
  const row = resultRows(await db.execute(sql`
    WITH visible AS MATERIALIZED (
      SELECT occurrence.*, session.status AS session_status,
             session.archived_at AS session_archived_at
      FROM session_occurrences occurrence
      JOIN workout_sessions session ON session.id = occurrence.session_id
      WHERE occurrence.id = ${input.occurrenceId}::uuid
        AND session.user_id = ${userId}::uuid
    ), existing_receipt AS MATERIALIZED (
      SELECT receipt.*
      FROM session_occurrence_mutations receipt
      JOIN visible ON visible.id = receipt.occurrence_id
      WHERE receipt.client_key = ${input.clientKey}
    ), owned AS MATERIALIZED (
      SELECT occurrence.*
      FROM session_occurrences occurrence
      JOIN workout_sessions session ON session.id = occurrence.session_id
      LEFT JOIN session_exercises exercise
        ON exercise.id = occurrence.session_exercise_id
      WHERE occurrence.id = ${input.occurrenceId}::uuid
        AND session.user_id = ${userId}::uuid
        AND session.status = 'in_progress'
        AND session.archived_at IS NULL
        AND NOT (
          occurrence.outcome = 'pending'
          AND occurrence.kind = 'day_warmup'
          AND jsonb_array_length(session.day_warmup_items) > 0
          AND jsonb_array_length(${actionableProgramDayWarmupItemsSql({
            lineageId: sql`coalesce(session.source_day_lineage_id, session.id)`,
            fallbackItemKey: sql`coalesce(session.template_id, session.id)`,
            additionalCompatibilityItemKey: sql`session.id`,
            warmupNotes: sql`session.day_warmup_notes`,
            warmupItems: sql`session.day_warmup_items`,
          })}) = 0
        )
        AND NOT (
          occurrence.outcome = 'pending'
          AND occurrence.kind = 'exercise_warmup'
          AND nullif(btrim(exercise.warmup_notes), '') IS NOT NULL
          AND occurrence.kind_ordinal = 0
          AND occurrence.label = exercise.warmup_notes
          AND occurrence.planned_reps_min IS NULL
          AND occurrence.planned_reps_max IS NULL
          AND occurrence.planned_load IS NULL
          AND occurrence.planned_load_unit IS NULL
          AND occurrence.planned_load_percent IS NULL
          AND occurrence.planned_load_text IS NULL
          AND occurrence.planned_rest_sec IS NULL
          AND occurrence.planned_note IS NULL
          AND (
            SELECT count(*)
            FROM session_occurrences peer
            WHERE peer.session_exercise_id = exercise.id
              AND peer.kind = 'exercise_warmup'
          ) > jsonb_array_length(exercise.warmup_sets)
        )
      FOR UPDATE OF occurrence, session
    ), updated AS (
      UPDATE session_occurrences occurrence
      SET outcome = CASE ${input.operation}
            WHEN 'complete' THEN 'completed'
            WHEN 'skip' THEN 'skipped'
            WHEN 'restore' THEN 'pending'
            ELSE occurrence.outcome
          END,
          outcome_reason = CASE ${input.operation}
            WHEN 'skip' THEN ${input.reason?.trim() || null}
            WHEN 'restore' THEN NULL
            ELSE occurrence.outcome_reason
          END,
          outcome_note = CASE ${input.operation}
            WHEN 'note' THEN ${input.note?.trim() || null}
            WHEN 'skip' THEN ${input.note?.trim() || null}
            ELSE occurrence.outcome_note
          END,
          revision = occurrence.revision + 1,
          resolved_at = CASE ${input.operation}
            WHEN 'complete' THEN now()
            WHEN 'skip' THEN now()
            WHEN 'restore' THEN NULL
            ELSE occurrence.resolved_at
          END,
          completed_set_id = CASE ${input.operation}
            WHEN 'restore' THEN NULL
            ELSE occurrence.completed_set_id
          END
      FROM owned
      WHERE occurrence.id = owned.id
        AND NOT EXISTS (SELECT 1 FROM existing_receipt)
        AND occurrence.revision = ${input.expectedRevision}
        AND occurrence.outcome <> 'legacy_unrecorded'
        AND (
          ${input.operation} <> 'restore'
          OR occurrence.outcome_reason IS NULL
          OR occurrence.outcome_reason NOT LIKE 'exercise:%'
        )
        AND (
          ${input.operation} <> 'restore'
          OR occurrence.session_exercise_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM session_exercises aggregate_exercise
            WHERE aggregate_exercise.id = occurrence.session_exercise_id
              AND (
                aggregate_exercise.modification_type = 'skipped'
                OR (
                  occurrence.kind = 'exercise_warmup'
                  AND aggregate_exercise.exercise_id IS DISTINCT FROM
                    occurrence.planned_exercise_id
                )
              )
          )
        )
        AND (
          ${input.operation} <> 'skip'
          OR occurrence.kind <> 'working_set'
          OR (
            NOT EXISTS (
              SELECT 1
              FROM session_occurrences earlier
              WHERE earlier.session_exercise_id = occurrence.session_exercise_id
                AND earlier.kind = 'working_set'
                AND earlier.kind_ordinal < occurrence.kind_ordinal
                AND earlier.outcome = 'pending'
                AND (
                  NOT (
                    occurrence.origin = 'ad_hoc'
                    AND occurrence.planned_note = ${ADDED_WORKOUT_SET_NOTE}
                  )
                  OR (
                    earlier.origin = 'ad_hoc'
                    AND earlier.planned_note = ${ADDED_WORKOUT_SET_NOTE}
                  )
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM session_occurrences earlier
              WHERE occurrence.group_snapshot_id IS NOT NULL
                AND earlier.group_snapshot_id = occurrence.group_snapshot_id
                AND earlier.kind = 'working_set'
                AND earlier.sequence_idx < occurrence.sequence_idx
                AND earlier.outcome = 'pending'
            )
          )
        )
        AND (
          (${input.operation} = 'complete'
            AND occurrence.kind IN ('day_warmup', 'exercise_warmup')
            AND occurrence.outcome = 'pending')
          OR (${input.operation} = 'skip' AND occurrence.outcome = 'pending')
          OR (${input.operation} = 'note'
            AND occurrence.outcome IN ('pending', 'completed', 'skipped'))
          OR (${input.operation} = 'restore' AND (
            occurrence.outcome IN ('skipped', 'abandoned')
            OR (
              occurrence.kind IN ('day_warmup', 'exercise_warmup')
              AND occurrence.outcome = 'completed'
            )
          ))
        )
      RETURNING occurrence.*
    ), saved_receipt AS (
      INSERT INTO session_occurrence_mutations (
        id, occurrence_id, client_key, operation, canonical_payload_hash,
        expected_revision, resulting_revision, result_code
      )
      SELECT ${mutationId}::uuid, updated.id, ${input.clientKey},
             ${input.operation}, ${canonicalPayloadHash},
             ${input.expectedRevision}, updated.revision, 'applied'
      FROM updated
      RETURNING *
    ), selected AS (
      SELECT * FROM updated
      UNION ALL
      SELECT occurrence.*
      FROM session_occurrences occurrence
      JOIN existing_receipt receipt ON receipt.occurrence_id = occurrence.id
      WHERE receipt.canonical_payload_hash = ${canonicalPayloadHash}
      LIMIT 1
    )
    SELECT
      CASE
        WHEN EXISTS (
          SELECT 1 FROM existing_receipt
          WHERE canonical_payload_hash <> ${canonicalPayloadHash}
        ) THEN 'conflict'
        WHEN EXISTS (SELECT 1 FROM existing_receipt) THEN 'replayed'
        WHEN EXISTS (SELECT 1 FROM updated) THEN 'saved'
        WHEN EXISTS (
          SELECT 1 FROM visible
          WHERE session_status <> 'in_progress' OR session_archived_at IS NOT NULL
        ) THEN 'workout_not_active'
        WHEN EXISTS (SELECT 1 FROM visible) THEN 'conflict'
        ELSE 'not_found'
      END AS outcome,
      selected.id,
      selected.outcome AS state,
      selected.outcome_reason,
      selected.outcome_note,
      selected.revision,
      selected.resolved_at
    FROM (SELECT 1) anchor
    LEFT JOIN selected ON true
  `))[0];
  if (!row) throw new Error("The occurrence mutation returned no outcome.");
  if (row.outcome === "saved" || row.outcome === "replayed") {
    return {
      outcome: row.outcome,
      occurrence: {
        id: String(row.id),
        state: String(row.state),
        reason: row.outcome_reason == null ? null : String(row.outcome_reason),
        note: row.outcome_note == null ? null : String(row.outcome_note),
        revision: Number(row.revision),
        resolvedAt: row.resolved_at == null
          ? null
          : new Date(String(row.resolved_at)).toISOString(),
      },
    };
  }
  if (
    row.outcome === "conflict" ||
    row.outcome === "workout_not_active" ||
    row.outcome === "not_found"
  ) {
    return { outcome: row.outcome };
  }
  throw new Error("The occurrence mutation returned an unsupported outcome.");
}

export async function startWorkoutSession(
  db: Db,
  userId: string,
  templateId: string,
  timeBudgetMin?: number,
  dependencies: SessionLifecycleDependencies = {}
): Promise<WorkoutStartResult> {
  const validatedTimeBudget = sessionTimeBudgetSchema.parse(timeBudgetMin);
  const startRequestKey = dependencies.startRequestKey?.toLowerCase() ?? null;
  const scheduledStart = dependencies.scheduledStart ?? null;
  if (
    startRequestKey != null &&
    (!START_REQUEST_UUID_PATTERN.test(startRequestKey) ||
      dependencies.timezone == null ||
      !isValidIanaTimezone(dependencies.timezone))
  ) {
    throw new Error("A valid Start request identity and timezone are required.");
  }
  if (
    scheduledStart != null &&
    (
      !START_REQUEST_UUID_PATTERN.test(
        scheduledStart.scheduledProgramEventId,
      ) ||
      !Number.isInteger(scheduledStart.expectedEventRevision) ||
      scheduledStart.expectedEventRevision < 0 ||
      !START_REQUEST_UUID_PATTERN.test(
        scheduledStart.programScheduleVersionId,
      ) ||
      !/^[0-9a-f]{64}$/.test(
        scheduledStart.programScheduleVersionHash,
      )
    )
  ) {
    throw new Error("A valid scheduled Start identity is required.");
  }
  const startRequestHash = startRequestKey == null
    ? null
    : buildWorkoutStartRequestHash({
        templateId,
        timezone: dependencies.timezone!,
        timeBudgetMin: validatedTimeBudget ?? null,
        ...(scheduledStart == null ? {} : { scheduledStart }),
      });
  const checkpoint = dependencies.checkpoint ?? noCheckpoint;
  const startedAt = (dependencies.now ?? (() => new Date()))();
  const sessionId = randomUUID();
  await checkpoint("before-start-statement");
  const query = sql`
    WITH existing_request AS MATERIALIZED (
      SELECT ws.id, false AS inserted, 'request'::text AS selected_by,
             ws.start_request_key, ws.start_request_hash
      FROM workout_sessions ws
      WHERE ${startRequestKey}::text IS NOT NULL
        AND ws.user_id = ${userId}::uuid
        AND ws.start_request_key = ${startRequestKey}::text
      LIMIT 1
    ), owner_mutex AS MATERIALIZED (
      UPDATE user_profiles profile
      SET timezone = profile.timezone
      WHERE profile.user_id = ${userId}::uuid
        AND NOT EXISTS (SELECT 1 FROM existing_request)
        AND NOT EXISTS (
          SELECT 1
          FROM workout_sessions active
          WHERE active.user_id = ${userId}::uuid
            AND active.status = 'in_progress'
            AND active.archived_at IS NULL
        )
        AND EXISTS (
          SELECT 1
          FROM workout_templates candidate
          JOIN program_versions version
            ON version.id = candidate.program_version_id
          JOIN programs program
            ON program.id = version.program_id
          WHERE candidate.id = ${templateId}::uuid
            AND program.user_id = ${userId}::uuid
            AND program.status = 'active'
            AND program.archived_at IS NULL
            AND program.current_version_id = version.id
            AND (
              ${scheduledStart?.scheduledProgramEventId ?? null}::uuid IS NOT NULL
              OR NOT EXISTS (
                SELECT 1
                FROM program_schedules schedule
                WHERE schedule.user_id = program.user_id
                  AND schedule.program_id = program.id
                  AND schedule.current_version_id IS NOT NULL
              )
            )
        )
      RETURNING profile.id
    ), existing_active AS MATERIALIZED (
      SELECT ws.id, false AS inserted, 'active'::text AS selected_by,
             ws.start_request_key, ws.start_request_hash
      FROM workout_sessions ws
      WHERE ws.user_id = ${userId}::uuid
        AND ws.status = 'in_progress'
        AND ws.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM existing_request)
      ORDER BY ws.started_at, ws.id
      LIMIT 1
    ), locked_program_schedule AS MATERIALIZED (
      SELECT schedule.*
      FROM owner_mutex
      CROSS JOIN program_schedules schedule
      JOIN scheduled_program_events event
        ON event.schedule_id = schedule.id
       AND event.user_id = schedule.user_id
       AND event.program_id = schedule.program_id
       AND event.schedule_version_id = schedule.current_version_id
      WHERE ${scheduledStart?.scheduledProgramEventId ?? null}::uuid IS NOT NULL
        AND event.id =
          ${scheduledStart?.scheduledProgramEventId ?? null}::uuid
        AND event.user_id = ${userId}::uuid
        AND event.schedule_version_id =
          ${scheduledStart?.programScheduleVersionId ?? null}::uuid
        AND NOT EXISTS (SELECT 1 FROM existing_request)
        AND NOT EXISTS (SELECT 1 FROM existing_active)
      FOR UPDATE OF schedule
    ), owned_scheduled_event AS MATERIALIZED (
      SELECT event.*, schedule_version.content_hash AS schedule_version_hash
      FROM scheduled_program_events event
      JOIN locked_program_schedule schedule
        ON schedule.id = event.schedule_id
       AND schedule.user_id = event.user_id
       AND schedule.program_id = event.program_id
       AND schedule.current_version_id = event.schedule_version_id
      JOIN program_schedule_versions schedule_version
        ON schedule_version.id = event.schedule_version_id
       AND schedule_version.schedule_id = event.schedule_id
       AND schedule_version.user_id = event.user_id
       AND schedule_version.program_id = event.program_id
       AND schedule_version.source_program_version_id =
         event.source_program_version_id
      WHERE ${scheduledStart?.scheduledProgramEventId ?? null}::uuid IS NOT NULL
        AND event.id =
          ${scheduledStart?.scheduledProgramEventId ?? null}::uuid
        AND event.user_id = ${userId}::uuid
        AND event.schedule_version_id =
          ${scheduledStart?.programScheduleVersionId ?? null}::uuid
        AND schedule_version.content_hash =
          ${scheduledStart?.programScheduleVersionHash ?? null}::text
        AND event.revision =
          ${scheduledStart?.expectedEventRevision ?? null}::integer
        AND event.status = 'scheduled'
        AND event.kind = 'resistance'
        AND event.routine_lineage_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM existing_request)
        AND NOT EXISTS (SELECT 1 FROM existing_active)
      FOR UPDATE OF event
    ), owned_template AS MATERIALIZED (
      SELECT wt.id, wt.name, wt.warmup_notes, wt.warmup_items,
             program.id AS source_program_id,
             version.id AS source_program_version_id,
             wt.lineage_id AS source_day_lineage_id,
             scheduled.id AS scheduled_program_event_id,
             scheduled.schedule_id AS program_schedule_id,
             scheduled.schedule_version_id AS program_schedule_version_id,
             scheduled.schedule_version_hash,
             scheduled.source_program_version_id AS
               schedule_source_program_version_id,
             scheduled.source_phase_id,
             scheduled.source_phase_name,
             scheduled.schedule_kind,
             scheduled.kind AS scheduled_event_kind,
             scheduled.source_event_id,
             scheduled.revision AS scheduled_event_revision,
             scheduled.original_local_date,
             scheduled.current_local_date,
             scheduled.timezone AS scheduled_timezone,
             scheduled.program_week,
             scheduled.cycle_position,
             scheduled.routine_lineage_id,
             ${actionableProgramDayWarmupItemsSql({
               lineageId: sql`wt.lineage_id`,
               fallbackItemKey: sql`wt.id`,
               warmupNotes: sql`wt.warmup_notes`,
               warmupItems: sql`wt.warmup_items`,
             })} AS effective_warmup_items,
             profile.timezone AS profile_timezone
      FROM owner_mutex
      CROSS JOIN workout_templates wt
      JOIN program_versions version ON version.id = wt.program_version_id
      JOIN programs program ON program.id = version.program_id
      JOIN user_profiles profile ON profile.user_id = program.user_id
      LEFT JOIN owned_scheduled_event scheduled
        ON scheduled.program_id = program.id
       AND scheduled.user_id = program.user_id
       AND scheduled.routine_lineage_id = wt.lineage_id
      WHERE program.user_id = ${userId}::uuid
        AND program.status = 'active'
        AND program.archived_at IS NULL
        AND program.current_version_id = version.id
        AND (
          (
            ${scheduledStart?.scheduledProgramEventId ?? null}::uuid IS NULL
            AND wt.id = ${templateId}::uuid
          )
          OR (
            ${scheduledStart?.scheduledProgramEventId ?? null}::uuid IS NOT NULL
            AND scheduled.id IS NOT NULL
            AND wt.id = ${templateId}::uuid
          )
        )
    ), upserted_session AS (
      INSERT INTO workout_sessions (
        id, user_id, template_id, template_name, time_budget_min,
        start_request_key, start_request_hash,
        started_at, timezone, local_date, day_warmup_notes, day_warmup_items,
        source_program_id, source_program_version_id, source_day_lineage_id,
        program_schedule_snapshot
      )
      SELECT
        ${sessionId}::uuid,
        ${userId}::uuid,
        template.id,
        template.name,
        ${validatedTimeBudget ?? null}::integer,
        ${startRequestKey}::text,
        ${startRequestHash}::text,
        ${startedAt.toISOString()}::timestamptz,
        coalesce(${dependencies.timezone ?? null}::text, template.profile_timezone),
        timezone(
          coalesce(${dependencies.timezone ?? null}::text, template.profile_timezone),
          ${startedAt.toISOString()}::timestamptz
        )::date,
        template.warmup_notes,
        template.effective_warmup_items,
        template.source_program_id,
        template.source_program_version_id,
        template.source_day_lineage_id,
        CASE WHEN template.scheduled_program_event_id IS NULL
          THEN NULL::jsonb
          ELSE jsonb_build_object(
            'schemaVersion', 1,
            'scheduledProgramEventId', template.scheduled_program_event_id,
            'programScheduleId', template.program_schedule_id,
            'programScheduleVersionId', template.program_schedule_version_id,
            'programScheduleVersionHash', template.schedule_version_hash,
            'scheduleSourceProgramVersionId',
              template.schedule_source_program_version_id,
            'resolvedProgramVersionId', template.source_program_version_id,
            'sourcePhaseId', template.source_phase_id,
            'sourcePhaseName', template.source_phase_name,
            'scheduleKind', template.schedule_kind,
            'eventKind', template.scheduled_event_kind,
            'sourceEventId', template.source_event_id,
            'eventRevision', template.scheduled_event_revision,
            'originalLocalDate', template.original_local_date,
            'currentLocalDate', template.current_local_date,
            'timezone', template.scheduled_timezone,
            'nominalProgramWeek', template.program_week,
            'cyclePosition', template.cycle_position,
            'routineLineageId', template.routine_lineage_id
          )
        END
      FROM owned_template template
      WHERE NOT EXISTS (SELECT 1 FROM existing_request)
        AND NOT EXISTS (SELECT 1 FROM existing_active)
      -- Either owner-scoped uniqueness rule may win under native PostgreSQL:
      -- exact Start identity or the one-active-workout invariant. Do not bind
      -- this insert to only one arbiter; reconcile the winning row below from
      -- a fresh statement snapshot when this insert loses a race.
      ON CONFLICT DO NOTHING
      RETURNING id, id = ${sessionId}::uuid AS inserted,
                'upsert'::text AS selected_by,
                start_request_key, start_request_hash
    ), claimed_scheduled_event AS (
      UPDATE scheduled_program_events event
      SET status = 'started',
          revision = event.revision + 1,
          updated_at = statement_timestamp()
      FROM upserted_session inserted
      JOIN owned_template template ON template.scheduled_program_event_id IS NOT NULL
      WHERE event.id = template.scheduled_program_event_id
        AND event.user_id = ${userId}::uuid
        AND event.schedule_id = template.program_schedule_id
        AND event.schedule_version_id = template.program_schedule_version_id
        AND event.source_program_version_id =
          template.schedule_source_program_version_id
        AND event.source_event_id = template.source_event_id
        AND event.routine_lineage_id = template.routine_lineage_id
        AND event.status = 'scheduled'
        AND event.revision = template.scheduled_event_revision
      RETURNING event.id
    ), start_integrity AS MATERIALIZED (
      SELECT 1 / CASE
        WHEN ${scheduledStart?.scheduledProgramEventId ?? null}::uuid IS NOT NULL
          AND EXISTS (SELECT 1 FROM upserted_session)
          AND (SELECT count(*) FROM claimed_scheduled_event) <> 1
        THEN 0 ELSE 1 END AS valid
    ), selected_session AS MATERIALIZED (
      SELECT * FROM existing_request
      UNION ALL
      SELECT * FROM existing_active
      UNION ALL
      SELECT inserted.*
      FROM upserted_session inserted
      CROSS JOIN start_integrity
      WHERE ${scheduledStart?.scheduledProgramEventId ?? null}::uuid IS NULL
         OR EXISTS (SELECT 1 FROM claimed_scheduled_event)
    ), inserted_groups AS (
      INSERT INTO session_exercise_groups (
        session_id, source_group_id, lineage_id, provenance, name, order_idx,
        planned_rounds, member_count, rest_between_members_sec,
        rest_between_rounds_sec
      )
      SELECT
        selected.id,
        source_group.id,
        source_group.lineage_id,
        CASE WHEN stats.equal_rounds THEN 'program' ELSE 'legacy' END,
        source_group.name,
        source_group.order_idx,
        CASE
          WHEN stats.equal_rounds THEN
            coalesce(source_group.planned_rounds, stats.minimum_sets)
          ELSE NULL
        END,
        stats.member_count,
        coalesce(source_group.rest_between_members_sec, 0),
        source_group.rest_after_round_sec
      FROM selected_session selected
      JOIN owned_template template ON selected.inserted
      JOIN superset_groups source_group
        ON source_group.workout_template_id = template.id
      JOIN LATERAL (
        SELECT
          count(*)::integer AS member_count,
          min(target.sets)::integer AS minimum_sets,
          min(target.sets) = max(target.sets) AS equal_rounds
        FROM workout_template_exercises member
        JOIN exercise_prescriptions target
          ON target.template_exercise_id = member.id
         AND target.superseded_by_id IS NULL
        WHERE member.superset_group_id = source_group.id
      ) stats ON true
      RETURNING id, session_id, source_group_id, rest_between_members_sec,
                rest_between_rounds_sec
    ), inserted_exercises AS (
      INSERT INTO session_exercises (
        session_id, exercise_id, planned_from_template_exercise_id,
        source_slot_lineage_id,
        prescribed_semantics_version, prescribed_exercise_name,
        prescribed_metric_type, prescribed_load_type,
        prescribed_load_semantics,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot,
        order_idx, superset_key, group_snapshot_id, group_member_order_idx,
        rest_sec, target_sets, target_reps_min,
        target_reps_max, target_load, target_load_unit, notes,
        warmup_notes, warmup_sets, set_notes
      )
      SELECT
        selected.id,
        slot.exercise_id,
        slot.id,
        slot.lineage_id,
        1,
        catalog.name,
        catalog.metric_type,
        catalog.load_type,
        catalog.load_semantics,
        1,
        ${sessionEquipmentRequirementsSnapshotExpression(sql`slot.exercise_id`)},
        slot.order_idx,
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
        slot.rest_sec,
        prescription.sets,
        prescription.rep_range_min,
        prescription.rep_range_max,
        prescription.target_load,
        prescription.target_load_unit,
        slot.notes,
        slot.warmup_notes,
        slot.warmup_sets,
        slot.set_notes
      FROM selected_session selected
      JOIN owned_template template ON selected.inserted
      JOIN workout_template_exercises slot
        ON slot.workout_template_id = template.id
      JOIN exercises catalog ON catalog.id = slot.exercise_id
      LEFT JOIN LATERAL (
        SELECT active.*
        FROM exercise_prescriptions active
        WHERE active.template_exercise_id = slot.id
          AND active.superseded_by_id IS NULL
        ORDER BY active.created_at DESC, active.id DESC
        LIMIT 1
      ) prescription ON true
      LEFT JOIN inserted_groups session_group
        ON session_group.source_group_id = slot.superset_group_id
      RETURNING *
    ), day_warmup_source AS MATERIALIZED (
      SELECT
        selected.id AS session_id,
        item.value,
        row_number() OVER (ORDER BY item.ordinality)::integer - 1 AS ordinal
      FROM selected_session selected
      JOIN owned_template template ON selected.inserted
      CROSS JOIN LATERAL jsonb_array_elements(template.effective_warmup_items)
        WITH ORDINALITY AS item(value, ordinality)
      WHERE item.value->>'beforeSlotLineageId' IS NULL
    ), anchored_warmup_source AS MATERIALIZED (
      SELECT
        exercise.id AS session_exercise_id,
        exercise.session_id,
        exercise.exercise_id AS planned_exercise_id,
        exercise.order_idx,
        exercise.group_snapshot_id,
        exercise.group_member_order_idx,
        coalesce(group_anchor.first_order_idx, exercise.order_idx) AS unit_order_idx,
        0::integer AS source_order,
        item.ordinality::integer - 1 AS local_order,
        item.value
      FROM selected_session selected
      JOIN owned_template template ON selected.inserted
      CROSS JOIN LATERAL jsonb_array_elements(template.effective_warmup_items)
        WITH ORDINALITY AS item(value, ordinality)
      JOIN inserted_exercises exercise
        ON exercise.source_slot_lineage_id =
          (item.value->>'beforeSlotLineageId')::uuid
      LEFT JOIN LATERAL (
        SELECT min(member.order_idx)::integer AS first_order_idx
        FROM inserted_exercises member
        WHERE member.group_snapshot_id = exercise.group_snapshot_id
      ) group_anchor ON exercise.group_snapshot_id IS NOT NULL
      WHERE item.value->>'beforeSlotLineageId' IS NOT NULL
    ), exercise_warmup_source AS MATERIALIZED (
      SELECT
        exercise.id AS session_exercise_id,
        exercise.session_id,
        exercise.exercise_id AS planned_exercise_id,
        exercise.order_idx,
        exercise.group_snapshot_id,
        exercise.group_member_order_idx,
        coalesce(group_anchor.first_order_idx, exercise.order_idx) AS unit_order_idx,
        1::integer AS source_order,
        item.ordinality::integer - 1 AS local_order,
        item.value
      FROM inserted_exercises exercise
      CROSS JOIN LATERAL jsonb_array_elements(exercise.warmup_sets)
        WITH ORDINALITY AS item(value, ordinality)
      LEFT JOIN LATERAL (
        SELECT min(member.order_idx)::integer AS first_order_idx
        FROM inserted_exercises member
        WHERE member.group_snapshot_id = exercise.group_snapshot_id
      ) group_anchor ON exercise.group_snapshot_id IS NOT NULL
    ), combined_exercise_warmup_source AS MATERIALIZED (
      SELECT * FROM anchored_warmup_source
      UNION ALL
      SELECT * FROM exercise_warmup_source
    ), ordered_exercise_warmups AS MATERIALIZED (
      SELECT source.*,
        row_number() OVER (
          PARTITION BY source.session_exercise_id
          ORDER BY source.source_order, source.local_order
        )::integer - 1 AS kind_ordinal
      FROM combined_exercise_warmup_source source
    ), working_source AS MATERIALIZED (
      SELECT
        exercise.id AS session_exercise_id,
        exercise.session_id,
        exercise.exercise_id AS planned_exercise_id,
        exercise.order_idx,
        exercise.target_reps_min,
        exercise.target_reps_max,
        exercise.target_load,
        exercise.target_load_unit,
        exercise.rest_sec,
        exercise.notes,
        exercise.set_notes,
        exercise.group_snapshot_id,
        exercise.group_member_order_idx,
        session_group.rest_between_members_sec,
        session_group.rest_between_rounds_sec,
        series.round_number,
        coalesce(group_anchor.first_order_idx, exercise.order_idx) AS unit_order_idx
      FROM inserted_exercises exercise
      CROSS JOIN LATERAL generate_series(
        1,
        coalesce(exercise.target_sets, 0)
      ) AS series(round_number)
      LEFT JOIN LATERAL (
        SELECT min(member.order_idx)::integer AS first_order_idx
        FROM inserted_exercises member
        WHERE member.group_snapshot_id = exercise.group_snapshot_id
      ) group_anchor ON exercise.group_snapshot_id IS NOT NULL
      LEFT JOIN inserted_groups session_group
        ON session_group.id = exercise.group_snapshot_id
    ), ordered_working AS MATERIALIZED (
      SELECT source.*,
        row_number() OVER (
          ORDER BY
            source.unit_order_idx,
            source.round_number,
            coalesce(source.group_member_order_idx, 0),
            source.order_idx,
            source.session_exercise_id
        )::integer - 1 AS global_ordinal,
        lead(source.group_snapshot_id) OVER (
          ORDER BY
            source.unit_order_idx,
            source.round_number,
            coalesce(source.group_member_order_idx, 0),
            source.order_idx,
            source.session_exercise_id
        ) AS next_group_snapshot_id,
        lead(source.round_number) OVER (
          ORDER BY
            source.unit_order_idx,
            source.round_number,
            coalesce(source.group_member_order_idx, 0),
            source.order_idx,
            source.session_exercise_id
        ) AS next_round_number
      FROM working_source source
    ), exercise_event_order AS MATERIALIZED (
      SELECT
        'warmup'::text AS event_kind,
        source.session_exercise_id,
        source.kind_ordinal AS item_ordinal,
        source.unit_order_idx,
        1::integer AS round_number,
        coalesce(source.group_member_order_idx, 0) AS member_order_idx,
        source.order_idx,
        0::integer AS event_order,
        source.source_order,
        source.local_order
      FROM ordered_exercise_warmups source
      UNION ALL
      SELECT
        'working'::text AS event_kind,
        source.session_exercise_id,
        source.round_number - 1 AS item_ordinal,
        source.unit_order_idx,
        source.round_number,
        coalesce(source.group_member_order_idx, 0) AS member_order_idx,
        source.order_idx,
        1::integer AS event_order,
        0::integer AS source_order,
        0::integer AS local_order
      FROM ordered_working source
    ), sequenced_exercise_events AS MATERIALIZED (
      SELECT source.*,
        row_number() OVER (
          ORDER BY source.unit_order_idx, source.round_number,
            source.member_order_idx, source.order_idx, source.event_order,
            source.source_order, source.local_order,
            source.session_exercise_id
        )::integer - 1 AS global_ordinal
      FROM exercise_event_order source
    ), inserted_occurrences AS (
      INSERT INTO session_occurrences (
        session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, label, planned_exercise_id, planned_reps_min,
        planned_reps_max, planned_load, planned_load_unit,
        planned_load_percent, planned_load_text, planned_rest_sec,
        planned_note, group_snapshot_id, group_round,
        group_member_order_idx, outcome
      )
      SELECT
        source.session_id,
        NULL::uuid,
        'day_warmup',
        'planned',
        source.ordinal,
        source.ordinal,
        source.value->>'label',
        NULL::uuid,
        (source.value->>'reps')::integer,
        (source.value->>'reps')::integer,
        (source.value->>'load')::numeric,
        CASE
          WHEN source.value->>'load' IS NOT NULL
          THEN (source.value->>'loadUnit')::unit
          ELSE NULL::unit
        END,
        CASE
          WHEN source.value->>'load' IS NULL
          THEN (source.value->>'loadPercent')::numeric
          ELSE NULL::numeric
        END,
        CASE
          WHEN source.value->>'load' IS NULL
            AND source.value->>'loadPercent' IS NULL
          THEN source.value->>'loadText'
          ELSE NULL::text
        END,
        NULL::integer,
        source.value->>'notes',
        NULL::uuid,
        NULL::integer,
        NULL::integer,
        'pending'
      FROM day_warmup_source source
      UNION ALL
      SELECT
        source.session_id,
        source.session_exercise_id,
        'exercise_warmup',
        'planned',
        (SELECT count(*) FROM day_warmup_source) + event.global_ordinal,
        source.kind_ordinal,
        source.value->>'label',
        source.planned_exercise_id,
        (source.value->>'reps')::integer,
        (source.value->>'reps')::integer,
        (source.value->>'load')::numeric,
        CASE
          WHEN source.value->>'load' IS NOT NULL
          THEN (source.value->>'loadUnit')::unit
          ELSE NULL::unit
        END,
        CASE
          WHEN source.value->>'load' IS NULL
          THEN (source.value->>'loadPercent')::numeric
          ELSE NULL::numeric
        END,
        CASE
          WHEN source.value->>'load' IS NULL
            AND source.value->>'loadPercent' IS NULL
          THEN source.value->>'loadText'
          ELSE NULL::text
        END,
        NULL::integer,
        source.value->>'notes',
        NULL::uuid,
        NULL::integer,
        NULL::integer,
        'pending'
      FROM ordered_exercise_warmups source
      JOIN sequenced_exercise_events event
        ON event.event_kind = 'warmup'
       AND event.session_exercise_id = source.session_exercise_id
       AND event.item_ordinal = source.kind_ordinal
      UNION ALL
      SELECT
        source.session_id,
        source.session_exercise_id,
        'working_set',
        'planned',
        (SELECT count(*) FROM day_warmup_source) + event.global_ordinal,
        source.round_number - 1,
        NULL::text,
        source.planned_exercise_id,
        source.target_reps_min,
        source.target_reps_max,
        source.target_load,
        source.target_load_unit,
        NULL::numeric,
        NULL::text,
        CASE
          WHEN source.group_snapshot_id IS NULL THEN source.rest_sec
          WHEN source.next_group_snapshot_id IS DISTINCT FROM source.group_snapshot_id THEN 0
          WHEN source.next_round_number = source.round_number THEN source.rest_between_members_sec
          ELSE source.rest_between_rounds_sec
        END,
        coalesce(source.set_notes->>(source.round_number - 1), source.notes),
        source.group_snapshot_id,
        CASE WHEN source.group_snapshot_id IS NULL THEN NULL ELSE source.round_number END,
        source.group_member_order_idx,
        'pending'
      FROM ordered_working source
      JOIN sequenced_exercise_events event
        ON event.event_kind = 'working'
       AND event.session_exercise_id = source.session_exercise_id
       AND event.item_ordinal = source.round_number - 1
      RETURNING id
    )
    SELECT
      selected.id,
      NOT selected.inserted AS existing,
      selected.selected_by,
      selected.start_request_key,
      selected.start_request_hash,
      CASE WHEN selected.inserted THEN (
        SELECT count(*)::int
        FROM workout_template_exercises slot
        JOIN owned_template template ON template.id = slot.workout_template_id
      ) ELSE NULL END AS expected_exercises,
      CASE WHEN selected.inserted THEN (
        SELECT count(*)::int FROM inserted_exercises
      ) ELSE NULL END AS inserted_exercises,
      CASE WHEN selected.inserted THEN (
        SELECT count(*)::int FROM superset_groups source_group
        JOIN owned_template template
          ON template.id = source_group.workout_template_id
      ) ELSE NULL END AS expected_groups,
      CASE WHEN selected.inserted THEN (
        SELECT count(*)::int FROM inserted_groups
      ) ELSE NULL END AS inserted_groups,
      CASE WHEN selected.inserted THEN (
        (SELECT count(*)::int FROM day_warmup_source)
        + (SELECT count(*)::int FROM ordered_exercise_warmups)
        + (SELECT count(*)::int FROM ordered_working)
      ) ELSE NULL END AS expected_occurrences,
      CASE WHEN selected.inserted THEN (
        SELECT count(*)::int FROM inserted_occurrences
      ) ELSE NULL END AS inserted_occurrences
    FROM selected_session selected
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) {
    if (startRequestKey != null) {
      const exact = await findOwnedWorkoutByStartRequest(
        db,
        userId,
        startRequestKey,
      );
      if (exact) {
        await checkpoint("after-start-statement");
        return exact.startRequestHash === startRequestHash
          ? {
              outcome: "replayed",
              sessionId: exact.id,
              existing: true,
            }
          : {
              outcome: "request_conflict",
              sessionId: exact.id,
              existing: true,
            };
      }
    }
    const active = await findOwnedActiveWorkout(db, userId);
    if (active) {
      await checkpoint("after-start-statement");
      return startRequestKey == null
        ? {
            outcome: "replayed",
            sessionId: active.id,
            existing: true,
          }
        : {
            outcome: "active_workout_exists",
            sessionId: active.id,
            activeSessionId: active.id,
            existing: true,
          };
    }
    throw new StaleWorkoutTemplateError();
  }
  if (startRequestKey != null) {
    const selectedKey = row.start_request_key == null
      ? null
      : String(row.start_request_key);
    const selectedHash = row.start_request_hash == null
      ? null
      : String(row.start_request_hash);
    if (selectedKey === startRequestKey && selectedHash !== startRequestHash) {
      return {
        outcome: "request_conflict",
        sessionId: String(row.id),
        existing: true,
      };
    }
    if (selectedKey !== startRequestKey) {
      return {
        outcome: "active_workout_exists",
        sessionId: String(row.id),
        activeSessionId: String(row.id),
        existing: true,
      };
    }
  }
  if (
    !row.existing &&
    !(dependencies.evaluateStartCounts ?? ((expected, inserted) => expected === inserted))(
      Number(row.expected_exercises)
        + Number(row.expected_groups)
        + Number(row.expected_occurrences),
      Number(row.inserted_exercises)
        + Number(row.inserted_groups)
        + Number(row.inserted_occurrences)
    )
  ) {
    await cleanupIncompleteWorkoutCreation(db, userId, String(row.id));
    if (dependencies.logStartIncomplete) {
      await dependencies.logStartIncomplete();
    } else {
      const { logDiagnosticEvent } = await import("@/lib/server-log");
      logDiagnosticEvent("session.start_incomplete", {});
    }
    throw new IncompleteWorkoutCreationError();
  }
  await checkpoint("after-start-statement");
  const existing = Boolean(row.existing);
  return {
    outcome: existing ? "replayed" : "created",
    sessionId: String(row.id),
    existing,
  };
}

export async function logWorkoutSet(
  db: Db,
  userId: string,
  input: LogWorkoutSetInput,
  dependencies: SessionLifecycleDependencies = {}
): Promise<LogWorkoutSetResult> {
  if (
    (input.occurrenceId == null) !==
    (input.expectedOccurrenceRevision == null)
  ) {
    throw new Error("An occurrence identity and revision must be supplied together.");
  }
  if (
    (input.rir != null && (
      !Number.isFinite(input.rir) || input.rir < 0 || input.rir > 10
    )) ||
    (input.rpe != null && input.rir != null) ||
    (input.techniqueIssue != null &&
      !TECHNIQUE_ISSUES.includes(input.techniqueIssue)) ||
    (input.limitationCause != null &&
      !LIMITATION_CAUSES.includes(input.limitationCause)) ||
    (input.pain != null && (
      !PAIN_BODY_PARTS.includes(input.pain.bodyPart) ||
      !Number.isInteger(input.pain.severity) ||
      input.pain.severity < 1 ||
      input.pain.severity > 10 ||
      (input.pain.note?.length ?? 0) > 500
    ))
  ) {
    throw new Error("Set exception context is invalid.");
  }
  if (
    input.performedSemanticsVersion !== 1 ||
    !PERFORMED_LOAD_SEMANTICS.includes(input.performedLoadSemantics) ||
    typeof input.performedLoadType !== "string" ||
    input.performedLoadType.trim().length === 0 ||
    input.performedLoadType.length > 50
  ) {
    return { outcome: "performed_evidence_conflict", reason: "semantics_changed" };
  }
  const measurement = buildPerformedSetMeasurement(input);
  if (!measurement.ok) {
    return {
      outcome: "unsupported_set_shape",
      metricType: input.metricType as PerformedMetricType,
      reason: measurement.reason,
    };
  }
  const initial = await logWorkoutSetAttempt(
    db,
    userId,
    input,
    dependencies,
    null,
  );
  if (
    initial.outcome !== "equipment_selection_required" ||
    input.weight == null ||
    input.equipmentSnapshotId != null ||
    (input.loadEntryMeaning ?? "legacy_unknown") !== "legacy_unknown"
  ) {
    return initial;
  }
  const availability = await resolveSessionEquipmentAvailability(
    db,
    userId,
    input.sessionExerciseId,
  );
  if (!availability || availability.availableOptionCount > 0) return initial;
  return logWorkoutSetAttempt(db, userId, input, dependencies, availability);
}

async function logWorkoutSetAttempt(
  db: Db,
  userId: string,
  input: LogWorkoutSetInput,
  dependencies: SessionLifecycleDependencies,
  equipmentAvailability: Awaited<
    ReturnType<typeof resolveSessionEquipmentAvailability>
  >,
): Promise<LogWorkoutSetResult> {
  const checkpoint = dependencies.checkpoint ?? noCheckpoint;
  if ((input.weight == null) !== (input.weightUnit == null)) {
    throw new Error("Weighted sets require one explicit load unit.");
  }
  if (!input.clientKey.trim()) throw new Error("A stable set identity is required.");
  if (input.isWarmup) return { outcome: "set_number_conflict" };
  const setId = randomUUID();
  const occurrenceId = randomUUID();
  const equipmentSnapshotId = input.equipmentSnapshotId ?? null;
  const loadEntryMeaning = input.loadEntryMeaning ?? "legacy_unknown";
  const observedCompletedAtISO = input.observedCompletedAtISO ?? null;
  const rir = input.rir ?? null;
  const techniqueIssue = input.techniqueIssue ?? null;
  const limitationCause = input.limitationCause ?? null;
  const pain = input.pain ?? null;
  if (input.rpe != null && rir != null) {
    throw new Error("Record effort as either RIR or RPE, not both.");
  }
  const painId = randomUUID();
  const equipmentExerciseId =
    equipmentAvailability?.exerciseId ?? input.sessionExerciseId;
  const equipmentSourceRevision = equipmentAvailability?.sourceRevision ?? "";
  const availableEquipmentOptionCount =
    equipmentAvailability?.availableOptionCount ?? 0;
  const mutationHash = createHash("sha256")
    .update(JSON.stringify({
      operation: "complete",
      occurrenceId: input.occurrenceId ?? null,
      expectedOccurrenceRevision: input.expectedOccurrenceRevision ?? null,
      performedExerciseId: input.performedExerciseId,
      performedSemanticsVersion: input.performedSemanticsVersion,
      performedLoadType: input.performedLoadType,
      performedLoadSemantics: input.performedLoadSemantics,
      metricType: input.metricType,
      setNo: input.setNo,
      weight: input.weight,
      weightUnit: input.weightUnit,
      reps: input.reps,
      distanceKm: input.distanceKm,
      durationSeconds: input.durationSeconds,
      rpe: input.rpe ?? null,
      rir,
      techniqueIssue,
      limitationCause,
      pain,
      isWarmup: input.isWarmup ?? false,
      note: input.note ?? null,
      equipmentSnapshotId,
      loadEntryMeaning,
      observedCompletedAtISO,
    }))
    .digest("hex");
  const usesPrescribedMeaning = sql`coalesce((
    se.prescribed_semantics_version = 1
    AND se.modification_type NOT IN ('substituted', 'added')
  ), false)`;
  const usesRetainedEquipmentRequirements = sql`coalesce((
    se.equipment_requirements_semantics_version = 1
    AND se.equipment_requirements_snapshot IS NOT NULL
  ), false)`;
  const authoritativeMetricType = sql`CASE
    WHEN ${usesPrescribedMeaning} THEN se.prescribed_metric_type
    ELSE exercise.metric_type
  END`;
  const authoritativeLoadType = sql`CASE
    WHEN ${usesPrescribedMeaning} THEN se.prescribed_load_type
    ELSE exercise.load_type
  END`;
  const authoritativeLoadSemantics = sql`CASE
    WHEN ${usesPrescribedMeaning} THEN se.prescribed_load_semantics
    ELSE exercise.load_semantics
  END`;
  const performedMetricType = sql`CASE
    WHEN ${authoritativeMetricType}::text = 'weight_reps'
      AND ${authoritativeLoadSemantics}::text = 'resistance_band'
      THEN 'reps'::metric_type
    ELSE ${authoritativeMetricType}
  END`;
  const retainedBroadRequirementsValid = sql`NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      se.equipment_requirements_snapshot->'broad'
    ) requirement(value)
    WHERE requirement.value->>'equipmentType' <> 'bodyweight'
      AND NOT (
        (
          requirement.value->>'equipmentType' = 'plates'
          AND requirement.value #>> '{equipmentDefinition,id}' IS NULL
          AND EXISTS (
            SELECT 1 FROM plate_inventory plate
            WHERE plate.user_id = ws.user_id
              AND plate.quantity > 0
              AND plate.denomination > 0
          )
        ) OR (
          requirement.value->>'equipmentType' <> 'plates'
          AND EXISTS (
          SELECT 1 FROM equipment_items available_item
          WHERE available_item.user_id = ws.user_id
            AND available_item.available
            AND available_item.type::text = requirement.value->>'equipmentType'
            AND (
              requirement.value #>> '{equipmentDefinition,id}' IS NULL
              OR requirement.value #>> '{equipmentDefinition,id}' =
                available_item.definition_id::text
            )
            AND (
              requirement.value->'minWeight' = 'null'::jsonb
              OR (
                available_item.attrs->>'maxWeight' ~ '^[0-9]+([.][0-9]+)?$'
                AND (available_item.attrs->>'maxWeight')::numeric >=
                  (requirement.value->>'minWeight')::numeric
              )
            )
          )
        )
      )
  )`;
  const retainedSelectedPrimaryMatchesBroad = sql`(
    NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        se.equipment_requirements_snapshot->'broad'
      ) requirement(value)
      WHERE requirement.value->>'equipmentType' <> 'bodyweight'
    ) OR (
      EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        se.equipment_requirements_snapshot->'broad'
      ) requirement(value)
      WHERE requirement.value->>'equipmentType' = selected_item.type::text
        AND (
          requirement.value #>> '{equipmentDefinition,id}' IS NULL
          OR requirement.value #>> '{equipmentDefinition,id}' =
            selected_item.definition_id::text
        )
        AND (
          requirement.value->'minWeight' = 'null'::jsonb
          OR (
            selected_item.attrs->>'maxWeight' ~ '^[0-9]+([.][0-9]+)?$'
            AND (selected_item.attrs->>'maxWeight')::numeric >=
              (requirement.value->>'minWeight')::numeric
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          se.equipment_requirements_snapshot->'broad'
        ) requirement(value)
        WHERE requirement.value->>'equipmentType' = selected_item.type::text
          AND NOT (
            (
              requirement.value #>> '{equipmentDefinition,id}' IS NULL
              OR requirement.value #>> '{equipmentDefinition,id}' =
                selected_item.definition_id::text
            )
            AND (
              requirement.value->'minWeight' = 'null'::jsonb
              OR (
                selected_item.attrs->>'maxWeight' ~ '^[0-9]+([.][0-9]+)?$'
                AND (selected_item.attrs->>'maxWeight')::numeric >=
                  (requirement.value->>'minWeight')::numeric
              )
            )
          )
      )
    )
  )`;
  const retainedSelectedProfileMatchesExact = sql`CASE
    WHEN se.equipment_requirements_snapshot->'exact' = 'null'::jsonb THEN true
    ELSE
      (
        se.equipment_requirements_snapshot #>> '{exact,requiredProfileKind}' IS NULL
        OR se.equipment_requirements_snapshot #>> '{exact,requiredProfileKind}' =
          snapshot.profile_kind
      )
      AND (
        se.equipment_requirements_snapshot #>>
          '{exact,requiredEquipmentDefinition,id}' IS NULL
        OR se.equipment_requirements_snapshot #>>
          '{exact,requiredEquipmentDefinition,id}' = selected_item.definition_id::text
      )
      AND (
        coalesce((se.equipment_requirements_snapshot #>>
          '{exact,requiresKnownGeometry}')::boolean, false) = false
        OR snapshot.geometry_certainty = 'known'
      )
      AND (
        (
          se.equipment_requirements_snapshot #>>
            '{exact,requiredAttachmentKind}' IS NULL
          AND se.equipment_requirements_snapshot #>>
            '{exact,requiredAttachmentDefinition,id}' IS NULL
        ) OR (
          selected_attachment.available
          AND (
            se.equipment_requirements_snapshot #>>
              '{exact,requiredAttachmentKind}' IS NULL
            OR se.equipment_requirements_snapshot #>>
              '{exact,requiredAttachmentKind}' =
                selected_attachment_profile.attachment_kind
          )
          AND (
            se.equipment_requirements_snapshot #>>
              '{exact,requiredAttachmentDefinition,id}' IS NULL
            OR se.equipment_requirements_snapshot #>>
              '{exact,requiredAttachmentDefinition,id}' =
                selected_attachment.definition_id::text
          )
          AND EXISTS (
            SELECT 1 FROM cable_attachment_compatibilities compatibility
            WHERE compatibility.cable_profile_id = snapshot.load_profile_id
              AND compatibility.attachment_profile_id = snapshot.attachment_profile_id
              AND compatibility.user_id = ws.user_id
          )
        )
      )
  END`;
  await checkpoint("before-set-statement");
  const query = sql`
    WITH visible AS MATERIALIZED (
      SELECT se.*, ws.status AS session_status, ws.archived_at AS session_archived_at,
             ws.started_at AS session_started_at
      FROM session_exercises se
      JOIN workout_sessions ws ON ws.id = se.session_id
      WHERE se.id = ${input.sessionExerciseId}::uuid
        AND ws.user_id = ${userId}::uuid
    ), owned AS MATERIALIZED (
      SELECT se.*,
             ${usesPrescribedMeaning} AS uses_prescribed_meaning,
             ${performedMetricType} AS performed_metric_type,
             ${authoritativeLoadType} AS performed_load_type,
             ${authoritativeLoadSemantics} AS performed_load_semantics,
             se.exercise_id = ${input.performedExerciseId}::uuid
               AS performed_exercise_matches,
             ${performedMetricType} = ${input.metricType}::metric_type
               AS performed_metric_matches,
             ${authoritativeLoadType}::text = ${input.performedLoadType}
               AND ${authoritativeLoadSemantics} =
                 ${input.performedLoadSemantics}::load_semantics
               AND ${input.performedSemanticsVersion}::integer = 1
               AS performed_semantics_match,
             CASE
               WHEN (
                 (${authoritativeLoadSemantics}::text = 'assistance')
                 IS DISTINCT FROM
                 (${authoritativeMetricType}::text = 'assisted_reps')
               ) THEN false
               WHEN ${authoritativeMetricType}::text = 'weight_reps'
                 AND ${authoritativeLoadSemantics}::text = 'resistance_band'
                 THEN ${input.weight}::double precision IS NULL
                   AND ${input.weightUnit}::unit IS NULL
                   AND ${input.reps}::integer IS NOT NULL
                   AND ${input.distanceKm}::real IS NULL
                   AND ${input.durationSeconds}::integer IS NULL
               WHEN ${authoritativeMetricType}::text IN ('duration', 'distance_duration')
                 AND ${authoritativeLoadSemantics}::text NOT IN ('none', 'bodyweight')
                 THEN false
               ELSE CASE ${performedMetricType}::text
               WHEN 'weight_reps' THEN
                 ${input.weight}::double precision IS NOT NULL
                 AND ${input.weightUnit}::unit IS NOT NULL
                 AND ${input.reps}::integer IS NOT NULL
                 AND ${input.distanceKm}::real IS NULL
                 AND ${input.durationSeconds}::integer IS NULL
               WHEN 'reps' THEN
                 ${input.weight}::double precision IS NULL
                 AND ${input.weightUnit}::unit IS NULL
                 AND ${input.reps}::integer IS NOT NULL
                 AND ${input.distanceKm}::real IS NULL
                 AND ${input.durationSeconds}::integer IS NULL
               WHEN 'assisted_reps' THEN
                 ${input.weight}::double precision IS NOT NULL
                 AND ${input.weightUnit}::unit IS NOT NULL
                 AND ${input.reps}::integer IS NOT NULL
                 AND ${input.distanceKm}::real IS NULL
                 AND ${input.durationSeconds}::integer IS NULL
               WHEN 'duration' THEN
                 ${input.weight}::double precision IS NULL
                 AND ${input.weightUnit}::unit IS NULL
                 AND ${input.reps}::integer IS NULL
                 AND ${input.distanceKm}::real IS NULL
                 AND ${input.durationSeconds}::integer IS NOT NULL
               WHEN 'distance_duration' THEN
                 ${input.weight}::double precision IS NULL
                 AND ${input.weightUnit}::unit IS NULL
                 AND ${input.reps}::integer IS NULL
                 AND ${input.distanceKm}::real IS NOT NULL
               ELSE false
               END
             END AS writer_shape_supported,
             (
               (
                 ${authoritativeLoadType}::text IN ('barbell', 'ez_bar', 'trap_bar')
                 OR (
                   (${usesRetainedEquipmentRequirements}
                     AND se.equipment_requirements_snapshot->'exact' <> 'null'::jsonb)
                   OR (
                     NOT ${usesRetainedEquipmentRequirements}
                     AND NOT ${usesPrescribedMeaning}
                     AND exact_requirement.exercise_id IS NOT NULL
                   )
                 )
               )
               AND (
                 ${equipmentAvailability == null}::boolean
                 OR ${availableEquipmentOptionCount}::integer > 0
               )
             ) AS evidence_required,
             (
               ${input.weight}::double precision IS NULL
               OR ${equipmentAvailability == null}::boolean
               OR (
                 se.exercise_id = ${equipmentExerciseId}::uuid
                 AND ${sessionEquipmentSelectionSourceRevisionExpression(
                   userId,
                   equipmentExerciseId,
                   equipmentAvailability?.requirementsEvidence === "legacy_unknown"
                     && !(equipmentAvailability?.usesPrescribedMeaning ?? false),
                   sql`se.equipment_requirements_snapshot`,
                 )} = ${equipmentSourceRevision}
               )
             ) AS equipment_source_current,
             snapshot.profile_kind AS selected_profile_kind,
             snapshot.geometry_snapshot AS selected_geometry_snapshot,
             CASE WHEN ${usesRetainedEquipmentRequirements}
             THEN ${retainedBroadRequirementsValid}
             ELSE (${usesPrescribedMeaning}) OR NOT EXISTS (
               SELECT 1
               FROM exercise_equipment_requirements requirement
               WHERE requirement.exercise_id = se.exercise_id
                 AND requirement.equipment_type::text <> 'bodyweight'
                 AND NOT (
                   (
                     requirement.equipment_type::text = 'plates'
                     AND EXISTS (
                       SELECT 1 FROM plate_inventory plate
                       WHERE plate.user_id = ws.user_id
                         AND plate.quantity > 0
                         AND plate.denomination > 0
                     )
                   ) OR EXISTS (
                     SELECT 1 FROM equipment_items available_item
                     WHERE available_item.user_id = ws.user_id
                       AND available_item.available
                       AND available_item.type = requirement.equipment_type
                       AND (
                         requirement.min_weight IS NULL
                         OR (
                           available_item.attrs->>'maxWeight' ~ '^[0-9]+([.][0-9]+)?$'
                           AND (available_item.attrs->>'maxWeight')::numeric
                             >= requirement.min_weight
                         )
                       )
                   )
                 )
             ) END AS broad_requirements_valid,
             CASE WHEN ${usesRetainedEquipmentRequirements}
             THEN ${retainedSelectedPrimaryMatchesBroad}
             ELSE (${usesPrescribedMeaning}) OR EXISTS (
               SELECT 1
               FROM exercise_equipment_requirements primary_requirement
               WHERE primary_requirement.exercise_id = se.exercise_id
                 AND primary_requirement.equipment_type = selected_item.type
                 AND (
                   primary_requirement.min_weight IS NULL
                   OR (
                     selected_item.attrs->>'maxWeight' ~ '^[0-9]+([.][0-9]+)?$'
                     AND (selected_item.attrs->>'maxWeight')::numeric
                       >= primary_requirement.min_weight
                   )
                 )
             ) END AS selected_primary_matches_broad,
             CASE ${authoritativeLoadType}::text
               WHEN 'barbell' THEN snapshot.profile_kind = 'plate_loaded_implement'
                 AND snapshot.geometry_snapshot->>'loadingKind' = 'olympic'
               WHEN 'ez_bar' THEN snapshot.profile_kind = 'plate_loaded_implement'
                 AND snapshot.geometry_snapshot->>'loadingKind' = 'ez'
               WHEN 'trap_bar' THEN snapshot.profile_kind = 'plate_loaded_implement'
                 AND snapshot.geometry_snapshot->>'loadingKind' = 'trap_hex'
               ELSE true
             END AS selected_profile_matches_load_type,
             CASE WHEN ${usesRetainedEquipmentRequirements}
             THEN ${retainedSelectedProfileMatchesExact}
             WHEN ${usesPrescribedMeaning} THEN true
             WHEN exact_requirement.exercise_id IS NULL THEN true ELSE
               (exact_requirement.required_profile_kind IS NULL
                 OR exact_requirement.required_profile_kind = snapshot.profile_kind)
               AND (exact_requirement.required_equipment_definition_id IS NULL
                 OR exact_requirement.required_equipment_definition_id = selected_item.definition_id)
               AND (NOT exact_requirement.requires_known_geometry
                 OR snapshot.geometry_certainty = 'known')
               AND (
                 (exact_requirement.required_attachment_kind IS NULL
                   AND exact_requirement.required_attachment_definition_id IS NULL)
                 OR (
                   selected_attachment.available
                   AND (exact_requirement.required_attachment_kind IS NULL
                     OR exact_requirement.required_attachment_kind = selected_attachment_profile.attachment_kind)
                   AND (exact_requirement.required_attachment_definition_id IS NULL
                     OR exact_requirement.required_attachment_definition_id = selected_attachment.definition_id)
                   AND EXISTS (
                     SELECT 1 FROM cable_attachment_compatibilities compatibility
                     WHERE compatibility.cable_profile_id = snapshot.load_profile_id
                       AND compatibility.attachment_profile_id = snapshot.attachment_profile_id
                       AND compatibility.user_id = ws.user_id
                   )
                 )
               )
             END AS selected_profile_matches_exact,
             (
               ${observedCompletedAtISO}::timestamptz IS NULL
               OR (
                 ${observedCompletedAtISO}::timestamptz >= ws.started_at
                   - (${LIVE_OBSERVED_COMPLETION_CLOCK_SKEW_SECONDS} * interval '1 second')
                 AND ${observedCompletedAtISO}::timestamptz <= statement_timestamp()
                   + (${LIVE_OBSERVED_COMPLETION_CLOCK_SKEW_SECONDS} * interval '1 second')
               )
             ) AS observed_completion_valid
      FROM session_exercises se
      JOIN workout_sessions ws ON ws.id = se.session_id
      JOIN exercises exercise ON exercise.id = se.exercise_id
      LEFT JOIN exercise_execution_requirements exact_requirement
        ON exact_requirement.exercise_id = se.exercise_id
      LEFT JOIN session_equipment_snapshots snapshot
        ON snapshot.id = se.current_equipment_snapshot_id
       AND snapshot.session_exercise_id = se.id
       AND snapshot.session_id = se.session_id
       AND snapshot.user_id = ws.user_id
      LEFT JOIN equipment_items selected_item
        ON selected_item.id = snapshot.equipment_item_id
       AND selected_item.user_id = ws.user_id
       AND selected_item.available
      LEFT JOIN equipment_items selected_attachment
        ON selected_attachment.id = snapshot.attachment_item_id
       AND selected_attachment.user_id = ws.user_id
      LEFT JOIN cable_attachment_profiles selected_attachment_profile
        ON selected_attachment_profile.id = snapshot.attachment_profile_id
       AND selected_attachment_profile.equipment_item_id = selected_attachment.id
       AND selected_attachment_profile.user_id = ws.user_id
      WHERE se.id = ${input.sessionExerciseId}::uuid
        AND ws.user_id = ${userId}::uuid
        AND ws.status = 'in_progress'
        AND ws.archived_at IS NULL
      FOR UPDATE OF ws, se
    ), selected_setup AS MATERIALIZED (
      SELECT owned.*
      FROM owned
      WHERE owned.equipment_source_current
      AND owned.observed_completion_valid
      AND owned.performed_exercise_matches
      AND owned.performed_metric_matches
      AND owned.performed_semantics_match
      AND owned.writer_shape_supported
      AND CASE
        WHEN owned.evidence_required AND ${input.weight}::double precision IS NOT NULL THEN
          owned.current_equipment_snapshot_id IS NOT NULL
          AND owned.current_equipment_snapshot_id = ${equipmentSnapshotId}::uuid
          AND owned.broad_requirements_valid
          AND owned.selected_primary_matches_broad
          AND owned.selected_profile_matches_load_type
          AND owned.selected_profile_matches_exact
          AND CASE owned.selected_profile_kind
            WHEN 'plate_loaded_implement' THEN ${loadEntryMeaning} = 'total_system'
            WHEN 'plate_loaded_machine' THEN
              ${loadEntryMeaning} = owned.selected_geometry_snapshot->>'targetEntryMeaning'
            WHEN 'cable_machine' THEN CASE owned.selected_geometry_snapshot->>'topology'
              WHEN 'shared_selection' THEN ${loadEntryMeaning} = 'displayed_stack'
              WHEN 'independent_per_stack' THEN
                ${loadEntryMeaning} IN ('per_stack', 'combined_stacks')
              ELSE false
            END
            ELSE false
          END
        ELSE ${equipmentSnapshotId}::uuid IS NULL
          AND ${loadEntryMeaning} = 'legacy_unknown'
      END
    ), owned_occurrence AS MATERIALIZED (
      SELECT occurrence.*
      FROM session_occurrences occurrence
      JOIN owned ON owned.id = occurrence.session_exercise_id
      WHERE occurrence.kind = 'working_set'
        AND occurrence.kind_ordinal = ${input.setNo - 1}
        AND (
          ${input.occurrenceId ?? null}::uuid IS NULL
          OR occurrence.id = ${input.occurrenceId ?? null}::uuid
        )
        AND (
          ${input.expectedOccurrenceRevision ?? null}::integer IS NULL
          OR occurrence.revision = ${input.expectedOccurrenceRevision ?? null}::integer
        )
      FOR UPDATE OF occurrence
    ), exact_occurrence_target AS MATERIALIZED (
      SELECT occurrence.id, occurrence.revision
      FROM session_occurrences occurrence
      JOIN owned ON owned.id = occurrence.session_exercise_id
      WHERE ${input.occurrenceId ?? null}::uuid IS NOT NULL
        AND occurrence.id = ${input.occurrenceId ?? null}::uuid
        AND occurrence.kind = 'working_set'
        AND occurrence.kind_ordinal = ${input.setNo - 1}
    ), blocking_owned_occurrence AS MATERIALIZED (
      SELECT
        earlier.id,
        earlier.revision,
        earlier.session_exercise_id,
        earlier.kind_ordinal + 1 AS set_no,
        earlier.group_round,
        earlier.origin,
        (
          earlier.origin = 'ad_hoc'
          AND earlier.planned_note = ${ADDED_WORKOUT_SET_NOTE}
        ) AS is_added_set,
        blocker_exercise.name AS exercise_name
      FROM owned_occurrence attempted
      JOIN session_occurrences earlier
        ON earlier.session_id = attempted.session_id
       AND earlier.kind = 'working_set'
       AND earlier.outcome = 'pending'
       AND (
         (
           earlier.session_exercise_id = attempted.session_exercise_id
           AND earlier.kind_ordinal < attempted.kind_ordinal
           AND (
             NOT (
               attempted.origin = 'ad_hoc'
               AND attempted.planned_note = ${ADDED_WORKOUT_SET_NOTE}
             )
             OR (
               earlier.origin = 'ad_hoc'
               AND earlier.planned_note = ${ADDED_WORKOUT_SET_NOTE}
             )
           )
         )
         OR (
           attempted.group_snapshot_id IS NOT NULL
           AND earlier.group_snapshot_id = attempted.group_snapshot_id
           AND earlier.sequence_idx < attempted.sequence_idx
         )
       )
      JOIN session_exercises blocker_session_exercise
        ON blocker_session_exercise.id = earlier.session_exercise_id
       AND blocker_session_exercise.session_id = attempted.session_id
      JOIN exercises blocker_exercise
        ON blocker_exercise.id = blocker_session_exercise.exercise_id
      ORDER BY earlier.sequence_idx, earlier.kind_ordinal, earlier.id
      LIMIT 1
    ), eligible_owned_occurrence AS MATERIALIZED (
      SELECT occurrence.*
      FROM owned_occurrence occurrence
      WHERE occurrence.outcome = 'pending'
        AND NOT EXISTS (SELECT 1 FROM blocking_owned_occurrence)
    ), eligible_ad_hoc AS MATERIALIZED (
      SELECT
        owned.*,
        (
          SELECT coalesce(max(existing.sequence_idx), -1) + 1
          FROM session_occurrences existing
          WHERE existing.session_id = owned.session_id
        ) AS next_sequence_idx
      FROM selected_setup owned
      WHERE owned.modification_type <> 'skipped'
        AND NOT EXISTS (SELECT 1 FROM owned_occurrence)
        AND ${input.setNo} = (
          SELECT coalesce(max(existing.kind_ordinal), -1) + 2
          FROM session_occurrences existing
          WHERE existing.session_exercise_id = owned.id
            AND existing.kind = 'working_set'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM session_occurrences unresolved
          WHERE unresolved.session_exercise_id = owned.id
            AND unresolved.kind = 'working_set'
            AND unresolved.outcome = 'pending'
        )
    ), saved AS (
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit, reps, rpe,
        rir, technique_issue, limitation_cause,
        distance_km, duration_seconds, is_warmup, metric_type, target_met,
        note, client_key, equipment_snapshot_id,
        load_entry_meaning, performed_semantics_version, performed_load_type,
        performed_load_semantics, observed_completed_at,
        observed_completion_provenance, observed_completion_quality
      )
      SELECT
        ${setId}::uuid,
        owned.id,
        ${input.setNo},
        ${input.weight},
        ${input.weightUnit}::unit,
        ${input.reps},
        ${input.rpe ?? null},
        ${rir},
        ${techniqueIssue},
        ${limitationCause},
        ${input.distanceKm},
        ${input.durationSeconds},
        ${input.isWarmup ?? false},
        owned.performed_metric_type,
        CASE
          WHEN ${input.isWarmup ?? false}::boolean THEN NULL
          WHEN occurrence.origin <> 'planned' THEN NULL
          WHEN owned.performed_metric_type::text IN ('duration', 'distance_duration')
            THEN NULL
          WHEN owned.performed_metric_type::text = 'assisted_reps' THEN NULL
          WHEN owned.performed_metric_type::text = 'reps'
            AND owned.modification_type = 'as_planned' THEN
            CASE
              WHEN owned.target_reps_min IS NULL THEN NULL
              ELSE ${input.reps}::integer >= owned.target_reps_min
            END
          WHEN owned.performed_metric_type::text = 'reps' THEN NULL
          WHEN owned.performed_metric_type::text = 'weight_reps'
            AND (
              owned.performed_load_semantics::text <> 'total'
              OR ${loadEntryMeaning}::text <> 'total_system'
              OR owned.modification_type <> 'as_planned'
            ) THEN NULL
          ELSE owned.target_reps_min IS NOT NULL
            AND ${input.reps}::integer >= owned.target_reps_min
            AND (
              owned.target_load IS NULL
              OR (
                ${input.weight}::double precision IS NOT NULL
                AND ${input.weightUnit}::unit IS NOT NULL
                AND owned.target_load_unit IS NOT NULL
                AND CASE ${input.weightUnit}::unit
                  WHEN 'kg' THEN ${input.weight}::double precision * ${KG_TO_LB}
                  ELSE ${input.weight}::double precision
                END >= CASE owned.target_load_unit
                  WHEN 'kg' THEN owned.target_load * ${KG_TO_LB}
                  ELSE owned.target_load
                END
              )
            )
        END,
        ${input.note ?? null},
        ${input.clientKey},
        CASE WHEN owned.evidence_required AND ${input.weight}::double precision IS NOT NULL
          THEN owned.current_equipment_snapshot_id ELSE NULL END,
        CASE WHEN owned.evidence_required AND ${input.weight}::double precision IS NOT NULL
          THEN ${loadEntryMeaning} ELSE 'legacy_unknown' END,
        1,
        ${input.performedLoadType},
        ${input.performedLoadSemantics}::load_semantics,
        ${observedCompletedAtISO}::timestamptz,
        CASE WHEN ${observedCompletedAtISO}::timestamptz IS NULL
          THEN 'unknown' ELSE 'live_client' END,
        CASE WHEN ${observedCompletedAtISO}::timestamptz IS NULL
          THEN 'unknown' ELSE 'trustworthy' END
      FROM selected_setup owned
      JOIN (
        SELECT occurrence.session_exercise_id, occurrence.origin
        FROM eligible_owned_occurrence occurrence
        UNION ALL
        SELECT eligible.id, 'ad_hoc'::text
        FROM eligible_ad_hoc eligible
      ) occurrence ON occurrence.session_exercise_id = owned.id
      ON CONFLICT (session_exercise_id, client_key)
        WHERE client_key IS NOT NULL
      DO UPDATE SET client_key = excluded.client_key
      WHERE completed_sets.archived_at IS NULL
        AND ROW(
          completed_sets.set_no,
          completed_sets.weight,
          completed_sets.weight_unit,
          completed_sets.reps,
          completed_sets.distance_km,
          completed_sets.duration_seconds,
          completed_sets.rpe,
          completed_sets.rir,
          completed_sets.technique_issue,
          completed_sets.limitation_cause,
          completed_sets.is_warmup,
          completed_sets.metric_type,
          completed_sets.note,
          completed_sets.equipment_snapshot_id,
          completed_sets.load_entry_meaning
          , completed_sets.performed_semantics_version
          , completed_sets.performed_load_type
          , completed_sets.performed_load_semantics
          , completed_sets.observed_completed_at
          , completed_sets.observed_completion_provenance
          , completed_sets.observed_completion_quality
        ) IS NOT DISTINCT FROM ROW(
          excluded.set_no,
          excluded.weight,
          excluded.weight_unit,
          excluded.reps,
          excluded.distance_km,
          excluded.duration_seconds,
          excluded.rpe,
          excluded.rir,
          excluded.technique_issue,
          excluded.limitation_cause,
          excluded.is_warmup,
          excluded.metric_type,
          excluded.note,
          excluded.equipment_snapshot_id,
          excluded.load_entry_meaning
          , excluded.performed_semantics_version
          , excluded.performed_load_type
          , excluded.performed_load_semantics
          , excluded.observed_completed_at
          , excluded.observed_completion_provenance
          , excluded.observed_completion_quality
        )
      RETURNING id, session_exercise_id
    ), inserted_pain AS (
      INSERT INTO pain_logs (
        id, user_id, session_id, exercise_id, completed_set_id,
        body_part, severity, source, note
      )
      SELECT
        ${painId}::uuid,
        ${userId}::uuid,
        selected.session_id,
        selected.exercise_id,
        saved.id,
        ${pain?.bodyPart ?? null},
        ${pain?.severity ?? null},
        'set_exception',
        ${pain?.note ?? null}
      FROM saved
      JOIN selected_setup selected ON selected.id = saved.session_exercise_id
      WHERE ${pain != null}::boolean
      RETURNING id
    ), updated_occurrence AS (
      UPDATE session_occurrences occurrence
      SET outcome = 'completed',
          outcome_reason = NULL,
          outcome_note = coalesce(${input.note ?? null}, occurrence.outcome_note),
          revision = occurrence.revision + 1,
          resolved_at = now(),
          completed_set_id = saved.id,
          equipment_snapshot_id = CASE
            WHEN ${equipmentSnapshotId}::uuid IS NULL THEN NULL
            ELSE ${equipmentSnapshotId}::uuid
          END
      FROM saved, eligible_owned_occurrence selected_occurrence
      WHERE occurrence.id = selected_occurrence.id
        AND occurrence.outcome = 'pending'
      RETURNING occurrence.id, selected_occurrence.revision AS expected_revision,
                occurrence.revision AS resulting_revision
    ), inserted_ad_hoc_occurrence AS (
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, planned_rest_sec, planned_note,
        outcome, outcome_note, revision, resolved_at, completed_set_id
        , equipment_snapshot_id
      )
      SELECT
        ${occurrenceId}::uuid,
        eligible.session_id,
        eligible.id,
        'working_set',
        'ad_hoc',
        eligible.next_sequence_idx,
        ${input.setNo - 1},
        eligible.exercise_id,
        eligible.rest_sec,
        'Added during this workout',
        'completed',
        ${input.note ?? null},
        1,
        now(),
        saved.id,
        CASE WHEN ${equipmentSnapshotId}::uuid IS NULL THEN NULL
          ELSE ${equipmentSnapshotId}::uuid END
      FROM eligible_ad_hoc eligible
      JOIN saved ON saved.session_exercise_id = eligible.id
      RETURNING id, 0::integer AS expected_revision, revision AS resulting_revision
    ), resolved_occurrence AS MATERIALIZED (
      SELECT * FROM updated_occurrence
      UNION ALL
      SELECT * FROM inserted_ad_hoc_occurrence
    ), saved_receipt AS (
      INSERT INTO session_occurrence_mutations (
        occurrence_id, client_key, operation, canonical_payload_hash,
        expected_revision, resulting_revision, result_code
      )
      SELECT updated.id, ${input.clientKey}, 'complete', ${mutationHash},
             updated.expected_revision, updated.resulting_revision, 'applied'
      FROM resolved_occurrence updated
      ON CONFLICT (occurrence_id, client_key) DO NOTHING
      RETURNING id
    )
    SELECT
      (SELECT saved.id FROM saved, resolved_occurrence LIMIT 1) AS id,
      (SELECT resolved_occurrence.id FROM resolved_occurrence LIMIT 1) AS occurrence_id,
      (SELECT resolved_occurrence.resulting_revision FROM resolved_occurrence LIMIT 1)
        AS occurrence_revision,
      CASE
        WHEN EXISTS (SELECT 1 FROM resolved_occurrence) THEN 'saved'
        WHEN EXISTS (
          SELECT 1 FROM owned
          WHERE NOT performed_exercise_matches
             OR NOT performed_metric_matches
             OR NOT performed_semantics_match
        ) THEN 'performed_evidence_conflict'
        WHEN EXISTS (
          SELECT 1 FROM owned
          WHERE NOT writer_shape_supported
        ) THEN 'unsupported_set_shape'
        WHEN EXISTS (
          SELECT 1 FROM owned
          WHERE NOT equipment_source_current
        ) THEN 'equipment_selection_conflict'
        WHEN EXISTS (
          SELECT 1 FROM owned
          WHERE NOT observed_completion_valid
        ) THEN 'invalid_observed_completion'
        WHEN EXISTS (
          SELECT 1 FROM owned
          WHERE evidence_required AND ${input.weight}::double precision IS NOT NULL
            AND current_equipment_snapshot_id IS NULL
        ) THEN 'equipment_selection_required'
        WHEN EXISTS (SELECT 1 FROM owned)
          AND NOT EXISTS (SELECT 1 FROM selected_setup)
          THEN 'equipment_selection_conflict'
        WHEN ${input.occurrenceId ?? null}::uuid IS NOT NULL
          AND EXISTS (SELECT 1 FROM exact_occurrence_target)
          AND NOT EXISTS (SELECT 1 FROM owned_occurrence)
          THEN 'stale_occurrence'
        WHEN EXISTS (
          SELECT 1
          FROM owned_occurrence occurrence
          WHERE occurrence.outcome = 'pending'
        )
          AND NOT EXISTS (SELECT 1 FROM eligible_owned_occurrence)
          THEN 'set_order_conflict'
        WHEN EXISTS (SELECT 1 FROM owned_occurrence) THEN 'set_number_conflict'
        WHEN EXISTS (SELECT 1 FROM eligible_ad_hoc) THEN 'set_number_conflict'
        WHEN EXISTS (SELECT 1 FROM owned) THEN 'set_number_conflict'
        WHEN EXISTS (SELECT 1 FROM visible) THEN 'workout_not_active'
        ELSE 'not_found'
      END AS outcome,
      (SELECT performed_metric_type::text FROM owned LIMIT 1) AS performed_metric_type,
      (SELECT CASE
        WHEN NOT performed_exercise_matches THEN 'exercise_changed'
        WHEN NOT performed_metric_matches THEN 'metric_changed'
        ELSE 'semantics_changed'
      END FROM owned
      WHERE NOT performed_exercise_matches
         OR NOT performed_metric_matches
         OR NOT performed_semantics_match
      LIMIT 1) AS performed_evidence_reason,
      (SELECT CASE
        WHEN (
          (performed_load_semantics::text = 'assistance')
          IS DISTINCT FROM
          (performed_metric_type::text = 'assisted_reps')
        ) THEN 'metric_semantics_conflict'
        WHEN performed_metric_type::text IN ('duration', 'distance_duration')
          AND performed_load_semantics::text NOT IN ('none', 'bodyweight')
          THEN 'metric_semantics_conflict'
        ELSE CASE performed_metric_type::text
          WHEN 'assisted_reps' THEN 'assisted_reps_requires_numeric_assistance'
          WHEN 'reps' THEN 'reps_cannot_include_load'
          WHEN 'weight_reps' THEN 'weight_reps_requires_load'
          WHEN 'duration' THEN CASE
            WHEN ${input.durationSeconds}::integer IS NULL
              THEN 'duration_requires_time'
            ELSE 'measurement_shape_conflict'
          END
          WHEN 'distance_duration' THEN CASE
            WHEN ${input.distanceKm}::real IS NULL
              THEN 'distance_duration_requires_distance'
            ELSE 'measurement_shape_conflict'
          END
          ELSE 'unsupported_metric'
        END
      END FROM owned WHERE NOT writer_shape_supported LIMIT 1) AS unsupported_reason
      , (SELECT id FROM blocking_owned_occurrence) AS blocker_occurrence_id
      , (SELECT revision FROM blocking_owned_occurrence) AS blocker_occurrence_revision
      , (SELECT session_exercise_id FROM blocking_owned_occurrence)
          AS blocker_session_exercise_id
      , (SELECT exercise_name FROM blocking_owned_occurrence)
          AS blocker_exercise_name
      , (SELECT set_no FROM blocking_owned_occurrence) AS blocker_set_no
      , (SELECT group_round FROM blocking_owned_occurrence) AS blocker_group_round
      , (SELECT origin FROM blocking_owned_occurrence) AS blocker_origin
      , (SELECT is_added_set FROM blocking_owned_occurrence) AS blocker_is_added_set
  `;
  let row: Record<string, unknown> | undefined;
  try {
    row = resultRows(await db.execute(query))[0];
  } catch (error) {
    if (databaseConstraint(error) === "completed_sets_active_set_no_uq") {
      return { outcome: "set_number_conflict" };
    }
    throw error;
  }
  if (!row) throw new Error("The set save statement returned no outcome.");
  await checkpoint("after-set-statement");
  if (row.outcome === "saved" && row.id && row.occurrence_id) {
    return {
      outcome: "saved",
      setId: String(row.id),
      occurrenceId: String(row.occurrence_id),
      occurrenceRevision: Number(row.occurrence_revision),
    };
  }
  if (
    row.outcome === "set_number_conflict" ||
    row.outcome === "equipment_selection_required" ||
    row.outcome === "equipment_selection_conflict" ||
    row.outcome === "performed_evidence_conflict" ||
    row.outcome === "stale_occurrence"
  ) {
    const replay = resultRows(await db.execute(sql`
      SELECT
        completed_set.id,
        occurrence.id AS occurrence_id,
        occurrence.revision AS occurrence_revision,
        (ROW(
          completed_set.set_no,
          completed_set.weight,
          completed_set.weight_unit,
          completed_set.reps,
          completed_set.distance_km,
          completed_set.duration_seconds,
          completed_set.rpe,
          completed_set.rir,
          completed_set.technique_issue,
          completed_set.limitation_cause,
          completed_set.is_warmup,
          completed_set.metric_type,
          completed_set.note,
          completed_set.equipment_snapshot_id,
          completed_set.load_entry_meaning
          , completed_set.performed_semantics_version
          , completed_set.performed_load_type
          , completed_set.performed_load_semantics
          , completed_set.observed_completed_at
          , completed_set.observed_completion_provenance
          , completed_set.observed_completion_quality
        ) IS NOT DISTINCT FROM ROW(
          ${input.setNo}::integer,
          ${input.weight}::double precision,
          ${input.weightUnit}::unit,
          ${input.reps}::integer,
          ${input.distanceKm}::real,
          ${input.durationSeconds}::integer,
          ${input.rpe ?? null}::real,
          ${rir}::real,
          ${techniqueIssue}::text,
          ${limitationCause}::text,
          false,
          ${input.metricType}::metric_type,
          ${input.note ?? null}::text,
          ${equipmentSnapshotId}::uuid,
          ${loadEntryMeaning}::text
          , ${input.performedSemanticsVersion}::integer
          , ${input.performedLoadType}::text
          , ${input.performedLoadSemantics}::load_semantics
          , ${observedCompletedAtISO}::timestamptz
          , CASE WHEN ${observedCompletedAtISO}::timestamptz IS NULL
              THEN 'unknown' ELSE 'live_client' END
          , CASE WHEN ${observedCompletedAtISO}::timestamptz IS NULL
              THEN 'unknown' ELSE 'trustworthy' END
        ))
        AND CASE
          WHEN ${pain != null}::boolean THEN (
            SELECT count(*) = 1
              AND bool_and(ROW(
                pain.body_part,
                pain.severity,
                pain.note
              ) IS NOT DISTINCT FROM ROW(
                ${pain?.bodyPart ?? null}::text,
                ${pain?.severity ?? null}::integer,
                ${pain?.note ?? null}::text
              ))
            FROM pain_logs pain
            WHERE pain.completed_set_id = completed_set.id
              AND pain.archived_at IS NULL
          )
          ELSE NOT EXISTS (
            SELECT 1 FROM pain_logs pain
            WHERE pain.completed_set_id = completed_set.id
              AND pain.archived_at IS NULL
          )
        END AS exact
      FROM completed_sets completed_set
      JOIN session_occurrences occurrence
        ON occurrence.completed_set_id = completed_set.id
       AND occurrence.session_exercise_id = completed_set.session_exercise_id
       AND occurrence.kind = 'working_set'
       AND occurrence.outcome = 'completed'
       AND occurrence.kind_ordinal = ${input.setNo - 1}
      JOIN session_exercises exercise
        ON exercise.id = completed_set.session_exercise_id
      JOIN workout_sessions session ON session.id = exercise.session_id
      WHERE completed_set.session_exercise_id = ${input.sessionExerciseId}::uuid
        AND exercise.exercise_id = ${input.performedExerciseId}::uuid
        AND completed_set.client_key = ${input.clientKey}
        AND completed_set.archived_at IS NULL
        AND session.user_id = ${userId}::uuid
        AND session.archived_at IS NULL
      LIMIT 1
    `))[0];
    if (replay?.exact) {
      return {
        outcome: "saved",
        setId: String(replay.id),
        occurrenceId: String(replay.occurrence_id),
        occurrenceRevision: Number(replay.occurrence_revision),
      };
    }
    if (replay) return { outcome: "retry_identity_conflict" };
    if (row.outcome === "equipment_selection_required") {
      return { outcome: "equipment_selection_required" };
    }
    if (row.outcome === "equipment_selection_conflict") {
      return { outcome: "equipment_selection_conflict" };
    }
    if (row.outcome === "set_number_conflict") {
      return { outcome: "set_number_conflict" };
    }
  }
  if (
    row.outcome === "workout_not_active" ||
    row.outcome === "retry_identity_conflict" ||
    row.outcome === "unsupported_set_shape" ||
    row.outcome === "performed_evidence_conflict" ||
    row.outcome === "equipment_selection_required" ||
    row.outcome === "equipment_selection_conflict" ||
    row.outcome === "invalid_observed_completion" ||
    row.outcome === "stale_occurrence" ||
    row.outcome === "set_order_conflict" ||
    row.outcome === "not_found"
  ) {
    if (row.outcome === "performed_evidence_conflict") {
      return {
        outcome: "performed_evidence_conflict",
        reason: String(row.performed_evidence_reason) as Extract<
          LogWorkoutSetResult,
          { outcome: "performed_evidence_conflict" }
        >["reason"],
      };
    }
    if (row.outcome === "unsupported_set_shape") {
      return {
        outcome: "unsupported_set_shape",
        metricType: String(row.performed_metric_type) as Extract<
          LogWorkoutSetResult,
          { outcome: "unsupported_set_shape" }
        >["metricType"],
        reason: String(row.unsupported_reason) as Extract<
          LogWorkoutSetResult,
          { outcome: "unsupported_set_shape" }
        >["reason"],
      };
    }
    if (row.outcome === "set_order_conflict") {
      if (
        row.blocker_occurrence_id == null ||
        row.blocker_occurrence_revision == null ||
        row.blocker_session_exercise_id == null ||
        row.blocker_exercise_name == null ||
        row.blocker_set_no == null ||
        typeof row.blocker_origin !== "string" ||
        typeof row.blocker_is_added_set !== "boolean"
      ) {
        throw new Error("The set order conflict did not identify its blocker.");
      }
      const setNo = Number(row.blocker_set_no);
      const groupRound = row.blocker_group_round == null
        ? null
        : Number(row.blocker_group_round);
      const exerciseName = String(row.blocker_exercise_name);
      const isAddedSet = row.blocker_is_added_set;
      const position = isAddedSet
        ? "added set"
        : groupRound == null
          ? `set ${setNo}`
          : `round ${groupRound}, set ${setNo}`;
      return {
        outcome: "set_order_conflict",
        blocker: {
          occurrenceId: String(row.blocker_occurrence_id),
          occurrenceRevision: Number(row.blocker_occurrence_revision),
          sessionExerciseId: String(row.blocker_session_exercise_id),
          exerciseName,
          setNo,
          groupRound,
          origin: String(row.blocker_origin),
          isAddedSet,
          label: `${exerciseName} · ${position}`,
        },
      };
    }
    return { outcome: row.outcome };
  }
  throw new Error("The set save statement returned an unsupported outcome.");
}

export async function completeWorkoutSession(
  db: Db,
  user: { id: string; coachingPrefs: CoachingPrefs },
  input: {
    sessionId: string;
    note?: string;
    fatigue?: number;
    durationDecision?: WorkoutCompletionDurationDecision | null;
  },
  dependencies: SessionLifecycleDependencies = {}
) {
  const checkpoint = dependencies.checkpoint ?? noCheckpoint;
  const now = dependencies.now ?? (() => new Date());
  const finishedAt = now();
  const progressionJobId = randomUUID();
  const note = input.note?.trim() || null;
  const durationDecisionBasis = input.durationDecision?.basis ?? null;
  const ownerReportedDurationInputValid =
    input.durationDecision?.basis !== "owner_reported" ||
    (
      Number.isInteger(input.durationDecision.activeDurationSeconds) &&
      input.durationDecision.activeDurationSeconds >= 0 &&
      input.durationDecision.activeDurationSeconds <=
        MAX_ACTIVE_WORKOUT_DURATION_SECONDS
    );
  const ownerReportedDurationSeconds =
    input.durationDecision?.basis === "owner_reported" &&
    ownerReportedDurationInputValid
      ? input.durationDecision.activeDurationSeconds
      : null;
  const finishMutationHash = createHash("sha256")
    .update(JSON.stringify({ operation: "abandon", reason: "finished_early" }))
    .digest("hex");
  await checkpoint("before-completion-statement");
  const query = sql`
    WITH history_revision_lock AS MATERIALIZED (
      ${historyRevisionLockSql(user.id)}
    ), owned AS MATERIALIZED (
      SELECT ws.*
      FROM workout_sessions ws
      CROSS JOIN history_revision_lock
      WHERE ws.id = ${input.sessionId}::uuid
        AND ws.user_id = ${user.id}::uuid
        AND ws.archived_at IS NULL
      FOR UPDATE
    ), duration_context AS MATERIALIZED (
      SELECT
        owned.*,
        LEAST(
          2147483647,
          GREATEST(
            0,
            floor(extract(epoch FROM (
              ${finishedAt.toISOString()}::timestamptz - owned.started_at
            )))
          )
        )::integer AS wall_clock_elapsed_seconds,
        CASE
          WHEN ${finishedAt.toISOString()}::timestamptz < owned.started_at
            THEN 'clock_skew'
          WHEN floor(extract(epoch FROM (
            ${finishedAt.toISOString()}::timestamptz - owned.started_at
          ))) > ${ACTIVE_WORKOUT_REVIEW_THRESHOLD_SECONDS}
            THEN 'stale'
          ELSE NULL
        END AS duration_review_reason
      FROM owned
    ), duration_validation AS MATERIALIZED (
      SELECT
        context.*,
        CASE
          WHEN context.status <> 'in_progress' THEN NULL
          WHEN context.duration_review_reason IS NOT NULL
            AND ${durationDecisionBasis}::text IS NULL
            THEN 'duration_review_required'
          WHEN context.duration_review_reason IS NOT NULL
            AND ${durationDecisionBasis}::text = 'wall_clock_no_stale_signal'
            THEN 'duration_review_required'
          WHEN ${durationDecisionBasis}::text = 'owner_reported'
            AND (
              NOT ${ownerReportedDurationInputValid}::boolean
              OR ${ownerReportedDurationSeconds}::integer IS NULL
              OR ${ownerReportedDurationSeconds}::integer >
                context.wall_clock_elapsed_seconds
            )
            THEN 'invalid_duration_review'
          WHEN ${durationDecisionBasis}::text IS NOT NULL
            AND ${durationDecisionBasis}::text NOT IN (
              'wall_clock_no_stale_signal',
              'owner_reported',
              'interruption_unknown'
            )
            THEN 'invalid_duration_review'
          ELSE NULL
        END AS duration_rejection_code,
        CASE
          WHEN context.status <> 'in_progress' THEN NULL
          WHEN context.duration_review_reason IS NOT NULL
            AND ${durationDecisionBasis}::text IS NULL
            THEN CASE context.duration_review_reason
              WHEN 'clock_skew' THEN
                'The recorded start time is later than the server clock. Keep active time unknown or correct the source time before finishing.'
              ELSE
                'This workout may include an interruption. Review its active duration before finishing.'
            END
          WHEN context.duration_review_reason IS NOT NULL
            AND ${durationDecisionBasis}::text = 'wall_clock_no_stale_signal'
            THEN
              'The recorded elapsed time includes a possible interruption. Report active time or keep it unknown.'
          WHEN ${durationDecisionBasis}::text = 'owner_reported'
            AND (
              NOT ${ownerReportedDurationInputValid}::boolean
              OR ${ownerReportedDurationSeconds}::integer IS NULL
              OR ${ownerReportedDurationSeconds}::integer >
                context.wall_clock_elapsed_seconds
            )
            THEN
              'Active duration must be a whole number of seconds no longer than the recorded elapsed time.'
          WHEN ${durationDecisionBasis}::text IS NOT NULL
            AND ${durationDecisionBasis}::text NOT IN (
              'wall_clock_no_stale_signal',
              'owner_reported',
              'interruption_unknown'
            )
            THEN 'The active-duration review choice is not supported.'
          ELSE NULL
        END AS duration_rejection_reason
      FROM duration_context context
    ), duration_resolution AS MATERIALIZED (
      SELECT
        validated.*,
        CASE WHEN validated.status = 'in_progress'
          AND validated.duration_rejection_code IS NULL
          THEN 1 ELSE NULL END AS resolved_active_duration_semantics_version,
        CASE
          WHEN validated.status <> 'in_progress'
            OR validated.duration_rejection_code IS NOT NULL THEN NULL
          WHEN ${durationDecisionBasis}::text = 'interruption_unknown' THEN NULL
          WHEN ${durationDecisionBasis}::text = 'owner_reported'
            THEN ${ownerReportedDurationSeconds}::integer
          ELSE validated.wall_clock_elapsed_seconds
        END AS resolved_active_duration_seconds,
        CASE
          WHEN validated.status <> 'in_progress'
            OR validated.duration_rejection_code IS NOT NULL THEN NULL
          WHEN ${durationDecisionBasis}::text = 'interruption_unknown'
            THEN 'interruption_unknown'
          WHEN ${durationDecisionBasis}::text = 'owner_reported'
            THEN 'owner_reported'
          ELSE 'wall_clock_no_stale_signal'
        END AS resolved_active_duration_basis
      FROM duration_validation validated
    ), transitioned AS (
      UPDATE workout_sessions ws
      SET status = 'completed',
          finished_at = ${finishedAt.toISOString()}::timestamptz,
          active_duration_semantics_version =
            resolved.resolved_active_duration_semantics_version,
          active_duration_seconds = resolved.resolved_active_duration_seconds,
          active_duration_basis = resolved.resolved_active_duration_basis,
          exclude_duration_from_analytics =
            resolved.exclude_duration_from_analytics OR
            resolved.resolved_active_duration_seconds IS NULL OR
            resolved.resolved_active_duration_seconds >
              ${MAX_ANALYTICS_WORKOUT_DURATION_MINUTES * 60},
          data_quality_flags =
            (
              resolved.data_quality_flags
                - ${LONG_WORKOUT_DURATION_FLAG}
                - ${LONG_WORKOUT_ELAPSED_FLAG}
                - ${UNKNOWN_ACTIVE_WORKOUT_DURATION_FLAG}
            ) ||
            CASE WHEN resolved.wall_clock_elapsed_seconds >
              ${ACTIVE_WORKOUT_REVIEW_THRESHOLD_SECONDS}
              THEN jsonb_build_array(${LONG_WORKOUT_ELAPSED_FLAG}::text)
              ELSE '[]'::jsonb END ||
            CASE WHEN resolved.resolved_active_duration_seconds IS NULL
              THEN jsonb_build_array(${UNKNOWN_ACTIVE_WORKOUT_DURATION_FLAG}::text)
              ELSE '[]'::jsonb END ||
            CASE WHEN resolved.resolved_active_duration_seconds >
              ${MAX_ANALYTICS_WORKOUT_DURATION_MINUTES * 60}
              THEN jsonb_build_array(${LONG_WORKOUT_DURATION_FLAG}::text)
              ELSE '[]'::jsonb END
      FROM duration_resolution resolved
      WHERE ws.id = resolved.id
        AND resolved.status = 'in_progress'
        AND resolved.duration_rejection_code IS NULL
      RETURNING ws.*
    ), completed_scheduled_event AS (
      UPDATE scheduled_program_events event
      SET status = 'completed',
          revision = event.revision + 1,
          resolved_at = ${finishedAt.toISOString()}::timestamptz,
          updated_at = statement_timestamp()
      FROM transitioned session
      WHERE session.program_schedule_snapshot IS NOT NULL
        AND event.id =
          (session.program_schedule_snapshot->>'scheduledProgramEventId')::uuid
        AND event.user_id = ${user.id}::uuid
        AND event.program_id = session.source_program_id
        AND event.schedule_id =
          (session.program_schedule_snapshot->>'programScheduleId')::uuid
        AND event.schedule_version_id =
          (session.program_schedule_snapshot->>'programScheduleVersionId')::uuid
        AND event.source_program_version_id =
          (session.program_schedule_snapshot->>'scheduleSourceProgramVersionId')::uuid
        AND event.source_event_id =
          (session.program_schedule_snapshot->>'sourceEventId')::uuid
        AND event.routine_lineage_id = session.source_day_lineage_id
        AND event.routine_lineage_id =
          (session.program_schedule_snapshot->>'routineLineageId')::uuid
        AND event.kind = 'resistance'
        AND event.status = 'started'
        AND event.revision =
          (session.program_schedule_snapshot->>'eventRevision')::integer + 1
      RETURNING event.id
    ), abandoned_occurrences AS (
      UPDATE session_occurrences occurrence
      SET outcome = 'abandoned',
          outcome_reason = 'finished_early',
          revision = occurrence.revision + 1,
          resolved_at = ${finishedAt.toISOString()}::timestamptz
      FROM transitioned
      WHERE occurrence.session_id = transitioned.id
        AND occurrence.outcome = 'pending'
      RETURNING occurrence.id, occurrence.revision - 1 AS expected_revision,
                occurrence.revision AS resulting_revision
    ), occurrence_receipts AS (
      INSERT INTO session_occurrence_mutations (
        occurrence_id, client_key, operation, canonical_payload_hash,
        expected_revision, resulting_revision, result_code
      )
      SELECT occurrence.id, 'finish:' || ${input.sessionId} || ':' || occurrence.id,
             'abandon', ${finishMutationHash}, occurrence.expected_revision,
             occurrence.resulting_revision, 'applied'
      FROM abandoned_occurrences occurrence
      ON CONFLICT (occurrence_id, client_key) DO NOTHING
      RETURNING id
    ), recorded_note AS (
      INSERT INTO session_notes (session_id, text)
      SELECT id, ${note}
      FROM transitioned
      WHERE ${note}::text IS NOT NULL
      RETURNING id
    ), recorded_fatigue AS (
      INSERT INTO fatigue_logs (user_id, session_id, severity)
      SELECT ${user.id}::uuid, id, ${input.fatigue ?? null}::integer
      FROM transitioned
      WHERE ${input.fatigue ?? null}::integer IS NOT NULL
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${user.id}::uuid,
        'user',
        'session.complete',
        'workout_session',
        transitioned.id::text,
        'Completed ' || coalesce(transitioned.template_name, 'workout'),
        jsonb_build_object(
          'activeDurationSemanticsVersion',
            transitioned.active_duration_semantics_version,
          'activeDurationSeconds', transitioned.active_duration_seconds,
          'activeDurationBasis', transitioned.active_duration_basis,
          'wallClockElapsedSeconds', wall_clock.wall_clock_elapsed_seconds
        )
      FROM transitioned
      JOIN duration_resolution wall_clock ON wall_clock.id = transitioned.id
      RETURNING id
    ), reconciled_progression AS (
      UPDATE recommendations recommendation
      SET status = 'expired',
          reconciled_at = statement_timestamp(),
          reconciliation_reason =
            'A newer completed workout changed this exercise lineage history, so the earlier suggestion was superseded.'
      WHERE recommendation.user_id = ${user.id}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
        AND recommendation.source_slot_lineage_id IN (
          SELECT DISTINCT exercise.source_slot_lineage_id
          FROM transitioned session
          JOIN session_exercises exercise ON exercise.session_id = session.id
          WHERE exercise.source_slot_lineage_id IS NOT NULL
        )
      RETURNING recommendation.id
    ), queued_progression AS (
      INSERT INTO progression_jobs (
        id, user_id, session_id, source_session_revision,
        coaching_prefs, next_attempt_at
      )
      SELECT
        ${progressionJobId}::uuid,
        ${user.id}::uuid,
        id,
        history_revision,
        ${JSON.stringify(user.coachingPrefs)}::jsonb,
        ${finishedAt.toISOString()}::timestamptz
      FROM transitioned
      ON CONFLICT (session_id, source_session_revision)
      DO UPDATE SET coaching_prefs = progression_jobs.coaching_prefs
      RETURNING id
    )
    SELECT
      resolved.id,
      resolved.status,
      EXISTS (SELECT 1 FROM transitioned) AS transitioned,
      resolved.duration_rejection_code,
      resolved.duration_rejection_reason,
      resolved.wall_clock_elapsed_seconds,
      (resolved.duration_review_reason IS NOT NULL) AS duration_review_required,
      coalesce(
        (SELECT id FROM queued_progression),
        (
          SELECT id
          FROM progression_jobs job
          WHERE job.session_id = resolved.id
            AND job.source_session_revision = resolved.history_revision
        )
      ) AS progression_job_id
    FROM duration_resolution resolved
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) throw new Error("Session not found");
  await checkpoint("after-completion-statement");
  if (row.duration_rejection_code) {
    return {
      outcome: String(row.duration_rejection_code) as
        | "duration_review_required"
        | "invalid_duration_review",
      sessionId: input.sessionId,
      alreadyFinished: false,
      progressionJobId: null,
      wallClockElapsedSeconds: Number(row.wall_clock_elapsed_seconds),
      reviewRequired: Boolean(row.duration_review_required),
      reason: String(row.duration_rejection_reason),
    } as const;
  }
  return {
    outcome: Boolean(row.transitioned) ? "completed" : "already_finished",
    sessionId: String(row.id),
    alreadyFinished: !Boolean(row.transitioned),
    progressionJobId: row.progression_job_id
      ? String(row.progression_job_id)
      : null,
  } as const;
}

export async function abandonWorkoutSession(
  db: Db,
  userId: string,
  sessionId: string,
  dependencies: SessionLifecycleDependencies = {}
) {
  const checkpoint = dependencies.checkpoint ?? noCheckpoint;
  const finishedAt = (dependencies.now ?? (() => new Date()))();
  const abandonMutationHash = createHash("sha256")
    .update(JSON.stringify({ operation: "abandon", reason: "workout_abandoned" }))
    .digest("hex");
  await checkpoint("before-abandon-statement");
  const query = sql`
    WITH owned AS MATERIALIZED (
      SELECT ws.*
      FROM workout_sessions ws
      WHERE ws.id = ${sessionId}::uuid
        AND ws.user_id = ${userId}::uuid
        AND ws.archived_at IS NULL
      FOR UPDATE
    ), transitioned AS (
      UPDATE workout_sessions ws
      SET status = 'abandoned',
          finished_at = ${finishedAt.toISOString()}::timestamptz
      FROM owned
      WHERE ws.id = owned.id
        AND owned.status = 'in_progress'
      RETURNING ws.*
    ), abandoned_scheduled_event AS (
      UPDATE scheduled_program_events event
      SET status = 'abandoned',
          revision = event.revision + 1,
          resolved_at = ${finishedAt.toISOString()}::timestamptz,
          updated_at = statement_timestamp()
      FROM transitioned session
      WHERE session.program_schedule_snapshot IS NOT NULL
        AND event.id =
          (session.program_schedule_snapshot->>'scheduledProgramEventId')::uuid
        AND event.user_id = ${userId}::uuid
        AND event.program_id = session.source_program_id
        AND event.schedule_id =
          (session.program_schedule_snapshot->>'programScheduleId')::uuid
        AND event.schedule_version_id =
          (session.program_schedule_snapshot->>'programScheduleVersionId')::uuid
        AND event.source_program_version_id =
          (session.program_schedule_snapshot->>'scheduleSourceProgramVersionId')::uuid
        AND event.source_event_id =
          (session.program_schedule_snapshot->>'sourceEventId')::uuid
        AND event.routine_lineage_id = session.source_day_lineage_id
        AND event.routine_lineage_id =
          (session.program_schedule_snapshot->>'routineLineageId')::uuid
        AND event.kind = 'resistance'
        AND event.status = 'started'
        AND event.revision =
          (session.program_schedule_snapshot->>'eventRevision')::integer + 1
      RETURNING event.id
    ), abandoned_occurrences AS (
      UPDATE session_occurrences occurrence
      SET outcome = 'abandoned',
          outcome_reason = 'workout_abandoned',
          revision = occurrence.revision + 1,
          resolved_at = ${finishedAt.toISOString()}::timestamptz
      FROM transitioned
      WHERE occurrence.session_id = transitioned.id
        AND occurrence.outcome = 'pending'
      RETURNING occurrence.id, occurrence.revision - 1 AS expected_revision,
                occurrence.revision AS resulting_revision
    ), occurrence_receipts AS (
      INSERT INTO session_occurrence_mutations (
        occurrence_id, client_key, operation, canonical_payload_hash,
        expected_revision, resulting_revision, result_code
      )
      SELECT occurrence.id, 'abandon:' || ${sessionId} || ':' || occurrence.id,
             'abandon', ${abandonMutationHash}, occurrence.expected_revision,
             occurrence.resulting_revision, 'applied'
      FROM abandoned_occurrences occurrence
      ON CONFLICT (occurrence_id, client_key) DO NOTHING
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary
      )
      SELECT
        ${userId}::uuid,
        'user',
        'session.abandon',
        'workout_session',
        id::text,
        'Abandoned ' || coalesce(template_name, 'workout')
      FROM transitioned
      RETURNING id
    )
    SELECT
      owned.id,
      coalesce(
        (SELECT transitioned.status FROM transitioned LIMIT 1),
        owned.status
      ) AS status,
      EXISTS (SELECT 1 FROM transitioned) AS transitioned
    FROM owned
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) throw new Error("Session not found");
  await checkpoint("after-abandon-statement");
  return {
    sessionId: String(row.id),
    alreadyFinished: !Boolean(row.transitioned),
    status: String(row.status) as "in_progress" | "completed" | "abandoned",
  };
}

export async function logWorkoutPain(
  db: Db,
  userId: string,
  input: {
    sessionExerciseId: string;
    bodyPart: string;
    severity: number;
    note?: string | null;
  }
) {
  const painId = randomUUID();
  const query = sql`
    WITH owned AS MATERIALIZED (
      SELECT se.id, se.session_id, se.exercise_id
      FROM session_exercises se
      JOIN workout_sessions ws ON ws.id = se.session_id
      WHERE se.id = ${input.sessionExerciseId}::uuid
        AND ws.user_id = ${userId}::uuid
        AND ws.status = 'in_progress'
        AND ws.archived_at IS NULL
      FOR UPDATE OF ws
    ), inserted AS (
      INSERT INTO pain_logs (
        id, user_id, session_id, exercise_id, body_part, severity, source, note
      )
      SELECT
        ${painId}::uuid,
        ${userId}::uuid,
        owned.session_id,
        owned.exercise_id,
        ${input.bodyPart},
        ${input.severity},
        'set_flag',
        ${input.note ?? null}
      FROM owned
      RETURNING id
    )
    SELECT id FROM inserted
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row) throw new Error("Only an active workout can record pain.");
  return { painId: String(row.id) };
}
