import type {
  LoggedSet,
  SessionExerciseData,
  SessionOccurrenceData,
} from "@/components/session/types";
import {
  type ActiveSetRowProjectionInput,
  type ActiveSetRowState,
  type ActiveSetVersionState,
} from "@/lib/active-set-row-projection";
import {
  type ActiveWorkoutEquipmentState,
  type ActiveWorkoutRestState,
  type ActiveWorkoutSessionState,
  type ActiveWorkoutSessionStateEvidence,
  type EquipmentLimitationEvidence,
} from "@/lib/active-workout-presentation-state";
import type { EquipmentPreparationCue } from "@/lib/session-guidance";
import {
  ADDED_WORKOUT_SET_NOTE,
  type WorkingSetSemanticRole,
} from "@/lib/session-occurrences";
import type { DurableRestTimer, RestTimerPhase } from "@/lib/rest-timer";
import type { WorkoutSetOutboxEntry } from "@/lib/workout-set-outbox";

type WeightRepsOutboxEntry = Extract<
  WorkoutSetOutboxEntry,
  { metricType: "weight_reps" }
>;

const EXERCISE_ID = "40000000-0000-4000-8000-000000000001";
const MOVEMENT_ID = "50000000-0000-4000-8000-000000000001";
const OCCURRENCE_ID = "60000000-0000-4000-8000-000000000001";
const SET_ID = "70000000-0000-4000-8000-000000000001";
const CLIENT_KEY = "80000000-0000-4000-8000-000000000001";

export const NORTH_STAR_NOW_MS = 1_800_000_000_000;

function exercise(sets: LoggedSet[] = []): SessionExerciseData {
  return {
    id: EXERCISE_ID,
    exerciseId: MOVEMENT_ID,
    name: "Barbell Back Squat",
    family: "squat",
    loadType: "barbell",
    loadSemantics: "total",
    metricType: "weight_reps",
    movementPattern: "squat",
    orderIdx: 0,
    supersetKey: null,
    restSec: 120,
    modificationType: "as_planned",
    skipReason: null,
    substitutedForExerciseId: null,
    substitutionReason: null,
    substitutedAt: null,
    plannedExerciseName: null,
    targetSets: 3,
    targetRepsMin: 8,
    targetRepsMax: 8,
    targetLoad: 95,
    targetLoadUnit: "lb",
    notes: null,
    warmupNotes: null,
    warmupSets: [],
    setNotes: [],
    cautionBodyParts: [],
    media: null,
    sets,
    last: null,
  };
}

function occurrence(
  overrides: Partial<SessionOccurrenceData> = {},
): SessionOccurrenceData {
  return {
    id: OCCURRENCE_ID,
    sessionExerciseId: EXERCISE_ID,
    kind: "working_set",
    origin: "planned",
    sequenceIdx: 10,
    kindOrdinal: 0,
    label: null,
    plannedExerciseId: MOVEMENT_ID,
    plannedNote: null,
    plannedRepsMin: 8,
    plannedRepsMax: 8,
    plannedLoad: 95,
    plannedLoadUnit: "lb",
    plannedLoadPercent: null,
    plannedLoadText: null,
    plannedRestSec: 120,
    groupSnapshotId: null,
    groupRound: null,
    groupMemberOrderIdx: null,
    outcome: "pending",
    outcomeReason: null,
    outcomeNote: null,
    revision: 0,
    resolvedAt: null,
    completedSetId: null,
    ...overrides,
  };
}

function savedSet(overrides: Partial<LoggedSet> = {}): LoggedSet {
  return {
    id: SET_ID,
    clientKey: CLIENT_KEY,
    occurrenceId: OCCURRENCE_ID,
    setNo: 1,
    weight: 95,
    weightUnit: "lb",
    reps: 8,
    metricType: "weight_reps",
    distanceKm: null,
    durationSeconds: null,
    rpe: 8,
    rir: 2,
    techniqueIssue: null,
    limitationCause: null,
    pain: null,
    note: "Exact performed result",
    correctionCount: 0,
    saveState: "saved",
    lastError: null,
    ...overrides,
  };
}

