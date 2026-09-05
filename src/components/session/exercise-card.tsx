"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  archiveSet,
  confirmExerciseUnskipped,
  skipExercise,
  logPain,
  saveExerciseNote,
  substituteExercise,
  replaceExercise,
  undoExerciseSubstitution,
} from "@/app/actions/sessions";
import { restoreArchiveOperation } from "@/app/actions/archive";
import {
  nextLoadUp,
  nextLoadDown,
  incrementalLoads,
  type PlateMathConfig,
  type IncrementalLoadConfig,
} from "@/engine/plate-math";
import { Button, buttonVariants } from "@/components/ui/button";
import { ExercisePicker } from "@/components/exercises/exercise-picker";
import { ExerciseFamilyIcon } from "@/components/exercises/exercise-family-icon";
import { ExerciseReferenceMedia } from "@/components/exercises/exercise-reference-media";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import { activeSetCommitFormId } from "@/lib/active-workout-layout";
import { formatRestTime } from "@/lib/rest-time";
import { skipReasonLabel } from "@/lib/session-exercise-decision-evidence";
import {
  EXERCISE_NOTE_MAX_LENGTH,
  SET_NOTE_MAX_LENGTH,
  exerciseSwipeRevealsRemove,
  exerciseUsesTotalBarLoad,
  formatCompactPlateLoadGuidance,
} from "@/lib/exercise-card";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import type {
  ExerciseAlternativeAnnotation,
  ExerciseAlternativeReason,
  UserSelectedAlternativeReason,
} from "@/lib/exercise-alternatives";
import { ALTERNATIVE_REASONS } from "@/lib/exercise-alternatives";
import { convertWeight, type LoadUnit } from "@/lib/units";
import {
  Check,
  ChevronDown,
  Minus,
  Plus,
  Archive,
  AlertTriangle,
  MessageSquareText,
  PlayCircle,
  Trash2,
} from "lucide-react";
import type {
  LoggedSet,
  SessionExerciseData,
  SessionOccurrenceData,
} from "./types";
import type { ExerciseProgressProjection } from "@/lib/session-guidance";
import type { MachineLoadConfig } from "@/engine/machine-load-math";
import {
  formatMachineLoadGuidance,
  machineLoadEntryLabel,
} from "@/lib/machine-load-guidance";
import {
  EFFORT_CHOICES,
  effortChoiceForLegacyRpe,
} from "@/lib/active-workout-language";
import { activeWorkoutScrollBehavior } from "@/lib/active-workout-motion";
import {
  isDocumentActionTimeout,
  reportDeploymentMismatch,
  reportDocumentActionTimeout,
  withDocumentActionDeadline,
} from "@/lib/deployment-recovery";
import {
  fetchWorkoutExerciseOptions,
  WorkoutExerciseOptionsRequestError,
  type WorkoutExerciseOptionsMode,
} from "@/lib/workout-exercise-options-client";
import {
  patchActiveWorkoutMeasurement,
  readActiveWorkoutMeasurements,
  writeActiveWorkoutMeasurement,
} from "@/lib/active-workout-measurements";
import {
  markWorkoutInteraction,
  WORKOUT_INTERACTION_MARKS,
} from "@/lib/workout-interaction-performance";
import { OccurrenceMutationDialog } from "./occurrence-mutation-dialog";
import {
  ActiveSetLedger,
  type ActiveSetLedgerDiagnosticRow,
} from "./active-set-ledger";
import {
  activeSetExactResult,
  projectActiveSetRows,
  type ActiveSetRow,
} from "@/lib/active-set-row-projection";
import {
  activeSetVersionEvidenceAfterCorrection,
  activeSetVersionEvidenceLabel,
} from "@/lib/active-set-version-evidence";
import type { IncompleteSessionReason } from "@/lib/session-completion-semantics";
import { OccurrenceSaveStatus } from "./occurrence-save-status";
import {
  isAppendedExtraSetOccurrence,
  workingSetDisplayPosition,
} from "@/lib/session-occurrences";
import {
  buildPerformedSetMeasurement,
  isSupportedSetWriterSemanticDefinition,
  PERFORMED_METRIC_TYPES,
  resolveFutureSetWriterMetricType,
  type SetLoadEntryMeaning,
  type PerformedMetricType,
} from "@/lib/set-metric-semantics";
import type { PreviousComparableSetEvidence } from "@/services/previous-comparable-sets";
import { createClientUuid } from "@/lib/client-uuid";
import { formatPainEvidence } from "@/lib/pain-evidence";
import { AthleteInsight } from "@/components/insights/athlete-insight";
import {
  buildMatchRecentBestInsight,
  buildUsualRestInsight,
  selectAthleteInsight,
  type AthleteInsightCandidate,
} from "@/lib/athlete-insights";
import {
  resolveSetStartingLoad,
  setStartingLoadPreviewText,
} from "@/lib/set-starting-load";
import type { OccurrenceMutationOutboxEntry } from "@/lib/occurrence-mutation-outbox";
import {
  CompletedSetCorrection,
} from "@/components/history/completed-set-correction";
import {
  LIMITATION_CAUSES,
  LIMITATION_CAUSE_LABELS,
  PAIN_BODY_PARTS,
  TECHNIQUE_ISSUES,
  TECHNIQUE_ISSUE_LABELS,
  type LimitationCause,
  type PainBodyPart,
  type SetPainContext,
  type TechniqueIssue,
} from "@/lib/set-exception-context";

const RPE_CHIPS = EFFORT_CHOICES.map((choice) => ({
  label: choice.label,
  shortcutLabel: `${choice.label} — RPE ${choice.legacyRpe}`,
  meaning: choice.meaning,
  value: choice.legacyRpe,
}));

function formatLoggedSet(
  set: LoggedSet,
  fallbackMetricType: SessionExerciseData["metricType"],
) {
  const metricType = set.metricType ?? fallbackMetricType ?? "weight_reps";
  if (metricType === "weight_duration_per_side") return `${set.weight ?? "—"} ${set.weightUnit ?? ""} · ${set.durationSeconds ?? "—"} sec/side`;
  if (metricType === "duration" && set.durationSeconds != null) {
    return formatPerformedDuration(set.durationSeconds);
  }
  if (metricType === "distance_duration" && set.distanceKm != null) {
    const duration = set.durationSeconds == null
      ? ""
      : ` · ${formatPerformedDuration(set.durationSeconds)}`;
    return `${set.distanceKm} km${duration}`;
  }
  if (set.reps == null) return "No numeric result";
  const repetitions = `${set.reps} rep${set.reps === 1 ? "" : "s"}`;
  if (
    metricType === "assisted_reps" &&
    set.weight != null &&
    set.weightUnit != null
  ) {
    return `Assistance: ${set.weight} ${set.weightUnit} · ${repetitions}`;
  }
  return set.weight != null && set.weightUnit != null
    ? `${set.weight} ${set.weightUnit} × ${repetitions}`
    : repetitions;
}

function formatPreviousComparableSet(
  set: PreviousComparableSetEvidence,
  metricType: PerformedMetricType,
) {
  return formatLoggedSet(
    {
      ...set,
      id: set.setId,
      clientKey: null,
      metricType,
      note: null,
    },
    metricType,
  );
}

function compactComparableProvenance(
  set: PreviousComparableSetEvidence,
  workoutSource: string,
) {
  const { state, count } = set.correctionProvenance;
  const versionLabel = state === "original"
    ? null
    : activeSetVersionEvidenceLabel({ state, count });
  if (versionLabel != null) return versionLabel;
  if (workoutSource === "history_manual") return "Owner-entered source";
  if (workoutSource === "hevy") return "Imported source";
  return "Repbook source";
}

