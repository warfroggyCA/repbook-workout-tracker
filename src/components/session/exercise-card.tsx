"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  archiveSet,
  skipExercise,
  unskipExercise,
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
import { Button } from "@/components/ui/button";
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
import { formatWarmupSetLine } from "@/lib/warmup";
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
import type { SessionExerciseData, SessionOccurrenceData, LoggedSet } from "./types";
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
  type PerformedMetricType,
} from "@/lib/set-metric-semantics";
import { createClientUuid } from "@/lib/client-uuid";
import type { OccurrenceMutationOutboxEntry } from "@/lib/occurrence-mutation-outbox";
import { CompletedSetCorrection } from "@/components/history/completed-set-correction";

const RPE_CHIPS = EFFORT_CHOICES.map((choice) => ({
  label: choice.label,
  shortcutLabel: `${choice.label} — RPE ${choice.legacyRpe}`,
  meaning: choice.meaning,
  value: choice.legacyRpe,
}));

const BODY_PARTS = ["shoulder", "knee", "back", "elbow", "wrist", "hip", "other"];

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

function formatPerformedDuration(durationSeconds: number) {
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, "0")}`
    : `${seconds} sec`;
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

type SetDraft = {
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
  rpe: number | null;
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
  isCurrentExercise?: boolean;
  warmupResolved?: boolean;
  warmupSkipped?: boolean;
  groupContext?: {
    name: string;
    memberOrder: number;
    memberCount: number;
  } | null;
  occurrenceChangesBlocked?: boolean;
  onPrepareRestCue?: () => void;
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
  onHistoryRevisionChange?: (historyRevision: number) => void;
  onOpenCoach: () => void;
  onSkipComplete: () => void;
  adjustIntent: ExerciseAdjustmentIntent | null;
  onAdjustIntentChange: (intent: ExerciseAdjustmentIntent | null) => void;
};

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
  onPatch,
  onQueueSet,
  onAppendSet = async () => null,
  activeOccurrence = null,
  workingOccurrences = [],
  occurrenceMutationEntries = [],
  occurrenceRuntimeSaveStates = {},
  acknowledgedOccurrenceIds = [],
  isCurrentExercise = false,
  warmupResolved = false,
  warmupSkipped = false,
  groupContext = null,
  occurrenceChangesBlocked = false,
  onPrepareRestCue = () => undefined,
  onSkipSet = async () => false,
  onRetryOccurrenceMutation = () => undefined,
  onDiscardOccurrenceMutation = () => undefined,
  onRetrySet,
  onDiscardSet,
  onHistoryRevisionChange = () => undefined,
  onOpenCoach,
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
  const unresolvedPlannedWorkingSet = workingOccurrences.some(
    (occurrence) =>
      occurrence.outcome === "pending" &&
      !isAppendedExtraSetOccurrence(occurrence),
  ) || (
    activeOccurrence?.kind === "working_set" &&
    activeOccurrence.outcome === "pending" &&
    !isAppendedExtraSetOccurrence(activeOccurrence)
  );
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
  const prefillFrom =
    [...exercise.sets]
      .filter((set) => set.setNo < nextSetNo)
      .sort((left, right) => right.setNo - left.setNo)[0] ??
    exercise.last?.sets[Math.min(nextSetIdx, (exercise.last?.sets.length ?? 1) - 1)];

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

  const [draft, setDraft] = useState<SetDraft>({
    weight: recordsNumericLoad ? defaultWeight : null,
    weightUnit: recordsNumericLoad
      ? defaultWeight == null ? null : unit
      : null,
    reps: defaultReps,
    distanceKm: null,
    durationSeconds: null,
    rpe: null,
    note: defaultSetNote,
  });
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
    note: "",
  });
  const [appendingSet, setAppendingSet] = useState(false);
  const appendRequestRef = useRef<string | null>(null);
  const appendFocusRequestRef = useRef<string | null>(null);
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
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
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
    if (exercise.sets.some((set) => set.saveState != null && set.saveState !== "saved")) {
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
    if (occurrence && occurrence.restAfterSec > 0) onPrepareRestCue();
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
      note: exercise.setNotes[setNo] ?? "",
    });
    if (occurrence?.id === appendedOccurrence?.id) {
      setAppendedDraft(resetSubmittedDraft);
    } else {
      setDraft(resetSubmittedDraft);
    }
  }

  async function handleAppendSet() {
    if (
      appendingSet ||
      appendRequestRef.current ||
      appendedOccurrence ||
      unresolvedPlannedWorkingSet
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
  const isCurrentPlannedSet =
    activeOccurrence?.sessionExerciseId === exercise.id &&
    activeOccurrence.kind === "working_set" &&
    activeOccurrence.kindOrdinal === nextSetIdx;
  const hasWarmup =
    exercise.modificationType !== "substituted" &&
    (!!exercise.warmupNotes?.trim() || exercise.warmupSets.length > 0);
  const warmupGuidance = hasWarmup ? (
    <>
      {exercise.warmupNotes && (
        <p className="mt-1 text-muted-foreground">{exercise.warmupNotes}</p>
      )}
      {exercise.warmupSets.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
          {exercise.warmupSets.map((set, i) => (
            <li key={`${set.label}-${i}`}>{formatWarmupSetLine(set)}</li>
          ))}
        </ul>
      )}
    </>
  ) : null;

  function plannedNote(index: number): string | null {
    if (exercise.modificationType === "substituted") return null;
    return exercise.setNotes[index]?.trim() || null;
  }

  return (
    <section
      id={`exercise-${exercise.id}`}
      aria-labelledby={`session-exercise-heading-${exercise.id}`}
      data-testid={isCurrentExercise ? "current-exercise-card" : undefined}
      data-current-set={isCurrentExercise ? "true" : "false"}
      className={cn(
        "scroll-mt-32 rounded-xl border bg-card [&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11",
        isCurrentExercise &&
          "border-2 border-foreground/70 bg-muted/25 shadow-[var(--shadow-soft)]",
        exercise.supersetKey && "border-l-4 border-l-primary/50",
        isSkipped && "opacity-60"
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
        className="flex w-full items-center justify-between gap-2 p-3 text-left"
      >
        <ExerciseFamilyIcon
          media={exercise.media}
          family={exercise.family}
          exerciseName={exercise.name}
          movementPattern={exercise.movementPattern}
        />
        <div className="min-w-0 flex-1">
          {isCurrentExercise && (
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-foreground">
              Current exercise
            </p>
          )}
          <div className="flex items-center gap-2">
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
          <p className="text-xs text-muted-foreground">
            {isSkipped
              ? `Skipped (${exercise.skipReason})`
              : exercise.modificationType === "added"
                ? `${progress.performed}/${progress.planned || "–"} performed${devicePendingSets > 0 ? ` · ${devicePendingSets} saving` : ""} · Added to this workout · ${formatRestTime(exercise.restSec)} rest`
                : `${progress.performed}/${progress.planned || "–"} performed${devicePendingSets > 0 ? ` · ${devicePendingSets} saving` : ""} · Planned: ${targetText} · ${formatRestTime(exercise.restSec)} rest`}
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

      {expanded && !isSkipped && (
        <div
          id={`session-exercise-details-${exercise.id}`}
          className="flex flex-col gap-3 border-t p-3"
        >
          {exercise.modificationType === "added" && (
            <p className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-sm">
              Added during this workout. It has no Program slot or progression
              target, and your Program remains unchanged.
            </p>
          )}
          {exercise.last && (
            <p className="text-xs text-muted-foreground">
              Last time:{" "}
              {exercise.last.sets
                .map(
                  (s) =>
                    `${s.weight != null && s.weightUnit != null ? `${s.weight} ${s.weightUnit}×` : ""}${s.reps}`
                )
                .join(", ")}
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
                  <span>
                    {warmupSkipped ? "Warm-up finished" : "Warm-up complete"}
                  </span>
                  <span className="text-muted-foreground">Show details</span>
                </summary>
                <div className="border-t px-3 pb-2">{warmupGuidance}</div>
              </details>
            ) : (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                <p className="font-medium text-foreground">Warm-up</p>
                {warmupGuidance}
              </div>
            )
          )}

          {/* Logged sets */}
          <div className="flex flex-col gap-1">
            {Array.from({ length: plannedRows }).map((_, i) => {
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
                return (
                  <div
                    key={set.id}
                    id={`logged-set-${exercise.id}-${set.setNo}`}
                    className="rounded-md bg-primary/5 px-3 py-2 text-sm"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">
                          {rowPosition?.label ?? `Set ${i + 1}`}
                        </span>
                        <span className="font-medium tabular-nums">
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
                    </div>
                    {set.saveState && (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs">
                        <span
                          role={set.saveState === "failed" ? "alert" : "status"}
                          className={cn(
                            "text-muted-foreground",
                            set.saveState === "failed" && "text-destructive"
                          )}
                        >
                          {setSaveStateLabel(set.saveState)}
                        </span>
                        {set.saveState === "failed" && set.lastError && (
                          <p className="basis-full text-amber-800 dark:text-amber-300">
                            {set.lastError}
                          </p>
                        )}
                        {set.saveState === "failed" && set.clientKey && (
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={async () =>
                                await onRetrySet(set.clientKey!)
                              }
                            >
                              Retry
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              onClick={async () =>
                                await onDiscardSet(set.clientKey!)
                              }
                            >
                              Discard
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
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
                      <Button
                        onClick={() =>
                          handleLog(i + 1, appendedOccurrence, appendedDraft)
                        }
                        disabled={
                          pending ||
                          !metricSupported ||
                          Boolean(unconfirmedSet) ||
                          Boolean(occurrenceMutation)
                        }
                      >
                        <Check className="size-4" /> Log set
                      </Button>
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
                if (isCurrentPlannedSet && !unconfirmedSet) {
                  return (
                    <div
                      key={`active-${i}`}
                      id={`set-entry-${exercise.id}-${activeOccurrence.id}`}
                      data-testid="current-set-entry"
                      className="scroll-mt-24 rounded-md border border-primary/40 p-2"
                    >
                      <p className="mb-2 px-1 text-sm font-medium">
                        Set {i + 1} of {exercise.targetSets ?? "open"}
                      </p>
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
                      />
                      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                        <Button
                          onClick={() => handleLog()}
                          disabled={
                            pending || !metricSupported || Boolean(occurrenceMutation)
                          }
                        >
                          <Check className="size-4" /> Log set
                        </Button>
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
                      </div>
                      <OccurrenceSaveStatus
                        entry={occurrenceMutation}
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
                return (
                  <div key={`active-${i}`} className="rounded-md border border-primary/40 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span>Set {i + 1}</span>
                      <span className="text-muted-foreground">
                        {unconfirmedSet ? "Waiting for save acknowledgement" : "Reach this set in the workout flow"}
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
            <Button
              type="button"
              variant="outline"
              className="mt-1 w-full justify-start border-dashed"
              disabled={
                Boolean(unconfirmedSet) ||
                appendingSet ||
                Boolean(appendedOccurrence) ||
                unresolvedPlannedWorkingSet
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
              {unresolvedPlannedWorkingSet
                ? "Finish or skip the sets above before adding an extra."
                : "Adds another set after your planned sets. Finish or skip it before adding one more."}
            </p>
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
                open={adjustIntent === "skip"}
                onOpenChange={(open) =>
                  onAdjustIntentChange(open ? "skip" : null)
                }
                onDone={(reason) => {
                  onAdjustIntentChange(null);
                  onPatch({ modificationType: "skipped", skipReason: reason });
                  onSkipComplete();
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
                      onReconcile={(candidate, state, plannedExerciseName) => {
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
                          substitutedForExerciseId:
                            state.substitutedForExerciseId,
                          substitutionReason: state.substitutionReason,
                          substitutedAt: state.substitutedAt,
                          plannedExerciseName:
                            state.substitutedForExerciseId == null
                              ? null
                              : plannedExerciseName,
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
                            state.targetLoad != null &&
                            state.targetLoadUnit != null
                              ? convertWeight(
                                  state.targetLoad,
                                  state.targetLoadUnit,
                                  unit,
                                )
                              : null,
                          weightUnit:
                            state.targetLoad == null ? null : unit,
                          note:
                            state.setNotes[exercise.sets.length] ?? "",
                        }));
                        setNote(state.notes ?? "");
                        router.refresh();
                      }}
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
        <div className="border-t p-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              startTransition(async () => {
                try {
                  const result = await unskipExercise(exercise.id);
                  if (!result.ok) {
                    toast.error(result.message);
                    return;
                  }
                } catch {
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
}) {
  const weightInputId = useId();
  const distanceInputId = useId();
  const durationInputId = useId();
  const exactRpeId = useId();
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
    (choice) => choice.legacyRpe === draft.rpe,
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
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        {hasWeight && (
          <div className="flex min-w-[10.5rem] flex-1 flex-col gap-1">
            {weightLabel && (
              <label htmlFor={weightInputId} className="text-xs font-medium">
                {weightLabel}
              </label>
            )}
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
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
              <div className="relative flex-1">
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
        <div className="flex min-w-[10.5rem] flex-1 items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setDraft((d) => ({
              ...d,
              reps: Math.max(0, (d.reps ?? 0) - 1),
            }))}
            aria-label="Decrease reps"
          >
            <Minus className="size-4" />
          </Button>
          <div className="relative flex-1">
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
          <div className="flex min-w-[10.5rem] flex-1 flex-col gap-1">
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
          <div className="flex min-w-[10.5rem] flex-1 flex-col gap-1">
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
      <p className="text-sm text-muted-foreground">
        Effort shortcuts are broad categories. Each shows the numeric RPE saved;
        use exact entry when the number matters.
      </p>
      {selectedEffort && !exactOpen && (
        <p className="text-sm font-medium">
          Selected: {selectedEffort.label} — RPE {selectedEffort.legacyRpe}
        </p>
      )}
      {(machineLine ?? plateLine) && (
        <p className="rounded-md bg-muted/50 px-2 py-1.5 text-sm text-muted-foreground" aria-live="polite">
          {machineLine ?? plateLine}
        </p>
      )}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {RPE_CHIPS.map((chip) => (
          <Button
            key={chip.value}
            variant={draft.rpe === chip.value ? "default" : "outline"}
            size="sm"
            className="h-auto min-h-11 whitespace-normal text-xs"
            aria-label={`${chip.shortcutLabel}; ${chip.meaning}`}
            onClick={() =>
              setDraft((d) => ({ ...d, rpe: d.rpe === chip.value ? null : chip.value }))
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
              }))
            }
          />
        </div>
      )}
      <Textarea
        aria-label="Set note (optional)"
        value={draft.note}
        maxLength={SET_NOTE_MAX_LENGTH}
        onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
        placeholder="Set note…"
        rows={2}
        className="min-h-14 text-sm"
      />
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
        Flag pain
      </DrawerTrigger>
      <DrawerContent className="[&_button]:min-h-11 [&_button]:min-w-11 [&_textarea]:min-h-11">
        <DrawerHeader>
          <DrawerTitle>Flag pain</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col gap-4 px-4">
          <div className="flex flex-wrap gap-1.5">
            {BODY_PARTS.map((part) => (
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
              Severity: <span className="font-medium text-foreground">{severity}/10</span>
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
                  toast.error("The pain flag could not be saved.");
                  return;
                }
                setOpen(false);
              })
            }
          >
            Save pain flag
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function SkipDrawer({
  exerciseId,
  open,
  onOpenChange,
  onDone,
}: {
  exerciseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (reason: "time" | "pain" | "fatigue" | "equipment" | "other") => void;
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
              onClick={() =>
                startTransition(async () => {
                  try {
                    const result = await skipExercise({
                      sessionExerciseId: exerciseId,
                      reason,
                    });
                    if (!result.ok) {
                      toast.error(result.message);
                      return;
                    }
                  } catch {
                    toast.error("The exercise could not be skipped.");
                    return;
                  }
                  onOpenChange(false);
                  onDone(reason);
                })
              }
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
          onOpenChange(false);
          return;
        }
        setOptions(result);
      } catch {
        if (ignore) return;
        toast.error("Alternatives could not be loaded.");
        onOpenChange(false);
      }
    });
    return () => {
      ignore = true;
    };
  }, [exerciseId, onOpenChange, open, options]);

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

  useEffect(() => {
    if (!open || options != null) return;
    let ignore = false;
    startTransition(async () => {
      try {
        const result = await getReplacementOptions(exerciseId);
        if (ignore) return;
        if (!result.ok) {
          toast.error(result.message);
          onOpenChange(false);
          return;
        }
        setOptions(result);
      } catch {
        if (ignore) return;
        toast.error("The exercise catalog could not be loaded.");
        onOpenChange(false);
      }
    });
    return () => {
      ignore = true;
    };
  }, [exerciseId, onOpenChange, open, options]);

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
