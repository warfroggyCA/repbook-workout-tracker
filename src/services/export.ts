import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import {
  workoutSessions,
  sessionExercises,
  completedSets,
  contextualNotes,
  painLogs,
  fatigueLogs,
  exercises,
  exportEvents,
  healthActivities,
  coachingInsights,
  sessionOccurrences,
  sessionEquipmentSnapshots,
} from "@/db/schema";
import {
  captureUserSnapshot,
  snapshotRecordCounts,
  SNAPSHOT_SCHEMA_VERSION,
  type CanonicalSnapshotPayload,
} from "@/services/snapshot-capture";
import { validateSnapshotPayload } from "@/services/snapshot-restore";
import { workingSetDisplayPosition } from "@/lib/session-occurrences";
import {
  PRESCRIPTION_OUTCOME_ALGORITHM_VERSION,
  classifyPrescriptionOutcome,
  classifySetMetricContainment,
} from "@/lib/set-metric-semantics";

export const BACKUP_SCHEMA_VERSION = SNAPSHOT_SCHEMA_VERSION;
export const USER_HELD_BACKUP_FORMAT = "workout-tracker-canonical-backup";

export type UserHeldJsonBackup = {
  format: typeof USER_HELD_BACKUP_FORMAT;
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  appVersion: string;
  recordCounts: ReturnType<typeof snapshotRecordCounts>;
  canonical: CanonicalSnapshotPayload;
};

export type JsonBackupDependencies = {
  now?: Date;
  appVersion?: string;
};

function csvEscape(value: unknown): string {
  if (value == null) return "";
  const raw = String(value);
  // Spreadsheet applications can execute cells that begin with these characters.
  // Prefixing the value with an apostrophe keeps the exported text visible while
  // forcing the cell to be treated as data rather than a formula.
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [
    headers.join(","),
    ...rows.map((r) => r.map(csvEscape).join(",")),
  ].join("\n");
}

export function sinceDate(weeks: number | null): Date | null {
  return weeks == null
    ? null
    : new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);
}