function formatPerformedDuration(durationSeconds: number) {
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, "0")}`
    : `${seconds} sec`;
}

function formatLoggedExceptionContext(set: LoggedSet) {
  const context: string[] = [];
  if (set.rir != null) context.push(`RIR ${set.rir}`);
  if (set.techniqueIssue != null) {
    context.push(`Technique: ${TECHNIQUE_ISSUE_LABELS[set.techniqueIssue]}`);
  }
  if (set.limitationCause != null) {
    context.push(`Limited by: ${LIMITATION_CAUSE_LABELS[set.limitationCause]}`);
  }
  if (set.pain != null) {
    context.push(`Pain: ${set.pain.bodyPart} ${set.pain.severity}/10`);
  }
  return context;
}

function PendingSetSaveStatus({
  set,
  rowLabel,
  orderBlocker = null,
  reviewRequired = false,
  onRevealBlocker,
  onRefreshWorkout,
  onRetry,
  onDiscard,
}: {
  set: LoggedSet;
  rowLabel: string;
  orderBlocker?: SetOrderBlocker | null;
  reviewRequired?: boolean;
  onRevealBlocker?: (targetId: string) => void;
  onRefreshWorkout?: () => void;
  onRetry: (clientKey: string) => Promise<void>;
  onDiscard: (clientKey: string) => Promise<void>;
}) {
  if (set.saveState !== "failed") return null;
  const orderConflict =
    (orderBlocker != null ||
      set.lastError?.toLowerCase().includes("earlier set") === true ||
      set.lastError?.toLowerCase().includes("set order") === true ||
      set.lastError?.toLowerCase().includes("workout order") === true);
  const blockerDescription = orderBlocker == null
    ? null
    : [orderBlocker.blockerExerciseName, orderBlocker.blockerLabel]
        .filter((part): part is string => Boolean(part?.trim()))
        .join(" · ");

  return (
    <div
      data-testid="failed-set-recovery"
      className="mt-2 border-t border-amber-900/15 pt-2 dark:border-amber-100/20"
    >
      <div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {reviewRequired
            ? `This retained ${rowLabel.toLowerCase()} was based on an older workout state. Refresh, then review or discard it.`
            : orderConflict && blockerDescription
            ? `${blockerDescription} comes first. This ${rowLabel.toLowerCase()} is still safe on this device.`
            : orderConflict
              ? "Workout order changed. Refresh to find the exact set that comes first."
              : `This device copy still owns ${rowLabel}. Retry the save, or discard the device copy to enter or skip ${rowLabel} again.`}
        </p>
        {set.lastError && !orderConflict && (
          <p className="mt-2 text-sm text-foreground">{set.lastError}</p>
        )}
      </div>
      {set.clientKey && (
        <div className="mt-3 grid grid-cols-1 gap-2 min-[520px]:grid-cols-2">
          {reviewRequired && onRefreshWorkout ? (
            <Button type="button" onClick={onRefreshWorkout}>
              Refresh workout
            </Button>
          ) : orderBlocker?.blockerTargetId && onRevealBlocker ? (
            <Button
              type="button"
              onClick={() => onRevealBlocker(orderBlocker.blockerTargetId!)}
            >
              Go to {orderBlocker.blockerLabel}
            </Button>
          ) : orderConflict && onRefreshWorkout ? (
            <Button type="button" onClick={onRefreshWorkout}>
              Refresh workout
            </Button>
          ) : null}
          {orderBlocker == null && !reviewRequired && (
            <Button
              type="button"
              variant="outline"
              onClick={async () => await onRetry(set.clientKey!)}
            >
              Retry save
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "text-destructive",
              orderConflict && "min-[520px]:col-span-2",
            )}
            onClick={async () => await onDiscard(set.clientKey!)}
          >
            Discard device copy
          </Button>
        </div>
      )}
    </div>
  );
}

function performedMetricTypeForLivePatch(
  metricType: string,
): PerformedMetricType | null {
  return PERFORMED_METRIC_TYPES.includes(metricType as PerformedMetricType)
    ? (metricType as PerformedMetricType)
    : null;
}

const SUBSTITUTION_REASON_LABELS: Record<ExerciseAlternativeReason, string> = {
  variety: "Variety",
  equipment_busy: "Equipment busy",
  equipment_unavailable_incompatible: "Equipment unavailable or incompatible",
  discomfort: "Discomfort",
  other: "Another reason",
};

type SetPainDraft = {
  bodyPart: PainBodyPart | null;
  severity: number | null;
  note: string | null;
};

type ActiveSetDraftCacheEntry = {
  identity: string;
  draft: SetDraft;
  weightEdited: boolean;
};

// A server refresh can replace the active SessionRunner when its history
// revision advances (for example, after an automatic equipment selection is
// acknowledged). Keep an unsaved set draft alive across that remount, but only
// while the performed exercise and its measurement semantics are unchanged.
// Session-exercise IDs are unique, so drafts from different workout rows never
// share an entry.
const serverActiveSetDraftCache = new Map<string, ActiveSetDraftCacheEntry>();

function getActiveSetDraftCache() {
  if (typeof window === "undefined") return serverActiveSetDraftCache;
  const cacheOwner = window as typeof window & {
    __repbookActiveSetDraftCache?: Map<string, ActiveSetDraftCacheEntry>;
  };
  cacheOwner.__repbookActiveSetDraftCache ??= new Map();
  return cacheOwner.__repbookActiveSetDraftCache;
}

function copySetDraft(draft: SetDraft): SetDraft {
  return {
    ...draft,
    pain: draft.pain == null ? null : { ...draft.pain },
  };
}

export function parseFiniteDraftNumber(
  rawValue: string,
  currentValue: number | null,
) {
  if (rawValue === "") return null;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : currentValue;
}

export function cachedDraftProtectsPreviousWeight(
  cached: Pick<ActiveSetDraftCacheEntry, "weightEdited"> | null,
) {
  return cached?.weightEdited === true;
}

type SetDraft = {
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
  rpe: number | null;
  rir: number | null;
  techniqueIssue: TechniqueIssue | null;
  limitationCause: LimitationCause | null;
  pain: SetPainDraft | null;
  note: string;
};

export function hydratePreviousComparableWeight(input: {
  draft: SetDraft;
  weight: number | null;
  unit: LoadUnit;
  source: string | null;
  protectedDraft: boolean;
  edited: boolean;
}) {
  if (
    input.weight == null ||
    input.source !== "Previous comparable set" ||
    input.protectedDraft ||
    input.edited ||
    input.draft.weight != null ||
    input.draft.weightUnit != null
  ) {
    return input.draft;
  }
  return {
    ...input.draft,
    weight: input.weight,
    weightUnit: input.unit,
  };
}

type Props = {
  exercise: SessionExerciseData;
  historyRevision: number;
  progress: ExerciseProgressProjection;
  expanded: boolean;
  onToggle: () => void;
  equipmentDecision?: ReactNode;
  equipmentReasonAvailable?: boolean;
  plateConfigs: Record<string, PlateMathConfig>;
  machineLoadConfig?: MachineLoadConfig | null;
  incrementals: Record<string, IncrementalLoadConfig>;
  unit: LoadUnit;
  loadEntryMeaning?: SetLoadEntryMeaning | null;
  comparisonTemporarilyUnavailable?: boolean;
  onPatch: (patch: Partial<SessionExerciseData>) => void;
  onQueueSet: (
    set: LoggedSet,
    occurrence?: SessionOccurrenceData | null,
  ) => Promise<boolean>;
  onPrepareSetLog?: (
    occurrence?: SessionOccurrenceData | null,
  ) => void;
  onAppendSet?: (
    occurrenceId: string,
    expectedSetNo: number,
  ) => Promise<SessionOccurrenceData | null>;
  activeOccurrence?: SessionOccurrenceData | null;
  resting?: boolean;
  preparationBlocker?: SetOrderBlocker | null;
  futureProgramRemoval?: {
    href: string;
    dayName: string;
    plannedExerciseName: string;
  } | null;
  workingOccurrences?: SessionOccurrenceData[];
  occurrenceMutationEntries?: OccurrenceMutationOutboxEntry[];
  occurrenceRuntimeSaveStates?: Record<string, "saving" | "retrying">;
  acknowledgedOccurrenceIds?: string[];
  isCurrentExercise?: boolean;
  fixedPrimaryActionAvailable?: boolean;
  nextActionLabel?: string | null;
  warmupResolved?: boolean;
  groupContext?: {
    name: string;
    memberOrder: number;
    memberCount: number;
  } | null;
  occurrenceChangesBlocked?: boolean;
  onSkipSet?: (
    input: {
      reason: string | null;
      reasonCode: IncompleteSessionReason | null;
      note: string | null;
    },
    occurrence?: SessionOccurrenceData | null,
  ) => Promise<boolean>;
  onRetryOccurrenceMutation?: (
    entry: OccurrenceMutationOutboxEntry,
  ) => void;
  onDiscardOccurrenceMutation?: (
    entry: OccurrenceMutationOutboxEntry,
  ) => void;
  onRetrySet: (clientKey: string) => Promise<void>;
  onDiscardSet: (clientKey: string) => Promise<void>;
  setOrderBlockers?: Record<string, SetOrderBlocker>;
  setReviewRequired?: Record<string, boolean>;
  onRevealBlocker?: (targetId: string) => void;
  onRefreshWorkout?: () => void;
  onHistoryRevisionChange?: (historyRevision: number) => void;
  onOpenCoach: () => void;
  onExplainInsight?: (insight: AthleteInsightCandidate) => void;
  onSkipRequestStart?: (
    reason: IncompleteSessionReason,
  ) => void;
  onSkipRequestFailure?: (
    reason: IncompleteSessionReason,
    code?: string,
  ) => boolean;
  skipConfirmationPending?: boolean;
  skipRecoverySettlementPending?: boolean;
  skipConfirmationError?: string | null;
  onSkipConfirmationErrorDismiss?: () => Promise<void> | void;
  onSkipComplete: () => void;
  adjustIntent: ExerciseAdjustmentIntent | null;
  onAdjustIntentChange: (intent: ExerciseAdjustmentIntent | null) => void;
};

export type SetOrderBlocker = {
  blockerOccurrenceId?: string;
  blockerLabel: string;
  blockerExerciseName?: string | null;
  blockerTargetId?: string;
};

export function unconfirmedSetsBlockLogging({
  sets,
  targetOccurrenceId,
  blockers,
}: {
  sets: LoggedSet[];
  targetOccurrenceId: string | null;
  blockers: Record<string, SetOrderBlocker>;
}) {
  const unconfirmedSets = sets.filter(
    (set) => set.saveState != null && set.saveState !== "saved",
  );
  if (unconfirmedSets.length === 0) return false;
  if (targetOccurrenceId == null) return true;
  return unconfirmedSets.some((set) => {
    if (set.occurrenceId === targetOccurrenceId) return true;
    if (set.occurrenceId != null) return false;
    return set.clientKey == null ||
      blockers[set.clientKey]?.blockerOccurrenceId !== targetOccurrenceId;
  });
}

export async function runGuardedLogRequest<T>(
  inFlight: Set<string>,
  requestKey: string,
  request: () => Promise<T>,
): Promise<{ started: false } | { started: true; value: T }> {
  if (inFlight.has(requestKey)) return { started: false };
  inFlight.add(requestKey);
  try {
    return { started: true, value: await request() };
  } finally {
    inFlight.delete(requestKey);
  }
}

type AlternativeOptions = {
  currentExerciseId: string;
  plannedExerciseId: string;
  plannedExerciseName: string;
  plannedExercise: ExerciseDiscoveryItem;
  items: ExerciseDiscoveryItem[];
  priorityIds: string[];
  annotations: Record<string, ExerciseAlternativeAnnotation>;
};

type ReplacementOptions = {
  currentExerciseId: string;
  plannedExerciseId: string;
  plannedExerciseName: string;
  currentState: Pick<
    SessionExerciseData,
    | "modificationType"
    | "skipReason"
    | "substitutedForExerciseId"
    | "substitutionReason"
    | "substitutedAt"
    | "targetLoad"
    | "targetLoadUnit"
    | "notes"
    | "warmupNotes"
    | "warmupSets"
    | "setNotes"
  >;
  items: ExerciseDiscoveryItem[];
  warnings: Record<string, string>;
  permittedIds: string[];
  disabledReasons: Record<string, string>;
};

export type ExerciseAdjustmentIntent =
  | "note"
  | "swap"
  | "replace"
  | "replace_equipment"
  | "skip"
  | "skip_equipment"
  | "remove";

export const REPLACEMENT_CATALOG_LOAD_TIMEOUT_MS = 12_000;

function useWorkoutExerciseOptions<T>({
  mode,
  exerciseId,
  open,
  onLoaded,
}: {
  mode: WorkoutExerciseOptionsMode;
  exerciseId: string;
  open: boolean;
  onLoaded?: (options: T) => void;
}) {
  const [options, setOptions] = useState<T | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const onLoadedRef = useRef(onLoaded);

  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    if (!open || options != null) return;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const controller = new AbortController();
    loadAbortRef.current = controller;
    let ignore = false;
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      REPLACEMENT_CATALOG_LOAD_TIMEOUT_MS,
    );
    void fetchWorkoutExerciseOptions<T>(mode, exerciseId, controller.signal)
      .then((result) => {
        if (ignore || generation !== loadGenerationRef.current) return;
        setOptions(result);
        onLoadedRef.current?.(result);
      })
      .catch((error: unknown) => {
        if (ignore || generation !== loadGenerationRef.current) return;
        if (controller.signal.aborted) {
          setLoadError(
            "The exercise catalog took too long to respond. Check your connection, then try again.",
          );
          return;
        }
        setLoadError(
          error instanceof WorkoutExerciseOptionsRequestError
            ? error.message
            : "The exercise catalog did not load. Check your connection, then try again.",
        );
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        if (loadAbortRef.current === controller) loadAbortRef.current = null;
      });
    return () => {
      ignore = true;
      window.clearTimeout(timeoutId);
      controller.abort();
      if (loadAbortRef.current === controller) loadAbortRef.current = null;
    };
  }, [exerciseId, loadAttempt, mode, open, options]);

  function invalidateActiveLoad() {
    loadGenerationRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
  }

  function retryLoad() {
    invalidateActiveLoad();
    setLoadError(null);
    setOptions(null);
    setLoadAttempt((current) => current + 1);
  }

  function prepareToOpen() {
    if (options == null) setLoadError(null);
  }

  return {
    options,
    setOptions,
    loadError,
    invalidateActiveLoad,
    retryLoad,
    prepareToOpen,
  };
}

export function ExerciseCard({
  exercise,
  historyRevision,
  progress,
  expanded,
  onToggle,
  equipmentDecision = null,
  equipmentReasonAvailable = false,
  plateConfigs,
  machineLoadConfig = null,
  incrementals,
  unit,
  loadEntryMeaning = null,
  comparisonTemporarilyUnavailable = false,
  onPatch,
  onQueueSet,
  onPrepareSetLog = () => undefined,
  onAppendSet = async () => null,
  activeOccurrence = null,
  resting = false,
  preparationBlocker = null,
  futureProgramRemoval = null,
  workingOccurrences = [],
  occurrenceMutationEntries = [],
  occurrenceRuntimeSaveStates = {},
  acknowledgedOccurrenceIds = [],
  isCurrentExercise = false,
  fixedPrimaryActionAvailable = false,
  nextActionLabel = null,
  warmupResolved = false,
  groupContext = null,
  occurrenceChangesBlocked = false,
  onSkipSet = async () => false,
  onRetryOccurrenceMutation = () => undefined,
  onDiscardOccurrenceMutation = () => undefined,
  onRetrySet,
  onDiscardSet,
  setOrderBlockers = {},
  setReviewRequired = {},
  onRevealBlocker,
  onRefreshWorkout,
  onHistoryRevisionChange = () => undefined,
  onOpenCoach,
  onExplainInsight = () => undefined,
  onSkipRequestStart = () => undefined,
  onSkipRequestFailure = () => true,
  skipConfirmationPending = false,
  skipRecoverySettlementPending = false,
  skipConfirmationError = null,
  onSkipConfirmationErrorDismiss = () => undefined,
  onSkipComplete,
  adjustIntent,
  onAdjustIntentChange,
}: Props) {
  const router = useRouter();
  const [removeSwipeRevealed, setRemoveSwipeRevealed] = useState(false);
  const removeSwipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const [removeSwipeOffset, setRemoveSwipeOffset] = useState(0);
  const plateConfig = plateConfigs[exercise.id];
  const incremental = incrementals[exercise.loadType];
  const usesTotalBarLoad = exerciseUsesTotalBarLoad({
    loadType: exercise.loadType,
    loadSemantics: exercise.loadSemantics,
    plateConfig,
  });
  const liveWeightLabel = machineLoadConfig
    ? machineLoadEntryLabel(machineLoadConfig)
    : exercise.metricType === "assisted_reps"
      ? "Assistance"
    : usesTotalBarLoad
      ? "Total load"
      : undefined;
  const performedMetricType = resolveFutureSetWriterMetricType({
    metricType: exercise.metricType ?? "weight_reps",
    loadSemantics: exercise.loadSemantics,
  });
  const recordsNumericLoad =
    performedMetricType === "weight_reps" ||
    performedMetricType === "assisted_reps" || performedMetricType === "weight_duration_per_side";
  const metricSupported = isSupportedSetWriterSemanticDefinition({
    metricType: performedMetricType,
    loadSemantics: exercise.loadSemantics,
  });

  const highestLoggedSetNo = exercise.sets.reduce(
    (highest, set) => Math.max(highest, set.setNo),
    0,
  );
  const highestOccurrenceSetNo = workingOccurrences.reduce(
    (highest, occurrence) => Math.max(highest, occurrence.kindOrdinal + 1),
    0,
  );
  const appendedOccurrence =
    [...workingOccurrences]
      .filter(
        (occurrence) =>
          isAppendedExtraSetOccurrence(occurrence) &&
          occurrence.outcome === "pending",
      )
      .sort((left, right) => right.kindOrdinal - left.kindOrdinal)[0] ?? null;
  const appendSetNo =
    Math.max(exercise.targetSets ?? 0, highestLoggedSetNo, highestOccurrenceSetNo) + 1;
  // Planned occurrences are the durable source of set identity. A skipped set
  // leaves a deliberate hole, so completed-set count cannot identify the next
  // set without accidentally reusing the skipped ordinal.
  const nextSetNo =
    activeOccurrence?.kind === "working_set"
      ? activeOccurrence.kindOrdinal + 1
      : highestLoggedSetNo + 1;
  const nextSetIdx = nextSetNo - 1;
  const deviceRetryingSets = exercise.sets.filter(
    (set) => set.saveState === "retrying",
  ).length;
  const deviceFailedSets = exercise.sets.filter(
    (set) => set.saveState === "failed",
  ).length;
  const deviceSavingSets = exercise.sets.filter(
    (set) =>
      set.saveState != null &&
      set.saveState !== "saved" &&
      set.saveState !== "retrying" &&
      set.saveState !== "failed",
  ).length;
  const deviceSaveSummary = [
    deviceRetryingSets > 0
      ? `Retrying ${deviceRetryingSets} ${deviceRetryingSets === 1 ? "set" : "sets"}`
      : null,
    deviceSavingSets > 0 ? `${deviceSavingSets} saving` : null,
    deviceFailedSets > 0
      ? `${deviceFailedSets} ${deviceFailedSets === 1 ? "needs" : "need"} attention`
      : null,
  ].filter((part): part is string => part != null).join(" · ");
  const comparableProjection = comparisonTemporarilyUnavailable
    ? undefined
    : exercise.previousComparable;
  const comparableSemanticsMatch =
    comparableProjection?.status === "available" &&
    comparableProjection.exerciseId === exercise.exerciseId &&
    (comparableProjection.semantics.metricType !== "weight_reps" &&
    comparableProjection.semantics.metricType !== "assisted_reps"
      ? true
      : comparableProjection.semantics.loadEntryMeaning === loadEntryMeaning);
  const previousComparableSetFor = (setNumber: number) =>
    comparableProjection?.status === "available" && comparableSemanticsMatch
      ? comparableProjection.sets.find((set) => set.setNo === setNumber) ??
        comparableProjection.sets.at(-1) ??
        null
      : null;
  const activeInsightCurrentSets = exercise.sets.map((set) => ({
    setId: set.id,
    metricType: set.metricType ?? performedMetricType,
    weight: set.weight,
    weightUnit: set.weightUnit,
    reps: set.reps,
    saveState: set.saveState,
    hasPainOrLimitation:
      set.pain != null ||
      set.techniqueIssue != null ||
      set.limitationCause != null,
  }));
  const generatedActiveInsight =
    !comparisonTemporarilyUnavailable &&
    comparableProjection?.status === "available" &&
    comparableSemanticsMatch
      ? selectAthleteInsight(
          [
            buildMatchRecentBestInsight({
              exerciseId: exercise.exerciseId,
              exerciseName: exercise.name,
              currentSets: activeInsightCurrentSets,
              previous: comparableProjection,
            }),
            buildUsualRestInsight({
              exerciseId: exercise.exerciseId,
              exerciseName: exercise.name,
              currentSets: activeInsightCurrentSets,
              samples: (comparableProjection.usualRestSamples ?? []).map(
                (sample) => ({
                  setId: sample.setId,
                  workoutId: sample.workoutId,
                  seconds: sample.restTakenSec,
                  compatible: true,
                }),
              ),
            }),
          ],
          {
            placement: "active_set",
            exactExerciseId: exercise.exerciseId,
          },
        )
      : null;
  // This projection lives only in the open workout's client state and renders
  // once at exercise level. It is never copied into each set row or persisted.
  const activeInsight = isCurrentExercise ? generatedActiveInsight : null;
  const prefillFrom =
    [...exercise.sets]
      .filter((set) => set.setNo < nextSetNo)
      .sort((left, right) => right.setNo - left.setNo)[0] ?? null;

  const startingLoad = resolveSetStartingLoad({
    exercise,
    setNumber: nextSetNo,
    unit,
    loadEntryMeaning,
    occurrence: activeOccurrence,
    comparisonTemporarilyUnavailable,
  });
  const defaultWeight = startingLoad.status === "available"
    ? startingLoad.weight
    : null;
  const defaultWeightSource = startingLoad.status === "available"
    ? startingLoad.source
    : null;
  const defaultReps =
    performedMetricType === "weight_reps" ||
      performedMetricType === "reps" ||
      performedMetricType === "assisted_reps"
      ? prefillFrom?.reps ?? exercise.targetRepsMax ?? exercise.targetRepsMin ?? 8
      : null;
  const appendedStartingLoad = appendedOccurrence == null
    ? null
    : resolveSetStartingLoad({
        exercise,
        setNumber: appendedOccurrence.kindOrdinal + 1,
        unit,
        loadEntryMeaning,
        occurrence: appendedOccurrence,
        comparisonTemporarilyUnavailable,
      });
  const appendedWeight =
    appendedOccurrence?.plannedExerciseId === exercise.exerciseId &&
    appendedOccurrence.plannedLoad != null &&
    appendedOccurrence.plannedLoadUnit != null
      ? convertWeight(
          appendedOccurrence.plannedLoad,
          appendedOccurrence.plannedLoadUnit,
          unit,
        )
      : appendedStartingLoad?.status === "available"
        ? appendedStartingLoad.weight
        : null;
  const appendedReps =
    appendedOccurrence?.plannedRepsMax ??
    appendedOccurrence?.plannedRepsMin ??
    null;
  const defaultSetNote =
    exercise.modificationType === "substituted"
      ? ""
      : (exercise.setNotes[nextSetIdx] ?? "");

  const draftIdentity = [
    exercise.exerciseId,
    performedMetricType,
    exercise.loadType,
    exercise.loadSemantics ?? "unknown",
    unit,
  ].join(":");
  const initialDraft: SetDraft = {
    weight: recordsNumericLoad ? defaultWeight : null,
    weightUnit: recordsNumericLoad
      ? defaultWeight == null ? null : unit
      : null,
    reps: defaultReps,
    distanceKm: null,
    durationSeconds: performedMetricType === "weight_duration_per_side" ? prefillFrom?.durationSeconds ?? null : null,
    rpe: null,
    rir: null,
    techniqueIssue: null,
    limitationCause: null,
    pain: null,
    note: defaultSetNote,
  };
  const [initialDraftState] = useState(() => {
    const activeSetDraftCache = getActiveSetDraftCache();
    const cached = activeSetDraftCache.get(exercise.id);
    if (cached?.identity === draftIdentity) {
      return {
        draft: copySetDraft(cached.draft),
        weightEdited: cachedDraftProtectsPreviousWeight(cached),
      };
    }
    if (cached) activeSetDraftCache.delete(exercise.id);
    return { draft: initialDraft, weightEdited: false };
  });
  const draftWeightEditedRef = useRef(initialDraftState.weightEdited);
  const [draft, setDraftState] = useState<SetDraft>(initialDraftState.draft);
  const setDraft: React.Dispatch<React.SetStateAction<SetDraft>> = (update) => {
    setDraftState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      getActiveSetDraftCache().set(exercise.id, {
        identity: draftIdentity,
        draft: copySetDraft(next),
        weightEdited: draftWeightEditedRef.current,
      });
      return next;
    });
  };
  useEffect(() => {
    if (
      !recordsNumericLoad ||
      defaultWeight == null ||
      defaultWeightSource !== "Previous comparable set" ||
      draftWeightEditedRef.current
    ) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setDraftState((current) => {
        const next = hydratePreviousComparableWeight({
          draft: current,
          weight: defaultWeight,
          unit,
          source: defaultWeightSource,
          protectedDraft: false,
          edited: draftWeightEditedRef.current,
        });
        if (next === current) return current;
        getActiveSetDraftCache().set(exercise.id, {
          identity: draftIdentity,
          draft: copySetDraft(next),
          weightEdited: false,
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    defaultWeight,
    defaultWeightSource,
    draftIdentity,
    exercise.id,
    recordsNumericLoad,
    unit,
  ]);
  const [appendedDraft, setAppendedDraft] = useState<SetDraft>({
    weight: recordsNumericLoad
      ? appendedOccurrence == null ? defaultWeight : appendedWeight
      : null,
    weightUnit: recordsNumericLoad &&
        (appendedOccurrence == null ? defaultWeight : appendedWeight) != null
      ? unit
      : null,
    reps: appendedReps ?? defaultReps,
    distanceKm: null,
    durationSeconds: null,
    rpe: null,
    rir: null,
    techniqueIssue: null,
    limitationCause: null,
    pain: null,
    note: "",
  });
  const [appendingSet, setAppendingSet] = useState(false);
  const appendRequestRef = useRef<string | null>(null);
  const appendFocusRequestRef = useRef<string | null>(null);
  const logRequestRef = useRef(new Set<string>());
  const [logRequestKey, setLogRequestKey] = useState<string | null>(null);
  const [skipSetOccurrence, setSkipSetOccurrence] =
    useState<SessionOccurrenceData | null>(null);
  const [note, setNote] = useState(exercise.notes ?? "");
  const [pending, startTransition] = useTransition();
  const readyAtRef = useRef(new Date().toISOString());
  const tapsRef = useRef(0);
  const focusChangesRef = useRef(0);

  useEffect(() => {
    readyAtRef.current = new Date().toISOString();
    tapsRef.current = 0;
    focusChangesRef.current = 0;
  }, [activeOccurrence?.id]);

  useEffect(() => {
    const requestedOccurrenceId = appendFocusRequestRef.current;
    if (
      requestedOccurrenceId == null ||
      appendedOccurrence?.id !== requestedOccurrenceId
    ) {
      return;
    }
    let focusFrame = 0;
    const scrollFrame = requestAnimationFrame(() => {
      const targetId = `added-set-entry-${exercise.id}-${requestedOccurrenceId}`;
      document
        .getElementById(targetId)
        ?.scrollIntoView({
          behavior: activeWorkoutScrollBehavior(),
          block: "center",
        });
      focusFrame = requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`#${targetId} input`)
          ?.focus({ preventScroll: true });
        if (appendFocusRequestRef.current === requestedOccurrenceId) {
          appendFocusRequestRef.current = null;
        }
      });
    });
    return () => {
      cancelAnimationFrame(scrollFrame);
      cancelAnimationFrame(focusFrame);
    };
  }, [appendedOccurrence?.id, exercise.id]);

  const isSkipped = exercise.modificationType === "skipped";
  const targetText =
    exercise.targetSets != null
      ? (exercise.timedPrescription ? `${exercise.targetSets} × ${exercise.timedPrescription.minSeconds}–${exercise.timedPrescription.maxSeconds} sec/side` : `${exercise.targetSets}×${exercise.targetRepsMin}–${exercise.targetRepsMax}`) +
        (exercise.targetLoad != null && exercise.targetLoadUnit != null
          ? ` @ ${exercise.targetLoad} ${exercise.targetLoadUnit}`
          : "")
      : "no target";

  function stepWeight(current: number | null, dir: 1 | -1): number | null {
    if (current == null) return dir > 0 ? 5 : null;
    if (plateConfig) {
      const next =
        dir > 0 ? nextLoadUp(current, plateConfig) : nextLoadDown(current, plateConfig);
      return next?.totalLoad ?? current;
    }
    if (incremental) {
      const loads = incrementalLoads(incremental);
      const idx = loads.findIndex((l) => Math.abs(l - current) < 1e-9);
      if (idx >= 0) {
        return loads[Math.min(loads.length - 1, Math.max(0, idx + dir))];
      }
      return dir > 0
        ? (loads.find((l) => l > current) ?? current)
        : ([...loads].reverse().find((l) => l < current) ?? current);
    }
    return Math.max(0, current + dir * 5);
  }

  async function handleLog(
    setNo = nextSetNo,
    occurrence: SessionOccurrenceData | null = activeOccurrence,
    submittedDraft: SetDraft = draft,
  ) {
    markWorkoutInteraction(WORKOUT_INTERACTION_MARKS.setLogTap);
    if (skipConfirmationPending || skipConfirmationError != null) {
      toast.info("Resolve the exercise skip before logging a set.");
      return;
    }
    if (unconfirmedSetsBlockLogging({
      sets: exercise.sets,
      targetOccurrenceId: occurrence?.id ?? null,
      blockers: setOrderBlockers,
    })) {
      return;
    }
    if (!metricSupported) {
      toast.error(
        "This exercise needs a performed measurement shape that Repbook cannot record truthfully yet.",
      );
      return;
    }
    const performed = buildPerformedSetMeasurement({
      metricType: performedMetricType,
      loadSemantics: exercise.loadSemantics,
      weight: submittedDraft.weight,
      weightUnit: submittedDraft.weight == null
        ? null
        : (submittedDraft.weightUnit ?? unit),
      reps: submittedDraft.reps,
      distanceKm: submittedDraft.distanceKm,
      durationSeconds: submittedDraft.durationSeconds,
    });
    if (!performed.ok) {
      toast.error(performed.message);
      return;
    }
    let pain: SetPainContext | null = null;
    if (submittedDraft.pain != null) {
      if (
        submittedDraft.pain.bodyPart == null ||
        submittedDraft.pain.severity == null
      ) {
        toast.error("Choose a pain location and severity, or clear the pain flag.");
        return;
      }
      pain = {
        bodyPart: submittedDraft.pain.bodyPart,
        severity: submittedDraft.pain.severity,
        note: submittedDraft.pain.note,
      };
    }
    const requestKey = occurrence?.id ?? `${exercise.id}:${setNo}`;
    await runGuardedLogRequest(logRequestRef.current, requestKey, async () => {
      setLogRequestKey(requestKey);
      try {
        let clientKey: string;
        try {
          clientKey = createClientUuid();
        } catch {
          toast.error(
            "This browser could not create a secure set identity. Nothing was saved.",
          );
          return;
        }
        const submittedAtISO = new Date().toISOString();
        const cleanNote = submittedDraft.note.trim() || null;
        const optimistic: LoggedSet = {
          id: `optimistic-${clientKey}`,
          clientKey,
          occurrenceId: occurrence?.id ?? null,
          setNo,
          ...performed.measurement,
          rpe: submittedDraft.rpe,
          rir: submittedDraft.rir,
          techniqueIssue: submittedDraft.techniqueIssue,
          limitationCause: submittedDraft.limitationCause,
          pain,
          note: cleanNote,
          saveState: "pending",
        };
        try {
          if (!(await onQueueSet(optimistic, occurrence))) return;
        } catch {
          toast.error(
            "This browser could not open the device set queue. Nothing was saved.",
          );
          return;
        }
        writeActiveWorkoutMeasurement({
          version: 1,
          clientKey,
          setId: null,
          readyAtISO: readyAtRef.current,
          submittedAtISO,
          acknowledgedAtISO: null,
          durationMs: null,
          taps: tapsRef.current,
          focusChanges: focusChangesRef.current,
          corrections: 0,
          outcome: "delayed",
        });
        const resetSubmittedDraft = (current: SetDraft): SetDraft => ({
          ...current,
          distanceKm:
            performed.measurement.metricType === "distance_duration"
              ? null
              : current.distanceKm,
          durationSeconds:
            performed.measurement.metricType === "duration" ||
            performed.measurement.metricType === "weight_duration_per_side" ||
              performed.measurement.metricType === "distance_duration"
              ? null
              : current.durationSeconds,
          rpe: null,
          rir: null,
          techniqueIssue: null,
          limitationCause: null,
          pain: null,
          note: exercise.setNotes[setNo] ?? "",
        });
        if (occurrence?.id === appendedOccurrence?.id) {
          setAppendedDraft(resetSubmittedDraft);
        } else {
          setDraft(resetSubmittedDraft);
        }
      } finally {
        setLogRequestKey((current) => current === requestKey ? null : current);
      }
    });
  }

  async function handleAppendSet() {
    if (
      appendingSet ||
      appendRequestRef.current ||
      appendedOccurrence
    ) {
      return;
    }
    const occurrenceId = createClientUuid();
    appendRequestRef.current = occurrenceId;
    appendFocusRequestRef.current = occurrenceId;
    setAppendingSet(true);
    try {
      const appended = await onAppendSet(occurrenceId, appendSetNo);
      if (!appended) {
        appendFocusRequestRef.current = null;
        return;
      }
      // A retained uncertain request may replay an earlier stable occurrence
      // identity instead of the newly proposed client ID.
      appendFocusRequestRef.current = appended.id;
      const plannedWeight =
        appended.plannedExerciseId === exercise.exerciseId &&
        appended.plannedLoad != null &&
        appended.plannedLoadUnit != null
          ? convertWeight(
              appended.plannedLoad,
              appended.plannedLoadUnit,
              unit,
            )
          : (() => {
              const preview = resolveSetStartingLoad({
                exercise,
                setNumber: appended.kindOrdinal + 1,
                unit,
                loadEntryMeaning,
                occurrence: appended,
                comparisonTemporarilyUnavailable,
              });
              return preview.status === "available" ? preview.weight : null;
            })();
      setAppendedDraft({
        weight: plannedWeight,
        weightUnit: plannedWeight == null ? null : unit,
        reps:
          appended.plannedRepsMax ??
          appended.plannedRepsMin ??
          defaultReps,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        rir: null,
        techniqueIssue: null,
        limitationCause: null,
        pain: null,
        note: "",
      });
    } finally {
      appendRequestRef.current = null;
      setAppendingSet(false);
    }
  }

  function handleDelete(set: LoggedSet) {
    const previousSets = exercise.sets;
    onPatch({ sets: exercise.sets.filter((s) => s.id !== set.id) });
    startTransition(async () => {
      try {
        const result = await archiveSet(set.id);
        if (!result.ok) {
          onPatch({ sets: previousSets });
          toast.error(result.message);
          return;
        }
        toast.success("Set archived", {
          action: {
            label: "Undo",
            onClick: async () => {
              const restored = await restoreArchiveOperation(result.operationId);
              if (restored.ok) {
                toast.success("Set restored");
                router.refresh();
              } else {
                toast.error(restored.reason);
              }
            },
          },
        });
      } catch {
        onPatch({ sets: previousSets });
        toast.error("The set could not be archived.");
      }
    });
  }

  const plannedRows = Math.max(
    exercise.targetSets ?? 0,
    highestLoggedSetNo,
    highestOccurrenceSetNo,
    activeOccurrence?.kind === "working_set" ? activeOccurrence.kindOrdinal + 1 : 0,
  );
  const unconfirmedSet = exercise.sets.find(
    (set) => set.saveState != null && set.saveState !== "saved",
  );
  const activeLoggingBlocked = unconfirmedSetsBlockLogging({
    sets: exercise.sets,
    targetOccurrenceId: activeOccurrence?.id ?? null,
    blockers: setOrderBlockers,
  });
  const appendedLoggingBlocked = unconfirmedSetsBlockLogging({
    sets: exercise.sets,
    targetOccurrenceId: appendedOccurrence?.id ?? null,
    blockers: setOrderBlockers,
  });
  const exactActiveBlockerCanLog =
    unconfirmedSet != null && !activeLoggingBlocked;
  const prioritizeCurrentAction = nextActionLabel != null;
  // A failed or delayed write still owns its exact occurrence. Keep its
  // recovery row prominent even though a different locally retained
  // occurrence may now be logged without rolling the workout backward.
  const prioritizedRowIndex = exactActiveBlockerCanLog
    ? nextSetIdx
    : unconfirmedSet
      ? unconfirmedSet.setNo - 1
    : prioritizeCurrentAction
      ? nextSetIdx
      : null;
  const plannedRowOrder = Array.from(
    { length: plannedRows },
    (_, index) => index,
  ).sort((left, right) => {
    if (left === prioritizedRowIndex) return -1;
    if (right === prioritizedRowIndex) return 1;
    return left - right;
  });
  const isCurrentPlannedSet =
    activeOccurrence?.sessionExerciseId === exercise.id &&
    activeOccurrence.kind === "working_set" &&
    activeOccurrence.kindOrdinal === nextSetIdx;
  const ledgerOccurrences =
    activeOccurrence?.kind === "working_set" &&
    activeOccurrence.sessionExerciseId === exercise.id &&
    !workingOccurrences.some(
      (occurrence) => occurrence.id === activeOccurrence.id,
    )
      ? [...workingOccurrences, activeOccurrence]
      : workingOccurrences;
  const activeSetProjection = projectActiveSetRows({
    exercise,
    occurrences: ledgerOccurrences,
    currentOccurrenceId:
      activeOccurrence?.kind === "working_set" &&
      activeOccurrence.sessionExerciseId === exercise.id
        ? activeOccurrence.id
        : null,
    currentBlockingReason: activeLoggingBlocked
      ? "Resolve the retained device copy for this set before logging again."
      : null,
    versionEvidenceBySetId: exercise.versionEvidenceBySetId,
  });
  const diagnosticSetIds = new Set([
    ...activeSetProjection.diagnostics.unlinkedSetIds,
    ...activeSetProjection.diagnostics.duplicateSetIds,
  ]);
  const activeSetDiagnosticRows: ActiveSetLedgerDiagnosticRow[] = exercise.sets
    .filter((set) => diagnosticSetIds.has(set.id))
    .map((set) => ({
      key: `diagnostic-${set.id}`,
      label: `Recorded set ${set.setNo}`,
      summary: formatLoggedSet(set, exercise.metricType),
      result: activeSetExactResult(set),
      version:
        exercise.versionEvidenceBySetId?.[set.id] ??
        ((set.correctionCount ?? 0) > 0
          ? { state: "corrected", count: set.correctionCount ?? 0 }
          : null),
      message: activeSetProjection.diagnostics.duplicateSetIds.includes(set.id)
        ? "This result has more than one possible occurrence link and cannot be presented as saved."
        : "This result is not linked to a supported set occurrence and cannot be presented as saved.",
    }));
  const unsupportedCompletedSetIds = new Set([
    ...diagnosticSetIds,
    ...activeSetProjection.rows.flatMap((row) =>
      row.state === "unknown_legacy" && row.result != null
        ? [row.result.id]
        : [],
    ),
  ]);
  const acknowledgedCompletedSets = exercise.sets.filter(
    (set) =>
      (set.saveState == null || set.saveState === "saved") &&
      !unsupportedCompletedSetIds.has(set.id),
  );
  const currentLedgerRow = activeSetProjection.rows.find(
    (row) => row.state === "current_editable",
  );
  const currentLedgerOccurrence = currentLedgerRow == null
    ? null
    : ledgerOccurrences.find(
        (occurrence) => occurrence.id === currentLedgerRow.occurrenceId,
      ) ?? null;
  const nextPlannedLedgerRow = currentLedgerOccurrence == null
    ? activeSetProjection.rows.find(
        (row) => row.state === "planned" && row.membership !== "extra",
      ) ?? null
    : null;
  const currentLedgerIsAppended =
    currentLedgerOccurrence != null &&
    currentLedgerOccurrence.id === appendedOccurrence?.id;
  const currentLedgerDraft = currentLedgerIsAppended ? appendedDraft : draft;
  const setCurrentLedgerDraft = currentLedgerIsAppended
    ? setAppendedDraft
    : setDraft;
  const activeOccurrenceMutation = activeOccurrence == null
    ? null
    : occurrenceMutationEntries.find(
        (entry) => entry.occurrenceId === activeOccurrence.id,
      ) ?? null;
  const hasWarmupGuidance =
    exercise.modificationType !== "substituted" &&
    !!exercise.warmupNotes?.trim();
  const warmupGuidance = hasWarmupGuidance ? (
    <p className="mt-1 whitespace-pre-line text-muted-foreground">
      {exercise.warmupNotes}
    </p>
  ) : null;

  function rowNeedsImmediateAttention(index: number) {
    const set = exercise.sets.find(
      (candidate) => candidate.setNo === index + 1,
    );
    const occurrence =
      workingOccurrences.find(
        (candidate) => candidate.kindOrdinal === index,
      ) ?? null;
    const mutation =
      occurrence == null
        ? null
        : occurrenceMutationEntries.find(
            (entry) => entry.occurrenceId === occurrence.id,
          ) ?? null;

    return (
      index === nextSetIdx ||
      appendedOccurrence?.kindOrdinal === index ||
      (set?.saveState != null && set.saveState !== "saved") ||
      mutation != null ||
      (occurrence != null &&
        occurrence.outcome !== "pending" &&
        (occurrence.outcome !== "completed" || set == null))
    );
  }

  const disclosedRowOrder = plannedRowOrder.filter(
    (index) => !rowNeedsImmediateAttention(index),
  );

  function reconcileReplacement(
    candidate: ExerciseDiscoveryItem,
    state: ReplacementOptions["currentState"],
    plannedExerciseName: string,
  ) {
    const metricType = performedMetricTypeForLivePatch(candidate.metricType);
    if (!metricType) {
      toast.error(
        "This exercise measurement is not supported in the live workout.",
      );
      router.refresh();
      return;
    }
    onPatch({
      exerciseId: candidate.id,
      name: candidate.name,
      family: candidate.family,
      loadType: candidate.loadType,
      metricType,
      loadSemantics: candidate.loadSemantics,
      movementPattern: candidate.movementPattern,
      cautionBodyParts: candidate.cautionBodyParts,
      modificationType: state.modificationType,
      skipReason: state.skipReason,
      substitutedForExerciseId: state.substitutedForExerciseId,
      substitutionReason: state.substitutionReason,
      substitutedAt: state.substitutedAt,
      plannedExerciseName:
        state.substitutedForExerciseId == null ? null : plannedExerciseName,
      targetLoad: state.targetLoad,
      targetLoadUnit: state.targetLoadUnit,
      notes: state.notes,
      warmupNotes: state.warmupNotes,
      warmupSets: state.warmupSets,
      setNotes: state.setNotes,
      last: null,
      media: candidate.media ?? null,
    });
    setDraft((current) => ({
      ...current,
      weight:
        state.targetLoad != null && state.targetLoadUnit != null
          ? convertWeight(state.targetLoad, state.targetLoadUnit, unit)
          : null,
      weightUnit: state.targetLoad == null ? null : unit,
      note: state.setNotes[exercise.sets.length] ?? "",
    }));
    setNote(state.notes ?? "");
    router.refresh();
  }

  function applyReplacement(
    candidate: ExerciseDiscoveryItem,
    reason: ExerciseAlternativeReason,
  ) {
    const metricType = performedMetricTypeForLivePatch(candidate.metricType);
    if (!metricType) {
      toast.error(
        "This exercise measurement is not supported in the live workout.",
      );
      router.refresh();
      return;
    }
    onAdjustIntentChange(null);
    onPatch({
      exerciseId: candidate.id,
      name: candidate.name,
      family: candidate.family,
      loadType: candidate.loadType,
      metricType,
      loadSemantics: candidate.loadSemantics,
      movementPattern: candidate.movementPattern,
      cautionBodyParts: candidate.cautionBodyParts,
      modificationType: "substituted",
      skipReason: exercise.skipReason,
      substitutedForExerciseId:
        exercise.substitutedForExerciseId ?? exercise.exerciseId,
      substitutionReason: reason,
      substitutedAt: new Date().toISOString(),
      plannedExerciseName: exercise.plannedExerciseName ?? exercise.name,
      targetLoad: null,
      targetLoadUnit: null,
      notes: null,
      warmupNotes: null,
      warmupSets: [],
      setNotes: [],
      last: null,
      media: candidate.media ?? null,
    });
    setDraft((current) => ({
      ...current,
      weight: null,
      weightUnit: null,
      note: "",
    }));
    setAppendedDraft((current) => ({
      ...current,
      weight: null,
      weightUnit: null,
      note: "",
    }));
    setNote("");
  }

  function renderEditableLedgerRow(
    row: Extract<
      ActiveSetRow,
      { state: "planned" | "current_editable" }
    >,
  ) {
    const occurrenceForRow =
      ledgerOccurrences.find(
        (occurrence) => occurrence.id === row.occurrenceId,
      ) ?? null;
    if (occurrenceForRow == null) {
      return (
        <p role="alert" className="text-sm">
          This set occurrence is unavailable. Reload before recording.
        </p>
      );
    }
    const rowIsAppended = appendedOccurrence?.id === occurrenceForRow.id;
    const rowDraft = rowIsAppended ? appendedDraft : draft;
    const updateRowDraft = rowIsAppended ? setAppendedDraft : setDraft;
    const occurrenceMutation =
      occurrenceMutationEntries.find(
        (entry) => entry.occurrenceId === occurrenceForRow.id,
      ) ?? null;
    const occurrenceAcknowledged = acknowledgedOccurrenceIds.includes(
      occurrenceForRow.id,
    );
    const rowLoggingBlocked = rowIsAppended
      ? appendedLoggingBlocked
      : activeLoggingBlocked;
    const rowLogDisabled =
      pending ||
      skipConfirmationPending ||
      !metricSupported ||
      Boolean(occurrenceMutation) ||
      occurrenceChangesBlocked ||
      rowLoggingBlocked ||
      logRequestKey === occurrenceForRow.id;
    const usesFixedPrimaryAction =
      row.state === "current_editable" &&
      isCurrentExercise &&
      fixedPrimaryActionAvailable;
    const rowCommitFormId = activeSetCommitFormId(
      exercise.id,
      occurrenceForRow.id,
    );
    const rowSetNumber = occurrenceForRow.kindOrdinal + 1;
    const rowPreviousComparableSet = previousComparableSetFor(rowSetNumber);
    const rowComparableRenderState = comparisonTemporarilyUnavailable
      ? "loading"
      : comparableProjection?.status === "available" &&
          comparableSemanticsMatch &&
          rowPreviousComparableSet
        ? "available"
        : "unavailable";
    const rowStartingLoad = resolveSetStartingLoad({
      exercise,
      setNumber: rowSetNumber,
      unit,
      loadEntryMeaning,
      occurrence: occurrenceForRow,
      comparisonTemporarilyUnavailable,
    });
    const rowDefaultWeightSource = rowStartingLoad.status === "available"
      ? rowStartingLoad.source
      : null;
    const rowCompactDefaultWeightSource = rowDefaultWeightSource ===
        "Previous set in this workout"
      ? "earlier workout set"
      : rowDefaultWeightSource === "Previous comparable set"
        ? "prior comparable"
        : rowDefaultWeightSource;

    return (
      <div>
        <p className="active-set-measure-heading ui-metadata mb-1 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2">
          <span className="whitespace-nowrap">Performed measure</span>
          {recordsNumericLoad && rowDefaultWeightSource && (
            <span
              data-testid="performed-load-prefill-source"
              aria-label={`Starting load: ${rowDefaultWeightSource}`}
              className="active-set-prefill-source min-w-0 truncate text-right font-normal normal-case tracking-normal"
            >
              Load: {rowCompactDefaultWeightSource}
            </span>
          )}
        </p>
        {exercise.timedPrescription && occurrenceForRow.origin === "planned" && (
          <p className="mb-1 text-sm">{exercise.timedPrescription.minSeconds}–{exercise.timedPrescription.maxSeconds} sec on each side · both sides, then rest</p>
        )}
        <SetEntry
          metricType={performedMetricType}
          supported={metricSupported}
          draft={rowDraft}
          setDraft={updateRowDraft}
          onWeightEdit={() => {
            if (!rowIsAppended) {
              draftWeightEditedRef.current = true;
            }
          }}
          stepWeight={stepWeight}
          unit={unit}
          hasWeight={recordsNumericLoad}
          weightLabel={liveWeightLabel}
          plateConfig={plateConfig}
          machineLoadConfig={machineLoadConfig}
          prioritizePerformedMeasure
          compactLedger
        />
        <div
          data-testid="previous-comparable-set"
          data-comparison-state={rowComparableRenderState}
          className="mt-1 border-t pt-1 text-xs text-muted-foreground"
        >
          {rowComparableRenderState === "available" &&
          comparableProjection?.status === "available" &&
          rowPreviousComparableSet ? (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
              <div className="min-w-0">
                <p className="break-words">
                  Previous · {comparableProjection.source.localDate} ·{" "}
                  {compactComparableProvenance(
                    rowPreviousComparableSet,
                    comparableProjection.source.workoutSource,
                  )}
                </p>
                <p
                  className="mt-1 break-words font-medium tabular-nums text-foreground"
                  data-ui-essential="true"
                >
                  {formatPreviousComparableSet(
                    rowPreviousComparableSet,
                    comparableProjection.semantics.metricType,
                  )}{" "}
                  · source set {rowPreviousComparableSet.setNo}
                </p>
              </div>
              <Link
                href={comparableProjection.source.historyHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View source workout"
                className={cn(
                  buttonVariants({
                    variant: "ghost",
                    size: "sm",
                  }),
                  "min-h-11 min-w-11 shrink-0 px-2 text-xs",
                )}
              >
                Source
              </Link>
            </div>
          ) : rowComparableRenderState === "loading" ? (
            <p role="status">Checking previous comparable set…</p>
          ) : comparableProjection?.status === "unavailable" && comparableProjection.previousRecorded ? (
            <div className="space-y-1" data-testid="previous-recorded-set">
              <p>Last recorded · {comparableProjection.previousRecorded.localDate}: {comparableProjection.previousRecorded.weight ?? "load not recorded"} {comparableProjection.previousRecorded.weightUnit ?? ""}
                {comparableProjection.previousRecorded.reps != null ? ` × ${comparableProjection.previousRecorded.reps} reps` : ""}
              </p>
              <p>{comparableProjection.reason === "load_entry_meaning_unavailable"
                ? "Choose the current equipment and load meaning to check whether this load can be reused."
                : "This record exists, but its exercise measurements or equipment setup cannot be confirmed as comparable. Weight has not been filled from it."}</p>
              <Link href={comparableProjection.previousRecorded.historyHref} className="inline-flex min-h-11 items-center underline">View recorded workout</Link>
            </div>
          ) : comparableProjection?.status === "unavailable" &&
            comparableProjection.reason === "no_comparable_history" ? (
            <p>No earlier set found for this exact exercise</p>
          ) : (
            <p>Previous comparison unavailable</p>
          )}
        </div>
        <div
          className={cn(
            "mt-1 grid gap-2",
            rowIsAppended && "grid-cols-[minmax(0,1fr)_auto]",
          )}
        >
          {skipConfirmationError == null ? (
            <>
              <form
                id={rowCommitFormId}
                data-testid="active-set-commit-form"
                data-log-disabled={rowLogDisabled ? "true" : "false"}
                hidden
                onSubmit={(event) => {
                  event.preventDefault();
                  if (rowLogDisabled) return;
                  onPrepareSetLog(occurrenceForRow);
                  void handleLog(
                    occurrenceForRow.kindOrdinal + 1,
                    occurrenceForRow,
                    rowDraft,
                  );
                }}
              />
              {!usesFixedPrimaryAction && (
                occurrenceChangesBlocked ? (
                  <p className="flex min-h-11 items-center text-sm font-medium text-muted-foreground">
                    Resolve the equipment setup before logging this set.
                  </p>
                ) : (
                  <Button
                    data-testid="inline-log-set"
                    type="submit"
                    form={rowCommitFormId}
                    className="min-h-12 w-full text-base font-semibold"
                    disabled={rowLogDisabled}
                  >
                    <Check className="size-4" /> Log set
                  </Button>
                )
              )}
            </>
          ) : (
            <p className="flex min-h-11 items-center text-sm font-medium">
              Resolve the exercise skip before logging sets.
            </p>
          )}
          {rowIsAppended && row.state === "planned" && (
            <Button
              type="button"
              variant="outline"
              disabled={
                occurrenceChangesBlocked || Boolean(occurrenceMutation)
              }
              onClick={() => setSkipSetOccurrence(occurrenceForRow)}
            >
              Skip set
            </Button>
          )}
        </div>
        <OccurrenceSaveStatus
          entry={occurrenceMutation}
          displayLabel={row.label}
          runtimeState={
            occurrenceMutation
              ? occurrenceRuntimeSaveStates[occurrenceMutation.clientKey] ?? null
              : null
          }
          saved={occurrenceAcknowledged}
          onRetry={onRetryOccurrenceMutation}
          onDiscard={onDiscardOccurrenceMutation}
        />
        {!rowIsAppended && prioritizeCurrentAction && (
          <div className="mt-1 flex min-h-11 items-center gap-2 border-t">
            <p className="ui-metadata shrink-0">Next action</p>
            <p className="min-w-0 break-words py-2 text-sm">
              {nextActionLabel}
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <section
      id={`exercise-${exercise.id}`}
      aria-labelledby={`session-exercise-heading-${exercise.id}`}
      data-testid={isCurrentExercise ? "current-exercise-card" : undefined}
      data-current-set={isCurrentExercise ? "true" : "false"}
      data-draft-identity={draftIdentity}
      data-ui-surface={isCurrentExercise ? "selected" : "primary"}
      className={cn(
        "ui-surface scroll-mt-32 [&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11",
        exercise.supersetKey &&
          "ring-2 ring-violet-500/55",
        isSkipped && "border-dashed bg-muted/20"
      )}
      onClickCapture={() => {
        if (isCurrentPlannedSet) tapsRef.current += 1;
      }}
      onFocusCapture={() => {
        if (isCurrentPlannedSet) focusChangesRef.current += 1;
      }}
    >
      <div className="relative overflow-hidden rounded-t-xl">
        <button
          type="button"
          aria-label={`Remove ${exercise.name} from today`}
          aria-hidden={!removeSwipeRevealed}
          tabIndex={removeSwipeRevealed ? 0 : -1}
          className="absolute inset-y-0 right-0 z-0 flex w-24 items-center justify-center gap-1 bg-destructive px-2 text-sm font-semibold text-destructive-foreground"
          onClick={() => {
            setRemoveSwipeRevealed(false);
            setRemoveSwipeOffset(0);
            // The confirmation drawer lives with the expanded exercise tools.
            // A swipe is available on collapsed cards too, so mount those tools
            // before opening the destructive confirmation.
            if (!expanded) onToggle();
            onAdjustIntentChange("remove");
          }}
        >
          <Trash2 className="size-4" /> Remove
        </button>
        <button
          type="button"
          onClick={() => {
            if (removeSwipeRevealed) {
              setRemoveSwipeRevealed(false);
              setRemoveSwipeOffset(0);
              return;
            }
            onToggle();
          }}
          onTouchStart={(event) => {
            const touch = event.touches[0];
            if (!touch) return;
            removeSwipeStartRef.current = { x: touch.clientX, y: touch.clientY };
          }}
          onTouchMove={(event) => {
            const start = removeSwipeStartRef.current;
            const touch = event.touches[0];
            if (!start || !touch) return;
            const deltaX = touch.clientX - start.x;
            const deltaY = touch.clientY - start.y;
            if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) return;
            setRemoveSwipeOffset(
              Math.max(-96, Math.min(0, removeSwipeRevealed ? deltaX - 96 : deltaX)),
            );
          }}
          onTouchEnd={(event) => {
            const start = removeSwipeStartRef.current;
            const touch = event.changedTouches[0];
            removeSwipeStartRef.current = null;
            if (!start || !touch) return;
            const revealed = exerciseSwipeRevealsRemove({
              deltaX: touch.clientX - start.x,
              deltaY: touch.clientY - start.y,
            });
            setRemoveSwipeRevealed(revealed);
            setRemoveSwipeOffset(revealed ? -96 : 0);
          }}
          onTouchCancel={() => {
            removeSwipeStartRef.current = null;
            setRemoveSwipeOffset(removeSwipeRevealed ? -96 : 0);
          }}
          aria-expanded={expanded}
          aria-controls={`session-exercise-details-${exercise.id}`}
          data-testid="exercise-swipe-surface"
          className={cn(
            "ui-motion-immediate relative z-10 flex w-full items-start justify-between gap-2 p-2 text-left transition-transform",
            isCurrentExercise
              ? "bg-[var(--surface-selected)]"
              : "bg-[var(--surface-primary)]",
          )}
          style={{
            transform: `translateX(${removeSwipeOffset}px)`,
            touchAction: "pan-y",
          }}
        >
        <ExerciseFamilyIcon
          media={exercise.media}
          family={exercise.family}
          exerciseName={exercise.name}
          movementPattern={exercise.movementPattern}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <h2
              id={`session-exercise-heading-${exercise.id}`}
              className={cn(
                "min-w-0 flex-1 break-words [overflow-wrap:anywhere] font-medium",
                isCurrentExercise
                  ? "break-words text-lg font-semibold leading-tight"
                  : "text-base leading-snug",
              )}
            >
              {exercise.name}
            </h2>
            {exercise.cautionBodyParts.length > 0 && (
              <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
            )}
          </div>
          <p className="break-words text-xs leading-5 text-muted-foreground">
            {isSkipped
              ? `Skipped (${skipReasonLabel(exercise.skipReason ?? "unknown")})`
              : exercise.modificationType === "added"
                ? `${progress.workoutOnlyPerformed}/${progress.workoutOnly || "–"} done${progress.extraPerformed > 0 ? ` · ${progress.extraPerformed} extra` : ""}${deviceSaveSummary ? ` · ${deviceSaveSummary}` : ""} · Workout only`
                : isCurrentExercise
                  ? `${progress.plannedPerformed} of ${progress.planned || "–"} sets${progress.extraPerformed > 0 ? ` · ${progress.extraPerformed} extra` : ""}${deviceSaveSummary ? ` · ${deviceSaveSummary}` : ""} · ${formatRestTime(exercise.restSec)} rest`
                  : `${progress.plannedPerformed}/${progress.planned || "–"} planned performed${progress.extraPerformed > 0 ? ` · ${progress.extraPerformed} extra` : ""}${deviceSaveSummary ? ` · ${deviceSaveSummary}` : ""} · ${targetText} · ${formatRestTime(exercise.restSec)} rest`}
            {exercise.modificationType === "substituted" &&
              ` · instead of ${exercise.plannedExerciseName ?? "planned exercise"}`}
          </p>
          {groupContext && (
            <p className="mt-1 rounded-md bg-violet-600 px-2 py-1 text-xs font-bold uppercase tracking-[0.08em] text-white">
              Superset · {groupContext.name} · Exercise {groupContext.memberOrder} of{" "}
              {groupContext.memberCount}
            </p>
          )}
          {(exercise.modificationType === "added" || exercise.supersetKey) && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {exercise.modificationType === "added" && (
                <Badge variant="outline">Workout only</Badge>
              )}
              {exercise.supersetKey && (
                <Badge
                  variant="outline"
                  aria-label="Part of a superset"
                  className="border-violet-500 font-semibold text-violet-900 dark:text-violet-100"
                >
                  Superset
                </Badge>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ChevronDown
            className={cn(
              "size-4 transition-transform motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
          />
        </div>
        </button>
      </div>

      {equipmentDecision}

      {expanded && !isSkipped && skipConfirmationPending && (
        <div
          id={`session-exercise-details-${exercise.id}`}
          role="status"
          className="border-t p-3"
        >
          <p className="font-medium">Checking the exercise skip…</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Repbook is confirming the saved workout state. Set logging stays
            paused so this exercise cannot be recorded against stale details.
          </p>
        </div>
      )}

      {expanded && !isSkipped && !skipConfirmationPending && (
        <div
          id={`session-exercise-details-${exercise.id}`}
          className="flex flex-col gap-1.5 border-t px-2 py-1.5"
        >
          {/* The current action and unresolved writes stay outside disclosure. */}
          <div className="flex flex-col gap-1">
            {skipConfirmationError && (
              <div
                id={`skip-recovery-description-${exercise.id}`}
                role="status"
                className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
              >
                <p className="font-medium">Skip was not confirmed</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {skipConfirmationError}
                </p>
                <div className="mt-2 grid gap-2 min-[420px]:grid-cols-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onAdjustIntentChange("skip")}
                  >
                    Try skipping again
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      startTransition(async () => {
                        await onSkipConfirmationErrorDismiss();
                      });
                    }}
                  >
                    {pending ? "Checking saved state…" : "Return to current set"}
                  </Button>
                </div>
              </div>
            )}
            {preparationBlocker && currentLedgerRow == null && (
              <div
                role="status"
                className="rounded-lg bg-[var(--surface-attention)] px-3 py-2 text-sm"
              >
                <p>
                  Complete {preparationBlocker.blockerExerciseName ?? exercise.name} preparation set first.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Starting load: {setStartingLoadPreviewText(startingLoad)}
                </p>
                {preparationBlocker.blockerTargetId && onRevealBlocker && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 h-auto min-h-11 w-full whitespace-normal"
                    onClick={() =>
                      onRevealBlocker(preparationBlocker.blockerTargetId!)
                    }
                  >
                    Go to preparation set
                  </Button>
                )}
              </div>
            )}
            <ActiveSetLedger
              exerciseId={exercise.id}
              exerciseName={exercise.name}
              metricType={performedMetricType}
              rows={activeSetProjection.rows}
              diagnostics={activeSetProjection.diagnostics}
              diagnosticRows={activeSetDiagnosticRows}
              renderCurrentRow={renderEditableLedgerRow}
              renderPlannedRow={(row) =>
                appendedOccurrence?.id === row.occurrenceId
                  ? renderEditableLedgerRow(row)
                  : null
              }
              renderPlannedRowDetail={(row) =>
                row.occurrenceId === nextPlannedLedgerRow?.occurrenceId ? (
                  <div className="mt-1 border-t pt-1 text-xs text-muted-foreground">
                    <p>
                      {activeLoggingBlocked
                        ? "Resolve the retained copy for this set"
                        : preparationBlocker
                          ? `Complete ${preparationBlocker.blockerExerciseName ?? exercise.name} preparation set first`
                          : "Reach this set in the workout flow"}
                    </p>
                    <p
                      data-testid="upcoming-set-load-preview"
                      className="mt-1 font-medium text-foreground"
                    >
                      Starting load: {setStartingLoadPreviewText(startingLoad)}
                    </p>
                  </div>
                ) : null
              }
              renderSaveRecovery={(row) => {
                const set =
                  exercise.sets.find(
                    (candidate) =>
                      candidate.id === row.result.id ||
                      (row.clientKey != null &&
                        candidate.clientKey === row.clientKey),
                  ) ?? null;
                if (set == null || row.state !== "failed") return null;
                return (
                  <PendingSetSaveStatus
                    set={set}
                    rowLabel={row.label}
                    orderBlocker={
                      set.clientKey == null
                        ? null
                        : (setOrderBlockers[set.clientKey] ?? null)
                    }
                    reviewRequired={
                      set.clientKey == null
                        ? false
                        : (setReviewRequired[set.clientKey] ?? false)
                    }
                    onRevealBlocker={onRevealBlocker}
                    onRefreshWorkout={onRefreshWorkout}
                    onRetry={onRetrySet}
                    onDiscard={onDiscardSet}
                  />
                );
              }}
              renderOutcomeStatus={(row) => {
                const occurrenceMutation =
                  occurrenceMutationEntries.find(
                    (entry) => entry.occurrenceId === row.occurrenceId,
                  ) ?? null;
                return (
                  <OccurrenceSaveStatus
                    entry={occurrenceMutation}
                    displayLabel={row.label}
                    saved={
                      occurrenceMutation == null ||
                      acknowledgedOccurrenceIds.includes(row.occurrenceId)
                    }
                    runtimeState={
                      occurrenceMutation == null
                        ? null
                        : occurrenceRuntimeSaveStates[
                            occurrenceMutation.clientKey
                          ] ?? null
                    }
                    onRetry={onRetryOccurrenceMutation}
                    onDiscard={onDiscardOccurrenceMutation}
                  />
                );
              }}
            />
            {currentLedgerOccurrence && (
              <div
                data-testid="current-set-secondary-actions"
                className={cn(
                  "grid gap-1.5",
                  exercise.sets.length === 0 ? "grid-cols-3" : "grid-cols-2",
                )}
              >
                {exercise.sets.length === 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="replace-current-exercise"
                    onClick={() => onAdjustIntentChange("replace")}
                  >
                    Replace
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    occurrenceChangesBlocked ||
                    activeOccurrenceMutation != null
                  }
                  onClick={() =>
                    setSkipSetOccurrence(currentLedgerOccurrence)
                  }
                >
                  Skip set
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Add extra set"
                  disabled={
                    Boolean(unconfirmedSet) ||
                    appendingSet ||
                    Boolean(appendedOccurrence)
                  }
                  onClick={() => void handleAppendSet()}
                >
                  {appendingSet ? "Adding…" : "Add set"}
                </Button>
              </div>
            )}
          </div>

            {activeInsight && (
              <AthleteInsight
                insight={activeInsight}
                className="mt-1 border-primary/20 bg-primary/[0.035]"
                onAction={() => onExplainInsight(activeInsight)}
              />
            )}

            <details
              data-testid="active-exercise-details"
              className="rounded-lg border bg-muted/15 text-sm"
            >
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-2 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                <span>More for this exercise</span>
                <span className="break-words text-right text-xs font-normal text-muted-foreground">
                  Set options · Completed sets · Extra sets
                </span>
              </summary>
              <div className="space-y-3 border-t p-2">
                {currentLedgerOccurrence && !resting ? (
                  <section
                    aria-labelledby={`optional-set-fields-${exercise.id}`}
                    className="rounded-lg border bg-background p-3"
                  >
                    <h3
                      id={`optional-set-fields-${exercise.id}`}
                      className="mb-2 font-medium"
                    >
                      Additional set details
                    </h3>
                    <SetEntry
                      metricType={performedMetricType}
                      supported={metricSupported}
                      draft={currentLedgerDraft}
                      setDraft={setCurrentLedgerDraft}
                      onWeightEdit={() => {
                        if (!currentLedgerIsAppended) {
                          draftWeightEditedRef.current = true;
                        }
                      }}
                      stepWeight={stepWeight}
                      unit={unit}
                      hasWeight={recordsNumericLoad}
                      weightLabel={liveWeightLabel}
                      plateConfig={plateConfig}
                      machineLoadConfig={machineLoadConfig}
                      optionalOnly
                    />
                  </section>
                ) : null}

                {appendedOccurrence &&
                appendedOccurrence.id !== currentLedgerOccurrence?.id ? (
                  <section
                    aria-labelledby={`optional-extra-set-fields-${exercise.id}`}
                    className="rounded-lg border bg-background p-3"
                  >
                    <h3
                      id={`optional-extra-set-fields-${exercise.id}`}
                      className="mb-2 font-medium"
                    >
                      Additional set details ·{" "}
                      {workingSetDisplayPosition(
                        appendedOccurrence,
                        workingOccurrences,
                      ).label}
                    </h3>
                    <SetEntry
                      metricType={performedMetricType}
                      supported={metricSupported}
                      draft={appendedDraft}
                      setDraft={setAppendedDraft}
                      stepWeight={stepWeight}
                      unit={unit}
                      hasWeight={recordsNumericLoad}
                      weightLabel={liveWeightLabel}
                      plateConfig={plateConfig}
                      machineLoadConfig={machineLoadConfig}
                      optionalOnly
                    />
                  </section>
                ) : null}

                <section
                  data-testid="completed-sets"
                  aria-labelledby={`completed-sets-heading-${exercise.id}`}
                  className="rounded-lg border bg-background text-sm"
                >
                  <div className="flex min-h-[44px] items-center justify-between gap-2 rounded-lg px-2 py-1 font-medium">
                    <h3 id={`completed-sets-heading-${exercise.id}`}>
                      Completed sets
                    </h3>
                    <span className="shrink-0 text-xs font-normal text-muted-foreground">
                      {acknowledgedCompletedSets.length} completed
                    </span>
                  </div>
                  <div className="space-y-2 border-t p-2">
                {disclosedRowOrder.map((i) => {
                  const set = acknowledgedCompletedSets.find(
                    (candidate) => candidate.setNo === i + 1,
                  );
                  const occurrenceForRow =
                    workingOccurrences.find(
                      (occurrence) => occurrence.kindOrdinal === i,
                    ) ?? null;
                  const rowPosition =
                    occurrenceForRow == null
                      ? null
                      : workingSetDisplayPosition(
                          occurrenceForRow,
                          workingOccurrences,
                        );
                  if (set) {
                    return (
                      <div
                        key={set.id}
                        id={`logged-set-${exercise.id}-${set.setNo}`}
                        className="rounded-md bg-primary/5 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-muted-foreground">
                            {rowPosition?.label ?? `Set ${i + 1}`}
                          </span>
                          <span className="text-right font-medium tabular-nums">
                            {formatLoggedSet(set, exercise.metricType)}
                            {set.rpe != null &&
                              ` · ${effortChoiceForLegacyRpe(set.rpe)?.label ?? `RPE ${set.rpe}`}`}
                            <Check className="ml-2 inline size-3.5 text-green-600" />
                          </span>
                        </div>
                        {set.note && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {set.note}
                          </p>
                        )}
                        {formatLoggedExceptionContext(set).map((context) => (
                          <p
                            key={context}
                            className="mt-1 text-xs text-muted-foreground"
                          >
                            {context}
                          </p>
                        ))}
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                          <span className="text-xs text-muted-foreground">
                            {(set.correctionCount ?? 0) > 0
                              ? `${set.correctionCount} saved correction${
                                  set.correctionCount === 1 ? "" : "s"
                                } · original retained in Edit history`
                              : "Acknowledged by Repbook"}
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {(set.metricType ?? performedMetricType) ===
                            "activity" ? (
                              <span className="self-center text-xs text-muted-foreground">
                                Correction unavailable for this legacy shape
                              </span>
                            ) : (
                              <CompletedSetCorrection
                                setId={set.id}
                                setNo={set.setNo}
                                weight={set.weight}
                                weightUnit={set.weightUnit}
                                reps={set.reps}
                                distanceKm={set.distanceKm ?? null}
                                durationSeconds={set.durationSeconds ?? null}
                                metricType={
                                  set.metricType ?? performedMetricType
                                }
                                rpe={set.rpe}
                                note={set.note}
                                historyRevision={historyRevision}
                                source="active_workout"
                                onAcknowledged={(result) => {
                                  const currentVersionEvidence =
                                    exercise.versionEvidenceBySetId?.[set.id];
                                  onPatch({
                                    sets: exercise.sets.map((candidate) =>
                                      candidate.id === set.id
                                        ? {
                                            ...candidate,
                                            ...result.values,
                                            correctionCount:
                                              (candidate.correctionCount ?? 0) +
                                              1,
                                          }
                                        : candidate,
                                    ),
                                    versionEvidenceBySetId: {
                                      ...exercise.versionEvidenceBySetId,
                                      [set.id]: activeSetVersionEvidenceAfterCorrection(
                                        currentVersionEvidence,
                                        set.correctionCount ?? 0,
                                      ),
                                    },
                                  });
                                  onHistoryRevisionChange(
                                    result.historyRevision,
                                  );
                                  const measurement =
                                    readActiveWorkoutMeasurements().find(
                                      (record) =>
                                        (set.clientKey != null &&
                                          record.clientKey === set.clientKey) ||
                                        record.setId === set.id,
                                    );
                                  if (measurement) {
                                    patchActiveWorkoutMeasurement(
                                      measurement.clientKey,
                                      {
                                        corrections:
                                          measurement.corrections + 1,
                                      },
                                    );
                                  }
                                }}
                              />
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              onClick={() => handleDelete(set)}
                              aria-label="Archive set"
                            >
                              <Archive className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return null;
                })}
                {acknowledgedCompletedSets.length === 0 && (
                  <p className="rounded-md border border-dashed px-3 py-2 text-muted-foreground">
                    No completed sets yet.
                  </p>
                )}
                  </div>
                </section>

                <section
                  aria-labelledby={`extra-sets-heading-${exercise.id}`}
                  className="rounded-lg border bg-background text-sm"
                >
              <div className="flex min-h-[44px] items-center justify-between gap-2 rounded-lg px-2 py-1 font-medium">
                <h3 id={`extra-sets-heading-${exercise.id}`}>Extra sets</h3>
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  Add only if needed
                </span>
              </div>
              <div className="space-y-2 border-t p-2">
                {currentLedgerOccurrence == null && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start border-dashed"
                    disabled={
                      Boolean(unconfirmedSet) ||
                      appendingSet ||
                      Boolean(appendedOccurrence)
                    }
                    aria-describedby={`add-set-description-${exercise.id}`}
                    onClick={() => void handleAppendSet()}
                  >
                    <Plus className="size-4" />
                    {appendingSet ? "Adding extra set…" : "Add extra set"}
                  </Button>
                )}
                <p
                  id={`add-set-description-${exercise.id}`}
                  className="px-1 text-xs text-muted-foreground"
                >
                  Adds ad-hoc work without changing the planned set order.
                  Finish or skip that extra before adding one more.
                </p>
              </div>
                </section>

          <section
            aria-labelledby={`exercise-actions-heading-${exercise.id}`}
            className="rounded-lg border bg-background text-sm"
          >
            <div className="flex min-h-[44px] items-center justify-between gap-2 rounded-lg px-2 py-1 font-medium">
              <h3 id={`exercise-actions-heading-${exercise.id}`}>Exercise actions</h3>
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                Notes, form &amp; swaps
              </span>
            </div>
            <div className="space-y-3 border-t p-2">
          <div className="flex flex-col gap-2" data-testid="exercise-reference-context">
            {exercise.modificationType === "added" && (
              <p className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-sm">
                Added during this workout. It has no Program slot or progression
                target, and your Program remains unchanged.
              </p>
            )}
            {exercise.cautionBodyParts.length > 0 && (
              <p className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                Take care of your {exercise.cautionBodyParts.join(" and ")} — stop
                if pain goes above mild.
              </p>
            )}
            {exercise.modificationType === "substituted" && (
              <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                <p className="font-medium">
                  Using {exercise.name} instead of {exercise.plannedExerciseName ?? "the planned exercise"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Reason: {exercise.substitutionReason
                    ? SUBSTITUTION_REASON_LABELS[exercise.substitutionReason]
                    : "Not recorded"}. Exercise-specific loads, warm-ups, and cues from the plan do not carry over.
                </p>
              </div>
            )}
            {warmupGuidance && (
              warmupResolved ? (
                <details className="rounded-md border bg-muted/30 text-xs">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                    <span>Warm-up guidance · reference</span>
                    <span className="text-muted-foreground">Show details</span>
                  </summary>
                  <div className="border-t px-3 pb-2">{warmupGuidance}</div>
                </details>
              ) : (
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                  <p className="font-medium text-foreground">
                    Warm-up guidance · not a check-off item
                  </p>
                  {warmupGuidance}
                </div>
              )
            )}
          </div>

          <section
            aria-labelledby={`workout-actions-${exercise.id}`}
            className="rounded-lg border bg-background/70 p-3"
          >
            <h3
              id={`workout-actions-${exercise.id}`}
              className="text-sm font-semibold"
            >
              Workout actions
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              These affect this workout only. They do not rewrite the saved Program.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onAdjustIntentChange("note")}
              >
                Add note
              </Button>
              <PainDrawer
                exerciseId={exercise.id}
                defaultBodyPart={exercise.cautionBodyParts[0]}
              />
              <SkipDrawer
                exerciseId={exercise.id}
                exerciseName={exercise.name}
                expectedHistoryRevision={historyRevision}
                open={adjustIntent === "skip" || adjustIntent === "skip_equipment"}
                allowEquipmentReason={equipmentReasonAvailable}
                forcedReason={
                  adjustIntent === "skip_equipment" && equipmentReasonAvailable
                    ? "equipment_unavailable_incompatible"
                    : undefined
                }
                onRequestStart={onSkipRequestStart}
                onRequestFailure={onSkipRequestFailure}
                onOpenChange={(open) =>
                  onAdjustIntentChange(
                    open
                      ? adjustIntent === "skip_equipment"
                        ? "skip_equipment"
                        : "skip"
                      : null,
                  )
                }
                onDone={(reason, resultHistoryRevision) => {
                  onAdjustIntentChange(null);
                  onHistoryRevisionChange(resultHistoryRevision);
                  onPatch({ modificationType: "skipped", skipReason: reason });
                }}
              />
              <Button
                type="button"
                variant="destructive"
                onClick={() => onAdjustIntentChange("remove")}
              >
                <Trash2 className="size-4" /> Remove from today
              </Button>
            </div>
          </section>

          <RemoveFromTodayDrawer
            exercise={exercise}
            futureProgramRemoval={futureProgramRemoval}
            expectedHistoryRevision={historyRevision}
            open={adjustIntent === "remove"}
            onOpenChange={(open) =>
              onAdjustIntentChange(open ? "remove" : null)
            }
            onRequestStart={onSkipRequestStart}
            onRequestFailure={onSkipRequestFailure}
            onRemoved={(resultHistoryRevision) => {
              onAdjustIntentChange(null);
              onHistoryRevisionChange(resultHistoryRevision);
              onPatch({ modificationType: "skipped", skipReason: "user_choice" });
              onSkipComplete();
              toast.success(`${exercise.name} removed from today`, {
                description:
                  "Completed sets stay in workout history. The saved routine is unchanged.",
                action: {
                  label: "Undo",
                  onClick: async () => {
                    try {
                      const restored = await withDocumentActionDeadline(
                        confirmExerciseUnskipped({
                          sessionExerciseId: exercise.id,
                          expectedHistoryRevision: resultHistoryRevision,
                        }),
                      );
                      if (!restored.ok) {
                        toast.error(restored.message);
                        if (restored.code === "unskip_stale") router.refresh();
                        return;
                      }
                      onHistoryRevisionChange(restored.historyRevision);
                      onPatch({
                        modificationType: restored.modificationType,
                        skipReason: null,
                      });
                      toast.success(`${exercise.name} restored to today`);
                    } catch (error) {
                      if (isDocumentActionTimeout(error)) {
                        reportDocumentActionTimeout();
                        toast.error(
                          "Repbook did not confirm Undo in time. Reload to reconcile the saved workout safely.",
                        );
                      } else {
                        toast.error("Repbook could not restore the exercise.");
                      }
                    }
                  },
                },
              });
            }}
          />

          <section
            aria-labelledby={`coach-tools-${exercise.id}`}
            className="rounded-lg border bg-background/70 p-3"
          >
            <h3 id={`coach-tools-${exercise.id}`} className="text-sm font-semibold">
              Coaching and form
            </h3>
            <p
              id={`coach-tools-description-${exercise.id}`}
              className="mt-1 text-xs text-muted-foreground"
            >
              Ask Coach gives guidance. It does not change the exercise.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                aria-describedby={`coach-tools-description-${exercise.id}`}
                onClick={onOpenCoach}
              >
                <MessageSquareText className="size-4" /> Ask Coach
              </Button>
              <Drawer>
                <DrawerTrigger render={<Button type="button" variant="outline" />}>
                  <PlayCircle className="size-4" /> Form guide
                </DrawerTrigger>
                <DrawerContent>
                  <DrawerHeader>
                    <DrawerTitle>{exercise.name} form guide</DrawerTitle>
                  </DrawerHeader>
                  <div className="max-h-[70dvh] overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
                    <ExerciseReferenceMedia
                      media={exercise.media}
                      exerciseName={exercise.name}
                    />
                  </div>
                </DrawerContent>
              </Drawer>
            </div>
          </section>

          {exercise.sets.length === 0 && (
            <section
              aria-labelledby={`change-exercise-${exercise.id}`}
              className="rounded-lg border bg-background/70 p-3"
            >
              <h3
                id={`change-exercise-${exercise.id}`}
                className="text-sm font-semibold"
              >
                Change exercise for this workout
              </h3>
              <p
                id={`change-exercise-description-${exercise.id}`}
                className="mt-1 text-xs text-muted-foreground"
              >
                Use ranked compatible alternatives, or deliberately replace
                the exercise from the broader strength catalog. Both are
                separate from coaching and leave your saved Program unchanged.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <div className="min-w-0 flex-1 basis-52 rounded-md border bg-card p-3">
                  <h4 className="text-sm font-semibold">Compatible alternatives</h4>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Choose from reviewed alternatives. Ranked choices keep a
                    related movement and fit your current equipment and
                    constraints.
                  </p>
                  <div className="mt-2">
                    <AlternativesDrawer
                      exerciseId={exercise.id}
                      describedBy={`change-exercise-description-${exercise.id}`}
                      open={adjustIntent === "swap"}
                      onOpenChange={(open) =>
                        onAdjustIntentChange(open ? "swap" : null)
                      }
                      onDone={applyReplacement}
                    />
                  </div>
                </div>
                <div className="min-w-0 flex-1 basis-52 rounded-md border bg-card p-3">
                  <h4 className="text-sm font-semibold">Replace exercise</h4>
                  <p
                    id={`replace-exercise-description-${exercise.id}`}
                    className="mt-1 text-xs leading-5 text-muted-foreground"
                  >
                    Search the full authorized strength catalog without
                    similarity ranking. Missing equipment is warned, not
                    invented.
                  </p>
                  <div className="mt-2">
                    <ReplacementDrawer
                      exerciseId={exercise.id}
                      describedBy={`replace-exercise-description-${exercise.id}`}
                      open={
                        adjustIntent === "replace" ||
                        adjustIntent === "replace_equipment"
                      }
                      forcedReason={
                        adjustIntent === "replace_equipment"
                          ? "equipment_unavailable_incompatible"
                          : undefined
                      }
                      onOpenChange={(open) =>
                        onAdjustIntentChange(
                          open
                            ? adjustIntent === "replace_equipment"
                              ? "replace_equipment"
                              : "replace"
                            : null,
                        )
                      }
                      onReconcile={reconcileReplacement}
                      onDone={applyReplacement}
                    />
                  </div>
                </div>
                {exercise.modificationType === "substituted" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        try {
                          const restored = await undoExerciseSubstitution(exercise.id);
                          if (!restored.ok) {
                            toast.error(restored.message);
                            return;
                          }
                          const metricType = performedMetricTypeForLivePatch(
                            restored.exercise.metricType,
                          );
                          if (!metricType) {
                            toast.error(
                              "This exercise measurement is not supported in the live workout.",
                            );
                            router.refresh();
                            return;
                          }
                          onPatch({
                            exerciseId: restored.exercise.id,
                            name: restored.exercise.name,
                            family: restored.exercise.family,
                            loadType: restored.exercise.loadType,
                            metricType,
                            loadSemantics: restored.exercise.loadSemantics,
                            movementPattern: restored.exercise.movementPattern,
                            cautionBodyParts: restored.exercise.cautionBodyParts,
                            modificationType: restored.modificationType,
                            skipReason: restored.skipReason,
                            substitutedForExerciseId:
                              restored.substitutedForExerciseId,
                            substitutionReason: restored.substitutionReason,
                            substitutedAt: restored.substitutedAt,
                            plannedExerciseName: restored.substitutedForExerciseId
                              ? exercise.plannedExerciseName
                              : null,
                            targetLoad: restored.targetLoad,
                            targetLoadUnit: restored.targetLoadUnit,
                            notes: restored.notes,
                            warmupNotes: restored.warmupNotes,
                            warmupSets: restored.warmupSets,
                            setNotes: restored.setNotes,
                            media: restored.exercise.media ?? null,
                          });
                          setDraft((current) => ({
                            ...current,
                            weight:
                              restored.targetLoad != null &&
                              restored.targetLoadUnit != null
                                ? convertWeight(
                                    restored.targetLoad,
                                    restored.targetLoadUnit,
                                    unit,
                                  )
                                : null,
                            weightUnit: restored.targetLoad == null ? null : unit,
                            note: restored.setNotes[exercise.sets.length] ?? "",
                          }));
                          toast.success("Alternative undone");
                        } catch {
                          toast.error("The alternative could not be undone.");
                        }
                      })
                    }
                  >
                    Undo alternative
                  </Button>
                )}
              </div>
            </section>
          )}

            </div>
          </section>
              </div>
            </details>

          <Drawer
            open={adjustIntent === "note"}
            onOpenChange={(open) => onAdjustIntentChange(open ? "note" : null)}
          >
            <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11 [&_textarea]:min-h-11">
              <DrawerHeader>
                <DrawerTitle>Add note for {exercise.name}</DrawerTitle>
              </DrawerHeader>
              <div className="max-h-[65dvh] space-y-3 overflow-y-auto px-4 pb-6">
                <p className="text-sm text-muted-foreground">
                  This note stays with this exercise in the active workout.
                </p>
                <Textarea
                  aria-label="Exercise note"
                  placeholder="Note for this exercise…"
                  value={note}
                  maxLength={EXERCISE_NOTE_MAX_LENGTH}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      try {
                        const result = await saveExerciseNote(exercise.id, note);
                        if (!result.ok) {
                          toast.error(result.message);
                          return;
                        }
                      } catch {
                        toast.error("The exercise note was not saved.");
                        return;
                      }
                      onPatch({ notes: note.trim() || null });
                      onAdjustIntentChange(null);
                      toast.success("Exercise note saved");
                    })
                  }
                >
                  Save note
                </Button>
              </div>
            </DrawerContent>
          </Drawer>
        </div>
      )}

      {expanded && isSkipped && skipRecoverySettlementPending && (
        <div className="border-t p-3">
          <div role="status" className="rounded-lg border bg-background p-3">
            <h3 className="text-sm font-semibold">Checking saved skip…</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Repbook is loading the confirmed workout revision before it offers
              replacement or continuation actions.
            </p>
          </div>
        </div>
      )}

      {expanded && isSkipped && !skipRecoverySettlementPending && (
        <div className="flex flex-col gap-3 border-t p-3">
          <div
            id={`skip-recovery-description-${exercise.id}`}
            role="status"
            className="rounded-lg border bg-background p-3"
          >
            <h3 className="text-sm font-semibold">Exercise skipped</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              This exercise is skipped for today. Keep it skipped and continue,
              replace it for today, or restore it. Your Program is unchanged.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <ReplacementDrawer
              exerciseId={exercise.id}
              describedBy={`skip-recovery-description-${exercise.id}`}
              open={
                adjustIntent === "replace" ||
                adjustIntent === "replace_equipment"
              }
              forcedReason={
                adjustIntent === "replace_equipment"
                  ? "equipment_unavailable_incompatible"
                  : undefined
              }
              onOpenChange={(open) =>
                onAdjustIntentChange(
                  open
                    ? adjustIntent === "replace_equipment"
                      ? "replace_equipment"
                      : "replace"
                    : null,
                )
              }
              onReconcile={reconcileReplacement}
              onDone={applyReplacement}
            />
            <Button type="button" onClick={onSkipComplete}>
              Keep skipped and continue
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    const result = await withDocumentActionDeadline(
                      confirmExerciseUnskipped({
                        sessionExerciseId: exercise.id,
                        expectedHistoryRevision: historyRevision,
                      }),
                    );
                    if (!result.ok) {
                      toast.error(result.message);
                      if (result.code === "unskip_stale") router.refresh();
                      return;
                    }
                    onHistoryRevisionChange(result.historyRevision);
                  } catch (error) {
                    if (isDocumentActionTimeout(error)) {
                      reportDocumentActionTimeout();
                      toast.error(
                        "Repbook did not confirm the restore in time. Reload before trying again.",
                      );
                      return;
                    }
                    if (reportDeploymentMismatch(error)) return;
                    toast.error("The exercise could not be restored.");
                    return;
                  }
                  onPatch({
                    modificationType: exercise.substitutedForExerciseId
                      ? "substituted"
                      : "as_planned",
                    skipReason: null,
                  });
                })
              }
            >
              Un-skip
            </Button>
          </div>
        </div>
      )}
      <OccurrenceMutationDialog
        open={skipSetOccurrence != null}
        onOpenChange={(open) => {
          if (!open) setSkipSetOccurrence(null);
        }}
        mode="skip"
        allowEquipmentReason={equipmentReasonAvailable}
        itemLabel={`${
          skipSetOccurrence
            ? workingSetDisplayPosition(
                skipSetOccurrence,
                workingOccurrences,
              ).lowercaseLabel
            : `set ${nextSetNo}`
        } of ${exercise.name}`}
        initialNote={null}
        onConfirm={(input) =>
          onSkipSet(input, skipSetOccurrence)
        }
      />
    </section>
  );
}