function outboxEntry(
  overrides: Partial<WeightRepsOutboxEntry> = {},
): WeightRepsOutboxEntry {
  return {
    clientKey: CLIENT_KEY,
    ownerId: "10000000-0000-4000-8000-000000000001",
    sessionId: "20000000-0000-4000-8000-000000000001",
    sessionExerciseId: EXERCISE_ID,
    occurrenceId: OCCURRENCE_ID,
    expectedOccurrenceRevision: 0,
    performedExerciseId: MOVEMENT_ID,
    performedSemanticsVersion: 1,
    performedLoadType: "barbell",
    performedLoadSemantics: "total",
    workoutName: "North Star fixture",
    exerciseName: "Barbell Back Squat",
    setNo: 1,
    metricType: "weight_reps",
    weight: 95,
    weightUnit: "lb",
    reps: 8,
    distanceKm: null,
    durationSeconds: null,
    rpe: 8,
    rir: 2,
    techniqueIssue: null,
    limitationCause: null,
    pain: null,
    note: "Exact device result",
    equipmentSnapshotId: null,
    equipmentSelectionClientKey: null,
    restAfterSec: 120,
    loadEntryMeaning: "total_system",
    observedCompletedAtISO: "2027-01-15T12:00:00.000Z",
    createdAtISO: "2027-01-15T12:00:00.000Z",
    status: "queued",
    attemptCount: 0,
    nextAttemptAtISO: null,
    lastAttemptAtISO: null,
    lastError: null,
    orderBlocker: null,
    reviewRequired: null,
    ...overrides,
  };
}

function setRowFixture(input: {
  occurrence?: Partial<SessionOccurrenceData>;
  set?: LoggedSet | null;
  outbox?: WorkoutSetOutboxEntry | null;
  runtimeState?: "saving" | "retrying";
  current?: boolean;
  currentBlockingReason?: string | null;
  versionEvidence?: ActiveSetRowProjectionInput["versionEvidenceBySetId"];
}) {
  const rowOccurrence = occurrence(input.occurrence);
  const projectionInput: ActiveSetRowProjectionInput = {
    exercise: exercise(input.set == null ? [] : [input.set]),
    occurrences: [rowOccurrence],
    outboxEntries: input.outbox == null ? [] : [input.outbox],
    runtimeSaveStates:
      input.outbox != null && input.runtimeState != null
        ? { [input.outbox.clientKey]: input.runtimeState }
        : {},
    currentOccurrenceId: input.current ? rowOccurrence.id : null,
    currentBlockingReason: input.currentBlockingReason ?? null,
    versionEvidenceBySetId: input.versionEvidence,
  };
  return projectionInput;
}

type SetRowFixture = {
  input: ActiveSetRowProjectionInput;
  expectedState: ActiveSetRowState;
};

const CORRECTED_SAVED_SET_INPUT = setRowFixture({
  occurrence: {
    outcome: "completed",
    completedSetId: SET_ID,
    revision: 2,
  },
  set: savedSet({ correctionCount: 1 }),
});

export const SET_ROW_STATE_FIXTURES = {
  planned: {
    input: setRowFixture({}),
    expectedState: "planned",
  },
  current_editable: {
    input: setRowFixture({ current: true }),
    expectedState: "current_editable",
  },
  retained_locally: {
    input: setRowFixture({ outbox: outboxEntry() }),
    expectedState: "retained_locally",
  },
  saving: {
    input: setRowFixture({
      outbox: outboxEntry(),
      runtimeState: "saving",
    }),
    expectedState: "saving",
  },
  retrying: {
    input: setRowFixture({
      outbox: outboxEntry({ attemptCount: 1 }),
      runtimeState: "retrying",
    }),
    expectedState: "retrying",
  },
  failed: {
    input: setRowFixture({
      outbox: outboxEntry({
        status: "needs_attention",
        attemptCount: 6,
        lastError: "The exact retained result needs attention.",
      }),
    }),
    expectedState: "failed",
  },
  saved: {
    input: setRowFixture({
      occurrence: {
        outcome: "completed",
        completedSetId: SET_ID,
        revision: 1,
      },
      set: savedSet(),
    }),
    expectedState: "saved",
  },
  skipped: {
    input: setRowFixture({
      occurrence: {
        outcome: "skipped",
        outcomeReason: "time",
        outcomeNote: "Skipped due to time",
        revision: 1,
      },
    }),
    expectedState: "skipped",
  },
  abandoned: {
    input: setRowFixture({
      occurrence: {
        outcome: "abandoned",
        outcomeReason: "technical_failure",
        outcomeNote: "Outcome could not be confirmed",
        revision: 1,
      },
    }),
    expectedState: "abandoned",
  },
  completed_without_result: {
    input: setRowFixture({
      occurrence: { outcome: "completed", revision: 1 },
    }),
    expectedState: "completed_without_result",
  },
  unknown_legacy: {
    input: setRowFixture({
      occurrence: { origin: "legacy", outcome: "legacy_unrecorded" },
      set: savedSet({ metricType: undefined, weightUnit: null }),
    }),
    expectedState: "unknown_legacy",
  },
} satisfies Record<ActiveSetRowState, SetRowFixture>;