/** Set-level history — the spreadsheet-friendly core export (plan §16). */
export async function buildSetsCsv(
  db: Db,
  userId: string,
  since: Date | null
): Promise<string> {
  const rows = await db
    .select({
      date: workoutSessions.startedAt,
      timezone: workoutSessions.timezone,
      localDate: workoutSessions.localDate,
      template: workoutSessions.templateName,
      sessionStatus: workoutSessions.status,
      source: workoutSessions.source,
      sourceWorkoutKey: workoutSessions.sourceWorkoutKey,
      importBatchId: workoutSessions.importBatchId,
      historyRevision: workoutSessions.historyRevision,
      performedTimePrecision: workoutSessions.performedTimePrecision,
      sourceProgramId: workoutSessions.sourceProgramId,
      sourceProgramVersionId: workoutSessions.sourceProgramVersionId,
      sourceDayLineageId: workoutSessions.sourceDayLineageId,
      startRequestKey: workoutSessions.startRequestKey,
      startRequestHash: workoutSessions.startRequestHash,
      sessionQualityFlags: workoutSessions.dataQualityFlags,
      durationExcluded: workoutSessions.excludeDurationFromAnalytics,
      compilerProposalId: sql<string | null>`${workoutSessions.compilationSnapshot} ->> 'proposalId'`,
      compilerProposalHash: sql<string | null>`${workoutSessions.compilationSnapshot} ->> 'proposalHash'`,
      compilerProgramVersionId: sql<string | null>`${workoutSessions.compilationSnapshot} #>> '{input,programVersionId}'`,
      compilerDayLineageId: sql<string | null>`${workoutSessions.compilationSnapshot} #>> '{input,day,lineageId}'`,
      exercise: exercises.name,
      plannedExerciseId: sessionExercises.substitutedForExerciseId,
      sourceExerciseName: sessionExercises.sourceExerciseName,
      sourceExerciseKey: sessionExercises.sourceExerciseKey,
      sourceSlotLineageId: sessionExercises.sourceSlotLineageId,
      prescribedSemanticsVersion: sessionExercises.prescribedSemanticsVersion,
      prescribedExerciseName: sessionExercises.prescribedExerciseName,
      prescribedMetricType: sessionExercises.prescribedMetricType,
      prescribedLoadType: sessionExercises.prescribedLoadType,
      prescribedLoadSemantics: sessionExercises.prescribedLoadSemantics,
      exerciseOrder: sessionExercises.orderIdx,
      supersetKey: sessionExercises.supersetKey,
      modification: sessionExercises.modificationType,
      skipReason: sessionExercises.skipReason,
      substitutionReason: sessionExercises.substitutionReason,
      substitutedAt: sessionExercises.substitutedAt,
      setNo: completedSets.setNo,
      weight: completedSets.weight,
      weightUnit: completedSets.weightUnit,
      reps: completedSets.reps,
      metricType: completedSets.metricType,
      performedSemanticsVersion: completedSets.performedSemanticsVersion,
      performedLoadType: completedSets.performedLoadType,
      performedLoadSemantics: completedSets.performedLoadSemantics,
      distanceKm: completedSets.distanceKm,
      durationSeconds: completedSets.durationSeconds,
      rpe: completedSets.rpe,
      rir: completedSets.rir,
      techniqueIssue: completedSets.techniqueIssue,
      limitationCause: completedSets.limitationCause,
      isWarmup: completedSets.isWarmup,
      targetMet: completedSets.targetMet,
      targetLoad: sessionOccurrences.plannedLoad,
      targetLoadUnit: sessionOccurrences.plannedLoadUnit,
      targetLoadPercent: sessionOccurrences.plannedLoadPercent,
      targetLoadText: sessionOccurrences.plannedLoadText,
      targetRepsMin: sessionOccurrences.plannedRepsMin,
      targetRepsMax: sessionOccurrences.plannedRepsMax,
      note: completedSets.note,
      sourceSetIndex: completedSets.sourceSetIndex,
      sourceRow: completedSets.sourceRow,
      excludedFromAnalytics: completedSets.excludeFromAnalytics,
      loggedAt: completedSets.loggedAt,
      observedCompletedAt: completedSets.observedCompletedAt,
      observedCompletionProvenance: completedSets.observedCompletionProvenance,
      observedCompletionQuality: completedSets.observedCompletionQuality,
      occurrenceId: sessionOccurrences.id,
      occurrenceSessionExerciseId: sessionOccurrences.sessionExerciseId,
      occurrenceKind: sessionOccurrences.kind,
      occurrenceOrigin: sessionOccurrences.origin,
      occurrenceSequence: sessionOccurrences.sequenceIdx,
      occurrenceKindOrdinal: sessionOccurrences.kindOrdinal,
      occurrenceOutcome: sessionOccurrences.outcome,
      occurrenceReason: sessionOccurrences.outcomeReason,
      occurrenceNote: sessionOccurrences.outcomeNote,
      plannedLabel: sessionOccurrences.label,
      occurrencePlannedNote: sessionOccurrences.plannedNote,
      plannedRestSec: sessionOccurrences.plannedRestSec,
      groupSnapshotId: sessionOccurrences.groupSnapshotId,
      groupRound: sessionOccurrences.groupRound,
      groupMemberOrder: sessionOccurrences.groupMemberOrderIdx,
      completedSetId: completedSets.id,
      loadEntryMeaning: completedSets.loadEntryMeaning,
      equipmentSnapshotId: completedSets.equipmentSnapshotId,
      equipmentLabel: sessionEquipmentSnapshots.equipmentLabel,
      equipmentProfileKind: sessionEquipmentSnapshots.profileKind,
      equipmentCertainty: sessionEquipmentSnapshots.geometryCertainty,
      equipmentUnit: sessionEquipmentSnapshots.unit,
      attachmentLabel: sessionEquipmentSnapshots.attachmentLabel,
      equipmentConfigurationHash: sessionEquipmentSnapshots.configurationHash,
      equipmentGeometry: sessionEquipmentSnapshots.geometrySnapshot,
    })
    .from(completedSets)
    .innerJoin(sessionExercises, eq(completedSets.sessionExerciseId, sessionExercises.id))
    .innerJoin(workoutSessions, eq(sessionExercises.sessionId, workoutSessions.id))
    .innerJoin(exercises, eq(sessionExercises.exerciseId, exercises.id))
    .leftJoin(
      sessionOccurrences,
      eq(sessionOccurrences.completedSetId, completedSets.id),
    )
    .leftJoin(
      sessionEquipmentSnapshots,
      eq(sessionEquipmentSnapshots.id, completedSets.equipmentSnapshotId),
    )
    .where(
      and(
        eq(workoutSessions.userId, userId),
        inArray(workoutSessions.status, ["completed", "abandoned"]),
        isNull(workoutSessions.archivedAt),
        isNull(completedSets.archivedAt),
        ...(since ? [gte(workoutSessions.startedAt, since)] : [])
      )
    )
    .orderBy(workoutSessions.startedAt, sessionExercises.orderIdx, completedSets.setNo);

  const occurrenceOnlyRows = await db
    .select({
      date: workoutSessions.startedAt,
      timezone: workoutSessions.timezone,
      localDate: workoutSessions.localDate,
      template: workoutSessions.templateName,
      sessionStatus: workoutSessions.status,
      source: workoutSessions.source,
      sourceWorkoutKey: workoutSessions.sourceWorkoutKey,
      importBatchId: workoutSessions.importBatchId,
      historyRevision: workoutSessions.historyRevision,
      performedTimePrecision: workoutSessions.performedTimePrecision,
      sourceProgramId: workoutSessions.sourceProgramId,
      sourceProgramVersionId: workoutSessions.sourceProgramVersionId,
      sourceDayLineageId: workoutSessions.sourceDayLineageId,
      startRequestKey: workoutSessions.startRequestKey,
      startRequestHash: workoutSessions.startRequestHash,
      sessionQualityFlags: workoutSessions.dataQualityFlags,
      durationExcluded: workoutSessions.excludeDurationFromAnalytics,
      compilerProposalId: sql<string | null>`${workoutSessions.compilationSnapshot} ->> 'proposalId'`,
      compilerProposalHash: sql<string | null>`${workoutSessions.compilationSnapshot} ->> 'proposalHash'`,
      compilerProgramVersionId: sql<string | null>`${workoutSessions.compilationSnapshot} #>> '{input,programVersionId}'`,
      compilerDayLineageId: sql<string | null>`${workoutSessions.compilationSnapshot} #>> '{input,day,lineageId}'`,
      exercise: exercises.name,
      plannedExerciseId: sessionOccurrences.plannedExerciseId,
      sourceExerciseName: sessionExercises.sourceExerciseName,
      sourceExerciseKey: sessionExercises.sourceExerciseKey,
      sourceSlotLineageId: sessionExercises.sourceSlotLineageId,
      prescribedSemanticsVersion: sessionExercises.prescribedSemanticsVersion,
      prescribedExerciseName: sessionExercises.prescribedExerciseName,
      prescribedMetricType: sessionExercises.prescribedMetricType,
      prescribedLoadType: sessionExercises.prescribedLoadType,
      prescribedLoadSemantics: sessionExercises.prescribedLoadSemantics,
      exerciseOrder: sessionExercises.orderIdx,
      supersetKey: sessionExercises.supersetKey,
      modification: sessionExercises.modificationType,
      skipReason: sessionExercises.skipReason,
      substitutionReason: sessionExercises.substitutionReason,
      substitutedAt: sessionExercises.substitutedAt,
      targetLoad: sessionOccurrences.plannedLoad,
      targetLoadUnit: sessionOccurrences.plannedLoadUnit,
      targetLoadPercent: sessionOccurrences.plannedLoadPercent,
      targetLoadText: sessionOccurrences.plannedLoadText,
      targetRepsMin: sessionOccurrences.plannedRepsMin,
      targetRepsMax: sessionOccurrences.plannedRepsMax,
      occurrenceId: sessionOccurrences.id,
      occurrenceSessionExerciseId: sessionOccurrences.sessionExerciseId,
      occurrenceKind: sessionOccurrences.kind,
      occurrenceOrigin: sessionOccurrences.origin,
      occurrenceSequence: sessionOccurrences.sequenceIdx,
      occurrenceKindOrdinal: sessionOccurrences.kindOrdinal,
      occurrenceOutcome: sessionOccurrences.outcome,
      occurrenceReason: sessionOccurrences.outcomeReason,
      occurrenceNote: sessionOccurrences.outcomeNote,
      plannedLabel: sessionOccurrences.label,
      occurrencePlannedNote: sessionOccurrences.plannedNote,
      plannedRestSec: sessionOccurrences.plannedRestSec,
      groupSnapshotId: sessionOccurrences.groupSnapshotId,
      groupRound: sessionOccurrences.groupRound,
      groupMemberOrder: sessionOccurrences.groupMemberOrderIdx,
      equipmentSnapshotId: sessionOccurrences.equipmentSnapshotId,
      equipmentLabel: sessionEquipmentSnapshots.equipmentLabel,
      equipmentProfileKind: sessionEquipmentSnapshots.profileKind,
      equipmentCertainty: sessionEquipmentSnapshots.geometryCertainty,
      equipmentUnit: sessionEquipmentSnapshots.unit,
      attachmentLabel: sessionEquipmentSnapshots.attachmentLabel,
      equipmentConfigurationHash: sessionEquipmentSnapshots.configurationHash,
      equipmentGeometry: sessionEquipmentSnapshots.geometrySnapshot,
    })
    .from(sessionOccurrences)
    .innerJoin(workoutSessions, eq(sessionOccurrences.sessionId, workoutSessions.id))
    .leftJoin(sessionExercises, eq(sessionOccurrences.sessionExerciseId, sessionExercises.id))
    .leftJoin(exercises, eq(sessionExercises.exerciseId, exercises.id))
    .leftJoin(
      sessionEquipmentSnapshots,
      eq(sessionEquipmentSnapshots.id, sessionOccurrences.equipmentSnapshotId),
    )
    .where(and(
      eq(workoutSessions.userId, userId),
      inArray(workoutSessions.status, ["completed", "abandoned"]),
      isNull(workoutSessions.archivedAt),
      isNull(sessionOccurrences.completedSetId),
      ...(since ? [gte(workoutSessions.startedAt, since)] : []),
    ))
    .orderBy(workoutSessions.startedAt, sessionOccurrences.sequenceIdx);

  const plannedExerciseIds = [
    ...new Set(
      [...rows, ...occurrenceOnlyRows]
        .map((row) => row.plannedExerciseId)
        .filter((value): value is string => value != null)
    ),
  ];
  const plannedExercises = plannedExerciseIds.length
    ? await db.query.exercises.findMany({
        where: inArray(exercises.id, plannedExerciseIds),
      })
    : [];
  const plannedExerciseNames = new Map(
    plannedExercises.map((exercise) => [exercise.id, exercise.name])
  );
  const displayOccurrences = [...rows, ...occurrenceOnlyRows].flatMap((row) =>
    row.occurrenceId != null &&
    row.occurrenceKind != null &&
    row.occurrenceOrigin != null &&
    row.occurrenceKindOrdinal != null
      ? [{
          id: row.occurrenceId,
          sessionExerciseId: row.occurrenceSessionExerciseId,
          kind: row.occurrenceKind,
          origin: row.occurrenceOrigin,
          kindOrdinal: row.occurrenceKindOrdinal,
          plannedNote: row.occurrencePlannedNote,
        }]
      : [],
  );
  const occurrenceDisplayLabels = new Map(
    displayOccurrences.map((occurrence) => [
      occurrence.id,
      occurrence.kind === "working_set"
        ? workingSetDisplayPosition(occurrence, displayOccurrences).label
        : null,
    ]),
  );
  const completedOccurrenceRowsBySetId = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.completedSetId == null || row.occurrenceId == null) continue;
    const linked = completedOccurrenceRowsBySetId.get(row.completedSetId) ?? [];
    linked.push(row);
    completedOccurrenceRowsBySetId.set(row.completedSetId, linked);
  }
  const exportedRows = [
    ...rows.map((r) => {
      const semantics = classifySetMetricContainment({
        recordedMetricType: r.metricType,
        prescribedSemanticsVersion: r.prescribedSemanticsVersion,
        performedSemanticsVersion: r.performedSemanticsVersion,
        performedLoadType: r.performedLoadType,
        performedLoadSemantics: r.performedLoadSemantics,
        currentExerciseMetricType: r.prescribedMetricType,
        loadType: r.prescribedLoadType,
        loadSemantics: r.prescribedLoadSemantics,
        loadEntryMeaning: r.loadEntryMeaning,
        weight: r.weight,
        reps: r.reps,
        excludeFromAnalytics: r.excludedFromAnalytics,
      });
      const linkedOccurrenceRows =
        completedOccurrenceRowsBySetId.get(r.completedSetId) ?? [];
      const hasPlannedOccurrence = linkedOccurrenceRows.some(
        (row) => row.occurrenceOrigin === "planned",
      );
      const targetOutcome =
        r.modification !== "as_planned" ||
        r.isWarmup ||
        !hasPlannedOccurrence
          ? null
          : linkedOccurrenceRows.length !== 1 ||
              r.occurrenceOrigin !== "planned" ||
              r.occurrenceKind !== "working_set" ||
              r.occurrenceOutcome !== "completed"
            ? ("unknown" as const)
            : classifyPrescriptionOutcome({
                semantics,
                reps: r.reps,
                weight: r.weight,
                weightUnit: r.weightUnit,
                targetRepsMin: r.targetRepsMin,
                targetRepsMax: r.targetRepsMax,
                targetLoad: r.targetLoad,
                targetLoadUnit: r.targetLoadUnit,
                targetLoadPercent: r.targetLoadPercent,
                targetLoadText: r.targetLoadText,
              });
      return {
      date: r.date,
      sequence: r.occurrenceSequence,
      exerciseOrder: r.exerciseOrder,
      setNo: r.setNo,
      values: [
        r.date.toISOString(), r.timezone, r.localDate, r.template,
        r.sessionStatus, r.source,
        r.sourceWorkoutKey, r.importBatchId,
        r.historyRevision, r.performedTimePrecision, r.sourceProgramId,
        r.sourceProgramVersionId, r.sourceDayLineageId,
        r.startRequestKey, r.startRequestHash,
        r.sessionQualityFlags.join(" | "), r.durationExcluded, r.exercise,
        r.plannedExerciseId
          ? (r.prescribedExerciseName ?? plannedExerciseNames.get(r.plannedExerciseId))
          : null,
        r.compilerProposalId, r.compilerProposalHash, r.compilerProgramVersionId, r.compilerDayLineageId,
        r.sourceExerciseName, r.sourceExerciseKey, r.sourceSlotLineageId,
        r.prescribedSemanticsVersion, r.prescribedExerciseName,
        r.prescribedMetricType, r.prescribedLoadType, r.prescribedLoadSemantics,
        r.exerciseOrder, r.supersetKey,
        r.modification, r.skipReason, r.substitutionReason,
        r.substitutedAt?.toISOString(), r.setNo, r.weight, r.weightUnit, r.reps,
        r.metricType, r.performedSemanticsVersion, r.performedLoadType,
        r.performedLoadSemantics, r.distanceKm, r.durationSeconds, r.rpe,
        r.rir, r.techniqueIssue, r.limitationCause,
        r.isWarmup, r.occurrenceOrigin === "planned" ? r.targetMet : null,
        targetOutcome,
        targetOutcome == null ? null : PRESCRIPTION_OUTCOME_ALGORITHM_VERSION,
        r.occurrenceOrigin === "planned" ? r.targetLoad : null,
        r.occurrenceOrigin === "planned" ? r.targetLoadUnit : null,
        r.occurrenceOrigin === "planned" ? r.targetLoadPercent : null,
        r.occurrenceOrigin === "planned" ? r.targetLoadText : null,
        r.occurrenceOrigin === "planned" ? r.targetRepsMin : null,
        r.occurrenceOrigin === "planned" ? r.targetRepsMax : null,
        r.note, r.sourceSetIndex,
        r.sourceRow, r.excludedFromAnalytics, r.loggedAt.toISOString(),
        r.observedCompletedAt?.toISOString(), r.observedCompletionProvenance,
        r.observedCompletionQuality,
        r.occurrenceId, r.occurrenceKind ?? (r.isWarmup ? "legacy_warmup_result" : "legacy_working_result"),
        r.occurrenceOrigin ?? "legacy", r.occurrenceSequence,
        r.occurrenceKindOrdinal,
        r.occurrenceId ? occurrenceDisplayLabels.get(r.occurrenceId) : null,
        r.occurrenceOutcome ?? "completed",
        r.occurrenceReason, r.occurrenceNote, r.plannedLabel,
        r.occurrencePlannedNote, r.plannedRestSec,
        r.groupSnapshotId, r.groupRound, r.groupMemberOrder, r.completedSetId,
        r.equipmentSnapshotId, r.loadEntryMeaning, r.equipmentLabel,
        r.equipmentProfileKind, r.equipmentCertainty, r.equipmentUnit,
        r.attachmentLabel, r.equipmentConfigurationHash,
        r.equipmentGeometry == null ? null : JSON.stringify(r.equipmentGeometry),
      ],
      };
    }),
    ...occurrenceOnlyRows.map((r) => ({
      date: r.date,
      sequence: r.occurrenceSequence,
      exerciseOrder: r.exerciseOrder,
      setNo: null,
      values: [
        r.date.toISOString(), r.timezone, r.localDate, r.template,
        r.sessionStatus, r.source,
        r.sourceWorkoutKey, r.importBatchId,
        r.historyRevision, r.performedTimePrecision, r.sourceProgramId,
        r.sourceProgramVersionId, r.sourceDayLineageId,
        r.startRequestKey, r.startRequestHash,
        r.sessionQualityFlags.join(" | "), r.durationExcluded, r.exercise,
        r.plannedExerciseId
          ? (r.prescribedExerciseName ?? plannedExerciseNames.get(r.plannedExerciseId))
          : null,
        r.compilerProposalId, r.compilerProposalHash, r.compilerProgramVersionId, r.compilerDayLineageId,
        r.sourceExerciseName, r.sourceExerciseKey, r.sourceSlotLineageId,
        r.prescribedSemanticsVersion, r.prescribedExerciseName,
        r.prescribedMetricType, r.prescribedLoadType, r.prescribedLoadSemantics,
        r.exerciseOrder, r.supersetKey,
        r.modification, r.skipReason, r.substitutionReason, r.substitutedAt?.toISOString(),
        null, null, null, null, null, null, null, null, null, null, null, null,
        null, null, null,
        null,
        null, null,
        r.targetLoad, r.targetLoadUnit, r.targetLoadPercent, r.targetLoadText,
        r.targetRepsMin, r.targetRepsMax, null,
        null, null, null, null, null, null, null,
        r.occurrenceId, r.occurrenceKind, r.occurrenceOrigin, r.occurrenceSequence,
        r.occurrenceKindOrdinal,
        r.occurrenceId ? occurrenceDisplayLabels.get(r.occurrenceId) : null,
        r.occurrenceOutcome, r.occurrenceReason, r.occurrenceNote, r.plannedLabel,
        r.occurrencePlannedNote, r.plannedRestSec, r.groupSnapshotId,
        r.groupRound, r.groupMemberOrder, null,
        r.equipmentSnapshotId, "legacy_unknown", r.equipmentLabel,
        r.equipmentProfileKind, r.equipmentCertainty, r.equipmentUnit,
        r.attachmentLabel, r.equipmentConfigurationHash,
        r.equipmentGeometry == null ? null : JSON.stringify(r.equipmentGeometry),
      ],
    })),
  ].sort((left, right) =>
    left.date.getTime() - right.date.getTime()
    || (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
    || (left.exerciseOrder ?? Number.MAX_SAFE_INTEGER) - (right.exerciseOrder ?? Number.MAX_SAFE_INTEGER)
    || (left.setNo ?? Number.MAX_SAFE_INTEGER) - (right.setNo ?? Number.MAX_SAFE_INTEGER)
  );

  return toCsv(
    [
      "started_at", "timezone", "local_date", "template", "session_status",
      "source", "source_workout_key", "import_batch_id",
      "history_revision", "performed_time_precision", "source_program_id",
      "source_program_version_id", "source_day_lineage_id",
      "start_request_key", "start_request_hash",
      "session_quality_flags", "duration_excluded", "exercise", "planned_exercise",
      "compiler_proposal_id", "compiler_proposal_hash", "compiler_program_version_id", "compiler_day_lineage_id",
      "source_exercise_name", "source_exercise_key", "source_slot_lineage_id",
      "prescribed_semantics_version", "prescribed_exercise_name",
      "prescribed_metric_type", "prescribed_load_type", "prescribed_load_semantics",
      "exercise_order", "superset_key",
      "modification", "skip_reason", "substitution_reason", "substituted_at",
      "set_no", "weight", "weight_unit", "reps",
      "metric_type", "performed_semantics_version", "performed_load_type",
      "performed_load_semantics", "distance_km", "duration_seconds", "rpe",
      "rir", "technique_issue", "limitation_cause", "is_warmup",
      "legacy_target_met_projection", "calculated_target_outcome",
      "target_outcome_algorithm_version", "target_load", "target_load_unit",
      "target_load_percent", "target_load_text", "target_reps_min",
      "target_reps_max", "note",
      "source_set_index", "source_row", "excluded_from_analytics", "logged_at",
      "observed_completed_at", "observed_completion_provenance",
      "observed_completion_quality",
      "occurrence_id", "occurrence_kind", "occurrence_origin", "occurrence_sequence",
      "occurrence_kind_ordinal", "occurrence_display_label", "occurrence_outcome",
      "occurrence_reason", "occurrence_note", "planned_label",
      "occurrence_planned_note", "planned_rest_seconds", "group_snapshot_id",
      "group_round", "group_member_order",
      "completed_set_id",
      "equipment_snapshot_id", "load_entry_meaning", "equipment_label",
      "equipment_profile_kind", "equipment_certainty", "equipment_unit",
      "attachment_label", "equipment_configuration_hash", "equipment_geometry_json",
    ],
    exportedRows.map((row) => row.values)
  );
}

