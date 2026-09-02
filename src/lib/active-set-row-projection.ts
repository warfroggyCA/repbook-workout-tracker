import type {
  LoggedSet,
  SessionExerciseData,
  SessionOccurrenceData,
} from "@/components/session/types";
import {
  workingSetDisplayPosition,
  workingSetSemanticRole,
  type WorkingSetSemanticRole,
} from "@/lib/session-occurrences";
import {
  queuedSetSaveState,
  type RuntimeSetSaveState,
} from "@/lib/session-runner";
import type { WorkoutSetOutboxEntry } from "@/lib/workout-set-outbox";

export const ACTIVE_SET_ROW_STATES = [
  "planned",
  "current_editable",
  "retained_locally",
  "saving",
  "retrying",
  "failed",
  "saved",
  "skipped",
  "abandoned",
  "completed_without_result",
  "unknown_legacy",
] as const;

export type ActiveSetRowState = (typeof ACTIVE_SET_ROW_STATES)[number];

export const ACTIVE_SET_VERSION_STATES = [
  "original",
  "corrected",
  "version_restored",
  "snapshot_restored",
] as const;

export type ActiveSetVersionState =
  (typeof ACTIVE_SET_VERSION_STATES)[number];

export type ActiveSetVersionEvidence =
  | { state: "original"; count: 0 }
  | {
      state: Exclude<ActiveSetVersionState, "original">;
      count: number;
    };

export type ActiveSetMembership = WorkingSetSemanticRole | "unknown";

export type ActiveSetFrozenPrescription = {
  repsMin: number | null;
  repsMax: number | null;
  load: number | null;
  loadUnit: "lb" | "kg" | null;
  loadPercent: number | null;
  loadText: string | null;
  note: string | null;
};

export type ActiveSetExactResult = Pick<
  LoggedSet,
  | "id"
  | "clientKey"
  | "setNo"
  | "weight"
  | "weightUnit"
  | "reps"
  | "distanceKm"
  | "durationSeconds"
  | "rpe"
  | "rir"
  | "techniqueIssue"
  | "limitationCause"
  | "pain"
  | "note"
> & {
  metricType: LoggedSet["metricType"] | null;
};

type ActiveSetRowBase = {
  key: string;
  occurrenceId: string;
  sessionExerciseId: string;
  sequenceIdx: number;
  label: string;
  outcome: SessionOccurrenceData["outcome"];
  /** Origin is independent of persistence and version state. */
  membership: ActiveSetMembership;
  group: {
    id: string;
    round: number | null;
    memberOrder: number | null;
  } | null;
};

type ActiveSetRowWithPrescription = ActiveSetRowBase & {
  prescription: ActiveSetFrozenPrescription;
};

type ActiveSetRowWithResult = ActiveSetRowWithPrescription & {
  result: ActiveSetExactResult;
  /** Revision provenance is independent of save lifecycle state. */
  version: ActiveSetVersionEvidence;
};

export type ActiveSetRow =
  | (ActiveSetRowWithPrescription & {
      state: "planned";
      result: null;
      version: null;
    })
  | (ActiveSetRowWithPrescription & {
      state: "current_editable";
      result: null;
      version: null;
      blockingReason: string | null;
    })
  | (ActiveSetRowWithResult & {
      state: "retained_locally";
      clientKey: string;
    })
  | (ActiveSetRowWithResult & {
      state: "saving";
      clientKey: string;
    })
  | (ActiveSetRowWithResult & {
      state: "retrying";
      clientKey: string;
    })
  | (ActiveSetRowWithResult & {
      state: "failed";
      clientKey: string;
      error: string | null;
    })
  | (ActiveSetRowWithResult & {
      state: "saved";
    })
  | (ActiveSetRowWithPrescription & {
      state: "skipped";
      result: null;
      version: null;
      reasonCode: string | null;
      note: string | null;
    })
  | (ActiveSetRowWithPrescription & {
      state: "abandoned";
      result: null;
      version: null;
      reasonCode: string | null;
      note: string | null;
    })
  | (ActiveSetRowWithPrescription & {
      state: "completed_without_result";
      result: null;
      version: null;
      message: string;
    })
  | (ActiveSetRowBase & {
      state: "unknown_legacy";
      prescription: null;
      result: ActiveSetExactResult | null;
      version: ActiveSetVersionEvidence | null;
      message: string;
    });

