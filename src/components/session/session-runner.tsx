"use client";

import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import {
  appendWorkoutSet,
  completeSession,
} from "@/app/actions/sessions";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, MessageSquareText } from "lucide-react";
import {
  ExerciseCard,
  type ExerciseAdjustmentIntent,
} from "./exercise-card";
import { ActiveWorkoutDiscard } from "./active-workout-actions";
import { LiveCoachDrawer } from "./live-coach-drawer";
import { WorkoutStatusBar } from "./workout-status-bar";
import {
  ActiveWorkoutTimingReview,
  type ActiveDurationChoice,
} from "./active-workout-timing-review";
import { WorkoutGuidanceSummary } from "./workout-guidance-summary";
import { WorkoutGroupContext } from "./workout-group-context";
import {
  formatOccurrencePrescription,
  OccurrenceMutationDialog,
} from "./occurrence-mutation-dialog";
import { OccurrenceSaveStatus } from "./occurrence-save-status";
import { WorkoutMeasurementsDrawer } from "./workout-measurements-drawer";
import { EquipmentSetupPanel } from "./equipment-setup-panel";
import { SessionPreparationPanel } from "./session-preparation-panel";
import { ContextualNoteScope } from "@/components/contextual-notes/contextual-note-scope";
import { AddWorkoutExercise } from "./add-workout-exercise";
import { openContextualNoteComposer, type ContextualNoteScopeValue } from "@/lib/contextual-note-ui";
import { createClientUuid } from "@/lib/client-uuid";
import {
  buildPerformedSetMeasurement,
  resolveFutureSetWriterMetricType,
  type PerformedLoadSemantics,
} from "@/lib/set-metric-semantics";
import type {
  LoggedSet,
  SessionRunnerProps,
  SessionExerciseData,
  SessionOccurrenceData,
  SetAcknowledgementReceipt,
} from "./types";
import { toast } from "sonner";
import {
  enqueueWorkoutSet,
  getWorkoutSetOutboxServerSnapshot,
  getWorkoutSetOutboxSnapshot,
  publishWorkoutSetOutboxEvent,
  removeWorkoutSet,
  retryWorkoutSet,
  subscribeToWorkoutSetOutbox,
  subscribeToWorkoutSetOutboxStatus,
  WORKOUT_SET_OUTBOX_CHANGE_EVENT,
  type WorkoutSetOutboxClientEvent,
  type WorkoutSetLoadEntryMeaning,
} from "@/lib/workout-set-outbox";
import {
  getEquipmentSelectionOutboxServerSnapshot,
  getEquipmentSelectionOutboxSnapshot,
  equipmentSelectionComparisonState,
  subscribeToEquipmentSelectionOutbox,
  subscribeToEquipmentSelectionOutboxStatus,
  type EquipmentSelectionOutboxEvent,
} from "@/lib/equipment-selection-outbox";
import {
  enqueueOccurrenceMutation,
  getOccurrenceMutationOutboxServerSnapshot,
  getOccurrenceMutationOutboxSnapshot,
  publishOccurrenceMutationOutboxEvent,
  removeOccurrenceMutation,
  retryOccurrenceMutation,
  subscribeToOccurrenceMutationOutbox,
  subscribeToOccurrenceMutationOutboxStatus,
  type OccurrenceMutationOutboxClientEvent,
  type OccurrenceMutationOperation,
} from "@/lib/occurrence-mutation-outbox";
import {
  equipmentSyncPending,
  finishBlockedByRecordedWork,
  mergeSessionOutboxSets,
  mergeEquipmentSelectionOccurrenceStates,
  nextIncompleteExerciseId,
  previousComparableIsTemporarilyUnavailable,
  resolveSetLoggingEquipment,
  shouldShowMissingWarmupMessage,
  workoutSaveQueueMessage,
  type WorkoutExitQueues,
} from "@/lib/session-runner";
import {
  adjustStoredRestTimer,
  claimRestCueMilestones,
  clearRestTimerForIdentity,
  completeForegroundRestTimer,
  continueAfterRest,
  remainingRestSeconds,
  resolveRestTimerSourceOccurrence,
  restoreAndPersistRestTimer,
  skipRestTimer,
  subscribeToRestTimer,
  writeRestTimerCas,
  type DurableRestTimer,
  type RestCueMilestone,
} from "@/lib/rest-timer";
import {
  planRestCueTransition,
  readRestAlertPreference,
  REST_COMPLETION_TONE_PATTERN,
  requestedRestCueChannels,
  restCueOutcome,
  type RestAlertPreference,
} from "@/lib/rest-alert-preference";
import {
  formatSessionGuidanceAction,
  projectSessionGuidance,
  sessionNonPerformedOutcomeParts,
  sessionEquipmentSetupMatchesExercise,
  type SessionGuidanceFocusAction,
} from "@/lib/session-guidance";
import { workingSetDisplayPosition } from "@/lib/session-occurrences";
import {
  patchActiveWorkoutMeasurement,
  readActiveWorkoutMeasurements,
} from "@/lib/active-workout-measurements";
import {
  classifyActiveSessionTiming,
  validateOwnerReportedActiveMinutes,
  type ActiveSessionTiming,
} from "@/lib/active-session-timing";
import { createUpdatingSessionEquipmentProjection } from "@/lib/session-equipment-requirements";

function useActiveTiming(
  startedAtISO: string,
  initialWallClockSeconds: number,
): ActiveSessionTiming {
  const startedAtMs = new Date(startedAtISO).getTime();
  const [timing, setTiming] = useState(() =>
    classifyActiveSessionTiming(
      new Date(startedAtMs),
      new Date(startedAtMs + initialWallClockSeconds * 1_000),
    ),
  );
  useEffect(() => {
    const compute = () =>
      setTiming(
        classifyActiveSessionTiming(new Date(startedAtISO), new Date()),
      );
    compute();
    const t = setInterval(compute, 30_000);
    return () => clearInterval(t);
  }, [startedAtISO]);
  return timing;
}

function WarmupPanel({
  completed,
  skipped,
  planned,
  remaining,
  children,
}: {
  completed: number;
  skipped: number;
  planned: number;
  remaining: number;
  children: ReactNode;
}) {
  const resolved = planned > 0 && remaining === 0;
  if (resolved) {
    return (
      <details
        id="workout-warmup"
        tabIndex={-1}
        className="scroll-mt-4 rounded-xl border border-violet-300/60 bg-violet-50/60 dark:bg-violet-950/20"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          <span className="font-semibold">
            {skipped > 0 ? "Warm-up finished" : "Warm-up complete"}
          </span>
          <span className="text-xs text-muted-foreground">
            {completed} completed
            {skipped > 0 ? ` · ${skipped} skipped` : ""} · Show details
          </span>
        </summary>
        <div className="border-t px-4 pb-4">{children}</div>
      </details>
    );
  }

  return (
    <section
      id="workout-warmup"
      tabIndex={-1}
      aria-labelledby="workout-warmup-heading"
      className="scroll-mt-4 rounded-xl border border-violet-300/60 bg-violet-50/60 p-4 dark:bg-violet-950/20"
    >
      <h2 id="workout-warmup-heading" className="font-semibold">Warm-up</h2>
      {children}
    </section>
  );
}

function actionTargetId(action: SessionGuidanceFocusAction | null): string {
  if (!action) return "finish-workout";
  if (action.kind === "rest") return "workout-rest-status";
  if (action.kind !== "working_set" || !action.sessionExerciseId) {
    return `warmup-occurrence-${action.occurrenceId}`;
  }
  const prefix =
    action.position.kind === "extra" ? "added-set-entry" : "set-entry";
  return `${prefix}-${action.sessionExerciseId}-${action.occurrenceId}`;
}

function revealWorkoutTarget(
  target: HTMLElement,
  behavior: ScrollBehavior,
) {
  const visualViewport = window.visualViewport;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportBottom =
    viewportTop + (visualViewport?.height ?? window.innerHeight);
  const stickySummary = document.querySelector<HTMLElement>(
    '[data-testid="active-workout-sticky-summary"]',
  );
  const statusBar = document.querySelector<HTMLElement>(
    '[aria-label="Workout status"]',
  );
  const visibleTop = Math.max(
    viewportTop,
    stickySummary?.getBoundingClientRect().bottom ?? viewportTop,
  ) + 8;
  const visibleBottom = Math.min(
    viewportBottom,
    statusBar?.getBoundingClientRect().top ?? viewportBottom,
  ) - 12;
  const revealTarget =
    target.querySelector<HTMLElement>(
      '[data-testid="active-workout-primary"]',
    ) ?? target;
  const availableHeight = Math.max(0, visibleBottom - visibleTop);
  const primaryBounds = revealTarget.getBoundingClientRect();
  const focalTarget = primaryBounds.height > availableHeight
    ? revealTarget.querySelector<HTMLElement>(
        '[data-testid="active-log-set"]',
      ) ?? revealTarget
    : revealTarget;
  const bounds = focalTarget.getBoundingClientRect();
  let desiredTop = bounds.top;
  if (bounds.height <= availableHeight) {
    if (bounds.top < visibleTop) desiredTop = visibleTop;
    if (bounds.bottom > visibleBottom) {
      desiredTop = visibleBottom - bounds.height;
    }
  } else {
    desiredTop = visibleTop;
  }
  const top = bounds.top - desiredTop;
  if (Math.abs(top) > 1) {
    window.scrollBy({ left: 0, top, behavior });
  }
}

function actionIdentity(action: SessionGuidanceFocusAction | null) {
  if (!action) return null;
  return action.kind === "rest" ? action.actionId : action.occurrenceId;
}

function actionOccurrenceId(action: SessionGuidanceFocusAction | null) {
  if (!action) return null;
  return action.kind === "rest"
    ? action.source?.occurrenceId ?? action.actionId
    : action.occurrenceId;
}

function subscribeToClientHydration() {
  return () => undefined;
}

function getClientHydrationSnapshot() {
  return true;
}

function getServerHydrationSnapshot() {
  return false;
}