export const SET_ROW_CROSS_AXIS_FIXTURES = {
  failedExtra: {
    input: setRowFixture({
      occurrence: {
        origin: "ad_hoc",
        plannedNote: ADDED_WORKOUT_SET_NOTE,
      },
      outbox: outboxEntry({
        status: "needs_attention",
        lastError: "Retry required",
      }),
    }),
    expectedState: "failed",
    expectedMembership: "extra",
  },
  correctedExtra: {
    input: setRowFixture({
      occurrence: {
        origin: "ad_hoc",
        plannedNote: ADDED_WORKOUT_SET_NOTE,
        outcome: "completed",
        completedSetId: SET_ID,
      },
      set: savedSet({ correctionCount: 2 }),
    }),
    expectedState: "saved",
    expectedMembership: "extra",
  },
  restoredExtra: {
    input: setRowFixture({
      occurrence: {
        origin: "ad_hoc",
        plannedNote: ADDED_WORKOUT_SET_NOTE,
        outcome: "completed",
        completedSetId: SET_ID,
      },
      set: savedSet(),
      versionEvidence: {
        [SET_ID]: { state: "version_restored", count: 1 },
      },
    }),
    expectedState: "saved",
    expectedMembership: "extra",
  },
  failedCorrected: {
    input: setRowFixture({
      occurrence: {
        outcome: "completed",
        completedSetId: SET_ID,
        revision: 2,
      },
      set: savedSet({
        correctionCount: 1,
        saveState: "failed",
        lastError: "The correction remains retained on this device.",
      }),
    }),
    expectedState: "failed",
    expectedMembership: "planned",
  },
  legacyPerformedUnknown: {
    input: setRowFixture({
      occurrence: {
        origin: "legacy",
        outcome: "legacy_unrecorded",
        completedSetId: SET_ID,
      },
      set: savedSet({ metricType: undefined, weightUnit: null }),
    }),
    expectedState: "unknown_legacy",
    expectedMembership: "legacy",
  },
} as const;

type MembershipFixture = SetRowFixture & {
  expectedMembership: WorkingSetSemanticRole;
};

export const SET_ROW_MEMBERSHIP_FIXTURES = {
  planned: {
    input: setRowFixture({}),
    expectedState: "planned",
    expectedMembership: "planned",
  },
  extra: {
    input: setRowFixture({
      occurrence: { origin: "ad_hoc", plannedNote: ADDED_WORKOUT_SET_NOTE },
    }),
    expectedState: "planned",
    expectedMembership: "extra",
  },
  workout_only: {
    input: setRowFixture({ occurrence: { origin: "ad_hoc" } }),
    expectedState: "planned",
    expectedMembership: "workout_only",
  },
  imported: {
    input: setRowFixture({ occurrence: { origin: "imported" } }),
    expectedState: "planned",
    expectedMembership: "imported",
  },
  legacy: {
    input: SET_ROW_STATE_FIXTURES.unknown_legacy.input,
    expectedState: "unknown_legacy",
    expectedMembership: "legacy",
  },
} satisfies Record<WorkingSetSemanticRole, MembershipFixture>;

type VersionFixture = SetRowFixture & {
  expectedVersionState: ActiveSetVersionState;
};

export const SET_ROW_VERSION_FIXTURES = {
  original: {
    input: SET_ROW_STATE_FIXTURES.saved.input,
    expectedState: "saved",
    expectedVersionState: "original",
  },
  corrected: {
    input: CORRECTED_SAVED_SET_INPUT,
    expectedState: "saved",
    expectedVersionState: "corrected",
  },
  version_restored: {
    input: SET_ROW_CROSS_AXIS_FIXTURES.restoredExtra.input,
    expectedState: "saved",
    expectedVersionState: "version_restored",
  },
  snapshot_restored: {
    input: setRowFixture({
      occurrence: {
        outcome: "completed",
        completedSetId: SET_ID,
        revision: 2,
      },
      set: savedSet(),
      versionEvidence: {
        [SET_ID]: { state: "snapshot_restored", count: 1 },
      },
    }),
    expectedState: "saved",
    expectedVersionState: "snapshot_restored",
  },
} satisfies Record<ActiveSetVersionState, VersionFixture>;

