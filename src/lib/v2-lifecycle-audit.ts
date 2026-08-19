export const REPBOOK_V2_LIFECYCLE_AUDIT_VERSION =
  "repbook-v2-lifecycle-audit/1" as const;

export const REPBOOK_V2_PRODUCT_PACKAGE_SEQUENCE = [
  "T01",
  "T02",
  "T03",
  "T04",
  "T05",
  "T06",
  "U01",
  "U02",
  "U03",
  "H01",
  "H02",
  "H03",
  "H04",
  "H05",
  "A01",
  "A02",
  "A03",
  "A04",
  "A05",
  "D01",
  "D02",
  "R01",
] as const;

export const REPBOOK_V2_LIFECYCLE_STAGES = [
  "creation",
  "reads",
  "correction",
  "archiveDelete",
  "importExport",
  "snapshot",
  "restore",
  "rollback",
  "signOutDeviceQueues",
  "diagnostics",
  "review",
  "coach",
  "recovery",
] as const;

export type RepbookV2LifecycleStage =
  (typeof REPBOOK_V2_LIFECYCLE_STAGES)[number];

export type RepbookV2LifecycleOwner =
  | {
      status: "owned";
      module: `src/${string}`;
      contract: string;
    }
  | {
      status: "not_applicable";
      reason: string;
    };

export type RepbookV2StorageRequirement = {
  table: string;
  fields: readonly string[];
  jsonPaths?: readonly string[];
};

export type RepbookV2FieldFamily = {
  id: string;
  packages: readonly (typeof REPBOOK_V2_PRODUCT_PACKAGE_SEQUENCE)[number][];
  durability: "database" | "device" | "ephemeral";
  meaning: string;
  storage: readonly RepbookV2StorageRequirement[];
  deviceStores?: readonly string[];
  lifecycle: Record<RepbookV2LifecycleStage, RepbookV2LifecycleOwner>;
};

const owned = (
  module: `src/${string}`,
  contract: string,
): RepbookV2LifecycleOwner => ({ status: "owned", module, contract });

const notApplicable = (reason: string): RepbookV2LifecycleOwner => ({
  status: "not_applicable",
  reason,
});

function serverDurableLifecycle(input: {
  creation: RepbookV2LifecycleOwner;
  reads: RepbookV2LifecycleOwner;
  correction: RepbookV2LifecycleOwner;
  importExport?: RepbookV2LifecycleOwner;
  review?: RepbookV2LifecycleOwner;
  coach?: RepbookV2LifecycleOwner;
}): Record<RepbookV2LifecycleStage, RepbookV2LifecycleOwner> {
  return {
    creation: input.creation,
    reads: input.reads,
    correction: input.correction,
    archiveDelete: owned(
      "src/services/recovery-manifest.ts",
      "The recovery table manifest owns archive and protected permanent-delete behavior.",
    ),
    importExport:
      input.importExport ??
      owned(
        "src/services/export.ts",
        "Canonical backup and purpose-specific exports retain the supported representation and explicit limits.",
      ),
    snapshot: owned(
      "src/services/snapshot-capture.ts",
      "Canonical snapshot capture is derived from recovery manifest 15.",
    ),
    restore: owned(
      "src/services/snapshot-restore.ts",
      "Restore replays the recovery manifest dependency and semantic guards.",
    ),
    rollback: owned(
      "src/services/snapshot-restore.ts",
      "Restore failure rolls back atomically and retains its safety snapshot boundary.",
    ),
    signOutDeviceQueues: notApplicable(
      "Authoritative server rows are not browser mutation queues; their pending device writers are inventoried separately.",
    ),
    diagnostics: owned(
      "src/lib/server-log.ts",
      "Only closed redacted operational categories may describe failures; semantic field values are prohibited.",
    ),
    review:
      input.review ??
      notApplicable(
        "This field family does not itself create or change a Review proposal.",
      ),
    coach:
      input.coach ??
      notApplicable(
        "This field family is not included in Coach context or calculations.",
      ),
    recovery: owned(
      "src/services/recovery-manifest.ts",
      "Recovery manifest 15 owns table inclusion, ownership, retention, ordering, and integrity checks.",
    ),
  };
}

