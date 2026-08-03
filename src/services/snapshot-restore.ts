import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import {
  captureUserSnapshot,
  normalizeSnapshotProgramDrafts,
  sanitizeSnapshotPrivacy,
  SNAPSHOT_SCHEMA_VERSION,
  type CanonicalSnapshotPayload,
} from "@/services/snapshot-capture";
import {
  createAutomaticSafetySnapshot,
  readVerifiedDataSnapshot,
  type SnapshotDependencies,
} from "@/services/snapshots";
import {
  isValidIanaTimezone,
  workoutLocalDate,
} from "@/lib/workout-calendar";
import { MAX_STORED_LOAD, normalizeStoredLoad } from "@/lib/units";
import {
  hashProgramDocument,
} from "@/services/program-document-hash";
import {
  programDayIntentSchema,
  programSlotIntentSchema,
  normalizeStoredProgramDocumentLoads,
  storedProgramDocumentSchema,
} from "@/lib/program-document";
import { programPreflightResultSchema } from "@/lib/program-preflight";
import { sessionCompilerInputSchema, sessionCompilerOutputSchema } from "@/lib/session-compiler";
import {
  assertCanonicalSnapshotTableCoverage,
  DIRECT_USER_OWNED_CAPTURE_TABLES,
  FULL_RESTORE_MERGE_TABLES,
  FULL_RESTORE_TARGET_TABLES,
  HISTORY_RESTORE_MERGE_TABLES,
  HISTORY_RESTORE_TARGET_TABLES,
  RECOVERY_MANIFEST_BY_TABLE,
} from "@/services/recovery-manifest";
import {
  buildSessionEquipmentConfigurationIdentity,
  sessionEquipmentGeometrySnapshotSchema,
} from "@/lib/session-equipment-snapshot-contract";
import { contextualNoteCapturedContextSchema } from "@/lib/contextual-note-contract";
import {
  PERFORMED_METRIC_TYPES,
  recomputeRestoredTargetMet,
  type PerformedMetricType,
} from "@/lib/set-metric-semantics";
import { analyzeHistoricalSemanticsPayload } from "@/services/historical-semantics-gate";

export type SnapshotRestoreScope = "history" | "full";

const PLATE_QUANTITY_SNAPSHOT_SCHEMA_VERSION = "19";
const PREVIOUS_SNAPSHOT_SCHEMA_VERSION = "20";
const TRAINING_INTENT_SNAPSHOT_SCHEMA_VERSION = "21";
const COMPILER_PROPOSAL_SNAPSHOT_SCHEMA_VERSION = "22";
const OCCURRENCE_SNAPSHOT_SCHEMA_VERSION = "23";
const PRE_CONTEXTUAL_NOTE_SNAPSHOT_SCHEMA_VERSION = "24";
const PRE_HISTORY_IDENTITY_SNAPSHOT_SCHEMA_VERSION = "25";
const PRE_PERFORMED_SEMANTICS_SNAPSHOT_SCHEMA_VERSION = "26";
const PRE_START_SEMANTICS_SNAPSHOT_SCHEMA_VERSION = "27";

type SnapshotRow = Record<string, unknown>;
type RestoreRows = Record<string, SnapshotRow[]>;

function rows(payload: CanonicalSnapshotPayload, table: string): SnapshotRow[] {
  const value = payload.tables[table];
  if (!Array.isArray(value)) throw new Error(`Snapshot table ${table} is missing.`);
  if (value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error(`Snapshot table ${table} contains an invalid row.`);
  }
  return value as SnapshotRow[];
}

function roundLegacyLoad(row: SnapshotRow, key: string) {
  const value = row[key];
  if (value == null) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      "This older snapshot contains an invalid load value. Nothing was restored."
    );
  }
  row[key] = normalizeStoredLoad(value);
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Restores raw observations, then derives the compatibility projection from
 * retained meaning. Legacy rows without that meaning remain explicitly
 * unknown instead of reviving a boolean produced by older logic.
 */
export function reconcileSnapshotCompletedSetOutcomes(
  payload: CanonicalSnapshotPayload,
): CanonicalSnapshotPayload {
  const sessionExercises = new Map(
    rows(payload, "session_exercises").map((row) => [String(row.id), row]),
  );
  const completedOccurrences = new Map<string, SnapshotRow[]>();
  const occurrenceRows = payload.tables.session_occurrences === undefined
    ? []
    : rows(payload, "session_occurrences");
  for (const occurrence of occurrenceRows) {
    if (
      occurrence.kind !== "working_set" ||
      occurrence.outcome !== "completed" ||
      typeof occurrence.completed_set_id !== "string"
    ) {
      continue;
    }
    const linked = completedOccurrences.get(occurrence.completed_set_id) ?? [];
    linked.push(occurrence);
    completedOccurrences.set(occurrence.completed_set_id, linked);
  }
  for (const completed of rows(payload, "completed_sets")) {
    const sessionExercise = sessionExercises.get(
      String(completed.session_exercise_id),
    );
    const metricType = completed.metric_type;
    const linkedOccurrences = completedOccurrences.get(String(completed.id)) ?? [];
    if (
      !sessionExercise ||
      linkedOccurrences.length !== 1 ||
      linkedOccurrences[0]?.origin !== "planned" ||
      typeof metricType !== "string" ||
      !PERFORMED_METRIC_TYPES.includes(metricType as PerformedMetricType)
    ) {
      completed.target_met = null;
      continue;
    }
    const weightUnit =
      completed.weight_unit === "lb" || completed.weight_unit === "kg"
        ? completed.weight_unit
        : null;
    const targetLoadUnit =
      sessionExercise.target_load_unit === "lb" ||
      sessionExercise.target_load_unit === "kg"
        ? sessionExercise.target_load_unit
        : null;
    completed.target_met = recomputeRestoredTargetMet({
      recordedMetricType: metricType as PerformedMetricType,
      performedSemanticsVersion:
        typeof completed.performed_semantics_version === "number"
          ? completed.performed_semantics_version
          : null,
      performedLoadType:
        typeof completed.performed_load_type === "string"
          ? completed.performed_load_type
          : null,
      performedLoadSemantics:
        typeof completed.performed_load_semantics === "string"
          ? completed.performed_load_semantics
          : null,
      loadEntryMeaning:
        typeof completed.load_entry_meaning === "string"
          ? completed.load_entry_meaning
          : null,
      weight: optionalNumber(completed.weight),
      weightUnit,
      reps: optionalNumber(completed.reps),
      targetRepsMin: optionalNumber(sessionExercise.target_reps_min),
      targetLoad: optionalNumber(sessionExercise.target_load),
      targetLoadUnit,
      isWarmup: completed.is_warmup === true,
      modificationType:
        typeof sessionExercise.modification_type === "string"
          ? sessionExercise.modification_type
          : null,
      excludeFromAnalytics: completed.exclude_from_analytics === true,
    });
  }
  return payload;
}

function projectLegacyWarmupText(row: SnapshotRow, textKey: string) {
  const value = row[textKey];
  if (typeof value !== "string" || value.trim().length === 0) return [];
  return [{
    key: String(row.id),
    label: value,
    reps: null,
    load: null,
    loadUnit: null,
    loadPercent: null,
    loadText: null,
    notes: null,
  }];
}

function validateStoredLoad(row: SnapshotRow, key: string, label: string) {
  const value = row[key];
  if (value == null) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_STORED_LOAD
  ) {
    throw new Error(`${label} is outside the supported load range.`);
  }
  if (normalizeStoredLoad(value) !== value) {
    throw new Error(`${label} is not an exact two-decimal load.`);
  }
}

function nullableLoadPair(
  row: SnapshotRow,
  loadKey: string,
  unitKey: string,
  label: string
) {
  const hasLoad = row[loadKey] !== null && row[loadKey] !== undefined;
  const unit = row[unitKey];
  if (hasLoad !== (unit === "lb" || unit === "kg")) {
    throw new Error(`${label} has a load without one explicit unit.`);
  }
}

function validateWarmupSets(row: SnapshotRow, label: string) {
  const warmupSets = row.warmup_sets;
  if (!Array.isArray(warmupSets)) return;
  for (const value of warmupSets) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    nullableLoadPair(
      value as SnapshotRow,
      "load",
      "loadUnit",
      `${label} warm-up set`
    );
  }
}

function validateQuickLogUnits(payload: CanonicalSnapshotPayload) {
  for (const event of rows(payload, "ai_parsing_events")) {
    if (event.scope !== "log") continue;
    const parsed = event.parsed_json as {
      data?: { entries?: Array<{ kind?: string; sets?: SnapshotRow[] }> };
    } | null;
    for (const entry of parsed?.data?.entries ?? []) {
      if (entry.kind !== "sets") continue;
      for (const set of entry.sets ?? []) {
        nullableLoadPair(set, "weight", "weightUnit", "Quick-log parse");
      }
    }
  }
}

function validateSetupUnits(profile: SnapshotRow) {
  const setup = profile.setup_state as {
    routineDraft?: {
      days?: Array<{
        exercises?: Array<
          SnapshotRow & {
            warmup?: { sets?: SnapshotRow[] } | null;
          }
        >;
      }>;
    } | null;
  } | null;
  for (const day of setup?.routineDraft?.days ?? []) {
    for (const exercise of day.exercises ?? []) {
      nullableLoadPair(
        exercise,
        "targetLoad",
        "targetLoadUnit",
        "Saved setup target"
      );
      for (const set of exercise.warmup?.sets ?? []) {
        nullableLoadPair(set, "load", "loadUnit", "Saved setup warm-up set");
      }
    }
  }
}

function validateLoadChangePayload(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const payload = value as SnapshotRow;
  if (
    payload.kind === "load_change" &&
    payload.loadUnit !== "lb" &&
    payload.loadUnit !== "kg"
  ) {
    throw new Error(`${label} is missing its explicit unit.`);
  }
}

function validatePrescriptionSnapshot(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const prescription = (value as SnapshotRow).prescription;
  if (!prescription || typeof prescription !== "object" || Array.isArray(prescription)) {
    return;
  }
  nullableLoadPair(
    prescription as SnapshotRow,
    "targetLoad",
    "targetLoadUnit",
    label
  );
}