export type ActiveSetRowProjection = {
  rows: ActiveSetRow[];
  diagnostics: {
    unlinkedSetIds: string[];
    duplicateSetIds: string[];
    contradictoryOccurrenceIds: string[];
    acknowledgedOutboxClientKeys: string[];
  };
};

export type ActiveSetRowProjectionInput = {
  exercise: SessionExerciseData;
  occurrences: SessionOccurrenceData[];
  /** Durable device commands, before the server acknowledges them. */
  outboxEntries?: readonly WorkoutSetOutboxEntry[];
  /** Ephemeral delivery state keyed by the durable client identity. */
  runtimeSaveStates?: Readonly<Record<string, RuntimeSetSaveState>>;
  currentOccurrenceId: string | null;
  currentBlockingReason?: string | null;
  versionEvidenceBySetId?: Readonly<Record<string, ActiveSetVersionEvidence>>;
};

function outboxResult(
  entry: WorkoutSetOutboxEntry,
  runtimeState: RuntimeSetSaveState | undefined,
): LoggedSet {
  return {
    id: `outbox-${entry.clientKey}`,
    clientKey: entry.clientKey,
    occurrenceId: entry.occurrenceId ?? null,
    setNo: entry.setNo,
    weight: entry.weight,
    weightUnit: entry.weightUnit,
    reps: entry.reps,
    metricType: entry.metricType,
    distanceKm: entry.distanceKm,
    durationSeconds: entry.durationSeconds,
    rpe: entry.rpe,
    rir: entry.rir,
    techniqueIssue: entry.techniqueIssue,
    limitationCause: entry.limitationCause,
    pain: entry.pain,
    note: entry.note,
    saveState: queuedSetSaveState(entry, runtimeState),
    lastError: entry.lastError,
  };
}

function resultCandidates(input: ActiveSetRowProjectionInput): {
  results: LoggedSet[];
  acknowledgedOutboxClientKeys: string[];
} {
  const results = [...input.exercise.sets];
  const acknowledgedOutboxClientKeys: string[] = [];
  for (const entry of input.outboxEntries ?? []) {
    if (entry.sessionExerciseId !== input.exercise.id) continue;
    const result = outboxResult(
      entry,
      input.runtimeSaveStates?.[entry.clientKey],
    );
    const matchingClientIndex = results.findIndex(
      (candidate) => candidate.clientKey === entry.clientKey,
    );
    if (matchingClientIndex < 0) {
      results.push(result);
      continue;
    }
    const matchingClient = results[matchingClientIndex];
    const serverAcknowledged =
      matchingClient.saveState == null || matchingClient.saveState === "saved";
    if (serverAcknowledged) {
      acknowledgedOutboxClientKeys.push(entry.clientKey);
    } else {
      results[matchingClientIndex] = result;
    }
  }
  return { results, acknowledgedOutboxClientKeys };
}

function exactResult(set: LoggedSet): ActiveSetExactResult {
  return {
    id: set.id,
    clientKey: set.clientKey,
    setNo: set.setNo,
    metricType: set.metricType ?? null,
    weight: set.weight,
    weightUnit: set.weightUnit,
    reps: set.reps,
    distanceKm: set.distanceKm ?? null,
    durationSeconds: set.durationSeconds ?? null,
    rpe: set.rpe,
    rir: set.rir ?? null,
    techniqueIssue: set.techniqueIssue ?? null,
    limitationCause: set.limitationCause ?? null,
    pain: set.pain ?? null,
    note: set.note,
  };
}

