import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { analysisPackageManifests, users } from "@/db/schema";
import {
  ANALYSIS_PACKAGE_CANONICALIZATION_VERSION,
  ANALYSIS_PACKAGE_FORMAT,
  ANALYSIS_PACKAGE_MAX_BYTES,
  ANALYSIS_PACKAGE_RETENTION_DAYS,
  ANALYSIS_PACKAGE_SCHEMA_VERSION,
  ANALYSIS_PACKAGE_SEMANTIC_VERSION,
  ANALYSIS_QUESTIONS,
  analysisPackageCoreSchema,
  analysisPackageSchema,
  type AnalysisPackage,
  type AnalysisPackageCore,
  type AnalysisPackageManifestSummary,
  type AnalysisPackageRequest,
  type AnalysisPackageSourceBindingEntity,
  type JsonValue,
} from "@/lib/analysis-package";
import {
  captureUserSnapshot,
  type CanonicalSnapshotPayload,
} from "@/services/snapshot-capture";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import { classifyHistoryProvenance } from "@/lib/history-workout-evidence";

type SnapshotRow = Record<string, unknown>;
type FactClass =
  | "recorded"
  | "imported"
  | "corrected"
  | "calculated"
  | "unknown";

type AnalysisScopePolicy = {
  includeConstraints: boolean;
  includeEquipment: boolean;
  includeProgramDetails: boolean;
  includeWorkoutDetails: boolean;
  includeRecoveryContext: boolean;
  includeIndependentActivities: boolean;
  includeRecommendationState: boolean;
};

const ANALYSIS_SCOPE_POLICIES: Record<
  AnalysisPackageRequest["questionId"],
  AnalysisScopePolicy
> = {
  program_progress: {
    includeConstraints: true,
    includeEquipment: true,
    includeProgramDetails: true,
    includeWorkoutDetails: true,
    includeRecoveryContext: true,
    includeIndependentActivities: false,
    includeRecommendationState: true,
  },
  recovery_constraints: {
    includeConstraints: true,
    includeEquipment: false,
    includeProgramDetails: true,
    includeWorkoutDetails: true,
    includeRecoveryContext: true,
    includeIndependentActivities: true,
    includeRecommendationState: true,
  },
  training_consistency: {
    includeConstraints: false,
    includeEquipment: false,
    includeProgramDetails: false,
    includeWorkoutDetails: false,
    includeRecoveryContext: false,
    includeIndependentActivities: true,
    includeRecommendationState: false,
  },
};

export class AnalysisPackageTooLargeError extends Error {
  constructor() {
    super(
      "This package is too large to preview safely. Choose a shorter evidence window.",
    );
    this.name = "AnalysisPackageTooLargeError";
  }
}

function table(payload: CanonicalSnapshotPayload, name: string): SnapshotRow[] {
  const value = payload.tables[name];
  if (!Array.isArray(value)) {
    throw new Error(`Analysis source ${name} is unavailable.`);
  }
  return value as SnapshotRow[];
}

function text(row: SnapshotRow, key: string): string | null {
  return typeof row[key] === "string" ? row[key] : null;
}

function number(row: SnapshotRow, key: string): number | null {
  return typeof row[key] === "number" && Number.isFinite(row[key])
    ? row[key]
    : null;
}

function id(row: SnapshotRow): string {
  const value = text(row, "id");
  if (!value) throw new Error("Analysis source row is missing its stable id.");
  return value;
}

function active(row: SnapshotRow): boolean {
  return row.archived_at == null;
}

function inWindow(
  row: SnapshotRow,
  key: string,
  start: Date,
  cutoff: Date,
): boolean {
  const value = text(row, key);
  if (!value) return false;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) && at >= start && at <= cutoff;
}

function asJson(value: unknown): JsonValue {
  if (value == null || typeof value === "string" || typeof value === "boolean") {
    return value ?? null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Analysis source has a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(asJson);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, asJson(item)]),
    );
  }
  return null;
}

function values(row: SnapshotRow, fields: readonly string[]) {
  return Object.fromEntries(fields.map((field) => [field, asJson(row[field])]));
}

function fact(input: {
  row: SnapshotRow;
  factClass?: FactClass;
  quality: string;
  source: string;
  revision?: number | null;
  fields: readonly string[];
}) {
  return {
    id: id(input.row),
    factClass: input.factClass ?? "recorded",
    evidenceQuality: input.quality,
    source: input.source,
    revision: input.revision ?? null,
    values: values(input.row, input.fields),
  };
}

function byId<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function ids(rows: SnapshotRow[]): Set<string> {
  return new Set(rows.map(id));
}

function binding(
  entity: AnalysisPackageSourceBindingEntity,
  rows: SnapshotRow[],
  revisionKey?: string,
) {
  const sorted = [...rows].sort((left, right) => id(left).localeCompare(id(right)));
  const revisions = revisionKey
    ? sorted.flatMap((row) => {
        const revision = number(row, revisionKey);
        return revision == null ? [] : [{ id: id(row), revision }];
      })
    : undefined;
  return {
    entity,
    ids: sorted.map(id),
    ...(revisions && revisions.length > 0 ? { revisions } : {}),
  };
}

export function analysisSourceRowContentHash(
  entity: AnalysisPackageSourceBindingEntity,
  row: unknown,
): string {
  const normalized =
    entity === "programs" && row && typeof row === "object" && !Array.isArray(row)
      ? Object.fromEntries(
          Object.entries(row as Record<string, unknown>).filter(
            ([key]) => key !== "recommendation_revision",
          ),
        )
      : row;
  return sha256Hex(Buffer.from(canonicalJson(normalized), "utf8"));
}

