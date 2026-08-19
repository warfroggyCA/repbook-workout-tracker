import {
  SET_CORRECTION_CATEGORY_LABELS,
  readSetCorrectionEvidence,
  type SetCorrectionEvidence,
} from "@/lib/set-correction";
import {
  setMetricExclusionLabel,
  type SetMetricContainment,
} from "@/lib/set-metric-semantics";

export type HistorySessionStatus = "in_progress" | "completed" | "abandoned";

export type HistoryOccurrenceEvidence = {
  id: string;
  kind: "day_warmup" | "exercise_warmup" | "working_set" | string;
  outcome: "pending" | "completed" | "skipped" | "abandoned" | "legacy_unrecorded" | string;
  outcomeReason: string | null;
  completedSetId: string | null;
};

export type HistoryTerminalState =
  | "in_progress"
  | "completed"
  | "completed_without_prescription"
  | "completed_with_remaining_work"
  | "legacy_incomplete_outcome_unknown"
  | "abandoned";

export function classifyHistoryTerminalState(
  status: HistorySessionStatus,
  occurrences: HistoryOccurrenceEvidence[],
  completion?: {
    semanticsVersion: number | null;
    state: string | null;
    reason: string | null;
  },
): HistoryTerminalState {
  if (status === "in_progress") return "in_progress";
  if (status === "abandoned") return "abandoned";
  if (
    completion?.semanticsVersion === 1 &&
    completion.state === "completed_without_prescription" &&
    completion.reason == null
  ) {
    return "completed_without_prescription";
  }
  if (
    completion?.semanticsVersion === 1 &&
    completion.state === "completed_with_remaining_work" &&
    completion.reason != null
  ) {
    return "completed_with_remaining_work";
  }
  return occurrences.some(
    (occurrence) =>
      occurrence.outcome === "abandoned" &&
      occurrence.outcomeReason === "finished_early",
  )
    ? "legacy_incomplete_outcome_unknown"
    : "completed";
}

export function historyTerminalLabel(state: HistoryTerminalState) {
  if (state === "completed_without_prescription") {
    return "Completed without a prescription";
  }
  if (state === "completed_with_remaining_work") {
    return "Completed with planned work remaining";
  }
  if (state === "legacy_incomplete_outcome_unknown") {
    return "Completed; legacy incomplete outcome";
  }
  if (state === "abandoned") return "Abandoned workout";
  if (state === "in_progress") return "Workout in progress";
  return "Completed workout";
}

export function performedWorkingSetIds(
  occurrences: HistoryOccurrenceEvidence[],
  retainedSetIds: Set<string>,
) {
  return new Set(
    occurrences.flatMap((occurrence) =>
      occurrence.kind === "working_set" &&
      occurrence.outcome === "completed" &&
      occurrence.completedSetId != null &&
      retainedSetIds.has(occurrence.completedSetId)
        ? [occurrence.completedSetId]
        : [],
    ),
  );
}

export function completedWarmupOccurrences<
  T extends HistoryOccurrenceEvidence,
>(occurrences: T[]): T[] {
  return occurrences.filter(
    (occurrence) =>
      (occurrence.kind === "day_warmup" ||
        occurrence.kind === "exercise_warmup") &&
      occurrence.outcome === "completed",
  );
}

export type PerformedSemanticFacet =
  | "supported"
  | "legacy_partial"
  | "unsupported";

export function classifyPerformedSemanticFacet(input: {
  performedSemanticsVersion: number | null;
  performedLoadType: string | null;
  performedLoadSemantics: string | null;
}): PerformedSemanticFacet {
  const values = [
    input.performedSemanticsVersion,
    input.performedLoadType,
    input.performedLoadSemantics,
  ];
  if (values.every((value) => value == null)) return "legacy_partial";
  if (
    input.performedSemanticsVersion === 1 &&
    typeof input.performedLoadType === "string" &&
    input.performedLoadType.trim().length > 0 &&
    typeof input.performedLoadSemantics === "string" &&
    input.performedLoadSemantics.trim().length > 0
  ) {
    return "supported";
  }
  return "unsupported";
}

