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
  confirmExerciseUnskipped,
  completeSession,
  skipExercise,
} from "@/app/actions/sessions";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, CheckCircle2, MessageSquareText } from "lucide-react";
import {
  ExerciseCard,
  type ExerciseAdjustmentIntent,
  type SetOrderBlocker,
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
import { activeWorkoutScrollBehavior } from "@/lib/active-workout-motion";
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
import { cn } from "@/lib/utils";
import {
  enqueueWorkoutSet,
  discardWorkoutSetDeviceCopy,
  getWorkoutSetOutboxServerSnapshot,
  getWorkoutSetOutboxSnapshot,
  publishWorkoutSetOutboxEvent,
  releaseWorkoutSetOrderBlockersForOccurrence,
  retryWorkoutSet,
  subscribeToWorkoutSetOutbox,
  subscribeToWorkoutSetOutboxStatus,
  withOutboxLock,
  WORKOUT_SET_OUTBOX_CHANGE_EVENT,
  type WorkoutSetOutboxClientEvent,
  type WorkoutSetOutboxEntry,
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
  withOccurrenceMutationOutboxLock,
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
  reconcileServerOccurrences,
  restTimerSecondsAfterQueuedSet,
  resolveSetLoggingEquipment,
  shouldShowMissingWarmupMessage,
  skipRecoveryNeedsReconciliation,
  workoutSaveQueueMessage,
  workoutSetOrderBlockerTargetId,
  type WorkoutExitQueues,
} from "@/lib/session-runner";
import {
  adjustStoredRestTimer,
  claimRestCueMilestones,
  clearRestTimerForIdentity,
  createRestTimer,
  completeForegroundRestTimer,
  continueAfterRest,
  deliverMissedRestCompletionCue,
  remainingRestSeconds,
  resolveRestTimerSourceOccurrence,
  restoreAndPersistRestTimer,
  skipRestTimer,
  subscribeToRestTimer,
  writeRestTimer,
  writeRestTimerCas,
  type DurableRestTimer,
  type RestCueChannelOutcome,
  type RestCueMilestone,
} from "@/lib/rest-timer";
import { ScreenWakeLockController } from "@/lib/screen-wake-lock";
import {
  DEFAULT_REST_ALERT_PREFERENCE,
  planRestCueTransition,
  playRestTonePattern,
  prepareRestAudioContext,
  primeRestAudioContext,
  readRestAlertPreference,
  REST_COMPLETION_TONE_PATTERN,
  REST_COUNTDOWN_TICK_PATTERN,
  requestedRestCueChannels,
  restSoundChannelState,
  restCountdownCueKey,
  restCueOutcome,
  subscribeToRestAlertPreference,
  type RestAlertPreference,
} from "@/lib/rest-alert-preference";
import {
  formatSessionGuidanceAction,
  projectSessionGuidance,
  sessionNonPerformedOutcomeParts,
  sessionEquipmentSetupMatchesExercise,
  type SessionGuidanceFocusAction,
} from "@/lib/session-guidance";
import {
  deploymentRecoveryRequired,
  isDocumentActionTimeout,
  reportDeploymentMismatch,
  reportDocumentActionTimeout,
  withDocumentActionDeadline,
} from "@/lib/deployment-recovery";
import {
  workingSetDisplayPosition,
  workingSetOccurrenceOrderIsEligible,
} from "@/lib/session-occurrences";
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
import {
  INCOMPLETE_SESSION_REASONS,
  INCOMPLETE_SESSION_REASON_LABELS,
  type IncompleteSessionReason,
} from "@/lib/session-completion-semantics";

function incompleteSessionReasonIsValid(
  value: unknown,
): value is IncompleteSessionReason {
  return typeof value === "string" &&
    INCOMPLETE_SESSION_REASONS.includes(value as IncompleteSessionReason);
}

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
      className="scroll-mt-4 flex flex-col rounded-xl border border-violet-300/60 bg-violet-50/60 p-4 dark:bg-violet-950/20"
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

function skipRecoveryStorageKey(ownerId: string, sessionId: string) {
  return `workout-tracker:skip-recovery:v1:${ownerId}:${sessionId}`;
}

function appendSetRecoveryStorageKey(ownerId: string, sessionId: string) {
  return `workout-tracker:append-set-recovery:v1:${ownerId}:${sessionId}`;
}

function finishRecoveryStorageKey(ownerId: string, sessionId: string) {
  return `workout-tracker:finish-recovery:v2:${ownerId}:${sessionId}`;
}

function legacyFinishRecoveryStorageKey(ownerId: string, sessionId: string) {
  return `workout-tracker:finish-recovery:v1:${ownerId}:${sessionId}`;
}

type FinishRecoveryInput = {
  sessionId: string;
  note?: string;
  fatigue?: number;
  completionReason?: IncompleteSessionReason;
  durationDecision:
    | { basis: "wall_clock_no_stale_signal" }
    | { basis: "interruption_unknown" }
    | { basis: "owner_reported"; activeDurationSeconds: number };
};

type FinishRecoveryCommand = FinishRecoveryInput & { version: 2 };

function finishDurationDecisionIsValid(
  value: unknown,
): value is FinishRecoveryCommand["durationDecision"] {
  if (value == null || typeof value !== "object") return false;
  const decision = value as Record<string, unknown>;
  if (
    decision.basis === "wall_clock_no_stale_signal" ||
    decision.basis === "interruption_unknown"
  ) {
    return true;
  }
  return decision.basis === "owner_reported" &&
    typeof decision.activeDurationSeconds === "number" &&
    Number.isInteger(decision.activeDurationSeconds) &&
    decision.activeDurationSeconds >= 0 &&
    decision.activeDurationSeconds <= 604_800;
}

function readFinishRecovery(
  storage: Storage,
  key: string,
  sessionId: string,
): FinishRecoveryCommand | null {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<FinishRecoveryCommand>;
    if (
      parsed.version !== 2 ||
      parsed.sessionId !== sessionId ||
      (parsed.note != null &&
        (typeof parsed.note !== "string" || parsed.note.length > 2_000)) ||
      (parsed.fatigue != null &&
        (typeof parsed.fatigue !== "number" ||
          !Number.isInteger(parsed.fatigue) ||
          parsed.fatigue < 1 ||
          parsed.fatigue > 5)) ||
      (parsed.completionReason != null &&
        !incompleteSessionReasonIsValid(parsed.completionReason)) ||
      !finishDurationDecisionIsValid(parsed.durationDecision)
    ) {
      return null;
    }
    return {
      version: 2,
      sessionId: parsed.sessionId,
      ...(parsed.note == null ? {} : { note: parsed.note }),
      ...(parsed.fatigue == null ? {} : { fatigue: parsed.fatigue }),
      ...(parsed.completionReason == null
        ? {}
        : { completionReason: parsed.completionReason }),
      durationDecision: parsed.durationDecision,
    };
  } catch {
    return null;
  }
}

function readLegacyFinishRecovery(
  storage: Storage,
  key: string,
  sessionId: string,
): FinishRecoveryInput | null {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<FinishRecoveryInput>;
    if (
      parsed.sessionId !== sessionId ||
      (parsed.note != null &&
        (typeof parsed.note !== "string" || parsed.note.length > 2_000)) ||
      (parsed.fatigue != null &&
        (typeof parsed.fatigue !== "number" ||
          !Number.isInteger(parsed.fatigue) ||
          parsed.fatigue < 1 ||
          parsed.fatigue > 5)) ||
      !finishDurationDecisionIsValid(parsed.durationDecision)
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      ...(parsed.note == null ? {} : { note: parsed.note }),
      ...(parsed.fatigue == null ? {} : { fatigue: parsed.fatigue }),
      durationDecision: parsed.durationDecision,
    };
  } catch {
    return null;
  }
}

function writeFinishRecovery(
  storage: Storage,
  key: string,
  command: FinishRecoveryCommand,
) {
  try {
    storage.setItem(key, JSON.stringify(command));
    return true;
  } catch {
    return false;
  }
}

function removeFinishRecovery(storage: Storage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // The retained command remains visible as unresolved recovery state.
  }
}

type AppendSetRecoveryMarker = {
  sessionExerciseId: string;
  occurrenceId: string;
  expectedSetNo: number;
};

function readAppendSetRecovery(
  storage: Storage,
  key: string,
): AppendSetRecoveryMarker | null {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<AppendSetRecoveryMarker>;
    if (
      typeof parsed.sessionExerciseId !== "string" ||
      parsed.sessionExerciseId.length === 0 ||
      typeof parsed.occurrenceId !== "string" ||
      parsed.occurrenceId.length === 0 ||
      typeof parsed.expectedSetNo !== "number" ||
      !Number.isInteger(parsed.expectedSetNo) ||
      parsed.expectedSetNo < 1 ||
      parsed.expectedSetNo > 100
    ) {
      return null;
    }
    return {
      sessionExerciseId: parsed.sessionExerciseId,
      occurrenceId: parsed.occurrenceId,
      expectedSetNo: parsed.expectedSetNo,
    };
  } catch {
    return null;
  }
}

