import type {
  LoggedSet,
  SessionEquipmentSetup,
  SessionExerciseData,
  SessionExerciseGroupData,
  SessionOccurrenceData,
} from "@/components/session/types";
import {
  type WorkingSetDisplayPosition,
  type WorkingSetSemanticRole,
  workingSetDisplayPosition,
  workingSetSemanticRole,
} from "@/lib/session-occurrences";
import type { DurableRestTimer } from "@/lib/rest-timer";

export type WorkingOccurrenceTruth =
  | "performed"
  | "skipped"
  | "abandoned"
  | "pending"
  | "legacy_unknown"
  | "completed_without_result";

export type SessionGuidanceAction = {
  kind: "working_set";
  occurrenceId: string;
  sessionExerciseId: string;
  sequenceIdx: number;
  truth: WorkingOccurrenceTruth;
  role: WorkingSetSemanticRole;
  actualExerciseId: string;
  actualExerciseName: string;
  plannedExerciseId: string | null;
  plannedExerciseName: string;
  substituted: boolean;
  position: WorkingSetDisplayPosition;
  planned: {
    setNumber: number;
    repsMin: number | null;
    repsMax: number | null;
    load: number | null;
    loadUnit: "lb" | "kg" | null;
    loadPercent: number | null;
    loadText: string | null;
  };
  performed: {
    exerciseId: string;
    setId: string;
    setNumber: number;
    reps: number | null;
    load: number | null;
    loadUnit: "lb" | "kg" | null;
    metricType: LoggedSet["metricType"];
    distanceKm: number | null;
    durationSeconds: number | null;
    rpe: number | null;
  } | null;
  restAfter: SessionRestAfter;
  group: {
    id: string;
    name: string;
    round: number;
    member: number;
    memberCount: number;
  } | null;
};

export type SessionRestKind =
  | "straight_set"
  | "between_members"
  | "between_rounds"
  | "none"
  | "unknown";

export type SessionRestAfter = {
  kind: SessionRestKind;
  seconds: number | null;
};

export type SessionWarmupGuidanceAction = {
  kind: "day_warmup" | "exercise_warmup";
  occurrenceId: string;
  sessionExerciseId: string | null;
  sequenceIdx: number;
  label: string;
  exerciseName: string | null;
};

export type SessionRestGuidanceAction = {
  kind: "rest";
  actionId: string;
  sequenceIdx: number;
  phase: "running" | "ready" | "skipped";
  restKind: Exclude<SessionRestKind, "none">;
  totalSec: number;
  source: SessionGuidanceAction | null;
};

export type SessionOccurrenceGuidanceAction =
  | SessionGuidanceAction
  | SessionWarmupGuidanceAction;

export type SessionGuidanceFocusAction =
  | SessionOccurrenceGuidanceAction
  | SessionRestGuidanceAction;

export type OccurrenceCompletionState =
  | "not_started"
  | "in_progress"
  | "resolved"
  | "resolved_with_changes";

export type ExerciseProgressProjection = {
  sessionExerciseId: string;
  exerciseName: string;
  planned: number;
  total: number;
  extra: number;
  workoutOnly: number;
  performed: number;
  plannedPerformed: number;
  extraPerformed: number;
  workoutOnlyPerformed: number;
  skipped: number;
  abandoned: number;
  pending: number;
  legacyUnknown: number;
  completedWithoutResult: number;
  status:
    | "not_started"
    | "current"
    | "in_progress"
    | "performed"
    | "skipped"
    | "partial";
};