function validateUnitAndCalendarIdentity(payload: CanonicalSnapshotPayload) {
  for (const profile of rows(payload, "user_profiles")) {
    if (
      typeof profile.timezone !== "string" ||
      !isValidIanaTimezone(profile.timezone)
    ) {
      throw new Error("Snapshot profile is missing a valid timezone.");
    }
    validateSetupUnits(profile);
  }
  for (const session of rows(payload, "workout_sessions")) {
    const timezone = session.timezone;
    const startedAt = session.started_at;
    if (
      typeof timezone !== "string" ||
      !isValidIanaTimezone(timezone) ||
      typeof startedAt !== "string" ||
      session.local_date !== workoutLocalDate(new Date(startedAt), timezone)
    ) {
      throw new Error("Snapshot workout calendar identity is missing or inconsistent.");
    }
  }
  for (const set of rows(payload, "completed_sets")) {
    nullableLoadPair(set, "weight", "weight_unit", "Completed set");
  }
  for (const prescription of rows(payload, "exercise_prescriptions")) {
    validateStoredLoad(prescription, "target_load", "Exercise target");
    nullableLoadPair(
      prescription,
      "target_load",
      "target_load_unit",
      "Exercise target"
    );
  }
  for (const exercise of rows(payload, "session_exercises")) {
    validateStoredLoad(exercise, "target_load", "Workout target");
    nullableLoadPair(
      exercise,
      "target_load",
      "target_load_unit",
      "Workout target"
    );
    validateWarmupSets(exercise, "Workout");
  }
  for (const exercise of rows(payload, "workout_template_exercises")) {
    validateWarmupSets(exercise, "Program");
  }
  for (const bar of rows(payload, "barbell_configs")) {
    validateStoredLoad(bar, "bar_weight", "Bar weight");
    validateStoredLoad(bar, "collar_weight", "Collar weight");
  }
  for (const plate of rows(payload, "plate_inventory")) {
    validateStoredLoad(plate, "denomination", "Plate denomination");
  }
  for (const requirement of rows(payload, "exercise_equipment_requirements")) {
    validateStoredLoad(requirement, "min_weight", "Equipment minimum weight");
  }
  validateQuickLogUnits(payload);
  for (const recommendation of rows(payload, "recommendations")) {
    validateLoadChangePayload(recommendation.payload, "Load recommendation");
  }
  for (const decision of rows(payload, "user_decisions")) {
    validateLoadChangePayload(decision.edited_payload, "Edited recommendation decision");
  }
  for (const adaptation of rows(payload, "adaptation_events")) {
    validatePrescriptionSnapshot(
      adaptation.before_snapshot,
      "Adaptation's earlier prescription"
    );
    validatePrescriptionSnapshot(
      adaptation.after_snapshot,
      "Adaptation's later prescription"
    );
  }
  for (const version of rows(payload, "record_versions")) {
    if (version.entity_type === "completed_set") {
      nullableLoadPair(
        version.before_data as SnapshotRow,
        "weight",
        "weight_unit",
        "Earlier set version"
      );
      nullableLoadPair(
        version.after_data as SnapshotRow,
        "weight",
        "weight_unit",
        "Later set version"
      );
    } else if (version.entity_type === "session_exercise") {
      nullableLoadPair(
        version.before_data as SnapshotRow,
        "target_load",
        "target_load_unit",
        "Earlier workout target version"
      );
      nullableLoadPair(
        version.after_data as SnapshotRow,
        "target_load",
        "target_load_unit",
        "Later workout target version"
      );
    }
  }
}

const START_REQUEST_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PRESCRIBED_METRIC_TYPES = new Set([
  "weight_reps", "reps", "assisted_reps", "duration",
  "distance_duration", "activity",
]);
const PRESCRIBED_LOAD_SEMANTICS = new Set([
  "total", "per_implement", "bodyweight", "added_weight", "assistance",
  "machine_stack", "resistance_band", "none",
]);