export async function buildPainFatigueCsv(
  db: Db,
  userId: string,
  since: Date | null
): Promise<string> {
  const [pain, fatigue] = await Promise.all([
    db
      .select({
        date: painLogs.createdAt,
        sessionId: painLogs.sessionId,
        completedSetId: painLogs.completedSetId,
        bodyPart: painLogs.bodyPart,
        severity: painLogs.severity,
        source: painLogs.source,
        exercise: exercises.name,
        note: painLogs.note,
      })
      .from(painLogs)
      .leftJoin(exercises, eq(painLogs.exerciseId, exercises.id))
      .leftJoin(workoutSessions, eq(painLogs.sessionId, workoutSessions.id))
      .where(
        and(
          eq(painLogs.userId, userId),
          isNull(painLogs.archivedAt),
          or(isNull(painLogs.sessionId), isNull(workoutSessions.archivedAt)),
          ...(since ? [gte(painLogs.createdAt, since)] : [])
        )
      ),
    db
      .select({
        createdAt: fatigueLogs.createdAt,
        severity: fatigueLogs.severity,
        note: fatigueLogs.note,
      })
      .from(fatigueLogs)
      .leftJoin(workoutSessions, eq(fatigueLogs.sessionId, workoutSessions.id))
      .where(
        and(
          eq(fatigueLogs.userId, userId),
          isNull(fatigueLogs.archivedAt),
          or(
            isNull(fatigueLogs.sessionId),
            isNull(workoutSessions.archivedAt)
          ),
          ...(since ? [gte(fatigueLogs.createdAt, since)] : [])
        )
      ),
  ]);

  return toCsv(
    [
      "date", "kind", "session_id", "completed_set_id", "body_part",
      "severity", "source", "exercise", "note",
    ],
    [
      ...pain.map((p) => [
        p.date.toISOString().slice(0, 10), "pain", p.sessionId,
        p.completedSetId, p.bodyPart, p.severity, p.source, p.exercise, p.note,
      ]),
      ...fatigue.map((f) => [
        f.createdAt.toISOString().slice(0, 10), "fatigue", "", "", "",
        f.severity, "", "", f.note,
      ]),
    ]
  );
}