export type GroupProgressProjection = {
  groupId: string;
  name: string;
  plannedRounds: number | null;
  totals: ReturnType<typeof countTruth>;
  status:
    | "not_started"
    | "in_progress"
    | "performed"
    | "skipped"
    | "abandoned"
    | "partial";
  completion: OccurrenceCompletionState;
  members: Array<{
    sessionExerciseId: string;
    order: number;
    exerciseName: string;
    plannedExerciseName: string;
    substituted: boolean;
    totals: ReturnType<typeof countTruth>;
    status:
      | "not_started"
      | "in_progress"
      | "performed"
      | "skipped"
      | "abandoned"
      | "partial";
    completion: OccurrenceCompletionState;
  }>;
  rounds: Array<{
    round: number;
    total: number;
    planned: number;
    extra: number;
    workoutOnly: number;
    performed: number;
    plannedPerformed: number;
    extraPerformed: number;
    workoutOnlyPerformed: number;
    skipped: number;
    abandoned: number;
    pending: number;
    legacyUnknown: number;
    completedWithoutResult: number;
    status:
      | "not_started"
      | "in_progress"
      | "performed"
      | "skipped"
      | "abandoned"
      | "partial";
    completion: OccurrenceCompletionState;
  }>;
};

export type ActiveGroupProjection = {
  groupId: string;
  name: string;
  plannedRounds: number | null;
  memberCount: number;
  currentRound: number;
  currentMemberOrder: number;
  currentMemberName: string;
  upNextMemberOrder: number | null;
  upNextMemberName: string | null;
  restAfterCurrent: SessionRestAfter;
  activeRest: SessionRestGuidanceAction | null;
  hasLaterResolvedWork: boolean;
  totals: GroupProgressProjection["totals"];
  status: GroupProgressProjection["status"];
  completion: GroupProgressProjection["completion"];
  members: GroupProgressProjection["members"];
  rounds: GroupProgressProjection["rounds"];
};

export type EquipmentPreparationCue = {
  status:
    | "none"
    | "selected"
    | "pending_confirmation"
    | "choice_required"
    | "unavailable"
    | "broad_only"
    | "updating";
  exerciseName: string | null;
  equipmentLabel: string | null;
  attachmentLabel: string | null;
  guidance: string | null;
  message: string;
  preciseClaimAllowed: boolean;
};

export type SessionGuidanceProjection = {
  completion: {
    state: "in_progress" | "ready_to_finish";
    pendingOccurrences: number;
    limitedEvidenceOccurrences: number;
    evidenceLimited: boolean;
  };
  totals: {
    planned: number;
    total: number;
    extra: number;
    workoutOnly: number;
    performed: number;
    plannedPerformed: number;
    extraPerformed: number;
    workoutOnlyPerformed: number;
    skipped: number;
    abandoned: number;
    pending: number;
    legacyUnknown: number;
    completedWithoutResult: number;
    remainingAfterCurrent: number;
  };
  warmups: {
    planned: number;
    completed: number;
    skipped: number;
    remaining: number;
  };
  actions: SessionGuidanceAction[];
  current: SessionGuidanceAction | null;
  upNext: SessionGuidanceAction | null;
  currentAction: SessionGuidanceFocusAction | null;
  nextAction: SessionGuidanceFocusAction | null;
  exercises: ExerciseProgressProjection[];
  groups: GroupProgressProjection[];
  activeGroup: ActiveGroupProjection | null;
  currentEquipment: EquipmentPreparationCue;
  upcomingEquipment: EquipmentPreparationCue;
};

export function sessionNonPerformedOutcomeParts(
  totals: SessionGuidanceProjection["totals"],
) {
  return [
    totals.skipped > 0 ? `${totals.skipped} skipped` : null,
    totals.pending > 0 ? `${totals.pending} still pending` : null,
    totals.abandoned > 0 ? `${totals.abandoned} abandoned` : null,
    totals.legacyUnknown > 0
      ? `${totals.legacyUnknown} legacy outcome unknown`
      : null,
    totals.completedWithoutResult > 0
      ? `${totals.completedWithoutResult} missing saved-result evidence`
      : null,
  ].filter((value): value is string => value != null);
}

