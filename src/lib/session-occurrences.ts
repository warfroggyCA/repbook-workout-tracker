export type SessionOccurrenceKind =
  | "day_warmup"
  | "exercise_warmup"
  | "working_set";

export type SessionOccurrenceOrigin =
  | "planned"
  | "ad_hoc"
  | "imported"
  | "legacy";

export type SessionOccurrenceOutcome =
  | "pending"
  | "completed"
  | "skipped"
  | "abandoned"
  | "legacy_unrecorded";

export type LoadUnit = "lb" | "kg";

export const ADDED_WORKOUT_SET_NOTE = "Added during this workout";

type WorkingSetLabelOccurrence = {
  id: string;
  sessionExerciseId: string | null;
  kind: string;
  origin: string;
  kindOrdinal: number;
  plannedNote: string | null;
};

export type WorkingSetDisplayPosition = {
  kind: "set" | "extra";
  number: number;
  label: string;
  lowercaseLabel: string;
};

export type WorkingSetSemanticRole =
  | "planned"
  | "extra"
  | "workout_only"
  | "imported"
  | "legacy";

export function isAppendedExtraSetOccurrence(
  occurrence: WorkingSetLabelOccurrence,
) {
  return (
    occurrence.kind === "working_set" &&
    occurrence.origin === "ad_hoc" &&
    occurrence.plannedNote === ADDED_WORKOUT_SET_NOTE
  );
}

/**
 * Names the durable role of working-set evidence without changing its stored
 * origin or immutable execution ordinal.
 */
export function workingSetSemanticRole(
  occurrence: WorkingSetLabelOccurrence,
): WorkingSetSemanticRole {
  if (occurrence.origin === "planned") return "planned";
  if (isAppendedExtraSetOccurrence(occurrence)) return "extra";
  if (occurrence.origin === "ad_hoc") return "workout_only";
  if (occurrence.origin === "imported") return "imported";
  return "legacy";
}

/**
 * Separates a set's immutable execution ordinal from its user-facing meaning.
 *
 * Planned sets and the initial occurrences of a workout-only exercise retain
 * their normal Set N ordinal. An explicitly appended occurrence is numbered
 * only among appended siblings, so Program work never appears to grow after
 * the owner adds performed work.
 */
export function workingSetDisplayPosition(
  occurrence: WorkingSetLabelOccurrence,
  occurrences: WorkingSetLabelOccurrence[],
): WorkingSetDisplayPosition {
  if (!isAppendedExtraSetOccurrence(occurrence)) {
    const number = occurrence.kindOrdinal + 1;
    return {
      kind: "set",
      number,
      label: `Set ${number}`,
      lowercaseLabel: `set ${number}`,
    };
  }

  const number = occurrences.filter(
    (candidate) =>
      candidate.sessionExerciseId === occurrence.sessionExerciseId &&
      candidate.kindOrdinal <= occurrence.kindOrdinal &&
      isAppendedExtraSetOccurrence(candidate),
  ).length;
  return {
    kind: "extra",
    number,
    label: `Extra set ${number}`,
    lowercaseLabel: `extra set ${number}`,
  };
}

export interface SessionOccurrence {
  id: string;
  sessionId: string;
  sessionExerciseId: string | null;
  kind: SessionOccurrenceKind;
  origin: SessionOccurrenceOrigin;
  sequenceIdx: number;
  kindOrdinal: number;
  label: string | null;
  plannedExerciseId: string | null;
  plannedRepsMin: number | null;
  plannedRepsMax: number | null;
  plannedLoad: number | null;
  plannedLoadUnit: LoadUnit | null;
  plannedLoadPercent: number | null;
  plannedLoadText: string | null;
  plannedRestSec: number | null;
  plannedNote: string | null;
  groupSnapshotId: string | null;
  groupRound: number | null;
  groupMemberOrderIdx: number | null;
  outcome: SessionOccurrenceOutcome;
  outcomeReason: string | null;
  outcomeNote: string | null;
  revision: number;
  resolvedAt: string | null;
  createdAt: string;
  completedSetId: string | null;
  performedExerciseId?: string | null;
}

export interface SessionExerciseGroupSnapshot {
  id: string;
  sessionId: string;
  sourceGroupId: string | null;
  lineageId: string | null;
  provenance: "program" | "compiler" | "import" | "legacy";
  name: string | null;
  orderIdx: number;
  plannedRounds: number;
  memberCount: number;
  restBetweenMembersSec: number | null;
  restBetweenRoundsSec: number | null;
  snapshotVersion: number;
}