export async function buildContextualNotesCsv(
  db: Db,
  userId: string,
  since: Date | null
): Promise<string> {
  const rows = await db
    .select({
      id: contextualNotes.id,
      clientKey: contextualNotes.clientKey,
      body: contextualNotes.body,
      coachVisible: contextualNotes.coachVisible,
      inputMode: contextualNotes.inputMode,
      attachmentKind: contextualNotes.attachmentKind,
      sessionId: contextualNotes.sessionId,
      sessionExerciseId: contextualNotes.sessionExerciseId,
      occurrenceId: contextualNotes.occurrenceId,
      completedSetId: contextualNotes.completedSetId,
      programId: contextualNotes.programId,
      programVersionId: contextualNotes.programVersionId,
      workoutTemplateId: contextualNotes.workoutTemplateId,
      workoutTemplateExerciseId: contextualNotes.workoutTemplateExerciseId,
      capturedContext: contextualNotes.capturedContext,
      revision: contextualNotes.revision,
      recordedAt: contextualNotes.recordedAt,
      createdAt: contextualNotes.createdAt,
      updatedAt: contextualNotes.updatedAt,
    })
    .from(contextualNotes)
    .leftJoin(workoutSessions, eq(contextualNotes.sessionId, workoutSessions.id))
    .where(and(
      eq(contextualNotes.userId, userId),
      isNull(contextualNotes.archivedAt),
      or(isNull(contextualNotes.sessionId), isNull(workoutSessions.archivedAt)),
      ...(since ? [gte(contextualNotes.recordedAt, since)] : []),
    ))
    .orderBy(contextualNotes.recordedAt, contextualNotes.id);

  return toCsv(
    [
      "id", "client_key", "recorded_at", "body", "coach_visible",
      "input_mode", "attachment_kind", "workout_id", "workout_exercise_id",
      "occurrence_id", "completed_set_id", "program_id", "program_version_id",
      "program_day_id", "program_item_id", "captured_context_json", "revision",
      "created_at", "updated_at",
    ],
    rows.map((row) => [
      row.id,
      row.clientKey,
      row.recordedAt.toISOString(),
      row.body,
      row.coachVisible,
      row.inputMode,
      row.attachmentKind,
      row.sessionId,
      row.sessionExerciseId,
      row.occurrenceId,
      row.completedSetId,
      row.programId,
      row.programVersionId,
      row.workoutTemplateId,
      row.workoutTemplateExerciseId,
      JSON.stringify(row.capturedContext),
      row.revision,
      row.createdAt.toISOString(),
      row.updatedAt.toISOString(),
    ])
  );
}