export function formatSessionGuidanceAction(
  action: SessionGuidanceFocusAction,
) {
  if (action.kind === "rest") {
    const restLabel = action.restKind === "between_members"
      ? "Member rest"
      : action.restKind === "between_rounds"
        ? "Round rest"
        : action.restKind === "straight_set"
          ? "Rest"
          : "Rest timer";
    const phase = action.phase === "running"
      ? ""
      : action.phase === "ready"
        ? " complete"
        : " skipped";
    if (!action.source) return `${restLabel}${phase}`;
    return `${restLabel}${phase} after ${action.source.actualExerciseName}, ${action.source.position.lowercaseLabel}`;
  }
  if (action.kind === "working_set") {
    const setLabel = action.position.lowercaseLabel;
    if (!action.group) return `${action.actualExerciseName}, ${setLabel}`;
    return `${action.group.name}, round ${action.group.round}, member ${action.group.member} of ${action.group.memberCount}: ${action.actualExerciseName}, ${setLabel}`;
  }
  if (action.kind === "exercise_warmup" && action.exerciseName) {
    return `${action.exerciseName} — preparation set: ${action.label}`;
  }
  return action.label;
}

type Input = {
  occurrences: SessionOccurrenceData[];
  exercises: SessionExerciseData[];
  exerciseGroups: SessionExerciseGroupData[];
  equipmentSetups: Record<string, SessionEquipmentSetup>;
  restTimer?: DurableRestTimer | null;
};

function isRetainedSet(set: LoggedSet) {
  return set.saveState == null || set.saveState === "saved";
}

function occurrenceTruth(
  occurrence: SessionOccurrenceData,
  retainedSets: Map<string, { exercise: SessionExerciseData; set: LoggedSet }>,
): WorkingOccurrenceTruth {
  if (occurrence.outcome === "completed") {
    return occurrence.completedSetId != null && retainedSets.has(occurrence.completedSetId)
      ? "performed"
      : "completed_without_result";
  }
  if (occurrence.outcome === "legacy_unrecorded") return "legacy_unknown";
  return occurrence.outcome;
}

function countTruth(actions: SessionGuidanceAction[]) {
  return {
    total: actions.length,
    planned: actions.filter((action) => action.role === "planned").length,
    extra: actions.filter((action) => action.role === "extra").length,
    workoutOnly: actions.filter((action) => action.role === "workout_only").length,
    performed: actions.filter((action) => action.truth === "performed").length,
    plannedPerformed: actions.filter(
      (action) => action.role === "planned" && action.truth === "performed",
    ).length,
    extraPerformed: actions.filter(
      (action) => action.role === "extra" && action.truth === "performed",
    ).length,
    workoutOnlyPerformed: actions.filter(
      (action) => action.role === "workout_only" && action.truth === "performed",
    ).length,
    skipped: actions.filter((action) => action.truth === "skipped").length,
    abandoned: actions.filter((action) => action.truth === "abandoned").length,
    pending: actions.filter((action) => action.truth === "pending").length,
    legacyUnknown: actions.filter((action) => action.truth === "legacy_unknown").length,
    completedWithoutResult: actions.filter(
      (action) => action.truth === "completed_without_result",
    ).length,
  };
}

function progressStatus(
  counts: ReturnType<typeof countTruth>,
): GroupProgressProjection["status"] {
  const resolved = counts.performed + counts.skipped + counts.abandoned +
    counts.legacyUnknown + counts.completedWithoutResult;
  if (counts.total > 0 && counts.performed === counts.total) {
    return "performed";
  }
  if (counts.total > 0 && counts.skipped === counts.total) {
    return "skipped";
  }
  if (counts.total > 0 && counts.abandoned === counts.total) {
    return "abandoned";
  }
  if (counts.pending === counts.total) return "not_started";
  if (counts.pending > 0 && resolved > 0) return "in_progress";
  return "partial";
}

function completionState(
  counts: ReturnType<typeof countTruth>,
): OccurrenceCompletionState {
  if (counts.total === 0 || counts.pending === counts.total) return "not_started";
  if (counts.pending > 0) return "in_progress";
  return counts.performed === counts.total
    ? "resolved"
    : "resolved_with_changes";
}