function SetEffortInput({ draft, setDraft }: {
  draft: SetDraft;
  setDraft: React.Dispatch<React.SetStateAction<SetDraft>>;
}) {
  const effortId = useId();
  const exactRpeId = useId();
  const exactRirId = useId();
  const [exactOpen, setExactOpen] = useState(
    draft.rir != null || (draft.rpe != null && !RPE_CHIPS.some((chip) => chip.value === draft.rpe)),
  );
  return <div className="space-y-2" data-testid="set-effort-input">
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">RPE · optional</legend>
        <div className="grid grid-cols-3 gap-1 min-[370px]:grid-cols-5">
          {[{ value: null, label: "Not recorded", shortcutLabel: "Not recorded", meaning: "Effort unknown" }, ...RPE_CHIPS].map((chip) => (
            <label key={chip.value ?? "unknown"} className={cn(
              "relative flex min-h-11 min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md border px-0.5 py-1 text-xs has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
              draft.rpe === chip.value && draft.rir == null && "border-primary bg-primary/10",
            )}>
              <input type="radio" name={effortId} value={chip.value ?? "unknown"}
                aria-label={`${chip.shortcutLabel}; ${chip.meaning}`}
                checked={draft.rpe === chip.value && draft.rir == null}
                onChange={() => setDraft((current) => ({ ...current, rpe: chip.value, rir: null }))}
                className="absolute inset-0 m-0 !h-full !min-h-11 !w-full cursor-pointer opacity-0" />
              <span aria-hidden="true" className={cn(
                "flex size-[16px] shrink-0 items-center justify-center rounded-full border border-muted-foreground",
                draft.rpe === chip.value && draft.rir == null && "border-primary",
              )}>
                {draft.rpe === chip.value && draft.rir == null && <span className="size-2 rounded-full bg-primary" />}
              </span>
              <span>{chip.value ?? "None"}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        aria-expanded={exactOpen}
        onClick={() => setExactOpen((open) => !open)}
      >
        {exactOpen ? "Hide exact RPE / RIR" : "Exact RPE / RIR"}
      </Button>
      {exactOpen && (
        <>
        <div className="max-w-48">
          <label htmlFor={exactRpeId} className="text-sm font-medium">
            Exact RPE (1–10)
          </label>
          <Input
            id={exactRpeId}
            type="number"
            inputMode="decimal"
            min={1}
            max={10}
            step={0.5}
            value={draft.rpe ?? ""}
            onChange={(event) => {
              const rawValue = event.currentTarget.value;
              setDraft((current) => {
                const parsed = parseFiniteDraftNumber(rawValue, current.rpe);
                return {
                  ...current,
                  rpe:
                    parsed == null
                      ? null
                      : Math.min(10, Math.max(1, parsed)),
                  rir: null,
                };
              });
            }}
          />
        </div>
      <div className="max-w-48">
        <label htmlFor={exactRirId} className="text-sm font-medium">
          RIR (0–10)
        </label>
        <Input
          id={exactRirId}
          type="number"
          inputMode="decimal"
          min={0}
          max={10}
          step={0.5}
          value={draft.rir ?? ""}
          onChange={(event) => {
            const rawValue = event.currentTarget.value;
            setDraft((current) => {
              const parsed = parseFiniteDraftNumber(rawValue, current.rir);
              return {
                ...current,
                rir:
                  parsed == null
                    ? null
                    : Math.min(10, Math.max(0, parsed)),
                rpe: null,
              };
            });
          }}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Reps you believe remained. Entering RIR clears RPE.
        </p>
      </div>
        </>
      )}
  </div>;
}

function SetEntry({
  metricType,
  supported,
  draft,
  setDraft,
  onWeightEdit = () => undefined,
  stepWeight,
  unit,
  hasWeight,
  weightLabel,
  plateConfig,
  machineLoadConfig,
  prioritizePerformedMeasure = false,
  compactLedger = false,
  optionalOnly = false,
}: {
  metricType: PerformedMetricType;
  supported: boolean;
  draft: SetDraft;
  setDraft: React.Dispatch<React.SetStateAction<SetDraft>>;
  onWeightEdit?: () => void;
  stepWeight: (current: number | null, dir: 1 | -1) => number | null;
  unit: string;
  hasWeight: boolean;
  weightLabel?: string;
  plateConfig?: PlateMathConfig;
  machineLoadConfig?: MachineLoadConfig | null;
  prioritizePerformedMeasure?: boolean;
  compactLedger?: boolean;
  optionalOnly?: boolean;
}) {
  const weightInputId = useId();
  const distanceInputId = useId();
  const durationInputId = useId();
  const plateLine =
    (unit === "lb" || unit === "kg")
      ? formatCompactPlateLoadGuidance(draft.weight, plateConfig, unit)
      : null;
  const machineLine =
    (unit === "lb" || unit === "kg") && machineLoadConfig
      ? formatMachineLoadGuidance(draft.weight, machineLoadConfig)
      : null;
  if (!supported) {
    return (
      <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        Repbook cannot yet represent every applicable performed value for this
        exercise, so it will not save a partial or misleading set.
      </p>
    );
  }
  const recordsRepetitions =
    metricType === "weight_reps" ||
    metricType === "reps" ||
    metricType === "assisted_reps";
  const optionalSetFields = (
    <>
      <p className="text-sm text-muted-foreground">Additional set details are optional.</p>
      <fieldset className="space-y-2 rounded-md border p-2">
        <legend className="px-1 text-sm font-medium">Technique issue</legend>
        <p className="text-xs text-muted-foreground">
          Select only if you noticed one. Select it again to clear it.
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {TECHNIQUE_ISSUES.map((issue) => (
            <Button
              key={issue}
              type="button"
              variant={draft.techniqueIssue === issue ? "default" : "outline"}
              size="sm"
              className="h-auto min-h-11 whitespace-normal text-xs"
              aria-pressed={draft.techniqueIssue === issue}
              onClick={() => setDraft((current) => ({
                ...current,
                techniqueIssue:
                  current.techniqueIssue === issue ? null : issue,
              }))}
            >
              {TECHNIQUE_ISSUE_LABELS[issue]}
            </Button>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2 rounded-md border p-2">
        <legend className="px-1 text-sm font-medium">What limited this set?</legend>
        <p className="text-xs text-muted-foreground">
          Optional context, not a change to your Program or next workout.
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {LIMITATION_CAUSES.map((cause) => (
            <Button
              key={cause}
              type="button"
              variant={draft.limitationCause === cause ? "default" : "outline"}
              size="sm"
              className="h-auto min-h-11 whitespace-normal text-xs"
              aria-pressed={draft.limitationCause === cause}
              onClick={() => setDraft((current) => ({
                ...current,
                limitationCause:
                  current.limitationCause === cause ? null : cause,
              }))}
            >
              {LIMITATION_CAUSE_LABELS[cause]}
            </Button>
          ))}
        </div>
      </fieldset>
      <div className="space-y-2 rounded-md border p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Pain during this set</p>
            <p className="text-xs text-muted-foreground">
              No flag means unknown, not “no pain.”
            </p>
          </div>
          <Button
            type="button"
            variant={draft.pain == null ? "outline" : "default"}
            size="sm"
            aria-expanded={draft.pain != null}
            onClick={() => setDraft((current) => ({
              ...current,
              pain: current.pain == null
                ? { bodyPart: null, severity: null, note: null }
                : null,
            }))}
          >
            {draft.pain == null ? "Record pain" : "Clear pain flag"}
          </Button>
        </div>
        {draft.pain != null && (
          <div className="space-y-3 border-t pt-3">
            <div className="flex flex-wrap gap-1.5">
              {PAIN_BODY_PARTS.map((part) => (
                <Button
                  key={part}
                  type="button"
                  variant={draft.pain?.bodyPart === part ? "default" : "outline"}
                  size="sm"
                  aria-pressed={draft.pain?.bodyPart === part}
                  onClick={() => setDraft((current) => ({
                    ...current,
                    pain: current.pain == null
                      ? null
                      : { ...current.pain, bodyPart: part },
                  }))}
                >
                  {part}
                </Button>
              ))}
            </div>
            <div>
              <p className="mb-2 text-sm text-muted-foreground">
                Pain severity: {draft.pain.severity == null ? (
                  <span className="font-medium text-foreground">choose 1–10</span>
                ) : (
                  <span className="font-medium text-foreground">
                    {draft.pain.severity}/10
                  </span>
                )}
              </p>
              <div
                className="grid grid-cols-2 gap-1.5 min-[400px]:grid-cols-5"
                role="group"
                aria-label="Pain severity"
              >
                {Array.from({ length: 10 }, (_, index) => index + 1).map(
                  (severity) => (
                    <Button
                      key={severity}
                      type="button"
                      variant={draft.pain?.severity === severity ? "default" : "outline"}
                      size="sm"
                      className="min-h-11 min-w-11"
                      aria-label={`Pain severity ${severity}`}
                      aria-pressed={draft.pain?.severity === severity}
                      onClick={() => setDraft((current) => ({
                        ...current,
                        pain: current.pain == null
                          ? null
                          : { ...current.pain, severity },
                      }))}
                    >
                      {severity}
                    </Button>
                  ),
                )}
              </div>
            </div>
            <Textarea
              aria-label="Pain note (optional)"
              value={draft.pain.note ?? ""}
              maxLength={SET_NOTE_MAX_LENGTH}
              onChange={(event) => setDraft((current) => ({
                ...current,
                pain: current.pain == null
                  ? null
                  : { ...current.pain, note: event.target.value || null },
              }))}
              placeholder="What did it feel like? (optional)"
              rows={2}
            />
            {(draft.pain.severity ?? 0) >= 5 && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                That is significant pain. Stop this movement today. If it
                persists, seek a professional opinion rather than a workaround.
              </p>
            )}
          </div>
        )}
      </div>
      <Textarea
        aria-label="Set note (optional)"
        value={draft.note}
        maxLength={SET_NOTE_MAX_LENGTH}
        onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
        placeholder="Set note…"
        rows={2}
        className="min-h-14 text-sm"
      />
    </>
  );
  if (optionalOnly) {
    return <div className="space-y-2">{optionalSetFields}</div>;
  }
  return (
    <div className={cn("flex flex-col", compactLedger ? "gap-1" : "gap-2")}>
      <div
        className={cn(
          "active-set-measures-grid grid items-end gap-2",
          (hasWeight && recordsRepetitions) ||
            metricType === "distance_duration"
            ? compactLedger
              ? "grid-cols-2"
              : "grid-cols-1 min-[520px]:grid-cols-2"
            : "grid-cols-1 sm:grid-cols-2",
        )}
      >
        {hasWeight && (
          <div className="flex min-w-0 flex-col gap-1">
            {weightLabel && (
              <label
                htmlFor={weightInputId}
                className={cn(
                  "text-xs font-medium",
                  compactLedger && "sr-only",
                )}
              >
                {weightLabel}
              </label>
            )}
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className={cn(
                  "active-set-stepper shrink-0",
                  compactLedger &&
                    "!size-[44px] !min-h-[44px] !min-w-[44px]",
                )}
                onClick={() => {
                  onWeightEdit();
                  setDraft((d) => ({
                    ...d,
                    weight: stepWeight(d.weight, -1),
                  }));
                }}
                aria-label="Decrease weight"
              >
                <Minus className="size-4" />
              </Button>
              <div className="relative min-w-0 flex-1">
                <Input
                  id={weightInputId}
                  aria-label={weightLabel ?? "Weight"}
                  inputMode="decimal"
                  className={cn(
                    "pr-8 text-center text-base font-medium",
                    compactLedger &&
                      "!h-[44px] !min-h-[44px] px-1 pb-3 text-lg font-semibold",
                  )}
                  value={draft.weight ?? ""}
                  onChange={(event) => {
                    const rawValue = event.currentTarget.value;
                    onWeightEdit();
                    setDraft((d) => ({
                      ...d,
                      weight: parseFiniteDraftNumber(rawValue, d.weight),
                    }));
                  }}
                />
                <span
                  className={cn(
                    "pointer-events-none absolute flex items-center text-xs text-muted-foreground",
                    compactLedger
                      ? "inset-x-0 bottom-1 justify-center text-[10px] leading-none"
                      : "inset-y-0 right-2",
                  )}
                >
                  {unit}
                </span>
              </div>
              <Button
                variant="outline"
                size="icon"
                className={cn(
                  "active-set-stepper shrink-0",
                  compactLedger &&
                    "!size-[44px] !min-h-[44px] !min-w-[44px]",
                )}
                onClick={() => {
                  onWeightEdit();
                  setDraft((d) => ({
                    ...d,
                    weight: stepWeight(d.weight, 1),
                  }));
                }}
                aria-label="Increase weight"
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>
        )}
        {recordsRepetitions && (
        <div className="flex min-w-0 items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className={cn(
              "active-set-stepper shrink-0",
              compactLedger &&
                "!size-[44px] !min-h-[44px] !min-w-[44px]",
            )}
            onClick={() => setDraft((d) => ({
              ...d,
              reps: Math.max(0, (d.reps ?? 0) - 1),
            }))}
            aria-label="Decrease reps"
          >
            <Minus className="size-4" />
          </Button>
          <div className="relative min-w-0 flex-1">
            <Input
              aria-label="Reps"
              inputMode="numeric"
              className={cn(
                "pr-10 text-center text-base font-medium",
                compactLedger &&
                  "!h-[44px] !min-h-[44px] px-1 pb-3 text-lg font-semibold",
              )}
              value={draft.reps ?? ""}
              onChange={(event) => {
                const rawValue = event.currentTarget.value;
                setDraft((d) => ({
                  ...d,
                  reps: parseFiniteDraftNumber(rawValue, d.reps),
                }));
              }}
            />
            <span
              className={cn(
                "pointer-events-none absolute flex items-center text-xs text-muted-foreground",
                compactLedger
                  ? "inset-x-0 bottom-1 justify-center text-[10px] leading-none"
                  : "inset-y-0 right-2",
              )}
            >
              reps
            </span>
          </div>
          <Button
            variant="outline"
            size="icon"
            className={cn(
              "active-set-stepper shrink-0",
              compactLedger &&
                "!size-[44px] !min-h-[44px] !min-w-[44px]",
            )}
            onClick={() => setDraft((d) => ({
              ...d,
              reps: (d.reps ?? 0) + 1,
            }))}
            aria-label="Increase reps"
          >
            <Plus className="size-4" />
          </Button>
        </div>
        )}
        {metricType === "distance_duration" && (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={distanceInputId} className="text-xs font-medium">
              Distance
            </label>
            <div className="relative">
              <Input
                id={distanceInputId}
                aria-label="Distance in kilometres"
                inputMode="decimal"
                className="pr-10 text-center text-base font-medium"
                value={draft.distanceKm ?? ""}
                onChange={(event) => {
                  const rawValue = event.currentTarget.value;
                  setDraft((current) => ({
                    ...current,
                    distanceKm: parseFiniteDraftNumber(
                      rawValue,
                      current.distanceKm,
                    ),
                  }));
                }}
              />
              <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                km
              </span>
            </div>
          </div>
        )}
        {(metricType === "duration" || metricType === "weight_duration_per_side" || metricType === "distance_duration") && (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={durationInputId} className="text-xs font-medium">
              {metricType === "weight_duration_per_side" ? "Seconds per side — both sides completed" : `Duration ${metricType === "distance_duration" ? "(optional)" : ""}`}
            </label>
            <div className="relative">
              <Input
                id={durationInputId}
                aria-label={metricType === "weight_duration_per_side" ? "Seconds per side — both sides completed" : "Duration in seconds"}
                inputMode="numeric"
                className="pr-10 text-center text-base font-medium"
                value={draft.durationSeconds ?? ""}
                onChange={(event) => {
                  const rawValue = event.currentTarget.value;
                  setDraft((current) => ({
                    ...current,
                    durationSeconds: parseFiniteDraftNumber(
                      rawValue,
                      current.durationSeconds,
                    ),
                  }));
                }}
              />
              <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                sec
              </span>
            </div>
          </div>
        )}
      </div>
      {(machineLine ?? plateLine) && (
        <p
          className={cn(
            "rounded-md bg-muted/50 px-2 text-muted-foreground",
            compactLedger ? "py-1 text-xs leading-4" : "py-1.5 text-sm",
          )}
          aria-live="polite"
        >
          {machineLine ?? plateLine}
        </p>
      )}
      <SetEffortInput draft={draft} setDraft={setDraft} />
      {!prioritizePerformedMeasure && (
        <div className="space-y-2">{optionalSetFields}</div>
      )}
    </div>
  );
}

function PainDrawer({
  exerciseId,
  defaultBodyPart,
}: {
  exerciseId: string;
  defaultBodyPart?: string;
}) {
  const [open, setOpen] = useState(false);
  const [bodyPart, setBodyPart] = useState(defaultBodyPart ?? "shoulder");
  const [severity, setSeverity] = useState(3);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger render={<Button variant="outline" size="sm" />}>
        Pain / no issue
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11 [&_textarea]:min-h-11">
        <DrawerHeader>
          <DrawerTitle>Pain / no-issue evidence</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col gap-4 px-4">
          <div className="flex flex-wrap gap-1.5">
            {PAIN_BODY_PARTS.map((part) => (
              <Button
                key={part}
                variant={bodyPart === part ? "default" : "outline"}
                size="sm"
                onClick={() => setBodyPart(part)}
              >
                {part}
              </Button>
            ))}
          </div>
          <div>
            <p className="mb-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {severity === 0
                  ? "No issue reported"
                  : formatPainEvidence({ bodyPart, severity, source: "set_flag" })}
              </span>
            </p>
            <Slider
              min={0}
              max={10}
              step={1}
              value={severity}
              onValueChange={(v) => setSeverity(Array.isArray(v) ? v[0] : v)}
            />
          </div>
          <Textarea
            placeholder="What did it feel like? (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
          {severity >= 5 && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              That&apos;s significant pain. Stop this movement today. If it
              persists, this is worth a professional opinion, not a workaround.
            </p>
          )}
        </div>
        <DrawerFooter>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                try {
                  const result = await logPain({
                    sessionExerciseId: exerciseId,
                    bodyPart,
                    severity,
                    note: note || undefined,
                  });
                  if (!result.ok) {
                    toast.error(result.message);
                    return;
                  }
                } catch {
                  toast.error("The pain / no-issue report could not be saved.");
                  return;
                }
                setOpen(false);
              })
            }
          >
            {severity === 0 ? "Save no-issue report" : "Save pain report"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function SkipDrawer({
  exerciseId,
  exerciseName,
  expectedHistoryRevision,
  open,
  onOpenChange,
  onRequestStart,
  onRequestFailure,
  onDone,
  forcedReason,
  allowEquipmentReason,
}: {
  exerciseId: string;
  exerciseName: string;
  expectedHistoryRevision: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestStart: (
    reason: IncompleteSessionReason,
  ) => void;
  onRequestFailure: (
    reason: IncompleteSessionReason,
    code?: string,
  ) => boolean;
  onDone: (
    reason: IncompleteSessionReason,
    historyRevision: number,
  ) => void;
  forcedReason?: IncompleteSessionReason;
  allowEquipmentReason: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const reasons = [
    { value: "time_limit_reached", label: "Time limit reached" },
    { value: "fatigue", label: "Fatigue" },
    { value: "pain_discomfort", label: "Pain or discomfort" },
    {
      value: "equipment_unavailable_incompatible",
      label: "Equipment unavailable or incompatible",
    },
    { value: "user_choice", label: "User choice" },
    { value: "technical_app_issue", label: "Technical or app issue" },
    { value: "interruption", label: "Interruption" },
    { value: "program_change", label: "Program change" },
  ] as const satisfies ReadonlyArray<{
    value: IncompleteSessionReason;
    label: string;
  }>;
  const availableReasons = allowEquipmentReason
    ? reasons
    : reasons.filter(
        (reason) =>
          reason.value !== "equipment_unavailable_incompatible",
      );

  function submitReason(reason: IncompleteSessionReason) {
    onRequestStart(reason);
    startTransition(async () => {
      try {
        const result = await withDocumentActionDeadline(
          skipExercise({
            sessionExerciseId: exerciseId,
            reason,
            expectedHistoryRevision,
          }),
        );
        if (!result.ok) {
          if (onRequestFailure(reason, result.code)) {
            toast.error(result.message);
          }
          return;
        }
        onDone(reason, result.historyRevision);
      } catch (error) {
        if (onRequestFailure(reason)) {
          if (isDocumentActionTimeout(error)) {
            reportDocumentActionTimeout();
            toast.error(
              "Repbook did not confirm the skip in time. Reload to reconcile the retained request safely.",
            );
          } else {
            toast.error("The exercise could not be skipped.");
          }
        }
      }
    });
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerTrigger render={<Button variant="outline" size="sm" />}>
        Skip exercise
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11">
        <DrawerHeader>
          <DrawerTitle>
            {forcedReason ? `Skip ${exerciseName}?` : "Skip exercise — why?"}
          </DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-wrap gap-2 px-4 pb-6">
          {forcedReason ? (
            <div className="w-full space-y-3">
              <p className="text-sm text-muted-foreground">
                Repbook already knows the reason: equipment unavailable or
                incompatible. This skips the exercise for today; your saved
                Program remains unchanged.
              </p>
              <Button
                className="w-full"
                variant="outline"
                disabled={pending}
                onClick={() => submitReason(forcedReason)}
              >
                {pending ? "Skipping…" : "Confirm skip"}
              </Button>
            </div>
          ) : availableReasons.map((reason) => (
            <Button
              key={reason.value}
              variant="outline"
              disabled={pending}
              onClick={() => submitReason(reason.value)}
            >
              {reason.label}
            </Button>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function RemoveFromTodayDrawer({
  exercise,
  futureProgramRemoval,
  expectedHistoryRevision,
  open,
  onOpenChange,
  onRequestStart,
  onRequestFailure,
  onRemoved,
}: {
  exercise: SessionExerciseData;
  futureProgramRemoval: Props["futureProgramRemoval"];
  expectedHistoryRevision: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestStart: (reason: "user_choice") => void;
  onRequestFailure: (reason: "user_choice", code?: string) => boolean;
  onRemoved: (historyRevision: number) => void;
}) {
  const [pending, startTransition] = useTransition();
  const completedSetCount = exercise.sets.filter(
    (set) => set.saveState == null || set.saveState === "saved",
  ).length;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11">
        <DrawerHeader>
          <DrawerTitle>Remove {exercise.name} from today?</DrawerTitle>
        </DrawerHeader>
        <div className="space-y-3 px-4 pb-2 text-sm leading-6">
          <p>
            Choose whether to remove the remaining work from this active workout
            only, or prepare a separate change for future workouts.
          </p>
          {completedSetCount > 0 ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              {completedSetCount} completed {completedSetCount === 1 ? "set" : "sets"}
              {" "}will remain in this workout&apos;s history.
            </p>
          ) : null}
          {futureProgramRemoval ? (
            <p className="text-xs text-muted-foreground">
              The future option opens the Program editor for review. It does not
              change this active workout, and nothing changes in future workouts
              until you publish the Program draft.
              {futureProgramRemoval.plannedExerciseName !== exercise.name
                ? ` It targets the planned ${futureProgramRemoval.plannedExerciseName} slot.`
                : ""}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              This workout does not retain a current Program slot that Repbook
              can edit safely. Open the Program separately to change future
              workouts.
            </p>
          )}
        </div>
        <DrawerFooter>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              onRequestStart("user_choice");
              startTransition(async () => {
                try {
                  const result = await withDocumentActionDeadline(
                    skipExercise({
                      sessionExerciseId: exercise.id,
                      reason: "user_choice",
                      expectedHistoryRevision,
                    }),
                  );
                  if (!result.ok) {
                    if (onRequestFailure("user_choice", result.code)) {
                      toast.error(result.message);
                    }
                    return;
                  }
                  onRemoved(result.historyRevision);
                } catch (error) {
                  if (onRequestFailure("user_choice")) {
                    if (isDocumentActionTimeout(error)) {
                      reportDocumentActionTimeout();
                      toast.error(
                        "Repbook did not confirm the removal in time. Reload to reconcile the retained request safely.",
                      );
                    } else {
                      toast.error("The exercise could not be removed from today.");
                    }
                  }
                }
              });
            }}
          >
            {pending ? "Removing…" : "Remove from today"}
          </Button>
          {futureProgramRemoval ? (
            <Link
              href={futureProgramRemoval.href}
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-auto min-h-11 whitespace-normal text-center",
              )}
            >
              <Trash2 className="size-4" /> Remove from future {futureProgramRemoval.dayName} workouts
            </Link>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Keep exercise
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function ExerciseOptionsLoadState({
  error,
  onRetry,
  onBack,
  reconciliationRequired = false,
}: {
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
  reconciliationRequired?: boolean;
}) {
  if (error == null) {
    return (
      <div className="space-y-3 py-2">
        <p role="status" className="text-sm text-muted-foreground">
          {reconciliationRequired
            ? "Checking the updated exercise…"
            : "Loading exercise catalog…"}
        </p>
        {reconciliationRequired ? (
          <a
            href="/today"
            className={buttonVariants({ variant: "outline", size: "touch" })}
          >
            Back to Today
          </a>
        ) : (
          <Button type="button" variant="outline" onClick={onBack}>
            Back to workout
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-destructive/35 bg-destructive/5 p-3"
    >
      <div>
        <p className="text-sm font-medium">
          {reconciliationRequired
            ? "Workout update needs attention"
            : "Catalog unavailable"}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{error}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onRetry}>
          {reconciliationRequired
            ? "Try updating workout again"
            : "Try loading catalog again"}
        </Button>
        {reconciliationRequired ? (
          <a
            href="/today"
            className={buttonVariants({ variant: "outline", size: "touch" })}
          >
            Back to Today
          </a>
        ) : (
          <Button type="button" variant="outline" onClick={onBack}>
            Back to workout
          </Button>
        )}
      </div>
    </div>
  );
}

function AlternativesDrawer({
  exerciseId,
  describedBy,
  open,
  onOpenChange,
  onDone,
}: {
  exerciseId: string;
  describedBy: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (
    candidate: ExerciseDiscoveryItem,
    reason: ExerciseAlternativeReason
  ) => void;
}) {
  const [reason, setReason] = useState<UserSelectedAlternativeReason>("variety");
  const catalog = useWorkoutExerciseOptions<AlternativeOptions>({
    mode: "alternative",
    exerciseId,
    open,
  });
  const { options, setOptions } = catalog;

  function handleOpen(next: boolean) {
    if (next) catalog.prepareToOpen();
    else catalog.invalidateActiveLoad();
    onOpenChange(next);
  }

  return (
    <Drawer open={open} onOpenChange={handleOpen}>
      <DrawerTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-describedby={describedBy}
          />
        }
      >
        View alternatives
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11">
        <DrawerHeader>
          <DrawerTitle>Use an alternative for this workout</DrawerTitle>
        </DrawerHeader>
        <div className="max-h-[60dvh] space-y-4 overflow-y-auto px-4 pb-6">
          <div>
            <p className="mb-2 text-sm text-muted-foreground">Why are you changing it?</p>
            <div className="flex flex-wrap gap-2">
              {ALTERNATIVE_REASONS.map(
                (value) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={reason === value ? "default" : "outline"}
                    aria-pressed={reason === value}
                    onClick={() => setReason(value)}
                  >
                    {SUBSTITUTION_REASON_LABELS[value]}
                  </Button>
                )
              )}
            </div>
          </div>
          {options == null ? (
            <ExerciseOptionsLoadState
              error={catalog.loadError}
              onRetry={catalog.retryLoad}
              onBack={() => handleOpen(false)}
            />
          ) : (
            <ExercisePicker
              items={options.items}
              priorityIds={options.priorityIds}
              itemAnnotations={options.annotations}
              triggerLabel="Browse alternatives"
              title={`Alternatives to ${options.plannedExerciseName}`}
              description="Closest family variants appear first, followed by the same movement and broader same-muscle choices. Available to me is the executable list; All exercises is view-only when a choice is unsafe or incompatible."
              confirmLabel="Use for this workout"
              largeTouchTargets
              onSelect={async (candidate) => {
                const selected = options.items.find((item) => item.id === candidate.id);
                if (!selected) return false;
                try {
                  const result = await substituteExercise({
                    sessionExerciseId: exerciseId,
                    newExerciseId: selected.id,
                    reason,
                  });
                  if (!result.ok) {
                    toast.error(result.message);
                    return false;
                  }
                  handleOpen(false);
                  setOptions(null);
                  onDone(selected, reason);
                  return true;
                } catch {
                  toast.error("That substitution could not be applied.");
                  return false;
                }
              }}
            />
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            This changes only the active workout. The saved routine and its next occurrence stay unchanged. Once a set is logged, completed work is never relabelled.
          </p>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function ReplacementDrawer({
  exerciseId,
  describedBy,
  open,
  onOpenChange,
  onReconcile,
  onDone,
  forcedReason,
}: {
  exerciseId: string;
  describedBy: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReconcile: (
    candidate: ExerciseDiscoveryItem,
    state: ReplacementOptions["currentState"],
    plannedExerciseName: string,
  ) => void;
  onDone: (
    candidate: ExerciseDiscoveryItem,
    reason: ExerciseAlternativeReason,
  ) => void;
  forcedReason?: ExerciseAlternativeReason;
}) {
  const [reason, setReason] = useState<UserSelectedAlternativeReason>("variety");
  const effectiveReason = forcedReason ?? reason;
  const [reconciliationRequired, setReconciliationRequired] = useState(false);
  const mutationRef = useRef<{ signature: string; id: string } | null>(null);
  const reconcileOnNextLoadRef = useRef(false);

  function reconcileLoadedOptions(loaded: ReplacementOptions) {
    if (!reconcileOnNextLoadRef.current) return;
    const authoritative = loaded.items.find(
      (item) => item.id === loaded.currentExerciseId,
    );
    if (!authoritative) return;
    reconcileOnNextLoadRef.current = false;
    onReconcile(
      authoritative,
      loaded.currentState,
      loaded.plannedExerciseName,
    );
    setReconciliationRequired(false);
  }

  const catalog = useWorkoutExerciseOptions<ReplacementOptions>({
    mode: "replacement",
    exerciseId,
    open,
    onLoaded: reconcileLoadedOptions,
  });
  const { options, setOptions } = catalog;

  function handleOpen(next: boolean) {
    if (next) catalog.prepareToOpen();
    else {
      if (reconcileOnNextLoadRef.current) return;
      reconcileOnNextLoadRef.current = false;
      catalog.invalidateActiveLoad();
    }
    onOpenChange(next);
  }

  return (
    <Drawer open={open} onOpenChange={handleOpen}>
      <DrawerTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-describedby={describedBy}
          />
        }
      >
        {forcedReason ? "Replace for today" : "Replace exercise"}
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11">
        <DrawerHeader>
          <DrawerTitle>
            {forcedReason
              ? "Replace for today"
              : "Replace exercise for this workout"}
          </DrawerTitle>
        </DrawerHeader>
        <div className="max-h-[60dvh] space-y-4 overflow-y-auto px-4 pb-6">
          {forcedReason ? (
            <div className="rounded-lg bg-[var(--surface-attention)] px-3 py-2 text-sm">
              <p className="font-medium">
                Reason: {SUBSTITUTION_REASON_LABELS[forcedReason]}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Repbook verifies this against the current saved equipment before it records the replacement.
              </p>
            </div>
          ) : <div>
            <p className="mb-2 text-sm text-muted-foreground">
              Why are you replacing it?
            </p>
            <div className="flex flex-wrap gap-2">
              {ALTERNATIVE_REASONS.map(
                (value) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={reason === value ? "default" : "outline"}
                    aria-pressed={reason === value}
                    onClick={() => setReason(value)}
                  >
                    {SUBSTITUTION_REASON_LABELS[value]}
                  </Button>
                ),
              )}
            </div>
          </div>}
          {options == null || reconciliationRequired ? (
            <ExerciseOptionsLoadState
              error={
                reconciliationRequired && options != null
                  ? "Repbook could not confirm the updated exercise. Try again or return to Today."
                  : catalog.loadError
              }
              onRetry={catalog.retryLoad}
              onBack={() => handleOpen(false)}
              reconciliationRequired={reconciliationRequired}
            />
          ) : (
            <ExercisePicker
              items={options.items}
              itemWarnings={options.warnings}
              allowedIds={options.permittedIds}
              disabledReasons={options.disabledReasons}
              allowUnavailableSelection={forcedReason == null}
              triggerLabel="Search exercise catalog"
              title="Replace exercise"
              description="Search the authorized catalog without similarity ranking. Repbook supports repetitions, assistance, duration, and distance when the full performed measurement can be retained; activity-only observations stay in Activity."
              confirmLabel="Replace in this workout"
              largeTouchTargets
              onSelect={async (candidate) => {
                const selected = options.items.find(
                  (item) => item.id === candidate.id,
                );
                if (!selected) return false;
                const signature = `${options.currentExerciseId}:${selected.id}:${effectiveReason}`;
                if (mutationRef.current?.signature !== signature) {
                  mutationRef.current = {
                    signature,
                    id: createClientUuid(),
                  };
                }
                try {
                  const result = await replaceExercise({
                    sessionExerciseId: exerciseId,
                    expectedExerciseId: options.currentExerciseId,
                    newExerciseId: selected.id,
                    reason: effectiveReason,
                    clientMutationId: mutationRef.current.id,
                  });
                  if (!result.ok) {
                    toast.error(result.message);
                    if (result.code === "replacement_stale") {
                      mutationRef.current = null;
                      setReconciliationRequired(true);
                      reconcileOnNextLoadRef.current = true;
                      catalog.retryLoad();
                    }
                    return false;
                  }
                  const warning = options.warnings[selected.id];
                  if (warning) toast.warning(warning);
                  mutationRef.current = null;
                  handleOpen(false);
                  setOptions(null);
                  onDone(selected, effectiveReason);
                  return true;
                } catch {
                  toast.error(
                    "The replacement was not confirmed. Your choice is still here so you can retry.",
                  );
                  return false;
                }
              }}
            />
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            This only changes sets you haven&apos;t done in this workout. Your
            saved Program and completed sets stay the same. We&apos;ll use the
            new exercise&apos;s equipment and setup.
          </p>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