export type AnalysisSourceBindingState = {
  entity: AnalysisPackageSourceBindingEntity;
  id: string;
  versionToken: string;
  contentHash: string;
};

export async function loadAnalysisSourceBindingState(
  db: Db,
  bindings: Array<{
    entity: AnalysisPackageSourceBindingEntity;
    ids: string[];
  }>,
): Promise<AnalysisSourceBindingState[]> {
  if (bindings.length === 0) return [];
  const selects = bindings.map((sourceBinding) => sql`
    SELECT ${sourceBinding.entity}::text AS entity,
           source.id::text AS id,
           source.xmin::text AS version_token,
           to_jsonb(source) AS source_row
    FROM ${sql.raw(`"${sourceBinding.entity}"`)} source
    WHERE source.id IN (
      SELECT value::uuid
      FROM jsonb_array_elements_text(${JSON.stringify(sourceBinding.ids)}::jsonb)
    )
  `);
  const loaded = resultRows(await db.execute(
    sql.join(selects, sql` UNION ALL `),
  )) as Array<Record<string, unknown>>;
  return loaded.map((row) => ({
    entity: row.entity as AnalysisPackageSourceBindingEntity,
    id: String(row.id),
    versionToken: String(row.version_token),
    contentHash: analysisSourceRowContentHash(
      row.entity as AnalysisPackageSourceBindingEntity,
      row.source_row,
    ),
  }));
}