function projectRestAfterOccurrence(
  occurrence: SessionOccurrenceData,
  occurrences: SessionOccurrenceData[],
): SessionRestAfter {
  const seconds = occurrence.plannedRestSec;
  if (seconds == null) return { kind: "unknown", seconds: null };
  if (seconds === 0) return { kind: "none", seconds: 0 };
  if (occurrence.groupSnapshotId == null) {
    return { kind: "straight_set", seconds };
  }
  if (
    occurrence.groupRound == null ||
    occurrence.groupMemberOrderIdx == null
  ) {
    return { kind: "unknown", seconds };
  }
  const nextInGroup = occurrences
    .filter(
      (candidate) =>
        candidate.kind === "working_set" &&
        candidate.groupSnapshotId === occurrence.groupSnapshotId &&
        candidate.sequenceIdx > occurrence.sequenceIdx,
    )
    .sort((left, right) => left.sequenceIdx - right.sequenceIdx)[0];
  if (!nextInGroup || nextInGroup.groupRound == null) {
    return { kind: "unknown", seconds };
  }
  return {
    kind: nextInGroup.groupRound === occurrence.groupRound
      ? "between_members"
      : "between_rounds",
    seconds,
  };
}

function actionHasUnacknowledgedSet(
  action: SessionOccurrenceGuidanceAction | null,
  exerciseById: Map<string, SessionExerciseData>,
) {
  if (action?.kind !== "working_set") return false;
  return exerciseById.get(action.sessionExerciseId)?.sets.some(
    (set) =>
      set.occurrenceId === action.occurrenceId &&
      set.saveState != null &&
      set.saveState !== "saved",
  ) ?? false;
}

function projectRestGuidance(
  timer: DurableRestTimer | null | undefined,
  actions: SessionGuidanceAction[],
  occurrences: SessionOccurrenceData[],
  exerciseById: Map<string, SessionExerciseData>,
): SessionRestGuidanceAction | null {
  if (!timer || timer.phase === "continued") return null;
  const sourceOccurrence = timer.sourceOccurrenceId == null ||
      timer.sourceSessionExerciseId == null
    ? null
    : occurrences.find(
        (occurrence) =>
          occurrence.id === timer.sourceOccurrenceId &&
          occurrence.kind === "working_set" &&
          occurrence.sessionExerciseId === timer.sourceSessionExerciseId &&
          (timer.sourceCompletedSetId == null ||
            occurrence.completedSetId === timer.sourceCompletedSetId),
      ) ?? null;
  const optimisticSourceMatches =
    sourceOccurrence != null &&
    timer.sourceClientKey != null &&
    exerciseById.get(sourceOccurrence.sessionExerciseId ?? "")?.sets.some(
      (set) =>
        set.clientKey === timer.sourceClientKey &&
        set.occurrenceId === sourceOccurrence.id &&
        set.saveState != null &&
        set.saveState !== "saved",
    ) === true;
  const source = sourceOccurrence
    ? actions.find(
        (action) =>
          action.occurrenceId === sourceOccurrence.id &&
          (action.truth === "performed" || optimisticSourceMatches),
      ) ?? null
    : null;
  const restKind = source?.restAfter.kind === "none" || !source
    ? "unknown"
    : source.restAfter.kind;
  return {
    kind: "rest",
    actionId: `rest:${timer.generationId}`,
    sequenceIdx: source?.sequenceIdx ?? -1,
    phase: timer.phase,
    restKind,
    totalSec: timer.totalSec,
    source,
  };
}

function broadEquipmentLabel(loadType: string): string | null {
  const labels: Record<string, string> = {
    barbell: "Barbell and owned weight plates",
    ez_bar: "EZ-curl bar and owned weight plates",
    trap_bar: "Trap bar and owned weight plates",
    specialty_bar: "Specialty bar and owned weight plates",
    dumbbell: "Dumbbells",
    kettlebell: "Kettlebell",
    cable: "Cable machine",
    selectorized: "Selectorized machine",
    machine: "Machine",
    plate_loaded_machine: "Plate-loaded machine and compatible plates",
    band: "Resistance band",
    external: "External or unrecorded equipment",
  };
  return labels[loadType] ?? null;
}

function guidanceIsExplicitlyLimited(guidance: string | null) {
  return guidance != null && /\b(?:unknown|unavailable|not fully known|no recorded)\b/i.test(guidance);
}