type WarmupInput = {
  sourceId: string;
  orderIdx: number;
  label: string;
  reps: number | null;
  load: number | null;
  loadUnit: LoadUnit | null;
  loadPercent: number | null;
  loadText: string | null;
  note: string | null;
};

type ExerciseWarmupInput = WarmupInput & { restSec: number | null };

export function buildWarmupOccurrences(input: {
  sessionId: string;
  createdAt: string;
  startingSequenceIdx: number;
  dayWarmups: WarmupInput[];
  exercises: Array<{
    sessionExerciseId: string;
    exerciseId: string;
    orderIdx: number;
    warmupSets: ExerciseWarmupInput[];
  }>;
  createOccurrenceId: (sequenceIdx: number) => string;
}): SessionOccurrence[] {
  let sequenceIdx = input.startingSequenceIdx;
  let dayOrdinal = 0;
  let exerciseOrdinal = 0;

  const build = (
    item: WarmupInput,
    kind: "day_warmup" | "exercise_warmup",
    sessionExerciseId: string | null,
    plannedExerciseId: string | null,
    plannedRestSec: number | null,
    kindOrdinal: number,
  ): SessionOccurrence => {
    const occurrence: SessionOccurrence = {
      id: input.createOccurrenceId(sequenceIdx),
      sessionId: input.sessionId,
      sessionExerciseId,
      kind,
      origin: "planned",
      sequenceIdx,
      kindOrdinal,
      label: item.label,
      plannedExerciseId,
      plannedRepsMin: item.reps,
      plannedRepsMax: item.reps,
      plannedLoad: item.load,
      plannedLoadUnit: item.loadUnit,
      plannedLoadPercent: item.loadPercent,
      plannedLoadText: item.loadText,
      plannedRestSec,
      plannedNote: item.note,
      groupSnapshotId: null,
      groupRound: null,
      groupMemberOrderIdx: null,
      outcome: "pending",
      outcomeReason: null,
      outcomeNote: null,
      revision: 0,
      resolvedAt: null,
      createdAt: input.createdAt,
      completedSetId: null,
    };
    sequenceIdx += 1;
    return occurrence;
  };

  const occurrences = [...input.dayWarmups]
    .sort((left, right) => left.orderIdx - right.orderIdx)
    .map((item) => build(item, "day_warmup", null, null, null, dayOrdinal++));

  for (const exercise of [...input.exercises].sort(
    (left, right) => left.orderIdx - right.orderIdx,
  )) {
    for (const item of [...exercise.warmupSets].sort(
      (left, right) => left.orderIdx - right.orderIdx,
    )) {
      occurrences.push(
        build(
          item,
          "exercise_warmup",
          exercise.sessionExerciseId,
          exercise.exerciseId,
          item.restSec,
          exerciseOrdinal++,
        ),
      );
    }
  }

  return occurrences;
}

type SimpleMutation =
  | { operation: "note"; note: string }
  | { operation: "complete"; resolvedAt: string; completedSet?: CompletedSetInput }
  | {
      operation: "skip";
      reason: string;
      note?: string;
      resolvedAt: string;
    }
  | { operation: "restore"; resolvedAt?: string };

type CompletedSetInput = {
  id: string;
  performedExerciseId: string;
  reps: number;
  load: number | null;
  loadUnit: LoadUnit | null;
};

type DurableMutation = SimpleMutation & {
  clientKey: string;
  expectedRevision: number;
};

export interface OccurrenceMutationReceipt {
  clientKey: string;
  occurrenceId: string;
  operation: DurableMutation["operation"];
  payloadFingerprint: string;
  expectedRevision: number;
  resultingRevision: number;
  resultCode: "saved";
}

export interface OccurrenceMutationState {
  occurrence: SessionOccurrence;
  receipts: OccurrenceMutationReceipt[];
}

type OccurrenceMutationResult = OccurrenceMutationState & {
  status: "saved" | "replayed" | "conflict";
  receipt?: OccurrenceMutationReceipt;
};

