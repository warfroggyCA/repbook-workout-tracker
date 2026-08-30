import type {
  SessionExerciseData,
  SessionOccurrenceData,
} from "@/components/session/types";
import {
  formatSessionGuidanceAction,
  type EquipmentPreparationCue,
  type SessionGuidanceFocusAction,
  type SessionGuidanceAction,
  type SessionGuidanceProjection,
} from "@/lib/session-guidance";
import {
  resolveFutureSetWriterMetricType,
  type PerformedMetricType,
  type SetLoadEntryMeaning,
} from "@/lib/set-metric-semantics";
import {
  resolveSetStartingLoad,
  type SetStartingLoadPreview,
} from "@/lib/set-starting-load";
import type { LoadUnit } from "@/lib/units";
import type {
  PreviousComparableSetEvidence,
  PreviousComparableSetResult,
} from "@/services/previous-comparable-sets";

export type ActiveWorkoutSaveState =
  | "retained_locally"
  | "saving"
  | "retrying"
  | "failed"
  | "acknowledged";

export type ActiveWorkoutQueueItem = {
  sessionExerciseId: string;
  exerciseName: string;
  order: number;
  status: SessionGuidanceProjection["exercises"][number]["status"];
  planned: number;
  total: number;
  extra: number;
  workoutOnly: number;
  performed: number;
  plannedPerformed: number;
  extraPerformed: number;
  workoutOnlyPerformed: number;
  pending: number;
  skipped: number;
  abandoned: number;
  legacyUnknown: number;
  completedWithoutResult: number;
  warmups: {
    total: number;
    pending: number;
    completed: number;
    skipped: number;
  };
  modification: SessionExerciseData["modificationType"];
  plannedExerciseName: string | null;
  group: {
    id: string;
    name: string;
  } | null;
  isCurrent: boolean;
  isNext: boolean;
};

export type ActiveWorkoutRecoveryItem = {
  kind:
    | "failed_set"
    | "unreadable_recorded_work"
    | "occurrence_queue_error"
    | "unresolved_exercise_skip";
  count: number;
  sessionExerciseId: string | null;
  label: string;
};

export type ActiveWorkoutComparableUnavailableReason =
  | Extract<
      PreviousComparableSetResult,
      { status: "unavailable" }
    >["reason"]
  | "comparison_loading"
  | "incompatible_load_entry_meaning"
  | "no_comparable_set_for_position"
  | "no_current_working_set";

export type ActiveWorkoutInputDefaults = {
  metricType: PerformedMetricType;
  load: SetStartingLoadPreview;
  reps: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
  note: string;
};

export type ActiveWorkoutViewModel = {
  displayMode: "action" | "rest" | "finish";
  currentAction: {
    action: SessionGuidanceFocusAction;
    label: string;
    occurrenceId: string | null;
    sessionExerciseId: string | null;
    exerciseName: string | null;
    setLabel: string | null;
    target: SessionGuidanceAction["planned"] | null;
    inputDefaults: ActiveWorkoutInputDefaults | null;
    blockingReason: string | null;
  } | null;
  previousComparable: {
    state: "available" | "temporarily_unavailable" | "unavailable";
    sessionExerciseId: string | null;
    set: PreviousComparableSetEvidence | null;
    source: Extract<
      PreviousComparableSetResult,
      { status: "available" }
    >["source"] | null;
    reason: ActiveWorkoutComparableUnavailableReason | null;
  };
  progress: SessionGuidanceProjection["totals"];
  rest: {
    phase: "running" | "ready" | "skipped";
    remainingSeconds: number | null;
    totalSeconds: number;
    destinationLabel: string | null;
  } | null;
  queue: ActiveWorkoutQueueItem[];
  saveState: {
    state: ActiveWorkoutSaveState;
    occurrenceId: string | null;
    sessionExerciseId: string;
  } | null;
  equipmentAttention: Array<{
    placement: "current" | "upcoming";
    sessionExerciseId: string | null;
    cue: EquipmentPreparationCue;
  }>;
  recovery: ActiveWorkoutRecoveryItem[];
  completion: {
    ready: boolean;
    blocked: boolean;
    blocker: string | null;
    pendingActions: number;
    evidenceLimited: boolean;
  };
};