export async function buildActivitiesCsv(
  db: Db,
  userId: string,
  since: Date | null
): Promise<string> {
  const rows = await db.query.healthActivities.findMany({
    where: and(
      eq(healthActivities.userId, userId),
      isNull(healthActivities.archivedAt),
      ...(since ? [gte(healthActivities.startedAt, since)] : [])
    ),
    orderBy: healthActivities.startedAt,
  });

  return toCsv(
    [
      "started_at",
      "timezone",
      "activity_type",
      "title",
      "duration_seconds",
      "distance_value",
      "distance_unit",
      "distance_km",
      "average_pace_seconds_per_km",
      "intensity",
      "elevation_value",
      "elevation_unit",
      "elevation_gain_m",
      "average_heart_rate_bpm",
      "energy_kcal",
      "notes",
      "source",
      "source_record_id",
      "fingerprint",
      "excluded_from_analytics",
      "created_at",
      "updated_at",
    ],
    rows.map((row) => [
      row.startedAt.toISOString(),
      row.timezone,
      row.activityType,
      row.title,
      row.durationSeconds,
      row.originalMetrics.distanceValue,
      row.originalMetrics.distanceUnit,
      row.distanceKm,
      row.averagePaceSecondsPerKm,
      row.intensity,
      row.originalMetrics.elevationValue,
      row.originalMetrics.elevationUnit,
      row.elevationGainM,
      row.averageHeartRateBpm,
      row.energyKcal,
      row.notes,
      row.source,
      row.sourceRecordId,
      row.fingerprint,
      row.excludeFromAnalytics,
      row.createdAt.toISOString(),
      row.updatedAt.toISOString(),
    ])
  );
}