export const PERFORMED_SEMANTIC_FACET_LABELS: Record<
  PerformedSemanticFacet,
  string
> = {
  supported: "Supported performed meaning",
  legacy_partial: "Legacy partial meaning",
  unsupported: "Unsupported performed meaning",
};

export type HistoryProvenanceFacet =
  | "native"
  | "manual"
  | "imported"
  | "legacy";

export function classifyHistoryProvenance(input: {
  source: string;
  importBatchId: string | null;
}): HistoryProvenanceFacet {
  if (input.source === "tracker" || input.source === "compiler") {
    return "native";
  }
  if (input.source === "history_manual") return "manual";
  if (input.importBatchId != null || input.source === "hevy") return "imported";
  return "legacy";
}

export const HISTORY_PROVENANCE_LABELS: Record<
  HistoryProvenanceFacet,
  string
> = {
  native: "Recorded in Repbook",
  manual: "Entered after the workout",
  imported: "Imported evidence",
  legacy: "Legacy source",
};

export type HistoryCorrectionFacet =
  | "original"
  | "corrected"
  | "version_restored"
  | "snapshot_restored";

export const HISTORY_SET_CORRECTION_ACTIONS = new Set([
  "set.active_correction",
  "set.completed_correction",
  "set.version_restore",
  "set.snapshot_restore",
]);

export function classifyHistoryCorrectionFacet(
  actions: string[],
): HistoryCorrectionFacet {
  for (const action of actions) {
    if (
      action === "set.snapshot_restore" ||
      action === "workout_session.snapshot_restore"
    ) return "snapshot_restored";
    if (
      action === "set.version_restore" ||
      action === "workout_session.version_restore"
    ) {
      return "version_restored";
    }
    if (
      action === "set.active_correction" ||
      action === "set.completed_correction" ||
      action === "workout_session.timing_correction" ||
      action === "workout_session.duration_correction"
    ) {
      return "corrected";
    }
  }
  return "original";
}

export const HISTORY_CORRECTION_LABELS: Record<HistoryCorrectionFacet, string> = {
  original: "Original evidence",
  corrected: "Corrected evidence",
  version_restored: "Restored from record version",
  snapshot_restored: "Restored from recovery snapshot",
};

export type CalculationEligibility = {
  kind: "included" | "limited" | "excluded";
  label: string;
  claims: string[];
};

export function classifyCalculationEligibility(
  status: HistorySessionStatus,
  semantics: SetMetricContainment,
  semanticFacet: PerformedSemanticFacet,
): CalculationEligibility {
  if (status === "abandoned") {
    return {
      kind: "excluded",
      label:
        "Excluded from completed metrics, progression, and Review because the workout was abandoned.",
      claims: [],
    };
  }

  if (semanticFacet === "legacy_partial") {
    return {
      kind: "excluded",
      label:
        "Not used in completed calculations because this legacy set's performed meaning is incomplete.",
      claims: [],
    };
  }
  if (semanticFacet === "unsupported") {
    return {
      kind: "excluded",
      label:
        "Not used in completed calculations because this set's performed meaning is unsupported.",
      claims: [],
    };
  }

  const claims = [
    semantics.prescriptionOutcomeEligible ? "target comparison" : null,
    semantics.longitudinalComparable ? "exercise progression" : null,
    semantics.loadedWorkEligible ? "loaded workload" : null,
    semantics.estimatedStrengthEligible ? "estimated strength" : null,
    semantics.personalRecordEligible ? "selected-period records" : null,
    semantics.automaticProgressionEligible ? "automatic progression" : null,
  ].filter((claim): claim is string => claim != null);

  if (claims.length === 0) {
    return {
      kind: "excluded",
      label: semantics.exclusionReason
        ? `Not used in completed calculations: ${setMetricExclusionLabel(semantics.exclusionReason)}`
        : "Not used in completed calculations.",
      claims,
    };
  }

  return {
    kind: claims.length === 6 ? "included" : "limited",
    label: `Eligible for ${claims.join(", ")}.`,
    claims,
  };
}