export type ActiveWorkoutViewModelInput = {
  guidance: SessionGuidanceProjection;
  exercises: SessionExerciseData[];
  occurrences: SessionOccurrenceData[];
  unit: LoadUnit;
  loadEntryMeaningByExerciseId?: Record<string, SetLoadEntryMeaning | null>;
  comparisonUnavailableByExerciseId?: Record<string, boolean>;
  currentActionBlockingReason?: string | null;
  restRemainingSeconds?: number | null;
  finishBlocked?: boolean;
  completionBlocker?: string | null;
  unreadableRecordedWork?: boolean;
  occurrenceQueueError?: boolean;
  unresolvedExerciseSkip?: boolean;
};

function inputDefaults(
  action: SessionGuidanceFocusAction | null,
  exercise: SessionExerciseData | null,
  occurrence: SessionOccurrenceData | null,
  input: ActiveWorkoutViewModelInput,
): ActiveWorkoutInputDefaults | null {
  if (action?.kind !== "working_set" || exercise == null) return null;
  const metricType = resolveFutureSetWriterMetricType({
    metricType: exercise.metricType ?? "weight_reps",
    loadSemantics: exercise.loadSemantics,
  });
  const precedingSet = [...exercise.sets]
    .filter((set) => set.setNo < action.planned.setNumber)
    .sort((left, right) => right.setNo - left.setNo)[0] ?? null;
  const recordsRepetitions =
    metricType === "weight_reps" ||
    metricType === "reps" ||
    metricType === "assisted_reps";
  return {
    metricType,
    load: resolveSetStartingLoad({
      exercise,
      setNumber: action.planned.setNumber,
      unit: input.unit,
      loadEntryMeaning:
        input.loadEntryMeaningByExerciseId?.[exercise.id] ?? null,
      occurrence,
      comparisonTemporarilyUnavailable:
        input.comparisonUnavailableByExerciseId?.[exercise.id] === true,
    }),
    reps: recordsRepetitions
      ? precedingSet?.reps ??
        action.planned.repsMax ??
        action.planned.repsMin ??
        exercise.targetRepsMax ??
        exercise.targetRepsMin ??
        8
      : null,
    distanceKm: null,
    durationSeconds: null,
    note: exercise.modificationType === "substituted"
      ? ""
      : exercise.setNotes[action.planned.setNumber - 1] ?? "",
  };
}

function currentActionBlockingReason(
  action: SessionGuidanceFocusAction | null,
  exercises: SessionExerciseData[],
  input: ActiveWorkoutViewModelInput,
) {
  if (input.currentActionBlockingReason?.trim()) {
    return input.currentActionBlockingReason.trim();
  }
  if (input.unresolvedExerciseSkip) {
    return "Resolve the exercise skip before continuing.";
  }
  if (action?.kind !== "working_set") return null;
  const exactRetainedFailure = exercises.some((exercise) =>
    exercise.sets.some(
      (set) =>
        set.occurrenceId === action.occurrenceId && set.saveState === "failed",
    ),
  );
  return exactRetainedFailure
    ? "Resolve the retained copy for this set."
    : null;
}