export async function buildLiveCoachCsv(
  db: Db,
  userId: string,
  since: Date | null
): Promise<string> {
  type ExportedCoachAnswer = {
    answer?: string;
    evidence?: string[];
    dataGaps?: string[];
    safetyNote?: string | null;
  };
  const rows = await db
    .select({
      createdAt: coachingInsights.createdAt,
      sessionId: workoutSessions.id,
      workout: workoutSessions.templateName,
      exercise: exercises.name,
      author: coachingInsights.author,
      messageKind: coachingInsights.messageKind,
      inputMode: coachingInsights.inputMode,
      responseStatus: coachingInsights.responseStatus,
      content: coachingInsights.contentMd,
      model: coachingInsights.model,
      failureReason: coachingInsights.failureReason,
    })
    .from(coachingInsights)
    .innerJoin(workoutSessions, eq(coachingInsights.sessionId, workoutSessions.id))
    .leftJoin(
      sessionExercises,
      eq(coachingInsights.sessionExerciseId, sessionExercises.id)
    )
    .leftJoin(exercises, eq(sessionExercises.exerciseId, exercises.id))
    .where(
      and(
        eq(coachingInsights.userId, userId),
        inArray(coachingInsights.kind, ["live_user", "live_assistant"]),
        isNull(coachingInsights.archivedAt),
        isNull(workoutSessions.archivedAt),
        ...(since ? [gte(workoutSessions.startedAt, since)] : [])
      )
    )
    .orderBy(coachingInsights.createdAt);

  return toCsv(
    [
      "created_at",
      "workout_id",
      "workout",
      "exercise",
      "author",
      "message_kind",
      "input_mode",
      "response_status",
      "message",
      "answer",
      "evidence",
      "data_gaps",
      "safety_note",
      "model",
      "failure_reason",
    ],
    rows.map((row) => {
      let answer: ExportedCoachAnswer | null = null;
      if (row.author === "assistant" && row.responseStatus === "completed") {
        try {
          answer = JSON.parse(row.content) as ExportedCoachAnswer;
        } catch {
          answer = null;
        }
      }
      return [
        row.createdAt.toISOString(),
        row.sessionId,
        row.workout,
        row.exercise,
        row.author,
        row.messageKind,
        row.inputMode,
        row.responseStatus,
        row.author === "user" ? row.content : "",
        answer?.answer,
        answer?.evidence?.join(" | "),
        answer?.dataGaps?.join(" | "),
        answer?.safetyNote,
        row.model,
        row.failureReason,
      ];
    })
  );
}