function restTimer(
  phase: DurableRestTimer["phase"],
  overrides: Partial<DurableRestTimer> = {},
): DurableRestTimer {
  return {
    version: 1,
    generationId: "90000000-0000-4000-8000-000000000001",
    revision: 1,
    ownerId: "10000000-0000-4000-8000-000000000001",
    sessionId: "20000000-0000-4000-8000-000000000001",
    startedAt: NORTH_STAR_NOW_MS - 30_000,
    sourceSessionExerciseId: EXERCISE_ID,
    sourceOccurrenceId: OCCURRENCE_ID,
    sourceClientKey: CLIENT_KEY,
    sourceCompletedSetId: null,
    phase,
    endsAt: NORTH_STAR_NOW_MS + 30_000,
    totalSec: 60,
    readyAt: phase === "running" ? null : NORTH_STAR_NOW_MS - 1_000,
    completionContext: phase === "ready" ? "foreground" : null,
    completionCueOutcome:
      phase === "ready"
        ? {
            sound: "requested",
            vibration: "requested",
            completion: "requested",
          }
        : null,
    attemptedMilestones: phase === "ready" ? ["complete"] : [],
    ...overrides,
  };
}

type RestFixture = {
  input: {
    timer: DurableRestTimer | null;
    nowMs: number;
    destinationLabel: string | null;
    cueAvailability?: "available" | "blocked" | "unavailable";
    recoveryMessage?: string | null;
  };
  expectedState: ActiveWorkoutRestState;
};

export const REST_STATE_FIXTURES = {
  inactive: {
    input: {
      timer: null,
      nowMs: NORTH_STAR_NOW_MS,
      destinationLabel: "Set 2",
    },
    expectedState: "inactive",
  },
  running: {
    input: {
      timer: restTimer("running"),
      nowMs: NORTH_STAR_NOW_MS,
      destinationLabel: "Set 2",
      cueAvailability: "available",
    },
    expectedState: "running",
  },
  ended_by_athlete: {
    input: {
      timer: restTimer("skipped"),
      nowMs: NORTH_STAR_NOW_MS,
      destinationLabel: "Set 2",
    },
    expectedState: "ended_by_athlete",
  },
  time_elapsed: {
    input: {
      timer: restTimer("ready"),
      nowMs: NORTH_STAR_NOW_MS,
      destinationLabel: "Set 2",
    },
    expectedState: "time_elapsed",
  },
  cue_unavailable: {
    input: {
      timer: restTimer("running"),
      nowMs: NORTH_STAR_NOW_MS,
      destinationLabel: "Set 2",
      cueAvailability: "blocked",
    },
    expectedState: "cue_unavailable",
  },
  recovery_required: {
    input: {
      timer: restTimer("running"),
      nowMs: NORTH_STAR_NOW_MS,
      destinationLabel: "Set 2",
      recoveryMessage: "The retained timer could not be read safely.",
    },
    expectedState: "recovery_required",
  },
} satisfies Record<ActiveWorkoutRestState, RestFixture>;

export const REST_TIMER_PHASE_FIXTURES = {
  running: REST_STATE_FIXTURES.running,
  ready: REST_STATE_FIXTURES.time_elapsed,
  skipped: REST_STATE_FIXTURES.ended_by_athlete,
  continued: {
    input: {
      timer: restTimer("continued"),
      nowMs: NORTH_STAR_NOW_MS,
      destinationLabel: "Set 2",
    },
    expectedState: "inactive",
  },
} satisfies Record<RestTimerPhase, RestFixture>;

function cue(
  status: EquipmentPreparationCue["status"],
): EquipmentPreparationCue {
  return {
    status,
    exerciseName: "Dumbbell Bench Press",
    equipmentLabel: status === "selected" ? "Pair A" : null,
    attachmentLabel: null,
    guidance: null,
    message: `Structured fixture: ${status}`,
    preciseClaimAllowed: status === "selected",
  };
}

type EquipmentFixture = {
  input: {
    cue: EquipmentPreparationCue;
    limitation?: EquipmentLimitationEvidence | null;
    selectionRuntime?: "idle" | "pending" | "failed";
  };
  expectedState: ActiveWorkoutEquipmentState;
  expectedBlocksLogging: boolean;
};