export function SessionRunner(props: SessionRunnerProps) {
  const router = useRouter();
  const timing = useActiveTiming(
    props.startedAtISO,
    props.initialWallClockSeconds ?? 0,
  );
  const elapsed = timing.wallClockLabel;
  const fatigueLabelId = useId();
  const [exercises, setExercises] = useState<SessionExerciseData[]>(
    props.exercises
  );
  const [historyRevision, setHistoryRevision] = useState(
    props.historyRevision,
  );
  const [occurrences, setOccurrences] = useState<SessionOccurrenceData[]>(
    props.occurrences,
  );
  const hasStructuredWarmup = occurrences.some(
    (occurrence) => occurrence.kind !== "working_set",
  );
  const [expandedId, setExpandedId] = useState<string | null>(() => {
    const firstOpen = props.exercises.find(
      (e) => e.modificationType !== "skipped"
    );
    return firstOpen?.id ?? null;
  });
  const [skipRecoveryExerciseId, setSkipRecoveryExerciseId] = useState<
    string | null
  >(null);
  const previousCurrentActionIdRef = useRef<string | null>(null);
  const previousCurrentActionKindRef = useRef<
    SessionGuidanceFocusAction["kind"] | null
  >(null);
  const lastConsumedWorkoutHashRef = useRef<string | null>(null);
  const staleWorkoutActionHashRef = useRef(false);
  const [timer, setTimer] = useState<DurableRestTimer | null>(null);
  const [restTimerHydrated, setRestTimerHydrated] = useState(false);
  const [restNow, setRestNow] = useState(() => Date.now());
  const previousRestRemainingRef = useRef<number | null>(null);
  const restWasVisibleRef = useRef(true);
  const [finishOpen, setFinishOpen] = useState(
    props.initialTimingReviewOpen ?? false,
  );
  const [finishNote, setFinishNote] = useState("");
  const [fatigue, setFatigue] = useState<number | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [durationChoice, setDurationChoice] =
    useState<ActiveDurationChoice | null>(() =>
      props.initialTimingReviewRequired
        ? null
        : "wall_clock_no_stale_signal",
    );
  const [ownerReportedMinutes, setOwnerReportedMinutes] = useState("");
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachExerciseId, setCoachExerciseId] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState<{
    exerciseId: string;
    intent: ExerciseAdjustmentIntent;
  } | null>(null);
  const [occurrenceAction, setOccurrenceAction] = useState<{
    occurrenceId: string;
    mode: "skip" | "note";
  } | null>(null);
  const [runtimeSaveStates, setRuntimeSaveStates] = useState<
    Record<string, "saving" | "retrying">
  >({});
  const pendingSetAcknowledgementAnchorRef = useRef<{
    clientKey: string;
    elementId: string;
    receiptElementId: string;
    viewportTop: number;
  } | null>(null);
  const pendingSetAcknowledgementFrameRef = useRef<number | null>(null);
  const [acknowledgedOccurrenceIds, setAcknowledgedOccurrenceIds] = useState<
    string[]
  >([]);
  const [latestSetAcknowledgement, setLatestSetAcknowledgement] =
    useState<SetAcknowledgementReceipt | null>(null);
  const [
    occurrenceRuntimeSaveStates,
    setOccurrenceRuntimeSaveStates,
  ] = useState<Record<string, "saving" | "retrying">>({});
  const occurrenceEnqueueInFlightRef = useRef<Set<string>>(new Set());
  const [equipmentLoadMeanings, setEquipmentLoadMeanings] = useState<Record<string, WorkoutSetLoadEntryMeaning>>(() =>
    Object.fromEntries(
      Object.entries(props.equipmentSetups).map(([exerciseId, setup]) => [
        exerciseId,
        setup.loadEntryMeaning ?? "legacy_unknown",
      ]),
    ) as Record<string, WorkoutSetLoadEntryMeaning>,
  );
  const [comparisonRefreshTargets, setComparisonRefreshTargets] = useState<
    Record<string, string>
  >({});
  const equipmentSnapshotIdsRef = useRef<Record<string, string | null>>(
    Object.fromEntries(
      Object.entries(props.equipmentSetups).map(([exerciseId, setup]) => [
        exerciseId,
        setup.currentSnapshotId,
      ]),
    ),
  );
  const equipmentSetupIdentity = Object.entries(props.equipmentSetups)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([exerciseId, setup]) =>
      `${exerciseId}:${setup.currentSnapshotId ?? "none"}:${setup.loadEntryMeaning ?? "none"}:${setup.loadEntryMeaningChoices.join(",")}`,
    )
    .join("|");
  useEffect(() => {
    setEquipmentLoadMeanings((current) => {
      const next: Record<string, WorkoutSetLoadEntryMeaning> = {};
      for (const [exerciseId, setup] of Object.entries(props.equipmentSetups)) {
        const fallback = setup.loadEntryMeaning ?? "legacy_unknown";
        const prior = current[exerciseId];
        const sameSnapshot =
          equipmentSnapshotIdsRef.current[exerciseId] === setup.currentSnapshotId;
        const stillValid = setup.loadEntryMeaningChoices.length > 0
          ? setup.loadEntryMeaningChoices.includes(
              prior as "per_stack" | "combined_stacks",
            )
          : prior === fallback;
        next[exerciseId] = sameSnapshot && stillValid ? prior : fallback;
      }
      return next;
    });
    equipmentSnapshotIdsRef.current = Object.fromEntries(
      Object.entries(props.equipmentSetups).map(([exerciseId, setup]) => [
        exerciseId,
        setup.currentSnapshotId,
      ]),
    );
    setComparisonRefreshTargets((current) => {
      const next = { ...current };
      let changed = false;
      for (const [exerciseId, expectedSnapshot] of Object.entries(current)) {
        const serverSnapshot =
          props.equipmentSetups[exerciseId]?.currentSnapshotId ?? "none";
        if (serverSnapshot === expectedSnapshot) {
          delete next[exerciseId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
    // The stable identity intentionally represents the setup fields consumed above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipmentSetupIdentity]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioCueBlockedRef = useRef(false);
  const outbox = useSyncExternalStore(
    subscribeToWorkoutSetOutbox,
    getWorkoutSetOutboxSnapshot,
    getWorkoutSetOutboxServerSnapshot
  );
  const sessionEntries = useMemo(
    () =>
      outbox.entries.filter(
        (entry) =>
          entry.ownerId === props.ownerId && entry.sessionId === props.sessionId
      ),
    [outbox.entries, props.ownerId, props.sessionId]
  );
  const equipmentSelectionOutbox = useSyncExternalStore(
    subscribeToEquipmentSelectionOutbox,
    getEquipmentSelectionOutboxSnapshot,
    getEquipmentSelectionOutboxServerSnapshot,
  );
  const equipmentOutboxHydrated = useSyncExternalStore(
    subscribeToClientHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot,
  );
  const occurrenceOutbox = useSyncExternalStore(
    subscribeToOccurrenceMutationOutbox,
    getOccurrenceMutationOutboxSnapshot,
    getOccurrenceMutationOutboxServerSnapshot,
  );
  const sessionOccurrenceEntries = useMemo(
    () =>
      occurrenceOutbox.entries.filter(
        (entry) =>
          entry.ownerId === props.ownerId && entry.sessionId === props.sessionId,
      ),
    [occurrenceOutbox.entries, props.ownerId, props.sessionId],
  );

  useEffect(
    () => () => {
      if (pendingSetAcknowledgementFrameRef.current != null) {
        window.cancelAnimationFrame(pendingSetAcknowledgementFrameRef.current);
      }
    },
    [],
  );

  const shownExercises = useMemo(() => {
    const serverComparisons = new Map(
      props.exercises.map((exercise) => [
        exercise.id,
        exercise.previousComparable,
      ]),
    );
    return mergeSessionOutboxSets(
      exercises.map((exercise) => ({
        ...exercise,
        previousComparable:
          serverComparisons.get(exercise.id) ?? exercise.previousComparable,
      })),
      sessionEntries,
      runtimeSaveStates,
    );
  }, [exercises, props.exercises, runtimeSaveStates, sessionEntries]);
  const comparisonUnavailableByExerciseId = useMemo(
    () => Object.fromEntries(shownExercises.map((exercise) => {
      const equipmentState = equipmentSelectionComparisonState(
        equipmentSelectionOutbox,
        {
          ownerId: props.ownerId,
          sessionId: props.sessionId,
          sessionExerciseId: exercise.id,
        },
      );
      return [
        exercise.id,
        previousComparableIsTemporarilyUnavailable({
          equipmentOutboxHydrated,
          equipmentState,
          awaitingServerRefresh:
            comparisonRefreshTargets[exercise.id] != null,
        }),
      ];
    })),
    [
      comparisonRefreshTargets,
      equipmentOutboxHydrated,
      equipmentSelectionOutbox,
      props.ownerId,
      props.sessionId,
      shownExercises,
    ],
  );
  useEffect(() => {
    const revealLinkedExercise = () => {
      const targetId = decodeURIComponent(window.location.hash.slice(1));
      if (!targetId || lastConsumedWorkoutHashRef.current === targetId) return;

      const linkedOccurrence = occurrences.find(
        (occurrence) =>
          occurrence.sessionExerciseId != null &&
          (targetId ===
            `set-entry-${occurrence.sessionExerciseId}-${occurrence.id}` ||
            targetId ===
              `added-set-entry-${occurrence.sessionExerciseId}-${occurrence.id}`),
      );
      const explicitExercise = shownExercises.find(
        (exercise) => targetId === `exercise-${exercise.id}`,
      );
      const linkedExercise =
        explicitExercise ??
        (linkedOccurrence
          ? shownExercises.find(
              (exercise) => exercise.id === linkedOccurrence.sessionExerciseId,
            )
          : null);
      if (!linkedExercise) return;

      lastConsumedWorkoutHashRef.current = targetId;
      if (linkedOccurrence) {
        const firstPendingOccurrence = [...occurrences]
          .filter((occurrence) => occurrence.outcome === "pending")
          .sort((left, right) => left.sequenceIdx - right.sequenceIdx)[0];
        if (
          linkedOccurrence.outcome !== "pending" ||
          linkedOccurrence.id !== firstPendingOccurrence?.id
        ) {
          staleWorkoutActionHashRef.current = true;
          return;
        }
      }

      staleWorkoutActionHashRef.current = false;
      setExpandedId(linkedExercise.id);
      requestAnimationFrame(() => {
        document
          .getElementById(targetId)
          ?.scrollIntoView({ block: "start" });
      });
    };
    const revealChangedHash = () => {
      lastConsumedWorkoutHashRef.current = null;
      staleWorkoutActionHashRef.current = false;
      revealLinkedExercise();
    };
    revealLinkedExercise();
    window.addEventListener("hashchange", revealChangedHash);
    return () => window.removeEventListener("hashchange", revealChangedHash);
  }, [occurrences, shownExercises]);
  const safeEquipmentSetups = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(props.equipmentSetups).filter(
          ([sessionExerciseId, setup]) => {
            const exercise = shownExercises.find(
              (candidate) => candidate.id === sessionExerciseId,
            );
            return (
              exercise != null &&
              sessionEquipmentSetupMatchesExercise(exercise, setup)
            );
          },
        ),
      ),
    [props.equipmentSetups, shownExercises],
  );
  const guidance = useMemo(
    () =>
      projectSessionGuidance({
        occurrences,
        exercises: shownExercises,
        exerciseGroups: props.exerciseGroups,
        equipmentSetups: safeEquipmentSetups,
        restTimer: restTimerHydrated ? timer : null,
      }),
    [
      occurrences,
      props.exerciseGroups,
      restTimerHydrated,
      safeEquipmentSetups,
      shownExercises,
      timer,
    ],
  );
  const currentActionId = actionIdentity(guidance.currentAction);
  const currentActionKind = guidance.currentAction?.kind ?? null;
  const currentActionSequenceIdx = guidance.currentAction?.sequenceIdx ?? null;
  const currentActionSessionExerciseId =
    guidance.currentAction?.kind === "working_set"
      ? guidance.currentAction.sessionExerciseId
      : guidance.currentAction?.kind === "rest"
        ? guidance.current?.sessionExerciseId ?? null
        : null;
  const currentActionTargetId = actionTargetId(guidance.currentAction);
  const latestAcknowledgementTargetId = latestSetAcknowledgement
    ? `active-set-save-receipt-${latestSetAcknowledgement.sessionExerciseId}-${latestSetAcknowledgement.set.setNo}`
    : null;
  const latestAcknowledgementIsWorkoutOnly =
    latestSetAcknowledgement != null &&
    shownExercises.some(
      (exercise) =>
        exercise.id === latestSetAcknowledgement.sessionExerciseId &&
        exercise.modificationType === "added",
    );
  const acknowledgementPresentationExerciseId =
    latestSetAcknowledgement != null &&
    (guidance.currentAction?.kind === "working_set" ||
      guidance.currentAction?.kind === "rest")
      ? guidance.currentAction.kind === "rest" &&
        latestAcknowledgementIsWorkoutOnly
        ? latestSetAcknowledgement.sessionExerciseId
        : currentActionSessionExerciseId ??
          latestSetAcknowledgement.sessionExerciseId
      : null;
  useEffect(() => {
    const previousActionId = previousCurrentActionIdRef.current;
    const previousActionKind = previousCurrentActionKindRef.current;
    previousCurrentActionIdRef.current = currentActionId;
    previousCurrentActionKindRef.current = currentActionKind;
    if (skipRecoveryExerciseId != null) {
      return;
    }
    const reconcileStaleHash = staleWorkoutActionHashRef.current;
    if (
      !reconcileStaleHash &&
      (previousActionId == null || previousActionId === currentActionId)
    ) {
      return;
    }
    staleWorkoutActionHashRef.current = false;

    const previousOccurrence = occurrences.find(
      (occurrence) => occurrence.id === previousActionId,
    );
    const restoredEarlierAction =
      previousOccurrence != null &&
      currentActionSequenceIdx != null &&
      currentActionSequenceIdx < previousOccurrence.sequenceIdx;
    if (
      previousOccurrence?.outcome === "pending" &&
      !restoredEarlierAction
    ) return;
    const acknowledgementBelongsToPreviousAction =
      previousOccurrence?.kind === "working_set" &&
      latestAcknowledgementTargetId ===
        `active-set-save-receipt-${previousOccurrence.sessionExerciseId}-${previousOccurrence.kindOrdinal + 1}`;
    const shouldRevealLatestAcknowledgement =
      currentActionKind === "rest" ||
      previousActionKind === "rest" ||
      acknowledgementBelongsToPreviousAction;

    let focusFrame = 0;
    let scrollFrame = 0;
    const revealCurrentAction = () => {
      if (pendingSetAcknowledgementAnchorRef.current != null) {
        scrollFrame = window.requestAnimationFrame(revealCurrentAction);
        return;
      }
      lastConsumedWorkoutHashRef.current = currentActionTargetId;
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}#${currentActionTargetId}`,
      );
      if (currentActionSessionExerciseId) {
        setExpandedId(currentActionSessionExerciseId);
      }
      focusFrame = window.requestAnimationFrame(() => {
        const target = document.getElementById(currentActionTargetId);
        const acknowledgement =
          shouldRevealLatestAcknowledgement && latestAcknowledgementTargetId
            ? document.getElementById(latestAcknowledgementTargetId)
            : null;
        if (acknowledgement) {
          revealWorkoutTarget(acknowledgement, "auto");
        } else if (currentActionKind !== "rest") {
          if (target) revealWorkoutTarget(target, "smooth");
        }
        const focusTarget = target?.matches("[tabindex]")
          ? target
          : target?.querySelector<HTMLElement>("button, [href], input");
        if (focusTarget instanceof HTMLElement) {
          focusTarget.focus({ preventScroll: true });
        }
      });
    };
    scrollFrame = window.requestAnimationFrame(revealCurrentAction);
    return () => {
      window.cancelAnimationFrame(scrollFrame);
      window.cancelAnimationFrame(focusFrame);
    };
  }, [
    currentActionId,
    currentActionKind,
    currentActionSequenceIdx,
    currentActionSessionExerciseId,
    currentActionTargetId,
    latestAcknowledgementTargetId,
    occurrences,
    skipRecoveryExerciseId,
  ]);
  const groupContextByExerciseId = useMemo(
    () =>
      Object.fromEntries(
        guidance.groups.flatMap((group) =>
          group.members.map((member) => [
            member.sessionExerciseId,
            {
              name: group.name,
              memberOrder: member.order,
              memberCount: group.members.length,
            },
          ]),
        ),
      ),
    [guidance.groups],
  );
  const safePlateConfigs = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(props.plateConfigs).filter(([sessionExerciseId]) => {
          const exercise = shownExercises.find(
            (candidate) => candidate.id === sessionExerciseId,
          );
          const setup = safeEquipmentSetups[sessionExerciseId];
          return exercise != null && setup != null &&
            sessionEquipmentSetupMatchesExercise(exercise, setup);
        }),
      ),
    [props.plateConfigs, safeEquipmentSetups, shownExercises],
  );

  const refreshRestTimer = useCallback(async () => {
    const now = Date.now();
    const result = await restoreAndPersistRestTimer(
      window.localStorage,
      { ownerId: props.ownerId, sessionId: props.sessionId },
      now,
    );
    setTimer(result.status === "restored" ? result.timer : null);
    setRestNow(now);
    setRestTimerHydrated(true);
  }, [
    props.ownerId,
    props.sessionId,
    setRestNow,
    setRestTimerHydrated,
    setTimer,
  ]);

  useEffect(() => {
    const initialRestore = window.setTimeout(
      () => void refreshRestTimer(),
      0,
    );
    const unsubscribe = subscribeToRestTimer(() => void refreshRestTimer());
    return () => {
      window.clearTimeout(initialRestore);
      unsubscribe();
    };
  }, [refreshRestTimer]);

  const advanceAfterExercise = useCallback(
    (exerciseId: string) => {
      const nextId = nextIncompleteExerciseId(shownExercises, exerciseId);
      setExpandedId(nextId);

      requestAnimationFrame(() => {
        document
          .getElementById(nextId ? `exercise-${nextId}` : "finish-workout")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    [shownExercises, setExpandedId]
  );

  useEffect(() => {
    const onStatus = (detail: WorkoutSetOutboxClientEvent) => {
      if (!detail || detail.sessionId !== props.sessionId) return;
      if (detail.type === "saving") {
        patchActiveWorkoutMeasurement(detail.clientKey, {
          outcome: detail.retrying ? "retried" : "delayed",
        });
        setRuntimeSaveStates((current) => ({
          ...current,
          [detail.clientKey]: detail.retrying ? "retrying" : "saving",
        }));
        return;
      }
      setRuntimeSaveStates((current) => {
        const next = { ...current };
        delete next[detail.clientKey];
        return next;
      });
      if (detail.type === "failed") {
        patchActiveWorkoutMeasurement(detail.clientKey, { outcome: "failed" });
        return;
      }
      if (detail.type === "discarded") {
        setExercises((current) =>
          current.map((exercise) => ({
            ...exercise,
            sets: exercise.sets.filter(
              (set) => set.clientKey !== detail.clientKey
            ),
          }))
        );
        return;
      }
      const acknowledgedRowId =
        `logged-set-${detail.entry.sessionExerciseId}-${detail.entry.setNo}`;
      const acknowledgedRow = document.getElementById(acknowledgedRowId);
      if (acknowledgedRow) {
        const bounds = acknowledgedRow.getBoundingClientRect();
        if (bounds.bottom >= 0 && bounds.top <= window.innerHeight) {
          pendingSetAcknowledgementAnchorRef.current = {
            clientKey: detail.clientKey,
            elementId: acknowledgedRowId,
            receiptElementId:
              `active-set-save-receipt-${detail.entry.sessionExerciseId}-${detail.entry.setNo}`,
            viewportTop: bounds.top,
          };
          if (pendingSetAcknowledgementFrameRef.current != null) {
            window.cancelAnimationFrame(
              pendingSetAcknowledgementFrameRef.current,
            );
          }
          let framesRemaining = 30;
          const keepAcknowledgementInPlace = () => {
            const anchor = pendingSetAcknowledgementAnchorRef.current;
            if (!anchor || anchor.clientKey !== detail.clientKey) return;
            const row =
              document.getElementById(anchor.receiptElementId) ??
              document.getElementById(anchor.elementId);
            if (row?.textContent?.includes("Saved")) {
              const offset =
                row.getBoundingClientRect().top - anchor.viewportTop;
              if (Math.abs(offset) > 1) {
                window.scrollBy({
                  left: 0,
                  top: offset,
                  behavior: "auto",
                });
              }
            }
            framesRemaining -= 1;
            if (framesRemaining > 0) {
              pendingSetAcknowledgementFrameRef.current =
                window.requestAnimationFrame(keepAcknowledgementInPlace);
              return;
            }
            pendingSetAcknowledgementAnchorRef.current = null;
            pendingSetAcknowledgementFrameRef.current = null;
          };
          pendingSetAcknowledgementFrameRef.current =
            window.requestAnimationFrame(keepAcknowledgementInPlace);
        }
      }
      const saved: LoggedSet = {
        id: detail.setId,
        clientKey: detail.clientKey,
        setNo: detail.entry.setNo,
        weight: detail.entry.weight,
        weightUnit: detail.entry.weightUnit,
        reps: detail.entry.reps,
        distanceKm: detail.entry.distanceKm,
        durationSeconds: detail.entry.durationSeconds,
        metricType: detail.entry.metricType,
        rpe: detail.entry.rpe,
        rir: detail.entry.rir,
        techniqueIssue: detail.entry.techniqueIssue,
        limitationCause: detail.entry.limitationCause,
        pain: detail.entry.pain,
        note: detail.entry.note,
        correctionCount: 0,
        saveState: "saved",
      };
      setLatestSetAcknowledgement({
        sessionExerciseId: detail.entry.sessionExerciseId,
        exerciseName: detail.entry.exerciseName,
        metricType: detail.entry.metricType,
        set: saved,
      });
      setExercises((current) =>
        current.map((exercise) => {
          if (exercise.id !== detail.entry.sessionExerciseId) return exercise;
          const withoutClientCopy = exercise.sets.filter(
            (set) => set.clientKey !== detail.clientKey
          );
          return {
            ...exercise,
            sets: [...withoutClientCopy, saved].sort(
              (a, b) => a.setNo - b.setNo
            ),
          };
        })
      );
      setOccurrences((current) =>
        current.map((occurrence) =>
          occurrence.kind === "working_set" &&
          occurrence.sessionExerciseId === detail.entry.sessionExerciseId &&
          occurrence.kindOrdinal === detail.entry.setNo - 1
            ? {
                ...occurrence,
                outcome: "completed",
                completedSetId: detail.setId,
                revision: occurrence.revision + 1,
                resolvedAt: new Date().toISOString(),
              }
            : occurrence,
        ),
      );
      const measured = readActiveWorkoutMeasurements().find(
        (record) => record.clientKey === detail.clientKey
      );
      const acknowledgedAtISO = new Date().toISOString();
      patchActiveWorkoutMeasurement(detail.clientKey, {
        setId: detail.setId,
        acknowledgedAtISO,
        durationMs: measured
          ? Math.max(
              0,
              Date.parse(acknowledgedAtISO) - Date.parse(measured.readyAtISO)
            )
          : null,
        outcome: measured?.outcome === "retried" ? "retried" : "saved",
      });
    };
    return subscribeToWorkoutSetOutboxStatus(onStatus);
  }, [
    props.sessionId,
  ]);

  useEffect(() => {
    const onStatus = (detail: OccurrenceMutationOutboxClientEvent) => {
      if (!detail || detail.sessionId !== props.sessionId) return;
      if (detail.type === "saving") {
        setOccurrenceRuntimeSaveStates((current) => ({
          ...current,
          [detail.clientKey]: detail.retrying ? "retrying" : "saving",
        }));
        return;
      }
      setOccurrenceRuntimeSaveStates((current) => {
        const next = { ...current };
        delete next[detail.clientKey];
        return next;
      });
      if (detail.type === "failed") return;
      if (detail.type === "discarded") return;
      if (
        sessionOccurrenceEntries.some(
          (entry) =>
            entry.occurrenceId === detail.occurrence.id &&
            entry.clientKey !== detail.clientKey,
        )
      ) {
        return;
      }
      setOccurrences((current) =>
        current.map((occurrence) =>
          occurrence.id === detail.occurrence.id
            ? {
                ...occurrence,
                outcome:
                  detail.occurrence.state as SessionOccurrenceData["outcome"],
                outcomeReason: detail.occurrence.reason,
                outcomeNote: detail.occurrence.note,
                revision: detail.occurrence.revision,
                resolvedAt: detail.occurrence.resolvedAt,
              }
            : occurrence,
        ),
      );
      setAcknowledgedOccurrenceIds((current) =>
        current.includes(detail.occurrence.id)
          ? current
          : [...current, detail.occurrence.id],
      );
    };
    return subscribeToOccurrenceMutationOutboxStatus(onStatus);
  }, [props.sessionId, sessionOccurrenceEntries]);

  useEffect(() => {
    const onStatus = (detail: EquipmentSelectionOutboxEvent) => {
      if (!detail || detail.type !== "saved") return;
      if (!props.exercises.some(
        (exercise) => exercise.id === detail.sessionExerciseId,
      )) return;
      setOccurrences((current) =>
        mergeEquipmentSelectionOccurrenceStates(current, detail.occurrenceStates),
      );
      const serverSnapshot =
        props.equipmentSetups[detail.sessionExerciseId]?.currentSnapshotId ??
        null;
      if (serverSnapshot !== detail.snapshotId) {
        setComparisonRefreshTargets((current) => ({
          ...current,
          [detail.sessionExerciseId]: detail.snapshotId ?? "none",
        }));
      }
      router.refresh();
    };
    return subscribeToEquipmentSelectionOutboxStatus(onStatus);
  }, [props.equipmentSetups, props.exercises, router]);

  useEffect(
    () => () => {
      const context = audioContextRef.current;
      if (context && context.state !== "closed") void context.close();
    },
    []
  );

  const totalPlanned = guidance.totals.planned;
  const totalPerformed = guidance.totals.performed;
  const plannedPerformed = guidance.totals.plannedPerformed;
  const extraPerformed = guidance.totals.extraPerformed;
  const workoutOnlyPerformed = guidance.totals.workoutOnlyPerformed;
  const pendingWorking = guidance.totals.pending;
  const nonPerformedSummary = sessionNonPerformedOutcomeParts(
    guidance.totals,
  ).join(" · ");
  const warmupOccurrences = occurrences.filter(
    (occurrence) => occurrence.kind !== "working_set",
  );
  const completedWarmups = guidance.warmups.completed;
  const groupRoundSummary = guidance.groups.flatMap((group) =>
    group.rounds.map((round) => ({
      key: `${group.groupId}:${round.round}`,
      groupName: group.name,
      round: round.round,
      planned: round.planned,
      completed: round.performed,
      skipped: round.skipped,
      pending: round.pending,
      abandoned: round.abandoned,
      legacyUnknown: round.legacyUnknown,
      completedWithoutResult: round.completedWithoutResult,
    })),
  );
  const sessionEquipmentEntries = equipmentSelectionOutbox.entries.filter(
    (entry) => entry.ownerId === props.ownerId && entry.sessionId === props.sessionId,
  );
  const exitQueues: WorkoutExitQueues = {
    unsyncedSetCount: sessionEntries.length,
    quarantinedSetCount: outbox.quarantined.length,
    setHasError: outbox.error != null,
    unsyncedOccurrenceCount: sessionOccurrenceEntries.length,
    occurrenceHasError: occurrenceOutbox.error != null,
    unsyncedEquipmentCount: sessionEquipmentEntries.length,
    quarantinedEquipmentCount: equipmentSelectionOutbox.quarantined.length,
    equipmentHasError: equipmentSelectionOutbox.error != null,
  };
  // Finishing is gated only by unresolved recorded work; a stuck equipment
  // setup ("awaiting information") is guidance and must never trap the workout.
  const finishBlocked = finishBlockedByRecordedWork(exitQueues);
  const equipmentGuidancePending = equipmentSyncPending(exitQueues);
  const effectiveDurationChoice =
    timing.reviewRequired && durationChoice === "wall_clock_no_stale_signal"
      ? null
      : durationChoice;
  const ownerReportedSeconds = validateOwnerReportedActiveMinutes(
    ownerReportedMinutes,
    timing.wallClockSeconds,
  ).seconds;
  const durationReviewReady =
    effectiveDurationChoice === "interruption_unknown" ||
    (effectiveDurationChoice === "wall_clock_no_stale_signal" &&
      !timing.reviewRequired) ||
    (effectiveDurationChoice === "owner_reported" &&
      ownerReportedSeconds != null &&
      ownerReportedSeconds <= timing.wallClockSeconds);

  function plannedExerciseNameForOccurrence(
    occurrence: SessionOccurrenceData,
  ): string | null {
    if (!occurrence.sessionExerciseId) return null;
    const exercise = shownExercises.find(
      (candidate) => candidate.id === occurrence.sessionExerciseId,
    );
    if (!exercise) return null;
    return occurrence.plannedExerciseId != null &&
      occurrence.plannedExerciseId === exercise.substitutedForExerciseId
      ? exercise.plannedExerciseName ?? exercise.name
      : exercise.name;
  }

  function equipmentConfirmationBlocks(
    occurrence: SessionOccurrenceData,
  ): boolean {
    if (!occurrence.sessionExerciseId) return false;
    const setup = safeEquipmentSetups[occurrence.sessionExerciseId];
    const automaticChoiceNotQueuedYet =
      setup?.status === "available" &&
      setup.currentSnapshotId == null &&
      setup.options.length === 1;
    return automaticChoiceNotQueuedYet || sessionEquipmentEntries.some(
      (entry) => entry.sessionExerciseId === occurrence.sessionExerciseId,
    );
  }

  function patchExercise(id: string, patch: Partial<SessionExerciseData>) {
    setExercises((list) =>
      list.map((e) => (e.id === id ? { ...e, ...patch } : e))
    );
  }

  async function queueSet(
    exercise: SessionExerciseData,
    set: LoggedSet,
    restAfterSec: number | null | undefined = exercise.restSec,
  ) {
    if (!set.clientKey) return false;
    const performed = buildPerformedSetMeasurement({
      metricType: set.metricType ?? resolveFutureSetWriterMetricType({
        metricType: exercise.metricType ?? "weight_reps",
        loadSemantics: exercise.loadSemantics,
      }),
      loadSemantics: exercise.loadSemantics,
      weight: set.weight,
      weightUnit: set.weightUnit,
      reps: set.reps,
      distanceKm: set.distanceKm ?? null,
      durationSeconds: set.durationSeconds ?? null,
    });
    if (!performed.ok) {
      toast.error(performed.message);
      return false;
    }
    const setup = safeEquipmentSetups[exercise.id];
    const pendingEquipmentSelection = equipmentSelectionOutbox.entries
      .filter((entry) =>
        entry.ownerId === props.ownerId && entry.sessionId === props.sessionId &&
        entry.sessionExerciseId === exercise.id && entry.operation === "select")
      .at(-1) ?? null;
    const pendingEquipmentOption = pendingEquipmentSelection == null ? null :
      setup?.options.find((option) =>
        option.equipmentItemId === pendingEquipmentSelection.equipmentItemId &&
        option.attachmentItemId === pendingEquipmentSelection.attachmentItemId) ?? null;
    const decision = performed.measurement.weight == null
      ? ({ status: "log_displayed_unknown" } as const)
      : resolveSetLoggingEquipment({
          hasSetup: setup != null,
          hasSnapshot: setup?.currentSnapshotId != null,
          hasPendingSelection: pendingEquipmentSelection != null,
          optionCount: setup?.options.length ?? 0,
          effectiveLoadMeaning: setup
            ? (pendingEquipmentOption?.loadEntryMeaning ??
                equipmentLoadMeanings[exercise.id] ??
                setup.loadEntryMeaning) ?? null
            : "legacy_unknown",
        });
    if (decision.status === "choose_setup") {
      toast.error("Choose the physical equipment setup before logging this set.");
      return false;
    }
    if (decision.status === "await_meaning") {
      toast.error("This equipment setup does not yet define what the entered load means.");
      return false;
    }
    // A resolvable setup carries its snapshot/selection; an unresolvable one
    // records the displayed load honestly with no snapshot so the workout is
    // never trapped by missing equipment information.
    const useSnapshot =
      decision.status === "log_with_snapshot" &&
      performed.measurement.weight != null;
    const observedCompletedAtISO = new Date().toISOString();
    if (restAfterSec != null && restAfterSec > 0) primeRestCue();
    const queued = await enqueueWorkoutSet({
      clientKey: set.clientKey,
      ownerId: props.ownerId,
      sessionId: props.sessionId,
      sessionExerciseId: exercise.id,
      performedExerciseId: exercise.exerciseId,
      performedSemanticsVersion: 1,
      performedLoadType: exercise.loadType,
      performedLoadSemantics:
        exercise.loadSemantics as PerformedLoadSemantics,
      workoutName: props.templateName,
      exerciseName: exercise.name,
      setNo: set.setNo,
      ...performed.measurement,
      rpe: set.rpe,
      rir: set.rir ?? null,
      techniqueIssue: set.techniqueIssue ?? null,
      limitationCause: set.limitationCause ?? null,
      pain: set.pain ?? null,
      note: set.note,
      equipmentSnapshotId: useSnapshot ? setup?.currentSnapshotId ?? null : null,
      equipmentSelectionClientKey: useSnapshot
        ? pendingEquipmentSelection?.clientKey ?? null
        : null,
      restAfterSec,
      loadEntryMeaning: useSnapshot ? decision.loadEntryMeaning : "legacy_unknown",
      observedCompletedAtISO,
      createdAtISO: observedCompletedAtISO,
    });
    if (!queued.ok) {
      toast.error(queued.reason);
      return false;
    }
    setExercises((current) =>
      current.map((candidate) =>
        candidate.id !== exercise.id ||
        candidate.sets.some((existing) => existing.clientKey === set.clientKey)
          ? candidate
          : { ...candidate, sets: [...candidate.sets, set] }
      )
    );
    return true;
  }

  async function retrySet(clientKey: string) {
    const retried = await retryWorkoutSet(clientKey);
    if (!retried.ok) toast.error(retried.reason);
    else {
      window.setTimeout(
        () => window.dispatchEvent(new Event(WORKOUT_SET_OUTBOX_CHANGE_EVENT)),
        0
      );
    }
  }

  async function discardSet(clientKey: string) {
    const entry = sessionEntries.find((candidate) => candidate.clientKey === clientKey);
    const removed = await removeWorkoutSet(clientKey);
    if (!removed.ok) {
      toast.error(removed.reason);
      return;
    }
    setExercises((current) =>
      current.map((exercise) => ({
        ...exercise,
        sets: exercise.sets.filter((set) => set.clientKey !== clientKey),
      }))
    );
    if (entry) {
      publishWorkoutSetOutboxEvent({
        type: "discarded",
        clientKey,
        sessionId: entry.sessionId,
      });
    }
  }

  const transitionRestTimer = useCallback(async (
    expected: DurableRestTimer,
    next: DurableRestTimer,
  ) => {
    if (next === expected) return;
    const result = await writeRestTimerCas(
      window.localStorage,
      { ownerId: props.ownerId, sessionId: props.sessionId },
      expected,
      next,
    );
    if (result.status === "updated") {
      setTimer(result.timer);
      setRestNow(Date.now());
    } else {
      await refreshRestTimer();
    }
  }, [
    props.ownerId,
    props.sessionId,
    refreshRestTimer,
    setRestNow,
    setTimer,
  ]);

  const clearMatchingRestTimer = useCallback(async (
    expectedGenerationId?: string,
  ) => {
    await clearRestTimerForIdentity(
      window.localStorage,
      { ownerId: props.ownerId, sessionId: props.sessionId },
      expectedGenerationId,
    );
    await refreshRestTimer();
  }, [props.ownerId, props.sessionId, refreshRestTimer]);

  function primeRestCue() {
    const preference = readRestAlertPreference(window.localStorage);
    if (!requestedRestCueChannels(preference).sound) return;
    audioCueBlockedRef.current = false;
    try {
      if (!audioContextRef.current && typeof AudioContext !== "undefined") {
        audioContextRef.current = new AudioContext();
      }
      if (audioContextRef.current?.state === "suspended") {
        void audioContextRef.current.resume().catch(() => {
          audioCueBlockedRef.current = true;
        });
      }
    } catch {
      audioCueBlockedRef.current = true;
      // The persistent visual timer remains authoritative when audio is blocked.
    }
  }

  function openCoach(sessionExerciseId: string | null) {
    setCoachExerciseId(sessionExerciseId);
    setCoachOpen(true);
  }

  const skipRest = useCallback(() => {
    if (!timer) return;
    void transitionRestTimer(timer, skipRestTimer(timer, Date.now()));
  }, [timer, transitionRestTimer]);

  const continueRest = useCallback(() => {
    if (!timer) return;
    const continued = continueAfterRest(timer, Date.now());
    if (continued === timer) return;
    void clearMatchingRestTimer(timer.generationId);
  }, [clearMatchingRestTimer, timer]);

  const requestRestCue = useCallback((
    milestone: RestCueMilestone,
    preference: RestAlertPreference,
  ) => {
    const channels = requestedRestCueChannels(preference);
    let soundRequested = false;
    let vibrationRequested = false;

    if (channels.sound) {
      const context = audioContextRef.current;
      if (context?.state === "running") {
        try {
          const startsAt = context.currentTime;
          if (milestone === "complete") {
            for (const tone of REST_COMPLETION_TONE_PATTERN) {
              playTone(
                context,
                tone.frequencyHz,
                startsAt + tone.delaySec,
                tone.durationSec,
              );
            }
          } else {
            playTone(
              context,
              milestone === "15" ? 660 : 760,
              startsAt,
              0.18,
            );
          }
          soundRequested = true;
          audioCueBlockedRef.current = false;
        } catch {
          soundRequested = false;
        }
      }
    }

    if (channels.vibration) {
      try {
        vibrationRequested = typeof navigator.vibrate === "function" &&
          navigator.vibrate(
            milestone === "complete" ? [180, 80, 180] : [100],
          );
      } catch {
        vibrationRequested = false;
      }
    }

    return restCueOutcome({
      preference,
      soundRequested,
      vibrationRequested,
      soundBlocked:
        channels.sound &&
        (audioCueBlockedRef.current ||
          (audioContextRef.current != null &&
            audioContextRef.current.state !== "running" &&
            audioContextRef.current.state !== "closed")),
    });
  }, []);

  useEffect(() => {
    if (!timer || timer.phase !== "running") {
      previousRestRemainingRef.current = null;
      return;
    }

    let disposed = false;
    let tickInFlight = false;
    restWasVisibleRef.current = document.visibilityState === "visible";

    const tick = async (
      foreground = document.visibilityState === "visible",
    ) => {
      if (disposed || tickInFlight) return;
      tickInFlight = true;
      const now = Date.now();
      const currentRemainingSec = remainingRestSeconds(timer, now);
      const previousRemainingSec = previousRestRemainingRef.current ??
        Math.max(currentRemainingSec, timer.totalSec);
      const preference = readRestAlertPreference(window.localStorage);
      const plan = planRestCueTransition({
        previousRemainingSec,
        currentRemainingSec,
        attemptedMilestones: timer.attemptedMilestones,
        preference,
        foreground,
      });
      try {
        if (currentRemainingSec === 0) {
          if (!foreground) {
            await refreshRestTimer();
          } else {
            const fallback = restCueOutcome({
              preference,
              soundRequested: false,
              vibrationRequested: false,
            });
            const result = await completeForegroundRestTimer(
              window.localStorage,
              { ownerId: props.ownerId, sessionId: props.sessionId },
              timer.generationId,
              now,
              fallback,
              () => requestRestCue("complete", preference),
            );
            if (result.status === "completed") {
              setTimer(result.timer);
            } else {
              await refreshRestTimer();
            }
          }
        } else if (plan.consumedMilestones.length > 0) {
          const claimed = await claimRestCueMilestones(
            window.localStorage,
            { ownerId: props.ownerId, sessionId: props.sessionId },
            timer.generationId,
            plan.consumedMilestones,
          );
          if (claimed.status === "updated" && claimed.timer) {
            setTimer(claimed.timer);
            for (const milestone of claimed.claimedMilestones) {
              if (plan.milestonesToAttempt.includes(milestone)) {
                requestRestCue(milestone, preference);
              }
            }
          } else if (claimed.status !== "unchanged") {
            await refreshRestTimer();
          }
        }
      } finally {
        previousRestRemainingRef.current = currentRemainingSec;
        setRestNow((current) =>
          Math.floor(current / 1000) === Math.floor(now / 1000)
            ? current
            : now,
        );
        tickInFlight = false;
      }
    };

    const onVisibilityChange = () => {
      const visible = document.visibilityState === "visible";
      const returnedFromBackground = visible && !restWasVisibleRef.current;
      restWasVisibleRef.current = visible;
      void tick(returnedFromBackground ? false : visible);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      void tick(event.persisted ? false : document.visibilityState === "visible");
    };
    const interval = window.setInterval(() => void tick(), 250);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    void tick();
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [
    props.ownerId,
    props.sessionId,
    refreshRestTimer,
    requestRestCue,
    timer,
  ]);

  async function handleFinish() {
    if (finishBlocked) {
      toast.error("Retry or discard the unconfirmed set copies below before finishing.");
      return;
    }
    if (!durationReviewReady || effectiveDurationChoice == null) {
      setFinishError(
        timing.reviewRequired
          ? "Choose a defensible active time or explicitly keep it unknown."
          : "Review the workout timing before saving.",
      );
      return;
    }
    setFinishing(true);
    setFinishError(null);
    try {
      await clearMatchingRestTimer();
      const result = await completeSession({
        sessionId: props.sessionId,
        note: finishNote || undefined,
        fatigue: fatigue ?? undefined,
        durationDecision:
          effectiveDurationChoice === "owner_reported"
            ? {
                basis: "owner_reported",
                activeDurationSeconds: ownerReportedSeconds!,
              }
            : { basis: effectiveDurationChoice },
      });
      if (result?.ok === false) {
        setFinishError(result.message);
        setFinishing(false);
      }
    } catch {
      setFinishError(
        "The workout was not saved. Review the latest timing and try again.",
      );
      setFinishing(false);
    }
  }

  async function applyOccurrenceMutation(
    occurrence: SessionOccurrenceData,
    operation: OccurrenceMutationOperation,
    input: { reason?: string | null; note?: string | null } = {},
  ) {
    if (equipmentConfirmationBlocks(occurrence)) {
      toast.error("Wait for this exercise's equipment setup to be confirmed first.");
      return false;
    }
    const reason = input.reason?.trim() || null;
    const note = input.note?.trim() || null;
    const existing = sessionOccurrenceEntries.find(
      (entry) => entry.occurrenceId === occurrence.id,
    );
    if (
      existing &&
      existing.expectedRevision === occurrence.revision &&
      existing.operation === operation &&
      existing.reason === reason &&
      existing.note === note
    ) {
      toast.info("This workout-item change is already saving.");
      return true;
    }
    if (existing || occurrenceEnqueueInFlightRef.current.has(occurrence.id)) {
      toast.error("Resolve the current workout-item change before making another.");
      return false;
    }
    occurrenceEnqueueInFlightRef.current.add(occurrence.id);
    setAcknowledgedOccurrenceIds((current) =>
      current.filter((id) => id !== occurrence.id),
    );
    try {
      let clientKey: string;
      try {
        clientKey = createClientUuid();
      } catch {
        toast.error(
          "This browser could not create a secure workout-item identity. Nothing was saved.",
        );
        return false;
      }
      const queued = await enqueueOccurrenceMutation({
        occurrenceId: occurrence.id,
        clientKey,
        ownerId: props.ownerId,
        sessionId: props.sessionId,
        label:
          occurrence.label ??
          (occurrence.kind === "working_set" ? "Working set" : "Warm-up item"),
        expectedRevision: occurrence.revision,
        operation,
        reason,
        note,
        createdAtISO: new Date().toISOString(),
      });
      if (!queued.ok) {
        toast.error(queued.reason);
        return false;
      }
      return true;
    } finally {
      occurrenceEnqueueInFlightRef.current.delete(occurrence.id);
    }
  }

  function retryOccurrenceEntry(
    entry: (typeof sessionOccurrenceEntries)[number],
  ) {
    void retryOccurrenceMutation(entry.clientKey).then((retried) => {
      if (!retried.ok) toast.error(retried.reason);
    });
  }

  function discardOccurrenceEntry(
    entry: (typeof sessionOccurrenceEntries)[number],
  ) {
    void removeOccurrenceMutation(entry.clientKey).then((removed) => {
      if (!removed.ok) {
        toast.error(removed.reason);
        return;
      }
      setAcknowledgedOccurrenceIds((current) =>
        current.filter((id) => id !== entry.occurrenceId),
      );
      publishOccurrenceMutationOutboxEvent({
        type: "discarded",
        clientKey: entry.clientKey,
        sessionId: entry.sessionId,
      });
    });
  }

  async function handleAppendSet(
    sessionExerciseId: string,
    occurrenceId: string,
    expectedSetNo: number,
  ) {
    try {
      const result = await appendWorkoutSet({
        sessionExerciseId,
        occurrenceId,
        expectedSetNo,
      });
      if (!result.ok) {
        toast.error(result.message);
        return null;
      }
      const appended: SessionOccurrenceData = {
        id: result.occurrence.id,
        sessionExerciseId: result.occurrence.sessionExerciseId,
        kind: "working_set",
        origin: "ad_hoc",
        sequenceIdx: result.occurrence.sequenceIdx,
        kindOrdinal: result.occurrence.kindOrdinal,
        label: null,
        plannedExerciseId: result.occurrence.plannedExerciseId,
        plannedNote: result.occurrence.plannedNote,
        plannedRepsMin: result.occurrence.plannedRepsMin,
        plannedRepsMax: result.occurrence.plannedRepsMax,
        plannedLoad: result.occurrence.plannedLoad,
        plannedLoadUnit: result.occurrence.plannedLoadUnit,
        plannedLoadPercent: result.occurrence.plannedLoadPercent,
        plannedLoadText: result.occurrence.plannedLoadText,
        plannedRestSec: result.occurrence.plannedRestSec,
        groupSnapshotId: null,
        groupRound: null,
        groupMemberOrderIdx: null,
        outcome: "pending",
        outcomeReason: null,
        outcomeNote: null,
        revision: 0,
        resolvedAt: null,
        completedSetId: null,
      };
      setOccurrences((current) =>
        current.some((occurrence) => occurrence.id === appended.id)
          ? current
          : [...current, appended].sort(
              (left, right) => left.sequenceIdx - right.sequenceIdx,
            ),
      );
      return appended;
    } catch {
      toast.error("The set could not be added.");
      return null;
    }
  }

  const restRemainingSec = timer?.phase === "running"
    ? remainingRestSeconds(timer, restNow)
    : null;
  const currentOccurrence = guidance.current
    ? occurrences.find(
        (occurrence) => occurrence.id === guidance.current?.occurrenceId,
      ) ?? null
    : null;
  const currentActionOccurrenceId = actionOccurrenceId(guidance.currentAction);
  const currentActionOccurrence = currentActionOccurrenceId
    ? occurrences.find(
        (occurrence) => occurrence.id === currentActionOccurrenceId,
      ) ?? null
    : null;
  const currentActionExercise = currentActionOccurrence?.sessionExerciseId
    ? shownExercises.find(
        (exercise) =>
          exercise.id === currentActionOccurrence.sessionExerciseId &&
          exercise.modificationType !== "skipped",
      ) ?? null
    : null;
  function nextPendingOccurrenceForExercise(exerciseId: string) {
    return occurrences.find(
      (occurrence) =>
        occurrence.sessionExerciseId === exerciseId &&
        occurrence.kind === "working_set" &&
        occurrence.outcome === "pending",
    ) ?? null;
  }

  function adjustRest(delta: number) {
    if (!timer) return;
    const preference = readRestAlertPreference(window.localStorage);
    const fallback = restCueOutcome({
      preference,
      soundRequested: false,
      vibrationRequested: false,
    });
    void adjustStoredRestTimer(
      window.localStorage,
      { ownerId: props.ownerId, sessionId: props.sessionId },
      timer.generationId,
      delta,
      Date.now(),
      fallback,
      () => requestRestCue("complete", preference),
    ).then(async (result) => {
      if (
        (result.status === "updated" || result.status === "completed") &&
        result.timer
      ) {
        setTimer(result.timer);
        setRestNow(Date.now());
      } else if (result.status !== "unchanged") {
        await refreshRestTimer();
      }
    });
  }
  const contextualNoteScope: ContextualNoteScopeValue = (() => {
    const currentOccurrence = currentActionOccurrence;
    const restOccurrence = timer
      ? resolveRestTimerSourceOccurrence(timer, occurrences)
      : null;
    // A running/ready timer owns the note context. Never retarget its rest to
    // guidance.current, which normally advances to the next pending set.
    const occurrence = timer ? restOccurrence : currentOccurrence;
    const exercise = occurrence?.sessionExerciseId
      ? shownExercises.find((candidate) => candidate.id === occurrence.sessionExerciseId) ?? null
      : null;
    const occurrencePosition =
      occurrence?.kind === "working_set"
        ? workingSetDisplayPosition(occurrence, occurrences)
        : null;
    const workoutPhase = timer
      ? timer.phase === "running"
        ? "rest" as const
        : "working" as const
      : occurrence?.kind === "working_set"
        ? "working" as const
        : occurrence
          ? "warmup" as const
          : "review" as const;
    const attachments: ContextualNoteScopeValue["attachments"] = [];
    if (occurrence && exercise) {
      if (timer) {
        attachments.push({
          key: `rest:${occurrence.id}`,
          kind: "rest",
          label: `Rest after ${exercise.name} ${occurrencePosition?.lowercaseLabel ?? `set ${occurrence.kindOrdinal + 1}`}`,
          sessionId: props.sessionId,
          sessionExerciseId: exercise.id,
          occurrenceId: occurrence.id,
          completedSetId: occurrence.completedSetId,
        });
      }
      attachments.push({
        key: `${occurrence.kind}:${occurrence.id}`,
        kind: occurrence.kind === "working_set" ? "set" : "occurrence",
        label:
          occurrence.kind === "working_set"
            ? `${exercise.name} ${occurrencePosition?.lowercaseLabel ?? `set ${occurrence.kindOrdinal + 1}`}`
            : occurrence.label ?? `${exercise.name} warm-up`,
        sessionId: props.sessionId,
        sessionExerciseId: exercise.id,
        occurrenceId: occurrence.id,
        completedSetId: occurrence.completedSetId,
      });
      attachments.push({
        key: `exercise:${exercise.id}`,
        kind: "exercise",
        label: `Current exercise · ${exercise.name}`,
        sessionId: props.sessionId,
        sessionExerciseId: exercise.id,
      });
    }
    attachments.push({
      key: `workout:${props.sessionId}`,
      kind: "workout",
      label: `Entire workout · ${props.templateName}`,
      sessionId: props.sessionId,
    });
    attachments.push({ key: "general", kind: "general", label: "General training note" });
    return {
      scopeId: `active-workout:${props.sessionId}:${occurrence?.id ?? "none"}:${timer?.generationId ?? "no-rest"}:${timer?.phase ?? "none"}`,
      capturedContext: {
        schemaVersion: 1,
        destination: "workout",
        workflow: occurrence && exercise
          ? `${props.templateName} · ${exercise.name} · ${occurrence.kind === "working_set" ? occurrencePosition?.lowercaseLabel ?? `set ${occurrence.kindOrdinal + 1}` : occurrence.label ?? "warm-up"}`
          : props.templateName,
        workoutPhase,
        originatedFromSimulation: false,
        programDay: null,
        plannedExercise: occurrence?.plannedExerciseId && exercise
          ? { id: occurrence.plannedExerciseId, name: exercise.plannedExerciseName ?? exercise.name }
          : null,
        performedExercise: exercise
          ? { id: exercise.exerciseId, name: exercise.name }
          : null,
        occurrence: occurrence
          ? {
              id: occurrence.id,
              kind: occurrence.kind,
              ordinal: occurrence.kindOrdinal,
              outcome: occurrence.outcome,
            }
          : null,
        loadRepetitions: occurrence
          ? {
              plannedLoad: occurrence.plannedLoad,
              plannedLoadUnit: occurrence.plannedLoadUnit,
              plannedLoadPercent: occurrence.plannedLoadPercent,
              plannedLoadText: occurrence.plannedLoadText,
              plannedRepsMin: occurrence.plannedRepsMin,
              plannedRepsMax: occurrence.plannedRepsMax,
            }
          : null,
        restContext: timer
          ? {
              plannedSeconds: timer.totalSec,
              remainingSeconds: restRemainingSec,
              state: timer.phase === "running" ? "resting" : "ready",
            }
          : null,
        reviewContext: null,
      },
      attachments,
      defaultAttachmentKey: attachments[0]?.key ?? "general",
    };
  })();
  const currentWorkingAction =
    guidance.currentAction?.kind === "working_set"
      ? guidance.currentAction
      : null;
  const currentWorkingExercise =
    currentWorkingAction
      ? shownExercises.find(
          (exercise) => exercise.id === currentWorkingAction.sessionExerciseId,
        ) ?? null
      : null;
  const currentCardOwnsNextAction =
    currentWorkingExercise != null &&
    expandedId === currentWorkingExercise.id &&
    !currentWorkingExercise.sets.some(
      (set) => set.saveState != null && set.saveState !== "saved",
    );
  const hasAcknowledgedWork = occurrences.some(
    (occurrence) =>
      occurrence.outcome === "completed" ||
      occurrence.outcome === "skipped" ||
      occurrence.outcome === "abandoned",
  );
  const sessionPreparationChangedOptimistically = shownExercises.some(
    (exercise) =>
      props.exercises.find((source) => source.id === exercise.id)?.exerciseId !==
        exercise.exerciseId,
  ) || shownExercises.length !== props.exercises.length;
  const sessionPreparation = sessionPreparationChangedOptimistically
    ? createUpdatingSessionEquipmentProjection()
    : props.sessionPreparation;
  const preparationWarmupAction =
    guidance.currentAction?.kind === "day_warmup" ||
    guidance.currentAction?.kind === "exercise_warmup"
      ? guidance.currentAction
      : guidance.nextAction?.kind === "day_warmup" ||
          guidance.nextAction?.kind === "exercise_warmup"
        ? guidance.nextAction
        : null;
  const preparationTargetId = preparationWarmupAction
    ? actionTargetId(preparationWarmupAction)
    : currentActionTargetId;
  const preparationContinueLabel = preparationWarmupAction
    ? "Go to warm-up"
    : guidance.currentAction?.kind === "rest"
      ? "Go to rest"
      : guidance.currentAction?.kind === "working_set"
        ? hasAcknowledgedWork
          ? "Go to current exercise"
          : "Go to first exercise"
        : guidance.currentAction
          ? "Go to warm-up"
          : "Go to finish workout";
  const continueFromPreparation = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (
        preparationTargetId !== "workout-warmup" &&
        currentActionSessionExerciseId
      ) {
        setExpandedId(currentActionSessionExerciseId);
      }
      lastConsumedWorkoutHashRef.current = preparationTargetId;
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}#${preparationTargetId}`,
      );
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const target = document.getElementById(preparationTargetId);
          if (!target) return;
          const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth";
          revealWorkoutTarget(target, behavior);
          const pendingWarmupControl = preparationWarmupAction
            ? target.querySelector<HTMLElement>(
                '[role="checkbox"][aria-checked="false"]',
              )
            : null;
          const focusTarget = pendingWarmupControl ?? (
            target.matches("[tabindex]")
              ? target
              : target.querySelector<HTMLElement>("button, [href], input")
          );
          focusTarget?.focus({ preventScroll: true });
        });
      });
    }, [
      currentActionSessionExerciseId,
      preparationWarmupAction,
      preparationTargetId,
      setExpandedId,
    ],
  );

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-3 p-3 pb-[calc(12rem+env(safe-area-inset-bottom))] min-[360px]:pb-[calc(8rem+env(safe-area-inset-bottom))] sm:p-5 sm:pb-[calc(8rem+env(safe-area-inset-bottom))] lg:p-8 lg:pb-24">
      <ContextualNoteScope value={contextualNoteScope} />
      <header className="flex flex-wrap items-center justify-between gap-2 px-1 max-[360px]:sr-only">
        <div className="min-w-0 max-[360px]:w-full">
          <h1 className="text-lg font-semibold">
            {props.templateName}
          </h1>
          <p className="text-xs text-muted-foreground max-[360px]:hidden">
            {timing.reviewRequired
              ? `Timing review · wall ${elapsed}`
              : `Active ${elapsed} · wall ${elapsed}`} · {plannedPerformed}/{totalPlanned || "?"} planned
            {extraPerformed > 0 ? ` · ${extraPerformed} extra` : ""}
            {workoutOnlyPerformed > 0
              ? ` · ${workoutOnlyPerformed} workout-only`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-1 max-[360px]:hidden">
          <WorkoutMeasurementsDrawer />
        </div>
      </header>

      <div
        data-testid="active-workout-sticky-summary"
        className="sticky top-[env(safe-area-inset-top)] z-20 -mx-1 bg-background/95 py-1 backdrop-blur max-[360px]:py-0"
      >
        <WorkoutGuidanceSummary
          guidance={guidance}
          compact
          deferNextActionToCurrentCard={currentCardOwnsNextAction}
        />
      </div>

      {timing.reviewRequired && (
        <section
          role="status"
          data-testid="active-workout-timing-warning"
          className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2.5 text-sm"
        >
          <p className="font-semibold">
            Timing needs review · wall clock {elapsed}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Active time is unavailable until you review the interruption.
            Recorded source timestamps will stay unchanged.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 min-h-11 w-full bg-background"
            onClick={() => setFinishOpen(true)}
          >
            Review timing
          </Button>
        </section>
      )}

      <SessionPreparationPanel
        projection={sessionPreparation}
        hasAcknowledgedWork={hasAcknowledgedWork}
        continueTargetId={preparationTargetId}
        continueLabel={preparationContinueLabel}
        onContinue={continueFromPreparation}
      />

      <WarmupPanel
        completed={guidance.warmups.completed}
        skipped={guidance.warmups.skipped}
        planned={guidance.warmups.planned}
        remaining={guidance.warmups.remaining}
      >
        {props.dayWarmupNotes && hasStructuredWarmup ? (
          <details className="mt-1 rounded-md border border-violet-300/50 bg-background/60 text-sm">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-md px-3 py-2 font-medium text-violet-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:text-violet-200">
              <span>Day guidance · reference only</span>
              <span className="text-xs text-muted-foreground">Show</span>
            </summary>
            <p className="whitespace-pre-line border-t px-3 py-2 leading-6 text-muted-foreground">
              {props.dayWarmupNotes}
            </p>
          </details>
        ) : props.dayWarmupNotes ? (
          <>
            <p className="mt-1 text-xs font-medium text-violet-800 dark:text-violet-200">
              Day guidance · reference only
            </p>
            <p className="mt-1 whitespace-pre-line text-sm leading-6 text-muted-foreground">
              {props.dayWarmupNotes}
            </p>
          </>
        ) : shouldShowMissingWarmupMessage({
          dayWarmupNotes: props.dayWarmupNotes,
          hasStructuredWarmup,
        }) ? (
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            No day warm-up guidance was saved with this workout. A checkable warm-up sequence is not available yet.
          </p>
        ) : null}
        {hasStructuredWarmup && (
          <>
            <p className="mt-3 text-xs font-medium text-violet-800 dark:text-violet-200">
              Check off only the distinct actions below.
            </p>
            <ul className="mt-2 space-y-2">
              {occurrences
                .filter((occurrence) => occurrence.kind !== "working_set")
                .map((occurrence) => {
                  const occurrenceExercise = occurrence.sessionExerciseId
                    ? shownExercises.find(
                        (exercise) => exercise.id === occurrence.sessionExerciseId,
                      )
                    : null;
                  const exerciseName = plannedExerciseNameForOccurrence(
                    occurrence,
                  );
                  const aggregateRestoreBlocked =
                    occurrenceExercise?.modificationType === "skipped" ||
                    (occurrence.kind === "exercise_warmup" &&
                      occurrence.plannedExerciseId != null &&
                      occurrence.plannedExerciseId !==
                        occurrenceExercise?.exerciseId) ||
                    occurrence.outcomeReason?.startsWith("exercise:") === true;
                  const aggregateRestoreDirection =
                    occurrence.outcomeReason?.startsWith(
                      "exercise:substituted:",
                    ) ||
                    (occurrence.kind === "exercise_warmup" &&
                      occurrence.plannedExerciseId != null &&
                      occurrence.plannedExerciseId !==
                        occurrenceExercise?.exerciseId)
                      ? "Undo the exercise alternative to restore this action."
                      : "Un-skip the exercise to restore this action.";
                  const prescription = formatOccurrencePrescription(occurrence);
                  const equipmentChangePending = equipmentConfirmationBlocks(occurrence);
                  const occurrenceMutation =
                    sessionOccurrenceEntries.find(
                      (entry) => entry.occurrenceId === occurrence.id,
                    ) ?? null;
                  const occurrenceAcknowledged =
                    acknowledgedOccurrenceIds.includes(occurrence.id);
                  return (
                    <li
                      key={occurrence.id}
                      id={`warmup-occurrence-${occurrence.id}`}
                      tabIndex={-1}
                      aria-current={
                        actionOccurrenceId(guidance.currentAction) === occurrence.id
                          ? "step"
                          : undefined
                      }
                      className="scroll-mt-40 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background/80 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          {occurrence.label ?? "Warm-up item"}
                        </p>
                        {exerciseName && (
                          <p className="text-xs text-muted-foreground">
                            For {exerciseName}
                          </p>
                        )}
                        {prescription && (
                          <p className="text-xs font-medium text-foreground">
                            {prescription}
                          </p>
                        )}
                        {occurrence.plannedNote && (
                          <p className="text-xs text-muted-foreground">
                            Plan: {occurrence.plannedNote}
                          </p>
                        )}
                        {occurrence.outcomeNote && (
                          <p className="text-xs text-muted-foreground">
                            Note: {occurrence.outcomeNote}
                          </p>
                        )}
                        {occurrence.outcome !== "pending" && (
                          <p className="text-xs capitalize text-muted-foreground">
                            {occurrence.outcome.replace("_", " ")}
                          </p>
                        )}
                      </div>
                      {occurrence.outcome === "pending" ? (
                        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                          <Button
                            type="button"
                            size="sm"
                            className="min-h-11"
                            variant="outline"
                            disabled={
                              equipmentChangePending ||
                              occurrenceMutation != null
                            }
                            onClick={() =>
                              setOccurrenceAction({
                                occurrenceId: occurrence.id,
                                mode: "note",
                              })
                            }
                          >
                            {occurrence.outcomeNote ? "Edit note" : "Add note"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="min-h-11"
                            variant="outline"
                            disabled={
                              equipmentChangePending ||
                              occurrenceMutation != null
                            }
                            onClick={() =>
                              setOccurrenceAction({
                                occurrenceId: occurrence.id,
                                mode: "skip",
                              })
                            }
                          >
                            Skip
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="min-h-11"
                            variant="outline"
                            role="checkbox"
                            aria-checked="false"
                            aria-label={`Mark ${occurrence.label ?? "warm-up item"} complete`}
                            disabled={
                              equipmentChangePending ||
                              occurrenceMutation != null
                            }
                            onClick={() =>
                              void applyOccurrenceMutation(occurrence, "complete")
                            }
                          >
                            <span aria-hidden className="size-4 rounded border-2 border-current" />
                            Complete
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {occurrence.outcome === "completed" && (
                            <>
                              <span
                                role="checkbox"
                                aria-checked="true"
                                aria-label={`${occurrence.label ?? "Warm-up item"} complete`}
                                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-emerald-600/50 bg-emerald-500/10 px-3 text-sm font-medium text-emerald-900 dark:text-emerald-100"
                              >
                                <span aria-hidden className="flex size-4 items-center justify-center rounded border-2 border-current text-[10px] leading-none">✓</span>
                                Complete
                              </span>
                              {!aggregateRestoreBlocked && (
                                <Button
                                  type="button"
                                  size="sm"
                                  className="min-h-11"
                                  variant="outline"
                                  disabled={occurrenceMutation != null}
                                  onClick={() =>
                                    void applyOccurrenceMutation(occurrence, "restore")
                                  }
                                >
                                  Undo completion
                                </Button>
                              )}
                            </>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            className="min-h-11"
                            variant="outline"
                            disabled={occurrenceMutation != null}
                            onClick={() =>
                              setOccurrenceAction({
                                occurrenceId: occurrence.id,
                                mode: "note",
                              })
                            }
                          >
                            {occurrence.outcomeNote ? "Edit note" : "Add note"}
                          </Button>
                          {occurrence.outcome === "skipped" &&
                            !aggregateRestoreBlocked && (
                            <Button
                              type="button"
                              size="sm"
                              className="min-h-11"
                              variant="outline"
                              disabled={occurrenceMutation != null}
                              onClick={() =>
                                void applyOccurrenceMutation(occurrence, "restore")
                              }
                            >
                              Restore
                            </Button>
                          )}
                          {aggregateRestoreBlocked && (
                            <p className="basis-full text-xs text-muted-foreground">
                              {aggregateRestoreDirection}
                            </p>
                          )}
                        </div>
                      )}
                      <OccurrenceSaveStatus
                        entry={occurrenceMutation}
                        runtimeState={
                          occurrenceMutation
                            ? occurrenceRuntimeSaveStates[
                                occurrenceMutation.clientKey
                              ] ?? null
                            : null
                        }
                        saved={
                          occurrenceAcknowledged ||
                          occurrence.outcome !== "pending"
                        }
                        onRetry={retryOccurrenceEntry}
                        onDiscard={discardOccurrenceEntry}
                      />
                    </li>
                  );
                })}
            </ul>
          </>
        )}
      </WarmupPanel>

      <div className="flex flex-col gap-3">
        {shownExercises.map((exercise) => {
          const equipmentSetup = props.equipmentSetups[exercise.id] ?? null;
          const equipmentSetupMatches = equipmentSetup != null &&
            sessionEquipmentSetupMatchesExercise(exercise, equipmentSetup);
          const equipmentSetupIsCurrent =
            currentActionOccurrence?.sessionExerciseId === exercise.id ||
            currentOccurrence?.sessionExerciseId === exercise.id;
          const equipmentSetupNeedsAttention = sessionEquipmentEntries.some(
            (entry) =>
              entry.sessionExerciseId === exercise.id &&
              (entry.status === "queued" || entry.status === "needs_attention"),
          );
          const equipmentSetupForcedOpen =
            equipmentSetupIsCurrent ||
            equipmentSetupNeedsAttention ||
            !equipmentSetupMatches;
          const equipmentPanel = equipmentSetupMatches ? (
            <EquipmentSetupPanel
              sessionExerciseId={exercise.id}
              exerciseName={exercise.name}
              ownerId={props.ownerId}
              sessionId={props.sessionId}
              setup={equipmentSetup}
              loadEntryMeaning={
                equipmentLoadMeanings[exercise.id] ??
                equipmentSetup.loadEntryMeaning ??
                "legacy_unknown"
              }
              onLoadEntryMeaningChange={(meaning) =>
                setEquipmentLoadMeanings((current) => ({
                  ...current,
                  [exercise.id]: meaning,
                }))
              }
            />
          ) : equipmentSetup ? (
            <p className="rounded-xl border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
              Updating equipment guidance… Old implement and plate details are
              withheld.
            </p>
          ) : null;
          return (
          <div key={exercise.id} className="flex flex-col gap-2">
          {currentOccurrence?.sessionExerciseId === exercise.id &&
          guidance.activeGroup ? (
            <WorkoutGroupContext guidance={guidance} />
          ) : null}
          {equipmentPanel ? (
            <details
              className={equipmentSetupForcedOpen
                ? undefined
                : "rounded-xl border bg-muted/20"}
              open={equipmentSetupForcedOpen ? true : undefined}
            >
              <summary
                hidden={equipmentSetupForcedOpen}
                className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="min-w-0 break-words">
                  Equipment setup for {exercise.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  Show
                </span>
              </summary>
              <div className={equipmentSetupForcedOpen ? undefined : "border-t p-2"}>
                {equipmentPanel}
              </div>
            </details>
          ) : null}
          <ExerciseCard
            key={`${exercise.id}:${exercise.exerciseId}:${exercise.metricType}:${exercise.loadType}:${exercise.loadSemantics}`}
            exercise={exercise}
            comparisonTemporarilyUnavailable={
              comparisonUnavailableByExerciseId[exercise.id] ?? true
            }
            historyRevision={historyRevision}
            progress={
              guidance.exercises.find(
                (item) => item.sessionExerciseId === exercise.id,
              )!
            }
            expanded={expandedId === exercise.id}
            onToggle={() =>
              setExpandedId(expandedId === exercise.id ? null : exercise.id)
            }
            plateConfigs={safePlateConfigs}
            machineLoadConfig={
              safeEquipmentSetups[exercise.id]?.machineLoadConfig ?? null
            }
            incrementals={props.incrementals}
            unit={props.unit}
            loadEntryMeaning={
              equipmentLoadMeanings[exercise.id] ??
              safeEquipmentSetups[exercise.id]?.loadEntryMeaning ??
              null
            }
            activeOccurrence={nextPendingOccurrenceForExercise(exercise.id)}
            workingOccurrences={occurrences.filter(
              (occurrence) =>
                occurrence.sessionExerciseId === exercise.id &&
                occurrence.kind === "working_set",
            )}
            occurrenceMutationEntries={sessionOccurrenceEntries.filter(
              (entry) =>
                occurrences.some(
                  (occurrence) =>
                    occurrence.id === entry.occurrenceId &&
                    occurrence.sessionExerciseId === exercise.id,
                ),
            )}
            occurrenceRuntimeSaveStates={occurrenceRuntimeSaveStates}
            acknowledgedOccurrenceIds={acknowledgedOccurrenceIds}
            acknowledgementReceipt={
              acknowledgementPresentationExerciseId === exercise.id
                ? latestSetAcknowledgement
                : null
            }
            isCurrentExercise={
              currentOccurrence?.sessionExerciseId === exercise.id
            }
            nextActionLabel={
              guidance.currentAction?.kind === "working_set" &&
              guidance.currentAction.sessionExerciseId === exercise.id
                ? guidance.nextAction
                  ? formatSessionGuidanceAction(guidance.nextAction)
                  : "No further unresolved work"
                : null
            }
            warmupResolved={
              occurrences.some(
                (occurrence) =>
                  occurrence.kind === "exercise_warmup" &&
                  occurrence.sessionExerciseId === exercise.id,
              ) &&
              occurrences.every(
                (occurrence) =>
                  occurrence.kind !== "exercise_warmup" ||
                  occurrence.sessionExerciseId !== exercise.id ||
                  occurrence.outcome !== "pending",
              )
            }
            groupContext={groupContextByExerciseId[exercise.id] ?? null}
            occurrenceChangesBlocked={
              sessionEquipmentEntries.some(
                (entry) => entry.sessionExerciseId === exercise.id,
              ) || (() => {
                const occurrence = nextPendingOccurrenceForExercise(exercise.id);
                return occurrence ? equipmentConfirmationBlocks(occurrence) : false;
              })()
            }
            onPatch={(patch) => {
              patchExercise(exercise.id, patch);
              const exerciseIdentityChanged = Object.hasOwn(
                patch,
                "exerciseId",
              );
              if (patch.modificationType === "skipped") {
                setSkipRecoveryExerciseId(exercise.id);
                setExpandedId(exercise.id);
                setOccurrences((current) => current.map((occurrence) =>
                  occurrence.sessionExerciseId === exercise.id &&
                  occurrence.outcome === "pending"
                    ? {
                        ...occurrence,
                        outcome: "skipped",
                        outcomeReason: `exercise:${patch.skipReason ?? "other"}`,
                        revision: occurrence.revision + 1,
                        resolvedAt: new Date().toISOString(),
                      }
                    : occurrence,
                ));
              } else if (
                exerciseIdentityChanged &&
                patch.modificationType === "substituted"
              ) {
                setSkipRecoveryExerciseId((current) =>
                  current === exercise.id ? null : current,
                );
                setOccurrences((current) => current.map((occurrence) => {
                  if (occurrence.sessionExerciseId !== exercise.id) {
                    return occurrence;
                  }
                  if (
                    occurrence.kind === "exercise_warmup" &&
                    occurrence.outcome === "pending"
                  ) {
                    return {
                      ...occurrence,
                      outcome: "skipped",
                      outcomeReason: "exercise:substituted:optimistic",
                      revision: occurrence.revision + 1,
                      resolvedAt: new Date().toISOString(),
                    };
                  }
                  if (
                    occurrence.kind === "working_set" &&
                    occurrence.outcome === "skipped" &&
                    occurrence.outcomeReason?.startsWith("exercise:") &&
                    !occurrence.outcomeReason.startsWith(
                      "exercise:substituted:",
                    )
                  ) {
                    return {
                      ...occurrence,
                      outcome: "pending",
                      outcomeReason: null,
                      revision: occurrence.revision + 1,
                      resolvedAt: null,
                    };
                  }
                  return occurrence;
                }));
              } else if (
                exerciseIdentityChanged &&
                patch.modificationType === "as_planned"
              ) {
                setOccurrences((current) => current.map((occurrence) =>
                  occurrence.sessionExerciseId === exercise.id &&
                  occurrence.kind === "exercise_warmup" &&
                  occurrence.outcome === "skipped" &&
                  occurrence.outcomeReason?.startsWith(
                    "exercise:substituted:",
                  )
                    ? {
                        ...occurrence,
                        outcome: "pending",
                        outcomeReason: null,
                        revision: occurrence.revision + 1,
                        resolvedAt: null,
                      }
                    : occurrence,
                ));
              } else if (
                patch.modificationType === "as_planned" ||
                patch.modificationType === "substituted"
              ) {
                setSkipRecoveryExerciseId((current) =>
                  current === exercise.id ? null : current,
                );
                setOccurrences((current) => current.map((occurrence) =>
                  occurrence.sessionExerciseId === exercise.id &&
                  occurrence.outcome === "skipped" &&
                  occurrence.outcomeReason?.startsWith("exercise:") &&
                  !occurrence.outcomeReason.startsWith(
                    "exercise:substituted:",
                  )
                    ? {
                        ...occurrence,
                        outcome: "pending",
                        outcomeReason: null,
                        revision: occurrence.revision + 1,
                        resolvedAt: null,
                      }
                    : occurrence,
                ));
              }
            }}
            onQueueSet={(set, occurrence) =>
              queueSet(
                exercise,
                set,
                occurrence
                  ? guidance.actions.find(
                      (action) => action.occurrenceId === occurrence.id,
                    )?.restAfter.seconds ?? null
                  : exercise.restSec,
              )
            }
            onAppendSet={(occurrenceId, expectedSetNo) =>
              handleAppendSet(exercise.id, occurrenceId, expectedSetNo)
            }
            onSkipSet={async ({ reason, note }, requestedOccurrence) => {
              const occurrence =
                requestedOccurrence ??
                nextPendingOccurrenceForExercise(exercise.id);
              if (!occurrence) {
                return false;
              }
              const skipped = await applyOccurrenceMutation(
                occurrence,
                "skip",
                { reason, note },
              );
              if (skipped) toast.info("Set skip is saving.");
              return skipped;
            }}
            onRetryOccurrenceMutation={retryOccurrenceEntry}
            onDiscardOccurrenceMutation={discardOccurrenceEntry}
            onRetrySet={retrySet}
            onDiscardSet={discardSet}
            onHistoryRevisionChange={setHistoryRevision}
            onOpenCoach={() => openCoach(exercise.id)}
            onSkipComplete={() => {
              setSkipRecoveryExerciseId((current) =>
                current === exercise.id ? null : current,
              );
              advanceAfterExercise(exercise.id);
            }}
            adjustIntent={
              adjustment?.exerciseId === exercise.id
                ? adjustment.intent
                : null
            }
            onAdjustIntentChange={(intent) =>
              setAdjustment(intent ? { exerciseId: exercise.id, intent } : null)
            }
          />
          </div>
          );
        })}
      </div>

      <AddWorkoutExercise
        ownerId={props.ownerId}
        sessionId={props.sessionId}
      />

      <section
        id="finish-workout"
        className="scroll-mt-4 rounded-xl border bg-card p-4 shadow-[var(--shadow-soft)]"
      >
        <p className="mb-3 text-center text-sm text-muted-foreground">
          {totalPerformed} set{totalPerformed === 1 ? "" : "s"} performed · {timing.reviewRequired
            ? `active time unavailable · wall clock ${elapsed}`
            : `active ${elapsed} · wall clock ${elapsed}`}
        </p>
        <Button
          type="button"
          variant="outline"
          className="mb-2 h-auto min-h-9 w-full whitespace-normal py-2"
          onClick={() => openCoach(null)}
        >
          <MessageSquareText className="size-4" /> Ask Coach about this workout
        </Button>
        <Button
          size="lg"
          className="w-full"
          onClick={() => setFinishOpen(true)}
        >
          <CheckCircle2 className="size-4" /> Finish Workout
        </Button>
      </section>

      <Drawer open={finishOpen} onOpenChange={setFinishOpen}>
        <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11 [&_textarea]:min-h-11">
          <DrawerHeader>
            <DrawerTitle>Finish workout</DrawerTitle>
            <DrawerDescription>
              {plannedPerformed} of {totalPlanned} planned sets done. Wall clock {elapsed}.
              {extraPerformed > 0
                ? ` ${extraPerformed} extra set${extraPerformed === 1 ? "" : "s"} performed.`
                : ""}
              {workoutOnlyPerformed > 0
                ? ` ${workoutOnlyPerformed} workout-only set${workoutOnlyPerformed === 1 ? "" : "s"} performed.`
                : ""}
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-4 px-4">
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p>
                {nonPerformedSummary || "All planned sets are accounted for."}
                {pendingWorking > 0
                  ? " Any sets left open will be marked not completed."
                  : ""}
              </p>
              {warmupOccurrences.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Warm-up: {completedWarmups} of {warmupOccurrences.length} completed.
                </p>
              )}
              {groupRoundSummary.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                  {groupRoundSummary.map((round) => (
                    <li key={round.key}>
                      {round.groupName}, round {round.round}: {round.completed} of {round.planned} performed
                      {round.skipped > 0 ? ` · ${round.skipped} skipped` : ""}
                      {round.pending > 0 ? ` · ${round.pending} still pending` : ""}
                      {round.abandoned > 0 ? ` · ${round.abandoned} abandoned` : ""}
                      {round.completedWithoutResult > 0
                        ? ` · ${round.completedWithoutResult} missing a saved result`
                        : ""}
                      {round.legacyUnknown > 0
                        ? ` · ${round.legacyUnknown} result unknown`
                        : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {finishBlocked && (
              <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
                {workoutSaveQueueMessage({
                  // Equipment guidance no longer blocks finishing, so it is
                  // excluded from this blocking message and shown separately.
                  equipmentError: null,
                  occurrenceError: occurrenceOutbox.error,
                  setError: outbox.error,
                  occurrenceCount: sessionOccurrenceEntries.length,
                  occurrenceQuarantineCount: 0,
                  equipmentCount: 0,
                  equipmentQuarantineCount: 0,
                  setCount: sessionEntries.length,
                  setQuarantineCount: outbox.quarantined.length,
                })}
              </p>
            )}
            {equipmentGuidancePending && (
              <p className="rounded-md border border-muted-foreground/25 bg-muted/40 p-3 text-sm text-muted-foreground">
                An equipment choice is still saving. You can finish now; it
                only affects suggestions for future sets and will keep trying
                in the background.
              </p>
            )}
            <ActiveWorkoutTimingReview
              wallClockLabel={elapsed}
              wallClockSeconds={timing.wallClockSeconds}
              reviewRequired={timing.reviewRequired}
              choice={effectiveDurationChoice}
              ownerReportedMinutes={ownerReportedMinutes}
              onChoiceChange={(choice) => {
                setDurationChoice(choice);
                setFinishError(null);
              }}
              onOwnerReportedMinutesChange={(value) => {
                setOwnerReportedMinutes(value);
                setFinishError(null);
              }}
            />
            {finishError && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {finishError}
              </p>
            )}
            <Textarea
              placeholder="Session note (optional) — how did it go?"
              value={finishNote}
              onChange={(e) => setFinishNote(e.target.value)}
              rows={2}
            />
            <div>
              <p
                id={fatigueLabelId}
                className="mb-2 text-sm text-muted-foreground"
              >
                Overall fatigue
              </p>
              <div
                role="group"
                aria-labelledby={fatigueLabelId}
                className="flex gap-2"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <Button
                    key={n}
                    variant={fatigue === n ? "default" : "outline"}
                    size="touch"
                    className="flex-1"
                    aria-pressed={fatigue === n}
                    onClick={() => setFatigue(fatigue === n ? null : n)}
                  >
                    {n}
                  </Button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                1 = fresh · 5 = wiped out
              </p>
            </div>
          </div>
          <DrawerFooter>
            <Button
              onClick={handleFinish}
              disabled={finishing || finishBlocked || !durationReviewReady}
              size="lg"
            >
              {finishing ? "Saving…" : "Save workout"}
            </Button>
            <ActiveWorkoutDiscard
              sessionId={props.sessionId}
              sessionName={props.templateName}
              triggerLabel="Discard workout"
              onBeforeDiscard={() =>
                clearMatchingRestTimer()
              }
            />
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <LiveCoachDrawer
        open={coachOpen}
        onOpenChange={setCoachOpen}
        ownerId={props.ownerId}
        sessionId={props.sessionId}
        context={
          coachExerciseId
            ? {
                sessionExerciseId: coachExerciseId,
                exerciseName:
                  shownExercises.find((exercise) => exercise.id === coachExerciseId)?.name ??
                  "Exercise",
              }
            : null
        }
        initialMessages={props.coachMessages}
        exerciseNames={Object.fromEntries(
          shownExercises.map((exercise) => [exercise.id, exercise.name])
        )}
        activeRestTimerSeconds={restRemainingSec}
      />
      {restTimerHydrated && (
        <WorkoutStatusBar
          action={guidance.currentAction}
          exercise={currentActionExercise}
          timer={timer}
          restRemainingSec={restRemainingSec}
          onShowCurrent={() => {
            const currentAction = guidance.currentAction;
            if (!currentAction) return;
            const targetId = actionTargetId(currentAction);
            const occurrenceAction = currentAction.kind === "rest"
              ? currentAction.source
              : currentAction;
            if (occurrenceAction?.kind === "working_set") {
              setExpandedId(occurrenceAction.sessionExerciseId);
            }
            lastConsumedWorkoutHashRef.current = targetId;
            staleWorkoutActionHashRef.current = false;
            window.history.replaceState(
              window.history.state,
              "",
              `${window.location.pathname}${window.location.search}#${targetId}`,
            );
            requestAnimationFrame(() => {
              const target = document.getElementById(targetId);
              if (target) revealWorkoutTarget(target, "smooth");
            });
          }}
          onRestAdjust={adjustRest}
          onRestSkip={skipRest}
          onRestContinue={continueRest}
          onAddNote={openContextualNoteComposer}
          onFinish={() => setFinishOpen(true)}
        />
      )}
      {(() => {
        if (!occurrenceAction) return null;
        const occurrence = occurrences.find(
          (candidate) => candidate.id === occurrenceAction.occurrenceId,
        );
        if (!occurrence) return null;
        const exerciseName = plannedExerciseNameForOccurrence(occurrence);
        const itemLabel = [exerciseName, occurrence.label ?? "warm-up item"]
          .filter(Boolean)
          .join(": ");
        return (
          <OccurrenceMutationDialog
            key={`${occurrence.id}:${occurrenceAction.mode}:${occurrence.outcomeNote ?? ""}`}
            open
            onOpenChange={(open) => {
              if (!open) setOccurrenceAction(null);
            }}
            mode={occurrenceAction.mode}
            itemLabel={itemLabel}
            initialNote={occurrence.outcomeNote}
            onConfirm={({ reason, note }) =>
              applyOccurrenceMutation(
                occurrence,
                occurrenceAction.mode === "skip" ? "skip" : "note",
                { reason, note },
              )
            }
          />
        );
      })()}
    </main>
  );
}

function playTone(
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number
) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startsAt);
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(0.16, startsAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration);
}