function previousComparableProjection(
  action: SessionGuidanceFocusAction | null,
  exercise: SessionExerciseData | null,
  input: ActiveWorkoutViewModelInput,
): ActiveWorkoutViewModel["previousComparable"] {
  const sessionExerciseId = exercise?.id ?? null;
  if (action?.kind !== "working_set" || exercise == null) {
    return {
      state: "unavailable",
      sessionExerciseId,
      set: null,
      source: null,
      reason: "no_current_working_set",
    };
  }
  if (input.comparisonUnavailableByExerciseId?.[exercise.id] === true) {
    return {
      state: "temporarily_unavailable",
      sessionExerciseId,
      set: null,
      source: null,
      reason: "comparison_loading",
    };
  }
  const comparable = exercise.previousComparable;
  if (comparable?.status !== "available") {
    return {
      state: "unavailable",
      sessionExerciseId,
      set: null,
      source: null,
      reason: comparable?.reason ?? "no_comparable_history",
    };
  }
  const loadEntryMeaning =
    input.loadEntryMeaningByExerciseId?.[exercise.id] ?? null;
  const semanticsMatch =
    comparable.semantics.metricType !== "weight_reps" &&
      comparable.semantics.metricType !== "assisted_reps"
      ? true
      : comparable.semantics.loadEntryMeaning === loadEntryMeaning;
  if (!semanticsMatch) {
    return {
      state: "unavailable",
      sessionExerciseId,
      set: null,
      source: null,
      reason: "incompatible_load_entry_meaning",
    };
  }
  const comparableSet = comparable.sets.find(
    (set) => set.setNo === action.planned.setNumber,
  ) ?? comparable.sets.at(-1) ?? null;
  return comparableSet == null
    ? {
        state: "unavailable",
        sessionExerciseId,
        set: null,
        source: comparable.source,
        reason: "no_comparable_set_for_position",
      }
    : {
        state: "available",
        sessionExerciseId,
        set: comparableSet,
        source: comparable.source,
        reason: null,
      };
}

function actionOccurrenceId(action: SessionGuidanceFocusAction | null) {
  if (!action) return null;
  return action.kind === "rest"
    ? action.source?.occurrenceId ?? null
    : action.occurrenceId;
}

function actionSessionExerciseId(action: SessionGuidanceFocusAction | null) {
  if (!action) return null;
  if (action.kind === "working_set") return action.sessionExerciseId;
  if (action.kind === "exercise_warmup") return action.sessionExerciseId;
  if (action.kind === "rest") {
    return action.destination?.sessionExerciseId ??
      action.source?.sessionExerciseId ??
      null;
  }
  return null;
}

function saveStatePriority(state: ActiveWorkoutSaveState) {
  const priorities: Record<ActiveWorkoutSaveState, number> = {
    failed: 5,
    retrying: 4,
    saving: 3,
    retained_locally: 2,
    acknowledged: 1,
  };
  return priorities[state];
}

function projectSaveState(
  exercises: SessionExerciseData[],
  currentOccurrenceId: string | null,
) {
  const candidates = exercises.flatMap((exercise) =>
    exercise.sets.flatMap((set) => {
      const state: ActiveWorkoutSaveState | null =
        set.saveState === "failed"
          ? "failed"
          : set.saveState === "retrying"
            ? "retrying"
            : set.saveState === "saving"
              ? "saving"
              : set.saveState === "pending"
                ? "retained_locally"
                : set.saveState === "saved"
                  ? "acknowledged"
                  : null;
      return state == null
        ? []
        : [{
            state,
            occurrenceId: set.occurrenceId ?? null,
            sessionExerciseId: exercise.id,
          }];
    }),
  );
  return candidates.sort((left, right) => {
    const leftCurrent = left.occurrenceId === currentOccurrenceId ? 1 : 0;
    const rightCurrent = right.occurrenceId === currentOccurrenceId ? 1 : 0;
    return rightCurrent - leftCurrent ||
      saveStatePriority(right.state) - saveStatePriority(left.state);
  })[0] ?? null;
}

function cueNeedsAttention(cue: EquipmentPreparationCue) {
  return cue.status === "pending_confirmation" ||
    cue.status === "choice_required" ||
    cue.status === "unavailable" ||
    cue.status === "updating" ||
    (cue.status === "broad_only" && !cue.preciseClaimAllowed);
}

function equipmentCueChanged(
  current: EquipmentPreparationCue,
  upcoming: EquipmentPreparationCue,
) {
  if (current.status !== "selected" || upcoming.status !== "selected") {
    return false;
  }
  return current.equipmentLabel !== upcoming.equipmentLabel ||
    current.attachmentLabel !== upcoming.attachmentLabel;
}

