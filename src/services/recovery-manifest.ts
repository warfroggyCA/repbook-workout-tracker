export const RECOVERY_MANIFEST_VERSION = 12 as const;

export type RecoveryOwnership =
  | "direct_user"
  | "parent_chain"
  | "shared_catalog"
  | "operational_user"
  | "security_ephemeral";

export type RecoveryCapture =
  | "canonical"
  | "excluded_operational"
  | "excluded_security";

export type RecoveryRestoreMode =
  | "replace"
  | "dependency"
  | "mixed_dependency_and_replace"
  | "merge"
  | "preserve";

export type RecoveryManifestEntry = {
  table: string;
  label: string;
  ownership: RecoveryOwnership;
  ownershipPath: string;
  dependencies: string[];
  capture: RecoveryCapture;
  restore: { full: RecoveryRestoreMode; history: RecoveryRestoreMode };
  restoreOrder: { full: string; history: string };
  archiveBehavior: string;
  permanentDeleteBehavior: string;
  retentionClass: string;
  integrityChecks: string[];
};

function entry(
  table: string,
  label: string,
  ownership: RecoveryOwnership,
  ownershipPath: string,
  dependencies: string[],
  capture: RecoveryCapture,
  full: RecoveryRestoreMode,
  history: RecoveryRestoreMode,
  archiveBehavior: string,
  permanentDeleteBehavior: string,
  retentionClass: string,
  integrityChecks: string[]
): RecoveryManifestEntry {
  const order = (mode: RecoveryRestoreMode) => {
    if (mode === "preserve") return "preserve destination row";
    if (mode === "merge") {
      return "merge immutable source rows, reject contradictory identity reuse, and preserve destination-only rows";
    }
    if (mode === "dependency") return "reconcile before dependent owned rows";
    if (mode === "mixed_dependency_and_replace") {
      return "reconcile global dependencies, then replace owned rows; delete owned children first";
    }
    return dependencies.length
      ? `reconcile ${dependencies.join(", ")} first; delete dependent children before parent`
      : "insert before dependent children; delete after dependent children";
  };
  return {
    table,
    label,
    ownership,
    ownershipPath,
    dependencies,
    capture,
    restore: { full, history },
    restoreOrder: { full: order(full), history: order(history) },
    archiveBehavior,
    permanentDeleteBehavior,
    retentionClass,
    integrityChecks,
  };
}

const durable = "durable_until_protected_permanent_delete";
const linked = "archived_with_root_and_restored_with_root";
const cascade = "deleted_only_by_protected_dependency_order";
const preserve = "not_independently_archived";