function frozenPrescription(
  occurrence: SessionOccurrenceData,
): ActiveSetFrozenPrescription {
  return {
    repsMin: occurrence.plannedRepsMin,
    repsMax: occurrence.plannedRepsMax,
    load: occurrence.plannedLoad,
    loadUnit: occurrence.plannedLoadUnit,
    loadPercent: occurrence.plannedLoadPercent,
    loadText: occurrence.plannedLoadText,
    note: occurrence.plannedNote,
  };
}

function versionEvidence(
  set: LoggedSet,
  provided: ActiveSetVersionEvidence | undefined,
): ActiveSetVersionEvidence {
  if (provided != null) return provided;
  const correctionCount = set.correctionCount ?? 0;
  return correctionCount > 0
    ? { state: "corrected", count: correctionCount }
    : { state: "original", count: 0 };
}

function supportedVersionEvidence(
  evidence: ActiveSetVersionEvidence,
): ActiveSetVersionEvidence | null {
  const state = evidence.state;
  switch (state) {
    case "original":
      return { state: "original", count: 0 };
    case "corrected":
    case "version_restored":
    case "snapshot_restored":
      return evidence;
    default:
      return null;
  }
}

function unsupportedOccurrenceOrigin(origin: never): "unknown" {
  void origin;
  return "unknown";
}

function activeSetMembership(
  occurrence: SessionOccurrenceData,
): ActiveSetMembership {
  switch (occurrence.origin) {
    case "planned":
    case "ad_hoc":
    case "imported":
    case "legacy":
      return workingSetSemanticRole(occurrence);
    default:
      return unsupportedOccurrenceOrigin(occurrence.origin);
  }
}

function unknownSaveState(
  base: ActiveSetRowWithPrescription,
  result: ActiveSetExactResult,
  state: never,
  version: ActiveSetVersionEvidence,
): ActiveSetRow {
  return {
    ...base,
    state: "unknown_legacy",
    prescription: null,
    result,
    version,
    message: `This result has unsupported save evidence (${String(state)}) and cannot be presented as saved.`,
  };
}

function retainedResultWithoutClientIdentity(
  base: ActiveSetRowWithPrescription,
  result: ActiveSetExactResult,
  version: ActiveSetVersionEvidence,
): ActiveSetRow {
  return {
    ...base,
    state: "unknown_legacy",
    prescription: null,
    result,
    version,
    message:
      "This retained result has no durable client identity and cannot be presented as saved.",
  };
}

function unknownOccurrenceOutcome(
  base: ActiveSetRowBase,
  set: LoggedSet | null,
  outcome: never,
  version: ActiveSetVersionEvidence | null,
): ActiveSetRow {
  return {
    ...base,
    state: "unknown_legacy",
    prescription: null,
    result: set == null ? null : exactResult(set),
    version,
    message: `This occurrence has an unsupported outcome (${String(outcome)}) and cannot be presented as planned or completed.`,
  };
}

function unknownVersionState(
  base: ActiveSetRowWithPrescription,
  result: ActiveSetExactResult,
  state: never,
): ActiveSetRow {
  return {
    ...base,
    state: "unknown_legacy",
    prescription: null,
    result,
    version: null,
    message: `This result has unsupported version evidence (${String(state)}) and cannot be presented as original, corrected, or restored.`,
  };
}

