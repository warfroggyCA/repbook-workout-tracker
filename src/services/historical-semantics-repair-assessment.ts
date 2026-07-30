import { createHash } from "node:crypto";
import type { Db } from "@/db";
import {
  analyzeHistoricalSemanticsPayload,
  type HistoricalSemanticsConsequenceReport,
} from "@/services/historical-semantics-gate";
import {
  captureUserSnapshot,
  type CanonicalSnapshotPayload,
} from "@/services/snapshot-capture";
import { canonicalJson } from "@/services/snapshot-crypto";

export const HISTORICAL_SEMANTICS_REPAIR_RULE_VERSION =
  "historical-semantics-repair-assessment-v1";

type Row = Record<string, unknown>;

export type HistoricalSemanticsRepairClassification =
  | "provably_repairable"
  | "ambiguous"
  | "unsupported";

export type HistoricalSemanticsRepairCandidate = {
  setId: string;
  workoutSessionId: string | null;
  parentHistoryRevision: number | null;
  classification: HistoricalSemanticsRepairClassification;
  reason:
    | "no_immutable_performed_time_evidence"
    | "incomplete_performed_semantics"
    | "unsupported_performed_semantics_version";
  currentTuple: {
    metricType: string | null;
    performedSemanticsVersion: number | null;
    performedLoadType: string | null;
    performedLoadSemantics: string | null;
  };
  proposedAfter: null;
  immutableEvidence: [];
  excludedEvidence: Array<
    | "current_mutable_exercise_catalog"
    | "record_version_without_performed_time_proof"
  >;
  idempotencyKey: string;
};

export type HistoricalSemanticsRepairAssessment = {
  assessmentVersion: typeof HISTORICAL_SEMANTICS_REPAIR_RULE_VERSION;
  mutationAuthorized: false;
  contractActivationAuthorized: false;
  programCorrectionPolicy: "new_reviewed_proposal_required";
  decision:
    | "blocked_no_proven_rows"
    | "blocked_unsupported_or_ambiguous_rows"
    | "not_required_no_candidates";
  counts: {
    candidates: number;
    provablyRepairable: number;
    ambiguous: number;
    unsupported: number;
  };
  candidates: HistoricalSemanticsRepairCandidate[];
  consequenceGraph: HistoricalSemanticsConsequenceReport;
  requiredActivationGates: {
    immutablePerformedTimeProof: "required_per_row";
    exactBeforeAfterVersion: "required_per_row";
    parentHistoryRevisionFence: "required_per_workout";
    verifiedSafetySnapshot: "required_before_write";
    deterministicIdempotency: "required_per_row";
    integrityFinding: "required_per_row";
    completeConsequenceReconciliation: "required";
    ownerReview: "required";
    correctiveProgramChange: "new_reviewed_proposal_only";
  };
};