export function sessionEquipmentSetupMatchesExercise(
  exercise: Pick<
    SessionExerciseData,
    "exerciseId" | "targetLoad" | "targetLoadUnit"
  >,
  setup: SessionEquipmentSetup,
) {
  return setup.sourceExerciseId === exercise.exerciseId &&
    setup.sourceTargetLoad === exercise.targetLoad &&
    setup.sourceTargetLoadUnit === exercise.targetLoadUnit;
}

export function projectEquipmentPreparationCue(
  action: SessionGuidanceAction | null,
  exercise: SessionExerciseData | null,
  setup: SessionEquipmentSetup | null,
): EquipmentPreparationCue {
  if (!action || !exercise) {
    return {
      status: "none",
      exerciseName: null,
      equipmentLabel: null,
      attachmentLabel: null,
      guidance: null,
      message: "No further equipment preparation is scheduled.",
      preciseClaimAllowed: false,
    };
  }

  if (!setup) {
    if (exercise.loadType === "bodyweight") {
      return {
        status: "broad_only",
        exerciseName: exercise.name,
        equipmentLabel: null,
        attachmentLabel: null,
        guidance: null,
        message: "No external equipment is required for this bodyweight movement.",
        preciseClaimAllowed: true,
      };
    }
    const label = broadEquipmentLabel(exercise.loadType);
    return {
      status: "broad_only",
      exerciseName: exercise.name,
      equipmentLabel: label,
      attachmentLabel: null,
      guidance: null,
      message: label
        ? `Prepare ${label}. The exact physical setup is not recorded.`
        : "The exact equipment preparation is not recorded.",
      preciseClaimAllowed: false,
    };
  }

  const sourceMatches = sessionEquipmentSetupMatchesExercise(exercise, setup);
  if (!sourceMatches) {
    return {
      status: "updating",
      exerciseName: exercise.name,
      equipmentLabel: null,
      attachmentLabel: null,
      guidance: null,
      message:
        "Updating equipment guidance… Old implement and plate details are withheld.",
      preciseClaimAllowed: false,
    };
  }

  if (setup.status === "unavailable") {
    return {
      status: "unavailable",
      exerciseName: exercise.name,
      equipmentLabel: null,
      attachmentLabel: null,
      guidance: null,
      message: "No reviewed equipment setup is currently available.",
      preciseClaimAllowed: false,
    };
  }

  if (setup.currentSnapshotId != null) {
    if (!setup.currentSelectionAvailable) {
      return {
        status: "unavailable",
        exerciseName: exercise.name,
        equipmentLabel: setup.currentEquipmentLabel,
        attachmentLabel: setup.currentAttachmentLabel,
        guidance: null,
        message: "The recorded setup is no longer in the available setup list; confirm a current setup before preparing.",
        preciseClaimAllowed: false,
      };
    }
    return {
      status: "selected",
      exerciseName: exercise.name,
      equipmentLabel: setup.currentEquipmentLabel,
      attachmentLabel: setup.currentAttachmentLabel,
      guidance: setup.currentGuidance,
      message: "Prepare the selected workout setup.",
      preciseClaimAllowed:
        !guidanceIsExplicitlyLimited(setup.currentGuidance),
    };
  }

  if (setup.options.length === 1) {
    const option = setup.options[0];
    return {
      status: "pending_confirmation",
      exerciseName: exercise.name,
      equipmentLabel: option.equipmentLabel,
      attachmentLabel: option.attachmentLabel,
      guidance: null,
      message: "The only reviewed setup is still being confirmed; precise loading guidance is withheld until it is selected.",
      preciseClaimAllowed: false,
    };
  }

  return {
    status: "choice_required",
    exerciseName: exercise.name,
    equipmentLabel: null,
    attachmentLabel: null,
    guidance: null,
    message: "Choose the physical equipment setup before preparing a precise load.",
    preciseClaimAllowed: false,
  };
}

