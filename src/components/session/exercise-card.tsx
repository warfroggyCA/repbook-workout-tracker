"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  archiveSet,
  confirmExerciseUnskipped,
  skipExercise,
  logPain,
  saveExerciseNote,
  getAlternativeOptions,
  getReplacementOptions,
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
import { formatRestTime } from "@/lib/rest-time";
import {
  EXERCISE_NOTE_MAX_LENGTH,
  SET_NOTE_MAX_LENGTH,
  exerciseUsesTotalBarLoad,
  formatCompactPlateLoadGuidance,
  setSaveStateLabel,
} from "@/lib/exercise-card";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import type { ExerciseAlternativeReason } from "@/lib/exercise-alternatives";
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
} from "lucide-react";
import type {
  LoggedSet,
  SessionExerciseData,
  SessionOccurrenceData,
  SetAcknowledgementReceipt,
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
import { reportDeploymentMismatch } from "@/lib/deployment-recovery";
import {
  patchActiveWorkoutMeasurement,
  readActiveWorkoutMeasurements,
  writeActiveWorkoutMeasurement,
} from "@/lib/active-workout-measurements";
import { OccurrenceMutationDialog } from "./occurrence-mutation-dialog";
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
import type { OccurrenceMutationOutboxEntry } from "@/lib/occurrence-mutation-outbox";
import {
  CompletedSetCorrection,
  type CorrectedSetValues,
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
  if (state === "corrected") return `Corrected ×${count}`;
  if (state === "version_restored") return `Version restored ×${count}`;
  if (state === "snapshot_restored") return `Snapshot restored ×${count}`;
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

function formatSetTarget(
  occurrence: SessionOccurrenceData,
  exercise: SessionExerciseData,
) {
  const parts: string[] = [];
  const repsMin = occurrence.plannedRepsMin ?? exercise.targetRepsMin;
  const repsMax = occurrence.plannedRepsMax ?? exercise.targetRepsMax;
  if (repsMin != null && repsMax != null) {
    parts.push(
      repsMin === repsMax
        ? `${repsMin} rep${repsMin === 1 ? "" : "s"}`
        : `${repsMin}–${repsMax} reps`,
    );
  }
  const plannedLoad = occurrence.plannedLoad ?? exercise.targetLoad;
  const plannedLoadUnit =
    occurrence.plannedLoadUnit ?? exercise.targetLoadUnit;
  if (plannedLoad != null && plannedLoadUnit != null) {
    parts.push(`${plannedLoad} ${plannedLoadUnit}`);
  } else if (occurrence.plannedLoadPercent != null) {
    parts.push(`${occurrence.plannedLoadPercent}%`);
  } else if (occurrence.plannedLoadText?.trim()) {
    parts.push(occurrence.plannedLoadText.trim());
  }
  return parts.length > 0 ? parts.join(" · ") : "No numeric target";
}

function ActiveSetSaveReceipt({
  receipt,
  currentExerciseId,
  historyRevision,
  onAcknowledged,
}: {
  receipt: SetAcknowledgementReceipt;
  currentExerciseId: string;
  historyRevision: number;
  onAcknowledged: (result: {
    values: CorrectedSetValues;
    historyRevision: number;
  }) => void;
}) {
  return (
    <div
      id={`active-set-save-receipt-${receipt.sessionExerciseId}-${receipt.set.setNo}`}
      data-testid="active-set-save-receipt"
      role="status"
      className="mt-2 rounded-lg border border-emerald-600/30 bg-emerald-600/10 p-3 text-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-semibold tabular-nums">
            Saved · {receipt.sessionExerciseId !== currentExerciseId
              ? `${receipt.exerciseName} · `
              : ""}
            Set {receipt.set.setNo} · {formatLoggedSet(receipt.set, receipt.metricType)}
          </p>
          {formatLoggedExceptionContext(receipt.set).length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {formatLoggedExceptionContext(receipt.set).join(" · ")}
            </p>
          )}
        </div>
        {(receipt.set.metricType ?? receipt.metricType) === "activity" ? (
          <span className="text-xs text-muted-foreground">
            Correction unavailable for this legacy shape
          </span>
        ) : (
          <CompletedSetCorrection
            setId={receipt.set.id}
            setNo={receipt.set.setNo}
            weight={receipt.set.weight}
            weightUnit={receipt.set.weightUnit}
            reps={receipt.set.reps}
            distanceKm={receipt.set.distanceKm ?? null}
            durationSeconds={receipt.set.durationSeconds ?? null}
            metricType={receipt.set.metricType ?? receipt.metricType}
            rpe={receipt.set.rpe}
            note={receipt.set.note}
            historyRevision={historyRevision}
            source="active_workout"
            onAcknowledged={onAcknowledged}
          />
        )}
      </div>
      <p className="mt-2 border-t border-emerald-700/20 pt-2 text-xs text-muted-foreground">
        Acknowledged by Repbook. Wrong value? Correct the saved set; the
        original remains in Edit history.
      </p>
    </div>
  );
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
  if (set.saveState == null || set.saveState === "saved") return null;
  const failed = set.saveState === "failed";
  const orderConflict =
    failed &&
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
      className={cn(
        "mt-2 rounded-lg border p-3",
        failed
          ? "border-destructive/40 bg-destructive/5"
          : "border-amber-600/30 bg-amber-500/5",
      )}
    >
      <div role={failed ? "alert" : "status"}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="font-semibold">{rowLabel}</p>
          <p
            className={cn(
              "text-xs font-semibold",
              failed ? "text-destructive" : "text-amber-800 dark:text-amber-200",
            )}
          >
            {setSaveStateLabel(set.saveState)}
          </p>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {reviewRequired
            ? `This retained ${rowLabel.toLowerCase()} was based on an older workout state. Refresh, then review or discard it.`
            : orderConflict && blockerDescription
            ? `${blockerDescription} comes first. This ${rowLabel.toLowerCase()} is still safe on this device.`
            : orderConflict
              ? "Workout order changed. Refresh to find the exact set that comes first."
              : failed
                ? `This device copy still owns ${rowLabel}. Retry the save, or discard the device copy to enter or skip ${rowLabel} again.`
                : `Waiting for Repbook to acknowledge ${rowLabel}. It will not advance until that happens.`}
        </p>
        {failed && set.lastError && !orderConflict && (
          <p className="mt-2 text-sm text-foreground">{set.lastError}</p>
        )}
      </div>
      {failed && set.clientKey && (
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

const ALTERNATIVE_REASON_LABELS: Record<ExerciseAlternativeReason, string> = {
  variety: "Variety",
  equipment_busy: "Equipment busy",
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

type Props = {
  exercise: SessionExerciseData;
  historyRevision: number;
  progress: ExerciseProgressProjection;
  expanded: boolean;
  onToggle: () => void;
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
  onAppendSet?: (
    occurrenceId: string,
    expectedSetNo: number,
  ) => Promise<SessionOccurrenceData | null>;
  activeOccurrence?: SessionOccurrenceData | null;
  workingOccurrences?: SessionOccurrenceData[];
  occurrenceMutationEntries?: OccurrenceMutationOutboxEntry[];
  occurrenceRuntimeSaveStates?: Record<string, "saving" | "retrying">;
  acknowledgedOccurrenceIds?: string[];
  acknowledgementReceipt?: SetAcknowledgementReceipt | null;
  isCurrentExercise?: boolean;
  nextActionLabel?: string | null;
  warmupResolved?: boolean;
  groupContext?: {
    name: string;
    memberOrder: number;
    memberCount: number;
  } | null;
  occurrenceChangesBlocked?: boolean;
  onSkipSet?: (
    input: { reason: string | null; note: string | null },
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
  onSkipRequestStart?: (
    reason: "time" | "pain" | "fatigue" | "equipment" | "other",
  ) => void;
  onSkipRequestFailure?: (
    reason: "time" | "pain" | "fatigue" | "equipment" | "other",
    code?: string,
  ) => void;
  skipConfirmationPending?: boolean;
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
  return !unconfirmedSets.every(
    (set) =>
      set.clientKey != null &&
      blockers[set.clientKey]?.blockerOccurrenceId === targetOccurrenceId,
  );
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

type ReplacementOptions = Extract<
  Awaited<ReturnType<typeof getReplacementOptions>>,
  { ok: true }
>;

export type ExerciseAdjustmentIntent = "note" | "swap" | "replace" | "skip";

export function ExerciseCard({
  exercise,
  historyRevision,
  progress,
  expanded,
  onToggle,
  plateConfigs,
  machineLoadConfig = null,
  incrementals,
  unit,
  loadEntryMeaning = null,
  comparisonTemporarilyUnavailable = false,
  onPatch,
  onQueueSet,
  onAppendSet = async () => null,
  activeOccurrence = null,
  workingOccurrences = [],
  occurrenceMutationEntries = [],
  occurrenceRuntimeSaveStates = {},
  acknowledgedOccurrenceIds = [],
  acknowledgementReceipt = null,
  isCurrentExercise = false,
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
  onSkipRequestStart = () => undefined,
  onSkipRequestFailure = () => undefined,
  skipConfirmationPending = false,
  skipConfirmationError = null,
  onSkipConfirmationErrorDismiss = () => undefined,
  onSkipComplete,
  adjustIntent,
  onAdjustIntentChange,
}: Props) {
  const router = useRouter();
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
    performedMetricType === "assisted_reps";
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
  const devicePendingSets = exercise.sets.filter(
    (set) => set.saveState != null && set.saveState !== "saved",
  ).length;
  const comparableProjection = comparisonTemporarilyUnavailable
    ? undefined
    : exercise.previousComparable;
  const comparableSemanticsMatch =
    comparableProjection?.status === "available" &&
    (comparableProjection.semantics.metricType !== "weight_reps" &&
    comparableProjection.semantics.metricType !== "assisted_reps"
      ? true
      : comparableProjection.semantics.loadEntryMeaning === loadEntryMeaning);
  const previousComparableSet =
    comparableProjection?.status === "available" && comparableSemanticsMatch
      ? comparableProjection.sets.find((set) => set.setNo === nextSetNo) ??
        comparableProjection.sets.at(-1) ??
        null
      : null;
  const comparableRenderState = comparisonTemporarilyUnavailable
    ? "loading"
    : comparableProjection?.status === "available" &&
        comparableSemanticsMatch &&
        previousComparableSet
      ? "available"
      : "unavailable";
  const prefillFrom =
    [...exercise.sets]
      .filter((set) => set.setNo < nextSetNo)
      .sort((left, right) => right.setNo - left.setNo)[0] ?? null;

  const defaultWeight =
    prefillFrom?.weight != null && prefillFrom.weightUnit != null
      ? convertWeight(prefillFrom.weight, prefillFrom.weightUnit, unit)
      : exercise.targetLoad != null && exercise.targetLoadUnit != null
        ? convertWeight(exercise.targetLoad, exercise.targetLoadUnit, unit)
        : null;
  const defaultReps =
    performedMetricType === "weight_reps" ||
      performedMetricType === "reps" ||
      performedMetricType === "assisted_reps"
      ? prefillFrom?.reps ?? exercise.targetRepsMax ?? exercise.targetRepsMin ?? 8
      : null;
  const appendedWeight =
    appendedOccurrence?.plannedLoad != null &&
    appendedOccurrence.plannedLoadUnit != null
      ? convertWeight(
          appendedOccurrence.plannedLoad,
          appendedOccurrence.plannedLoadUnit,
          unit,
        )
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
    durationSeconds: null,
    rpe: null,
    rir: null,
    techniqueIssue: null,
    limitationCause: null,
    pain: null,
    note: defaultSetNote,
  };
  const [draft, setDraftState] = useState<SetDraft>(() => {
    const activeSetDraftCache = getActiveSetDraftCache();
    const cached = activeSetDraftCache.get(exercise.id);
    if (cached?.identity === draftIdentity) {
      return copySetDraft(cached.draft);
    }
    if (cached) activeSetDraftCache.delete(exercise.id);
    return initialDraft;
  });
  const setDraft: React.Dispatch<React.SetStateAction<SetDraft>> = (update) => {
    setDraftState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      getActiveSetDraftCache().set(exercise.id, {
        identity: draftIdentity,
        draft: copySetDraft(next),
      });
      return next;
    });
  };
  const [appendedDraft, setAppendedDraft] = useState<SetDraft>({
    weight: recordsNumericLoad ? appendedWeight ?? defaultWeight : null,
    weightUnit: recordsNumericLoad &&
        (appendedWeight != null || defaultWeight != null)
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
      ? `${exercise.targetSets}×${exercise.targetRepsMin}–${exercise.targetRepsMax}` +
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
      const plannedWeight =
        appended.plannedLoad != null && appended.plannedLoadUnit != null
          ? convertWeight(
              appended.plannedLoad,
              appended.plannedLoadUnit,
              unit,
            )
          : defaultWeight;
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
  const latestAcknowledgedSet = prioritizeCurrentAction
    ? [...exercise.sets]
        .filter(
          (set) => set.saveState === "saved" && set.setNo < nextSetNo,
        )
        .sort((left, right) => right.setNo - left.setNo)[0] ?? null
    : null;
  const displayedAcknowledgementReceipt =
    acknowledgementReceipt ??
    (isCurrentExercise && prioritizeCurrentAction && latestAcknowledgedSet
      ? {
          sessionExerciseId: exercise.id,
          exerciseName: exercise.name,
          metricType:
            latestAcknowledgedSet.metricType ??
            exercise.metricType ??
            "weight_reps",
          set: latestAcknowledgedSet,
        }
      : null);

  function handleAcknowledgementCorrection(result: {
    values: CorrectedSetValues;
    historyRevision: number;
  }) {
    if (!displayedAcknowledgementReceipt) return;
    if (displayedAcknowledgementReceipt.sessionExerciseId === exercise.id) {
      onPatch({
        sets: exercise.sets.map((candidate) =>
          candidate.id === displayedAcknowledgementReceipt.set.id
            ? {
                ...candidate,
                ...result.values,
                correctionCount: (candidate.correctionCount ?? 0) + 1,
              }
            : candidate,
        ),
      });
    }
    onHistoryRevisionChange(result.historyRevision);
    const measurement = readActiveWorkoutMeasurements().find(
      (record) =>
        (displayedAcknowledgementReceipt.set.clientKey != null &&
          record.clientKey === displayedAcknowledgementReceipt.set.clientKey) ||
        record.setId === displayedAcknowledgementReceipt.set.id,
    );
    if (measurement) {
      patchActiveWorkoutMeasurement(measurement.clientKey, {
        corrections: measurement.corrections + 1,
      });
    }
  }
  // A failed or delayed write owns its occurrence until acknowledgement. Put
  // that exact recovery row ahead of the later blocked row so the user never
  // has to hunt for the action that can move the workout forward.
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
  const hasWarmupGuidance =
    exercise.modificationType !== "substituted" &&
    !!exercise.warmupNotes?.trim();
  const warmupGuidance = hasWarmupGuidance ? (
    <p className="mt-1 whitespace-pre-line text-muted-foreground">
      {exercise.warmupNotes}
    </p>
  ) : null;

  function plannedNote(index: number): string | null {
    if (exercise.modificationType === "substituted") return null;
    return exercise.setNotes[index]?.trim() || null;
  }

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

  const immediateRowOrder = plannedRowOrder.filter(rowNeedsImmediateAttention);
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
      skipReason: null,
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
    setNote("");
  }

  return (
    <section
      id={`exercise-${exercise.id}`}
      aria-labelledby={`session-exercise-heading-${exercise.id}`}
      data-testid={isCurrentExercise ? "current-exercise-card" : undefined}
      data-current-set={isCurrentExercise ? "true" : "false"}
      data-draft-identity={draftIdentity}
      className={cn(
        "scroll-mt-32 rounded-xl border bg-card [&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11",
        isCurrentExercise &&
          "border-2 border-foreground/70 bg-muted/25 shadow-[var(--shadow-soft)]",
        exercise.supersetKey && "border-l-4 border-l-primary/50",
        isSkipped && "border-dashed bg-muted/20"
      )}
      onClickCapture={() => {
        if (isCurrentPlannedSet) tapsRef.current += 1;
      }}
      onFocusCapture={() => {
        if (isCurrentPlannedSet) focusChangesRef.current += 1;
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`session-exercise-details-${exercise.id}`}
        className="flex w-full items-center justify-between gap-2 p-2 text-left"
      >
        <ExerciseFamilyIcon
          media={exercise.media}
          family={exercise.family}
          exerciseName={exercise.name}
          movementPattern={exercise.movementPattern}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2
              id={`session-exercise-heading-${exercise.id}`}
              className={cn(
                "min-w-0 font-medium",
                isCurrentExercise
                  ? "break-words text-lg font-semibold leading-tight"
                  : "truncate",
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
              ? `Skipped (${exercise.skipReason})`
              : exercise.modificationType === "added"
                ? `${progress.workoutOnlyPerformed}/${progress.workoutOnly || "–"} done${progress.extraPerformed > 0 ? ` · ${progress.extraPerformed} extra` : ""}${devicePendingSets > 0 ? ` · ${devicePendingSets} saving` : ""} · Workout only`
                : isCurrentExercise
                  ? `${progress.plannedPerformed}/${progress.planned || "–"} done${progress.extraPerformed > 0 ? ` · ${progress.extraPerformed} extra` : ""}${devicePendingSets > 0 ? ` · ${devicePendingSets} saving` : ""}`
                  : `${progress.plannedPerformed}/${progress.planned || "–"} planned performed${progress.extraPerformed > 0 ? ` · ${progress.extraPerformed} extra` : ""}${devicePendingSets > 0 ? ` · ${devicePendingSets} saving` : ""} · ${targetText} · ${formatRestTime(exercise.restSec)} rest`}
            {exercise.modificationType === "substituted" &&
              ` · instead of ${exercise.plannedExerciseName ?? "planned exercise"}`}
          </p>
          {groupContext && (
            <p className="text-xs font-medium text-foreground">
              {groupContext.name} · member {groupContext.memberOrder} of{" "}
              {groupContext.memberCount}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {exercise.modificationType === "added" && (
            <Badge variant="outline">Workout only</Badge>
          )}
          {exercise.supersetKey && (
            <Badge variant="outline" aria-label="Exercise group">
              SS
            </Badge>
          )}
          <ChevronDown
            className={cn("size-4 transition-transform", expanded && "rotate-180")}
          />
        </div>
      </button>

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
            {immediateRowOrder.map((i) => {
              const set = exercise.sets.find((candidate) => candidate.setNo === i + 1);
              const occurrenceForRow = workingOccurrences.find(
                (occurrence) => occurrence.kindOrdinal === i,
              ) ?? null;
              const occurrenceMutation =
                occurrenceForRow == null
                  ? null
                  : occurrenceMutationEntries.find(
                      (entry) => entry.occurrenceId === occurrenceForRow.id,
                    ) ?? null;
              const occurrenceAcknowledged =
                occurrenceForRow != null &&
                acknowledgedOccurrenceIds.includes(occurrenceForRow.id);
              const rowPosition =
                occurrenceForRow == null
                  ? null
                  : workingSetDisplayPosition(
                      occurrenceForRow,
                      workingOccurrences,
                    );
              const noteForSet = plannedNote(i);
              if (set) {
                const awaitingSave =
                  set.saveState != null && set.saveState !== "saved";
                const setRowLabel = rowPosition?.label ?? `Set ${i + 1}`;
                return (
                  <div
                    key={set.id}
                    id={`logged-set-${exercise.id}-${set.setNo}`}
                    className={cn(
                      "rounded-lg px-3 py-2 text-sm",
                      awaitingSave ? "border bg-background" : "bg-primary/5",
                    )}
                  >
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                        <span className="text-muted-foreground">
                          {setRowLabel}
                        </span>
                        <span className="break-words text-right font-medium tabular-nums">
                          {formatLoggedSet(set, exercise.metricType)}
                          {set.rpe != null &&
                            ` · ${effortChoiceForLegacyRpe(set.rpe)?.label ?? `RPE ${set.rpe}`}`}
                          {!awaitingSave && (
                            <Check className="ml-2 inline size-3.5 text-green-600" />
                          )}
                        </span>
                      </div>
                      {set.note && (
                        <p className="mt-1 text-xs text-muted-foreground">{set.note}</p>
                      )}
                      {formatLoggedExceptionContext(set).map((context) => (
                        <p
                          key={context}
                          className="mt-1 text-xs text-muted-foreground"
                        >
                          {context}
                        </p>
                      ))}
                    </div>
                    <PendingSetSaveStatus
                      set={set}
                      rowLabel={setRowLabel}
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
                    {!awaitingSave && (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                        <span className="text-xs text-muted-foreground">
                          {(set.correctionCount ?? 0) > 0
                            ? `${set.correctionCount} saved correction${
                                set.correctionCount === 1 ? "" : "s"
                              } · original retained in Edit history`
                            : "Acknowledged by Repbook"}
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {(set.metricType ?? performedMetricType) === "activity" ? (
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
                              metricType={set.metricType ?? performedMetricType}
                              rpe={set.rpe}
                              note={set.note}
                              historyRevision={historyRevision}
                              source="active_workout"
                              onAcknowledged={(result) => {
                                onPatch({
                                  sets: exercise.sets.map((candidate) =>
                                    candidate.id === set.id
                                      ? {
                                          ...candidate,
                                          ...result.values,
                                          correctionCount:
                                            (candidate.correctionCount ?? 0) + 1,
                                        }
                                      : candidate,
                                  ),
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
                    )}
                  </div>
                );
              }
              if (
                occurrenceForRow &&
                occurrenceForRow.outcome !== "pending"
              ) {
                return (
                  <div
                    key={occurrenceForRow.id}
                    className="rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span>{rowPosition?.label ?? `Set ${i + 1}`}</span>
                      <span className="capitalize text-muted-foreground">
                        {occurrenceForRow.outcome.replace("_", " ")}
                      </span>
                    </div>
                    {occurrenceForRow.outcomeNote && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Note: {occurrenceForRow.outcomeNote}
                      </p>
                    )}
                    <OccurrenceSaveStatus
                      entry={occurrenceMutation}
                      displayLabel={rowPosition?.label ?? `Set ${i + 1}`}
                      runtimeState={
                        occurrenceMutation
                          ? occurrenceRuntimeSaveStates[
                              occurrenceMutation.clientKey
                            ] ?? null
                          : null
                      }
                      saved
                      onRetry={onRetryOccurrenceMutation}
                      onDiscard={onDiscardOccurrenceMutation}
                    />
                  </div>
                );
              }
              if (appendedOccurrence?.kindOrdinal === i) {
                return (
                  <div
                    key={appendedOccurrence.id}
                    id={`added-set-entry-${exercise.id}-${appendedOccurrence.id}`}
                    data-testid="added-set-entry"
                    className="scroll-mt-24 rounded-md border-2 border-foreground/60 bg-background p-2"
                  >
                    <p className="mb-2 px-1 text-sm font-semibold">
                      {workingSetDisplayPosition(
                        appendedOccurrence,
                        workingOccurrences,
                      ).label} · Added to this workout
                    </p>
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
                    />
                    <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                      {skipConfirmationError == null ? (
                        <Button
                          onClick={() =>
                            handleLog(i + 1, appendedOccurrence, appendedDraft)
                          }
                          disabled={
                            pending ||
                            skipConfirmationPending ||
                            !metricSupported ||
                            appendedLoggingBlocked ||
                            Boolean(occurrenceMutation) ||
                            logRequestKey === appendedOccurrence.id
                          }
                        >
                          <Check className="size-4" /> Log set
                        </Button>
                      ) : (
                        <p className="flex min-h-11 items-center text-sm font-medium">
                          Resolve the exercise skip before logging sets.
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          occurrenceChangesBlocked ||
                          Boolean(occurrenceMutation)
                        }
                        onClick={() => setSkipSetOccurrence(appendedOccurrence)}
                      >
                        Skip set
                      </Button>
                    </div>
                    <OccurrenceSaveStatus
                      entry={occurrenceMutation}
                      displayLabel={workingSetDisplayPosition(
                        appendedOccurrence,
                        workingOccurrences,
                      ).label}
                      runtimeState={
                        occurrenceMutation
                          ? occurrenceRuntimeSaveStates[
                              occurrenceMutation.clientKey
                            ] ?? null
                          : null
                      }
                      saved={occurrenceAcknowledged}
                      onRetry={onRetryOccurrenceMutation}
                      onDiscard={onDiscardOccurrenceMutation}
                    />
                  </div>
                );
              }
              if (i === nextSetIdx) {
                if (isCurrentPlannedSet && !activeLoggingBlocked) {
                  return (
                    <div
                      key={`active-${i}`}
                      id={`set-entry-${exercise.id}-${activeOccurrence.id}`}
                      data-testid="current-set-entry"
                      className={cn(
                        "scroll-mt-24 p-2",
                        prioritizeCurrentAction
                          ? "rounded-lg border-2 border-primary/60 bg-background p-2 shadow-sm"
                          : "rounded-md border border-primary/40",
                      )}
                    >
                      <div data-testid="active-workout-primary">
                      {prioritizeCurrentAction ? (
                        <div className="mb-3 rounded-lg bg-primary px-3 py-2.5 text-primary-foreground">
                          <p className="text-xs font-semibold uppercase tracking-[0.12em] opacity-80">
                            Current action
                          </p>
                          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                            <p className="break-words text-base font-semibold leading-tight">
                              {exercise.name}
                            </p>
                            <p className="text-xl font-bold tabular-nums">
                              {rowPosition?.label ?? `Set ${i + 1}`} of {exercise.targetSets ?? "open"}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <p className="mb-2 px-1 text-sm font-medium">
                          Set {i + 1} of {exercise.targetSets ?? "open"}
                        </p>
                      )}
                      <div className="mb-3 grid grid-cols-1 gap-2 min-[520px]:grid-cols-2">
                        <div
                          data-testid="current-set-target"
                          className="rounded-lg border bg-muted/25 px-3 py-2 text-sm"
                        >
                          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                            Target
                          </p>
                          <p className="mt-1 break-words font-semibold tabular-nums">
                            {formatSetTarget(activeOccurrence, exercise)}
                          </p>
                        </div>
                        <div
                          data-testid="previous-comparable-set"
                          data-comparison-state={comparableRenderState}
                          className="rounded-lg border bg-muted/25 px-3 py-2 text-sm"
                        >
                        {comparableRenderState === "available" &&
                        comparableProjection?.status === "available" &&
                        previousComparableSet ? (
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                            <div className="min-w-0">
                              <p className="break-words text-xs text-muted-foreground">
                                Previous · {comparableProjection.source.localDate} · {compactComparableProvenance(
                                  previousComparableSet,
                                  comparableProjection.source.workoutSource,
                                )}
                              </p>
                              <p className="mt-1 break-words font-semibold tabular-nums">
                                {formatPreviousComparableSet(
                                  previousComparableSet,
                                  comparableProjection.semantics.metricType,
                                )} · source set {previousComparableSet.setNo}
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
                        ) : comparableRenderState === "loading" ? (
                          <p
                            role="status"
                            className="flex min-h-11 items-center font-medium"
                          >
                            Checking previous comparable set…
                          </p>
                        ) : (
                          <p className="flex min-h-11 items-center font-medium">
                            Previous comparable set unavailable
                          </p>
                        )}
                        </div>
                      </div>
                      {prioritizeCurrentAction && (
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Performed measure</p>
                      )}
                      <SetEntry
                        metricType={performedMetricType}
                        supported={metricSupported}
                        draft={draft}
                        setDraft={setDraft}
                        stepWeight={stepWeight}
                        unit={unit}
                        hasWeight={recordsNumericLoad}
                        weightLabel={liveWeightLabel}
                        plateConfig={plateConfig}
                        machineLoadConfig={machineLoadConfig}
                        prioritizePerformedMeasure
                      />
                      <div
                        className={cn(
                          prioritizeCurrentAction
                            ? "mt-3"
                            : "mt-2 grid grid-cols-[1fr_auto] gap-2",
                        )}
                      >
                        {skipConfirmationError == null ? (
                          <Button
                            data-testid="active-log-set"
                            className={cn(
                              prioritizeCurrentAction &&
                                "min-h-12 w-full text-base font-semibold",
                            )}
                            onClick={() => handleLog()}
                            disabled={
                              pending ||
                              skipConfirmationPending ||
                              !metricSupported ||
                              Boolean(occurrenceMutation) ||
                              activeLoggingBlocked ||
                              logRequestKey === activeOccurrence.id
                            }
                          >
                            <Check className="size-4" /> Log set
                          </Button>
                        ) : (
                          <p className="flex min-h-11 items-center text-sm font-medium">
                            Resolve the exercise skip before logging sets.
                          </p>
                        )}
                        {!prioritizeCurrentAction && (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={
                              occurrenceChangesBlocked ||
                              Boolean(occurrenceMutation)
                            }
                            onClick={() =>
                              setSkipSetOccurrence(activeOccurrence)
                            }
                          >
                            Skip set
                          </Button>
                        )}
                      </div>
                      </div>
                      <OccurrenceSaveStatus
                        entry={occurrenceMutation}
                        displayLabel={workingSetDisplayPosition(
                          activeOccurrence,
                          workingOccurrences,
                        ).label}
                        runtimeState={
                          occurrenceMutation
                            ? occurrenceRuntimeSaveStates[
                                occurrenceMutation.clientKey
                              ] ?? null
                            : null
                        }
                        saved={occurrenceAcknowledged}
                        onRetry={onRetryOccurrenceMutation}
                        onDiscard={onDiscardOccurrenceMutation}
                      />
                      {prioritizeCurrentAction && (
                        <div className="mt-1 flex min-h-11 items-center gap-2 border-t">
                          <p className="shrink-0 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            Next action
                          </p>
                          <p className="min-w-0 break-words py-2 text-sm">
                            {nextActionLabel}
                          </p>
                        </div>
                      )}
                      <details className="mt-1 rounded-md border border-dashed text-sm">
                        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 rounded-md px-2 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                          <span>Set options</span>
                          <span className="break-words text-right text-xs text-muted-foreground">
                            {prioritizeCurrentAction
                              ? "Effort, note or skip"
                              : "Effort or note"}
                          </span>
                        </summary>
                        <div className="space-y-3 border-t p-3">
                          <section
                            aria-labelledby={`optional-set-fields-${exercise.id}`}
                          >
                            <h3
                              id={`optional-set-fields-${exercise.id}`}
                              className="mb-2 font-medium"
                            >
                              Optional effort and set note
                            </h3>
                            <SetEntry
                              metricType={performedMetricType}
                              supported={metricSupported}
                              draft={draft}
                              setDraft={setDraft}
                              stepWeight={stepWeight}
                              unit={unit}
                              hasWeight={recordsNumericLoad}
                              weightLabel={liveWeightLabel}
                              plateConfig={plateConfig}
                              machineLoadConfig={machineLoadConfig}
                              optionalOnly
                            />
                          </section>
                          {prioritizeCurrentAction && (
                              <section
                                aria-labelledby={`set-exceptions-${exercise.id}`}
                                className="border-t pt-3"
                              >
                                <h3
                                  id={`set-exceptions-${exercise.id}`}
                                  className="mb-2 font-medium"
                                >
                                  Set exceptions
                                </h3>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="w-full"
                                  disabled={
                                    occurrenceChangesBlocked ||
                                    Boolean(occurrenceMutation)
                                  }
                                  onClick={() =>
                                    setSkipSetOccurrence(activeOccurrence)
                                  }
                                >
                                  Skip set
                                </Button>
                              </section>
                          )}
                        </div>
                      </details>
                    </div>
                  );
                }
                return (
                  <div key={`active-${i}`} className="rounded-md border border-primary/40 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span>Set {i + 1}</span>
                      <span className="text-muted-foreground">
                        {activeLoggingBlocked
                          ? "Waiting for save acknowledgement"
                          : "Reach this set in the workout flow"}
                      </span>
                    </div>
                    {plannedNote(i) && (
                      <p className="mt-1 text-muted-foreground">{plannedNote(i)}</p>
                    )}
                  </div>
                );
              }
              return (
                <div
                  key={`future-${i}`}
                  className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
                >
                  <div className="flex items-center justify-between">
                    <span>Set {i + 1}</span>
                    <span>—</span>
                  </div>
                  {noteForSet && <p className="mt-1 text-xs">{noteForSet}</p>}
                </div>
              );
            })}

            {displayedAcknowledgementReceipt && (
              <ActiveSetSaveReceipt
                receipt={displayedAcknowledgementReceipt}
                currentExerciseId={exercise.id}
                historyRevision={historyRevision}
                onAcknowledged={handleAcknowledgementCorrection}
              />
            )}

            <details className="mt-1 rounded-lg border bg-muted/15 text-sm">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-2 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                <span>Exercise progress &amp; extras</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {exercise.sets.filter(
                    (set) => set.saveState == null || set.saveState === "saved",
                  ).length} logged
                </span>
              </summary>
              <div className="space-y-2 border-t p-2">
                {disclosedRowOrder.map((i) => {
                  const set = exercise.sets.find(
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
                  const noteForSet = plannedNote(i);

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

                  return (
                    <div
                      key={`future-${i}`}
                      className="rounded-md border border-dashed px-3 py-2 text-muted-foreground"
                    >
                      <div className="flex items-center justify-between">
                        <span>Set {i + 1}</span>
                        <span>Upcoming</span>
                      </div>
                      {noteForSet && (
                        <p className="mt-1 text-xs">{noteForSet}</p>
                      )}
                    </div>
                  );
                })}
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
                <p
                  id={`add-set-description-${exercise.id}`}
                  className="px-1 text-xs text-muted-foreground"
                >
                  Adds ad-hoc work without changing the planned set order.
                  Finish or skip this extra before adding one more.
                </p>
              </div>
            </details>
          </div>

          <details className="rounded-lg border bg-muted/15 text-sm">
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-2 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <span>More for this exercise</span>
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                Notes, form &amp; swaps
              </span>
            </summary>
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
                    ? ALTERNATIVE_REASON_LABELS[exercise.substitutionReason]
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
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
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
                expectedHistoryRevision={historyRevision}
                open={adjustIntent === "skip"}
                onRequestStart={onSkipRequestStart}
                onRequestFailure={onSkipRequestFailure}
                onOpenChange={(open) =>
                  onAdjustIntentChange(open ? "skip" : null)
                }
                onDone={(reason, resultHistoryRevision) => {
                  onAdjustIntentChange(null);
                  onHistoryRevisionChange(resultHistoryRevision);
                  onPatch({ modificationType: "skipped", skipReason: reason });
                }}
              />
            </div>
          </section>

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
                      onDone={(candidate, reason) => {
                        const metricType = performedMetricTypeForLivePatch(
                          candidate.metricType,
                        );
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
                          skipReason: null,
                          substitutedForExerciseId:
                            exercise.substitutedForExerciseId ?? exercise.exerciseId,
                          substitutionReason: reason,
                          substitutedAt: new Date().toISOString(),
                          plannedExerciseName:
                            exercise.plannedExerciseName ?? exercise.name,
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
                        setNote("");
                      }}
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
                      open={adjustIntent === "replace"}
                      onOpenChange={(open) =>
                        onAdjustIntentChange(open ? "replace" : null)
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

      {expanded && isSkipped && (
        <div className="flex flex-col gap-3 border-t p-3">
          <div
            id={`skip-recovery-description-${exercise.id}`}
            role="status"
            className="rounded-lg border bg-background p-3"
          >
            <h3 className="text-sm font-semibold">Exercise skipped</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Replace it for this workout, or deliberately continue. Your saved
              Program is unchanged.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <ReplacementDrawer
              exerciseId={exercise.id}
              describedBy={`skip-recovery-description-${exercise.id}`}
              open={adjustIntent === "replace"}
              onOpenChange={(open) =>
                onAdjustIntentChange(open ? "replace" : null)
              }
              onReconcile={reconcileReplacement}
              onDone={applyReplacement}
            />
            <Button type="button" onClick={onSkipComplete}>
              Continue without replacement
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    const result = await confirmExerciseUnskipped({
                      sessionExerciseId: exercise.id,
                      expectedHistoryRevision: historyRevision,
                    });
                    if (!result.ok) {
                      toast.error(result.message);
                      if (result.code === "unskip_stale") router.refresh();
                      return;
                    }
                    onHistoryRevisionChange(result.historyRevision);
                  } catch (error) {
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

function SetEntry({
  metricType,
  supported,
  draft,
  setDraft,
  stepWeight,
  unit,
  hasWeight,
  weightLabel,
  plateConfig,
  machineLoadConfig,
  prioritizePerformedMeasure = false,
  optionalOnly = false,
}: {
  metricType: PerformedMetricType;
  supported: boolean;
  draft: SetDraft;
  setDraft: React.Dispatch<React.SetStateAction<SetDraft>>;
  stepWeight: (current: number | null, dir: 1 | -1) => number | null;
  unit: string;
  hasWeight: boolean;
  weightLabel?: string;
  plateConfig?: PlateMathConfig;
  machineLoadConfig?: MachineLoadConfig | null;
  prioritizePerformedMeasure?: boolean;
  optionalOnly?: boolean;
}) {
  const weightInputId = useId();
  const distanceInputId = useId();
  const durationInputId = useId();
  const exactRpeId = useId();
  const exactRirId = useId();
  const [exactOpen, setExactOpen] = useState(
    draft.rpe != null && !RPE_CHIPS.some((chip) => chip.value === draft.rpe),
  );
  const plateLine =
    (unit === "lb" || unit === "kg")
      ? formatCompactPlateLoadGuidance(draft.weight, plateConfig, unit)
      : null;
  const machineLine =
    (unit === "lb" || unit === "kg") && machineLoadConfig
      ? formatMachineLoadGuidance(draft.weight, machineLoadConfig)
      : null;
  const selectedEffort = EFFORT_CHOICES.find(
    (choice) => draft.rir == null && choice.legacyRpe === draft.rpe,
  );
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
      <p className="text-sm text-muted-foreground">
        All fields below are optional. Record effort as either RIR or RPE;
        leaving it blank keeps effort unknown.
      </p>
      <div aria-live="polite" aria-atomic="true">
        {selectedEffort && !exactOpen && (
          <p className="text-sm font-medium">
            Selected: {selectedEffort.label} — RPE {selectedEffort.legacyRpe}
          </p>
        )}
      </div>
      <div
        role="group"
        aria-label="Effort shortcuts"
        className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
      >
        {RPE_CHIPS.map((chip) => (
          <Button
            key={chip.value}
            variant={draft.rpe === chip.value ? "default" : "outline"}
            size="sm"
            className="h-auto min-h-11 whitespace-normal text-xs"
            aria-label={`${chip.shortcutLabel}; ${chip.meaning}`}
            aria-pressed={draft.rpe === chip.value && draft.rir == null}
            onClick={() =>
              setDraft((d) => ({
                ...d,
                rpe: d.rpe === chip.value ? null : chip.value,
                rir: null,
              }))
            }
          >
            {chip.shortcutLabel}
          </Button>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        aria-expanded={exactOpen}
        onClick={() => setExactOpen((open) => !open)}
      >
        {exactOpen ? "Hide exact RPE" : "Enter exact RPE instead"}
      </Button>
      {exactOpen && (
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
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                rpe:
                  event.target.value === ""
                    ? null
                    : Math.min(10, Math.max(1, Number(event.target.value))),
                rir: null,
              }))
            }
          />
        </div>
      )}
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
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              rir:
                event.target.value === ""
                  ? null
                  : Math.min(10, Math.max(0, Number(event.target.value))),
              rpe: null,
            }))
          }
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Reps you believe remained. Entering RIR clears RPE.
        </p>
      </div>
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
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          "grid items-end gap-2",
          (hasWeight && recordsRepetitions) ||
            metricType === "distance_duration"
            ? "grid-cols-1 min-[520px]:grid-cols-2"
            : "grid-cols-1 sm:grid-cols-2",
        )}
      >
        {hasWeight && (
          <div className="flex min-w-0 flex-col gap-1">
            {weightLabel && (
              <label htmlFor={weightInputId} className="text-xs font-medium">
                {weightLabel}
              </label>
            )}
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="active-set-stepper shrink-0"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    weight: stepWeight(d.weight, -1),
                  }))
                }
                aria-label="Decrease weight"
              >
                <Minus className="size-4" />
              </Button>
              <div className="relative min-w-0 flex-1">
                <Input
                  id={weightInputId}
                  aria-label={weightLabel ?? "Weight"}
                  inputMode="decimal"
                  className="pr-8 text-center text-base font-medium"
                  value={draft.weight ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      weight:
                        e.target.value === "" ? null : Number(e.target.value),
                    }))
                  }
                />
                <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                  {unit}
                </span>
              </div>
              <Button
                variant="outline"
                size="icon"
                className="active-set-stepper shrink-0"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    weight: stepWeight(d.weight, 1),
                  }))
                }
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
            className="active-set-stepper shrink-0"
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
              className="pr-10 text-center text-base font-medium"
              value={draft.reps ?? ""}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  reps: e.target.value === "" ? null : Number(e.target.value),
                }))
              }
            />
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
              reps
            </span>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="active-set-stepper shrink-0"
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
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  distanceKm:
                    event.target.value === "" ? null : Number(event.target.value),
                }))}
              />
              <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                km
              </span>
            </div>
          </div>
        )}
        {(metricType === "duration" || metricType === "distance_duration") && (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={durationInputId} className="text-xs font-medium">
              Duration {metricType === "distance_duration" ? "(optional)" : ""}
            </label>
            <div className="relative">
              <Input
                id={durationInputId}
                aria-label="Duration in seconds"
                inputMode="numeric"
                className="pr-10 text-center text-base font-medium"
                value={draft.durationSeconds ?? ""}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  durationSeconds:
                    event.target.value === "" ? null : Number(event.target.value),
                }))}
              />
              <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                sec
              </span>
            </div>
          </div>
        )}
      </div>
      {(machineLine ?? plateLine) && (
        <p className="rounded-md bg-muted/50 px-2 py-1.5 text-sm text-muted-foreground" aria-live="polite">
          {machineLine ?? plateLine}
        </p>
      )}
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
  expectedHistoryRevision,
  open,
  onOpenChange,
  onRequestStart,
  onRequestFailure,
  onDone,
}: {
  exerciseId: string;
  expectedHistoryRevision: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestStart: (
    reason: "time" | "pain" | "fatigue" | "equipment" | "other",
  ) => void;
  onRequestFailure: (
    reason: "time" | "pain" | "fatigue" | "equipment" | "other",
    code?: string,
  ) => void;
  onDone: (
    reason: "time" | "pain" | "fatigue" | "equipment" | "other",
    historyRevision: number,
  ) => void;
}) {
  const [pending, startTransition] = useTransition();
  const reasons = ["time", "pain", "fatigue", "equipment", "other"] as const;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerTrigger render={<Button variant="outline" size="sm" />}>
        Skip exercise
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11">
        <DrawerHeader>
          <DrawerTitle>Skip exercise — why?</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-wrap gap-2 px-4 pb-6">
          {reasons.map((reason) => (
            <Button
              key={reason}
              variant="outline"
              disabled={pending}
              onClick={() => {
                onRequestStart(reason);
                startTransition(async () => {
                  try {
                    const result = await skipExercise({
                      sessionExerciseId: exerciseId,
                      reason,
                      expectedHistoryRevision,
                    });
                    if (!result.ok) {
                      onRequestFailure(reason, result.code);
                      toast.error(result.message);
                      return;
                    }
                    onOpenChange(false);
                    onDone(reason, result.historyRevision);
                  } catch {
                    onRequestFailure(reason);
                    toast.error("The exercise could not be skipped.");
                    return;
                  }
                });
              }}
            >
              {reason}
            </Button>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
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
  type AlternativeOptions = Extract<
    Awaited<ReturnType<typeof getAlternativeOptions>>,
    { ok: true }
  >;
  const [options, setOptions] = useState<AlternativeOptions | null>(null);
  const [reason, setReason] = useState<ExerciseAlternativeReason>("variety");
  const [pending, startTransition] = useTransition();
  const onOpenChangeRef = useRef(onOpenChange);

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  function handleOpen(next: boolean) {
    onOpenChange(next);
  }

  useEffect(() => {
    if (!open || options != null) return;
    let ignore = false;
    startTransition(async () => {
      try {
        const result = await getAlternativeOptions(exerciseId);
        if (ignore) return;
        if (!result.ok) {
          toast.error(result.message);
          onOpenChangeRef.current(false);
          return;
        }
        setOptions(result);
      } catch {
        if (ignore) return;
        toast.error("Alternatives could not be loaded.");
        onOpenChangeRef.current(false);
      }
    });
    return () => {
      ignore = true;
    };
  }, [exerciseId, open, options]);

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
              {(Object.keys(ALTERNATIVE_REASON_LABELS) as ExerciseAlternativeReason[]).map(
                (value) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={reason === value ? "default" : "outline"}
                    disabled={pending}
                    aria-pressed={reason === value}
                    onClick={() => setReason(value)}
                  >
                    {ALTERNATIVE_REASON_LABELS[value]}
                  </Button>
                )
              )}
            </div>
          </div>
          {options == null ? (
            <p className="py-4 text-sm text-muted-foreground">Loading…</p>
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
                  onOpenChange(false);
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
}) {
  const [options, setOptions] = useState<ReplacementOptions | null>(null);
  const [reason, setReason] = useState<ExerciseAlternativeReason>("variety");
  const [pending, startTransition] = useTransition();
  const mutationRef = useRef<{ signature: string; id: string } | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(() => {
    if (!open || options != null) return;
    let ignore = false;
    startTransition(async () => {
      try {
        const result = await getReplacementOptions(exerciseId);
        if (ignore) return;
        if (!result.ok) {
          toast.error(result.message);
          onOpenChangeRef.current(false);
          return;
        }
        setOptions(result);
      } catch {
        if (ignore) return;
        toast.error("The exercise catalog could not be loaded.");
        onOpenChangeRef.current(false);
      }
    });
    return () => {
      ignore = true;
    };
  }, [exerciseId, open, options]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-describedby={describedBy}
          />
        }
      >
        Replace exercise
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11">
        <DrawerHeader>
          <DrawerTitle>Replace exercise for this workout</DrawerTitle>
        </DrawerHeader>
        <div className="max-h-[60dvh] space-y-4 overflow-y-auto px-4 pb-6">
          <div>
            <p className="mb-2 text-sm text-muted-foreground">
              Why are you replacing it?
            </p>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(ALTERNATIVE_REASON_LABELS) as ExerciseAlternativeReason[]).map(
                (value) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={reason === value ? "default" : "outline"}
                    disabled={pending}
                    aria-pressed={reason === value}
                    onClick={() => setReason(value)}
                  >
                    {ALTERNATIVE_REASON_LABELS[value]}
                  </Button>
                ),
              )}
            </div>
          </div>
          {options == null ? (
            <p className="py-4 text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ExercisePicker
              items={options.items}
              itemWarnings={options.warnings}
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
                const signature = `${options.currentExerciseId}:${selected.id}:${reason}`;
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
                    reason,
                    clientMutationId: mutationRef.current.id,
                  });
                  if (!result.ok) {
                    toast.error(result.message);
                    if (result.code === "replacement_stale") {
                      mutationRef.current = null;
                      try {
                        const refreshed = await getReplacementOptions(exerciseId);
                        if (refreshed.ok) {
                          setOptions(refreshed);
                          const authoritative = refreshed.items.find(
                            (item) => item.id === refreshed.currentExerciseId,
                          );
                          if (authoritative) {
                            onReconcile(
                              authoritative,
                              refreshed.currentState,
                              refreshed.plannedExerciseName,
                            );
                          }
                        }
                      } catch {
                        // The preserved selection remains available for review.
                      }
                    }
                    return false;
                  }
                  const warning = options.warnings[selected.id];
                  if (warning) toast.warning(warning);
                  mutationRef.current = null;
                  onOpenChange(false);
                  setOptions(null);
                  onDone(selected, reason);
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
