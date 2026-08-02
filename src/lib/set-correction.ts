export const SET_CORRECTION_EVIDENCE_KEY = "repbook_correction";
export const SET_CORRECTION_EVIDENCE_SCHEMA_VERSION = 1;
export const SET_CORRECTION_WRITER_VERSION = "repbook-v2-t02/1";

export const SET_CORRECTION_CATEGORIES = [
  "measurement_entry",
  "wrong_unit",
  "effort_entry",
  "note_entry",
  "other",
] as const;

export type SetCorrectionCategory =
  (typeof SET_CORRECTION_CATEGORIES)[number];

export const SET_CORRECTION_CATEGORY_LABELS: Record<
  SetCorrectionCategory,
  string
> = {
  measurement_entry: "The performed measurement was entered incorrectly",
  wrong_unit: "The load unit was entered incorrectly",
  effort_entry: "The effort was entered incorrectly",
  note_entry: "The set note was entered incorrectly",
  other: "Another recording mistake",
};

export const SET_CORRECTION_SOURCES = [
  "active_workout",
  "workout_history",
  "record_version_restore",
  "snapshot_restore",
] as const;

export type SetCorrectionSource =
  (typeof SET_CORRECTION_SOURCES)[number];

export type SetCorrectionEvidence = {
  schemaVersion: typeof SET_CORRECTION_EVIDENCE_SCHEMA_VERSION;
  writerVersion: typeof SET_CORRECTION_WRITER_VERSION;
  category:
    | SetCorrectionCategory
    | "restore_prior_version"
    | "restore_snapshot";
  reasonNote: string | null;
  actorType: "owner";
  source: SetCorrectionSource;
  decidedAt: string;
  decisionTimezone: string;
  decisionLocalDate: string;
  sourceHistoryRevision: number;
  resultHistoryRevision: number;
  sourceLedgerRevision: number;
  resultLedgerRevision: number;
  dependentConclusions:
    | "not_created_while_active"
    | "recompute_queued"
    | "abandoned_session_excluded"
    | "snapshot_state_reconciled";
  expiredRecommendationCount: number;
  progressionJobId: string | null;
  restoredFromVersionId: string | null;
  restoredFromSnapshotId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isUuidOrNull(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ))
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Reads the versioned correction envelope without inventing evidence for
 * pre-T02 records. Legacy versions intentionally return null.
 */
export function readSetCorrectionEvidence(
  afterData: Record<string, unknown>,
): SetCorrectionEvidence | null {
  const value = afterData[SET_CORRECTION_EVIDENCE_KEY];
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== SET_CORRECTION_EVIDENCE_SCHEMA_VERSION ||
    value.writerVersion !== SET_CORRECTION_WRITER_VERSION ||
    typeof value.category !== "string" ||
    (value.reasonNote !== null && typeof value.reasonNote !== "string") ||
    value.actorType !== "owner" ||
    !SET_CORRECTION_SOURCES.includes(value.source as SetCorrectionSource) ||
    !isIsoTimestamp(value.decidedAt) ||
    typeof value.decisionTimezone !== "string" ||
    value.decisionTimezone.length === 0 ||
    !isCalendarDate(value.decisionLocalDate) ||
    !isNonNegativeInteger(value.sourceHistoryRevision) ||
    !isNonNegativeInteger(value.resultHistoryRevision) ||
    !isNonNegativeInteger(value.sourceLedgerRevision) ||
    !isNonNegativeInteger(value.resultLedgerRevision) ||
    value.resultLedgerRevision !== value.sourceLedgerRevision + 1 ||
    typeof value.dependentConclusions !== "string" ||
    !isNonNegativeInteger(value.expiredRecommendationCount) ||
    !isUuidOrNull(value.progressionJobId) ||
    !isUuidOrNull(value.restoredFromVersionId) ||
    !isUuidOrNull(value.restoredFromSnapshotId)
  ) {
    return null;
  }
  if (
    value.category !== "restore_prior_version" &&
    value.category !== "restore_snapshot" &&
    !SET_CORRECTION_CATEGORIES.includes(value.category as SetCorrectionCategory)
  ) {
    return null;
  }
  if (
    value.dependentConclusions !== "not_created_while_active" &&
    value.dependentConclusions !== "recompute_queued" &&
    value.dependentConclusions !== "abandoned_session_excluded" &&
    value.dependentConclusions !== "snapshot_state_reconciled"
  ) {
    return null;
  }
  const restoreSourceMatches =
    (value.source === "record_version_restore" &&
      value.category === "restore_prior_version" &&
      value.restoredFromVersionId !== null &&
      value.restoredFromSnapshotId === null) ||
    (value.source === "snapshot_restore" &&
      value.category === "restore_snapshot" &&
      value.restoredFromSnapshotId !== null &&
      value.restoredFromVersionId === null) ||
    ((value.source === "active_workout" ||
      value.source === "workout_history") &&
      value.category !== "restore_prior_version" &&
      value.category !== "restore_snapshot" &&
      value.restoredFromVersionId === null &&
      value.restoredFromSnapshotId === null);
  if (!restoreSourceMatches) return null;
  return value as SetCorrectionEvidence;
}