export const REPBOOK_V2_FIELD_FAMILIES = [
  {
    id: "program_intent_and_versions",
    packages: ["U03"],
    durability: "database",
    meaning:
      "Editable future Program intent, immutable published versions, schedules, and prescriptions remain distinct from active and performed work.",
    storage: [
      {
        table: "programs",
        fields: ["current_version_id", "recommendation_revision", "status"],
      },
      {
        table: "program_versions",
        fields: [
          "program_id",
          "parent_version_id",
          "restored_from_version_id",
          "document_schema_version",
          "review_hash",
          "publication_source",
        ],
      },
      {
        table: "program_drafts",
        fields: [
          "program_id",
          "base_version_id",
          "restored_from_version_id",
          "revision",
          "document",
          "content_hash",
          "reviewed_revision",
          "review_hash",
          "review_summary",
        ],
      },
      {
        table: "workout_templates",
        fields: ["program_version_id", "lineage_id", "order_idx", "intent"],
      },
      {
        table: "workout_template_exercises",
        fields: [
          "workout_template_id",
          "exercise_id",
          "lineage_id",
          "order_idx",
          "group_member_order_idx",
        ],
      },
      {
        table: "exercise_prescriptions",
        fields: [
          "template_exercise_id",
          "sets",
          "rep_range_min",
          "rep_range_max",
          "target_load",
          "target_load_unit",
          "progression_rule_id",
          "effective_from",
          "superseded_by_id",
        ],
      },
      {
        table: "program_schedules",
        fields: ["user_id", "program_id", "current_version_id"],
      },
      {
        table: "program_schedule_versions",
        fields: [
          "user_id",
          "program_id",
          "schedule_id",
          "version_no",
          "parent_version_id",
          "source_program_version_id",
          "schema_version",
          "document",
          "content_hash",
        ],
      },
      {
        table: "scheduled_program_events",
        fields: [
          "user_id",
          "program_id",
          "schedule_id",
          "schedule_version_id",
          "source_program_version_id",
          "source_phase_id",
          "source_event_id",
          "kind",
          "schedule_kind",
          "routine_lineage_id",
          "intent_snapshot",
          "current_local_date",
          "timezone",
          "status",
          "revision",
        ],
      },
    ],
    lifecycle: serverDurableLifecycle({
      creation: owned(
        "src/services/program-drafts.ts",
        "Draft creation and publication are owner-scoped and revision-fenced.",
      ),
      reads: owned(
        "src/services/program.ts",
        "Program readers retain current version, immutable lineage, and schedule identity.",
      ),
      correction: owned(
        "src/services/program-publication.ts",
        "Corrections publish a new future version; earlier versions and active snapshots are immutable.",
      ),
      review: owned(
        "src/services/recommendation-decisions.ts",
        "Only an explicit accepted future proposal can enter the Program publication path.",
      ),
      coach: owned(
        "src/services/digest.ts",
        "Coach receives labelled Program intent separately from performed evidence.",
      ),
    }),
  },
  {
    id: "active_workout_plan_snapshot",
    packages: ["T03", "T04", "T05", "T06", "U01"],
    durability: "database",
    meaning:
      "A workout freezes its owner, Program lineage, local calendar identity, planned order, grouping, and prescribed meaning without becoming performed evidence.",
    storage: [
      {
        table: "workout_sessions",
        fields: [
          "user_id",
          "template_id",
          "source_program_id",
          "source_program_version_id",
          "source_day_lineage_id",
          "program_schedule_snapshot",
          "status",
          "timezone",
          "local_date",
          "start_request_key",
          "start_request_hash",
          "history_revision",
          "planned_duration_semantics_version",
          "planned_duration_min_minutes",
          "planned_duration_max_minutes",
          "planned_duration_source",
          "time_budget_min",
        ],
      },
      {
        table: "session_exercise_groups",
        fields: [
          "session_id",
          "source_group_id",
          "lineage_id",
          "order_idx",
          "planned_rounds",
          "rest_between_members_sec",
          "rest_between_rounds_sec",
        ],
      },
      {
        table: "session_exercises",
        fields: [
          "session_id",
          "exercise_id",
          "group_snapshot_id",
          "order_idx",
          "source_slot_lineage_id",
          "prescribed_semantics_version",
          "prescribed_exercise_name",
          "prescribed_metric_type",
          "prescribed_load_type",
          "prescribed_load_semantics",
          "equipment_requirements_semantics_version",
          "equipment_requirements_snapshot",
        ],
      },
    ],
    lifecycle: serverDurableLifecycle({
      creation: owned(
        "src/services/session-lifecycle.ts",
        "Explicit Start, accepted compilation, and workout-only additions retain immutable plan and equipment-requirement snapshots.",
      ),
      reads: owned(
        "src/services/session-lifecycle.ts",
        "Active-workout readers project current and next plan items without claiming performance.",
      ),
      correction: notApplicable(
        "Start identity and prescribed semantics are immutable; substitution and version restore atomically replace or restore the retained requirement tuple with the exercise identity.",
      ),
      review: owned(
        "src/services/review-decisions.ts",
        "Review reads active-workout boundaries but cannot rewrite its snapshot.",
      ),
      coach: owned(
        "src/services/live-coaching.ts",
        "Live Coach receives labelled current-workout context without treating the plan as completed work.",
      ),
    }),
  },
  {
    id: "workout_occurrence_outcomes",
    packages: ["T03", "T04", "T05"],
    durability: "database",
    meaning:
      "Planned, ad-hoc, warm-up, skipped, abandoned, and completed occurrences retain exact order, outcome, structured resolution reason, revision, and optional performed-result linkage; terminal session meaning remains separate.",
    storage: [
      {
        table: "workout_sessions",
        fields: [
          "completion_semantics_version",
          "completion_state",
          "completion_reason",
        ],
      },
      {
        table: "session_occurrences",
        fields: [
          "session_id",
          "session_exercise_id",
          "kind",
          "origin",
          "sequence_idx",
          "planned_exercise_id",
          "outcome",
          "outcome_reason",
          "resolution_semantics_version",
          "resolution_reason_code",
          "outcome_note",
          "revision",
          "completed_set_id",
          "equipment_snapshot_id",
        ],
      },
      {
        table: "session_occurrence_mutations",
        fields: [
          "occurrence_id",
          "client_key",
          "operation",
          "canonical_payload_hash",
          "expected_revision",
          "resulting_revision",
          "result_code",
        ],
      },
    ],
    lifecycle: serverDurableLifecycle({
      creation: owned(
        "src/services/session-lifecycle.ts",
        "The session lifecycle creates frozen occurrences and owner-scoped mutation receipts.",
      ),
      reads: owned(
        "src/lib/history-workout-evidence.ts",
        "History classifies occurrence outcomes and performance links without inferring missing results.",
      ),
      correction: owned(
        "src/services/session-lifecycle.ts",
        "Only allowed revision-plus-one outcome transitions can correct reversible occurrence state.",
      ),
      review: owned(
        "src/services/review-evidence.ts",
        "Review cites retained occurrence evidence and excludes unresolved or abandoned work from performed claims.",
      ),
      coach: owned(
        "src/services/digest.ts",
        "Coach digests use linked completed occurrences and label unresolved outcomes.",
      ),
    }),
  },
  {
    id: "performed_set_measurement",
    packages: ["T01", "T02", "U02", "H01", "H02", "H03", "H04"],
    durability: "database",
    meaning:
      "Acknowledged set measurements retain explicit metric, load meaning, recorded unit, observed-time quality, and exception context; missing remains unknown.",
    storage: [
      {
        table: "completed_sets",
        fields: [
          "session_exercise_id",
          "client_key",
          "set_no",
          "reps",
          "weight",
          "weight_unit",
          "metric_type",
          "load_entry_meaning",
          "performed_semantics_version",
          "performed_load_type",
          "performed_load_semantics",
          "distance_km",
          "duration_seconds",
          "rpe",
          "rir",
          "technique_issue",
          "limitation_cause",
          "logged_at",
          "observed_completed_at",
          "observed_completion_provenance",
          "observed_completion_quality",
        ],
      },
      {
        table: "pain_logs",
        fields: [
          "user_id",
          "session_id",
          "exercise_id",
          "completed_set_id",
          "body_part",
          "severity",
          "source",
          "note",
        ],
      },
    ],
    lifecycle: serverDurableLifecycle({
      creation: owned(
        "src/services/session-lifecycle.ts",
        "One authoritative acknowledgement writes the performed set and optional set-linked pain atomically.",
      ),
      reads: owned(
        "src/services/history-report.ts",
        "History owns performed-set interpretation at the exact retained exercise and semantic tier.",
      ),
      correction: owned(
        "src/services/record-versions.ts",
        "Corrections append immutable before/after evidence, advance history revision, and reconcile dependent conclusions.",
      ),
      review: owned(
        "src/services/review-evidence.ts",
        "Review exposes supported, contradictory, unsupported, and external evidence explicitly.",
      ),
      coach: owned(
        "src/services/digest.ts",
        "Coach consumes only supported performed semantics and labels limitation and pain context.",
      ),
    }),
  },
  {
    id: "performed_correction_lineage",
    packages: ["T02", "H02", "H03"],
    durability: "database",
    meaning:
      "Original performed facts, superseding corrections, restore transitions, provenance, and dependent-conclusion reconciliation remain inspectable.",
    storage: [
      {
        table: "record_versions",
        fields: [
          "user_id",
          "entity_type",
          "entity_id",
          "action",
          "before_data",
          "after_data",
          "changed_fields",
          "source_version_id",
          "created_at",
        ],
        jsonPaths: [
          "after_data.repbook_correction.schemaVersion",
          "after_data.repbook_correction.category",
          "after_data.repbook_correction.sourceHistoryRevision",
          "after_data.repbook_correction.resultHistoryRevision",
          "after_data.repbook_correction.sourceLedgerRevision",
          "after_data.repbook_correction.resultLedgerRevision",
          "after_data.repbook_correction.dependentConclusions",
          "after_data.repbook_correction.restoredFromSnapshotId",
        ],
      },
    ],
    lifecycle: serverDurableLifecycle({
      creation: owned(
        "src/services/record-versions.ts",
        "Every correction appends one immutable, owner-scoped version transition.",
      ),
      reads: owned(
        "src/lib/history-workout-evidence.ts",
        "History projects correction and snapshot-restore evidence without hiding the original.",
      ),
      correction: owned(
        "src/services/record-versions.ts",
        "A correction to a corrected record appends another linked version; it never edits prior version rows.",
      ),
      review: owned(
        "src/services/recommendation-evidence-eligibility.ts",
        "Stale conclusions are expired or made non-actionable after a correction.",
      ),
      coach: owned(
        "src/services/digest.ts",
        "Coach reads the effective value with labelled correction provenance.",
      ),
    }),
  },
  {
    id: "independent_activity_evidence",
    packages: ["H01", "H02", "H03"],
    durability: "database",
    meaning:
      "Independent activities retain their own provenance and may provide labelled context without entering strength progress, Program fit, loaded workload, or performed-set calculations.",
    storage: [
      {
        table: "health_activities",
        fields: [
          "user_id",
          "activity_type",
          "started_at",
          "timezone",
          "duration_seconds",
          "source",
          "source_record_id",
          "original_metrics",
          "exclude_from_analytics",
        ],
      },
    ],
    lifecycle: serverDurableLifecycle({
      creation: owned(
        "src/services/activities.ts",
        "Activity creation and import normalize owner, provenance, time, and stable source identity.",
      ),
      reads: owned(
        "src/services/activity-report.ts",
        "Activity reports remain separate from performed-set and Program calculations.",
      ),
      correction: owned(
        "src/services/record-versions.ts",
        "Supported activity corrections retain immutable version evidence.",
      ),
      review: notApplicable(
        "Independent activities can be labelled context but do not directly create Program Review proposals.",
      ),
      coach: owned(
        "src/services/activity-report.ts",
        "Coach receives activities only through the separately labelled activity context.",
      ),
    }),
  },
  {
    id: "progression_inputs_and_metrics",
    packages: ["H02", "H03", "H04"],
    durability: "database",
    meaning:
      "Derived progression work binds exact input workout revisions; unsupported or changed evidence is invalidated rather than guessed.",
    storage: [
      {
        table: "progression_jobs",
        fields: [
          "user_id",
          "session_id",
          "source_session_revision",
          "coaching_prefs",
          "status",
        ],
      },
      {
        table: "progression_job_input_sessions",
        fields: ["user_id", "job_id", "session_id", "history_revision"],
      },
    ],
    lifecycle: serverDurableLifecycle({
      creation: owned(
        "src/services/progression-jobs.ts",
        "Progression jobs retain the exact owner, triggering workout revision, coaching preferences, and historical input revisions.",
      ),
      reads: owned(
        "src/services/progression.ts",
        "Rules consume only supported performed semantics and exact source revisions.",
      ),
      correction: owned(
        "src/services/record-versions.ts",
        "Corrections invalidate or supersede affected derived work without rewriting prior evidence.",
      ),
      review: owned(
        "src/services/review-evidence.ts",
        "Progression output becomes an evidence-linked proposal, never an automatic Program change.",
      ),
      coach: owned(
        "src/services/coaching.ts",
        "Coach presents supported conclusions with limitations and exact evidence links.",
      ),
    }),
  },
  {
    id: "review_proposals_decisions_and_adaptations",
    packages: ["H05", "A05"],
    durability: "database",
    meaning:
      "Proposals, deferrals, owner decisions, and accepted future adaptations remain separate, evidence-linked, revision-fenced records.",
    storage: [
      {
        table: "recommendations",
        fields: [
          "user_id",
          "source",
          "rule_id",
          "insight_id",
          "status",
          "payload",
          "reason",
          "evidence",
          "review_revision",
          "defer_revision",
          "deferred_at",
          "revisit_on",
          "defer_reason",
        ],
        jsonPaths: [
          "evidence.review.schemaVersion",
          "evidence.review.producer",
          "evidence.review.quality",
          "evidence.review.limitations",
          "evidence.review.proposedEffect",
        ],
      },
      {
        table: "user_decisions",
        fields: [
          "recommendation_id",
          "decision",
          "edited_payload",
          "reason",
          "review_snapshot",
          "decided_at",
        ],
        jsonPaths: [
          "review_snapshot.schemaVersion",
          "review_snapshot.recommendationId",
          "review_snapshot.reviewRevision",
          "review_snapshot.deferRevision",
          "review_snapshot.evidenceState",
        ],
      },
      {
        table: "adaptation_events",
        fields: [
          "user_id",
          "recommendation_id",
          "before_snapshot",
          "after_snapshot",
          "applied_at",
          "undone_at",
        ],
      },
    ],
    lifecycle: serverDurableLifecycle({
      creation: owned(
        "src/services/recommendation-decisions.ts",
        "Proposal creation and explicit owner decisions are owner-scoped, evidence-linked, and atomic.",
      ),
      reads: owned(
        "src/services/review-decisions.ts",
        "Review retains pending, deferred, accepted, edited, rejected, stale, and non-actionable states.",
      ),
      correction: notApplicable(
        "Prior decisions are immutable; a later proposal and decision create new evidence instead of rewriting the old decision.",
      ),
      review: owned(
        "src/services/review-decisions.ts",
        "Review is the sole owner-facing proposal and decision workspace.",
      ),
      coach: owned(
        "src/services/coaching.ts",
        "Coach may explain proposals but cannot make the owner decision or silently publish an adaptation.",
      ),
    }),
  },
  {
    id: "analysis_package_receipt",
    packages: ["A01", "A02", "A03", "A04"],
    durability: "database",
    meaning:
      "Only a privacy-minimal, expiring owner receipt is retained for a locally previewed external-analysis package; raw package bytes and responses are not retained.",
    storage: [
      {
        table: "analysis_package_manifests",
        fields: [
          "id",
          "user_id",
          "package_namespace",
          "schema_version",
          "semantic_version",
          "digest_algorithm",
          "digest",
          "scope",
          "inventory",
          "source_bindings",
          "created_at",
          "evidence_cutoff",
          "expires_at",
        ],
      },
    ],
    lifecycle: serverDurableLifecycle({
      creation: owned(
        "src/services/analysis-package.ts",
        "Owner-selected local package generation stores only the bounded receipt and digest.",
      ),
      reads: owned(
        "src/services/external-analysis-validation.ts",
        "Validation reads the exact active owner receipt and current Program precondition.",
      ),
      correction: notApplicable(
        "Package receipts are immutable; the owner generates a new package or deletes the old receipt.",
      ),
      importExport: owned(
        "src/services/analysis-package.ts",
        "The detailed package is previewed and downloaded locally while the retained receipt stays purpose-minimal.",
      ),
      review: notApplicable(
        "A package or validated preview alone cannot create a Review proposal.",
      ),
      coach: notApplicable(
        "The external-analysis package is separate from in-app Coach context.",
      ),
    }),
  },
  {
    id: "external_analysis_import_receipt",
    packages: ["A05"],
    durability: "database",
    meaning:
      "A selective external import retains one owner-scoped typed receipt and sanitized evidence links, never the raw provider response.",
    storage: [
      {
        table: "coaching_insights",
        fields: [
          "user_id",
          "kind",
          "client_key",
          "response_status",
          "data_digest",
          "completed_at",
          "archived_at",
        ],
        jsonPaths: [
          "data_digest.schemaVersion",
          "data_digest.rawResponseRetained",
          "data_digest.package",
          "data_digest.response",
          "data_digest.observations",
        ],
      },
      {
        table: "recommendations",
        fields: ["user_id", "insight_id", "source", "rule_id", "payload", "evidence"],
        jsonPaths: [
          "payload.kind=external_review",
          "evidence.externalAnalysis.schemaVersion",
          "evidence.externalAnalysis.importId",
          "evidence.externalAnalysis.packageId",
          "evidence.externalAnalysis.responseId",
          "evidence.externalAnalysis.responseDigest",
          "evidence.externalAnalysis.proposalId",
          "evidence.externalAnalysis.citedEvidenceIds",
        ],
      },
    ],
    lifecycle: serverDurableLifecycle({
      creation: owned(
        "src/services/external-analysis-import.ts",
        "One atomic owner-selected import writes the sanitized receipt and selected future-only proposals.",
      ),
      reads: owned(
        "src/services/external-analysis-review.ts",
        "Review projects external origin, limitations, evidence links, and future-only requested outcome.",
      ),
      correction: notApplicable(
        "An imported receipt is immutable and idempotent; changed response content conflicts instead of overwriting it.",
      ),
      importExport: owned(
        "src/services/external-analysis-import.ts",
        "The allowlisted selection crosses the import boundary without retaining the raw response.",
      ),
      review: owned(
        "src/services/recommendation-decisions.ts",
        "External proposals remain ordinary explicit Review decisions and cannot claim a Program slot.",
      ),
      coach: owned(
        "src/services/coaching.ts",
        "Imported observations are visibly external context and never performed facts.",
      ),
    }),
  },
  {
    id: "device_mutation_queues",
    packages: ["T01", "T03", "U01"],
    durability: "device",
    meaning:
      "Unacknowledged owner commands remain owner-scoped, retryable device copies and are reviewed before sign-out or account change.",
    storage: [],
    deviceStores: [
      "workout_sets",
      "occurrence_mutations",
      "equipment_selections",
      "contextual_notes",
      "live_coach",
    ],
    lifecycle: {
      creation: owned(
        "src/lib/workout-set-outbox.ts",
        "Each queue module validates and stores owner-scoped commands before authoritative acknowledgement.",
      ),
      reads: owned(
        "src/lib/sign-out-device-work.ts",
        "One sign-out inventory reads every command queue and keeps foreign entries separate.",
      ),
      correction: owned(
        "src/lib/workout-set-outbox.ts",
        "Queue modules retain retry, acknowledgement, quarantine, and needs-attention state without inventing a commit result.",
      ),
      archiveDelete: owned(
        "src/lib/sign-out-device-work.ts",
        "Only explicit owner-scoped discard removes attributable device copies; unreadable or foreign copies fail closed.",
      ),
      importExport: notApplicable(
        "Transient device commands are not canonical export or import records.",
      ),
      snapshot: notApplicable(
        "Unacknowledged device commands are outside server snapshots and remain visible on the device.",
      ),
      restore: owned(
        "src/lib/sign-out-device-work.ts",
        "Re-authentication re-reads retained device work without assigning it to another owner.",
      ),
      rollback: owned(
        "src/lib/workout-set-outbox.ts",
        "Failed synchronization retains the command for retry or attention instead of rolling it into a false acknowledgement.",
      ),
      signOutDeviceQueues: owned(
        "src/lib/sign-out-device-work.ts",
        "The sign-out device-work inventory is the single lifecycle owner for all five command queues.",
      ),
      diagnostics: owned(
        "src/lib/server-log.ts",
        "Queue failures expose only closed operational categories, never raw command payloads.",
      ),
      review: notApplicable(
        "Unacknowledged device commands cannot become Review evidence.",
      ),
      coach: notApplicable(
        "Unacknowledged device commands cannot become Coach facts or context.",
      ),
      recovery: owned(
        "src/lib/sign-out-device-work.ts",
        "Owner-visible retry, quarantine, and re-authentication are the device recovery boundary.",
      ),
    },
  },
  {
    id: "structured_diagnostic_events",
    packages: ["D01"],
    durability: "ephemeral",
    meaning:
      "Closed redacted diagnostic events retain only coarse operational categories with explicit expiry and no semantic workout values.",
    storage: [],
    lifecycle: {
      creation: owned(
        "src/lib/server-log.ts",
        "The closed manifest validates every event and field before writing.",
      ),
      reads: notApplicable(
        "The application has no retained-log reader or owner-data reconstruction path.",
      ),
      correction: notApplicable("Diagnostic events are immutable and short-lived."),
      archiveDelete: owned(
        "src/lib/server-log.ts",
        "Every accepted event carries a maximum 24-hour expiry for the runtime sink.",
      ),
      importExport: notApplicable(
        "Diagnostic events are not exported, imported, or included in analysis packages or support bundles.",
      ),
      snapshot: notApplicable("Diagnostic events are excluded from snapshots."),
      restore: notApplicable("Diagnostic events are excluded from restore."),
      rollback: notApplicable("Logging failure never affects application transactions."),
      signOutDeviceQueues: notApplicable(
        "Diagnostic events are not browser device work.",
      ),
      diagnostics: owned(
        "src/lib/server-log.ts",
        "The diagnostic manifest is the sole producer and retention boundary.",
      ),
      review: notApplicable("Diagnostics cannot create Review proposals."),
      coach: notApplicable("Diagnostics cannot become Coach context."),
      recovery: notApplicable(
        "Diagnostic events are deliberately outside application recovery artifacts.",
      ),
    },
  },
  {
    id: "owner_previewed_support_bundle",
    packages: ["D02"],
    durability: "ephemeral",
    meaning:
      "A support bundle exists only as the owner's exact local preview and deliberate download; it never sends, persists, or becomes AI or training evidence.",
    storage: [],
    lifecycle: {
      creation: owned(
        "src/lib/support-bundle.ts",
        "Closed problem allowlists generate one minimum local artifact with random per-bundle correlation.",
      ),
      reads: owned(
        "src/components/export/support-bundle-builder.tsx",
        "The owner sees the exact final canonical bytes before download.",
      ),
      correction: owned(
        "src/components/export/support-bundle-builder.tsx",
        "Removing optional fields immediately regenerates the exact preview.",
      ),
      archiveDelete: notApplicable(
        "Repbook retains no support bundle to archive or delete.",
      ),
      importExport: owned(
        "src/components/export/support-bundle-builder.tsx",
        "Only deliberate local export writes the exact previewed bytes.",
      ),
      snapshot: notApplicable("Support bundles are excluded from snapshots."),
      restore: notApplicable("Support bundles are excluded from restore."),
      rollback: notApplicable(
        "Cancel or page close leaves no hidden application state to roll back.",
      ),
      signOutDeviceQueues: notApplicable(
        "Support bundles are not stored in a browser queue.",
      ),
      diagnostics: notApplicable(
        "The support builder cannot read D01 diagnostic log lines.",
      ),
      review: notApplicable("Support bundles cannot create Review proposals."),
      coach: notApplicable("Support bundles cannot become Coach context."),
      recovery: notApplicable(
        "Support bundles are deliberately outside application recovery artifacts.",
      ),
    },
  },
] as const satisfies readonly RepbookV2FieldFamily[];