function resultState(
  base: ActiveSetRowWithPrescription,
  set: LoggedSet,
  version: ActiveSetVersionEvidence,
): ActiveSetRow {
  const result = exactResult(set);
  const clientKey = set.clientKey;
  const versionState = version.state;
  let normalizedVersion: ActiveSetVersionEvidence;
  switch (versionState) {
    case "original":
      normalizedVersion = { state: "original", count: 0 };
      break;
    case "corrected":
    case "version_restored":
    case "snapshot_restored":
      normalizedVersion = version;
      break;
    default:
      return unknownVersionState(base, result, versionState);
  }
  switch (set.saveState) {
    case "pending":
      return clientKey == null
        ? retainedResultWithoutClientIdentity(base, result, normalizedVersion)
        : {
            ...base,
            state: "retained_locally",
            result,
            version: normalizedVersion,
            clientKey,
          };
    case "saving":
      return clientKey == null
        ? retainedResultWithoutClientIdentity(base, result, normalizedVersion)
        : {
            ...base,
            state: "saving",
            result,
            version: normalizedVersion,
            clientKey,
          };
    case "retrying":
      return clientKey == null
        ? retainedResultWithoutClientIdentity(base, result, normalizedVersion)
        : {
            ...base,
            state: "retrying",
            result,
            version: normalizedVersion,
            clientKey,
          };
    case "failed":
      return clientKey == null
        ? retainedResultWithoutClientIdentity(base, result, normalizedVersion)
        : {
            ...base,
            state: "failed",
            result,
            version: normalizedVersion,
            clientKey,
            error: set.lastError ?? null,
          };
    case "saved":
    case undefined:
      return {
        ...base,
        state: "saved",
        result,
        version: normalizedVersion,
      };
    default:
      return unknownSaveState(
        base,
        result,
        set.saveState,
        normalizedVersion,
      );
  }
}

/**
 * Projects one exercise's occurrence ledger into exhaustive presentation rows.
 * It never creates order, mutates a command, or treats an unmatched set as a
 * planned occurrence. Diagnostics keep incomplete relationships visible to the
 * caller instead of silently dropping their meaning.
 */