function rows(payload: CanonicalSnapshotPayload, table: string): Row[] {
  return (payload.tables[table] ?? []).filter(
    (value): value is Row =>
      value != null && typeof value === "object" && !Array.isArray(value),
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function candidateReason(
  provenance: string[],
): Pick<
  HistoricalSemanticsRepairCandidate,
  "classification" | "reason"
> {
  if (provenance.includes("unsupported_performed_semantics_version")) {
    return {
      classification: "unsupported",
      reason: "unsupported_performed_semantics_version",
    };
  }
  if (provenance.includes("incomplete_performed_semantics")) {
    return {
      classification: "ambiguous",
      reason: "incomplete_performed_semantics",
    };
  }
  return {
    classification: "ambiguous",
    reason: "no_immutable_performed_time_evidence",
  };
}

/**
 * Sequence 5 assessment only. The current retained model has no accepted
 * performed-time evidence adapter capable of proving a missing tuple, so no
 * candidate can be classified as repairable. Current catalog metadata and
 * ordinary record versions are deliberately excluded as proof.
 */
export function assessHistoricalSemanticsRepairPayload(
  payload: CanonicalSnapshotPayload,
  userId: string,
): HistoricalSemanticsRepairAssessment {
  const consequenceGraph = analyzeHistoricalSemanticsPayload(payload, userId);
  const completedSets = new Map(
    rows(payload, "completed_sets")
      .map((row) => [stringValue(row.id), row] as const)
      .filter((entry): entry is readonly [string, Row] => entry[0] != null),
  );
  const sessionExercises = new Map(
    rows(payload, "session_exercises")
      .map((row) => [stringValue(row.id), row] as const)
      .filter((entry): entry is readonly [string, Row] => entry[0] != null),
  );
  const workoutSessions = new Map(
    rows(payload, "workout_sessions")
      .filter((row) => row.user_id === userId)
      .map((row) => [stringValue(row.id), row] as const)
      .filter((entry): entry is readonly [string, Row] => entry[0] != null),
  );
  const recordVersionCounts = new Map<string, number>();
  for (const version of rows(payload, "record_versions")) {
    if (
      version.user_id !== userId ||
      version.entity_type !== "completed_set"
    ) {
      continue;
    }
    const setId = stringValue(version.entity_id);
    if (setId) {
      recordVersionCounts.set(
        setId,
        (recordVersionCounts.get(setId) ?? 0) + 1,
      );
    }
  }

  const candidates = consequenceGraph.nodes
    .filter((node) => node.kind === "completed_set")
    .map((node): HistoricalSemanticsRepairCandidate => {
      const set = completedSets.get(node.id) ?? {};
      const sessionExercise = sessionExercises.get(
        stringValue(set.session_exercise_id) ?? "",
      );
      const workoutSessionId = stringValue(sessionExercise?.session_id);
      const workout = workoutSessionId
        ? workoutSessions.get(workoutSessionId)
        : undefined;
      const classification = candidateReason(node.provenance);
      const currentTuple = {
        metricType: stringValue(set.metric_type),
        performedSemanticsVersion: numberValue(
          set.performed_semantics_version,
        ),
        performedLoadType: stringValue(set.performed_load_type),
        performedLoadSemantics: stringValue(
          set.performed_load_semantics,
        ),
      };
      const parentHistoryRevision = numberValue(workout?.history_revision);
      const excludedEvidence: HistoricalSemanticsRepairCandidate["excludedEvidence"] =
        ["current_mutable_exercise_catalog"];
      if ((recordVersionCounts.get(node.id) ?? 0) > 0) {
        excludedEvidence.push(
          "record_version_without_performed_time_proof",
        );
      }

      return {
        setId: node.id,
        workoutSessionId,
        parentHistoryRevision,
        ...classification,
        currentTuple,
        proposedAfter: null,
        immutableEvidence: [],
        excludedEvidence,
        idempotencyKey: hash({
          ruleVersion: HISTORICAL_SEMANTICS_REPAIR_RULE_VERSION,
          userId,
          setId: node.id,
          workoutSessionId,
          parentHistoryRevision,
          currentTuple,
        }),
      };
    })
    .sort((a, b) => a.setId.localeCompare(b.setId));

  const ambiguous = candidates.filter(
    (candidate) => candidate.classification === "ambiguous",
  ).length;
  const unsupported = candidates.filter(
    (candidate) => candidate.classification === "unsupported",
  ).length;
  const provablyRepairable = candidates.filter(
    (candidate) => candidate.classification === "provably_repairable",
  ).length;

  return {
    assessmentVersion: HISTORICAL_SEMANTICS_REPAIR_RULE_VERSION,
    mutationAuthorized: false,
    contractActivationAuthorized: false,
    programCorrectionPolicy: "new_reviewed_proposal_required",
    decision:
      candidates.length === 0
        ? "not_required_no_candidates"
        : provablyRepairable === 0
          ? "blocked_no_proven_rows"
          : "blocked_unsupported_or_ambiguous_rows",
    counts: {
      candidates: candidates.length,
      provablyRepairable,
      ambiguous,
      unsupported,
    },
    candidates,
    consequenceGraph,
    requiredActivationGates: {
      immutablePerformedTimeProof: "required_per_row",
      exactBeforeAfterVersion: "required_per_row",
      parentHistoryRevisionFence: "required_per_workout",
      verifiedSafetySnapshot: "required_before_write",
      deterministicIdempotency: "required_per_row",
      integrityFinding: "required_per_row",
      completeConsequenceReconciliation: "required",
      ownerReview: "required",
      correctiveProgramChange: "new_reviewed_proposal_only",
    },
  };
}

export async function assessHistoricalSemanticsRepair(
  db: Db,
  userId: string,
  now = new Date(),
): Promise<HistoricalSemanticsRepairAssessment> {
  const payload = await captureUserSnapshot(
    db,
    userId,
    now,
    HISTORICAL_SEMANTICS_REPAIR_RULE_VERSION,
    {
      normalizeProgramDrafts: false,
      retainCoachEvidenceIds: true,
    },
  );
  return assessHistoricalSemanticsRepairPayload(payload, userId);
}

export function rejectHistoricalSemanticsRepairActivation(): never {
  throw new Error(
    "Historical performed-semantics repair activation is blocked. Sequence 5 is assessment-only and no retained candidate has accepted immutable performed-time proof.",
  );
}