export function validateRepbookV2LifecycleAudit(
  families: readonly RepbookV2FieldFamily[] = REPBOOK_V2_FIELD_FAMILIES,
): string[] {
  const failures: string[] = [];
  const ids = new Set<string>();
  for (const family of families) {
    if (ids.has(family.id)) failures.push(`duplicate family: ${family.id}`);
    ids.add(family.id);
    if (family.packages.length === 0) {
      failures.push(`${family.id}: no owning package`);
    }
    if (new Set(family.packages).size !== family.packages.length) {
      failures.push(`${family.id}: duplicate owning package`);
    }
    for (const packageId of family.packages) {
      if (!REPBOOK_V2_PRODUCT_PACKAGE_SEQUENCE.includes(packageId)) {
        failures.push(`${family.id}: unknown owning package ${packageId}`);
      }
    }
    if (family.durability === "database" && family.storage.length === 0) {
      failures.push(`${family.id}: database family has no storage`);
    }
    if (family.durability !== "database" && family.storage.length > 0) {
      failures.push(`${family.id}: non-database family has database storage`);
    }
    if (family.durability === "device" && !family.deviceStores?.length) {
      failures.push(`${family.id}: device family has no stores`);
    }
    if (
      family.deviceStores &&
      new Set(family.deviceStores).size !== family.deviceStores.length
    ) {
      failures.push(`${family.id}: duplicate device store`);
    }
    for (const requirement of family.storage) {
      if (!requirement.table || requirement.fields.length === 0) {
        failures.push(`${family.id}: incomplete storage requirement`);
      }
      if (new Set(requirement.fields).size !== requirement.fields.length) {
        failures.push(`${family.id}.${requirement.table}: duplicate field`);
      }
      if (
        requirement.jsonPaths &&
        (requirement.jsonPaths.length === 0 ||
          new Set(requirement.jsonPaths).size !== requirement.jsonPaths.length)
      ) {
        failures.push(`${family.id}.${requirement.table}: invalid JSON path inventory`);
      }
    }
    const lifecycleKeys = Object.keys(family.lifecycle).sort();
    const expectedKeys = [...REPBOOK_V2_LIFECYCLE_STAGES].sort();
    if (
      lifecycleKeys.length !== expectedKeys.length ||
      lifecycleKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      failures.push(`${family.id}: incomplete lifecycle`);
    }
    for (const stage of REPBOOK_V2_LIFECYCLE_STAGES) {
      const owner = family.lifecycle[stage];
      if (!owner) continue;
      if (owner.status === "owned") {
        if (!owner.module.startsWith("src/") || owner.contract.trim().length < 20) {
          failures.push(`${family.id}.${stage}: incomplete owner`);
        }
      } else if (owner.reason.trim().length < 20) {
        failures.push(`${family.id}.${stage}: incomplete not-applicable reason`);
      }
    }
  }
  return failures;
}

export function assertRepbookV2LifecycleAudit(
  families: readonly RepbookV2FieldFamily[] = REPBOOK_V2_FIELD_FAMILIES,
) {
  const failures = validateRepbookV2LifecycleAudit(families);
  if (failures.length > 0) {
    throw new Error(
      `Repbook v2 lifecycle audit ${REPBOOK_V2_LIFECYCLE_AUDIT_VERSION} failed: ${failures.join("; ")}`,
    );
  }
}