export function projectActiveSetRows(
  input: ActiveSetRowProjectionInput,
): ActiveSetRowProjection {
  const { results, acknowledgedOutboxClientKeys } = resultCandidates(input);
  const occurrences = input.occurrences
    .filter(
      (occurrence) =>
        occurrence.kind === "working_set" &&
        occurrence.sessionExerciseId === input.exercise.id,
    )
    .sort(
      (left, right) =>
        left.sequenceIdx - right.sequenceIdx || left.id.localeCompare(right.id),
    );
  const linkedSetIds = new Set<string>();
  const duplicateSetIds = new Set<string>();
  const contradictoryOccurrenceIds = new Set<string>();

  const rows = occurrences.map((occurrence): ActiveSetRow => {
    const byCompletedIdentity = occurrence.completedSetId == null
        ? []
        : results.filter(
          (set) => set.id === occurrence.completedSetId,
        );
    const byOccurrenceIdentity = results.filter(
      (set) => set.occurrenceId === occurrence.id,
    );
    const candidates = [...byCompletedIdentity, ...byOccurrenceIdentity].filter(
      (set, index, all) =>
        all.findIndex((candidate) => candidate.id === set.id) === index,
    );
    const set = byCompletedIdentity[0] ?? byOccurrenceIdentity[0] ?? null;
    const rawVersion = set == null
      ? null
      : versionEvidence(set, input.versionEvidenceBySetId?.[set.id]);
    const supportedVersion = rawVersion == null
      ? null
      : supportedVersionEvidence(rawVersion);
    if (set != null) linkedSetIds.add(set.id);
    for (const duplicate of candidates.slice(1)) {
      duplicateSetIds.add(duplicate.id);
    }
    const position = workingSetDisplayPosition(occurrence, occurrences);
    const membership = activeSetMembership(occurrence);
    const base: ActiveSetRowBase = {
      key: occurrence.id,
      occurrenceId: occurrence.id,
      sessionExerciseId: input.exercise.id,
      sequenceIdx: occurrence.sequenceIdx,
      label: position.label,
      outcome: occurrence.outcome,
      membership,
      group: occurrence.groupSnapshotId == null
        ? null
        : {
            id: occurrence.groupSnapshotId,
            round: occurrence.groupRound,
            memberOrder: occurrence.groupMemberOrderIdx,
          },
    };

    if (
      membership === "unknown" ||
      occurrence.origin === "legacy" ||
      occurrence.outcome === "legacy_unrecorded"
    ) {
      return {
        ...base,
        state: "unknown_legacy",
        prescription: null,
        result: set == null ? null : exactResult(set),
        version: supportedVersion,
        message: membership === "unknown"
          ? "This set has an unsupported origin and cannot be presented as planned or completed."
          : "This legacy set does not have complete supported evidence.",
      };
    }

    const prescribedBase: ActiveSetRowWithPrescription = {
      ...base,
      prescription: frozenPrescription(occurrence),
    };
    if (occurrence.outcome === "skipped") {
      if (set != null) {
        contradictoryOccurrenceIds.add(occurrence.id);
        return {
          ...base,
          state: "unknown_legacy",
          prescription: null,
          result: exactResult(set),
          version: supportedVersion,
          message:
            "This occurrence is skipped but also has a linked result; review the retained evidence.",
        };
      }
      return {
        ...prescribedBase,
        state: "skipped",
        result: null,
        version: null,
        reasonCode: occurrence.outcomeReason,
        note: occurrence.outcomeNote,
      };
    }
    if (occurrence.outcome === "abandoned") {
      if (set != null) {
        contradictoryOccurrenceIds.add(occurrence.id);
        return {
          ...base,
          state: "unknown_legacy",
          prescription: null,
          result: exactResult(set),
          version: supportedVersion,
          message:
            "This occurrence is abandoned but also has a linked result; review the retained evidence.",
        };
      }
      return {
        ...prescribedBase,
        state: "abandoned",
        result: null,
        version: null,
        reasonCode: occurrence.outcomeReason,
        note: occurrence.outcomeNote,
      };
    }
    if (
      occurrence.outcome !== "pending" &&
      occurrence.outcome !== "completed"
    ) {
      return unknownOccurrenceOutcome(
        base,
        set,
        occurrence.outcome,
        supportedVersion,
      );
    }
    if (set != null) {
      const resultIsAcknowledged =
        set.saveState == null || set.saveState === "saved";
      if (occurrence.outcome === "pending" && resultIsAcknowledged) {
        contradictoryOccurrenceIds.add(occurrence.id);
        return {
          ...base,
          state: "unknown_legacy",
          prescription: null,
          result: exactResult(set),
          version: supportedVersion,
          message:
            "This acknowledged result is linked to an unresolved occurrence and needs review.",
        };
      }
      return resultState(
        prescribedBase,
        set,
        rawVersion ?? versionEvidence(
          set,
          input.versionEvidenceBySetId?.[set.id],
        ),
      );
    }
    if (occurrence.outcome === "completed") {
      return {
        ...prescribedBase,
        state: "completed_without_result",
        result: null,
        version: null,
        message: "This occurrence is complete but has no linked saved result.",
      };
    }
    if (occurrence.id === input.currentOccurrenceId) {
      return {
        ...prescribedBase,
        state: "current_editable",
        result: null,
        version: null,
        blockingReason: input.currentBlockingReason?.trim() || null,
      };
    }
    return {
      ...prescribedBase,
      state: "planned",
      result: null,
      version: null,
    };
  });

  return {
    rows,
    diagnostics: {
      unlinkedSetIds: input.exercise.sets
        .concat(
          results.filter(
            (result) => !input.exercise.sets.some(
              (set) => set.id === result.id,
            ),
          ),
        )
        .filter((set) => !linkedSetIds.has(set.id) && !duplicateSetIds.has(set.id))
        .map((set) => set.id)
        .sort(),
      duplicateSetIds: [...duplicateSetIds].sort(),
      contradictoryOccurrenceIds: [...contradictoryOccurrenceIds].sort(),
      acknowledgedOutboxClientKeys: [...acknowledgedOutboxClientKeys].sort(),
    },
  };
}