export const RECOVERY_TABLE_MANIFEST = [
  entry("users", "Account", "direct_user", "users.id", [], "canonical", "preserve", "preserve", preserve, "account deletion boundary only", durable, ["exactly one signed-in owner"]),
  entry("user_profiles", "Profile", "direct_user", "user_profiles.user_id", ["users"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner", "valid timezone", "valid unit"]),
  entry("constraints", "Safety constraints", "direct_user", "constraints.user_id", ["users"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner"]),
  entry("equipment_definitions", "Equipment definitions", "shared_catalog", "referenced by owned equipment or captured exercises", [], "canonical", "dependency", "dependency", preserve, "catalog release lifecycle", "catalog_release", ["referenced definition exists"]),
  entry("equipment_items", "Equipment", "direct_user", "equipment_items.user_id", ["users", "equipment_definitions"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner", "definition reference"]),
  entry("plate_inventory", "Plate inventory", "direct_user", "plate_inventory.user_id", ["users"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner"]),
  entry("barbell_configs", "Bar settings", "direct_user", "barbell_configs.user_id", ["users"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner"]),
  entry("plate_loaded_machine_profiles", "Plate-loaded machine profiles", "direct_user", "plate_loaded_machine_profiles.user_id", ["users", "equipment_items"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner", "exact equipment item", "known geometry completeness"]),
  entry("plate_loaded_machine_compatible_plates", "Machine-compatible plates", "direct_user", "plate_loaded_machine_compatible_plates.user_id", ["plate_loaded_machine_profiles", "plate_inventory"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner", "machine profile", "owned plate row"]),
  entry("cable_machine_profiles", "Cable machine profiles", "direct_user", "cable_machine_profiles.user_id", ["users", "equipment_items"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner", "exact equipment item", "stack topology", "ratio certainty"]),
  entry("cable_stack_steps", "Cable stack steps", "direct_user", "cable_stack_steps.user_id", ["cable_machine_profiles"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner", "cable profile", "stack and step order"]),
  entry("cable_attachment_profiles", "Cable attachment profiles", "direct_user", "cable_attachment_profiles.user_id", ["users", "equipment_items"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner", "exact attachment item", "attachment kind"]),
  entry("cable_attachment_compatibilities", "Cable attachment compatibility", "direct_user", "cable_attachment_compatibilities.user_id", ["cable_machine_profiles", "cable_attachment_profiles"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner", "exact cable profile", "exact attachment profile"]),
  entry("exercise_families", "Exercise families", "shared_catalog", "referenced by captured exercises or media", [], "canonical", "dependency", "dependency", preserve, "catalog release lifecycle", "catalog_release", ["referenced family exists"]),
  entry("exercises", "Exercises", "shared_catalog", "global rows plus exercises.user_id", ["users", "exercise_families"], "canonical", "mixed_dependency_and_replace", "dependency", linked, cascade, durable, ["global-or-owner", "family reference"]),
  entry("exercise_sources", "Exercise sources", "parent_chain", "exercise_sources.exercise_id -> exercises.user_id", ["exercises"], "canonical", "mixed_dependency_and_replace", "dependency", linked, cascade, durable, ["exercise reference"]),
  entry("exercise_media_assets", "Exercise media assets", "shared_catalog", "referenced by captured media associations", [], "canonical", "dependency", "dependency", preserve, "catalog release lifecycle", "catalog_release", ["referenced asset exists"]),
  entry("exercise_media_associations", "Exercise media links", "shared_catalog", "captured exercise or family reference", ["exercise_media_assets", "exercises", "exercise_families"], "canonical", "dependency", "dependency", preserve, "catalog release lifecycle", "catalog_release", ["asset reference", "exercise-or-family reference"]),
  entry("exercise_aliases", "Exercise aliases", "parent_chain", "exercise_aliases.exercise_id -> exercises.user_id", ["exercises"], "canonical", "mixed_dependency_and_replace", "dependency", linked, cascade, durable, ["exercise reference"]),
  entry("external_exercise_mappings", "Reviewed exercise mappings", "direct_user", "external_exercise_mappings.user_id", ["users", "exercises"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner", "exercise reference"]),
  entry("exercise_equipment_requirements", "Exercise requirements", "parent_chain", "exercise_equipment_requirements.exercise_id -> exercises.user_id", ["exercises", "equipment_definitions"], "canonical", "mixed_dependency_and_replace", "dependency", linked, cascade, durable, ["exercise reference", "equipment definition reference"]),
  entry("exercise_execution_requirements", "Exact execution requirements", "parent_chain", "exercise_execution_requirements.exercise_id -> exercises.user_id", ["exercises", "equipment_definitions"], "canonical", "mixed_dependency_and_replace", "dependency", linked, cascade, durable, ["exercise reference", "reviewed exact profile and attachment requirements"]),
  entry("programs", "Programs", "direct_user", "programs.user_id", ["users"], "canonical", "replace", "dependency", linked, cascade, durable, ["owner", "one current active program"]),
  entry("program_versions", "Program versions", "parent_chain", "program_versions.program_id -> programs.user_id", ["programs"], "canonical", "replace", "dependency", linked, cascade, durable, ["program reference"]),
  entry("program_drafts", "Program drafts", "direct_user", "program_drafts.user_id", ["users", "programs", "program_versions"], "canonical", "replace", "preserve", preserve, cascade, durable, ["owner", "program, base, restore-source, and published version references", "revision and review state", "validated document and content hash"]),
  entry("workout_templates", "Workout templates", "parent_chain", "workout_templates.program_version_id -> programs.user_id", ["program_versions"], "canonical", "replace", "dependency", linked, cascade, durable, ["program version reference", "day warm-up guidance"]),
  entry("superset_groups", "Superset groups", "parent_chain", "superset_groups.workout_template_id -> programs.user_id", ["workout_templates"], "canonical", "replace", "dependency", linked, cascade, durable, ["workout template reference"]),
  entry("workout_template_exercises", "Planned exercises", "parent_chain", "workout_template_exercises.workout_template_id -> programs.user_id", ["workout_templates", "exercises"], "canonical", "replace", "dependency", linked, cascade, durable, ["template reference", "exercise reference", "load unit"]),
  entry("exercise_prescriptions", "Exercise targets", "parent_chain", "exercise_prescriptions.template_exercise_id -> programs.user_id", ["workout_template_exercises"], "canonical", "replace", "dependency", linked, cascade, durable, ["planned exercise reference", "load unit", "one current prescription"]),
  entry("session_compiler_proposals", "Session compiler proposals", "direct_user", "session_compiler_proposals.user_id", ["users", "programs", "program_versions", "workout_templates", "workout_sessions"], "canonical", "replace", "dependency", "accepted proposal follows its workout; open and declined proposals remain review records", cascade, durable, ["owner", "schema-2 source", "immutable input/output and hash", "one-way disposition", "accepted workout reference"]),
  entry("workout_sessions", "Workouts", "direct_user", "workout_sessions.user_id", ["users", "programs", "program_versions", "workout_templates", "history_import_batches", "archive_operations"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "timezone/local date", "one active workout", "owner-scoped immutable Start request identity and canonical payload hash", "history revision", "performed-time precision", "all-or-none source Program lineage", "snapshotted day warm-up guidance", "immutable accepted compiler provenance"]),
  entry("session_exercise_groups", "Workout exercise groups", "parent_chain", "session_exercise_groups.session_id -> workout_sessions.user_id", ["workout_sessions", "superset_groups"], "canonical", "replace", "replace", linked, cascade, durable, ["workout reference", "same-workout membership", "round and rest snapshot"]),
  entry("session_exercises", "Workout exercises", "parent_chain", "session_exercises.session_id -> workout_sessions.user_id", ["workout_sessions", "exercises", "session_exercise_groups"], "canonical", "replace", "replace", linked, cascade, durable, ["workout reference", "exercise reference", "load unit", "same-workout group membership", "stable source slot lineage", "immutable nullable prescribed name, metric, load type, and load semantics snapshot"]),
  entry("session_equipment_snapshots", "Performed equipment setups", "parent_chain", "session_equipment_snapshots.session_id -> workout_sessions.user_id", ["workout_sessions", "session_exercises"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "same-workout exercise", "immutable versioned geometry", "configuration hash"]),
  entry("completed_sets", "Completed sets", "parent_chain", "completed_sets.session_exercise_id -> workout_sessions.user_id", ["session_exercises"], "canonical", "replace", "replace", linked, cascade, durable, ["workout exercise reference", "stable client identity", "load unit", "immutable versioned performed measurement and load semantics", "nullable RIR-or-RPE, technique, and limitation evidence", "immutable server recording time", "nullable observed completion with provenance and quality"]),
  entry("session_occurrences", "Workout occurrences", "parent_chain", "session_occurrences.session_id -> workout_sessions.user_id", ["workout_sessions", "session_exercises", "session_exercise_groups", "exercises", "completed_sets"], "canonical", "replace", "replace", linked, cascade, durable, ["workout and exercise ownership", "unique sequence", "immutable plan snapshot", "explicit outcome", "performed result link"]),
  entry("session_occurrence_mutations", "Workout occurrence receipts", "parent_chain", "session_occurrence_mutations.occurrence_id -> workout_sessions.user_id", ["session_occurrences"], "canonical", "replace", "replace", linked, cascade, durable, ["occurrence ownership", "unique client key", "revision and payload hash"]),
  entry("session_equipment_selection_receipts", "Equipment selection receipts", "direct_user", "session_equipment_selection_receipts.user_id", ["workout_sessions", "session_exercises", "session_equipment_snapshots"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "same-workout exercise", "UUID client identity", "immutable payload hash"]),
  entry("pain_logs", "Pain records", "direct_user", "pain_logs.user_id", ["users", "workout_sessions", "exercises", "completed_sets", "archive_operations"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "optional workout/exercise reference", "set-linked evidence matches one owner, workout, and exercise", "at most one active pain flag per completed set"]),
  entry("fatigue_logs", "Fatigue records", "direct_user", "fatigue_logs.user_id", ["users", "workout_sessions", "archive_operations"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "optional workout reference"]),
  entry("session_notes", "Workout notes", "parent_chain", "session_notes.session_id -> workout_sessions.user_id", ["workout_sessions"], "canonical", "replace", "replace", linked, cascade, durable, ["workout reference"]),
  entry("contextual_notes", "Contextual training notes", "direct_user", "contextual_notes.user_id", ["users", "programs", "program_versions", "workout_templates", "workout_template_exercises", "workout_sessions", "session_exercises", "session_occurrences", "completed_sets", "archive_operations"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "stable client identity", "attachment kind matches its references", "same-owner and same-workout references", "planned-versus-performed context", "explicit Coach visibility", "revision and origin"]),
  entry("contextual_note_revisions", "Contextual note revisions", "direct_user", "contextual_note_revisions.user_id", ["users", "contextual_notes"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "note reference", "strict revision chain", "stable revision client identity", "immutable payload hash"]),
  entry("progression_jobs", "Progression jobs", "direct_user", "progression_jobs.user_id", ["users", "workout_sessions"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "workout reference", "source workout revision", "lease state", "stale-revision refusal"]),
  entry("progression_job_input_sessions", "Progression input revisions", "direct_user", "progression_job_input_sessions.user_id", ["users", "progression_jobs", "workout_sessions"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "job reference", "source slot lineage", "exact input workout revision", "unique job-lineage-workout membership"]),
  entry("health_activities", "Activities", "direct_user", "health_activities.user_id", ["users", "archive_operations"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "timezone/local date", "measurement units"]),
  entry("recommendations", "Recommendations", "direct_user", "recommendations.user_id", ["users", "exercises", "progression_jobs", "workout_template_exercises", "archive_operations"], "canonical", "replace", "merge", linked, cascade, durable, ["owner", "source references", "decision consistency", "history restore never downgrades a terminal recommendation to pending", "versioned evidence and proposed future effect", "review and defer revisions", "coherent durable defer state"]),
  entry("user_decisions", "Recommendation decisions", "parent_chain", "user_decisions.recommendation_id -> recommendations.user_id", ["recommendations"], "canonical", "replace", "merge", linked, cascade, durable, ["recommendation reference", "one decision", "immutable evidence and proposal snapshot at decision time"]),
  entry("adaptation_events", "Applied adaptations", "direct_user", "adaptation_events.user_id", ["users", "recommendations"], "canonical", "replace", "merge", linked, cascade, durable, ["owner", "recommendation reference", "one adaptation"]),
  entry("coaching_insights", "Coaching insights", "direct_user", "coaching_insights.user_id", ["users", "workout_sessions", "session_exercises", "completed_sets", "coaching_insights", "archive_operations"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "reply graph", "generation state", "minimal retained context"]),
  entry("ai_usage_events", "AI usage telemetry", "operational_user", "ai_usage_events.user_id", ["users"], "excluded_operational", "preserve", "preserve", preserve, "cascade with account", "operational_90_days", ["owner", "lease state", "prompt-free fields"]),
  entry("ai_parsing_events", "Reviewed AI input", "direct_user", "ai_parsing_events.user_id", ["users", "workout_sessions"], "canonical", "replace", "preserve", preserve, cascade, "temporary_raw_then_durable_provenance", ["owner", "result workout reference", "raw privacy boundary"]),
  entry("import_events", "Imports", "direct_user", "import_events.user_id", ["users"], "canonical", "replace", "dependency", preserve, cascade, "temporary_raw_then_durable_provenance", ["owner", "one current Hevy stage", "raw privacy boundary"]),
  entry("history_import_batches", "History imports", "direct_user", "history_import_batches.user_id", ["users", "import_events", "archive_operations"], "canonical", "replace", "replace", linked, cascade, durable, ["owner", "import reference", "timezone"]),
  entry("export_events", "Export ledger", "operational_user", "export_events.user_id", ["users"], "canonical", "preserve", "preserve", preserve, "cascade with account", "durable_audit", ["owner"]),
  entry("analysis_package_manifests", "External-analysis package manifests", "operational_user", "analysis_package_manifests.user_id", ["users"], "excluded_operational", "preserve", "preserve", preserve, "cascade with account, owner delete, or privacy expiry", "thirty_day_owner_scoped_manifest", ["owner", "schema and semantic version", "canonical digest", "source bindings", "expiry", "no raw package retention"]),
  entry("expensive_operation_leases", "Expensive-operation controls", "operational_user", "expensive_operation_leases.user_id", ["users"], "excluded_operational", "preserve", "preserve", preserve, "cascade with account", "operational_control_state", ["owner", "lease state", "supported operation kind"]),
  entry("audit_logs", "Audit log", "operational_user", "audit_logs.user_id", ["users"], "canonical", "preserve", "preserve", preserve, "cascade with account", "durable_audit", ["owner"]),
  entry("archive_operations", "Archive actions", "direct_user", "archive_operations.user_id", ["users"], "canonical", "replace", "dependency", "root archive ledger", cascade, durable, ["owner", "archive membership"]),
  entry("permanent_delete_grants", "Permanent-delete grants", "security_ephemeral", "permanent_delete_grants.user_id", ["users", "archive_operations"], "excluded_security", "preserve", "preserve", preserve, "consumed or short expiry", "security_short_lived", ["owner", "expiry", "single use"]),
  entry("archive_operation_records", "Archive membership", "direct_user", "archive_operation_records.user_id", ["users", "archive_operations"], "canonical", "replace", "preserve", "membership ledger", cascade, durable, ["owner", "operation reference", "unique member"]),
  entry("record_versions", "Version history", "operational_user", "record_versions.user_id", ["users"], "canonical", "merge", "merge", preserve, "T02 merges performed-set chains; other version types remain preserved at the destination until their own bridge contract; deletion otherwise follows the reviewed entity or account", durable, ["owner", "immutable identity", "version chain", "performed-set snapshot lineage merge"]),
  entry("data_snapshots", "Snapshot metadata", "operational_user", "data_snapshots.user_id", ["users", "archive_operations"], "canonical", "preserve", "preserve", preserve, "object and metadata lifecycle together", "snapshot_lifecycle_policy", ["owner", "verification metadata", "record counts", "deletion tombstone"]),
  entry("recovery_runs", "Recovery runs", "operational_user", "recovery_runs.user_id", ["users"], "canonical", "preserve", "preserve", preserve, "cascade with account", "durable_recovery_evidence", ["owner", "status", "time order"]),
  entry("integrity_findings", "Integrity findings", "operational_user", "integrity_findings.user_id", ["users", "recovery_runs"], "canonical", "preserve", "preserve", preserve, "cascade with recovery run", "durable_recovery_evidence", ["owner", "recovery run reference", "severity"]),
] as const satisfies readonly RecoveryManifestEntry[];

export const RECOVERY_MANIFEST_BY_TABLE = Object.fromEntries(
  RECOVERY_TABLE_MANIFEST.map((item) => [item.table, item])
) as Record<string, RecoveryManifestEntry>;

export const CANONICAL_CAPTURE_TABLES = RECOVERY_TABLE_MANIFEST
  .filter((item) => item.capture === "canonical")
  .map((item) => item.table);

export const DIRECT_USER_OWNED_CAPTURE_TABLES = RECOVERY_TABLE_MANIFEST
  .filter(
    (item) =>
      item.capture === "canonical" &&
      (item.ownership === "direct_user" || item.ownership === "operational_user") &&
      item.table !== "users"
  )
  .map((item) => item.table);

export const FULL_RESTORE_TARGET_TABLES = RECOVERY_TABLE_MANIFEST
  .filter(
    (item) =>
      item.restore.full === "replace" ||
      item.restore.full === "mixed_dependency_and_replace"
  )
  .map((item) => item.table);

export const HISTORY_RESTORE_TARGET_TABLES = RECOVERY_TABLE_MANIFEST
  .filter((item) => item.restore.history === "replace")
  .map((item) => item.table);

export const FULL_RESTORE_MERGE_TABLES = RECOVERY_TABLE_MANIFEST
  .filter((item) => item.restore.full === "merge")
  .map((item) => item.table);

export const HISTORY_RESTORE_MERGE_TABLES = RECOVERY_TABLE_MANIFEST
  .filter((item) => item.restore.history === "merge")
  .map((item) => item.table);

export function assertCanonicalSnapshotTableCoverage(
  tables: Record<string, unknown[]>
) {
  const actual = Object.keys(tables).sort();
  const expected = [...CANONICAL_CAPTURE_TABLES].sort();
  if (
    actual.length !== expected.length ||
    actual.some((table, index) => table !== expected[index])
  ) {
    const missing = expected.filter((table) => !actual.includes(table));
    const unexpected = actual.filter((table) => !expected.includes(table));
    throw new Error(
      `Canonical snapshot table coverage differs from recovery manifest ${RECOVERY_MANIFEST_VERSION}. Missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`
    );
  }
}