function writeAppendSetRecovery(
  storage: Storage,
  key: string,
  marker: AppendSetRecoveryMarker,
) {
  try {
    storage.setItem(key, JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

function removeAppendSetRecovery(
  storage: Storage,
  key: string,
  occurrenceId: string,
) {
  try {
    const current = readAppendSetRecovery(storage, key);
    if (current?.occurrenceId !== occurrenceId) return;
    storage.removeItem(key);
  } catch {
    // The marker remains visible as unresolved recovery state in this runner.
  }
}

type LegacySkipReason = "time" | "pain" | "equipment" | "other";
type SkipRecoveryReason = LegacySkipReason | IncompleteSessionReason;

function skipRecoveryReasonLabel(reason: SkipRecoveryReason) {
  return incompleteSessionReasonIsValid(reason)
    ? INCOMPLETE_SESSION_REASON_LABELS[reason].toLowerCase()
    : reason;
}

type SkipRecoveryMarker = {
  exerciseId: string;
  pageTimeOrigin: number;
  runnerInstanceId: string | null;
  reason: SkipRecoveryReason;
  phase: "pending" | "unconfirmed";
  expectedHistoryRevision: number;
};

function skipRecoveryReason(value: unknown): SkipRecoveryMarker["reason"] {
  return typeof value === "string" &&
      (["time", "pain", "equipment", "other"] as const).includes(
        value as LegacySkipReason,
      )
    ? value as LegacySkipReason
    : incompleteSessionReasonIsValid(value)
      ? value
      : "user_choice";
}

function readSkipRecovery(
  storage: Storage,
  key: string,
): SkipRecoveryMarker | null {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<SkipRecoveryMarker>;
    if (
      typeof parsed.exerciseId !== "string" ||
      typeof parsed.pageTimeOrigin !== "number" ||
      !Number.isFinite(parsed.pageTimeOrigin) ||
      (parsed.runnerInstanceId != null &&
        (typeof parsed.runnerInstanceId !== "string" ||
          parsed.runnerInstanceId.length === 0)) ||
      typeof parsed.expectedHistoryRevision !== "number" ||
      !Number.isInteger(parsed.expectedHistoryRevision) ||
      parsed.expectedHistoryRevision < 0 ||
      (parsed.phase != null &&
        parsed.phase !== "pending" &&
        parsed.phase !== "unconfirmed") ||
      !(
        typeof parsed.reason === "string" &&
        (["time", "pain", "equipment", "other"] as const).includes(
          parsed.reason as LegacySkipReason,
        )
      ) &&
      !incompleteSessionReasonIsValid(parsed.reason)
    ) {
      return null;
    }
    return {
      exerciseId: parsed.exerciseId,
      pageTimeOrigin: parsed.pageTimeOrigin,
      runnerInstanceId: parsed.runnerInstanceId ?? null,
      reason: skipRecoveryReason(parsed.reason),
      phase: parsed.phase === "unconfirmed" ? "unconfirmed" : "pending",
      expectedHistoryRevision: parsed.expectedHistoryRevision,
    };
  } catch {
    return null;
  }
}

function writeSkipRecovery(
  storage: Storage,
  key: string,
  marker: SkipRecoveryMarker,
) {
  try {
    storage.setItem(key, JSON.stringify(marker));
  } catch {
    // The in-memory recovery state remains available for this page lifetime.
  }
}

function removeSkipRecovery(storage: Storage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // The in-memory recovery state remains authoritative for this page lifetime.
  }
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
  const deviceSaveStatus = document.querySelector<HTMLElement>(
    '[aria-label="Device save status"]',
  );
  const visibleTop = Math.max(
    viewportTop,
    stickySummary?.getBoundingClientRect().bottom ?? viewportTop,
  ) + 8;
  const visibleBottom = Math.min(
    viewportBottom,
    statusBar?.getBoundingClientRect().top ?? viewportBottom,
    deviceSaveStatus?.getBoundingClientRect().top ?? viewportBottom,
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

function firstVisibleFocusable(target: HTMLElement) {
  return [...target.querySelectorAll<HTMLElement>(
    "input:not([type='hidden']):not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
  )].find((candidate) => {
    const bounds = candidate.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 &&
      candidate.getAttribute("aria-hidden") !== "true";
  }) ?? null;
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
  const restAlertPreference = useSyncExternalStore(
    subscribeToRestAlertPreference,
    () => readRestAlertPreference(window.localStorage),
    () => DEFAULT_REST_ALERT_PREFERENCE,
  );
  const router = useRouter();
  const [skipRecoveryRunnerInstanceId] = useState(() => createClientUuid());
  const runnerActiveRef = useRef(true);
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
  const effectiveHistoryRevision = Math.max(
    historyRevision,
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
  const [collapsedActiveGroupMemberState, setCollapsedActiveGroupMemberState] =
    useState<{
      groupId: string | null;
      currentActionSessionExerciseId: string | null;
      ids: Set<string>;
    }>(() => ({
      groupId: null,
      currentActionSessionExerciseId: null,
      ids: new Set(),
    }));
  const [skipRecoveryExerciseId, setSkipRecoveryExerciseId] = useState<
    string | null
  >(null);
  const [skipConfirmationExerciseId, setSkipConfirmationExerciseId] = useState<
    string | null
  >(null);
  const [skipConfirmationError, setSkipConfirmationError] = useState<{
    exerciseId: string;
    message: string;
  } | null>(null);
  const skipRecoverySettlementPending =
    skipRecoveryExerciseId != null && historyRevision > props.historyRevision;
  const skipReconciliationRef = useRef<Set<string>>(new Set());
  const skipUnconfirmedRef = useRef<Set<string>>(new Set());
  const skipRequestRunnerInstanceRef = useRef<Record<string, string>>({});
  const pageUnloadingRef = useRef(false);
  const skipRecoveryKey = skipRecoveryStorageKey(
    props.ownerId,
    props.sessionId,
  );
  const appendRecoveryKey = appendSetRecoveryStorageKey(
    props.ownerId,
    props.sessionId,
  );
  const finishRecoveryKey = finishRecoveryStorageKey(
    props.ownerId,
    props.sessionId,
  );
  const legacyFinishRecoveryKey = legacyFinishRecoveryStorageKey(
    props.ownerId,
    props.sessionId,
  );
  const [appendRecoveryMarker, setAppendRecoveryMarker] = useState<
    AppendSetRecoveryMarker | null
  >(null);
  const [appendRecoveryHydrated, setAppendRecoveryHydrated] = useState(false);
  const [finishRecoveryCommand, setFinishRecoveryCommand] = useState<
    FinishRecoveryCommand | null
  >(null);
  const [finishRecoveryHydrated, setFinishRecoveryHydrated] = useState(false);
  const previousCurrentActionIdRef = useRef<string | null>(null);
  const previousCurrentActionKindRef = useRef<
    SessionGuidanceFocusAction["kind"] | null
  >(null);
  const previousCurrentActionSessionExerciseIdRef = useRef<string | null>(null);
  const exerciseDisclosureGenerationRef = useRef(0);
  const lastConsumedWorkoutHashRef = useRef<string | null>(null);
  const staleWorkoutActionHashRef = useRef(false);
  const [timer, setTimer] = useState<DurableRestTimer | null>(null);
  const [restTimerHydrated, setRestTimerHydrated] = useState(false);
  const [restNow, setRestNow] = useState(() => Date.now());
  const previousRestRemainingRef = useRef<number | null>(null);
  const restWasVisibleRef = useRef(true);
  const serverOccurrenceIdsRef = useRef(
    new Set(props.occurrences.map((occurrence) => occurrence.id)),
  );
  const requestedOrderConflictRefreshesRef = useRef<Set<string>>(new Set());
  const [finishOpen, setFinishOpen] = useState(
    props.initialTimingReviewOpen ?? false,
  );
  const [finishNote, setFinishNote] = useState("");
  const [fatigue, setFatigue] = useState<number | null>(null);
  const [completionReason, setCompletionReason] =
    useState<IncompleteSessionReason | null>(null);
  const [warmupPlanOpen, setWarmupPlanOpen] = useState(false);
  const [completedWarmupsOpen, setCompletedWarmupsOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [finishConflictDetected, setFinishConflictDetected] = useState(false);
  const [recordedEnqueueCount, setRecordedEnqueueCount] = useState(0);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const retained = readFinishRecovery(
        window.localStorage,
        finishRecoveryKey,
        props.sessionId,
      );
      setFinishRecoveryCommand(retained);
      setFinishRecoveryHydrated(true);
      if (retained != null) {
        setFinishNote(retained.note ?? "");
        setFatigue(retained.fatigue ?? null);
        setCompletionReason(retained.completionReason ?? null);
        setDurationChoice(retained.durationDecision.basis);
        setOwnerReportedMinutes(
          retained.durationDecision.basis === "owner_reported"
            ? String(retained.durationDecision.activeDurationSeconds / 60)
            : "",
        );
        setFinishOpen(true);
        setFinishError(
          "Repbook retained your exact finish details. Save workout to retry them safely.",
        );
        return;
      }
      const legacy = readLegacyFinishRecovery(
        window.localStorage,
        legacyFinishRecoveryKey,
        props.sessionId,
      );
      if (legacy != null) {
        setFinishNote(legacy.note ?? "");
        setFatigue(legacy.fatigue ?? null);
        setDurationChoice(legacy.durationDecision.basis);
        setOwnerReportedMinutes(
          legacy.durationDecision.basis === "owner_reported"
            ? String(legacy.durationDecision.activeDurationSeconds / 60)
            : "",
        );
        setFinishOpen(true);
        setFinishError(
          "Repbook recovered finish details saved by an older app version. Review them and choose an explicit reason for any remaining planned work before retrying.",
        );
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [finishRecoveryKey, legacyFinishRecoveryKey, props.sessionId]);

  useEffect(() => {
    runnerActiveRef.current = true;
    return () => {
      runnerActiveRef.current = false;
    };
  }, []);
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

  useEffect(() => {
    const onPageHide = () => {
      pageUnloadingRef.current = true;
    };
    const onPageShow = () => {
      pageUnloadingRef.current = false;
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  const clearSkipRecovery = useCallback((sessionExerciseId: string) => {
    skipUnconfirmedRef.current.delete(sessionExerciseId);
    setSkipRecoveryExerciseId((current) =>
      current === sessionExerciseId ? null : current,
    );
    setSkipConfirmationExerciseId((current) =>
      current === sessionExerciseId ? null : current,
    );
    const storedMarker = readSkipRecovery(
      window.sessionStorage,
      skipRecoveryKey,
    );
    if (storedMarker?.exerciseId === sessionExerciseId) {
      removeSkipRecovery(window.sessionStorage, skipRecoveryKey);
    }
  }, [skipRecoveryKey]);

  const failSkipRecovery = useCallback((
    sessionExerciseId: string,
    reason: SkipRecoveryMarker["reason"],
    message: string,
  ) => {
    skipUnconfirmedRef.current.add(sessionExerciseId);
    const storedMarker = readSkipRecovery(
      window.sessionStorage,
      skipRecoveryKey,
    );
    writeSkipRecovery(window.sessionStorage, skipRecoveryKey, {
      exerciseId: sessionExerciseId,
      pageTimeOrigin:
        storedMarker?.exerciseId === sessionExerciseId
          ? storedMarker.pageTimeOrigin
          : window.performance.timeOrigin,
      runnerInstanceId: skipRecoveryRunnerInstanceId,
      reason,
      phase: "unconfirmed",
      expectedHistoryRevision:
        storedMarker?.exerciseId === sessionExerciseId
          ? storedMarker.expectedHistoryRevision
          : effectiveHistoryRevision,
    });
    setSkipConfirmationExerciseId((current) =>
      current === sessionExerciseId ? null : current,
    );
    setSkipRecoveryExerciseId(sessionExerciseId);
    setExpandedId(sessionExerciseId);
    setSkipConfirmationError({ exerciseId: sessionExerciseId, message });
  }, [
    effectiveHistoryRevision,
    skipRecoveryKey,
    skipRecoveryRunnerInstanceId,
  ]);

  useEffect(() => {
    if (skipRecoveryExerciseId != null) return;
    const storedMarker = readSkipRecovery(
      window.sessionStorage,
      skipRecoveryKey,
    );
    if (storedMarker == null) return;
    const linkedExercise = exercises.find(
      (exercise) => storedMarker.exerciseId === exercise.id,
    );
    if (!linkedExercise) {
      removeSkipRecovery(window.sessionStorage, skipRecoveryKey);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const unconfirmed =
        storedMarker.phase === "unconfirmed" ||
        skipUnconfirmedRef.current.has(linkedExercise.id);
      if (unconfirmed) skipUnconfirmedRef.current.add(linkedExercise.id);
      setSkipRecoveryExerciseId(linkedExercise.id);
      setExpandedId(linkedExercise.id);
      setSkipConfirmationExerciseId(
        linkedExercise.modificationType === "skipped" ||
          unconfirmed
          ? null
          : linkedExercise.id,
      );
      setSkipConfirmationError(
        linkedExercise.modificationType !== "skipped" &&
          unconfirmed
          ? {
              exerciseId: linkedExercise.id,
              message: `Repbook could not confirm the ${skipRecoveryReasonLabel(storedMarker.reason)} skip after the reload. Review the exercise, then try skipping again or return to the current set.`,
            }
          : null,
      );
    });
    if (
      linkedExercise.modificationType !== "skipped" &&
      storedMarker.phase === "pending" &&
      skipRecoveryNeedsReconciliation({
        markerRunnerInstanceId: storedMarker.runnerInstanceId,
        currentRunnerInstanceId: skipRecoveryRunnerInstanceId,
      })
    ) {
      const reconciliationKey = [
        storedMarker.exerciseId,
        storedMarker.reason,
        storedMarker.runnerInstanceId ?? "legacy",
        storedMarker.expectedHistoryRevision,
      ].join(":");
      if (!skipReconciliationRef.current.has(reconciliationKey)) {
        skipReconciliationRef.current.add(reconciliationKey);
        void skipExercise({
          sessionExerciseId: storedMarker.exerciseId,
          reason: storedMarker.reason,
          expectedHistoryRevision: storedMarker.expectedHistoryRevision,
        }).then((result) => {
          if (
            pageUnloadingRef.current || !runnerActiveRef.current
          ) {
            return;
          }
          if (!result.ok) {
            failSkipRecovery(
              storedMarker.exerciseId,
              storedMarker.reason,
              `${result.message} Review the ${skipRecoveryReasonLabel(storedMarker.reason)} skip, then try again or return to the current set.`,
            );
            if (result.code === "skip_stale") router.refresh();
            return;
          }
          patchExercise(storedMarker.exerciseId, {
            modificationType: "skipped",
            skipReason: storedMarker.reason,
          });
          setOccurrences((current) => current.map((occurrence) =>
            occurrence.sessionExerciseId === storedMarker.exerciseId &&
            occurrence.outcome === "pending"
              ? {
                  ...occurrence,
                  outcome: "skipped",
                  outcomeReason: `exercise:${storedMarker.reason}`,
                  revision: occurrence.revision + 1,
                  resolvedAt: new Date().toISOString(),
                }
              : occurrence,
          ));
          setSkipConfirmationExerciseId(null);
          setHistoryRevision(result.historyRevision);
          router.refresh();
        }).catch(() => {
          if (
            pageUnloadingRef.current || !runnerActiveRef.current
          ) {
            return;
          }
          failSkipRecovery(
            storedMarker.exerciseId,
            storedMarker.reason,
            `Repbook could not confirm the ${skipRecoveryReasonLabel(storedMarker.reason)} skip after the reload. Review the exercise, then try again or return to the current set.`,
          );
        });
      }
    }
    return () => window.cancelAnimationFrame(frame);
  }, [
    exercises,
    failSkipRecovery,
    router,
    skipRecoveryExerciseId,
    skipRecoveryKey,
    skipRecoveryRunnerInstanceId,
  ]);
  useEffect(() => {
    if (skipRecoveryExerciseId == null) return;
    const authoritative = props.exercises.find(
      (exercise) =>
        exercise.id === skipRecoveryExerciseId &&
        exercise.modificationType === "skipped",
    );
    if (!authoritative) return;
    const frame = window.requestAnimationFrame(() => {
      skipUnconfirmedRef.current.delete(skipRecoveryExerciseId);
      setExercises((current) => current.map((exercise) =>
        exercise.id === authoritative.id
          ? {
              ...exercise,
              modificationType: "skipped",
              skipReason: authoritative.skipReason,
            }
          : exercise,
      ));
      setSkipConfirmationExerciseId(null);
      setSkipConfirmationError((current) =>
        current?.exerciseId === authoritative.id ? null : current,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.exercises, skipRecoveryExerciseId]);
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
  const [restSoundState, setRestSoundState] = useState<RestCueChannelOutcome>(
    "not_requested",
  );
  const lastRestCountdownCueRef = useRef<string | null>(null);
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
  const failedSetEntries = useMemo(
    () => sessionEntries.filter((entry) => entry.status === "needs_attention"),
    [sessionEntries],
  );
  useEffect(() => {
    const resolvedBlockerIds = new Set(
      sessionEntries.flatMap((entry) => {
        const blocker = entry.orderBlocker;
        if (!blocker) return [];
        const authoritative = props.occurrences.find(
          (occurrence) => occurrence.id === blocker.occurrenceId,
        );
        return authoritative && authoritative.outcome !== "pending"
          ? [blocker.occurrenceId]
          : [];
      }),
    );
    for (const blockerOccurrenceId of resolvedBlockerIds) {
      void releaseWorkoutSetOrderBlockersForOccurrence(
        blockerOccurrenceId,
      ).then((released) => {
        if (!released.ok) toast.error(released.reason);
      });
    }
  }, [props.occurrences, sessionEntries]);
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

  // A router refresh preserves this Client Component whenever the session-wide
  // history revision is unchanged. Reconcile occurrence rows by their own
  // monotonic revision so an acknowledgement in another tab, an equipment
  // refresh, or an order-conflict recovery cannot leave a stale local ledger
  // presenting a later set as actionable. Rows created locally by the append
  // action remain until the refreshed server payload includes them.
  useEffect(() => {
    const previousServerIds = serverOccurrenceIdsRef.current;
    const nextServerIds = new Set(
      props.occurrences.map((occurrence) => occurrence.id),
    );
    const reconcile = window.setTimeout(() => {
      setOccurrences((current) => reconcileServerOccurrences({
        current,
        server: props.occurrences,
        previousServerIds,
        pendingMutationOccurrenceIds: new Set(
          sessionOccurrenceEntries.map((entry) => entry.occurrenceId),
        ),
        acknowledgedOccurrenceIds: new Set(acknowledgedOccurrenceIds),
      }));
      serverOccurrenceIdsRef.current = nextServerIds;
    }, 0);
    return () => window.clearTimeout(reconcile);
  }, [
    acknowledgedOccurrenceIds,
    props.occurrences,
    sessionOccurrenceEntries,
  ]);

  useEffect(() => {
    const conflicts = failedSetEntries.filter(
      (entry) =>
        entry.orderBlocker != null ||
        entry.lastError?.toLowerCase().includes("earlier set") === true ||
        entry.lastError?.toLowerCase().includes("set order") === true ||
        entry.lastError?.toLowerCase().includes("workout order") === true,
    );
    if (conflicts.length === 0) return;
    let needsRefresh = false;
    for (const entry of conflicts) {
      if (requestedOrderConflictRefreshesRef.current.has(entry.clientKey)) {
        continue;
      }
      requestedOrderConflictRefreshesRef.current.add(entry.clientKey);
      needsRefresh = true;
    }
    if (needsRefresh) router.refresh();
  }, [failedSetEntries, router]);

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
        requestAnimationFrame(() => {
          const target = document.getElementById(targetId);
          if (!target) return;
          revealWorkoutTarget(target, activeWorkoutScrollBehavior());
          const focusTarget = firstVisibleFocusable(target);
          (focusTarget ?? target).focus({ preventScroll: true });
        });
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
  const locallyRecordedOccurrenceIds = new Set(
    sessionEntries.flatMap((entry) =>
      entry.occurrenceId ? [entry.occurrenceId] : []
    ),
  );
  const activeRestAction =
    guidance.currentAction?.kind === "rest" ? guidance.currentAction : null;
  const activeRestSource = activeRestAction?.source ?? null;
  const straightSetRestContinuation =
    activeRestAction?.restKind === "straight_set" && activeRestSource
      ? guidance.actions.find(
          (action) =>
            action.kind === "working_set" &&
            action.sessionExerciseId ===
              activeRestSource.sessionExerciseId &&
            action.sequenceIdx > activeRestSource.sequenceIdx &&
            action.truth === "pending" &&
            !locallyRecordedOccurrenceIds.has(action.occurrenceId),
        ) ?? null
      : null;
  const currentActionId = actionIdentity(guidance.currentAction);
  const currentActionKind = guidance.currentAction?.kind ?? null;
  const currentActionSequenceIdx = guidance.currentAction?.sequenceIdx ?? null;
  const currentActionSessionExerciseId =
    guidance.currentAction?.kind === "working_set"
      ? guidance.currentAction.sessionExerciseId
      : guidance.currentAction?.kind === "rest"
        ? straightSetRestContinuation?.sessionExerciseId ??
          guidance.current?.sessionExerciseId ?? null
        : null;
  const currentActionTargetId = actionTargetId(guidance.currentAction);
  const restingWorkingSetTargetId =
    currentActionKind === "rest"
      ? actionTargetId(straightSetRestContinuation ?? guidance.current)
      : null;
  useEffect(() => {
    if (
      currentActionKind !== "working_set" ||
      currentActionSessionExerciseId == null ||
      skipRecoveryExerciseId != null
    ) {
      return;
    }
    const disclosureGeneration = exerciseDisclosureGenerationRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (
        exerciseDisclosureGenerationRef.current !== disclosureGeneration
      ) return;
      setExpandedId(currentActionSessionExerciseId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    currentActionKind,
    currentActionSessionExerciseId,
    skipRecoveryExerciseId,
  ]);
  useEffect(() => {
    const disclosureGeneration = exerciseDisclosureGenerationRef.current;
    const previousActionId = previousCurrentActionIdRef.current;
    const previousActionSessionExerciseId =
      previousCurrentActionSessionExerciseIdRef.current;
    const linkedExerciseTarget = decodeURIComponent(
      window.location.hash.slice(1),
    );
    const explicitExerciseOwnsRestFocus =
      currentActionKind === "rest" &&
      linkedExerciseTarget.startsWith("exercise-") &&
      lastConsumedWorkoutHashRef.current === linkedExerciseTarget;
    if (skipRecoveryExerciseId != null) {
      previousCurrentActionIdRef.current = currentActionId;
      previousCurrentActionKindRef.current = currentActionKind;
      previousCurrentActionSessionExerciseIdRef.current =
        currentActionSessionExerciseId;
      return;
    }
    // A deliberate exercise deep link (including failed-set recovery) owns
    // focus while an already-running timer hydrates. The timer remains visible
    // and accurate, but must not replace the recovery target with its own hash.
    if (explicitExerciseOwnsRestFocus) {
      previousCurrentActionIdRef.current = currentActionId;
      previousCurrentActionKindRef.current = currentActionKind;
      previousCurrentActionSessionExerciseIdRef.current =
        currentActionSessionExerciseId;
      return;
    }
    const reconcileStaleHash = staleWorkoutActionHashRef.current;
    const reconcileInitialCurrentAction =
      previousActionId == null &&
      currentActionSessionExerciseId != null &&
      lastConsumedWorkoutHashRef.current == null;
    if (
      !reconcileStaleHash &&
      !reconcileInitialCurrentAction &&
      (previousActionId == null ||
        (previousActionId === currentActionId &&
          previousActionSessionExerciseId ===
            currentActionSessionExerciseId))
    ) {
      previousCurrentActionIdRef.current = currentActionId;
      previousCurrentActionKindRef.current = currentActionKind;
      previousCurrentActionSessionExerciseIdRef.current =
        currentActionSessionExerciseId;
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
      !restoredEarlierAction &&
      currentActionKind !== "rest"
    ) return;
    // Do not consume a transition until the previous occurrence is locally
    // acknowledged and the scheduled reveal/focus has actually run. A queue
    // or RSC reconciliation render can otherwise cancel the frame after this
    // effect has claimed the handoff, leaving the next card open but unfocused.
    let focusFrame = 0;
    let scrollFrame = 0;
    const revealCurrentAction = () => {
      if (
        exerciseDisclosureGenerationRef.current !== disclosureGeneration
      ) return;
      if (!reconcileInitialCurrentAction) {
        lastConsumedWorkoutHashRef.current = currentActionTargetId;
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}#${currentActionTargetId}`,
        );
      }
      if (currentActionSessionExerciseId) {
        setExpandedId(currentActionSessionExerciseId);
      }
      focusFrame = window.requestAnimationFrame(() => {
        if (
          exerciseDisclosureGenerationRef.current !== disclosureGeneration
        ) return;
        const target = document.getElementById(currentActionTargetId);
        const revealTarget = restingWorkingSetTargetId == null
          ? target
          : document.getElementById(restingWorkingSetTargetId);
        if (revealTarget) {
          revealWorkoutTarget(
            revealTarget,
            currentActionKind === "rest"
              ? "auto"
              : activeWorkoutScrollBehavior(),
          );
        }
        const focusTarget = target == null
          ? null
          : firstVisibleFocusable(target) ??
            (target.matches("[tabindex]") ? target : null);
        if (focusTarget instanceof HTMLElement) {
          focusTarget.focus({ preventScroll: true });
          previousCurrentActionIdRef.current = currentActionId;
          previousCurrentActionKindRef.current = currentActionKind;
          previousCurrentActionSessionExerciseIdRef.current =
            currentActionSessionExerciseId;
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
    occurrences,
    restingWorkingSetTargetId,
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
  const activeGroupMemberIds = useMemo(
    () => new Set(
      guidance.activeGroup?.members.map((member) => member.sessionExerciseId) ?? [],
    ),
    [guidance.activeGroup],
  );
  const firstActiveGroupMemberId =
    guidance.activeGroup?.members[0]?.sessionExerciseId ?? null;
  const activeGroupId = guidance.activeGroup?.groupId ?? null;
  const collapsedActiveGroupMemberIds = (() => {
    if (collapsedActiveGroupMemberState.groupId !== activeGroupId) {
      return new Set<string>();
    }
    const normalized = new Set(collapsedActiveGroupMemberState.ids);
    if (
      collapsedActiveGroupMemberState.currentActionSessionExerciseId !==
        currentActionSessionExerciseId &&
      currentActionSessionExerciseId != null
    ) {
      normalized.delete(currentActionSessionExerciseId);
    }
    return normalized;
  })();
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

  useEffect(() => {
    const wakeLock = (navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{
        released: boolean;
        release: () => Promise<void>;
        addEventListener: (type: "release", listener: () => void) => void;
        removeEventListener: (type: "release", listener: () => void) => void;
      }> };
    }).wakeLock;
    const controller = new ScreenWakeLockController(
      wakeLock?.request
        ? () => wakeLock.request("screen")
        : null,
      () => document.visibilityState === "visible",
    );
    controller.setActive(timer?.phase === "running");
    const reconcile = () => controller.reconcile();
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("pageshow", reconcile);
    window.addEventListener("focus", reconcile);
    return () => {
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("pageshow", reconcile);
      window.removeEventListener("focus", reconcile);
      void controller.dispose();
    };
  }, [timer?.generationId, timer?.phase]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const preference = readRestAlertPreference(window.localStorage);
      if (!requestedRestCueChannels(preference).sound) {
        setRestSoundState("not_requested");
        return;
      }
      if (timer?.phase !== "running") return;
      const audioWindow = window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      };
      if (!(audioWindow.AudioContext ?? audioWindow.webkitAudioContext)) {
        setRestSoundState("unavailable");
      } else if (audioContextRef.current == null) {
        // A restored timer has no owner gesture with which to unlock Web Audio.
        // The next set gesture can safely create and prime a fresh context.
        setRestSoundState("blocked");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [restAlertPreference, timer?.generationId, timer?.phase]);

  const advanceAfterExercise = useCallback(
    (exerciseId: string) => {
      const nextId = nextIncompleteExerciseId(shownExercises, exerciseId);
      setExpandedId(nextId);

      requestAnimationFrame(() => {
        const target = document.getElementById(
          nextId ? `exercise-${nextId}` : "finish-workout",
        );
        if (!target) return;
        revealWorkoutTarget(target, activeWorkoutScrollBehavior());
        (firstVisibleFocusable(target) ?? target).focus({ preventScroll: true });
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
          occurrence.id === detail.occurrenceId
            ? {
                ...occurrence,
                outcome: "completed",
                completedSetId: detail.setId,
                revision: detail.occurrenceRevision,
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
      void releaseWorkoutSetOrderBlockersForOccurrence(
        detail.occurrence.id,
      ).then((released) => {
        if (!released.ok) toast.error(released.reason);
      });
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
  const pendingPlannedOccurrences = occurrences.filter(
    (occurrence) =>
      occurrence.origin === "planned" && occurrence.outcome === "pending",
  ).length;
  const nonPerformedSummary = sessionNonPerformedOutcomeParts(
    guidance.totals,
  ).join(" · ");
  const warmupOccurrences = occurrences.filter(
    (occurrence) => occurrence.kind !== "working_set",
  );
  const remainingExercisePreparations = warmupOccurrences.filter(
    (occurrence) =>
      occurrence.kind === "exercise_warmup" && occurrence.outcome === "pending",
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
    // Unreadable recorded-work copies have no trustworthy session identity.
    // That uncertainty is exactly why Finish must wait for explicit review;
    // completing first could abandon the occurrence that the copy belongs to.
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
  const unresolvedExerciseSkip =
    skipRecoveryExerciseId != null &&
    (
      skipConfirmationExerciseId != null ||
      skipRecoverySettlementPending ||
      skipConfirmationError?.exerciseId === skipRecoveryExerciseId ||
      !exercises.some(
        (exercise) =>
          exercise.id === skipRecoveryExerciseId &&
          exercise.modificationType === "skipped",
      )
    );
  const finishBlocked =
    unresolvedExerciseSkip ||
    !appendRecoveryHydrated ||
    appendRecoveryMarker != null ||
    !finishRecoveryHydrated ||
    recordedEnqueueCount > 0 ||
    finishBlockedByRecordedWork(exitQueues);
  const equipmentGuidancePending = equipmentSyncPending(exitQueues);
  const foreignDeviceCopiesPending =
    outbox.entries.some(
      (entry) =>
        entry.ownerId !== props.ownerId || entry.sessionId !== props.sessionId,
    ) ||
    occurrenceOutbox.entries.some(
      (entry) =>
        entry.ownerId !== props.ownerId || entry.sessionId !== props.sessionId,
    );
  const unreadableRecordedCopiesPending =
    outbox.quarantined.length > 0 ||
    outbox.error != null ||
    occurrenceOutbox.error != null;
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

  async function returnFromUnconfirmedSkip(exercise: SessionExerciseData) {
    const marker = readSkipRecovery(window.sessionStorage, skipRecoveryKey);
    const reason = marker?.exerciseId === exercise.id
      ? marker.reason
      : skipRecoveryReason(exercise.skipReason);
    setSkipConfirmationExerciseId(exercise.id);
    setSkipConfirmationError((current) =>
      current?.exerciseId === exercise.id ? null : current,
    );
    try {
      const result = await withDocumentActionDeadline(
        confirmExerciseUnskipped({
          sessionExerciseId: exercise.id,
          expectedHistoryRevision: effectiveHistoryRevision,
        }),
      );
      if (!runnerActiveRef.current) return;
      if (!result.ok) {
        failSkipRecovery(
          exercise.id,
          reason,
          `${result.message} Repbook has kept this exercise paused so you can try again safely.`,
        );
        router.refresh();
        return;
      }
      setHistoryRevision(result.historyRevision);
    } catch (error) {
      if (!runnerActiveRef.current) return;
      if (isDocumentActionTimeout(error)) {
        reportDocumentActionTimeout();
      }
      failSkipRecovery(
        exercise.id,
        reason,
        isDocumentActionTimeout(error)
          ? "Repbook did not confirm the saved exercise state in time. Reload to reconcile the retained request safely."
          : "Repbook could not confirm the saved exercise state. The exercise remains paused so you can try again safely.",
      );
      return;
    }
    patchExercise(exercise.id, {
      modificationType: exercise.substitutedForExerciseId
        ? "substituted"
        : "as_planned",
      skipReason: null,
    });
    setOccurrences((current) => current.map((occurrence) =>
      occurrence.sessionExerciseId === exercise.id &&
      occurrence.outcome === "skipped" &&
      occurrence.outcomeReason?.startsWith("exercise:") &&
      !occurrence.outcomeReason.startsWith("exercise:substituted:")
        ? {
            ...occurrence,
            outcome: "pending",
            outcomeReason: null,
            revision: occurrence.revision + 1,
            resolvedAt: null,
          }
        : occurrence,
    ));
    clearSkipRecovery(exercise.id);
    router.refresh();
    window.requestAnimationFrame(revealCurrentWorkoutAction);
  }

  async function queueSet(
    exercise: SessionExerciseData,
    set: LoggedSet,
    restAfterSec: number | null | undefined = exercise.restSec,
    occurrence: SessionOccurrenceData | null = null,
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
    setRecordedEnqueueCount((count) => count + 1);
    try {
      const queued = await enqueueWorkoutSet({
        clientKey: set.clientKey,
        ownerId: props.ownerId,
        sessionId: props.sessionId,
        sessionExerciseId: exercise.id,
        ...(occurrence
          ? {
              occurrenceId: occurrence.id,
              expectedOccurrenceRevision: occurrence.revision,
            }
          : {}),
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
        equipmentSnapshotId: useSnapshot
          ? setup?.currentSnapshotId ?? null
          : null,
        equipmentSelectionClientKey: useSnapshot
          ? pendingEquipmentSelection?.clientKey ?? null
          : null,
        restAfterSec,
        loadEntryMeaning: useSnapshot
          ? decision.loadEntryMeaning
          : "legacy_unknown",
        observedCompletedAtISO,
        createdAtISO: observedCompletedAtISO,
      });
      if (!queued.ok) {
        toast.error(queued.reason);
        return false;
      }
      if (restAfterSec != null && restAfterSec > 0 && occurrence) {
        const optimisticTimer = createRestTimer({
          ownerId: props.ownerId,
          sessionId: props.sessionId,
          now: Date.parse(observedCompletedAtISO),
          seconds: restAfterSec,
          sourceSessionExerciseId: exercise.id,
          sourceOccurrenceId: occurrence.id,
          sourceClientKey: set.clientKey,
        });
        if (
          optimisticTimer == null ||
          !(await writeRestTimer(window.localStorage, optimisticTimer))
        ) {
          toast.error(
            "The set is retained on this device, but this rest timer could not be stored. Use a separate clock for this rest; the set will keep saving.",
          );
        }
      } else if (restAfterSec !== undefined && (!restAfterSec || restAfterSec <= 0)) {
        await clearRestTimerForIdentity(window.localStorage, {
          ownerId: props.ownerId,
          sessionId: props.sessionId,
        });
      }
      setExercises((current) =>
        current.map((candidate) =>
          candidate.id !== exercise.id ||
          candidate.sets.some((existing) => existing.clientKey === set.clientKey)
            ? candidate
            : { ...candidate, sets: [...candidate.sets, set] },
        ),
      );
      return true;
    } finally {
      setRecordedEnqueueCount((count) => Math.max(0, count - 1));
    }
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
    if (!entry) {
      toast.error("This device copy changed. Reopen recovery and try again.");
      return;
    }
    const removed = await discardWorkoutSetDeviceCopy(
      window.localStorage,
      entry,
    );
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
    if (!requestedRestCueChannels(preference).sound) {
      setRestSoundState("not_requested");
      return;
    }
    audioCueBlockedRef.current = false;
    try {
      const audioWindow = window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioContextConstructor =
        audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
      if (!AudioContextConstructor) {
        setRestSoundState("unavailable");
        return;
      }
      const context = prepareRestAudioContext(
        audioContextRef.current,
        AudioContextConstructor,
      );
      audioContextRef.current = context;
      if (context.state === "running") {
        setRestSoundState("requested");
      } else {
        void context.resume().then(() => {
          // Prime again after a successful WebKit resume. This matters when a
          // prior timer left the context suspended or interrupted.
          primeRestAudioContext(context);
          audioCueBlockedRef.current = false;
          setRestSoundState("requested");
        }).catch(() => {
          audioCueBlockedRef.current = true;
          setRestSoundState("blocked");
        });
      }
    } catch {
      audioCueBlockedRef.current = true;
      setRestSoundState("blocked");
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
    void transitionRestTimer(timer, continued);
  }, [timer, transitionRestTimer]);

  const requestRestCue = useCallback((
    milestone: RestCueMilestone,
    preference: RestAlertPreference,
  ) => {
    const channels = requestedRestCueChannels(preference);
    let soundRequested = false;
    let vibrationRequested = false;

    if (channels.sound) {
      const audioWindow = window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      };
      const audioSupported = Boolean(
        audioWindow.AudioContext ?? audioWindow.webkitAudioContext,
      );
      const context = audioContextRef.current;
      if (context?.state === "running") {
        try {
          if (milestone === "complete") {
            playRestTonePattern(context, REST_COMPLETION_TONE_PATTERN);
          } else {
            playRestTonePattern(
              context,
              milestone === "10"
                ? REST_COUNTDOWN_TICK_PATTERN
                : [
                    {
                      delaySec: 0,
                      frequencyHz: 660,
                      durationSec: 0.18,
                      peakGain: 0.24,
                      wave: "square",
                    },
                  ],
            );
          }
          soundRequested = true;
          audioCueBlockedRef.current = false;
          setRestSoundState("requested");
        } catch {
          soundRequested = false;
          setRestSoundState("blocked");
        }
      } else if (context == null) {
        setRestSoundState(restSoundChannelState({
          requested: true,
          audioSupported,
          contextState: null,
        }));
      } else {
        setRestSoundState("blocked");
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
        (audioCueBlockedRef.current || (Boolean(
          (window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }).AudioContext ??
          (window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }).webkitAudioContext,
        ) && !soundRequested) ||
          (audioContextRef.current != null &&
            audioContextRef.current.state !== "running" &&
            audioContextRef.current.state !== "closed")),
    });
  }, []);

  useEffect(() => {
    const resumeAudio = () => {
      if (document.visibilityState !== "visible") return;
      const context = audioContextRef.current;
      if (context?.state === "closed") {
        setRestSoundState("blocked");
      } else if (
        context != null &&
        (context.state === "suspended" ||
          (context.state as string) === "interrupted")
      ) {
        void context.resume().then(() => {
          primeRestAudioContext(context);
          audioCueBlockedRef.current = false;
          setRestSoundState("requested");
        }).catch(() => {
          audioCueBlockedRef.current = true;
          setRestSoundState("blocked");
        });
      }
    };
    document.addEventListener("visibilitychange", resumeAudio);
    window.addEventListener("pageshow", resumeAudio);
    window.addEventListener("focus", resumeAudio);
    return () => {
      document.removeEventListener("visibilitychange", resumeAudio);
      window.removeEventListener("pageshow", resumeAudio);
      window.removeEventListener("focus", resumeAudio);
    };
  }, []);

  useEffect(() => {
    if (
      !timer ||
      timer.phase !== "ready" ||
      timer.completionContext !== "while_away" ||
      timer.completionCueOutcome?.completion !== "missed_while_away" ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const preference = readRestAlertPreference(window.localStorage);
    void (async () => {
      const context = audioContextRef.current;
      if (context?.state === "suspended") {
        await context.resume().catch(() => {
          audioCueBlockedRef.current = true;
        });
      }
      const result = await deliverMissedRestCompletionCue(
        window.localStorage,
        { ownerId: props.ownerId, sessionId: props.sessionId },
        timer.generationId,
        () => requestRestCue("complete", preference),
      );
      if (result.timer) setTimer(result.timer);
    })();
  }, [
    props.ownerId,
    props.sessionId,
    requestRestCue,
    timer,
  ]);

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
      const countdownCueKey = restCountdownCueKey({
        generationId: timer.generationId,
        remainingSec: currentRemainingSec,
        previousCueKey: lastRestCountdownCueRef.current,
        preference,
        foreground,
        tenSecondMilestoneDue: plan.milestonesToAttempt.includes("10"),
      });
      try {
        if (countdownCueKey != null) {
          const context = audioContextRef.current;
          if (context?.state === "running") {
            try {
              playRestTonePattern(context, REST_COUNTDOWN_TICK_PATTERN);
              lastRestCountdownCueRef.current = countdownCueKey;
              audioCueBlockedRef.current = false;
            } catch {
              // The visual countdown remains authoritative if audio fails.
            }
          }
        }
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
    const onFocus = () => void tick(document.visibilityState === "visible");
    const interval = window.setInterval(() => void tick(), 250);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    void tick();
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
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
      toast.error(
        skipConfirmationExerciseId != null
          ? "Wait while Repbook confirms the exercise skip before finishing."
          : skipRecoveryExerciseId != null
            ? "Resolve the exercise skip before finishing."
            : appendRecoveryMarker != null
              ? "Reload or wait while Repbook confirms the extra set before finishing."
          : "Retry save or discard the current workout's device copies below before finishing.",
      );
      return;
    }
    if (
      finishRecoveryCommand != null &&
      deploymentRecoveryRequired()
    ) {
      setFinishError(
        "Reload Repbook to retry the retained finish request safely.",
      );
      return;
    }
    if (
      finishRecoveryCommand == null &&
      (!durationReviewReady || effectiveDurationChoice == null)
    ) {
      setFinishError(
        timing.reviewRequired
          ? "Choose a defensible active time or explicitly keep it unknown."
          : "Review the workout timing before saving.",
      );
      return;
    }
    if (
      finishRecoveryCommand == null &&
      pendingPlannedOccurrences > 0 &&
      completionReason == null
    ) {
      setFinishError(
        "Choose why the remaining planned work was not completed. Repbook will preserve that reason without inferring it from elapsed time.",
      );
      return;
    }
    const command: FinishRecoveryCommand = finishRecoveryCommand ?? {
      version: 2,
      sessionId: props.sessionId,
      ...(finishNote ? { note: finishNote } : {}),
      ...(fatigue == null ? {} : { fatigue }),
      ...(pendingPlannedOccurrences > 0 && completionReason != null
        ? { completionReason }
        : {}),
      durationDecision:
        effectiveDurationChoice === "owner_reported"
          ? {
              basis: "owner_reported",
              activeDurationSeconds: ownerReportedSeconds!,
            }
          : { basis: effectiveDurationChoice! },
    };
    setFinishing(true);
    setFinishError(null);
    try {
      const completion = await withOutboxLock(() =>
        withOccurrenceMutationOutboxLock(async () => {
          const latestSetQueue = getWorkoutSetOutboxSnapshot();
          const latestOccurrenceQueue = getOccurrenceMutationOutboxSnapshot();
          const freshExitQueues: WorkoutExitQueues = {
            ...exitQueues,
            unsyncedSetCount: latestSetQueue.entries.filter(
              (entry) =>
                entry.ownerId === props.ownerId &&
                entry.sessionId === props.sessionId,
            ).length,
            quarantinedSetCount: latestSetQueue.quarantined.length,
            setHasError: latestSetQueue.error != null,
            unsyncedOccurrenceCount: latestOccurrenceQueue.entries.filter(
              (entry) =>
                entry.ownerId === props.ownerId &&
                entry.sessionId === props.sessionId,
            ).length,
            occurrenceHasError: latestOccurrenceQueue.error != null,
          };
          if (finishBlockedByRecordedWork(freshExitQueues)) {
            return { blocked: true as const, result: null };
          }
          if (
            !writeFinishRecovery(
              window.localStorage,
              finishRecoveryKey,
              command,
            )
          ) {
            throw new Error("finish_recovery_storage_unavailable");
          }
          setFinishRecoveryCommand(command);
          removeFinishRecovery(window.localStorage, legacyFinishRecoveryKey);
          await clearMatchingRestTimer();
          const { version: _recoveryVersion, ...completionInput } = command;
          void _recoveryVersion;
          const result = await withDocumentActionDeadline(
            completeSession(completionInput),
          );
          return { blocked: false as const, result };
        }),
      );
      if (completion.blocked) {
        setFinishError(
          "A recorded workout change entered the device queue. Review it before finishing.",
        );
        setFinishing(false);
        return;
      }
      const result = completion.result;
      if (result?.ok === false) {
        setFinishConflictDetected(result.code === "finish_payload_conflict");
        if (result.code !== "finish_payload_conflict") {
          removeFinishRecovery(window.localStorage, finishRecoveryKey);
          removeFinishRecovery(window.localStorage, legacyFinishRecoveryKey);
          setFinishRecoveryCommand(null);
        }
        setFinishError(result.message);
        setFinishing(false);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "finish_recovery_storage_unavailable"
      ) {
        setFinishError(
          "Repbook cannot safely retain this finish request on your device, so nothing was sent. Free device storage or reload, then try again.",
        );
        setFinishing(false);
        return;
      }
      if (isDocumentActionTimeout(error)) {
        reportDocumentActionTimeout();
        setFinishError(
          "Repbook did not confirm the workout finish in time. Your exact finish details are retained. Reload to retry safely.",
        );
        setFinishing(false);
        return;
      }
      if (reportDeploymentMismatch(error)) {
        setFinishError(
          "Repbook was updated. Your exact finish details are retained on this device. Reload once, then finish again.",
        );
        setFinishing(false);
        return;
      }
      setFinishError(
        "Repbook could not confirm the workout finish. Your exact finish details are retained; try Save workout again or reload.",
      );
      setFinishing(false);
    }
  }

  async function applyOccurrenceMutation(
    occurrence: SessionOccurrenceData,
    operation: OccurrenceMutationOperation,
    input: {
      reason?: string | null;
      reasonCode?: IncompleteSessionReason | null;
      note?: string | null;
    } = {},
  ) {
    if (equipmentConfirmationBlocks(occurrence)) {
      toast.error("Wait for this exercise's equipment setup to be confirmed first.");
      return false;
    }
    const reason = input.reason?.trim() || null;
    const reasonCode = input.reasonCode ?? null;
    const note = input.note?.trim() || null;
    const existing = sessionOccurrenceEntries.find(
      (entry) => entry.occurrenceId === occurrence.id,
    );
    if (
      existing &&
      existing.expectedRevision === occurrence.revision &&
      existing.operation === operation &&
      existing.reason === reason &&
      (existing.reasonCode ?? null) === reasonCode &&
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
    setRecordedEnqueueCount((count) => count + 1);
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
        reasonCode,
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
      setRecordedEnqueueCount((count) => Math.max(0, count - 1));
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

  const handleAppendSet = useCallback(async (
    sessionExerciseId: string,
    occurrenceId: string,
    expectedSetNo: number,
  ) => {
    const retained = readAppendSetRecovery(
      window.localStorage,
      appendRecoveryKey,
    );
    if (retained != null && deploymentRecoveryRequired()) {
      setAppendRecoveryMarker(retained);
      toast.error("Reload Repbook to retry the retained extra set safely.");
      return null;
    }
    if (
      retained != null &&
      (retained.sessionExerciseId !== sessionExerciseId ||
        retained.expectedSetNo !== expectedSetNo)
    ) {
      setAppendRecoveryMarker(retained);
      toast.error(
        "Another extra set still needs confirmation. Reload to retry that exact set safely.",
      );
      return null;
    }
    const command: AppendSetRecoveryMarker = retained ?? {
      sessionExerciseId,
      occurrenceId,
      expectedSetNo,
    };
    if (
      retained == null &&
      !writeAppendSetRecovery(
        window.localStorage,
        appendRecoveryKey,
        command,
      )
    ) {
      toast.error(
        "This browser could not retain the extra-set request. Nothing was sent.",
      );
      return null;
    }
    setAppendRecoveryMarker(command);
    try {
      const result = await withDocumentActionDeadline(
        appendWorkoutSet(command),
      );
      if (!result.ok) {
        removeAppendSetRecovery(
          window.localStorage,
          appendRecoveryKey,
          command.occurrenceId,
        );
        setAppendRecoveryMarker(null);
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
      removeAppendSetRecovery(
        window.localStorage,
        appendRecoveryKey,
        command.occurrenceId,
      );
      setAppendRecoveryMarker(null);
      return appended;
    } catch (error) {
      if (isDocumentActionTimeout(error)) {
        reportDocumentActionTimeout();
        toast.error(
          "Repbook did not confirm the extra set in time. Reload to retry the exact request safely.",
        );
      } else {
        toast.error(
          "Repbook could not confirm the extra set. Try Add extra set again to replay the exact request, or reload.",
        );
      }
      return null;
    }
  }, [appendRecoveryKey]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const retained = readAppendSetRecovery(
        window.localStorage,
        appendRecoveryKey,
      );
      setAppendRecoveryHydrated(true);
      if (retained == null) return;
      setAppendRecoveryMarker(retained);
      if (
        occurrences.some(
          (occurrence) => occurrence.id === retained.occurrenceId,
        )
      ) {
        removeAppendSetRecovery(
          window.localStorage,
          appendRecoveryKey,
          retained.occurrenceId,
        );
        setAppendRecoveryMarker(null);
        return;
      }
      if (
        !exercises.some(
          (exercise) => exercise.id === retained.sessionExerciseId,
        )
      ) {
        removeAppendSetRecovery(
          window.localStorage,
          appendRecoveryKey,
          retained.occurrenceId,
        );
        setAppendRecoveryMarker(null);
        return;
      }
      void handleAppendSet(
        retained.sessionExerciseId,
        retained.occurrenceId,
        retained.expectedSetNo,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [appendRecoveryKey, exercises, handleAppendSet, occurrences]);

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
  const retainedFailuresForCurrentExercise = currentActionExercise == null
    ? []
    : failedSetEntries.filter(
        (entry) => entry.sessionExerciseId === currentActionExercise.id,
      );
  const allowLogWithRetainedFailure =
    currentActionOccurrence?.kind === "working_set" &&
    retainedFailuresForCurrentExercise.length > 0 &&
    retainedFailuresForCurrentExercise.every(
      (entry) =>
        entry.reviewRequired == null &&
        entry.orderBlocker?.occurrenceId === currentActionOccurrence.id,
    );
  function nextPendingOccurrenceForExercise(exerciseId: string) {
    return occurrences.find(
      (occurrence) =>
        occurrence.sessionExerciseId === exerciseId &&
        occurrence.kind === "working_set" &&
        occurrence.outcome === "pending" &&
        !locallyRecordedOccurrenceIds.has(occurrence.id),
    ) ?? null;
  }

  function nextLoggableOccurrenceForExercise(exerciseId: string) {
    const occurrence = nextPendingOccurrenceForExercise(exerciseId);
    return occurrence &&
      workingSetOccurrenceOrderIsEligible(
        occurrence,
        occurrences,
        locallyRecordedOccurrenceIds,
      )
      ? occurrence
      : null;
  }

  function revealExerciseCard(exerciseId: string) {
    setExpandedId(exerciseId);
    if (!activeGroupMemberIds.has(exerciseId)) return;
    setCollapsedActiveGroupMemberState((current) => {
      const ids = current.groupId === activeGroupId
        ? new Set(current.ids)
        : new Set<string>();
      if (
        current.currentActionSessionExerciseId !==
          currentActionSessionExerciseId &&
        currentActionSessionExerciseId != null
      ) {
        ids.delete(currentActionSessionExerciseId);
      }
      ids.delete(exerciseId);
      return {
        groupId: activeGroupId,
        currentActionSessionExerciseId,
        ids,
      };
    });
  }

  function revealCurrentWorkoutAction() {
    const currentAction = guidance.currentAction;
    if (!currentAction) return;
    const targetId = actionTargetId(currentAction);
    const occurrenceAction = currentAction.kind === "rest"
      ? currentAction.source
      : currentAction;
    if (occurrenceAction?.kind === "working_set") {
      revealExerciseCard(occurrenceAction.sessionExerciseId);
    }
    setFinishOpen(false);
    lastConsumedWorkoutHashRef.current = targetId;
    staleWorkoutActionHashRef.current = false;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}#${targetId}`,
    );
    requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (target) {
        revealWorkoutTarget(target, activeWorkoutScrollBehavior());
      }
    });
  }

  function revealSkippedExerciseRecovery() {
    if (skipRecoveryExerciseId == null) return;
    const targetId = `skip-recovery-description-${skipRecoveryExerciseId}`;
    setFinishOpen(false);
    setExpandedId(skipRecoveryExerciseId);
    requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (!target) return;
      revealWorkoutTarget(target, activeWorkoutScrollBehavior());
      const focusTarget = firstVisibleFocusable(target.parentElement ?? target);
      (focusTarget ?? target).focus({ preventScroll: true });
    });
  }

  function revealUnsavedSet(entry: WorkoutSetOutboxEntry) {
    const targetId = `exercise-${entry.sessionExerciseId}`;
    setFinishOpen(false);
    revealExerciseCard(entry.sessionExerciseId);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}#${targetId}`,
    );
    requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (!target) return;
      revealWorkoutTarget(target, activeWorkoutScrollBehavior());
      const focusTarget = target.querySelector<HTMLElement>(
        "button, [href], input",
      );
      focusTarget?.focus({ preventScroll: true });
    });
  }

  function revealOrderBlocker(targetId: string) {
    const blocker = occurrences.find((occurrence) => {
      if (occurrence.kind !== "working_set") {
        return targetId === `warmup-occurrence-${occurrence.id}`;
      }
      if (!occurrence.sessionExerciseId) return false;
      const position = workingSetDisplayPosition(occurrence, occurrences);
      const prefix = position.kind === "extra" ? "added-set-entry" : "set-entry";
      return `${prefix}-${occurrence.sessionExerciseId}-${occurrence.id}` === targetId;
    });
    if (blocker?.kind === "working_set" && blocker.sessionExerciseId) {
      revealExerciseCard(blocker.sessionExerciseId);
    } else if (blocker) {
      setWarmupPlanOpen(true);
    }
    setFinishOpen(false);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}#${targetId}`,
    );
    window.requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (!target) return;
      revealWorkoutTarget(target, activeWorkoutScrollBehavior());
      const focusTarget = firstVisibleFocusable(target);
      (focusTarget ?? target).focus({ preventScroll: true });
    });
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
    !shownExercises.some((exercise) =>
      exercise.sets.some(
        (set) => set.saveState != null && set.saveState !== "saved",
      )
    );
  const hasAcknowledgedWork = occurrences.some(
    (occurrence) =>
      occurrence.outcome === "completed" ||
      occurrence.outcome === "skipped" ||
      occurrence.outcome === "abandoned",
  );
  const hasWorkoutFlowStarted = hasAcknowledgedWork ||
    sessionEntries.length > 0 ||
    sessionOccurrenceEntries.some(
      (entry) => entry.operation === "complete" || entry.operation === "skip",
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
        ? hasWorkoutFlowStarted
          ? "Go to current exercise"
          : "Go to first exercise"
        : guidance.currentAction
          ? "Go to warm-up"
          : "Go to finish workout";
  const setOrderBlockers = useMemo(() => {
    const blockers: Record<string, SetOrderBlocker> = {};
    for (const entry of failedSetEntries) {
      const blocker = entry.orderBlocker;
      if (!blocker) continue;
      blockers[entry.clientKey] = {
        blockerOccurrenceId: blocker.occurrenceId,
        blockerLabel: blocker.kind === "day_warmup"
          ? "Warm-up"
          : blocker.kind === "exercise_warmup"
            ? "Preparation set"
            : blocker.isAddedSet
            ? "Added set"
            : blocker.groupRound == null
              ? `Set ${blocker.setNo}`
              : `Round ${blocker.groupRound} · Set ${blocker.setNo}`,
        blockerExerciseName: blocker.exerciseName,
        blockerTargetId:
          workoutSetOrderBlockerTargetId(blocker) ?? undefined,
      };
    }
    return blockers;
  }, [failedSetEntries]);
  const setReviewRequired = useMemo(
    () => Object.fromEntries(
      failedSetEntries
        .filter((entry) => entry.reviewRequired === "stale_occurrence")
        .map((entry) => [entry.clientKey, true]),
    ),
    [failedSetEntries],
  );
  const currentActionIsWorkingSet =
    guidance.currentAction?.kind === "working_set";
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
          revealWorkoutTarget(target, activeWorkoutScrollBehavior());
          const pendingWarmupControl = preparationWarmupAction
            ? target.querySelector<HTMLElement>(
                '[role="checkbox"][aria-checked="false"]',
              )
            : null;
          const focusTarget = pendingWarmupControl ??
            firstVisibleFocusable(target) ??
            (target.matches("[tabindex]") ? target : null);
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
      <p
        data-testid="set-save-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {latestSetAcknowledgement
          ? `${latestSetAcknowledgement.exerciseName}, set ${latestSetAcknowledgement.set.setNo} saved.`
          : ""}
      </p>
      <header className="flex flex-wrap items-center justify-between gap-2 px-1">
        <a
          href="/today"
          aria-label="Back to Today"
          className={buttonVariants({
            variant: "outline",
            size: "sm",
            className: "min-h-11 min-w-11 p-0 min-[361px]:hidden",
          })}
        >
          <ArrowLeft aria-hidden="true" className="size-5" />
        </a>
        <div className="min-w-0 max-[360px]:w-full">
          <h1 className="text-lg font-semibold max-[360px]:sr-only">
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
        <div className="ml-auto flex items-center gap-1 max-[360px]:hidden">
          <a
            href="/today"
            className={buttonVariants({
              variant: "outline",
              size: "sm",
              className: "min-h-11 lg:hidden",
            })}
          >
            Back to Today
          </a>
          <div className="max-[360px]:hidden">
            <WorkoutMeasurementsDrawer />
          </div>
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

      {(hasStructuredWarmup || Boolean(props.dayWarmupNotes?.trim())) && (
      <WarmupPanel
        completed={guidance.warmups.completed}
        skipped={guidance.warmups.skipped}
        planned={guidance.warmups.planned}
        remaining={guidance.warmups.remaining}
      >
        {props.dayWarmupNotes ? (
          <details className="order-3 mt-2 rounded-md border border-violet-300/50 bg-background/60 text-sm">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-md px-3 py-2 font-medium text-violet-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:text-violet-200">
              <span>Day guidance · reference only</span>
              <span className="text-xs text-muted-foreground">Show</span>
            </summary>
            <p className="whitespace-pre-line border-t px-3 py-2 leading-6 text-muted-foreground">
              {props.dayWarmupNotes}
            </p>
          </details>
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
            <div className="order-2 mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-violet-800 dark:text-violet-200">
                {guidance.currentAction?.kind === "day_warmup" ||
                guidance.currentAction?.kind === "exercise_warmup"
                  ? "Complete the current warm-up action below."
                  : "Warm-up actions are accounted for."}
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-11"
                aria-expanded={warmupPlanOpen}
                aria-controls="workout-warmup-plan"
                onClick={() => setWarmupPlanOpen((open) => !open)}
              >
                {warmupPlanOpen ? "Hide full plan" : "Review full plan"}
              </Button>
            </div>
            {remainingExercisePreparations.length > 0 && (
              <p
                data-testid="remaining-exercise-preparations"
                className="order-2 mt-2 rounded-md border border-violet-300/40 bg-background/60 px-3 py-2 text-xs leading-5 text-violet-900 dark:text-violet-100"
              >
                Preparation sets still scheduled: {remainingExercisePreparations
                  .map((occurrence) =>
                    plannedExerciseNameForOccurrence(occurrence) ?? "Exercise",
                  )
                  .filter((name, index, names) => names.indexOf(name) === index)
                  .join(", ")}.
              </p>
            )}
            {guidance.warmups.completed > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="order-2 mt-2 min-h-11 w-full justify-between"
                aria-expanded={completedWarmupsOpen}
                aria-controls="workout-warmup-plan"
                onClick={() => setCompletedWarmupsOpen((open) => !open)}
              >
                <span>
                  Completed warm-ups · {guidance.warmups.completed}
                </span>
                <span className="text-xs text-muted-foreground">
                  {completedWarmupsOpen ? "Hide" : "Show"}
                </span>
              </Button>
            )}
            <ul id="workout-warmup-plan" className="order-1 mt-2 space-y-2">
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
                  const overtakenByWorkingSet =
                    occurrences.some(
                      (candidate) =>
                        candidate.kind === "working_set" &&
                        candidate.sequenceIdx > occurrence.sequenceIdx &&
                        (candidate.outcome === "completed" ||
                          locallyRecordedOccurrenceIds.has(candidate.id)) &&
                        (occurrence.kind === "day_warmup" ||
                          (occurrence.kind === "exercise_warmup" &&
                            candidate.sessionExerciseId ===
                              occurrence.sessionExerciseId)),
                    );
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
                      className={cn(
                        "scroll-mt-40 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background/80 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        !warmupPlanOpen &&
                          actionOccurrenceId(guidance.currentAction) !== occurrence.id &&
                          occurrenceMutation == null &&
                          !(
                            completedWarmupsOpen &&
                            occurrence.outcome === "completed"
                          ) &&
                          "hidden",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          {occurrence.kind === "exercise_warmup" && exerciseName
                            ? `${exerciseName} — Preparation set`
                            : occurrence.label ?? "Warm-up item"}
                        </p>
                        {occurrence.kind === "exercise_warmup" && (
                          <p className="text-xs text-muted-foreground">
                            {occurrence.label ?? "Exercise-specific preparation"}
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
                        {occurrence.outcome === "pending" &&
                          overtakenByWorkingSet && (
                          <p className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-950 dark:text-amber-100">
                            A later working set is already recorded. Resolve this
                            preparation set now; Repbook will not move a rest
                            timer backwards to it.
                          </p>
                        )}
                      </div>
                      {occurrence.outcome === "pending" ? (
                        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
                          <Button
                            type="button"
                            size="sm"
                            className="h-auto min-h-[44px] min-w-0 w-full whitespace-normal px-1.5 py-1 text-center leading-tight sm:w-auto sm:px-2.5"
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
                            className="h-auto min-h-[44px] min-w-0 w-full whitespace-normal px-1.5 py-1 text-center leading-tight sm:w-auto sm:px-2.5"
                            variant="secondary"
                            disabled={
                              equipmentChangePending ||
                              occurrenceMutation != null
                            }
                            onClick={() => void applyOccurrenceMutation(
                              occurrence,
                              "skip",
                              {
                                reason: "Skip due to time",
                                reasonCode: "time_limit_reached",
                              },
                            )}
                          >
                            Skip due to time
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-auto min-h-[44px] min-w-0 w-full whitespace-normal px-1.5 py-1 text-center leading-tight sm:w-auto sm:px-2.5"
                            variant="ghost"
                            aria-label="Other skip reason"
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
                            Other
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-auto min-h-[44px] min-w-0 w-full whitespace-normal px-1.5 py-1 text-center leading-tight sm:w-auto sm:px-2.5"
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
                                  disabled={
                                    occurrenceMutation != null ||
                                    overtakenByWorkingSet
                                  }
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
                              disabled={
                                occurrenceMutation != null ||
                                overtakenByWorkingSet
                              }
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
                          {!aggregateRestoreBlocked &&
                            overtakenByWorkingSet && (
                              <p className="basis-full text-xs text-muted-foreground">
                                A later working set is already recorded, so this
                                earlier warm-up cannot be restored.
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
      )}

      {!currentActionIsWorkingSet && <SessionPreparationPanel
        projection={sessionPreparation}
        hasAcknowledgedWork={hasWorkoutFlowStarted}
        continueTargetId={preparationTargetId}
        continueLabel={preparationContinueLabel}
        onContinue={continueFromPreparation}
      />}

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
            !exercise.sets.some(
              (set) => set.saveState == null || set.saveState === "saved",
            ) &&
            (equipmentSetupIsCurrent ||
              equipmentSetupNeedsAttention ||
              !equipmentSetupMatches);
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
          <div
            key={exercise.id}
            data-active-superset-member={
              activeGroupMemberIds.has(exercise.id) ? "true" : undefined
            }
            className={cn(
              "flex flex-col gap-2",
              activeGroupMemberIds.has(exercise.id) &&
                "rounded-xl bg-violet-100/60 p-1.5 ring-2 ring-violet-400/60 dark:bg-violet-950/25",
            )}
          >
          {firstActiveGroupMemberId === exercise.id &&
          guidance.activeGroup ? (
            <WorkoutGroupContext guidance={guidance} />
          ) : null}
          {equipmentPanel ? (
            <details
              data-testid="exercise-equipment-setup"
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
            historyRevision={effectiveHistoryRevision}
            progress={
              guidance.exercises.find(
                (item) => item.sessionExerciseId === exercise.id,
              )!
            }
            expanded={
              skipRecoveryExerciseId != null
                ? skipRecoveryExerciseId === exercise.id
                : activeGroupMemberIds.has(exercise.id)
                  ? !collapsedActiveGroupMemberIds.has(exercise.id)
                  : expandedId === exercise.id
            }
            onToggle={() => {
              if (skipRecoveryExerciseId != null) {
                setExpandedId(skipRecoveryExerciseId);
                return;
              }
              if (activeGroupMemberIds.has(exercise.id)) {
                setCollapsedActiveGroupMemberState((current) => {
                  const next = current.groupId === activeGroupId
                    ? new Set(current.ids)
                    : new Set<string>();
                  if (
                    current.currentActionSessionExerciseId !==
                      currentActionSessionExerciseId &&
                    currentActionSessionExerciseId != null
                  ) {
                    next.delete(currentActionSessionExerciseId);
                  }
                  if (next.has(exercise.id)) next.delete(exercise.id);
                  else next.add(exercise.id);
                  return {
                    groupId: activeGroupId,
                    currentActionSessionExerciseId,
                    ids: next,
                  };
                });
                return;
              }
              exerciseDisclosureGenerationRef.current += 1;
              // An explicit disclosure choice owns this handoff. Consume any
              // queued automatic reveal so later reconciliation cannot undo
              // the owner's newer choice.
              previousCurrentActionIdRef.current = currentActionId;
              previousCurrentActionKindRef.current = currentActionKind;
              previousCurrentActionSessionExerciseIdRef.current =
                currentActionSessionExerciseId;
              setExpandedId(expandedId === exercise.id ? null : exercise.id);
            }}
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
            activeOccurrence={
              nextLoggableOccurrenceForExercise(exercise.id)
            }
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
              if (!runnerActiveRef.current) return;
              patchExercise(exercise.id, patch);
              const exerciseIdentityChanged = Object.hasOwn(
                patch,
                "exerciseId",
              );
              if (patch.modificationType === "skipped") {
                writeSkipRecovery(
                  window.sessionStorage,
                  skipRecoveryKey,
                  {
                    exerciseId: exercise.id,
                    pageTimeOrigin: window.performance.timeOrigin,
                    runnerInstanceId: skipRecoveryRunnerInstanceId,
                    reason: skipRecoveryReason(patch.skipReason),
                    phase: "pending",
                    expectedHistoryRevision: effectiveHistoryRevision,
                  },
                );
                setSkipConfirmationExerciseId(null);
                setSkipConfirmationError((current) =>
                  current?.exerciseId === exercise.id ? null : current,
                );
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
                clearSkipRecovery(exercise.id);
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
                clearSkipRecovery(exercise.id);
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
                  ? restTimerSecondsAfterQueuedSet({
                      plannedRestSeconds:
                        guidance.actions.find(
                          (action) => action.occurrenceId === occurrence.id,
                        )?.restAfter.seconds ?? null,
                      pendingActionCount:
                        guidance.completion.pendingActions,
                    })
                  : exercise.restSec,
                occurrence,
              )
            }
            onAppendSet={(occurrenceId, expectedSetNo) =>
              handleAppendSet(exercise.id, occurrenceId, expectedSetNo)
            }
            onSkipSet={async ({ reason, reasonCode, note }, requestedOccurrence) => {
              const occurrence =
                requestedOccurrence ??
                nextPendingOccurrenceForExercise(exercise.id);
              if (!occurrence) {
                return false;
              }
              const skipped = await applyOccurrenceMutation(
                occurrence,
                "skip",
                { reason, reasonCode, note },
              );
              if (skipped) toast.info("Set skip is saving.");
              return skipped;
            }}
            onRetryOccurrenceMutation={retryOccurrenceEntry}
            onDiscardOccurrenceMutation={discardOccurrenceEntry}
            onRetrySet={retrySet}
            onDiscardSet={discardSet}
            setOrderBlockers={setOrderBlockers}
            setReviewRequired={setReviewRequired}
            onRevealBlocker={revealOrderBlocker}
            onRefreshWorkout={() => router.refresh()}
            onHistoryRevisionChange={setHistoryRevision}
            onOpenCoach={() => openCoach(exercise.id)}
            onSkipRequestStart={(reason) => {
              skipUnconfirmedRef.current.delete(exercise.id);
              const pageTimeOrigin = window.performance.timeOrigin;
              skipRequestRunnerInstanceRef.current[exercise.id] =
                skipRecoveryRunnerInstanceId;
              writeSkipRecovery(
                window.sessionStorage,
                skipRecoveryKey,
                {
                  exerciseId: exercise.id,
                  pageTimeOrigin,
                  runnerInstanceId: skipRecoveryRunnerInstanceId,
                  reason,
                  phase: "pending",
                  expectedHistoryRevision: effectiveHistoryRevision,
                },
              );
              setSkipRecoveryExerciseId(exercise.id);
              setSkipConfirmationExerciseId(exercise.id);
              setSkipConfirmationError((current) =>
                current?.exerciseId === exercise.id ? null : current,
              );
              setExpandedId(exercise.id);
            }}
            onSkipRequestFailure={(reason, code) => {
              if (
                pageUnloadingRef.current ||
                !runnerActiveRef.current ||
                skipRequestRunnerInstanceRef.current[exercise.id] !==
                  skipRecoveryRunnerInstanceId
              ) {
                return false;
              }
              failSkipRecovery(
                exercise.id,
                reason,
                `Repbook did not confirm the ${skipRecoveryReasonLabel(reason)} skip. Review the exercise, then try again or return to the current set.`,
              );
              if (code === "skip_stale") router.refresh();
              return true;
            }}
            skipConfirmationPending={
              skipConfirmationExerciseId === exercise.id
            }
            skipRecoverySettlementPending={
              skipRecoverySettlementPending &&
              skipRecoveryExerciseId === exercise.id
            }
            skipConfirmationError={
              skipConfirmationError?.exerciseId === exercise.id
                ? skipConfirmationError.message
                : null
            }
            onSkipConfirmationErrorDismiss={() =>
              returnFromUnconfirmedSkip(exercise)
            }
            onSkipComplete={() => {
              clearSkipRecovery(exercise.id);
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
          {currentActionIsWorkingSet &&
          currentOccurrence?.sessionExerciseId === exercise.id ? (
            <SessionPreparationPanel
              projection={sessionPreparation}
              hasAcknowledgedWork={hasWorkoutFlowStarted}
              continueTargetId={preparationTargetId}
              continueLabel={preparationContinueLabel}
              onContinue={continueFromPreparation}
            />
          ) : null}
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
          <CheckCircle2 className="size-4" /> {pendingPlannedOccurrences > 0
            ? "Finish early"
            : "Finish workout"}
        </Button>
      </section>

      <Drawer open={finishOpen} onOpenChange={setFinishOpen}>
        <DrawerContent className="m-0 [--drawer-content-height:100dvh] [--drawer-content-max-height:100dvh] [border-radius:0] [&_button]:min-h-11 [&_button]:min-w-11 [&_textarea]:min-h-11">
          <DrawerHeader className="border-b pb-3 pt-[max(1rem,env(safe-area-inset-top))] text-left">
            <div className="flex items-start gap-3">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={() => setFinishOpen(false)}
                aria-label="Back to workout"
              >
                <ArrowLeft className="size-5" />
              </Button>
              <div className="min-w-0">
                <DrawerTitle className="text-lg">Finish workout</DrawerTitle>
                <DrawerDescription className="mt-1 text-left">
                  {plannedPerformed} of {totalPlanned} planned sets done. Wall clock {elapsed}.
                  {extraPerformed > 0
                    ? ` ${extraPerformed} extra set${extraPerformed === 1 ? "" : "s"} performed.`
                    : ""}
                  {workoutOnlyPerformed > 0
                    ? ` ${workoutOnlyPerformed} workout-only set${workoutOnlyPerformed === 1 ? "" : "s"} performed.`
                    : ""}
                </DrawerDescription>
              </div>
            </div>
          </DrawerHeader>
          <div
            data-testid="finish-workout-scroll"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4"
          >
            <div className="flex flex-col gap-4">
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p>
                {nonPerformedSummary || "All planned sets are accounted for."}
                {pendingWorking > 0
                  ? " Any sets left open will be marked not completed with the one reason you choose below."
                  : ""}
              </p>
              {warmupOccurrences.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Warm-up: {completedWarmups} of {warmupOccurrences.length} completed.
                </p>
              )}
              {groupRoundSummary.length > 0 && (
                <details className="mt-2 rounded-md border bg-background/70">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                    <span>Group-round details</span>
                    <span className="text-muted-foreground">
                      {groupRoundSummary.length} rounds
                    </span>
                  </summary>
                  <ul className="flex flex-col gap-1 border-t px-3 py-2 text-xs text-muted-foreground">
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
                </details>
              )}
            </div>
            {finishBlocked && (
              <div
                role="region"
                aria-label="Unsaved workout recovery"
                className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100"
              >
                <p role="alert" className="font-medium">
                  {skipConfirmationExerciseId != null
                    ? "Repbook is confirming an exercise skip. Set logging and Finish remain paused until the saved workout state is known."
                    : skipConfirmationError?.exerciseId === skipRecoveryExerciseId
                      ? "Repbook could not confirm the exercise skip. Review that exercise, retry the skip, or return to the current set before finishing."
                      : skipRecoveryExerciseId != null
                        ? "Resolve the skipped exercise by replacing it or continuing without a replacement before finishing."
                    : appendRecoveryMarker != null
                      ? "Repbook is confirming an extra set. Its exact identity is retained on this device; reload to retry safely before finishing."
                    : failedSetEntries.length > 0
                    ? `${failedSetEntries.length} ${failedSetEntries.length === 1 ? "set failed" : "sets failed"} to save. Your recorded ${failedSetEntries.length === 1 ? "attempt is" : "attempts are"} still on this device.`
                    : sessionOccurrenceEntries.length > 0
                      ? `${sessionOccurrenceEntries.length} workout-item ${sessionOccurrenceEntries.length === 1 ? "device copy is" : "device copies are"} waiting for acknowledgement.`
                    : workoutSaveQueueMessage({
                        // Equipment guidance no longer blocks finishing, so it is
                        // excluded from this blocking message and shown separately.
                        equipmentError: null,
                        occurrenceError: null,
                        setError: null,
                        occurrenceCount: sessionOccurrenceEntries.length,
                        occurrenceQuarantineCount: 0,
                        equipmentCount: 0,
                        equipmentQuarantineCount: 0,
                        setCount: sessionEntries.length,
                        setQuarantineCount: 0,
                      })}
                </p>
                {guidance.currentAction && sessionEntries.length > 0 && (
                  <div className="mt-3 rounded-md border border-amber-700/25 bg-background/70 p-3 text-foreground">
                    <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      Workout order currently requires
                    </p>
                    <p className="mt-1 font-medium">
                      {formatSessionGuidanceAction(guidance.currentAction)}
                    </p>
                    <Button
                      type="button"
                      className="mt-3 w-full"
                      onClick={revealCurrentWorkoutAction}
                    >
                      Go to required action
                    </Button>
                  </div>
                )}
                {sessionEntries.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-2">
                    {sessionEntries.map((entry) => (
                      <li
                        key={entry.clientKey}
                        className="rounded-md border border-amber-700/25 bg-background/70 p-3 text-foreground"
                      >
                        <p className="font-medium">
                          {entry.exerciseName} · Set {entry.setNo}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {entry.status === "needs_attention"
                            ? "Save failed — attempt retained"
                            : "Waiting for save acknowledgement"}
                        </p>
                        {entry.lastError && (
                          <p className="mt-2 text-sm text-destructive">
                            {entry.lastError}
                          </p>
                        )}
                        {entry.orderBlocker && (
                          <p className="mt-2 text-sm font-medium">
                            Required first: {entry.orderBlocker.label}. Retry
                            unlocks after that exact action is completed or skipped.
                          </p>
                        )}
                        <div className="mt-3 flex flex-col gap-2 min-[420px]:flex-row">
                          {entry.orderBlocker ? (
                            <Button
                              type="button"
                              className="flex-1"
                              disabled={
                                workoutSetOrderBlockerTargetId(
                                  entry.orderBlocker,
                                ) == null
                              }
                              onClick={() =>
                                workoutSetOrderBlockerTargetId(
                                  entry.orderBlocker!,
                                ) &&
                                revealOrderBlocker(
                                  workoutSetOrderBlockerTargetId(
                                    entry.orderBlocker!,
                                  )!,
                                )
                              }
                            >
                              Go to required action
                            </Button>
                          ) : entry.status === "needs_attention" &&
                            entry.reviewRequired !== "stale_occurrence" ? (
                            <Button
                              type="button"
                              variant="outline"
                              className="flex-1"
                              onClick={() => void retrySet(entry.clientKey)}
                            >
                              Retry save
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="outline"
                            className="flex-1"
                            onClick={() => revealUnsavedSet(entry)}
                          >
                            Review device copy
                          </Button>
                          {entry.status === "needs_attention" && (
                            <Button
                              type="button"
                              variant="ghost"
                              className="flex-1 text-destructive"
                              onClick={() => void discardSet(entry.clientKey)}
                            >
                              Discard device copy
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {sessionOccurrenceEntries.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-2">
                    {sessionOccurrenceEntries.map((entry) => (
                      <li
                        key={entry.clientKey}
                        className="rounded-md border border-amber-700/25 bg-background/70 p-3 text-foreground"
                      >
                        <p className="font-medium">{entry.label}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {entry.operation === "complete"
                            ? "Mark done"
                            : entry.operation === "skip"
                              ? "Skip"
                              : entry.operation === "restore"
                                ? "Restore"
                                : "Update note"}
                          {entry.status === "needs_attention"
                            ? " · Save failed — device copy retained"
                            : " · Waiting for save acknowledgement"}
                        </p>
                        {entry.lastError && (
                          <p className="mt-2 text-sm text-destructive">
                            {entry.lastError}
                          </p>
                        )}
                        <div className="mt-3 flex flex-col gap-2 min-[420px]:flex-row">
                          {entry.status === "needs_attention" && (
                            <Button
                              type="button"
                              variant="outline"
                              className="flex-1"
                              onClick={() => retryOccurrenceEntry(entry)}
                            >
                              Retry save
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            className="flex-1 text-destructive"
                            onClick={() => discardOccurrenceEntry(entry)}
                          >
                            Discard device copy
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {unreadableRecordedCopiesPending && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100">
                Repbook found recorded-work device data whose workout ownership
                cannot be verified. Finish is blocked so it cannot silently
                discard a set or warm-up change. Close Finish, then use the
                device-copy attention control to review or explicitly discard
                it.
              </p>
            )}
            {foreignDeviceCopiesPending && (
              <p className="rounded-md border border-sky-500/40 bg-sky-500/10 p-3 text-sm text-sky-950 dark:text-sky-100">
                Repbook also found an identified device copy for another
                workout or account. It does not block Finish and will not be
                deleted here. Review it separately under the device-copy tray.
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
              readOnly={finishRecoveryCommand != null}
              onChoiceChange={(choice) => {
                setDurationChoice(choice);
                setFinishError(null);
              }}
              onOwnerReportedMinutesChange={(value) => {
                setOwnerReportedMinutes(value);
                setFinishError(null);
              }}
            />
            {pendingPlannedOccurrences > 0 && (
              <div className="rounded-lg border bg-background p-3">
                <label
                  htmlFor="completion-reason"
                  className="text-sm font-medium"
                >
                  Why are you finishing this workout early?
                </label>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Choose one reason for all {pendingPlannedOccurrences}{" "}
                  {pendingPlannedOccurrences === 1
                    ? "remaining planned item"
                    : "remaining planned items"}. Repbook will close {pendingPlannedOccurrences === 1
                    ? "it"
                    : "them"} together—you do not need to skip sets or exercises
                  one at a time. Elapsed time does not choose the reason
                  automatically.
                </p>
                <select
                  id="completion-reason"
                  value={completionReason ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCompletionReason(
                      incompleteSessionReasonIsValid(value) ? value : null,
                    );
                    setFinishError(null);
                  }}
                  className="mt-3 min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-required="true"
                  disabled={finishRecoveryCommand != null}
                >
                  <option value="">Choose a reason</option>
                  {INCOMPLETE_SESSION_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {INCOMPLETE_SESSION_REASON_LABELS[reason]}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {finishError && (
              <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <p role="alert">{finishError}</p>
                {finishConflictDetected && (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => router.push(`/history/${props.sessionId}`)}
                    >
                      Review saved workout
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        removeFinishRecovery(
                          window.localStorage,
                          finishRecoveryKey,
                        );
                        removeFinishRecovery(
                          window.localStorage,
                          legacyFinishRecoveryKey,
                        );
                        setFinishRecoveryCommand(null);
                        setFinishConflictDetected(false);
                        setFinishError(null);
                      }}
                    >
                      Discard retained device request
                    </Button>
                  </div>
                )}
              </div>
            )}
            <details className="rounded-lg border bg-background">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                <span>Optional note and fatigue</span>
                <span className="text-xs text-muted-foreground">
                  {finishNote.trim() || fatigue != null ? "Added" : "Skip if not useful"}
                </span>
              </summary>
              <div className="space-y-4 border-t p-3">
                <Textarea
                  placeholder="Session note (optional) — how did it go?"
                  value={finishNote}
                  onChange={(e) => setFinishNote(e.target.value)}
                  rows={2}
                  disabled={finishRecoveryCommand != null}
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
                        disabled={finishRecoveryCommand != null}
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
            </details>
            {finishRecoveryCommand != null && !finishConflictDetected && (
              <p className="text-xs leading-5 text-muted-foreground">
                These finish details are read-only because Repbook is retrying
                the exact request retained on this device.
              </p>
            )}
            </div>
          </div>
          <DrawerFooter className="border-t bg-popover pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Button
              onClick={handleFinish}
              disabled={
                finishing ||
                finishConflictDetected ||
                finishBlocked ||
                !durationReviewReady ||
                (finishRecoveryCommand == null &&
                  pendingPlannedOccurrences > 0 &&
                  completionReason == null)
              }
              size="lg"
            >
              {finishing
                ? "Saving…"
                : pendingPlannedOccurrences > 0
                  ? "Finish early"
                  : "Save workout"}
            </Button>
            <ActiveWorkoutDiscard
              ownerId={props.ownerId}
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
          restAlertPreference={restAlertPreference}
          restSoundState={restSoundState}
          onShowCurrent={() => {
            revealCurrentWorkoutAction();
          }}
          currentWorkingSetRevealed={
            guidance.currentAction?.kind !== "working_set" ||
            (activeGroupMemberIds.has(
              guidance.currentAction.sessionExerciseId,
            )
              ? !collapsedActiveGroupMemberIds.has(
                  guidance.currentAction.sessionExerciseId,
                )
              : expandedId === guidance.currentAction.sessionExerciseId)
          }
          onPrimaryAction={() => {
            if (
              guidance.currentAction != null &&
              guidance.currentAction.kind !== "working_set" &&
              guidance.currentAction.kind !== "rest"
            ) {
              const target = document.getElementById(currentActionTargetId);
              const warmup = target?.querySelector<HTMLButtonElement>(
                '[role="checkbox"][aria-checked="false"]',
              );
              if (warmup && !warmup.disabled) warmup.click();
              else revealCurrentWorkoutAction();
              return;
            }
            const logSet = document.querySelector<HTMLButtonElement>(
              '[data-testid="active-log-set"]',
            );
            if (logSet && !logSet.disabled) logSet.click();
            else revealCurrentWorkoutAction();
          }}
          allowLogWithRetainedFailure={allowLogWithRetainedFailure}
          checkingExerciseSkip={
            (skipConfirmationExerciseId ??
              (skipRecoverySettlementPending
                ? skipRecoveryExerciseId
                : null)) == null
              ? null
              : shownExercises.find(
                  (exercise) => exercise.id === (
                    skipConfirmationExerciseId ?? skipRecoveryExerciseId
                  ),
                )?.name ?? "exercise"
          }
          recoveringSkippedExercise={
            skipConfirmationExerciseId != null ||
            skipRecoverySettlementPending ||
            skipRecoveryExerciseId == null
              ? null
              : shownExercises.find(
                  (exercise) => exercise.id === skipRecoveryExerciseId,
                )?.name ?? "exercise"
          }
          skippedExerciseRecoveryFailed={
            skipRecoveryExerciseId != null &&
            skipConfirmationError?.exerciseId === skipRecoveryExerciseId
          }
          onResolveSkippedExercise={revealSkippedExerciseRecovery}
          onRestAdjust={adjustRest}
          onRestSkip={skipRest}
          onRestContinue={continueRest}
          onAddNote={openContextualNoteComposer}
          onFinish={() => setFinishOpen(true)}
          finishReady={guidance.currentAction == null && !finishBlocked}
          pendingPlannedCount={pendingPlannedOccurrences}
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
            onConfirm={({ reason, reasonCode, note }) =>
              applyOccurrenceMutation(
                occurrence,
                occurrenceAction.mode === "skip" ? "skip" : "note",
                { reason, reasonCode, note },
              )
            }
          />
        );
      })()}
    </main>
  );
}