function queueOrder(
  exercise: SessionExerciseData,
  occurrences: SessionOccurrenceData[],
) {
  return occurrences
    .filter(
      (occurrence) =>
        occurrence.sessionExerciseId === exercise.id &&
        occurrence.kind === "working_set",
    )
    .reduce(
      (earliest, occurrence) => Math.min(earliest, occurrence.sequenceIdx),
      Number.POSITIVE_INFINITY,
    );
}

export function projectActiveWorkoutViewModel(
  input: ActiveWorkoutViewModelInput,
): ActiveWorkoutViewModel {
  const current = input.guidance.currentAction;
  const currentOccurrenceId = actionOccurrenceId(current);
  const currentSessionExerciseId = actionSessionExerciseId(current);
  const currentExercise = currentSessionExerciseId == null
    ? null
    : input.exercises.find(
        (exercise) => exercise.id === currentSessionExerciseId,
      ) ?? null;
  const currentOccurrence = currentOccurrenceId == null
    ? null
    : input.occurrences.find(
        (occurrence) => occurrence.id === currentOccurrenceId,
      ) ?? null;
  const nextSessionExerciseId = actionSessionExerciseId(
    input.guidance.nextAction,
  );
  const groupByExerciseId = new Map(
    input.guidance.groups.flatMap((group) =>
      group.members.map((member) => [
        member.sessionExerciseId,
        { id: group.groupId, name: group.name },
      ] as const),
    ),
  );
  const progressByExerciseId = new Map(
    input.guidance.exercises.map((progress) => [
      progress.sessionExerciseId,
      progress,
    ]),
  );
  const queue = [...input.exercises]
    .sort((left, right) => {
      const leftOrder = queueOrder(left, input.occurrences);
      const rightOrder = queueOrder(right, input.occurrences);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.orderIdx - right.orderIdx;
    })
    .map((exercise, index): ActiveWorkoutQueueItem => {
      const progress = progressByExerciseId.get(exercise.id);
      const warmups = input.occurrences.filter(
        (occurrence) =>
          occurrence.sessionExerciseId === exercise.id &&
          occurrence.kind === "exercise_warmup",
      );
      return {
        sessionExerciseId: exercise.id,
        exerciseName: exercise.name,
        order: index + 1,
        status: progress?.status ?? "not_started",
        planned: progress?.planned ?? 0,
        total: progress?.total ?? 0,
        extra: progress?.extra ?? 0,
        workoutOnly: progress?.workoutOnly ?? 0,
        performed: progress?.performed ?? 0,
        plannedPerformed: progress?.plannedPerformed ?? 0,
        extraPerformed: progress?.extraPerformed ?? 0,
        workoutOnlyPerformed: progress?.workoutOnlyPerformed ?? 0,
        pending: progress?.pending ?? 0,
        skipped: progress?.skipped ?? 0,
        abandoned: progress?.abandoned ?? 0,
        legacyUnknown: progress?.legacyUnknown ?? 0,
        completedWithoutResult: progress?.completedWithoutResult ?? 0,
        warmups: {
          total: warmups.length,
          pending: warmups.filter(
            (occurrence) => occurrence.outcome === "pending",
          ).length,
          completed: warmups.filter(
            (occurrence) => occurrence.outcome === "completed",
          ).length,
          skipped: warmups.filter(
            (occurrence) => occurrence.outcome === "skipped",
          ).length,
        },
        modification: exercise.modificationType,
        plannedExerciseName: exercise.plannedExerciseName,
        group: groupByExerciseId.get(exercise.id) ?? null,
        isCurrent:
          current?.kind !== "rest" && exercise.id === currentSessionExerciseId,
        isNext: exercise.id === nextSessionExerciseId,
      };
    });
  const failedSets = input.exercises.flatMap((exercise) =>
    exercise.sets
      .filter((set) => set.saveState === "failed")
      .map((set) => ({ exerciseId: exercise.id, set })),
  );
  const recovery: ActiveWorkoutRecoveryItem[] = [];
  if (failedSets.length > 0) {
    recovery.push({
      kind: "failed_set",
      count: failedSets.length,
      sessionExerciseId: failedSets[0]?.exerciseId ?? null,
      label: failedSets.length === 1
        ? "One set save needs attention"
        : `${failedSets.length} set saves need attention`,
    });
  }
  if (input.unreadableRecordedWork) {
    recovery.push({
      kind: "unreadable_recorded_work",
      count: 1,
      sessionExerciseId: null,
      label: "Recorded work on this device needs review",
    });
  }
  if (input.occurrenceQueueError) {
    recovery.push({
      kind: "occurrence_queue_error",
      count: 1,
      sessionExerciseId: null,
      label: "A workout action needs recovery",
    });
  }
  if (input.unresolvedExerciseSkip) {
    recovery.push({
      kind: "unresolved_exercise_skip",
      count: 1,
      sessionExerciseId: currentSessionExerciseId,
      label: "Resolve the exercise skip before continuing",
    });
  }

  const previousComparable = previousComparableProjection(
    current,
    currentExercise,
    input,
  );
  const rest = current?.kind === "rest"
    ? {
        phase: current.phase,
        remainingSeconds: input.restRemainingSeconds ?? null,
        totalSeconds: current.totalSec,
        destinationLabel: current.destination
          ? formatSessionGuidanceAction(current.destination)
          : null,
      }
    : null;
  const equipmentAttention = [
    {
      placement: "current" as const,
      sessionExerciseId: currentSessionExerciseId,
      cue: input.guidance.currentEquipment,
    },
    {
      placement: "upcoming" as const,
      sessionExerciseId: nextSessionExerciseId,
      cue: input.guidance.upcomingEquipment,
    },
  ].filter(({ placement, sessionExerciseId, cue }, index, entries) =>
    (
      cueNeedsAttention(cue) ||
      (placement === "upcoming" && equipmentCueChanged(
        input.guidance.currentEquipment,
        cue,
      ))
    ) &&
    entries.findIndex(
      (candidate) =>
        candidate.sessionExerciseId === sessionExerciseId &&
        candidate.cue.exerciseName === cue.exerciseName &&
        candidate.cue.status === cue.status &&
        candidate.cue.equipmentLabel === cue.equipmentLabel &&
        candidate.cue.attachmentLabel === cue.attachmentLabel &&
        candidate.cue.message === cue.message,
    ) === index,
  );
  const finishBlocked = input.finishBlocked === true;

  return {
    displayMode: rest
      ? "rest"
      : current == null
        ? "finish"
        : "action",
    currentAction: current == null
      ? null
      : {
          action: current,
          label: formatSessionGuidanceAction(current),
          occurrenceId: currentOccurrenceId,
          sessionExerciseId: currentSessionExerciseId,
          exerciseName:
            current?.kind === "working_set"
              ? current.actualExerciseName
              : currentExercise?.name ?? null,
          setLabel:
            current?.kind === "working_set"
              ? current.position.label
              : null,
          target: current?.kind === "working_set" ? current.planned : null,
          inputDefaults: inputDefaults(
            current,
            currentExercise,
            currentOccurrence,
            input,
          ),
          blockingReason: currentActionBlockingReason(
            current,
            input.exercises,
            input,
          ),
        },
    previousComparable,
    progress: input.guidance.totals,
    rest,
    queue,
    saveState: projectSaveState(
      input.exercises,
      currentOccurrenceId,
    ),
    equipmentAttention,
    recovery,
    completion: {
      ready:
        input.guidance.completion.state === "ready_to_finish" &&
        !finishBlocked,
      blocked: finishBlocked,
      blocker: finishBlocked
        ? input.completionBlocker ?? "Recorded work needs review"
        : null,
      pendingActions: input.guidance.completion.pendingActions,
      evidenceLimited: input.guidance.completion.evidenceLimited,
    },
  };
}