export function projectSessionGuidance(input: Input): SessionGuidanceProjection {
  const exerciseById = new Map(input.exercises.map((exercise) => [exercise.id, exercise]));
  const groupById = new Map(input.exerciseGroups.map((group) => [group.id, group]));
  const retainedSets = new Map<string, { exercise: SessionExerciseData; set: LoggedSet }>();
  for (const exercise of input.exercises) {
    for (const set of exercise.sets) {
      if (isRetainedSet(set)) retainedSets.set(set.id, { exercise, set });
    }
  }

  const actions = [...input.occurrences]
    .filter(
      (occurrence): occurrence is SessionOccurrenceData & { sessionExerciseId: string } =>
        occurrence.kind === "working_set" && occurrence.sessionExerciseId != null,
    )
    .sort((left, right) => left.sequenceIdx - right.sequenceIdx)
    .flatMap((occurrence): SessionGuidanceAction[] => {
      const exercise = exerciseById.get(occurrence.sessionExerciseId);
      if (!exercise) return [];
      const truth = occurrenceTruth(occurrence, retainedSets);
      const retained = occurrence.completedSetId
        ? retainedSets.get(occurrence.completedSetId) ?? null
        : null;
      const group = occurrence.groupSnapshotId
        ? groupById.get(occurrence.groupSnapshotId) ?? null
        : null;
      const memberCount = occurrence.groupSnapshotId
        ? group?.memberCount ?? new Set(
            input.occurrences
              .filter(
                (candidate) =>
                  candidate.kind === "working_set" &&
                  candidate.groupSnapshotId === occurrence.groupSnapshotId &&
                  candidate.groupRound === occurrence.groupRound,
              )
              .map((candidate) => candidate.groupMemberOrderIdx),
          ).size
        : 0;
      return [{
        kind: "working_set",
        occurrenceId: occurrence.id,
        sessionExerciseId: occurrence.sessionExerciseId,
        sequenceIdx: occurrence.sequenceIdx,
        truth,
        role: workingSetSemanticRole(occurrence),
        actualExerciseId: exercise.exerciseId,
        actualExerciseName: exercise.name,
        plannedExerciseId: occurrence.plannedExerciseId,
        plannedExerciseName: exercise.plannedExerciseName ?? exercise.name,
        substituted: exercise.modificationType === "substituted",
        position: workingSetDisplayPosition(occurrence, input.occurrences),
        planned: {
          setNumber: occurrence.kindOrdinal + 1,
          repsMin: occurrence.plannedRepsMin,
          repsMax: occurrence.plannedRepsMax,
          load: occurrence.plannedLoad,
          loadUnit: occurrence.plannedLoadUnit,
          loadPercent: occurrence.plannedLoadPercent,
          loadText: occurrence.plannedLoadText,
        },
        performed: truth === "performed" && retained
          ? {
              exerciseId: retained.exercise.exerciseId,
              setId: retained.set.id,
              setNumber: retained.set.setNo,
              reps: retained.set.reps,
              load: retained.set.weight,
              loadUnit: retained.set.weightUnit,
              metricType: retained.set.metricType,
              distanceKm: retained.set.distanceKm ?? null,
              durationSeconds: retained.set.durationSeconds ?? null,
              rpe: retained.set.rpe,
            }
          : null,
        restAfter: projectRestAfterOccurrence(occurrence, input.occurrences),
        group: occurrence.groupSnapshotId && occurrence.groupRound != null &&
          occurrence.groupMemberOrderIdx != null
          ? {
              id: occurrence.groupSnapshotId,
              name: group?.name ?? "Exercise group",
              round: occurrence.groupRound,
              member: occurrence.groupMemberOrderIdx + 1,
              memberCount,
            }
          : null,
      }];
    });

  // A locally retained set has already captured the performed action. Keep its
  // durable occurrence truth pending until the server acknowledges it, while
  // allowing the device UI and rest timer to move to the next action.
  const pending = actions.filter(
    (action) =>
      action.truth === "pending" &&
      !actionHasUnacknowledgedSet(action, exerciseById),
  );
  const current = pending[0] ?? null;
  const upNext = pending[1] ?? null;
  const pendingWarmups = input.occurrences
    .filter(
      (
        occurrence,
      ): occurrence is SessionOccurrenceData & {
        kind: "day_warmup" | "exercise_warmup";
      } =>
        occurrence.kind !== "working_set" && occurrence.outcome === "pending",
    )
    .map((occurrence): SessionWarmupGuidanceAction => {
      const exercise = occurrence.sessionExerciseId
        ? exerciseById.get(occurrence.sessionExerciseId) ?? null
        : null;
      return {
        kind: occurrence.kind,
        occurrenceId: occurrence.id,
        sessionExerciseId: occurrence.sessionExerciseId,
        sequenceIdx: occurrence.sequenceIdx,
        label: occurrence.label?.trim() || "Warm-up item",
        exerciseName: exercise?.name ?? null,
      };
    });
  const pendingActions: SessionOccurrenceGuidanceAction[] = [
    ...pendingWarmups,
    ...pending,
  ].sort((left, right) => left.sequenceIdx - right.sequenceIdx);
  const canonicalAction = pendingActions[0] ?? null;
  const occurrenceCurrentAction =
    canonicalAction?.kind !== "working_set" ? canonicalAction : current;
  const occurrenceNextAction = occurrenceCurrentAction
    ? pendingActions.find(
        (action) => action.occurrenceId !== occurrenceCurrentAction.occurrenceId,
      ) ?? null
    : null;
  const activeRest = projectRestGuidance(
    input.restTimer,
    actions,
    input.occurrences,
    exerciseById,
  );
  const acknowledgementPending = actionHasUnacknowledgedSet(
    occurrenceCurrentAction,
    exerciseById,
  );
  const currentAction: SessionGuidanceFocusAction | null =
    activeRest && !acknowledgementPending ? activeRest : occurrenceCurrentAction;
  const nextAction: SessionOccurrenceGuidanceAction | null =
    activeRest && !acknowledgementPending
    ? occurrenceCurrentAction
    : occurrenceNextAction;
  const totals = countTruth(actions);

  const exerciseProgress = input.exercises.map((exercise): ExerciseProgressProjection => {
    const exerciseActions = actions.filter(
      (action) => action.sessionExerciseId === exercise.id,
    );
    const counts = countTruth(exerciseActions);
    const resolved = counts.performed + counts.skipped + counts.abandoned +
      counts.legacyUnknown + counts.completedWithoutResult;
    let status: ExerciseProgressProjection["status"];
    if (
      occurrenceCurrentAction?.kind === "working_set" &&
      occurrenceCurrentAction.sessionExerciseId === exercise.id
    ) status = "current";
    else if (counts.total > 0 && counts.performed === counts.total) status = "performed";
    else if (counts.total > 0 && counts.skipped === counts.total) status = "skipped";
    else if (counts.pending === counts.total) status = "not_started";
    else if (counts.pending > 0 && resolved > 0) status = "in_progress";
    else status = "partial";
    return {
      sessionExerciseId: exercise.id,
      exerciseName: exercise.name,
      ...counts,
      status,
    };
  });

  const groups = [...input.exerciseGroups]
    .sort((left, right) => left.orderIdx - right.orderIdx)
    .map((group): GroupProgressProjection => {
      const groupActions = actions.filter((action) => action.group?.id === group.id);
      const roundNumbers = [...new Set(groupActions.flatMap((action) =>
        action.group ? [action.group.round] : []))].sort((left, right) => left - right);
      const memberNumbers = [...new Set(groupActions.flatMap((action) =>
        action.group ? [action.group.member] : []))].sort((left, right) => left - right);
      const totals = countTruth(groupActions);
      return {
        groupId: group.id,
        name: group.name,
        plannedRounds: group.plannedRounds,
        totals,
        status: progressStatus(totals),
        completion: completionState(totals),
        members: memberNumbers.flatMap((memberOrder) => {
          const memberActions = groupActions.filter(
            (action) => action.group?.member === memberOrder,
          );
          const first = memberActions[0];
          if (!first) return [];
          const memberTotals = countTruth(memberActions);
          return [{
            sessionExerciseId: first.sessionExerciseId,
            order: memberOrder,
            exerciseName: first.actualExerciseName,
            plannedExerciseName: first.plannedExerciseName,
            substituted: first.substituted,
            totals: memberTotals,
            status: progressStatus(memberTotals),
            completion: completionState(memberTotals),
          }];
        }),
        rounds: roundNumbers.map((round) => {
          const counts = countTruth(
            groupActions.filter((action) => action.group?.round === round),
          );
          return {
            round,
            ...counts,
            status: progressStatus(counts),
            completion: completionState(counts),
          };
        }),
      };
    });
  const activeGroupProgress =
    occurrenceCurrentAction?.kind === "working_set" && current?.group
      ? groups.find((group) => group.groupId === current.group?.id) ?? null
      : null;
  const activeGroup =
    occurrenceCurrentAction?.kind === "working_set" &&
    occurrenceCurrentAction.occurrenceId === current?.occurrenceId &&
    current?.group && activeGroupProgress
    ? {
        groupId: activeGroupProgress.groupId,
        name: activeGroupProgress.name,
        plannedRounds: activeGroupProgress.plannedRounds,
        memberCount: current.group.memberCount,
        currentRound: current.group.round,
        currentMemberOrder: current.group.member,
        currentMemberName: current.actualExerciseName,
        upNextMemberOrder:
          upNext?.group?.id === current.group.id ? upNext.group.member : null,
        upNextMemberName:
          upNext?.group?.id === current.group.id ? upNext.actualExerciseName : null,
        restAfterCurrent: current.restAfter,
        activeRest:
          activeRest?.source?.group?.id === current.group.id ? activeRest : null,
        hasLaterResolvedWork: actions.some(
          (action) =>
            action.group?.id === current.group?.id &&
            action.sequenceIdx > current.sequenceIdx &&
            action.truth !== "pending",
        ),
        totals: activeGroupProgress.totals,
        status: activeGroupProgress.status,
        completion: activeGroupProgress.completion,
        members: activeGroupProgress.members,
        rounds: activeGroupProgress.rounds,
      }
    : null;

  const warmupOccurrences = input.occurrences.filter(
    (occurrence) => occurrence.kind !== "working_set",
  );
  const currentExercise = current
    ? exerciseById.get(current.sessionExerciseId) ?? null
    : null;
  const upcomingExercise = upNext ? exerciseById.get(upNext.sessionExerciseId) ?? null : null;
  const pendingOccurrences = input.occurrences.filter(
    (occurrence) => occurrence.outcome === "pending",
  ).length;
  const limitedEvidenceOccurrences =
    input.occurrences.filter(
      (occurrence) => occurrence.outcome === "legacy_unrecorded",
    ).length + totals.completedWithoutResult;
  return {
    completion: {
      state: pendingOccurrences > 0
        ? "in_progress"
        : "ready_to_finish",
      pendingOccurrences,
      limitedEvidenceOccurrences,
      evidenceLimited: limitedEvidenceOccurrences > 0,
    },
    totals: {
      ...totals,
      remainingAfterCurrent: Math.max(0, totals.pending - (current ? 1 : 0)),
    },
    warmups: {
      planned: warmupOccurrences.length,
      completed: warmupOccurrences.filter(
        (occurrence) => occurrence.outcome === "completed",
      ).length,
      skipped: warmupOccurrences.filter(
        (occurrence) => occurrence.outcome === "skipped",
      ).length,
      remaining: warmupOccurrences.filter(
        (occurrence) => occurrence.outcome === "pending",
      ).length,
    },
    actions,
    current,
    upNext,
    currentAction,
    nextAction,
    exercises: exerciseProgress,
    groups,
    activeGroup,
    currentEquipment: projectEquipmentPreparationCue(
      current,
      currentExercise,
      current ? input.equipmentSetups[current.sessionExerciseId] ?? null : null,
    ),
    upcomingEquipment: projectEquipmentPreparationCue(
      upNext,
      upcomingExercise,
      upNext ? input.equipmentSetups[upNext.sessionExerciseId] ?? null : null,
    ),
  };
}