type CorrectionVersion = {
  id: string;
  action: string;
  beforeData: Record<string, unknown>;
  afterData: Record<string, unknown>;
  changedFields: string[];
  sourceVersionId: string | null;
  createdAt: Date;
};

const CORRECTION_FIELD_LABELS: Record<string, string> = {
  weight: "Load",
  weight_unit: "Load unit",
  reps: "Repetitions",
  distance_km: "Distance",
  duration_seconds: "Duration",
  metric_type: "Measurement type",
  rpe: "RPE",
  rir: "RIR",
  note: "Set note",
  technique_issue: "Technique issue",
  limitation_cause: "Limitation",
  exclude_from_analytics: "Calculation exclusion",
};

function formatCorrectionValue(field: string, value: unknown) {
  if (value == null || value === "") return "Not recorded";
  if (field === "duration_seconds" && typeof value === "number") {
    const minutes = Math.floor(value / 60);
    const seconds = value % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  if (field === "distance_km" && typeof value === "number") {
    return `${value} km`;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") {
    return String(value).replaceAll("_", " ");
  }
  return "Recorded value";
}

function correctionActionLabel(action: string) {
  if (action === "set.version_restore") return "Record version restored";
  if (action === "set.snapshot_restore") return "Recovery snapshot restored";
  if (action === "set.active_correction") return "Corrected during workout";
  return "Corrected from History";
}

function correctionCategoryLabel(evidence: SetCorrectionEvidence) {
  if (evidence.category === "restore_prior_version") {
    return "Restored a prior record version";
  }
  if (evidence.category === "restore_snapshot") {
    return "Restored recovery snapshot evidence";
  }
  return SET_CORRECTION_CATEGORY_LABELS[evidence.category];
}

export type HistoryCorrectionEvidenceRow = {
  id: string;
  actionLabel: string;
  categoryLabel: string | null;
  reasonNote: string | null;
  decidedAt: string | null;
  sourceLabel: string | null;
  historyRevisionLabel: string | null;
  ledgerRevisionLabel: string | null;
  restoreReference: string | null;
  readableEnvelope: boolean;
  deltas: Array<{ field: string; label: string; before: string; after: string }>;
  changedFieldLabels: string[];
};

export function buildHistoryCorrectionEvidenceRows(
  versions: CorrectionVersion[],
): HistoryCorrectionEvidenceRow[] {
  return versions
    .filter((version) => HISTORY_SET_CORRECTION_ACTIONS.has(version.action))
    .map((version) => {
      const evidence = readSetCorrectionEvidence(version.afterData);
      const changedFields = version.changedFields.filter(
        (field) => field in CORRECTION_FIELD_LABELS,
      );
      const deltas = changedFields.flatMap((field) => {
        const before = version.beforeData[field];
        const after = version.afterData[field];
        return Object.is(before, after)
          ? []
          : [
              {
                field,
                label: CORRECTION_FIELD_LABELS[field],
                before: formatCorrectionValue(field, before),
                after: formatCorrectionValue(field, after),
              },
            ];
      });
      return {
        id: version.id,
        actionLabel: correctionActionLabel(version.action),
        categoryLabel: evidence ? correctionCategoryLabel(evidence) : null,
        reasonNote: evidence?.reasonNote ?? null,
        decidedAt: evidence?.decidedAt ?? null,
        sourceLabel: evidence
          ? evidence.source.replaceAll("_", " ")
          : null,
        historyRevisionLabel: evidence
          ? `${evidence.sourceHistoryRevision} → ${evidence.resultHistoryRevision}`
          : null,
        ledgerRevisionLabel: evidence
          ? `${evidence.sourceLedgerRevision} → ${evidence.resultLedgerRevision}`
          : null,
        restoreReference:
          evidence?.restoredFromVersionId ??
          evidence?.restoredFromSnapshotId ??
          version.sourceVersionId,
        readableEnvelope: evidence != null,
        deltas,
        changedFieldLabels: changedFields.map(
          (field) => CORRECTION_FIELD_LABELS[field],
        ),
      };
    });
}