function validateStartAndPrescribedSemantics(payload: CanonicalSnapshotPayload) {
  if (payload.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return;
  const identities = new Set<string>();
  for (const session of rows(payload, "workout_sessions")) {
    for (const key of ["start_request_key", "start_request_hash"]) {
      if (!Object.hasOwn(session, key)) {
        throw new Error("Snapshot workout is missing Start request identity state.");
      }
    }
    const requestKey = session.start_request_key;
    const requestHash = session.start_request_hash;
    if (requestKey == null && requestHash == null) continue;
    if (
      typeof requestKey !== "string" ||
      !START_REQUEST_KEY_PATTERN.test(requestKey) ||
      typeof requestHash !== "string" ||
      !SHA256_PATTERN.test(requestHash)
    ) {
      throw new Error("Snapshot workout has invalid Start request identity.");
    }
    const ownerKey = `${String(session.user_id)}:${requestKey}`;
    if (identities.has(ownerKey)) {
      throw new Error("Snapshot reuses one owner Start request identity.");
    }
    identities.add(ownerKey);
  }

  const tupleKeys = [
    "prescribed_semantics_version",
    "prescribed_exercise_name",
    "prescribed_metric_type",
    "prescribed_load_type",
    "prescribed_load_semantics",
  ];
  for (const exercise of rows(payload, "session_exercises")) {
    if (tupleKeys.some((key) => !Object.hasOwn(exercise, key))) {
      throw new Error("Snapshot workout exercise is missing prescribed meaning state.");
    }
    const values = tupleKeys.map((key) => exercise[key]);
    if (values.every((value) => value == null)) continue;
    if (
      exercise.prescribed_semantics_version !== 1 ||
      typeof exercise.prescribed_exercise_name !== "string" ||
      exercise.prescribed_exercise_name.trim().length < 1 ||
      exercise.prescribed_exercise_name.trim().length > 300 ||
      !PRESCRIBED_METRIC_TYPES.has(String(exercise.prescribed_metric_type)) ||
      typeof exercise.prescribed_load_type !== "string" ||
      exercise.prescribed_load_type.trim().length < 1 ||
      exercise.prescribed_load_type.trim().length > 50 ||
      !PRESCRIBED_LOAD_SEMANTICS.has(String(exercise.prescribed_load_semantics))
    ) {
      throw new Error("Snapshot workout exercise has incoherent prescribed meaning.");
    }
  }
}

function isNonnegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateHistoryIdentityAndTiming(payload: CanonicalSnapshotPayload) {
  const programs = new Map(
    rows(payload, "programs").map((program) => [String(program.id), program])
  );
  const versions = new Map(
    rows(payload, "program_versions").map((version) => [
      String(version.id),
      version,
    ])
  );
  const templates = new Map(
    rows(payload, "workout_templates").map((template) => [
      String(template.id),
      template,
    ])
  );
  const jobs = new Map(
    rows(payload, "progression_jobs").map((job) => [String(job.id), job])
  );
  const sessions = new Map(
    rows(payload, "workout_sessions").map((session) => [
      String(session.id),
      session,
    ])
  );
  for (const session of rows(payload, "workout_sessions")) {
    if (
      !isNonnegativeInteger(session.history_revision) ||
      !["instant", "date_only"].includes(String(session.performed_time_precision))
    ) {
      throw new Error("Snapshot workout has invalid History revision or time precision.");
    }
    const lineage = [
      session.source_program_id,
      session.source_program_version_id,
      session.source_day_lineage_id,
    ];
    const linked = lineage.filter((value) => value != null).length;
    if (linked !== 0 && linked !== lineage.length) {
      throw new Error("Snapshot workout has incomplete source Program lineage.");
    }
    if (linked === lineage.length) {
      const program = programs.get(String(session.source_program_id));
      const version = versions.get(String(session.source_program_version_id));
      const template = session.template_id == null
        ? undefined
        : templates.get(String(session.template_id));
      if (
        (program && program.user_id !== session.user_id) ||
        (version && version.program_id !== session.source_program_id) ||
        (template &&
          (template.program_version_id !== session.source_program_version_id ||
            template.lineage_id !== session.source_day_lineage_id))
      ) {
        throw new Error(
          "Snapshot workout source Program lineage contradicts retained Program records."
        );
      }
    }
  }
  for (const set of rows(payload, "completed_sets")) {
    const performedSemanticsVersion = set.performed_semantics_version;
    const performedLoadType = set.performed_load_type;
    const performedLoadSemantics = set.performed_load_semantics;
    const performedSemanticsCoherent =
      (performedSemanticsVersion == null &&
        performedLoadType == null &&
        performedLoadSemantics == null) ||
      (performedSemanticsVersion === 1 &&
        typeof performedLoadType === "string" &&
        performedLoadType.trim().length > 0 &&
        typeof performedLoadSemantics === "string");
    if (!performedSemanticsCoherent) {
      throw new Error(
        "Snapshot completed set has incoherent performed-semantics evidence.",
      );
    }
    const observed = set.observed_completed_at;
    const provenance = set.observed_completion_provenance;
    const quality = set.observed_completion_quality;
    const coherent =
      (observed == null && provenance === "unknown" && quality === "unknown") ||
      (typeof observed === "string" &&
        Number.isFinite(Date.parse(observed)) &&
        ((provenance === "live_client" && quality === "trustworthy") ||
          (provenance === "import_source" && quality === "trustworthy") ||
          (provenance === "manual_explicit" && quality === "owner_reported")));
    if (!coherent) {
      throw new Error(
        "Snapshot completed set has incoherent observed-completion evidence."
      );
    }
  }
  for (const job of rows(payload, "progression_jobs")) {
    if (!isNonnegativeInteger(job.source_session_revision)) {
      throw new Error("Snapshot progression job has an invalid source revision.");
    }
  }
  const memberships = new Set<string>();
  for (const input of rows(payload, "progression_job_input_sessions")) {
    const job = jobs.get(String(input.job_id));
    const session = sessions.get(String(input.session_id));
    if (
      !isNonnegativeInteger(input.history_revision) ||
      typeof input.source_slot_lineage_id !== "string" ||
      !job ||
      !session ||
      input.user_id !== job.user_id ||
      input.user_id !== session.user_id
    ) {
      throw new Error(
        "Snapshot progression input has invalid revision or ownership evidence."
      );
    }
    const key = [
      input.job_id,
      input.source_slot_lineage_id,
      input.session_id,
    ].join(":");
    if (memberships.has(key)) {
      throw new Error("Snapshot progression input evidence is duplicated.");
    }
    memberships.add(key);
  }
}

function validateSessionCompilerIdentity(payload: CanonicalSnapshotPayload) {
  const proposals = new Map<string, SnapshotRow>();
  for (const proposal of rows(payload, "session_compiler_proposals")) {
    const input = sessionCompilerInputSchema.safeParse(proposal.input_snapshot);
    const output = sessionCompilerOutputSchema.safeParse(proposal.output_snapshot);
    const preflight = programPreflightResultSchema.safeParse(proposal.preflight_snapshot);
    if (!input.success || !output.success || !preflight.success) {
      throw new Error("Snapshot Session Compiler proposal contains invalid durable evidence.");
    }
    if (canonicalJson(preflight.data) !== canonicalJson(input.data.preflight)) {
      throw new Error("Snapshot Session Compiler proposal has mismatched Preflight evidence.");
    }
    const identity = {
      input: { ...input.data, preflight: { ...input.data.preflight, checkedAt: "evidence-time-excluded-from-identity" } },
      output: output.data,
    };
    if (proposal.content_hash !== sha256Hex(Buffer.from(canonicalJson(identity), "utf8"))) {
      throw new Error("Snapshot Session Compiler proposal checksum does not match its evidence.");
    }
    proposals.set(String(proposal.id), proposal);
  }
  for (const session of rows(payload, "workout_sessions")) {
    const key = session.compilation_acceptance_key;
    const snapshot = session.compilation_snapshot;
    if ((key == null) !== (snapshot == null)) {
      throw new Error("Snapshot workout has incomplete compiler provenance.");
    }
    if (snapshot == null) continue;
    if (session.source !== "compiler" || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("Snapshot workout compiler provenance is invalid.");
    }
    const record = snapshot as SnapshotRow;
    if (!sessionCompilerInputSchema.safeParse(record.input).success || !sessionCompilerOutputSchema.safeParse(record.output).success) {
      throw new Error("Snapshot workout compiler input or output is invalid.");
    }
    const proposal = proposals.get(String(record.proposalId));
    if (!proposal || proposal.content_hash !== record.proposalHash) {
      throw new Error("Snapshot workout does not match its accepted compiler proposal.");
    }
    if (
      proposal.status !== "accepted" ||
      proposal.accepted_session_id !== session.id ||
      proposal.acceptance_key !== key ||
      proposal.review_hash !== proposal.content_hash ||
      canonicalJson(record.input) !== canonicalJson(proposal.input_snapshot) ||
      canonicalJson(record.output) !== canonicalJson(proposal.output_snapshot)
    ) {
      throw new Error("Snapshot workout and accepted compiler review disagree.");
    }
  }
}

export function upgradeSnapshotPayload(
  payload: CanonicalSnapshotPayload
): CanonicalSnapshotPayload {
  const supported = new Set([
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
    "12",
    "13",
    "14",
    "15",
    "16",
    "17",
    "18",
    PLATE_QUANTITY_SNAPSHOT_SCHEMA_VERSION,
    PREVIOUS_SNAPSHOT_SCHEMA_VERSION,
    TRAINING_INTENT_SNAPSHOT_SCHEMA_VERSION,
    COMPILER_PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
    OCCURRENCE_SNAPSHOT_SCHEMA_VERSION,
    PRE_CONTEXTUAL_NOTE_SNAPSHOT_SCHEMA_VERSION,
    PRE_HISTORY_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
    PRE_PERFORMED_SEMANTICS_SNAPSHOT_SCHEMA_VERSION,
    PRE_START_SEMANTICS_SNAPSHOT_SCHEMA_VERSION,
    SNAPSHOT_SCHEMA_VERSION,
  ]);
  if (!supported.has(payload.schemaVersion)) {
    throw new Error(
      `Snapshot schema ${payload.schemaVersion} is not supported by this app version.`
    );
  }
  const upgraded = structuredClone(payload);
  normalizeSnapshotProgramDrafts(upgraded);
  if (upgraded.schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
    reconcileSnapshotCompletedSetOutcomes(upgraded);
    sanitizeSnapshotPrivacy(upgraded);
    validateUnitAndCalendarIdentity(upgraded);
    validateStartAndPrescribedSemantics(upgraded);
    validateHistoryIdentityAndTiming(upgraded);
    return upgraded;
  }

  // Schema 18 moved the float32 load columns to exact two-decimal storage.
  // Every older supported schema used the same float columns, so normalize
  // their artifacts before restore planning and final row verification.
  for (const row of rows(upgraded, "barbell_configs")) {
    roundLegacyLoad(row, "bar_weight");
    roundLegacyLoad(row, "collar_weight");
  }
  // Schema 19 replaced the per-side pair count with a total plate count so odd
  // quantities (a single spare plate) are representable. Every older supported
  // schema stored `count_per_side` pairs; two plates make one pair, so an older
  // count of N becomes a total quantity of 2N. Conservative and idempotent: we
  // only fill `quantity` when it is absent, then drop the retired column.
  const legacyPlateUnit = rows(upgraded, "user_profiles")[0]?.unit;
  for (const row of rows(upgraded, "plate_inventory")) {
    roundLegacyLoad(row, "denomination");
    row.unit ??= legacyPlateUnit === "kg" ? "kg" : "lb";
    if (row.count_per_side != null && row.quantity == null) {
      row.quantity = Number(row.count_per_side) * 2;
    }
    delete row.count_per_side;
  }
  for (const row of rows(upgraded, "exercise_equipment_requirements")) {
    roundLegacyLoad(row, "min_weight");
  }
  for (const row of rows(upgraded, "exercise_prescriptions")) {
    roundLegacyLoad(row, "target_load");
  }
  for (const row of rows(upgraded, "session_exercises")) {
    roundLegacyLoad(row, "target_load");
  }

  // These ledgers did not exist in schema 6. An absent table in that version
  // means an empty ledger, not a damaged snapshot.
  if (upgraded.schemaVersion === "6") {
    upgraded.tables.recovery_runs ??= [];
    upgraded.tables.integrity_findings ??= [];
  }
  // Progression jobs were introduced in schema 13. Older snapshots completed
  // progression inline, so an absent durable-job ledger means an empty ledger.
  if (
    ![
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      PLATE_QUANTITY_SNAPSHOT_SCHEMA_VERSION,
      PREVIOUS_SNAPSHOT_SCHEMA_VERSION,
      TRAINING_INTENT_SNAPSHOT_SCHEMA_VERSION,
      COMPILER_PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
      OCCURRENCE_SNAPSHOT_SCHEMA_VERSION,
      PRE_CONTEXTUAL_NOTE_SNAPSHOT_SCHEMA_VERSION,
      PRE_HISTORY_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
      PRE_PERFORMED_SEMANTICS_SNAPSHOT_SCHEMA_VERSION,
      PRE_START_SEMANTICS_SNAPSHOT_SCHEMA_VERSION,
      SNAPSHOT_SCHEMA_VERSION,
    ].includes(upgraded.schemaVersion)
  ) {
    upgraded.tables.progression_jobs ??= [];
  }

  // Schema 17 introduced immutable Program lineage and durable editor drafts.
  // Older formats cannot prove that independently-created rows represented the
  // same logical day, superset, or exercise slot, so each legacy row keeps only
  // its own ID as lineage. We deliberately do not infer lineage across versions
  // or across Programs.
  upgraded.tables.program_drafts ??= [];
  const programs = rows(upgraded, "programs");
  const programsById = new Map(
    programs.map((program) => [String(program.id), program])
  );
  const versions = rows(upgraded, "program_versions");
  const versionsByProgram = new Map<string, SnapshotRow[]>();
  for (const version of versions) {
    const program = programsById.get(String(version.program_id));
    if (!program) continue;
    version.name ??= program.name;
    version.parent_version_id ??= null;
    version.restored_from_version_id ??= null;
    version.publication_source ??=
      version.source_import_event_id == null ? "setup" : "import";
    version.review_hash ??= null;
    version.document_schema_version ??= 1;
    version.publication_preflight ??= null;
    version.activated_at ??= version.created_at;
    const programVersions = versionsByProgram.get(String(version.program_id)) ?? [];
    programVersions.push(version);
    versionsByProgram.set(String(version.program_id), programVersions);
  }
  for (const program of programs) {
    if (program.current_version_id != null) continue;
    const candidates = versionsByProgram.get(String(program.id)) ?? [];
    if (candidates.length === 0) {
      if (program.status === "active" && program.archived_at == null) {
        throw new Error(
          "This older snapshot has an active Program without a version. Nothing was restored."
        );
      }
      program.current_version_id = null;
      continue;
    }
    const highestVersion = Math.max(
      ...candidates.map((version) => Number(version.version_no))
    );
    const latest = candidates.filter(
      (version) => Number(version.version_no) === highestVersion
    );
    if (latest.length !== 1) {
      throw new Error(
        "This older snapshot has an ambiguous current Program version. Nothing was restored."
      );
    }
    program.current_version_id = latest[0].id;
  }
  for (const draft of rows(upgraded, "program_drafts")) {
    draft.restored_from_version_id ??= null;
  }
  for (const template of rows(upgraded, "workout_templates")) {
    template.lineage_id ??= template.id;
    template.warmup_notes ??= null;
    template.warmup_items ??= projectLegacyWarmupText(template, "warmup_notes");
    template.intent ??= null;
  }
  for (const group of rows(upgraded, "superset_groups")) {
    group.lineage_id ??= group.id;
    group.name ??= `Superset ${Number(group.order_idx ?? 0) + 1}`;
  }
  const slotsById = new Map<string, SnapshotRow>();
  for (const slot of rows(upgraded, "workout_template_exercises")) {
    slot.lineage_id ??= slot.id;
    slot.intent ??= null;
    slotsById.set(String(slot.id), slot);
  }

  for (const profile of rows(upgraded, "user_profiles")) {
    if (
      typeof profile.timezone !== "string" ||
      !isValidIanaTimezone(profile.timezone)
    ) {
      profile.timezone = "America/Toronto";
    }
  }
  const batchTimezones = new Map(
    rows(upgraded, "history_import_batches")
      .filter(
        (batch) =>
          typeof batch.id === "string" &&
          typeof batch.timezone === "string" &&
          isValidIanaTimezone(batch.timezone)
      )
      .map((batch) => [String(batch.id), String(batch.timezone)])
  );
  for (const session of rows(upgraded, "workout_sessions")) {
    session.day_warmup_notes ??= null;
    session.day_warmup_items ??= projectLegacyWarmupText(
      session,
      "day_warmup_notes"
    );
    session.compilation_acceptance_key ??= null;
    session.compilation_snapshot ??= null;
    session.start_request_key ??= null;
    session.start_request_hash ??= null;
    let timezone =
      typeof session.timezone === "string" &&
      isValidIanaTimezone(session.timezone)
        ? session.timezone
        : null;
    if (!timezone && session.import_batch_id != null) {
      timezone = batchTimezones.get(String(session.import_batch_id)) ?? null;
    }
    if (!timezone || typeof session.started_at !== "string") {
      throw new Error(
        "This older snapshot contains a workout whose timezone cannot be proven. Nothing was restored."
      );
    }
    session.timezone = timezone;
    session.local_date = workoutLocalDate(new Date(session.started_at), timezone);
    session.history_revision ??= 0;
    session.performed_time_precision ??= "instant";
    if (
      session.source_program_id == null &&
      session.source_program_version_id == null &&
      session.source_day_lineage_id == null &&
      session.template_id != null
    ) {
      const template = rows(upgraded, "workout_templates").find(
        (candidate) => candidate.id === session.template_id
      );
      const version = template
        ? versions.find(
            (candidate) => candidate.id === template.program_version_id
          )
        : undefined;
      const program = version
        ? programs.find((candidate) => candidate.id === version.program_id)
        : undefined;
      if (
        template &&
        version &&
        program &&
        program.user_id === session.user_id
      ) {
        session.source_program_id = program.id;
        session.source_program_version_id = version.id;
        session.source_day_lineage_id = template.lineage_id;
      }
    }
    session.source_program_id ??= null;
    session.source_program_version_id ??= null;
    session.source_day_lineage_id ??= null;
  }
  upgraded.tables.session_compiler_proposals ??= [];
  upgraded.tables.session_exercise_groups ??= [];
  upgraded.tables.session_occurrences ??= [];
  upgraded.tables.session_occurrence_mutations ??= [];
  upgraded.tables.plate_loaded_machine_profiles ??= [];
  upgraded.tables.plate_loaded_machine_compatible_plates ??= [];
  upgraded.tables.cable_machine_profiles ??= [];
  upgraded.tables.cable_stack_steps ??= [];
  upgraded.tables.cable_attachment_profiles ??= [];
  upgraded.tables.cable_attachment_compatibilities ??= [];
  upgraded.tables.exercise_execution_requirements ??= [];
  upgraded.tables.session_equipment_snapshots ??= [];
  upgraded.tables.session_equipment_selection_receipts ??= [];
  upgraded.tables.contextual_notes ??= [];
  upgraded.tables.contextual_note_revisions ??= [];
  upgraded.tables.progression_job_input_sessions ??= [];
  for (const prescription of rows(upgraded, "exercise_prescriptions")) {
    prescription.target_load_unit ??= null;
  }
  for (const exercise of rows(upgraded, "session_exercises")) {
    exercise.target_load_unit ??= null;
    exercise.current_equipment_snapshot_id ??= null;
    exercise.prescribed_semantics_version ??= null;
    exercise.prescribed_exercise_name ??= null;
    exercise.prescribed_metric_type ??= null;
    exercise.prescribed_load_type ??= null;
    exercise.prescribed_load_semantics ??= null;
    if (
      exercise.source_slot_lineage_id == null &&
      exercise.planned_from_template_exercise_id != null
    ) {
      const session = rows(upgraded, "workout_sessions").find(
        (candidate) => candidate.id === exercise.session_id
      );
      const slot = slotsById.get(
        String(exercise.planned_from_template_exercise_id)
      );
      if (
        session?.source_program_id != null &&
        session.template_id != null &&
        slot?.workout_template_id === session.template_id
      ) {
        exercise.source_slot_lineage_id = slot.lineage_id;
      }
    }
    exercise.source_slot_lineage_id ??= null;
  }
  for (const completed of rows(upgraded, "completed_sets")) {
    completed.equipment_snapshot_id ??= null;
    completed.load_entry_meaning ??= "legacy_unknown";
    completed.observed_completed_at ??= null;
    completed.observed_completion_provenance ??= "unknown";
    completed.observed_completion_quality ??= "unknown";
    completed.performed_semantics_version ??= null;
    completed.performed_load_type ??= null;
    completed.performed_load_semantics ??= null;
  }
  for (const job of rows(upgraded, "progression_jobs")) {
    job.source_session_revision ??= 0;
  }
  for (const occurrence of rows(upgraded, "session_occurrences")) {
    occurrence.equipment_snapshot_id ??= null;
  }
  for (const recommendation of rows(upgraded, "recommendations")) {
    recommendation.progression_job_id ??= null;
    recommendation.source_template_exercise_id ??= null;
    recommendation.source_slot_lineage_id ??=
      recommendation.source_template_exercise_id == null
        ? null
        : (slotsById.get(String(recommendation.source_template_exercise_id))
            ?.lineage_id ?? null);
    recommendation.reconciled_at ??=
      recommendation.status === "expired"
        ? (recommendation.decided_at ?? recommendation.created_at)
        : null;
    recommendation.reconciliation_reason ??=
      recommendation.status === "expired"
        ? "Expired before versioned Program reconciliation; the original reason was not recorded."
        : null;
    recommendation.reconciled_by_program_version_id ??= null;
  }
  for (const audit of rows(upgraded, "audit_logs")) {
    audit.idempotency_key ??= null;
  }
  for (const insight of rows(upgraded, "coaching_insights")) {
    insight.generation_lease_id ??= null;
    insight.generation_lease_expires_at ??= null;
    insight.generation_started_at ??= null;
  }
  for (const event of rows(upgraded, "ai_parsing_events")) {
    event.result_session_id ??= null;
  }
  for (const snapshot of rows(upgraded, "data_snapshots")) {
    snapshot.snapshot_kind ??=
      snapshot.reason === "manual"
        ? "user"
        : typeof snapshot.name === "string" &&
            snapshot.name.startsWith("Safety snapshot · ")
          ? "automatic"
          : "user";
    snapshot.deletion_status ??= null;
    snapshot.deletion_requested_at ??= null;
    snapshot.deletion_attempts ??= 0;
    snapshot.deletion_failure_reason ??= null;
    snapshot.deletion_lease_id ??= null;
    snapshot.deletion_lease_expires_at ??= null;
  }
  sanitizeSnapshotPrivacy(upgraded);
  reconcileSnapshotCompletedSetOutcomes(upgraded);
  upgraded.schemaVersion = SNAPSHOT_SCHEMA_VERSION;
  validateUnitAndCalendarIdentity(upgraded);
  validateStartAndPrescribedSemantics(upgraded);
  validateHistoryIdentityAndTiming(upgraded);
  return upgraded;
}

function idSet(payload: CanonicalSnapshotPayload, table: string) {
  return new Set(rows(payload, table).map((row) => String(row.id)));
}

function requireReferences(
  payload: CanonicalSnapshotPayload,
  table: string,
  column: string,
  parentTable: string
) {
  const parentIds = idSet(payload, parentTable);
  for (const row of rows(payload, table)) {
    if (!parentIds.has(String(row[column]))) {
      throw new Error(`Snapshot table ${table} has a broken ${parentTable} reference.`);
    }
  }
}

function requireOptionalReferences(
  payload: CanonicalSnapshotPayload,
  table: string,
  column: string,
  parentTable: string
) {
  const parentIds = idSet(payload, parentTable);
  for (const row of rows(payload, table)) {
    if (row[column] != null && !parentIds.has(String(row[column]))) {
      throw new Error(`Snapshot table ${table} has a broken ${parentTable} reference.`);
    }
  }
}

function validateContextualNoteData(payload: CanonicalSnapshotPayload) {
  const sessionExerciseById = new Map(
    rows(payload, "session_exercises").map((row) => [String(row.id), row])
  );
  const occurrenceById = new Map(
    rows(payload, "session_occurrences").map((row) => [String(row.id), row])
  );
  const completedSetById = new Map(
    rows(payload, "completed_sets").map((row) => [String(row.id), row])
  );
  const noteById = new Map(
    rows(payload, "contextual_notes").map((note) => [String(note.id), note])
  );
  const revisionsByNote = new Map<string, SnapshotRow[]>();
  for (const revision of rows(payload, "contextual_note_revisions")) {
    const note = noteById.get(String(revision.note_id));
    if (
      !note ||
      revision.user_id !== note.user_id ||
      !Number.isInteger(Number(revision.revision)) ||
      Number(revision.revision) < 1 ||
      typeof revision.body !== "string" ||
      revision.body.trim().length === 0 ||
      typeof revision.coach_visible !== "boolean" ||
      !["typed", "reviewed_dictation"].includes(String(revision.input_mode)) ||
      typeof revision.client_key !== "string" ||
      typeof revision.canonical_payload_hash !== "string"
    ) {
      throw new Error("Snapshot contextual note revision is invalid.");
    }
    const revisions = revisionsByNote.get(String(revision.note_id)) ?? [];
    revisions.push(revision);
    revisionsByNote.set(String(revision.note_id), revisions);
  }
  for (const note of noteById.values()) {
    if (
      typeof note.body !== "string" ||
      note.body.trim().length === 0 ||
      typeof note.coach_visible !== "boolean" ||
      !["typed", "reviewed_dictation"].includes(String(note.input_mode)) ||
      !["general", "workout", "exercise", "occurrence", "set", "rest", "program", "program_day", "program_item"].includes(String(note.attachment_kind)) ||
      !Number.isInteger(Number(note.revision)) ||
      Number(note.revision) < 1 ||
      typeof note.client_key !== "string" ||
      typeof note.creation_payload_hash !== "string" ||
      !contextualNoteCapturedContextSchema.safeParse(note.captured_context).success
    ) {
      throw new Error("Snapshot contextual note is invalid.");
    }
    const sessionId = note.session_id == null ? null : String(note.session_id);
    const sessionExercise = note.session_exercise_id == null
      ? null
      : sessionExerciseById.get(String(note.session_exercise_id));
    const occurrence = note.occurrence_id == null
      ? null
      : occurrenceById.get(String(note.occurrence_id));
    const completedSet = note.completed_set_id == null
      ? null
      : completedSetById.get(String(note.completed_set_id));
    const setExercise = completedSet
      ? sessionExerciseById.get(String(completedSet.session_exercise_id))
      : null;
    if (
      (sessionExercise && sessionExercise.session_id !== sessionId) ||
      (occurrence && occurrence.session_id !== sessionId) ||
      (setExercise && setExercise.session_id !== sessionId) ||
      (occurrence && sessionExercise && occurrence.session_exercise_id != null && occurrence.session_exercise_id !== sessionExercise.id) ||
      (completedSet && sessionExercise && completedSet.session_exercise_id !== sessionExercise.id) ||
      (completedSet && occurrence && occurrence.completed_set_id !== completedSet.id)
    ) {
      throw new Error("Snapshot contextual note crosses workout attachment boundaries.");
    }
    const revisions = (revisionsByNote.get(String(note.id)) ?? []).sort(
      (left, right) => Number(left.revision) - Number(right.revision)
    );
    if (
      revisions.length !== Number(note.revision) ||
      revisions.some((revision, index) => Number(revision.revision) !== index + 1)
    ) {
      throw new Error("Snapshot contextual note has an incomplete revision chain.");
    }
    const latest = revisions.at(-1);
    if (
      !latest ||
      latest.body !== note.body ||
      latest.coach_visible !== note.coach_visible ||
      latest.input_mode !== note.input_mode
    ) {
      throw new Error("Snapshot contextual note does not match its latest revision.");
    }
  }
}

function validateVersionedProgramData(payload: CanonicalSnapshotPayload) {
  if (payload.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return;

  const programs = new Map(
    rows(payload, "programs").map((program) => [String(program.id), program])
  );
  const versions = new Map(
    rows(payload, "program_versions").map((version) => [String(version.id), version])
  );
  const versionsByProgram = new Map<string, Set<number>>();
  const newestVersionByProgram = new Map<string, { id: string; versionNo: number }>();
  for (const version of versions.values()) {
    const programId = String(version.program_id);
    const number = Number(version.version_no);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error("Snapshot Program history contains an invalid version number.");
    }
    const used = versionsByProgram.get(programId) ?? new Set<number>();
    if (used.has(number)) {
      throw new Error("Snapshot Program history contains a duplicate version number.");
    }
    used.add(number);
    versionsByProgram.set(programId, used);
    const newest = newestVersionByProgram.get(programId);
    if (!newest || number > newest.versionNo) {
      newestVersionByProgram.set(programId, { id: String(version.id), versionNo: number });
    }
    for (const key of ["parent_version_id", "restored_from_version_id"] as const) {
      if (version[key] == null) continue;
      const linked = versions.get(String(version[key]));
      if (!linked || linked.program_id !== version.program_id) {
        throw new Error("Snapshot Program history crosses between different Programs.");
      }
      if (key === "parent_version_id" && Number(linked.version_no) >= number) {
        throw new Error("Snapshot Program history has an invalid parent version.");
      }
    }
    if (
      typeof version.name !== "string" ||
      version.name.trim().length === 0 ||
      typeof version.activated_at !== "string" ||
      !["setup", "import", "editor", "recommendation", "restore"].includes(String(version.publication_source))
    ) {
      throw new Error("Snapshot Program history is missing immutable activation details.");
    }
    const documentSchemaVersion = Number(version.document_schema_version);
    if (![1, 2, 3].includes(documentSchemaVersion)) {
      throw new Error("Snapshot Program history has an unsupported document version.");
    }
    if (
      documentSchemaVersion >= 2 &&
      !programPreflightResultSchema.safeParse(version.publication_preflight).success
    ) {
      throw new Error("Snapshot Program version is missing its publication-time Preflight result.");
    }
  }
  const activeProgramUsers = new Set<string>();
  for (const program of programs.values()) {
    const current =
      program.current_version_id == null
        ? null
        : versions.get(String(program.current_version_id));
    if (program.status === "active" && program.archived_at == null && !current) {
      throw new Error("Snapshot active Program has no current immutable version.");
    }
    if (current && current.program_id !== program.id) {
      throw new Error("Snapshot Program current version belongs to another Program.");
    }
    if (
      (program.status === "active") !== (program.archived_at == null) ||
      (program.status === "archived") !== (program.archived_at != null)
    ) {
      throw new Error("Snapshot Program archive state is inconsistent.");
    }
    const newest = newestVersionByProgram.get(String(program.id));
    if (current && newest && String(current.id) !== newest.id) {
      throw new Error("Snapshot Program current version is not its newest version.");
    }
    if (program.status === "active" && program.archived_at == null) {
      const owner = String(program.user_id);
      if (activeProgramUsers.has(owner)) {
        throw new Error("Snapshot owner has more than one active Program.");
      }
      activeProgramUsers.add(owner);
    }
  }

  const templates = new Map(
    rows(payload, "workout_templates").map((template) => [String(template.id), template])
  );
  const templateLineagesByVersion = new Set<string>();
  const templateOrdersByVersion = new Set<string>();
  for (const template of templates.values()) {
    if (!versions.has(String(template.program_version_id)) ||
        !Number.isInteger(Number(template.order_idx)) || Number(template.order_idx) < 0 ||
        typeof template.name !== "string" || template.name.trim().length === 0) {
      throw new Error("Snapshot Program day has invalid ownership, order, or name.");
    }
    const key = `${String(template.program_version_id)}:${String(template.lineage_id)}`;
    if (templateLineagesByVersion.has(key)) {
      throw new Error("Snapshot Program version contains duplicate day lineage.");
    }
    templateLineagesByVersion.add(key);
    const orderKey = `${String(template.program_version_id)}:${Number(template.order_idx)}`;
    if (templateOrdersByVersion.has(orderKey)) {
      throw new Error("Snapshot Program version contains duplicate day order.");
    }
    templateOrdersByVersion.add(orderKey);
    const version = versions.get(String(template.program_version_id));
    if (
      Number(version?.document_schema_version) >= 2 &&
      !programDayIntentSchema.safeParse(template.intent).success
    ) {
      throw new Error("Snapshot Program day is missing reviewed structured intent.");
    }
  }
  const groups = new Map(
    rows(payload, "superset_groups").map((group) => [String(group.id), group])
  );
  const groupLineagesByTemplate = new Set<string>();
  const groupOrdersByTemplate = new Set<string>();
  for (const group of groups.values()) {
    if (!templates.has(String(group.workout_template_id)) ||
        !Number.isInteger(Number(group.order_idx)) || Number(group.order_idx) < 0 ||
        !Number.isInteger(Number(group.rest_after_round_sec)) || Number(group.rest_after_round_sec) < 0 || Number(group.rest_after_round_sec) > 1800 ||
        typeof group.name !== "string" || group.name.trim().length === 0) {
      throw new Error("Snapshot Program superset has invalid ownership, order, or rest.");
    }
    const key = `${String(group.workout_template_id)}:${String(group.lineage_id)}`;
    if (groupLineagesByTemplate.has(key)) {
      throw new Error("Snapshot Program day contains duplicate superset lineage.");
    }
    groupLineagesByTemplate.add(key);
    const orderKey = `${String(group.workout_template_id)}:${Number(group.order_idx)}`;
    if (groupOrdersByTemplate.has(orderKey)) {
      throw new Error("Snapshot Program day contains duplicate superset order.");
    }
    groupOrdersByTemplate.add(orderKey);
  }
  const slots = new Map(
    rows(payload, "workout_template_exercises").map((slot) => [String(slot.id), slot])
  );
  const slotLineagesByVersion = new Set<string>();
  const knownSlotLineages = new Set<string>();
  const slotOrdersByTemplate = new Set<string>();
  const groupMemberCounts = new Map<string, number>();
  for (const slot of slots.values()) {
    const template = templates.get(String(slot.workout_template_id));
    if (!template || !Number.isInteger(Number(slot.order_idx)) || Number(slot.order_idx) < 0 ||
        !Number.isInteger(Number(slot.rest_sec)) || Number(slot.rest_sec) < 0 || Number(slot.rest_sec) > 1800) {
      throw new Error("Snapshot Program exercise has invalid ownership, order, or rest.");
    }
    const orderKey = `${String(slot.workout_template_id)}:${Number(slot.order_idx)}`;
    if (slotOrdersByTemplate.has(orderKey)) {
      throw new Error("Snapshot Program day contains duplicate exercise order.");
    }
    slotOrdersByTemplate.add(orderKey);
    const lineage = String(slot.lineage_id);
    const key = `${String(template.program_version_id)}:${lineage}`;
    if (slotLineagesByVersion.has(key)) {
      throw new Error("Snapshot Program version contains duplicate exercise-slot lineage.");
    }
    slotLineagesByVersion.add(key);
    const version = versions.get(String(template.program_version_id));
    if (
      Number(version?.document_schema_version) >= 2 &&
      !programSlotIntentSchema.safeParse(slot.intent).success
    ) {
      throw new Error("Snapshot Program exercise is missing reviewed structured intent.");
    }
    knownSlotLineages.add(lineage);
    if (slot.superset_group_id != null) {
      const group = groups.get(String(slot.superset_group_id));
      if (!group || group.workout_template_id !== slot.workout_template_id) {
        throw new Error("Snapshot Program exercise points to a superset in another day.");
      }
      const groupId = String(slot.superset_group_id);
      groupMemberCounts.set(groupId, (groupMemberCounts.get(groupId) ?? 0) + 1);
    }
  }
  for (const groupId of groups.keys()) {
    if ((groupMemberCounts.get(groupId) ?? 0) < 2) {
      throw new Error("Snapshot Program superset has fewer than two exercises.");
    }
  }
  for (const template of templates.values()) {
    const version = versions.get(String(template.program_version_id));
    if (Number(version?.document_schema_version) < 2) continue;
    const intent = programDayIntentSchema.parse(template.intent);
    const daySlotLineages = new Set(
      [...slots.values()]
        .filter((slot) => slot.workout_template_id === template.id)
        .map((slot) => String(slot.lineage_id)),
    );
    if (
      intent.identity.anchorSlotLineageIds.some(
        (lineageId) => !daySlotLineages.has(lineageId),
      )
    ) {
      throw new Error("Snapshot Program day identity points outside its exercise list.");
    }
  }

  const activePrescriptionCounts = new Map<string, number>();
  for (const prescription of rows(payload, "exercise_prescriptions")) {
    if (!slots.has(String(prescription.template_exercise_id)) ||
        !Number.isInteger(Number(prescription.sets)) || Number(prescription.sets) < 1 || Number(prescription.sets) > 20 ||
        !Number.isInteger(Number(prescription.rep_range_min)) || Number(prescription.rep_range_min) < 1 || Number(prescription.rep_range_min) > 100 ||
        !Number.isInteger(Number(prescription.rep_range_max)) || Number(prescription.rep_range_max) < Number(prescription.rep_range_min) || Number(prescription.rep_range_max) > 100 ||
        ((prescription.target_load == null) !== (prescription.target_load_unit == null))) {
      throw new Error("Snapshot Program prescription is invalid.");
    }
    if (prescription.superseded_by_id == null) {
      const slotId = String(prescription.template_exercise_id);
      activePrescriptionCounts.set(slotId, (activePrescriptionCounts.get(slotId) ?? 0) + 1);
    }
  }
  for (const slotId of slots.keys()) {
    if (activePrescriptionCounts.get(slotId) !== 1) {
      throw new Error("Snapshot Program exercise must have exactly one active prescription.");
    }
  }

  const openDraftPrograms = new Set<string>();
  for (const draft of rows(payload, "program_drafts")) {
    const program = programs.get(String(draft.program_id));
    const base = versions.get(String(draft.base_version_id));
    const published =
      draft.published_version_id == null
        ? null
        : versions.get(String(draft.published_version_id));
    const restoredFrom =
      draft.restored_from_version_id == null
        ? null
        : versions.get(String(draft.restored_from_version_id));
    if (
      !program ||
      !base ||
      base.program_id !== program.id ||
      (published && published.program_id !== program.id) ||
      (restoredFrom && restoredFrom.program_id !== program.id) ||
      draft.restored_from_version_id === draft.base_version_id
    ) {
      throw new Error("Snapshot Program draft crosses between different Programs.");
    }
    let document;
    try {
      document = normalizeStoredProgramDocumentLoads(
        storedProgramDocumentSchema.parse(draft.document),
      );
    } catch {
      throw new Error("Snapshot Program draft document is invalid or mismatched.");
    }
    if (
      document.programId !== program.id ||
      document.baseVersionId !== base.id ||
      draft.content_hash !== hashProgramDocument(document)
    ) {
      throw new Error("Snapshot Program draft document is invalid or mismatched.");
    }
    if (
      !Number.isInteger(Number(draft.revision)) ||
      Number(draft.revision) < 1 ||
      typeof draft.content_hash !== "string" ||
      draft.content_hash.length === 0
    ) {
      throw new Error("Snapshot Program draft revision or content identity is invalid.");
    }
    const reviewedRevision =
      draft.reviewed_revision == null ? null : Number(draft.reviewed_revision);
    if (
      (reviewedRevision == null) !== (draft.review_hash == null) ||
      (reviewedRevision != null &&
        (!Number.isInteger(reviewedRevision) ||
          reviewedRevision < 1 ||
          reviewedRevision > Number(draft.revision)))
    ) {
      throw new Error("Snapshot Program draft review state is invalid.");
    }
    if (draft.status === "open") {
      if (openDraftPrograms.has(String(program.id))) {
        throw new Error("Snapshot contains more than one open draft for a Program.");
      }
      openDraftPrograms.add(String(program.id));
      if (draft.published_version_id != null || draft.published_at != null) {
        throw new Error("Snapshot open Program draft is already marked as published.");
      }
    } else if (
      draft.status === "published" &&
      (!published || draft.published_at == null)
    ) {
      throw new Error("Snapshot published Program draft is missing its new version.");
    } else if (draft.status === "discarded" && draft.discarded_at == null) {
      throw new Error("Snapshot discarded Program draft is missing its discard time.");
    }
  }

  for (const recommendation of rows(payload, "recommendations")) {
    const sourceSlot =
      recommendation.source_template_exercise_id == null
        ? null
        : slots.get(String(recommendation.source_template_exercise_id));
    if (
      sourceSlot &&
      recommendation.source_slot_lineage_id !== sourceSlot.lineage_id
    ) {
      throw new Error("Snapshot recommendation source lineage does not match its Program slot.");
    }
    if (recommendation.status === "pending") {
      const isProgramWide =
        (recommendation.payload as { kind?: unknown } | null)?.kind === "deload";
      if (isProgramWide) {
        if (
          recommendation.source_template_exercise_id != null ||
          recommendation.source_slot_lineage_id != null ||
          ![...programs.values()].some(
            (program) =>
              String(program.user_id) === String(recommendation.user_id) &&
              program.status === "active" &&
              program.archived_at == null &&
              program.current_version_id != null
          )
        ) {
          throw new Error("Snapshot Program-wide recommendation is not tied to an active Program.");
        }
      } else {
        if (!sourceSlot || recommendation.source_slot_lineage_id == null) {
          throw new Error("Snapshot pending recommendation has no current Program source.");
        }
        const sourceTemplate = templates.get(String(sourceSlot.workout_template_id));
        const currentProgram = [...programs.values()].find((program) =>
          String(program.user_id) === String(recommendation.user_id) &&
          String(program.current_version_id) === String(sourceTemplate?.program_version_id)
        );
        if (!currentProgram) {
          throw new Error("Snapshot pending recommendation does not reference its owner current Program.");
        }
      }
    }
    if (
      recommendation.source_slot_lineage_id != null &&
      !knownSlotLineages.has(String(recommendation.source_slot_lineage_id))
    ) {
      throw new Error("Snapshot recommendation points to an unknown Program slot lineage.");
    }
    const reconciled = recommendation.reconciled_at != null;
    const hasReason =
      typeof recommendation.reconciliation_reason === "string" &&
      recommendation.reconciliation_reason.trim().length > 0;
    const hasVersion = recommendation.reconciled_by_program_version_id != null;
    const allowsReconciliation = ["pending", "approved", "edited", "expired"].includes(
      String(recommendation.status)
    );
    if (
      (recommendation.status === "expired" && (!reconciled || !hasReason)) ||
      (!allowsReconciliation && (reconciled || hasReason || hasVersion)) ||
      (allowsReconciliation && (reconciled !== hasReason || (hasVersion && !reconciled)))
    ) {
      throw new Error("Snapshot recommendation reconciliation state is inconsistent.");
    }
  }
}

function validateSessionOccurrenceData(payload: CanonicalSnapshotPayload) {
  if (payload.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return;

  const exercises = new Map(
    rows(payload, "session_exercises").map((row) => [String(row.id), row])
  );
  const groups = new Map(
    rows(payload, "session_exercise_groups").map((row) => [String(row.id), row])
  );
  const completedSets = new Map(
    rows(payload, "completed_sets").map((row) => [String(row.id), row])
  );
  const equipmentSnapshots = new Map(
    rows(payload, "session_equipment_snapshots").map((row) => [String(row.id), row])
  );
  const attachmentProfiles = new Map(
    rows(payload, "cable_attachment_profiles").map((row) => [String(row.id), row])
  );
  const occurrences = new Map(
    rows(payload, "session_occurrences").map((row) => [String(row.id), row])
  );
  const sequenceKeys = new Set<string>();
  const completedSetLinks = new Set<string>();

  for (const exercise of exercises.values()) {
    const groupId = exercise.group_snapshot_id;
    const memberOrder = exercise.group_member_order_idx;
    if ((groupId == null) !== (memberOrder == null)) {
      throw new Error("Snapshot workout exercise has incomplete group coordinates.");
    }
    if (groupId != null) {
      const group = groups.get(String(groupId));
      if (!group || group.session_id !== exercise.session_id) {
        throw new Error("Snapshot workout exercise group crosses between workouts.");
      }
      if (!Number.isInteger(Number(memberOrder)) || Number(memberOrder) < 0) {
        throw new Error("Snapshot workout exercise has an invalid group member order.");
      }
    }
    if (exercise.current_equipment_snapshot_id != null) {
      const snapshot = equipmentSnapshots.get(
        String(exercise.current_equipment_snapshot_id)
      );
      if (
        !snapshot ||
        snapshot.session_id !== exercise.session_id ||
        snapshot.session_exercise_id !== exercise.id
      ) {
        throw new Error("Snapshot current equipment selection crosses between workout exercises.");
      }
    }
  }

  for (const occurrence of occurrences.values()) {
    const key = `${String(occurrence.session_id)}:${Number(occurrence.sequence_idx)}`;
    if (sequenceKeys.has(key)) {
      throw new Error("Snapshot workout contains a duplicate occurrence sequence.");
    }
    sequenceKeys.add(key);

    const sessionExercise = occurrence.session_exercise_id == null
      ? null
      : exercises.get(String(occurrence.session_exercise_id));
    if (sessionExercise && sessionExercise.session_id !== occurrence.session_id) {
      throw new Error("Snapshot occurrence exercise crosses between workouts.");
    }
    const group = occurrence.group_snapshot_id == null
      ? null
      : groups.get(String(occurrence.group_snapshot_id));
    if (group && group.session_id !== occurrence.session_id) {
      throw new Error("Snapshot occurrence group crosses between workouts.");
    }
    const hasAnyGroupCoordinate =
      occurrence.group_snapshot_id != null ||
      occurrence.group_round != null ||
      occurrence.group_member_order_idx != null;
    const hasAllGroupCoordinates =
      occurrence.group_snapshot_id != null &&
      Number.isInteger(Number(occurrence.group_round)) &&
      Number(occurrence.group_round) >= 1 &&
      Number.isInteger(Number(occurrence.group_member_order_idx)) &&
      Number(occurrence.group_member_order_idx) >= 0;
    if (hasAnyGroupCoordinate !== hasAllGroupCoordinates) {
      throw new Error("Snapshot occurrence has incomplete group coordinates.");
    }

    const needsPerformedResult =
      occurrence.kind === "working_set" && occurrence.outcome === "completed";
    if (needsPerformedResult !== (occurrence.completed_set_id != null)) {
      throw new Error("Snapshot occurrence outcome does not match its performed-result link.");
    }

    if (occurrence.completed_set_id != null) {
      const completedSetId = String(occurrence.completed_set_id);
      const completedSet = completedSets.get(completedSetId);
      if (
        !completedSet ||
        completedSet.session_exercise_id !== occurrence.session_exercise_id ||
        occurrence.kind !== "working_set" ||
        occurrence.outcome !== "completed"
      ) {
        throw new Error("Snapshot occurrence has an invalid performed-result link.");
      }
      if (completedSetLinks.has(completedSetId)) {
        throw new Error("Snapshot completed result is linked to more than one occurrence.");
      }
      completedSetLinks.add(completedSetId);
      if (
        completedSet.equipment_snapshot_id !== occurrence.equipment_snapshot_id
      ) {
        throw new Error("Snapshot completed occurrence and set equipment evidence disagree.");
      }
    }
  }

  for (const snapshot of equipmentSnapshots.values()) {
    const exercise = exercises.get(String(snapshot.session_exercise_id));
    if (
      !exercise ||
      exercise.session_id !== snapshot.session_id ||
      typeof snapshot.configuration_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(snapshot.configuration_hash) ||
      !snapshot.geometry_snapshot ||
      typeof snapshot.geometry_snapshot !== "object" ||
      Array.isArray(snapshot.geometry_snapshot) ||
      Number((snapshot.geometry_snapshot as SnapshotRow).version) !==
        Number(snapshot.geometry_version) ||
      (snapshot.geometry_snapshot as SnapshotRow).kind !== snapshot.profile_kind
    ) {
      throw new Error("Snapshot equipment setup has invalid ownership or geometry evidence.");
    }

    if (["plate_loaded_implement", "plate_loaded_machine", "cable_machine"].includes(String(snapshot.profile_kind))) {
      const parsedGeometry = sessionEquipmentGeometrySnapshotSchema.safeParse(
        snapshot.geometry_snapshot
      );
      if (!parsedGeometry.success) {
        throw new Error("Snapshot equipment setup contains malformed historical geometry.");
      }
      const geometry = parsedGeometry.data;
      const rowCertainty = snapshot.geometry_certainty;
      const expectedCertainty = geometry.kind === "plate_loaded_implement"
        ? "known"
        : geometry.geometryCertainty;
      const expectedUnit = geometry.kind === "plate_loaded_implement"
        ? geometry.unit
        : geometry.kind === "plate_loaded_machine"
          ? geometry.startingResistanceUnit
          : geometry.displayedUnit;
      if (rowCertainty !== expectedCertainty || snapshot.unit !== expectedUnit) {
        throw new Error("Snapshot equipment setup disagrees with its historical geometry.");
      }

      const attachmentStateComplete = snapshot.attachment_item_id == null
        ? snapshot.attachment_profile_id == null &&
          snapshot.attachment_label == null &&
          snapshot.attachment_definition_key == null
        : typeof snapshot.attachment_profile_id === "string" &&
          typeof snapshot.attachment_label === "string" &&
          snapshot.attachment_label.trim().length > 0;
      if (
        typeof snapshot.equipment_item_id !== "string" ||
        typeof snapshot.equipment_label !== "string" ||
        snapshot.equipment_label.trim().length === 0 ||
        !attachmentStateComplete ||
        (snapshot.attachment_item_id != null && geometry.kind !== "cable_machine")
      ) {
        throw new Error("Snapshot equipment setup has an invalid canonical identity.");
      }

      const knownAttachmentKind = snapshot.attachment_profile_id == null
        ? null
        : attachmentProfiles.get(String(snapshot.attachment_profile_id))?.attachment_kind;
      const attachmentKinds = snapshot.attachment_item_id == null
        ? [null]
        : typeof knownAttachmentKind === "string"
          ? [knownAttachmentKind]
          : ["rope", "straight_bar", "lat_bar", "v_bar", "single_handle", "ankle_cuff", "other"];
      const matchingHashes = attachmentKinds.filter((attachmentKind) => {
        const identity = buildSessionEquipmentConfigurationIdentity({
          equipmentItemId: snapshot.equipment_item_id as string,
          equipmentLabel: snapshot.equipment_label as string,
          equipmentDefinitionKey: snapshot.equipment_definition_key == null
            ? null
            : String(snapshot.equipment_definition_key),
          attachmentItemId: snapshot.attachment_item_id == null
            ? null
            : String(snapshot.attachment_item_id),
          attachmentLabel: snapshot.attachment_label == null
            ? null
            : String(snapshot.attachment_label),
          attachmentDefinitionKey: snapshot.attachment_definition_key == null
            ? null
            : String(snapshot.attachment_definition_key),
          attachmentKind,
          geometry,
        });
        return sha256Hex(Buffer.from(canonicalJson(identity), "utf8")) ===
          snapshot.configuration_hash;
      });
      if (matchingHashes.length !== 1) {
        throw new Error("Snapshot equipment setup checksum does not match its immutable identity.");
      }
    }
  }

  const selectionKeys = new Set<string>();
  for (const receipt of rows(payload, "session_equipment_selection_receipts")) {
    const exercise = exercises.get(String(receipt.session_exercise_id));
    const prior = receipt.prior_snapshot_id == null
      ? null
      : equipmentSnapshots.get(String(receipt.prior_snapshot_id));
    const result = receipt.resulting_snapshot_id == null
      ? null
      : equipmentSnapshots.get(String(receipt.resulting_snapshot_id));
    const key = `${String(receipt.session_exercise_id)}:${String(receipt.client_key)}`;
    if (
      selectionKeys.has(key) ||
      !exercise ||
      exercise.session_id !== receipt.session_id ||
      (prior && prior.session_exercise_id !== receipt.session_exercise_id) ||
      (result && result.session_exercise_id !== receipt.session_exercise_id) ||
      (receipt.prior_snapshot_id != null && !prior) ||
      (receipt.resulting_snapshot_id != null && !result) ||
      typeof receipt.canonical_payload_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(receipt.canonical_payload_hash)
    ) {
      throw new Error("Snapshot equipment selection receipt is invalid.");
    }
    selectionKeys.add(key);
  }

  const receiptKeys = new Set<string>();
  for (const receipt of rows(payload, "session_occurrence_mutations")) {
    const occurrence = occurrences.get(String(receipt.occurrence_id));
    const key = `${String(receipt.occurrence_id)}:${String(receipt.client_key)}`;
    if (receiptKeys.has(key)) {
      throw new Error("Snapshot occurrence mutation contains a duplicate client key.");
    }
    receiptKeys.add(key);
    if (
      !occurrence ||
      !Number.isInteger(Number(receipt.expected_revision)) ||
      !Number.isInteger(Number(receipt.resulting_revision)) ||
      Number(receipt.expected_revision) < 0 ||
      Number(receipt.resulting_revision) < Number(receipt.expected_revision) ||
      Number(receipt.resulting_revision) > Number(occurrence.revision) ||
      typeof receipt.canonical_payload_hash !== "string" ||
      receipt.canonical_payload_hash.length === 0
    ) {
      throw new Error("Snapshot occurrence mutation has invalid durable receipt state.");
    }
  }
}

export function validateSnapshotPayload(
  payload: CanonicalSnapshotPayload,
  userId: string
) {
  assertCanonicalSnapshotTableCoverage(payload.tables);
  if (
    ![
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      PLATE_QUANTITY_SNAPSHOT_SCHEMA_VERSION,
      PREVIOUS_SNAPSHOT_SCHEMA_VERSION,
      TRAINING_INTENT_SNAPSHOT_SCHEMA_VERSION,
      COMPILER_PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
      OCCURRENCE_SNAPSHOT_SCHEMA_VERSION,
      PRE_CONTEXTUAL_NOTE_SNAPSHOT_SCHEMA_VERSION,
      PRE_HISTORY_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
      PRE_PERFORMED_SEMANTICS_SNAPSHOT_SCHEMA_VERSION,
      PRE_START_SEMANTICS_SNAPSHOT_SCHEMA_VERSION,
      SNAPSHOT_SCHEMA_VERSION,
    ].includes(payload.schemaVersion)
  ) {
    throw new Error(
      `Snapshot schema ${payload.schemaVersion} is not supported by this app version.`
    );
  }
  const owners = rows(payload, "users");
  if (owners.length !== 1 || owners[0].id !== userId) {
    throw new Error("Snapshot owner does not match the signed-in user.");
  }
  for (const table of DIRECT_USER_OWNED_CAPTURE_TABLES) {
    for (const row of rows(payload, table)) {
      if (row.user_id !== userId) {
        throw new Error(`Snapshot table ${table} contains another user's record.`);
      }
    }
  }
  if (
    [
      "7",
      "8",
      "9",
      "10",
      "14",
      "15",
      "16",
      "17",
      "18",
      PLATE_QUANTITY_SNAPSHOT_SCHEMA_VERSION,
      PREVIOUS_SNAPSHOT_SCHEMA_VERSION,
      TRAINING_INTENT_SNAPSHOT_SCHEMA_VERSION,
      COMPILER_PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
      OCCURRENCE_SNAPSHOT_SCHEMA_VERSION,
      PRE_CONTEXTUAL_NOTE_SNAPSHOT_SCHEMA_VERSION,
      PRE_HISTORY_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
      PRE_PERFORMED_SEMANTICS_SNAPSHOT_SCHEMA_VERSION,
      PRE_START_SEMANTICS_SNAPSHOT_SCHEMA_VERSION,
      SNAPSHOT_SCHEMA_VERSION,
    ].includes(payload.schemaVersion)
  ) {
    for (const table of ["recovery_runs", "integrity_findings"]) {
      for (const row of rows(payload, table)) {
        if (row.user_id !== userId) {
          throw new Error(`Snapshot table ${table} contains another user's record.`);
        }
      }
    }
    requireReferences(payload, "integrity_findings", "run_id", "recovery_runs");
  }
  for (const exercise of rows(payload, "exercises")) {
    if (exercise.user_id !== null && exercise.user_id !== userId) {
      throw new Error("Snapshot exercise ownership is invalid.");
    }
  }

  requireReferences(payload, "program_versions", "program_id", "programs");
  requireReferences(payload, "program_drafts", "program_id", "programs");
  requireReferences(payload, "program_drafts", "base_version_id", "program_versions");
  requireOptionalReferences(
    payload,
    "program_drafts",
    "restored_from_version_id",
    "program_versions"
  );
  requireOptionalReferences(
    payload,
    "program_drafts",
    "published_version_id",
    "program_versions"
  );
  requireOptionalReferences(payload, "programs", "current_version_id", "program_versions");
  requireOptionalReferences(
    payload,
    "program_versions",
    "parent_version_id",
    "program_versions"
  );
  requireOptionalReferences(
    payload,
    "program_versions",
    "restored_from_version_id",
    "program_versions"
  );
  requireReferences(payload, "workout_templates", "program_version_id", "program_versions");
  requireReferences(payload, "superset_groups", "workout_template_id", "workout_templates");
  requireReferences(
    payload,
    "workout_template_exercises",
    "workout_template_id",
    "workout_templates"
  );
  requireReferences(
    payload,
    "exercise_prescriptions",
    "template_exercise_id",
    "workout_template_exercises"
  );
  requireReferences(payload, "session_compiler_proposals", "program_id", "programs");
  requireReferences(payload, "session_compiler_proposals", "program_version_id", "program_versions");
  requireReferences(payload, "session_compiler_proposals", "workout_template_id", "workout_templates");
  requireOptionalReferences(payload, "session_compiler_proposals", "accepted_session_id", "workout_sessions");
  requireReferences(payload, "session_exercise_groups", "session_id", "workout_sessions");
  requireOptionalReferences(
    payload,
    "session_exercise_groups",
    "source_group_id",
    "superset_groups"
  );
  requireReferences(payload, "session_exercises", "session_id", "workout_sessions");
  requireReferences(payload, "completed_sets", "session_exercise_id", "session_exercises");
  requireReferences(payload, "session_occurrences", "session_id", "workout_sessions");
  requireOptionalReferences(
    payload,
    "session_occurrences",
    "session_exercise_id",
    "session_exercises"
  );
  requireOptionalReferences(
    payload,
    "session_occurrences",
    "planned_exercise_id",
    "exercises"
  );
  requireOptionalReferences(
    payload,
    "session_occurrences",
    "group_snapshot_id",
    "session_exercise_groups"
  );
  requireOptionalReferences(
    payload,
    "session_occurrences",
    "completed_set_id",
    "completed_sets"
  );
  requireReferences(
    payload,
    "session_occurrence_mutations",
    "occurrence_id",
    "session_occurrences"
  );
  requireReferences(payload, "session_notes", "session_id", "workout_sessions");
  requireReferences(payload, "progression_jobs", "session_id", "workout_sessions");
  requireReferences(
    payload,
    "progression_job_input_sessions",
    "job_id",
    "progression_jobs"
  );
  requireReferences(
    payload,
    "progression_job_input_sessions",
    "session_id",
    "workout_sessions"
  );
  requireReferences(payload, "user_decisions", "recommendation_id", "recommendations");
  requireReferences(payload, "adaptation_events", "recommendation_id", "recommendations");
  requireReferences(payload, "archive_operation_records", "operation_id", "archive_operations");
  requireReferences(payload, "history_import_batches", "import_event_id", "import_events");
  requireReferences(payload, "external_exercise_mappings", "exercise_id", "exercises");
  requireReferences(payload, "workout_template_exercises", "exercise_id", "exercises");
  requireReferences(payload, "session_exercises", "exercise_id", "exercises");
  requireOptionalReferences(
    payload,
    "session_exercises",
    "substituted_for_exercise_id",
    "exercises"
  );
  for (const table of [
    "exercise_aliases",
    "exercise_sources",
    "exercise_equipment_requirements",
  ]) {
    requireReferences(payload, table, "exercise_id", "exercises");
  }
  if (
    [
      "10",
      "14",
      "15",
      "16",
      "17",
      "18",
      PLATE_QUANTITY_SNAPSHOT_SCHEMA_VERSION,
      PREVIOUS_SNAPSHOT_SCHEMA_VERSION,
      TRAINING_INTENT_SNAPSHOT_SCHEMA_VERSION,
      COMPILER_PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
      OCCURRENCE_SNAPSHOT_SCHEMA_VERSION,
      PRE_CONTEXTUAL_NOTE_SNAPSHOT_SCHEMA_VERSION,
      PRE_HISTORY_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
      PRE_PERFORMED_SEMANTICS_SNAPSHOT_SCHEMA_VERSION,
      PRE_START_SEMANTICS_SNAPSHOT_SCHEMA_VERSION,
      SNAPSHOT_SCHEMA_VERSION,
    ].includes(payload.schemaVersion)
  ) {
    requireReferences(
      payload,
      "exercise_media_associations",
      "asset_id",
      "exercise_media_assets"
    );
    requireOptionalReferences(
      payload,
      "exercise_media_associations",
      "exercise_id",
      "exercises"
    );
    requireOptionalReferences(
      payload,
      "exercise_media_associations",
      "family_id",
      "exercise_families"
    );
  }
  requireOptionalReferences(payload, "exercises", "family_id", "exercise_families");
  requireOptionalReferences(
    payload,
    "exercise_equipment_requirements",
    "equipment_definition_id",
    "equipment_definitions"
  );
  requireOptionalReferences(
    payload,
    "exercise_execution_requirements",
    "required_equipment_definition_id",
    "equipment_definitions"
  );
  requireOptionalReferences(
    payload,
    "exercise_execution_requirements",
    "required_attachment_definition_id",
    "equipment_definitions"
  );
  requireReferences(
    payload,
    "exercise_execution_requirements",
    "exercise_id",
    "exercises"
  );
  requireReferences(payload, "plate_loaded_machine_profiles", "equipment_item_id", "equipment_items");
  requireReferences(payload, "plate_loaded_machine_compatible_plates", "machine_profile_id", "plate_loaded_machine_profiles");
  requireReferences(payload, "plate_loaded_machine_compatible_plates", "plate_inventory_id", "plate_inventory");
  requireReferences(payload, "cable_machine_profiles", "equipment_item_id", "equipment_items");
  requireReferences(payload, "cable_stack_steps", "cable_profile_id", "cable_machine_profiles");
  requireReferences(payload, "cable_attachment_profiles", "equipment_item_id", "equipment_items");
  requireReferences(payload, "cable_attachment_compatibilities", "cable_profile_id", "cable_machine_profiles");
  requireReferences(payload, "cable_attachment_compatibilities", "attachment_profile_id", "cable_attachment_profiles");
  requireReferences(payload, "session_equipment_snapshots", "session_id", "workout_sessions");
  requireReferences(payload, "session_equipment_snapshots", "session_exercise_id", "session_exercises");
  requireOptionalReferences(payload, "session_exercises", "current_equipment_snapshot_id", "session_equipment_snapshots");
  requireOptionalReferences(payload, "completed_sets", "equipment_snapshot_id", "session_equipment_snapshots");
  requireOptionalReferences(payload, "session_occurrences", "equipment_snapshot_id", "session_equipment_snapshots");
  requireReferences(payload, "session_equipment_selection_receipts", "session_id", "workout_sessions");
  requireReferences(payload, "session_equipment_selection_receipts", "session_exercise_id", "session_exercises");
  requireOptionalReferences(payload, "session_equipment_selection_receipts", "prior_snapshot_id", "session_equipment_snapshots");
  requireOptionalReferences(payload, "session_equipment_selection_receipts", "resulting_snapshot_id", "session_equipment_snapshots");
  requireOptionalReferences(
    payload,
    "equipment_items",
    "definition_id",
    "equipment_definitions"
  );
  requireOptionalReferences(payload, "workout_sessions", "template_id", "workout_templates");
  requireOptionalReferences(
    payload,
    "workout_sessions",
    "import_batch_id",
    "history_import_batches"
  );
  requireOptionalReferences(payload, "pain_logs", "session_id", "workout_sessions");
  requireOptionalReferences(payload, "pain_logs", "exercise_id", "exercises");
  requireOptionalReferences(payload, "pain_logs", "completed_set_id", "completed_sets");
  requireOptionalReferences(payload, "fatigue_logs", "session_id", "workout_sessions");
  requireOptionalReferences(
    payload,
    "ai_parsing_events",
    "result_session_id",
    "workout_sessions"
  );
  requireOptionalReferences(
    payload,
    "coaching_insights",
    "session_id",
    "workout_sessions"
  );
  requireOptionalReferences(
    payload,
    "coaching_insights",
    "session_exercise_id",
    "session_exercises"
  );
  requireOptionalReferences(
    payload,
    "coaching_insights",
    "completed_set_id",
    "completed_sets"
  );
  requireOptionalReferences(
    payload,
    "coaching_insights",
    "reply_to_id",
    "coaching_insights"
  );
  requireOptionalReferences(payload, "contextual_notes", "session_id", "workout_sessions");
  requireOptionalReferences(payload, "contextual_notes", "session_exercise_id", "session_exercises");
  requireOptionalReferences(payload, "contextual_notes", "occurrence_id", "session_occurrences");
  requireOptionalReferences(payload, "contextual_notes", "completed_set_id", "completed_sets");
  requireOptionalReferences(payload, "contextual_notes", "program_id", "programs");
  requireOptionalReferences(payload, "contextual_notes", "program_version_id", "program_versions");
  requireOptionalReferences(payload, "contextual_notes", "workout_template_id", "workout_templates");
  requireOptionalReferences(payload, "contextual_notes", "workout_template_exercise_id", "workout_template_exercises");
  requireReferences(payload, "contextual_note_revisions", "note_id", "contextual_notes");
  requireOptionalReferences(payload, "recommendations", "exercise_id", "exercises");
  requireOptionalReferences(
    payload,
    "recommendations",
    "progression_job_id",
    "progression_jobs"
  );
  requireOptionalReferences(
    payload,
    "recommendations",
    "source_template_exercise_id",
    "workout_template_exercises"
  );
  requireOptionalReferences(
    payload,
    "recommendations",
    "reconciled_by_program_version_id",
    "program_versions"
  );
  for (const table of [
    "programs",
    "workout_sessions",
    "completed_sets",
    "pain_logs",
    "fatigue_logs",
    "health_activities",
    "recommendations",
    "coaching_insights",
    "contextual_notes",
    "history_import_batches",
  ]) {
    requireOptionalReferences(payload, table, "archive_operation_id", "archive_operations");
  }
  if (payload.schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
    validateUnitAndCalendarIdentity(payload);
    validateStartAndPrescribedSemantics(payload);
    validateVersionedProgramData(payload);
    validateSessionCompilerIdentity(payload);
    validateSessionOccurrenceData(payload);
    validateContextualNoteData(payload);
    validateHistoryIdentityAndTiming(payload);
  }
}

function targetRows(
  payload: CanonicalSnapshotPayload,
  userId: string,
  scope: SnapshotRestoreScope
): RestoreRows {
  const tableNames =
    scope === "full"
      ? [...FULL_RESTORE_TARGET_TABLES, ...FULL_RESTORE_MERGE_TABLES]
      : [...HISTORY_RESTORE_TARGET_TABLES, ...HISTORY_RESTORE_MERGE_TABLES];
  const result: RestoreRows = {};
  const customExerciseIds = new Set(
    rows(payload, "exercises")
      .filter((row) => row.user_id === userId)
      .map((row) => String(row.id))
  );
  const historyContextualNoteIds = new Set(
    rows(payload, "contextual_notes")
      .filter((row) => scope === "full" || row.session_id != null)
      .map((row) => String(row.id))
  );
  const snapshotCompletedSetIds = new Set(
    rows(payload, "completed_sets").map((row) => String(row.id)),
  );
  for (const table of tableNames) {
    const tableRows = rows(payload, table);
    if (table === "contextual_notes" && scope === "history") {
      result[table] = tableRows.filter((row) => row.session_id != null);
    } else if (table === "contextual_note_revisions" && scope === "history") {
      result[table] = tableRows.filter((row) =>
        historyContextualNoteIds.has(String(row.note_id))
      );
    } else if (table === "exercises") {
      result[table] = tableRows.filter((row) => row.user_id === userId);
    } else if (table === "record_versions") {
      // T02 activates merge semantics only for performed-set version chains.
      // Other version types keep the established preserve-at-destination
      // behavior until their own restore packages define a bridge transition.
      result[table] = tableRows.filter(
        (row) =>
          row.user_id === userId &&
          row.entity_type === "completed_set" &&
          (scope === "full" ||
            snapshotCompletedSetIds.has(String(row.entity_id))),
      );
    } else if (
      table === "exercise_aliases" ||
      table === "exercise_sources" ||
      table === "exercise_equipment_requirements" ||
      table === "exercise_execution_requirements"
    ) {
      result[table] = tableRows.filter((row) =>
        customExerciseIds.has(String(row.exercise_id))
      );
    } else {
      result[table] = tableRows;
    }
  }
  return result;
}

function dependencyRows(
  payload: CanonicalSnapshotPayload,
  userId: string,
  scope: SnapshotRestoreScope
): RestoreRows {
  const customExerciseIds = new Set(
    rows(payload, "exercises")
      .filter((row) => row.user_id === userId)
      .map((row) => String(row.id))
  );
  const globalExerciseIds = new Set(
    rows(payload, "exercises")
      .filter((row) => row.user_id === null)
      .map((row) => String(row.id))
  );
  const result: RestoreRows = {
    equipment_definitions: rows(payload, "equipment_definitions"),
    exercise_families: rows(payload, "exercise_families"),
  };
  const exerciseIds = scope === "full" ? globalExerciseIds : new Set([...globalExerciseIds, ...customExerciseIds]);
  result.exercises = rows(payload, "exercises").filter((row) =>
    exerciseIds.has(String(row.id))
  );
  for (const table of [
    "exercise_aliases",
    "exercise_sources",
    "exercise_equipment_requirements",
  ]) {
    result[table] = rows(payload, table).filter((row) =>
      exerciseIds.has(String(row.exercise_id))
    );
  }
  // Global exact-execution rules are release-owned catalog policy. A user's
  // backup can carry the historical copy as evidence, but restore must never
  // replace or roll back the currently released global rule. Requirements for
  // the user's own custom exercises remain restorable dependencies.
  result.exercise_execution_requirements = rows(
    payload,
    "exercise_execution_requirements"
  ).filter(
    (row) =>
      scope === "history" && customExerciseIds.has(String(row.exercise_id))
  );
  if (scope === "history") {
    for (const table of [
      "archive_operations",
      "import_events",
      "programs",
      "program_versions",
      "workout_templates",
      "superset_groups",
      "workout_template_exercises",
      "exercise_prescriptions",
    ]) {
      result[table] = rows(payload, table);
    }
    const restoredSessionIds = new Set(
      rows(payload, "workout_sessions").map((row) => String(row.id))
    );
    result.session_compiler_proposals = rows(
      payload,
      "session_compiler_proposals"
    ).filter(
      (row) =>
        row.accepted_session_id != null &&
        restoredSessionIds.has(String(row.accepted_session_id))
    );
  }
  return result;
}

function compareRows(current: SnapshotRow[], target: SnapshotRow[]) {
  const currentById = new Map(current.map((row) => [String(row.id), row]));
  const targetById = new Map(target.map((row) => [String(row.id), row]));
  let added = 0;
  let updated = 0;
  let removed = 0;
  let unchanged = 0;
  for (const [id, targetRow] of targetById) {
    const currentRow = currentById.get(id);
    if (!currentRow) added += 1;
    else if (canonicalJson(currentRow) === canonicalJson(targetRow)) unchanged += 1;
    else updated += 1;
  }
  for (const id of currentById.keys()) {
    if (!targetById.has(id)) removed += 1;
  }
  return { added, updated, removed, unchanged };
}

function compareMergedRows(current: SnapshotRow[], target: SnapshotRow[]) {
  const compared = compareRows(current, target);
  return { ...compared, removed: 0 };
}

function buildPlan(
  currentPayload: CanonicalSnapshotPayload,
  sourcePayload: CanonicalSnapshotPayload,
  userId: string,
  scope: SnapshotRestoreScope
) {
  const expectedCurrent = targetRows(currentPayload, userId, scope);
  const desired = targetRows(sourcePayload, userId, scope);
  const dependencies = dependencyRows(sourcePayload, userId, scope);
  const tables = Object.keys(desired).map((table) => {
    const restoreMode = RECOVERY_MANIFEST_BY_TABLE[table]?.restore[scope];
    return {
      table,
      label: RECOVERY_MANIFEST_BY_TABLE[table]?.label ?? table,
      current: expectedCurrent[table].length,
      snapshot: desired[table].length,
      ...(restoreMode === "merge"
        ? compareMergedRows(expectedCurrent[table], desired[table])
        : compareRows(expectedCurrent[table], desired[table])),
    };
  });
  const totals = tables.reduce(
    (sum, table) => ({
      added: sum.added + table.added,
      updated: sum.updated + table.updated,
      removed: sum.removed + table.removed,
      unchanged: sum.unchanged + table.unchanged,
    }),
    { added: 0, updated: 0, removed: 0, unchanged: 0 }
  );
  const fingerprint = sha256Hex(
    Buffer.from(canonicalJson({ scope, expectedCurrent, desired }), "utf8")
  );
  return { expectedCurrent, desired, dependencies, tables, totals, fingerprint };
}

function restoreError(error: unknown) {
  const message =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : "Snapshot restore failed.";
  if (message.includes("Restore preview is stale")) {
    return "Your data changed after this preview. Nothing was restored; refresh the preview and review it again.";
  }
  return message.slice(0, 500);
}

export async function getSnapshotRestorePreview(
  db: Db,
  userId: string,
  snapshotId: string,
  scope: SnapshotRestoreScope,
  dependencies: Pick<SnapshotDependencies, "store" | "keyring"> = {}
) {
  const { snapshot, payload } = await readVerifiedDataSnapshot(
    db,
    userId,
    snapshotId,
    dependencies
  );
  const upgradedPayload = upgradeSnapshotPayload(payload);
  validateSnapshotPayload(upgradedPayload, userId);
  const current = await captureUserSnapshot(
    db,
    userId,
    new Date(),
    "restore-preview",
    { normalizeProgramDrafts: false }
  );
  validateSnapshotPayload(
    normalizeSnapshotProgramDrafts(structuredClone(current)),
    userId
  );
  const plan = buildPlan(current, upgradedPayload, userId, scope);
  const consequences = analyzeHistoricalSemanticsPayload(
    upgradedPayload,
    userId,
  );
  return {
    snapshot: {
      id: snapshot.id,
      name: snapshot.name,
      note: snapshot.note,
      createdAt: snapshot.createdAt,
      verifiedAt: snapshot.verifiedAt,
      schemaVersion: snapshot.schemaVersion,
    },
    scope,
    tables: plan.tables,
    totals: plan.totals,
    fingerprint: plan.fingerprint,
    consequences,
  };
}

export async function restoreDataSnapshot(
  db: Db,
  userId: string,
  input: {
    snapshotId: string;
    scope: SnapshotRestoreScope;
    previewFingerprint: string;
    confirmation: string;
  },
  dependencies: SnapshotDependencies & { failAfterTable?: string } = {}
) {
  if (input.confirmation !== "RESTORE") {
    return { ok: false as const, reason: "Type RESTORE exactly to confirm." };
  }
  try {
    const source = await readVerifiedDataSnapshot(db, userId, input.snapshotId, dependencies);
    const sourcePayload = upgradeSnapshotPayload(source.payload);
    validateSnapshotPayload(sourcePayload, userId);
    const currentBeforeSafety = await captureUserSnapshot(
      db,
      userId,
      new Date(),
      "restore-check",
      { normalizeProgramDrafts: false }
    );
    validateSnapshotPayload(
      normalizeSnapshotProgramDrafts(structuredClone(currentBeforeSafety)),
      userId
    );
    const previewPlan = buildPlan(
      currentBeforeSafety,
      sourcePayload,
      userId,
      input.scope
    );
    if (previewPlan.fingerprint !== input.previewFingerprint) {
      return {
        ok: false as const,
        reason:
          "Your data changed after this preview. Nothing was restored; refresh the preview and review it again.",
      };
    }

    const safety = await createAutomaticSafetySnapshot(
      db,
      userId,
      `before ${input.scope} restore`,
      `Automatic safety copy created before restoring “${source.snapshot.name}” (${input.scope} scope).`,
      dependencies
    );
    if (!safety.ok) {
      return {
        ok: false as const,
        reason: `Nothing was restored because the safety snapshot could not be verified: ${safety.reason}`,
      };
    }

    const current = await captureUserSnapshot(
      db,
      userId,
      new Date(),
      "restore-execution",
      { normalizeProgramDrafts: false }
    );
    validateSnapshotPayload(
      normalizeSnapshotProgramDrafts(structuredClone(current)),
      userId
    );
    const plan = buildPlan(current, sourcePayload, userId, input.scope);
    if (plan.fingerprint !== input.previewFingerprint) {
      return {
        ok: false as const,
        reason:
          "Your data changed while the safety copy was being created. Nothing was restored; refresh the preview and review it again.",
        safetySnapshotId: safety.snapshotId,
      };
    }

    const query = sql`
      SELECT restore_user_snapshot(
        ${userId}::uuid,
        ${input.scope}::text,
        ${JSON.stringify(plan.expectedCurrent)}::jsonb,
        ${JSON.stringify(plan.desired)}::jsonb,
        ${JSON.stringify(plan.dependencies)}::jsonb,
        ${input.snapshotId}::uuid,
        ${safety.snapshotId}::uuid,
        ${dependencies.failAfterTable ?? null}::text
      ) AS result
    `;
    const row = resultRows(await db.execute(query))[0];
    const result = row?.result as
      | { scope: SnapshotRestoreScope; restoredRecords: number }
      | undefined;
    if (!result) throw new Error("Database did not confirm the snapshot restore.");
    return {
      ok: true as const,
      scope: result.scope,
      restoredRecords: Number(result.restoredRecords),
      safetySnapshotId: safety.snapshotId,
    };
  } catch (error) {
    return { ok: false as const, reason: restoreError(error) };
  }
}