function mutateOccurrence(
  occurrence: SessionOccurrence,
  mutation: SimpleMutation,
): SessionOccurrence {
  if (occurrence.outcome === "legacy_unrecorded") {
    throw new Error("legacy_unrecorded is a terminal occurrence outcome");
  }

  const canMutate =
    (mutation.operation === "complete" && occurrence.outcome === "pending") ||
    (mutation.operation === "skip" && occurrence.outcome === "pending") ||
    (mutation.operation === "note" &&
      ["pending", "completed", "skipped"].includes(occurrence.outcome)) ||
    (mutation.operation === "restore" &&
      (["skipped", "abandoned"].includes(occurrence.outcome) ||
        (occurrence.kind !== "working_set" && occurrence.outcome === "completed")) &&
      !occurrence.outcomeReason?.startsWith("exercise:"));
  if (!canMutate) {
    throw new Error(`Cannot ${mutation.operation} an ${occurrence.outcome} occurrence`);
  }

  const next = { ...occurrence, revision: occurrence.revision + 1 };
  switch (mutation.operation) {
    case "note":
      return { ...next, outcomeNote: mutation.note };
    case "complete":
      return {
        ...next,
        outcome: "completed",
        outcomeReason: null,
        resolvedAt: mutation.resolvedAt,
        completedSetId: mutation.completedSet?.id ?? occurrence.completedSetId,
        performedExerciseId:
          mutation.completedSet?.performedExerciseId ?? occurrence.performedExerciseId,
      };
    case "skip":
      return {
        ...next,
        outcome: "skipped",
        outcomeReason: mutation.reason,
        outcomeNote: mutation.note ?? occurrence.outcomeNote,
        resolvedAt: mutation.resolvedAt,
        completedSetId: null,
        performedExerciseId: null,
      };
    case "restore":
      return {
        ...next,
        outcome: "pending",
        outcomeReason: null,
        resolvedAt: null,
        completedSetId: null,
        performedExerciseId: null,
      };
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function fingerprintMutation(mutation: DurableMutation): string {
  return JSON.stringify(canonicalize(mutation));
}

export function applyOccurrenceMutation(
  occurrence: SessionOccurrence,
  mutation: SimpleMutation,
): SessionOccurrence;
export function applyOccurrenceMutation(
  state: OccurrenceMutationState,
  mutation: DurableMutation,
): OccurrenceMutationResult;
export function applyOccurrenceMutation(
  target: SessionOccurrence | OccurrenceMutationState,
  mutation: SimpleMutation | DurableMutation,
): SessionOccurrence | OccurrenceMutationResult {
  if (!("occurrence" in target)) {
    return mutateOccurrence(target, mutation);
  }

  const durable = mutation as DurableMutation;
  const payloadFingerprint = fingerprintMutation(durable);
  const existing = target.receipts.find(
    (receipt) => receipt.clientKey === durable.clientKey,
  );
  if (existing) {
    return {
      ...target,
      status:
        existing.payloadFingerprint === payloadFingerprint
          ? "replayed"
          : "conflict",
      receipt:
        existing.payloadFingerprint === payloadFingerprint ? existing : undefined,
    };
  }

  if (target.occurrence.revision !== durable.expectedRevision) {
    return { ...target, status: "conflict" };
  }

  const occurrence = mutateOccurrence(target.occurrence, durable);
  const receipt: OccurrenceMutationReceipt = {
    clientKey: durable.clientKey,
    occurrenceId: occurrence.id,
    operation: durable.operation,
    payloadFingerprint,
    expectedRevision: durable.expectedRevision,
    resultingRevision: occurrence.revision,
    resultCode: "saved",
  };
  return {
    occurrence,
    receipts: [...target.receipts, receipt],
    status: "saved",
    receipt,
  };
}

export function abandonPendingOccurrences(
  occurrences: SessionOccurrence[],
  input: { resolvedAt: string; outcomeReason: string },
): SessionOccurrence[] {
  return occurrences.map((occurrence) =>
    occurrence.outcome === "pending"
      ? {
          ...occurrence,
          outcome: "abandoned",
          outcomeReason: input.outcomeReason,
          revision: occurrence.revision + 1,
          resolvedAt: input.resolvedAt,
        }
      : occurrence,
  );
}

export function countPerformedWorkingSets(
  occurrences: SessionOccurrence[],
): number {
  return occurrences.filter(
    (occurrence) =>
      occurrence.kind === "working_set" &&
      occurrence.outcome === "completed" &&
      occurrence.completedSetId !== null,
  ).length;
}

type GroupMemberInput = {
  sessionExerciseId: string;
  plannedExerciseId: string;
  groupMemberOrderIdx: number;
  setCount: number;
  repMin: number | null;
  repMax: number | null;
  plannedLoad: number | null;
  plannedLoadUnit: LoadUnit | null;
  plannedRestSec: number | null;
  plannedNote: string | null;
};

export function buildGroupWorkingOccurrences(input: {
  sessionId: string;
  group: SessionExerciseGroupSnapshot;
  firstSequenceIdx: number;
  createdAt: string;
  members: GroupMemberInput[];
  createOccurrenceId: (coordinates: {
    roundNumber: number;
    groupMemberOrderIdx: number;
  }) => string;
}): SessionOccurrence[] {
  const members = [...input.members].sort(
    (left, right) => left.groupMemberOrderIdx - right.groupMemberOrderIdx,
  );
  const occurrences: SessionOccurrence[] = [];
  let sequenceIdx = input.firstSequenceIdx;

  for (let roundNumber = 1; roundNumber <= input.group.plannedRounds; roundNumber += 1) {
    for (const member of members) {
      if (member.setCount < roundNumber) continue;
      occurrences.push({
        id: input.createOccurrenceId({
          roundNumber,
          groupMemberOrderIdx: member.groupMemberOrderIdx,
        }),
        sessionId: input.sessionId,
        sessionExerciseId: member.sessionExerciseId,
        kind: "working_set",
        origin: "planned",
        sequenceIdx,
        kindOrdinal: roundNumber - 1,
        label: null,
        plannedExerciseId: member.plannedExerciseId,
        plannedRepsMin: member.repMin,
        plannedRepsMax: member.repMax,
        plannedLoad: member.plannedLoad,
        plannedLoadUnit: member.plannedLoadUnit,
        plannedLoadPercent: null,
        plannedLoadText: null,
        plannedRestSec: member.plannedRestSec,
        plannedNote: member.plannedNote,
        groupSnapshotId: input.group.id,
        groupRound: roundNumber,
        groupMemberOrderIdx: member.groupMemberOrderIdx,
        outcome: "pending",
        outcomeReason: null,
        outcomeNote: null,
        revision: 0,
        resolvedAt: null,
        createdAt: input.createdAt,
        completedSetId: null,
      });
      sequenceIdx += 1;
    }
  }

  return occurrences;
}

export function nextActionableOccurrence(
  occurrences: SessionOccurrence[],
): SessionOccurrence | null {
  return (
    [...occurrences]
      .sort((left, right) => left.sequenceIdx - right.sequenceIdx)
      .find((occurrence) => occurrence.outcome === "pending") ?? null
  );
}

export function restAfterOccurrence(
  occurrence: SessionOccurrence,
  occurrences: SessionOccurrence[],
  group: SessionExerciseGroupSnapshot,
): { kind: "between_members" | "between_rounds" | "none"; seconds: number } {
  const ordered = [...occurrences]
    .filter((item) => item.groupSnapshotId === group.id)
    .sort((left, right) => left.sequenceIdx - right.sequenceIdx);
  const index = ordered.findIndex((item) => item.id === occurrence.id);
  const next = index >= 0 ? ordered[index + 1] : undefined;
  if (!next) return { kind: "none", seconds: 0 };
  if (next.groupRound === occurrence.groupRound) {
    return {
      kind: "between_members",
      seconds: group.restBetweenMembersSec ?? 0,
    };
  }
  return {
    kind: "between_rounds",
    seconds: group.restBetweenRoundsSec ?? 0,
  };
}

export function summarizeGroupRounds(
  occurrences: SessionOccurrence[],
  group: SessionExerciseGroupSnapshot,
): Array<{
  roundNumber: number;
  status: "complete" | "partial" | "pending";
  planned: number;
  completed: number;
  skipped: number;
  abandoned: number;
  pending: number;
}> {
  const summaries = [];
  for (let roundNumber = 1; roundNumber <= group.plannedRounds; roundNumber += 1) {
    const round = occurrences.filter(
      (occurrence) =>
        occurrence.groupSnapshotId === group.id &&
        occurrence.groupRound === roundNumber,
    );
    const completed = round.filter((item) => item.outcome === "completed").length;
    const skipped = round.filter((item) => item.outcome === "skipped").length;
    const abandoned = round.filter((item) => item.outcome === "abandoned").length;
    const pending = round.filter((item) => item.outcome === "pending").length;
    summaries.push({
      roundNumber,
      status:
        completed === round.length && round.length > 0
          ? "complete"
          : pending === round.length
            ? "pending"
            : "partial",
      planned: round.length,
      completed,
      skipped,
      abandoned,
      pending,
    } as const);
  }
  return summaries;
}