export const EQUIPMENT_STATE_FIXTURES = {
  ready_confirmed: {
    input: { cue: cue("selected") },
    expectedState: "ready_confirmed",
    expectedBlocksLogging: false,
  },
  compatible_unselected: {
    input: { cue: cue("choice_required") },
    expectedState: "compatible_unselected",
    expectedBlocksLogging: true,
  },
  configuration_incomplete: {
    input: {
      cue: cue("unavailable"),
      limitation: "configuration_incomplete",
    },
    expectedState: "configuration_incomplete",
    expectedBlocksLogging: true,
  },
  unavailable: {
    input: { cue: cue("unavailable"), limitation: "unavailable" },
    expectedState: "unavailable",
    expectedBlocksLogging: true,
  },
  incompatible: {
    input: { cue: cue("unavailable"), limitation: "incompatible" },
    expectedState: "incompatible",
    expectedBlocksLogging: true,
  },
  unknown_legacy: {
    input: { cue: cue("broad_only"), limitation: "unknown_legacy" },
    expectedState: "unknown_legacy",
    expectedBlocksLogging: false,
  },
  selection_pending: {
    input: { cue: cue("pending_confirmation") },
    expectedState: "selection_pending",
    expectedBlocksLogging: true,
  },
  selection_failed: {
    input: { cue: cue("choice_required"), selectionRuntime: "failed" },
    expectedState: "selection_failed",
    expectedBlocksLogging: true,
  },
} satisfies Record<ActiveWorkoutEquipmentState, EquipmentFixture>;

export const EQUIPMENT_CUE_STATUS_FIXTURES = {
  none: {
    input: { cue: cue("none") },
    expectedState: "ready_confirmed",
    expectedBlocksLogging: false,
  },
  selected: EQUIPMENT_STATE_FIXTURES.ready_confirmed,
  pending_confirmation: EQUIPMENT_STATE_FIXTURES.selection_pending,
  choice_required: EQUIPMENT_STATE_FIXTURES.compatible_unselected,
  unavailable: {
    input: { cue: cue("unavailable") },
    expectedState: "unknown_legacy",
    expectedBlocksLogging: false,
  },
  broad_only: EQUIPMENT_STATE_FIXTURES.unknown_legacy,
  updating: {
    input: { cue: cue("updating") },
    expectedState: "selection_pending",
    expectedBlocksLogging: true,
  },
} satisfies Record<EquipmentPreparationCue["status"], EquipmentFixture>;

const BASE_SESSION_EVIDENCE: ActiveWorkoutSessionStateEvidence = {
  completed: false,
  completionPending: false,
  earlyFinishReview: false,
  readyToFinish: false,
  failureRecovery: false,
  offlineRetention: false,
  correctionOpen: false,
  skipReplaceDecision: false,
  equipmentDecision: false,
  restState: "inactive",
  setSavePending: false,
  supersetTransition: false,
  structuredWarmup: false,
  preparation: false,
};

function sessionEvidence(
  overrides: Partial<ActiveWorkoutSessionStateEvidence> = {},
): ActiveWorkoutSessionStateEvidence {
  return { ...BASE_SESSION_EVIDENCE, ...overrides };
}

export const SESSION_STATE_FIXTURES = {
  preparation: sessionEvidence({ preparation: true }),
  structured_warmup: sessionEvidence({ structuredWarmup: true }),
  set_entry: sessionEvidence(),
  set_save_pending: sessionEvidence({ setSavePending: true }),
  rest_running: sessionEvidence({ restState: "running" }),
  rest_complete: sessionEvidence({ restState: "time_elapsed" }),
  equipment_decision: sessionEvidence({ equipmentDecision: true }),
  skip_replace_decision: sessionEvidence({ skipReplaceDecision: true }),
  correction: sessionEvidence({ correctionOpen: true }),
  offline_retention: sessionEvidence({ offlineRetention: true }),
  failure_recovery: sessionEvidence({ failureRecovery: true }),
  superset_transition: sessionEvidence({ supersetTransition: true }),
  early_finish_review: sessionEvidence({ earlyFinishReview: true }),
  ready_to_finish: sessionEvidence({ readyToFinish: true }),
  completion_pending: sessionEvidence({ completionPending: true }),
  completed_handoff: sessionEvidence({ completed: true }),
} satisfies Record<
  ActiveWorkoutSessionState,
  ActiveWorkoutSessionStateEvidence
>;