/** Full user-held backup: one validated canonical capture plus outer metadata. */
function countsMatch(
  actual: Record<string, number>,
  expected: Record<string, number>
) {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].every((key) => actual[key] === expected[key]);
}

export function validateUserHeldJsonBackup(
  value: unknown,
  userId: string
): UserHeldJsonBackup {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Full backup has an invalid outer format.");
  }
  const backup = value as Partial<UserHeldJsonBackup>;
  if (
    backup.format !== USER_HELD_BACKUP_FORMAT ||
    backup.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    typeof backup.exportedAt !== "string" ||
    typeof backup.appVersion !== "string" ||
    !backup.recordCounts ||
    typeof backup.recordCounts !== "object" ||
    !backup.canonical
  ) {
    throw new Error("Full backup does not match the current backup schema.");
  }
  if (
    backup.canonical.schemaVersion !== backup.schemaVersion ||
    backup.canonical.capturedAt !== backup.exportedAt ||
    backup.canonical.appVersion !== backup.appVersion
  ) {
    throw new Error("Full backup metadata does not match its canonical data.");
  }
  validateSnapshotPayload(backup.canonical, userId);
  if (
    !countsMatch(
      backup.recordCounts as Record<string, number>,
      snapshotRecordCounts(backup.canonical)
    )
  ) {
    throw new Error("Full backup record counts do not match its canonical data.");
  }
  return backup as UserHeldJsonBackup;
}

export async function buildJsonBackup(
  db: Db,
  userId: string,
  checkpoint: (boundary: string) => void | Promise<void> = () => undefined,
  dependencies: JsonBackupDependencies = {}
): Promise<UserHeldJsonBackup> {
  const capturedAt = dependencies.now ?? new Date();
  const appVersion =
    dependencies.appVersion ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.npm_package_version ??
    "development";
  const canonical = await captureUserSnapshot(
    db,
    userId,
    capturedAt,
    appVersion
  );
  // This boundary is after the one-statement capture so a competing writer can
  // prove it cannot leak a later parent or child into the result.
  await checkpoint("backup-captured");
  const backup: UserHeldJsonBackup = {
    format: USER_HELD_BACKUP_FORMAT,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    exportedAt: canonical.capturedAt,
    appVersion: canonical.appVersion,
    recordCounts: snapshotRecordCounts(canonical),
    canonical,
  };
  return validateUserHeldJsonBackup(backup, userId);
}

export async function recordExport(
  db: Db,
  userId: string,
  kind: "csv" | "json" | "markdown",
  filters: Record<string, unknown>
) {
  await db.insert(exportEvents).values({ userId, kind, filters });
}