export function analysisPackageOwnerNamespace(userId: string): string {
  return `repbook-owner/${createHash("sha256")
    .update(`repbook-analysis-owner:${userId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export async function loadAnalysisEvidenceRevision(
  db: Db,
  userId: string,
): Promise<string> {
  const row = await db.query.users.findFirst({
    columns: { analysisEvidenceRevision: true },
    where: eq(users.id, userId),
  });
  if (!row) throw new Error("Analysis package owner was not found.");
  return String(row.analysisEvidenceRevision);
}

function exerciseIdentityScope(row: SnapshotRow, userId: string) {
  const ownerId = text(row, "user_id");
  if (ownerId == null) return "shared";
  if (ownerId !== userId) return "unknown";
  return row.created_from_import_event_id == null
    ? "owner_created"
    : "import_created";
}

function sessionProvenanceFactClass(row: SnapshotRow): FactClass {
  const provenance = classifyHistoryProvenance({
    source: text(row, "source") ?? "unknown",
    importBatchId: text(row, "import_batch_id"),
  });
  if (provenance === "imported") return "imported";
  if (provenance === "native" || provenance === "manual") return "recorded";
  return "unknown";
}

function sessionFactClass(row: SnapshotRow): FactClass {
  if ((number(row, "history_revision") ?? 0) > 0) return "corrected";
  return sessionProvenanceFactClass(row);
}

function childFactClass(
  row: SnapshotRow,
  session: SnapshotRow | null,
  correctedEntityIds: Set<string>,
): FactClass {
  if (correctedEntityIds.has(id(row))) return "corrected";
  return session ? sessionProvenanceFactClass(session) : "unknown";
}

function buildCore(input: {
  snapshot: CanonicalSnapshotPayload;
  userId: string;
  request: AnalysisPackageRequest;
  now: Date;
  packageId: string;
}): AnalysisPackageCore {
  const { snapshot, userId, request, now, packageId } = input;
  const cutoff = new Date(now);
  const windowStart = new Date(
    cutoff.getTime() - request.windowDays * 24 * 60 * 60 * 1000,
  );
  const expiresAt = new Date(
    now.getTime() + ANALYSIS_PACKAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const question = ANALYSIS_QUESTIONS[request.questionId];
  const policy = ANALYSIS_SCOPE_POLICIES[request.questionId];
  const profileFields = policy.includeWorkoutDetails
    ? ["age_range", "experience", "goals", "session_length_min", "weekly_frequency", "unit", "timezone", "coaching_prefs"] as const
    : ["goals", "session_length_min", "weekly_frequency", "timezone"] as const;
  const programVersionFields = policy.includeProgramDetails
    ? ["program_id", "version_no", "name", "parent_version_id", "restored_from_version_id", "publication_source", "change_summary", "document_schema_version", "activated_at"] as const
    : ["program_id", "version_no", "name", "publication_source", "activated_at"] as const;
  const programDayFields = policy.includeProgramDetails
    ? ["program_version_id", "lineage_id", "name", "order_idx", "notes", "warmup_notes", "warmup_items", "intent"] as const
    : ["program_version_id", "lineage_id", "name", "order_idx"] as const;
  const workoutFields = policy.includeWorkoutDetails
    ? ["template_id", "template_name", "import_batch_id", "source", "source_workout_key", "history_revision", "performed_time_precision", "source_program_id", "source_program_version_id", "source_day_lineage_id", "data_quality_flags", "exclude_duration_from_analytics", "status", "time_budget_min", "started_at", "timezone", "local_date", "finished_at"] as const
    : ["template_name", "import_batch_id", "source", "history_revision", "performed_time_precision", "source_program_id", "source_program_version_id", "source_day_lineage_id", "data_quality_flags", "exclude_duration_from_analytics", "status", "started_at", "timezone", "local_date", "finished_at"] as const;

  const profileRows = table(snapshot, "user_profiles");
  const profile = profileRows[0] ?? null;
  const timezone = profile ? text(profile, "timezone") : null;
  if (!timezone) {
    throw new Error("A valid owner timezone is required before analysis export.");
  }

  const constraintRows = policy.includeConstraints
    ? table(snapshot, "constraints")
    : [];
  const equipmentRows = policy.includeEquipment
    ? table(snapshot, "equipment_items")
    : [];
  const plateRows = policy.includeEquipment ? table(snapshot, "plate_inventory") : [];
  const barRows = policy.includeEquipment ? table(snapshot, "barbell_configs") : [];
  const plateMachineRows = policy.includeEquipment
    ? table(snapshot, "plate_loaded_machine_profiles")
    : [];
  const cableMachineRows = policy.includeEquipment
    ? table(snapshot, "cable_machine_profiles")
    : [];
  const cableStepRows = policy.includeEquipment
    ? table(snapshot, "cable_stack_steps")
    : [];
  const attachmentRows = policy.includeEquipment
    ? table(snapshot, "cable_attachment_profiles")
    : [];

  const activePrograms = table(snapshot, "programs").filter(
    (row) => active(row) && text(row, "status") === "active",
  );
  if (activePrograms.length > 1) {
    throw new Error("Analysis requires one unambiguous current Program.");
  }
  const program = activePrograms[0] ?? null;
  const currentVersionId = program ? text(program, "current_version_id") : null;
  const programVersion = currentVersionId
    ? table(snapshot, "program_versions").find((row) => id(row) === currentVersionId) ?? null
    : null;
  const programDayRows = programVersion
    ? table(snapshot, "workout_templates").filter(
        (row) => text(row, "program_version_id") === id(programVersion),
      )
    : [];
  const programDayIds = ids(programDayRows);
  const allCurrentSlotRows = table(snapshot, "workout_template_exercises").filter(
    (row) => programDayIds.has(text(row, "workout_template_id") ?? ""),
  );
  const slotRows = policy.includeProgramDetails ? allCurrentSlotRows : [];
  const allCurrentSlotIds = ids(allCurrentSlotRows);
  const allCurrentPrescriptionRows = table(snapshot, "exercise_prescriptions").filter(
    (row) =>
      allCurrentSlotIds.has(text(row, "template_exercise_id") ?? "") &&
      row.superseded_by_id == null,
  );
  const prescriptionRows = policy.includeProgramDetails
    ? allCurrentPrescriptionRows
    : [];

  const sessionRows = table(snapshot, "workout_sessions").filter(
    (row) =>
      active(row) &&
      ["completed", "abandoned"].includes(text(row, "status") ?? "") &&
      inWindow(row, "started_at", windowStart, cutoff),
  );
  const sessionIds = ids(sessionRows);
  const allSessionExerciseRows = table(snapshot, "session_exercises").filter(
    (row) => sessionIds.has(text(row, "session_id") ?? ""),
  );
  const allSessionGroupRows = table(snapshot, "session_exercise_groups").filter(
    (row) => sessionIds.has(text(row, "session_id") ?? ""),
  );
  const allSessionExerciseIds = ids(allSessionExerciseRows);
  const allOccurrenceRows = table(snapshot, "session_occurrences").filter(
    (row) => sessionIds.has(text(row, "session_id") ?? ""),
  );
  const allCompletedSetRows = table(snapshot, "completed_sets").filter(
    (row) =>
      active(row) &&
      allSessionExerciseIds.has(text(row, "session_exercise_id") ?? ""),
  );
  const sessionExerciseRows = policy.includeWorkoutDetails
    ? allSessionExerciseRows
    : [];
  const sessionGroupRows = policy.includeWorkoutDetails ? allSessionGroupRows : [];
  const occurrenceRows = policy.includeWorkoutDetails ? allOccurrenceRows : [];
  const completedSetRows = policy.includeWorkoutDetails ? allCompletedSetRows : [];
  const allPainRows = table(snapshot, "pain_logs").filter(
    (row) => active(row) && inWindow(row, "created_at", windowStart, cutoff),
  );
  const allFatigueRows = table(snapshot, "fatigue_logs").filter(
    (row) => active(row) && inWindow(row, "created_at", windowStart, cutoff),
  );
  const allContextualNoteRows = table(snapshot, "contextual_notes").filter(
    (row) => active(row) && inWindow(row, "recorded_at", windowStart, cutoff),
  );
  const allCoachVisibleNoteRows = allContextualNoteRows.filter(
    (row) =>
      row.coach_visible === true,
  );
  const allWindowActivityRows = table(snapshot, "health_activities").filter(
    (row) =>
      active(row) &&
      inWindow(row, "started_at", windowStart, cutoff),
  );
  const allActivityRows = allWindowActivityRows.filter(
    (row) => row.exclude_from_analytics !== true,
  );
  const painRows = policy.includeRecoveryContext ? allPainRows : [];
  const fatigueRows = policy.includeRecoveryContext ? allFatigueRows : [];
  const noteRows = policy.includeRecoveryContext ? allCoachVisibleNoteRows : [];
  const activityRows = policy.includeIndependentActivities ? allActivityRows : [];

  const allRecommendationRows = table(snapshot, "recommendations").filter(
    (row) =>
      active(row) &&
      (text(row, "status") === "pending" ||
        inWindow(row, "created_at", windowStart, cutoff)),
  );
  const recommendationRows = policy.includeRecommendationState
    ? allRecommendationRows
    : [];
  const recommendationIds = ids(recommendationRows);
  const allRecommendationIds = ids(allRecommendationRows);
  const allDecisionRows = table(snapshot, "user_decisions").filter((row) =>
    allRecommendationIds.has(text(row, "recommendation_id") ?? ""),
  );
  const allAdaptationRows = table(snapshot, "adaptation_events").filter(
    (row) =>
      allRecommendationIds.has(text(row, "recommendation_id") ?? "") ||
      inWindow(row, "applied_at", windowStart, cutoff),
  );
  const decisionRows = policy.includeRecommendationState
    ? allDecisionRows.filter((row) =>
        recommendationIds.has(text(row, "recommendation_id") ?? ""),
      )
    : [];
  const adaptationRows = policy.includeRecommendationState
    ? allAdaptationRows
    : [];

  const selectedEntityIds = new Set([
    ...sessionRows.map(id),
    ...sessionGroupRows.map(id),
    ...sessionExerciseRows.map(id),
    ...completedSetRows.map(id),
    ...occurrenceRows.map(id),
    ...noteRows.map(id),
  ]);
  const correctionRows = table(snapshot, "record_versions").filter((row) =>
    selectedEntityIds.has(text(row, "entity_id") ?? ""),
  );
  const correctedEntityIds = new Set(
    correctionRows.map((row) => text(row, "entity_id")).filter(
      (value): value is string => value != null,
    ),
  );

  const referencedExerciseIds = new Set(
    [
      ...slotRows.flatMap((row) => [text(row, "exercise_id")]),
      ...sessionExerciseRows.flatMap((row) => [
        text(row, "exercise_id"),
        text(row, "substituted_for_exercise_id"),
      ]),
      ...occurrenceRows.flatMap((row) => [text(row, "planned_exercise_id")]),
      ...painRows.flatMap((row) => [text(row, "exercise_id")]),
      ...recommendationRows.flatMap((row) => [text(row, "exercise_id")]),
    ].filter((value): value is string => Boolean(value)),
  );
  const exerciseRows = table(snapshot, "exercises").filter((row) =>
    referencedExerciseIds.has(id(row)),
  );

  const sessionById = new Map(sessionRows.map((row) => [id(row), row]));
  const sessionExerciseById = new Map(
    sessionExerciseRows.map((row) => [id(row), row]),
  );

  const equipmentFacts = [
    ...equipmentRows.map((row) =>
      fact({
        row,
        quality: row.available === true ? "owner_available" : "owner_unavailable",
        source: "equipment_items",
        fields: ["type", "definition_id", "label", "quantity", "attrs", "available"],
      }),
    ),
    ...plateRows.map((row) =>
      fact({ row, quality: "owner_recorded", source: "plate_inventory", fields: ["denomination", "unit", "quantity"] }),
    ),
    ...barRows.map((row) =>
      fact({ row, quality: "owner_recorded", source: "barbell_configs", fields: ["bar_type", "equipment_item_id", "unit", "loading_kind", "shared_plate_pool_compatible", "bar_weight", "collar_weight", "quantity", "label"] }),
    ),
    ...plateMachineRows.map((row) =>
      fact({ row, quality: text(row, "geometry_certainty") ?? "unknown", source: "plate_loaded_machine_profiles", fields: ["equipment_item_id", "geometry_certainty", "starting_resistance", "starting_resistance_unit", "loading_point_count", "balancing_rule", "target_entry_meaning"] }),
    ),
    ...cableMachineRows.map((row) =>
      fact({ row, quality: text(row, "geometry_certainty") ?? "unknown", source: "cable_machine_profiles", fields: ["equipment_item_id", "geometry_certainty", "stack_count", "topology", "displayed_unit", "ratio_status", "ratio_numerator", "ratio_denominator"] }),
    ),
    ...cableStepRows.map((row) =>
      fact({ row, quality: "owner_recorded", source: "cable_stack_steps", fields: ["cable_profile_id", "stack_index", "step_index", "position_label", "displayed_load"] }),
    ),
    ...attachmentRows.map((row) =>
      fact({ row, quality: text(row, "status") ?? "unknown", source: "cable_attachment_profiles", fields: ["equipment_item_id", "attachment_kind", "connection_standard", "status"] }),
    ),
  ];

  const workoutFacts = sessionRows.map((row) =>
    fact({
      row,
      factClass: sessionFactClass(row),
      quality:
        Array.isArray(row.data_quality_flags) && row.data_quality_flags.length > 0
          ? "quality_flags_present"
          : text(row, "performed_time_precision") === "instant"
            ? "retained_instant"
            : "retained_date_only",
      source: text(row, "source") ?? "unknown",
      revision: number(row, "history_revision"),
      fields: workoutFields,
    }),
  );
  const performedExerciseFacts = sessionExerciseRows.map((row) => {
    const session = sessionById.get(text(row, "session_id") ?? "");
    return fact({
      row,
      factClass: childFactClass(row, session ?? null, correctedEntityIds),
      quality:
        row.prescribed_semantics_version == null
          ? "prescribed_semantics_unknown"
          : "prescribed_semantics_retained",
      source: "session_exercises",
      fields: ["session_id", "exercise_id", "source_exercise_key", "source_exercise_name", "prescribed_semantics_version", "prescribed_exercise_name", "prescribed_metric_type", "prescribed_load_type", "prescribed_load_semantics", "planned_from_template_exercise_id", "source_slot_lineage_id", "modification_type", "skip_reason", "substituted_for_exercise_id", "substitution_reason", "order_idx", "superset_key", "group_snapshot_id", "group_member_order_idx", "rest_sec", "target_sets", "target_reps_min", "target_reps_max", "target_load", "target_load_unit"],
    });
  });
  const setFacts = completedSetRows.map((row) => {
    const sessionExercise = sessionExerciseById.get(
      text(row, "session_exercise_id") ?? "",
    );
    const session = sessionExercise
      ? sessionById.get(text(sessionExercise, "session_id") ?? "")
      : null;
    return fact({
      row,
      factClass: childFactClass(row, session ?? null, correctedEntityIds),
      quality:
        row.performed_semantics_version == null
          ? "performed_semantics_unknown"
          : row.observed_completion_quality === "trustworthy"
            ? "retained_trustworthy_completion"
            : text(row, "observed_completion_quality") ?? "unknown",
      source: "completed_sets",
      fields: ["session_exercise_id", "set_no", "weight", "weight_unit", "load_entry_meaning", "reps", "metric_type", "performed_semantics_version", "performed_load_type", "performed_load_semantics", "distance_km", "duration_seconds", "rpe", "rir", "technique_issue", "limitation_cause", "is_warmup", "rest_taken_sec", "note", "exclude_from_analytics", "logged_at", "observed_completed_at", "observed_completion_provenance", "observed_completion_quality"],
    });
  });
  const calculatedMetricFacts = completedSetRows.map((row) =>
    fact({
      row,
      factClass: typeof row.target_met === "boolean" ? "calculated" : "unknown",
      quality:
        typeof row.target_met === "boolean"
          ? "legacy_projection_not_current_calculated_truth"
          : "calculation_unknown",
      source: "completed_sets.target_met",
      fields: ["target_met"],
    }),
  );

  const included = {
    constraints: constraintRows.length,
    equipmentFacts: equipmentFacts.length,
    currentProgramDays: programDayRows.length,
    currentProgramSlots: slotRows.length,
    currentPrescriptions: prescriptionRows.length,
    exerciseIdentities: exerciseRows.length,
    workouts: sessionRows.length,
    workoutGroups: sessionGroupRows.length,
    workoutExercises: sessionExerciseRows.length,
    occurrences: occurrenceRows.length,
    completedSets: completedSetRows.length,
    painLogs: painRows.length,
    fatigueLogs: fatigueRows.length,
    coachVisibleNotes: noteRows.length,
    correctionRecords: correctionRows.length,
    independentActivities: activityRows.length,
    calculatedMetrics: calculatedMetricFacts.length,
    recommendationProposals: recommendationRows.length,
    ownerDecisions: decisionRows.length,
    acceptedAdaptations: adaptationRows.length,
  };

  const sourceBindings = [
    binding("user_profiles", profileRows),
    binding("constraints", constraintRows),
    binding("equipment_items", equipmentRows),
    binding("plate_inventory", plateRows),
    binding("barbell_configs", barRows),
    binding("plate_loaded_machine_profiles", plateMachineRows),
    binding("cable_machine_profiles", cableMachineRows),
    binding("cable_stack_steps", cableStepRows),
    binding("cable_attachment_profiles", attachmentRows),
    binding("programs", program ? [program] : []),
    binding("program_versions", programVersion ? [programVersion] : []),
    binding("workout_templates", programDayRows),
    binding("workout_template_exercises", slotRows),
    binding("exercise_prescriptions", prescriptionRows),
    binding("exercises", exerciseRows),
    binding("workout_sessions", sessionRows, "history_revision"),
    binding("session_exercise_groups", sessionGroupRows),
    binding("session_exercises", sessionExerciseRows),
    binding("session_occurrences", occurrenceRows, "revision"),
    binding("completed_sets", completedSetRows),
    binding("pain_logs", painRows),
    binding("fatigue_logs", fatigueRows),
    binding("contextual_notes", noteRows, "revision"),
    binding("record_versions", correctionRows),
    binding("health_activities", activityRows),
    binding("recommendations", recommendationRows, "review_revision"),
    binding("user_decisions", decisionRows),
    binding("adaptation_events", adaptationRows),
  ].filter((sourceBinding) => sourceBinding.ids.length > 0);

  return {
    format: ANALYSIS_PACKAGE_FORMAT,
    schemaVersion: ANALYSIS_PACKAGE_SCHEMA_VERSION,
    semanticVersion: ANALYSIS_PACKAGE_SEMANTIC_VERSION,
    packageId,
    packageNamespace: analysisPackageOwnerNamespace(userId),
    createdAt: now.toISOString(),
    evidenceCutoff: cutoff.toISOString(),
    expiresAt: expiresAt.toISOString(),
    request: {
      questionId: request.questionId,
      question: question.question,
      purpose: question.purpose,
      windowDays: request.windowDays,
      windowStart: windowStart.toISOString(),
    },
    timeSemantics: {
      timezone,
      localDateRule:
        "Workout local_date is retained with its recorded IANA timezone; timestamps are UTC ISO-8601 instants.",
      cutoffRule:
        "Only records at or before evidenceCutoff and within the selected window are included, except current Program and current recommendation state.",
    },
    definitions: [
      { key: "unknown", meaning: "Missing historical meaning remains unknown and must not be inferred from the current catalog, Program, or equipment." },
      { key: "program_intent", meaning: "Current Program rows are future training intent, not evidence that work was performed." },
      { key: "completed_or_imported_evidence", meaning: "Workout and set rows are retained observations; imported and corrected provenance remains labelled." },
      { key: "calculated_fields", meaning: "Fields such as target_met are derived classifications, not new performed facts." },
      { key: "calculated_metric", meaning: "Calculated or legacy projected values live in their own domain and never become performed evidence; an absent or unsupported calculation remains unknown." },
      { key: "recommendation_proposal", meaning: "A recommendation is proposal-only until an explicit owner decision and, where applicable, an accepted adaptation." },
      { key: "owner_decision", meaning: "Owner decisions remain separate from generated or imported content." },
      { key: "accepted_adaptation", meaning: "An adaptation records an accepted future Program change; it does not rewrite completed history." },
      { key: "independent_activity", meaning: "Independent activities are context only and must not enter strength progression, loaded workload, Program fit, or strength-record calculations." },
      { key: "exercise_identity", meaning: "Shared, owner-created, and import-created identities are explicit. Current catalog metadata is identity context only." },
      { key: "load_units", meaning: "Every numeric load retains its recorded lb or kg unit; null load is not zero." },
      { key: "privacy_scope", meaning: "The package excludes account identity, raw provider/AI payloads, private contextual notes, operational logs, archives, and recovery artifacts." },
    ],
    inventory: {
      included,
      omitted: [
        { category: "account_identity", reason: "Email, account name, authentication, and account timestamps are not needed for the selected question." },
        { category: "raw_ai_and_provider_material", reason: "Raw prompts, provider output, parsed staging payloads, model identifiers, and provider item ids are excluded." },
        { category: "archived_records", reason: "Archived facts are outside this active analysis package and remain preserved in Repbook." },
        { category: "in_progress_workouts", reason: "Active sessions are mutable and are not completed evidence." },
        { category: "private_contextual_notes", reason: "Only notes explicitly marked visible to a coach are included.", count: allContextualNoteRows.filter((row) => row.coach_visible !== true).length },
        { category: "outside_selected_window", reason: "Historical evidence outside the owner-selected time window is omitted." },
        { category: "activity_excluded_from_analysis", reason: "Activities explicitly excluded from analytics are not sent for external analysis.", count: allWindowActivityRows.length - allActivityRows.length },
        { category: "operational_and_recovery_data", reason: "Audit, export, archive, snapshot, recovery, integrity, and package-manifest rows are not analysis facts." },
        { category: "session_equipment_evidence", reason: "Performed session-equipment snapshots remain omitted until their separate semantic preparation is complete; opaque snapshot identifiers are not exported without their definitions.", count: table(snapshot, "session_equipment_snapshots").filter((row) => sessionIds.has(text(row, "session_id") ?? "")).length },
        { category: "raw_package_retention", reason: "Repbook retains only this package's manifest and source bindings for 30 days, not the detailed package." },
        ...(!policy.includeConstraints
          ? [{ category: "owner_constraints", reason: "Owner constraints are not needed for the selected consistency question.", count: table(snapshot, "constraints").length }]
          : []),
        ...(!policy.includeEquipment
          ? [{ category: "equipment_context", reason: "Equipment details are not needed for the selected question.", count: table(snapshot, "equipment_items").length + table(snapshot, "plate_inventory").length + table(snapshot, "barbell_configs").length + table(snapshot, "plate_loaded_machine_profiles").length + table(snapshot, "cable_machine_profiles").length + table(snapshot, "cable_stack_steps").length + table(snapshot, "cable_attachment_profiles").length }]
          : []),
        ...(!policy.includeProgramDetails
          ? [{ category: "program_exercise_details", reason: "Program identity and day cadence are sufficient for the selected consistency question; exercise slots and prescriptions are omitted.", count: allCurrentSlotRows.length + allCurrentPrescriptionRows.length }]
          : []),
        ...(!policy.includeWorkoutDetails
          ? [{ category: "detailed_workout_evidence", reason: "Workout status and retained local timing are sufficient for the selected consistency question; groups, exercises, occurrences, and sets are omitted.", count: allSessionGroupRows.length + allSessionExerciseRows.length + allOccurrenceRows.length + allCompletedSetRows.length }]
          : []),
        ...(!policy.includeRecoveryContext
          ? [{ category: "recovery_health_context", reason: "Pain, fatigue, and coach-visible contextual notes are outside the selected question.", count: allPainRows.length + allFatigueRows.length + allCoachVisibleNoteRows.length }]
          : []),
        ...(!policy.includeIndependentActivities
          ? [{ category: "independent_activity_context", reason: "Independent activities are outside the selected Program-progress question and remain excluded from strength calculations.", count: allActivityRows.length }]
          : []),
        ...(!policy.includeRecommendationState
          ? [{ category: "recommendation_decision_state", reason: "Recommendation, decision, and adaptation state is outside the selected consistency question.", count: allRecommendationRows.length + allDecisionRows.length + allAdaptationRows.length }]
          : []),
      ],
    },
    ownerContext: {
      profile: profile
        ? fact({ row: profile, quality: "owner_recorded", source: "user_profiles", fields: profileFields })
        : null,
      constraints: byId(
        constraintRows.map((row) =>
          fact({ row, quality: "owner_recorded_safety_constraint", source: "constraints", fields: ["body_part", "affected_patterns", "avoid", "cautious", "pain_stop_threshold", "note"] }),
        ),
      ),
      equipment: byId(equipmentFacts),
    },
    currentProgramIntent: {
      program: program
        ? fact({ row: program, quality: "current_program_pointer", source: "programs", revision: number(program, "recommendation_revision"), fields: ["name", "status", "current_version_id", "recommendation_revision"] })
        : null,
      version: programVersion
        ? fact({ row: programVersion, quality: "published_program_version", source: "program_versions", revision: number(programVersion, "version_no"), fields: programVersionFields })
        : null,
      days: byId(programDayRows.map((row) => fact({ row, quality: "published_program_intent", source: "workout_templates", fields: programDayFields }))),
      slots: byId(slotRows.map((row) => fact({ row, quality: "published_program_intent", source: "workout_template_exercises", fields: ["workout_template_id", "exercise_id", "lineage_id", "order_idx", "superset_group_id", "group_member_order_idx", "rest_sec", "notes", "warmup_notes", "warmup_sets", "set_notes", "intent"] }))),
      prescriptions: byId(prescriptionRows.map((row) => fact({ row, quality: "current_program_prescription", source: "exercise_prescriptions", fields: ["template_exercise_id", "sets", "rep_range_min", "rep_range_max", "target_load", "target_load_unit", "progression_rule_id", "effective_from"] }))),
    },
    exerciseIdentities: byId(
      exerciseRows.map((row) => {
        const record = fact({ row, quality: row.catalog_reviewed === true ? "catalog_reviewed" : "identity_unreviewed", source: "exercises", fields: ["family_id", "name", "movement_pattern", "primary_muscles", "secondary_muscles", "is_unilateral", "load_type", "activity_class", "metric_type", "load_semantics", "variant_key", "variant_attributes", "catalog_reviewed", "created_from_import_event_id"] });
        return {
          ...record,
          values: {
            ...record.values,
            identity_scope: exerciseIdentityScope(row, userId),
          },
        };
      }),
    ),
    completedOrImportedEvidence: {
      workouts: byId(workoutFacts),
      groups: byId(sessionGroupRows.map((row) => fact({ row, factClass: childFactClass(row, sessionById.get(text(row, "session_id") ?? "") ?? null, correctedEntityIds), quality: text(row, "provenance") === "legacy" ? "legacy_group_snapshot" : "retained_group_snapshot", source: "session_exercise_groups", fields: ["session_id", "source_group_id", "lineage_id", "provenance", "name", "order_idx", "planned_rounds", "member_count", "rest_between_members_sec", "rest_between_rounds_sec", "snapshot_version"] }))),
      exercises: byId(performedExerciseFacts),
      occurrences: byId(occurrenceRows.map((row) => fact({ row, factClass: childFactClass(row, sessionById.get(text(row, "session_id") ?? "") ?? null, correctedEntityIds), quality: text(row, "origin") === "legacy" ? "legacy_outcome" : "retained_outcome", source: "session_occurrences", revision: number(row, "revision"), fields: ["session_id", "session_exercise_id", "kind", "origin", "sequence_idx", "kind_ordinal", "label", "planned_exercise_id", "planned_reps_min", "planned_reps_max", "planned_load", "planned_load_unit", "planned_load_percent", "planned_load_text", "planned_rest_sec", "group_snapshot_id", "group_round", "group_member_order_idx", "outcome", "outcome_reason", "outcome_note", "revision", "resolved_at", "completed_set_id"] }))),
      sets: byId(setFacts),
      pain: byId(painRows.map((row) => fact({ row, quality: "owner_recorded_pain", source: "pain_logs", fields: ["session_id", "exercise_id", "completed_set_id", "body_part", "severity", "source", "note", "created_at"] }))),
      fatigue: byId(fatigueRows.map((row) => fact({ row, quality: "owner_recorded_fatigue", source: "fatigue_logs", fields: ["session_id", "severity", "note", "created_at"] }))),
      coachVisibleNotes: byId(noteRows.map((row) => fact({ row, quality: "owner_shared_with_coach", source: "contextual_notes", revision: number(row, "revision"), fields: ["body", "coach_visible", "input_mode", "attachment_kind", "session_id", "session_exercise_id", "occurrence_id", "completed_set_id", "program_id", "program_version_id", "workout_template_id", "workout_template_exercise_id", "captured_context", "revision", "recorded_at"] }))),
      correctionEvidence: byId(correctionRows.map((row) => fact({ row, factClass: "corrected", quality: "immutable_correction_metadata", source: "record_versions", fields: ["entity_type", "entity_id", "action", "changed_fields", "source_version_id", "created_at"] }))),
    },
    independentActivityContext: byId(activityRows.map((row) => fact({ row, factClass: text(row, "source") === "manual" ? "recorded" : "imported", quality: "context_only_excluded_from_strength", source: "health_activities", fields: ["activity_type", "title", "started_at", "timezone", "duration_seconds", "distance_km", "average_pace_seconds_per_km", "intensity", "elevation_gain_m", "average_heart_rate_bpm", "energy_kcal", "notes", "source", "original_metrics", "exclude_from_analytics"] }))),
    calculatedMetrics: byId(calculatedMetricFacts),
    recommendationProposals: byId(recommendationRows.map((row) => ({ id: id(row), state: text(row, "status") ?? "unknown", source: text(row, "source") ?? "unknown", values: values(row, ["rule_id", "exercise_id", "source_template_exercise_id", "source_slot_lineage_id", "payload", "reason", "evidence", "review_revision", "defer_revision", "deferred_at", "revisit_on", "defer_reason", "created_at", "decided_at", "reconciled_at", "reconciliation_reason", "reconciled_by_program_version_id"]) }))),
    ownerDecisions: byId(decisionRows.map((row) => ({ id: id(row), state: text(row, "decision") ?? "unknown", source: "explicit_owner_decision", values: values(row, ["recommendation_id", "decision", "edited_payload", "reason", "review_snapshot", "decided_at"]) }))),
    acceptedAdaptations: byId(adaptationRows.map((row) => ({ id: id(row), state: row.undone_at == null ? "accepted" : "undone", source: "accepted_future_adaptation", values: values(row, ["recommendation_id", "before_snapshot", "after_snapshot", "applied_at", "undone_at"]) }))),
    sourceBindings,
  };
}

export function finalizeAnalysisPackage(core: AnalysisPackageCore): {
  package: AnalysisPackage;
  serialized: string;
} {
  const parsedCore = analysisPackageCoreSchema.parse(core);
  const canonicalCore = canonicalJson(parsedCore);
  const digest = sha256Hex(Buffer.from(canonicalCore, "utf8"));
  const packageValue = analysisPackageSchema.parse({
    ...parsedCore,
    integrity: {
      canonicalizationVersion: ANALYSIS_PACKAGE_CANONICALIZATION_VERSION,
      digestAlgorithm: "sha256",
      digest,
    },
  });
  const serialized = `${JSON.stringify(packageValue, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > ANALYSIS_PACKAGE_MAX_BYTES) {
    throw new AnalysisPackageTooLargeError();
  }
  return { package: packageValue, serialized };
}

export function verifyAnalysisPackage(value: unknown): AnalysisPackage {
  const parsed = analysisPackageSchema.parse(value);
  const { integrity, ...core } = parsed;
  const actual = sha256Hex(Buffer.from(canonicalJson(core), "utf8"));
  if (actual !== integrity.digest) {
    throw new Error("Analysis package digest does not match its contents.");
  }
  return parsed;
}

export async function createAnalysisPackage(
  db: Db,
  userId: string,
  request: AnalysisPackageRequest,
  dependencies: { now?: Date; packageId?: string; appVersion?: string } = {},
) {
  const now = dependencies.now ?? new Date();
  const packageId = dependencies.packageId ?? randomUUID();
  const snapshot = await captureUserSnapshot(
    db,
    userId,
    now,
    dependencies.appVersion ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "development",
    { normalizeProgramDrafts: false, retainCoachEvidenceIds: true },
  );
  const firstCore = buildCore({ snapshot, userId, request, now, packageId });
  const sourceState = await loadAnalysisSourceBindingState(
    db,
    firstCore.sourceBindings,
  );
  const sourceEvidenceRevision = await loadAnalysisEvidenceRevision(db, userId);
  const sourceStateById = new Map(
    sourceState.map((item) => [`${item.entity}:${item.id}`, item]),
  );
  const confirmingSnapshot = await captureUserSnapshot(
    db,
    userId,
    now,
    dependencies.appVersion ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "development",
    { normalizeProgramDrafts: false, retainCoachEvidenceIds: true },
  );
  const confirmingCore = buildCore({
    snapshot: confirmingSnapshot,
    userId,
    request,
    now,
    packageId,
  });
  const confirmingSourceEvidenceRevision =
    await loadAnalysisEvidenceRevision(db, userId);
  if (
    canonicalJson(firstCore) !== canonicalJson(confirmingCore) ||
    sourceEvidenceRevision !== confirmingSourceEvidenceRevision
  ) {
    throw new Error(
      "Analysis evidence changed while the package was being prepared. Prepare it again.",
    );
  }
  const finalized = finalizeAnalysisPackage(firstCore);
  const manifestSourceBindings = finalized.package.sourceBindings.map(
    (sourceBinding) => {
      const contentHashes = sourceBinding.ids.map((sourceId) => {
        const current = sourceStateById.get(
          `${sourceBinding.entity}:${sourceId}`,
        );
        if (!current) {
          throw new Error(
            "Analysis evidence changed while the package was being prepared. Prepare it again.",
          );
        }
        return { id: sourceId, hash: current.contentHash };
      });
      const versionTokens = sourceBinding.ids.map((sourceId) => {
        const current = sourceStateById.get(
          `${sourceBinding.entity}:${sourceId}`,
        );
        if (!current) {
          throw new Error(
            "Analysis evidence changed while the package was being prepared. Prepare it again.",
          );
        }
        return { id: sourceId, token: current.versionToken };
      });
      return { ...sourceBinding, contentHashes, versionTokens };
    },
  );
  await db.insert(analysisPackageManifests).values({
    id: packageId,
    userId,
    packageNamespace: finalized.package.packageNamespace,
    schemaVersion: finalized.package.schemaVersion,
    semanticVersion: finalized.package.semanticVersion,
    digestAlgorithm: finalized.package.integrity.digestAlgorithm,
    digest: finalized.package.integrity.digest,
    scope: {
      questionId: request.questionId,
      windowDays: request.windowDays,
      windowStart: finalized.package.request.windowStart,
      evidenceCutoff: finalized.package.evidenceCutoff,
      timezone: finalized.package.timeSemantics.timezone,
      sourceEvidenceRevision,
    },
    inventory: finalized.package.inventory,
    sourceBindings: manifestSourceBindings,
    createdAt: now,
    evidenceCutoff: now,
    expiresAt: new Date(finalized.package.expiresAt),
  });
  return finalized;
}

export async function listAnalysisPackageManifests(
  db: Db,
  userId: string,
  now = new Date(),
): Promise<AnalysisPackageManifestSummary[]> {
  const rows = await db
    .select()
    .from(analysisPackageManifests)
    .where(eq(analysisPackageManifests.userId, userId))
    .orderBy(desc(analysisPackageManifests.createdAt))
    .limit(20);
  return rows.map((row) => ({
    id: row.id,
    schemaVersion: row.schemaVersion,
    semanticVersion: row.semanticVersion,
    questionId: row.scope.questionId,
    windowDays: row.scope.windowDays,
    digest: row.digest,
    createdAt: row.createdAt.toISOString(),
    evidenceCutoff: row.evidenceCutoff.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: row.expiresAt <= now ? "expired" : "active",
  }));
}

export async function deleteAnalysisPackageManifest(
  db: Db,
  userId: string,
  packageId: string,
): Promise<boolean> {
  const rows = await db
    .delete(analysisPackageManifests)
    .where(
      and(
        eq(analysisPackageManifests.id, packageId),
        eq(analysisPackageManifests.userId, userId),
      ),
    )
    .returning({ id: analysisPackageManifests.id });
  return rows.length === 1;
}
