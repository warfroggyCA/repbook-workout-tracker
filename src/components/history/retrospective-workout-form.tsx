"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { AlertCircle, ArrowLeft, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { recordRetrospectiveWorkout } from "@/app/actions/history";
import { ExercisePicker } from "@/components/exercises/exercise-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StateNotice } from "@/components/ui/state-notice";
import { Textarea } from "@/components/ui/textarea";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import { ALTERNATIVE_REASONS } from "@/lib/exercise-alternatives";
import { workoutReplacementUnavailableReason } from "@/lib/exercise-replacements";
import type { ProgramPresentation } from "@/lib/program-presentation";
import {
  buildWorkoutHistoryHref,
  type HistoryContext,
} from "@/lib/history-navigation";
import {
  resolveRetrospectiveWallTime,
  type RetrospectiveWorkoutInput,
} from "@/lib/retrospective-workout";
import {
  addCompletedDraftSet,
  changeDraftOutcome,
  draftExerciseFromLibrary,
  draftExercisesForProgramDay,
  initializeRetrospectiveDraft,
  parseRetrospectiveDraft,
  retrospectiveDraftKey,
  selectPerformedDraftExercise,
  type RetrospectiveExerciseDraft,
  type RetrospectiveOutcomeDraft,
  type RetrospectiveWorkoutDraft,
} from "@/lib/retrospective-workout-draft";

const subscribeToHydration = () => () => undefined;
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;
const selectClassName =
  "min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type OffsetChoice = "earlier" | "later" | null;

function numberOrNull(value: string, label: string) {
  if (!value.trim()) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be zero or greater.`);
  }
  return number;
}

function integerOrNull(value: string, label: string) {
  const number = numberOrNull(value, label);
  if (number == null) return null;
  if (!Number.isInteger(number)) throw new Error(`${label} must be a whole number.`);
  return number;
}

function resolveLocalInstant(input: {
  localDate: string;
  localTime: string;
  timezone: string;
  offsetChoice: OffsetChoice;
  label: string;
}) {
  const resolution = resolveRetrospectiveWallTime(input);
  if (resolution.outcome === "nonexistent") {
    throw new Error(
      `${input.label} does not exist in ${input.timezone} because the clock moves forward. Choose another time.`,
    );
  }
  if (resolution.outcome === "ambiguous") {
    if (!input.offsetChoice) {
      throw new Error(
        `${input.label} occurs twice in ${input.timezone}. Choose earlier or later.`,
      );
    }
    return input.offsetChoice === "earlier"
      ? resolution.earlier
      : resolution.later;
  }
  return resolution.instant;
}

function outcomeLabel(outcome: RetrospectiveOutcomeDraft) {
  if (outcome.outcome === "completed") return "Completed";
  if (outcome.outcome === "skipped") return "Skipped";
  return "Unknown";
}

function substitutionReasonLabel(reason: string) {
  if (reason === "equipment_busy") return "Equipment unavailable";
  if (reason === "discomfort") return "Discomfort";
  if (reason === "variety") return "Variety";
  return "Other";
}

function formatSelectedDate(localDate: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${localDate}T12:00:00.000Z`));
}

function supportedMetricType(metricType: string) {
  return [
    "weight_reps",
    "assisted_reps",
    "reps",
    "duration",
    "distance_duration",
    "activity",
  ].includes(metricType);
}

function programTargetLabel(
  day: ProgramPresentation["days"][number] | undefined,
  sourceTemplateExerciseId: string | null,
  unit: "lb" | "kg",
) {
  if (!day || !sourceTemplateExerciseId) return null;
  const slot = day.slots.find(
    (candidate) => candidate.id === sourceTemplateExerciseId,
  );
  if (!slot?.prescription) return "No current numeric target";
  const target = slot.prescription;
  const reps =
    target.repRangeMin === target.repRangeMax
      ? `${target.repRangeMin} reps`
      : `${target.repRangeMin}–${target.repRangeMax} reps`;
  const load =
    target.targetLoad == null
      ? ""
      : ` at ${target.targetLoad} ${target.targetLoadUnit ?? unit}`;
  return `${target.sets} sets × ${reps}${load}`;
}

function buildInput(
  draft: RetrospectiveWorkoutDraft,
  program: ProgramPresentation | null,
  unit: "lb" | "kg",
): RetrospectiveWorkoutInput {
  const selectedDay =
    draft.linkKind === "program_day"
      ? program?.days.find((day) => day.lineageId === draft.dayLineageId)
      : null;
  if (draft.linkKind === "program_day" && (!program || !selectedDay)) {
    throw new Error("Choose a current Program day before reviewing.");
  }
  if (draft.exercises.length === 0) {
    throw new Error("Add at least one exercise before reviewing.");
  }
  if (
    !draft.exercises.some((exercise) =>
      exercise.outcomes.some(
        (outcome) => outcome.outcome !== "legacy_unrecorded",
      ),
    )
  ) {
    throw new Error(
      "Record at least one completed or intentionally skipped set before reviewing.",
    );
  }
  for (const exercise of draft.exercises) {
    const substituted =
      exercise.plannedExerciseId != null &&
      exercise.exerciseId !== exercise.plannedExerciseId;
    if (substituted && !exercise.substitutionReason) {
      throw new Error(
        `Choose why ${exercise.name} replaced ${exercise.plannedExerciseName ?? "the planned exercise"}.`,
      );
    }
    if (!substituted && exercise.substitutionReason) {
      throw new Error(
        `${exercise.name} cannot carry a substitution reason when it matches the planned exercise.`,
      );
    }
  }

  let startedAt: Date | null = null;
  let finishedAt: Date | null = null;
  if (draft.timingPrecision === "instant") {
    if (!draft.startLocalTime) throw new Error("Enter the remembered start time.");
    startedAt = resolveLocalInstant({
      localDate: draft.localDate,
      localTime: draft.startLocalTime,
      timezone: draft.timezone,
      offsetChoice: draft.startOffsetChoice,
      label: "The workout start time",
    });
    const durationMinutes = numberOrNull(
      draft.durationMinutes,
      "Duration",
    );
    if (durationMinutes != null) {
      if (durationMinutes > 10_080) {
        throw new Error("Duration cannot be longer than seven days.");
      }
      finishedAt = new Date(startedAt.getTime() + durationMinutes * 60_000);
    }
  }

  return {
    requestId: draft.requestId,
    sessionId: draft.sessionId,
    progressionJobId: draft.progressionJobId,
    localDate: draft.localDate,
    timezone: draft.timezone,
    timing:
      draft.timingPrecision === "date_only"
        ? { precision: "date_only" }
        : {
            precision: "instant",
            startedAtISO: startedAt!.toISOString(),
            finishedAtISO: finishedAt?.toISOString() ?? null,
          },
    link:
      draft.linkKind === "unlinked"
        ? { kind: "unlinked" }
        : {
            kind: "program_day",
            programId: program!.program.id,
            programVersionId: program!.version.id,
            templateId: selectedDay!.id,
            dayLineageId: selectedDay!.lineageId,
          },
    exercises: draft.exercises.map((exercise) => ({
      id: exercise.id,
      exerciseId: exercise.exerciseId,
      sourceTemplateExerciseId: exercise.sourceTemplateExerciseId,
      substitutionReason: exercise.substitutionReason,
      outcomes: exercise.outcomes.map((outcome, ordinal) => {
        if (outcome.outcome === "legacy_unrecorded") {
          return {
            occurrenceId: outcome.occurrenceId,
            ordinal,
            outcome: "legacy_unrecorded" as const,
          };
        }
        if (outcome.outcome === "skipped") {
          return {
            occurrenceId: outcome.occurrenceId,
            ordinal,
            outcome: "skipped" as const,
            reason: outcome.skipReason,
            note: outcome.note.trim() || null,
          };
        }
        const weight = numberOrNull(outcome.weight, "Weight");
        const reps = integerOrNull(outcome.reps, "Repetitions");
        const distanceKm = numberOrNull(outcome.distanceKm, "Distance");
        const durationSeconds = integerOrNull(
          outcome.durationSeconds,
          "Set duration",
        );
        if (
          ["weight_reps", "assisted_reps", "reps"].includes(
            exercise.metricType,
          ) &&
          reps == null
        ) {
          throw new Error(
            `${exercise.name}, set ${ordinal + 1}: enter repetitions.`,
          );
        }
        if (exercise.metricType === "duration" && durationSeconds == null) {
          throw new Error(
            `${exercise.name}, set ${ordinal + 1}: enter duration.`,
          );
        }
        if (
          exercise.metricType === "distance_duration" &&
          distanceKm == null &&
          durationSeconds == null
        ) {
          throw new Error(
            `${exercise.name}, set ${ordinal + 1}: enter distance or duration.`,
          );
        }
        if (
          exercise.metricType === "activity" &&
          reps == null &&
          distanceKm == null &&
          durationSeconds == null
        ) {
          throw new Error(
            `${exercise.name}, set ${ordinal + 1}: enter a recorded result.`,
          );
        }
        const observedAt = outcome.observedLocalTime
          ? resolveLocalInstant({
              localDate: draft.localDate,
              localTime: outcome.observedLocalTime,
              timezone: draft.timezone,
              offsetChoice: outcome.observedOffsetChoice,
              label: `${exercise.name}, set ${ordinal + 1} completion time`,
            })
          : null;
        return {
          occurrenceId: outcome.occurrenceId,
          ordinal,
          outcome: "completed" as const,
          completedSet: {
            id: outcome.completedSetId,
            clientKey: outcome.clientKey,
            setNo: ordinal + 1,
            weight,
            weightUnit: weight == null ? null : unit,
            reps,
            distanceKm,
            durationSeconds,
            rpe: (() => {
              const rpe = numberOrNull(outcome.rpe, "RPE");
              if (rpe != null && rpe > 10) {
                throw new Error("RPE must be between 0 and 10.");
              }
              return rpe;
            })(),
            targetMet: null,
            restTakenSec: null,
            note: outcome.note.trim() || null,
            observedCompletedAtISO: observedAt?.toISOString() ?? null,
          },
        };
      }),
    })),
    sessionNote: draft.sessionNote.trim() || null,
    recordAnotherWorkout: draft.recordAnotherWorkout,
  };
}

function OffsetChoiceControl({
  localDate,
  localTime,
  timezone,
  value,
  onChange,
  label,
}: {
  localDate: string;
  localTime: string;
  timezone: string;
  value: OffsetChoice;
  onChange: (value: Exclude<OffsetChoice, null>) => void;
  label: string;
}) {
  if (!localTime) return null;
  let resolution;
  try {
    resolution = resolveRetrospectiveWallTime({
      localDate,
      localTime,
      timezone,
    });
  } catch {
    return null;
  }
  if (resolution.outcome !== "ambiguous") return null;
  return (
    <fieldset className="rounded-lg border border-amber-500/35 bg-amber-500/5 p-3">
      <legend className="px-1 text-sm font-medium">
        {label} occurs twice
      </legend>
      <p className="mb-2 text-xs text-muted-foreground">
        Daylight saving time repeats this clock time. Choose the instant you
        remember.
      </p>
      <div className="flex flex-wrap gap-3">
        {(["earlier", "later"] as const).map((choice) => (
          <label key={choice} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              checked={value === choice}
              onChange={() => onChange(choice)}
            />
            <span className="capitalize">{choice} time</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CompletedSetFields({
  exercise,
  outcome,
  index,
  unit,
  draft,
  onChange,
}: {
  exercise: RetrospectiveExerciseDraft;
  outcome: Extract<RetrospectiveOutcomeDraft, { outcome: "completed" }>;
  index: number;
  unit: "lb" | "kg";
  draft: RetrospectiveWorkoutDraft;
  onChange: (
    update: (
      outcome: Extract<RetrospectiveOutcomeDraft, { outcome: "completed" }>,
    ) => Extract<RetrospectiveOutcomeDraft, { outcome: "completed" }>,
  ) => void;
}) {
  const showsReps = [
    "weight_reps",
    "assisted_reps",
    "reps",
    "activity",
  ].includes(exercise.metricType);
  const showsWeight = ["weight_reps", "assisted_reps"].includes(
    exercise.metricType,
  );
  const showsDistance = ["distance_duration", "activity"].includes(
    exercise.metricType,
  );
  const showsDuration = ["duration", "distance_duration", "activity"].includes(
    exercise.metricType,
  );

  return (
    <div className="grid gap-3 rounded-lg border bg-muted/15 p-3 sm:grid-cols-2">
      {showsWeight && (
        <div>
          <Label htmlFor={`${outcome.occurrenceId}-weight`}>Weight ({unit})</Label>
          <Input
            id={`${outcome.occurrenceId}-weight`}
            inputMode="decimal"
            min="0"
            type="number"
            value={outcome.weight}
            onChange={(event) =>
              onChange((current) => ({ ...current, weight: event.target.value }))
            }
          />
        </div>
      )}
      {showsReps && (
        <div>
          <Label htmlFor={`${outcome.occurrenceId}-reps`}>
            Repetitions
          </Label>
          <Input
            id={`${outcome.occurrenceId}-reps`}
            inputMode="numeric"
            min="0"
            type="number"
            value={outcome.reps}
            onChange={(event) =>
              onChange((current) => ({ ...current, reps: event.target.value }))
            }
          />
        </div>
      )}
      {showsDistance && (
        <div>
          <Label htmlFor={`${outcome.occurrenceId}-distance`}>
            Distance (km)
          </Label>
          <Input
            id={`${outcome.occurrenceId}-distance`}
            inputMode="decimal"
            min="0"
            type="number"
            value={outcome.distanceKm}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                distanceKm: event.target.value,
              }))
            }
          />
        </div>
      )}
      {showsDuration && (
        <div>
          <Label htmlFor={`${outcome.occurrenceId}-duration`}>
            Duration (seconds)
          </Label>
          <Input
            id={`${outcome.occurrenceId}-duration`}
            inputMode="numeric"
            min="0"
            type="number"
            value={outcome.durationSeconds}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                durationSeconds: event.target.value,
              }))
            }
          />
        </div>
      )}
      <div>
        <Label htmlFor={`${outcome.occurrenceId}-rpe`}>
          Effort (RPE 0–10, optional)
        </Label>
        <Input
          id={`${outcome.occurrenceId}-rpe`}
          inputMode="decimal"
          min="0"
          max="10"
          step="0.5"
          type="number"
          value={outcome.rpe}
          onChange={(event) =>
            onChange((current) => ({ ...current, rpe: event.target.value }))
          }
        />
      </div>
      <div>
        <Label htmlFor={`${outcome.occurrenceId}-observed-time`}>
          Completed at (optional)
        </Label>
        <Input
          id={`${outcome.occurrenceId}-observed-time`}
          type="time"
          step="60"
          value={outcome.observedLocalTime}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              observedLocalTime: event.target.value,
              observedOffsetChoice: null,
            }))
          }
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Leave blank unless you remember this set’s actual completion time.
        </p>
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={`${outcome.occurrenceId}-note`}>
          Set note (optional)
        </Label>
        <Input
          id={`${outcome.occurrenceId}-note`}
          value={outcome.note}
          maxLength={4000}
          onChange={(event) =>
            onChange((current) => ({ ...current, note: event.target.value }))
          }
        />
      </div>
      <div className="sm:col-span-2">
        <OffsetChoiceControl
          localDate={draft.localDate}
          localTime={outcome.observedLocalTime}
          timezone={draft.timezone}
          value={outcome.observedOffsetChoice}
          label={`${exercise.name}, set ${index + 1} completion time`}
          onChange={(choice) =>
            onChange((current) => ({
              ...current,
              observedOffsetChoice: choice,
            }))
          }
        />
      </div>
    </div>
  );
}

export function RetrospectiveWorkoutForm(props: {
  ownerId: string;
  localDate: string;
  timezone: string;
  unit: "lb" | "kg";
  program: ProgramPresentation | null;
  exerciseLibrary: ExerciseDiscoveryItem[];
  historyHref: string;
  historyContext: HistoryContext;
}) {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot,
  );
  if (!hydrated) {
    return (
      <div className="flex min-h-96 items-center justify-center text-sm text-muted-foreground">
        Preparing the retrospective workout form…
      </div>
    );
  }
  return <RetrospectiveWorkoutFields {...props} />;
}

function RetrospectiveWorkoutFields({
  ownerId,
  localDate,
  timezone,
  unit,
  program,
  exerciseLibrary,
  historyHref,
  historyContext,
}: {
  ownerId: string;
  localDate: string;
  timezone: string;
  unit: "lb" | "kg";
  program: ProgramPresentation | null;
  exerciseLibrary: ExerciseDiscoveryItem[];
  historyHref: string;
  historyContext: HistoryContext;
}) {
  const router = useRouter();
  const storageKey = retrospectiveDraftKey(ownerId, localDate);
  const [draft, setDraft] = useState<RetrospectiveWorkoutDraft>(() => {
    const stored = parseRetrospectiveDraft(localStorage.getItem(storageKey), {
      ownerId,
      localDate,
    });
    return (
      stored ??
      initializeRetrospectiveDraft({ ownerId, localDate, timezone })
    );
  });
  const [notice, setNotice] = useState<{
    state: "saved" | "recovered" | "needs_attention";
    title: string;
    description: string;
  } | null>(() =>
    parseRetrospectiveDraft(localStorage.getItem(storageKey), {
      ownerId,
      localDate,
    })
      ? {
          state: "recovered",
          title: "Recovered this browser’s draft",
          description:
            "Review it before saving. Nothing was written while the draft was stored.",
        }
      : null,
  );
  const [pending, startTransition] = useTransition();
  const [duplicateConfirmationRequired, setDuplicateConfirmationRequired] =
    useState(false);
  const metricTypeByExerciseId = useMemo(
    () =>
      new Map(
        exerciseLibrary.map((exercise) => [
          exercise.id,
          exercise.metricType,
        ]),
      ),
    [exerciseLibrary],
  );
  const replacementPickerContract = useMemo(() => {
    const allowedIds: string[] = [];
    const disabledReasons: Record<string, string> = {};
    for (const exercise of exerciseLibrary) {
      const reason = workoutReplacementUnavailableReason(exercise);
      if (reason) disabledReasons[exercise.id] = reason;
      else allowedIds.push(exercise.id);
    }
    return { allowedIds, disabledReasons };
  }, [exerciseLibrary]);
  const selectedDay = program?.days.find(
    (day) => day.lineageId === draft.dayLineageId,
  );

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      queueMicrotask(() => {
        setNotice({
          state: "needs_attention",
          title: "This browser cannot keep a recovery copy",
          description:
            "The form still works in this tab, but do not reload until it is saved.",
        });
      });
    }
  }, [draft, storageKey]);

  function updateExercise(
    exerciseIndex: number,
    update: (exercise: RetrospectiveExerciseDraft) => RetrospectiveExerciseDraft,
  ) {
    setDraft((current) => ({
      ...current,
      exercises: current.exercises.map((exercise, index) =>
        index === exerciseIndex ? update(exercise) : exercise,
      ),
    }));
  }

  function selectLinkKind(kind: RetrospectiveWorkoutDraft["linkKind"]) {
    setDraft((current) => ({
      ...current,
      linkKind: kind,
      dayLineageId: null,
      exercises: [],
      recordAnotherWorkout: false,
      step: "facts",
    }));
    setNotice(null);
  }

  function selectProgramDay(lineageId: string) {
    const day = program?.days.find((candidate) => candidate.lineageId === lineageId);
    if (!day) return;
    setDraft((current) => ({
      ...current,
      dayLineageId: day.lineageId,
      exercises: draftExercisesForProgramDay(
        day,
        () => crypto.randomUUID(),
        metricTypeByExerciseId,
      ),
      recordAnotherWorkout: false,
      step: "facts",
    }));
    setNotice(null);
  }

  function review() {
    try {
      buildInput(draft, program, unit);
      setDraft((current) => ({ ...current, step: "review" }));
      setNotice(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setNotice({
        state: "needs_attention",
        title: "Review the remembered facts",
        description:
          error instanceof Error
            ? error.message
            : "The workout draft is incomplete.",
      });
    }
  }

  function save() {
    let input: RetrospectiveWorkoutInput;
    try {
      input = buildInput(draft, program, unit);
    } catch (error) {
      setNotice({
        state: "needs_attention",
        title: "The reviewed draft needs attention",
        description:
          error instanceof Error ? error.message : "Check the workout facts.",
      });
      return;
    }
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await recordRetrospectiveWorkout(input);
        if (result.ok) {
          localStorage.removeItem(storageKey);
          router.replace(
            buildWorkoutHistoryHref(result.sessionId, historyContext),
          );
          return;
        }
        if (result.code === "duplicate_warning_required") {
          setDraft((current) => ({
            ...current,
            recordAnotherWorkout: false,
            step: "review",
          }));
          setDuplicateConfirmationRequired(true);
          setNotice({
            state: "needs_attention",
            title: "Another workout is already recorded on this date",
            description:
              "Nothing was added. Confirm below only if this is a separate workout, then save again.",
          });
          return;
        }
        if (result.code === "stale_program") {
          setDraft((current) => ({ ...current, step: "facts" }));
        }
        setNotice({
          state: "needs_attention",
          title:
            result.code === "stale_program"
              ? "The current Program changed"
              : "The workout was not saved",
          description: result.reason,
        });
      } catch {
        setNotice({
          state: "needs_attention",
          title: "The save response could not be confirmed",
          description:
            "Your reviewed workout is still saved here. Try again—it won't create a duplicate.",
        });
      }
    });
  }

  const completedCount = draft.exercises.reduce(
    (count, exercise) =>
      count +
      exercise.outcomes.filter((outcome) => outcome.outcome === "completed")
        .length,
    0,
  );
  const skippedCount = draft.exercises.reduce(
    (count, exercise) =>
      count +
      exercise.outcomes.filter((outcome) => outcome.outcome === "skipped")
        .length,
    0,
  );
  const unknownCount = draft.exercises.reduce(
    (count, exercise) =>
      count +
      exercise.outcomes.filter(
        (outcome) => outcome.outcome === "legacy_unrecorded",
      ).length,
    0,
  );

  if (draft.step === "review") {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
        <header>
          <Button
            render={<Link href={historyHref} />}
            nativeButton={false}
            variant="ghost"
            size="touch"
            className="-ml-3"
          >
            <ArrowLeft /> History
          </Button>
          <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            Review performed facts
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            Record workout on {formatSelectedDate(localDate)}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            This review separates what you remember doing from the Program
            intent. Saving creates a completed historical record; it does not
            change the Program.
          </p>
        </header>

        {notice && <StateNotice {...notice} />}
        {pending && (
          <StateNotice
            state="saving"
            title="Saving the reviewed workout…"
            description="Keep this page open until the result is confirmed."
          />
        )}

        <Card>
          <CardHeader>
            <CardTitle>Workout details</CardTitle>
            <CardDescription>
              Review the date, time quality, and Program relationship.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Date</dt>
                <dd className="font-medium">{formatSelectedDate(localDate)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Timing</dt>
                <dd className="font-medium">
                  {draft.timingPrecision === "date_only"
                    ? "Date only — time and duration unknown"
                    : `${draft.startLocalTime} in ${draft.timezone}${
                        draft.durationMinutes
                          ? ` · ${draft.durationMinutes} min`
                          : " · duration unknown"
                      }`}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">
                  Program relationship
                </dt>
                <dd className="font-medium">
                  {selectedDay
                    ? `${program?.program.name} · ${selectedDay.name}`
                    : "Not linked to Program"}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Badge>{completedCount} completed</Badge>
              <Badge variant="outline">{skippedCount} skipped</Badge>
              <Badge variant="outline">{unknownCount} unknown</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Exercise evidence</CardTitle>
            <CardDescription>
              Unknown means you did not supply an outcome. It is not recorded as
              skipped or completed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {draft.exercises.map((exercise) => (
              <section key={exercise.id} className="rounded-xl border p-3">
                <h2 className="font-medium">{exercise.name}</h2>
                {exercise.plannedExerciseId &&
                  exercise.exerciseId !== exercise.plannedExerciseId && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Performed {exercise.name} instead of{" "}
                      {exercise.plannedExerciseName ?? "the planned exercise"} ·{" "}
                      {substitutionReasonLabel(
                        exercise.substitutionReason ?? "other",
                      )}
                    </p>
                  )}
                {programTargetLabel(
                  selectedDay,
                  exercise.sourceTemplateExerciseId,
                  unit,
                ) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Program target:{" "}
                    {programTargetLabel(
                      selectedDay,
                      exercise.sourceTemplateExerciseId,
                      unit,
                    )}
                  </p>
                )}
                <ol className="mt-2 space-y-1 text-sm">
                  {exercise.outcomes.map((outcome, index) => (
                    <li key={outcome.occurrenceId}>
                      {exercise.sourceTemplateExerciseId &&
                      index >= exercise.plannedSetCount
                        ? `Extra set ${index - exercise.plannedSetCount + 1}`
                        : `Set ${index + 1}`}
                      :{" "}
                      {outcomeLabel(outcome)}
                      {outcome.outcome === "completed" &&
                        ` · ${
                          outcome.weight
                            ? `${outcome.weight} ${unit} × `
                            : ""
                        }${outcome.reps || "recorded result"}${
                          outcome.rpe ? ` · RPE ${outcome.rpe}` : ""
                        }`}
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </CardContent>
        </Card>

        {duplicateConfirmationRequired && (
          <label className="flex min-h-11 items-start gap-3 rounded-xl border border-amber-500/35 bg-amber-500/5 p-3">
            <Checkbox
              checked={draft.recordAnotherWorkout}
              onCheckedChange={(checked) =>
                setDraft((current) => ({
                  ...current,
                  recordAnotherWorkout: checked === true,
                }))
              }
            />
            <span>
              <span className="block font-medium">
                This is a separate workout on the same date
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                Turning this off returns duplicate protection.
              </span>
            </span>
          </label>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={pending}
            onClick={() =>
              setDraft((current) => ({ ...current, step: "facts" }))
            }
          >
            Back to facts
          </Button>
          <Button
            type="button"
            size="touch"
            aria-disabled={
              pending ||
              (duplicateConfirmationRequired && !draft.recordAnotherWorkout)
            }
            disabled={
              pending ||
              (duplicateConfirmationRequired && !draft.recordAnotherWorkout)
            }
            onClick={save}
          >
            <CheckCircle2 /> {pending ? "Saving…" : "Save completed workout"}
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <header>
        <Button
          render={<Link href={historyHref} />}
          nativeButton={false}
          variant="ghost"
          size="touch"
          className="-ml-3"
        >
          <ArrowLeft /> History
        </Button>
        <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
          Retrospective entry
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          Record workout on {formatSelectedDate(localDate)}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Enter only facts you remember. Unknown values stay unknown, and the
          time you enter stays separate from when this workout is saved.
        </p>
      </header>

      {notice && <StateNotice {...notice} />}

      <Card>
        <CardHeader>
          <CardTitle>1. When did it happen?</CardTitle>
          <CardDescription>
            The selected calendar date is fixed. Choose date only unless you
            remember the local start time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset>
            <legend className="text-sm font-medium">Timing precision</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(["date_only", "instant"] as const).map((precision) => (
                <label
                  key={precision}
                  className="flex min-h-11 items-start gap-3 rounded-xl border p-3"
                >
                  <input
                    type="radio"
                    name="timingPrecision"
                    checked={draft.timingPrecision === precision}
                    onChange={() =>
                      setDraft((current) => ({
                        ...current,
                        timingPrecision: precision,
                        startOffsetChoice: null,
                      }))
                    }
                  />
                  <span>
                    <span className="block font-medium">
                      {precision === "date_only"
                        ? "Date only"
                        : "Exact local start"}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {precision === "date_only"
                        ? "Start time and duration remain unknown."
                        : "Enter the time you remember; duration may stay unknown."}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <Label htmlFor="retrospective-timezone">Workout timezone</Label>
            <Input
              id="retrospective-timezone"
              value={draft.timezone}
              maxLength={100}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  timezone: event.target.value,
                  startOffsetChoice: null,
                }))
              }
            />
          </div>
          {draft.timingPrecision === "instant" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="retrospective-start-time">
                  Local start time
                </Label>
                <Input
                  id="retrospective-start-time"
                  type="time"
                  step="60"
                  value={draft.startLocalTime}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      startLocalTime: event.target.value,
                      startOffsetChoice: null,
                    }))
                  }
                />
              </div>
              <div>
                <Label htmlFor="retrospective-duration">
                  Duration in minutes (optional)
                </Label>
                <Input
                  id="retrospective-duration"
                  type="number"
                  min="0"
                  inputMode="decimal"
                  value={draft.durationMinutes}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      durationMinutes: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="sm:col-span-2">
                <OffsetChoiceControl
                  localDate={draft.localDate}
                  localTime={draft.startLocalTime}
                  timezone={draft.timezone}
                  value={draft.startOffsetChoice}
                  label="Workout start time"
                  onChange={(choice) =>
                    setDraft((current) => ({
                      ...current,
                      startOffsetChoice: choice,
                    }))
                  }
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Was it from the Program?</CardTitle>
          <CardDescription>
            Link only when you performed a specific current Program day. A link
            can affect Program-day exposure, Today rotation, and progression;
            it never changes the Program.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset>
            <legend className="sr-only">Program relationship</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex min-h-11 items-start gap-3 rounded-xl border p-3">
                <input
                  type="radio"
                  name="linkKind"
                  checked={draft.linkKind === "unlinked"}
                  onChange={() => selectLinkKind("unlinked")}
                />
                <span>
                  <span className="block font-medium">Not linked to Program</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Counts in calendar cadence, but not Program-day exposure or
                    rotation.
                  </span>
                </span>
              </label>
              <label className="flex min-h-11 items-start gap-3 rounded-xl border p-3">
                <input
                  type="radio"
                  name="linkKind"
                  disabled={!program}
                  checked={draft.linkKind === "program_day"}
                  onChange={() => selectLinkKind("program_day")}
                />
                <span>
                  <span className="block font-medium">Performed from Program</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Requires an exact current Program day.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>
          {draft.linkKind === "program_day" && program && (
            <div>
              <Label htmlFor="retrospective-program-day">Program day</Label>
              <select
                id="retrospective-program-day"
                className={selectClassName}
                value={draft.dayLineageId ?? ""}
                onChange={(event) => selectProgramDay(event.target.value)}
              >
                <option value="">Choose a Program day</option>
                {program.days.map((day) => (
                  <option key={day.lineageId} value={day.lineageId}>
                    {day.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. What do you remember doing?</CardTitle>
          <CardDescription>
            For Program days, every planned set starts Unknown. Mark only
            completed or intentionally skipped work. For unlinked workouts, add
            the exact exercise variants you performed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {draft.linkKind === "unlinked" && (
            <ExercisePicker
              items={exerciseLibrary.filter((item) =>
                supportedMetricType(item.metricType),
              )}
              initialAvailability="all"
              allowUnavailableSelection
              triggerLabel="Add performed exercise"
              title="Choose the performed exercise"
              description="Choose the exact supported variant. Current equipment availability is guidance only for this historical record."
              confirmLabel="Add to workout"
              largeTouchTargets
              onSelect={(exercise) => {
                setDraft((current) => ({
                  ...current,
                  exercises: [
                    ...current.exercises,
                    draftExerciseFromLibrary(exercise),
                  ],
                }));
              }}
            />
          )}

          {draft.exercises.length === 0 ? (
            <div className="rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground">
              {draft.linkKind === "program_day"
                ? "Choose the exact Program day to load its planned sets."
                : "Add the first exercise you performed."}
            </div>
          ) : (
            draft.exercises.map((exercise, exerciseIndex) => (
              <section
                key={exercise.id}
                aria-labelledby={`${exercise.id}-heading`}
                className="space-y-3 rounded-xl border p-3 sm:p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 id={`${exercise.id}-heading`} className="font-semibold">
                      {exercise.name}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {exercise.sourceTemplateExerciseId
                        ? exercise.exerciseId === exercise.plannedExerciseId
                          ? "Performed as planned"
                          : `Performed instead of ${exercise.plannedExerciseName ?? "the planned exercise"}`
                        : "Performed exercise not linked to a Program slot"}
                    </p>
                    {programTargetLabel(
                      selectedDay,
                      exercise.sourceTemplateExerciseId,
                      unit,
                    ) && (
                      <p className="mt-1 text-xs font-medium text-primary">
                        Program target:{" "}
                        {programTargetLabel(
                          selectedDay,
                          exercise.sourceTemplateExerciseId,
                          unit,
                        )}
                      </p>
                    )}
                  </div>
                  {!exercise.sourceTemplateExerciseId && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="touch"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          exercises: current.exercises.filter(
                            (candidate) => candidate.id !== exercise.id,
                          ),
                        }))
                      }
                    >
                      <Trash2 /> Remove exercise
                    </Button>
                  )}
                </div>

                {exercise.sourceTemplateExerciseId && (
                  <div className="grid gap-3 rounded-xl border bg-muted/10 p-3 sm:grid-cols-2">
                    <div>
                      <Label>Performed exercise</Label>
                      <ExercisePicker
                        items={exerciseLibrary}
                        selectedId={exercise.exerciseId}
                        allowedIds={[
                          ...replacementPickerContract.allowedIds,
                          ...(exercise.plannedExerciseId
                            ? [exercise.plannedExerciseId]
                            : []),
                        ]}
                        disabledReasons={Object.fromEntries(
                          Object.entries(
                            replacementPickerContract.disabledReasons,
                          ).filter(
                            ([exerciseId]) =>
                              exerciseId !== exercise.plannedExerciseId,
                          ),
                        )}
                        allowUnavailableSelection
                        initialAvailability="all"
                        triggerLabel={
                          exercise.exerciseId === exercise.plannedExerciseId
                            ? "Choose a performed substitution"
                            : `Performed: ${exercise.name}`
                        }
                        title="Choose the performed exercise"
                        description={`Keep ${exercise.plannedExerciseName ?? "the Program exercise"} as the planned intent, or choose the exact supported catalog exercise actually performed.`}
                        confirmLabel="Use as performed exercise"
                        largeTouchTargets
                        onSelect={(performed) =>
                          updateExercise(exerciseIndex, (current) =>
                            selectPerformedDraftExercise(current, performed),
                          )
                        }
                      />
                    </div>
                    {exercise.exerciseId !== exercise.plannedExerciseId && (
                      <div>
                        <Label htmlFor={`${exercise.id}-substitution-reason`}>
                          Substitution reason
                        </Label>
                        <select
                          id={`${exercise.id}-substitution-reason`}
                          className={selectClassName}
                          value={exercise.substitutionReason ?? ""}
                          onChange={(event) =>
                            updateExercise(exerciseIndex, (current) => ({
                              ...current,
                              substitutionReason:
                                (event.target.value ||
                                  null) as RetrospectiveExerciseDraft["substitutionReason"],
                            }))
                          }
                        >
                          <option value="">Choose a reason</option>
                          {ALTERNATIVE_REASONS.map((reason) => (
                            <option key={reason} value={reason}>
                              {substitutionReasonLabel(reason)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}

                {exercise.outcomes.map((outcome, outcomeIndex) => (
                  <div
                    key={outcome.occurrenceId}
                    className="space-y-3 rounded-xl bg-muted/20 p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">
                        {exercise.sourceTemplateExerciseId &&
                        outcomeIndex >= exercise.plannedSetCount
                          ? `Extra set ${
                              outcomeIndex - exercise.plannedSetCount + 1
                            } · Added to this workout`
                          : `Set ${outcomeIndex + 1}`}
                      </p>
                      <select
                        aria-label={`${exercise.name}, ${
                          exercise.sourceTemplateExerciseId &&
                          outcomeIndex >= exercise.plannedSetCount
                            ? `extra set ${
                                outcomeIndex -
                                exercise.plannedSetCount +
                                1
                              }`
                            : `set ${outcomeIndex + 1}`
                        } outcome`}
                        className="min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-sm"
                        value={outcome.outcome}
                        onChange={(event) =>
                          updateExercise(exerciseIndex, (current) => ({
                            ...current,
                            outcomes: current.outcomes.map((candidate, index) =>
                              index === outcomeIndex
                                ? changeDraftOutcome(
                                    candidate,
                                    event.target
                                      .value as RetrospectiveOutcomeDraft["outcome"],
                                  )
                                : candidate,
                            ),
                          }))
                        }
                      >
                        <option value="legacy_unrecorded">Unknown</option>
                        <option value="completed">Completed</option>
                        <option value="skipped">Skipped</option>
                      </select>
                    </div>

                    {outcome.outcome === "completed" && (
                      <CompletedSetFields
                        exercise={exercise}
                        outcome={outcome}
                        index={outcomeIndex}
                        unit={unit}
                        draft={draft}
                        onChange={(update) =>
                          updateExercise(exerciseIndex, (current) => ({
                            ...current,
                            outcomes: current.outcomes.map((candidate, index) =>
                              index === outcomeIndex &&
                              candidate.outcome === "completed"
                                ? update(candidate)
                                : candidate,
                            ),
                          }))
                        }
                      />
                    )}
                    {outcome.outcome === "skipped" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <Label htmlFor={`${outcome.occurrenceId}-skip-reason`}>
                            Skip reason
                          </Label>
                          <select
                            id={`${outcome.occurrenceId}-skip-reason`}
                            className={selectClassName}
                            value={outcome.skipReason}
                            onChange={(event) =>
                              updateExercise(exerciseIndex, (current) => ({
                                ...current,
                                outcomes: current.outcomes.map(
                                  (candidate, index) =>
                                    index === outcomeIndex &&
                                    candidate.outcome === "skipped"
                                      ? {
                                          ...candidate,
                                          skipReason: event.target
                                            .value as typeof candidate.skipReason,
                                        }
                                      : candidate,
                                ),
                              }))
                            }
                          >
                            <option value="time">Time</option>
                            <option value="pain">Pain</option>
                            <option value="fatigue">Fatigue</option>
                            <option value="equipment">Equipment</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                        <div>
                          <Label htmlFor={`${outcome.occurrenceId}-skip-note`}>
                            Skip note (optional)
                          </Label>
                          <Input
                            id={`${outcome.occurrenceId}-skip-note`}
                            value={outcome.note}
                            onChange={(event) =>
                              updateExercise(exerciseIndex, (current) => ({
                                ...current,
                                outcomes: current.outcomes.map(
                                  (candidate, index) =>
                                    index === outcomeIndex &&
                                    candidate.outcome === "skipped"
                                      ? {
                                          ...candidate,
                                          note: event.target.value,
                                        }
                                      : candidate,
                                ),
                              }))
                            }
                          />
                        </div>
                      </div>
                    )}
                    {outcomeIndex >= exercise.plannedSetCount &&
                      exercise.outcomes.length >
                        Math.max(1, exercise.plannedSetCount) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="touch"
                          onClick={() =>
                            updateExercise(exerciseIndex, (current) => ({
                              ...current,
                              outcomes: current.outcomes.filter(
                                (_, index) => index !== outcomeIndex,
                              ),
                            }))
                          }
                        >
                          <Trash2 /> Remove set
                        </Button>
                      )}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  onClick={() =>
                    updateExercise(exerciseIndex, (current) =>
                      addCompletedDraftSet(current),
                    )
                  }
                >
                  <Plus />{" "}
                  {exercise.sourceTemplateExerciseId
                    ? "Add extra set"
                    : "Add set"}
                </Button>
              </section>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Workout note</CardTitle>
          <CardDescription>
            Optional owner observation. It remains evidence, not a Program
            instruction or Coach conclusion.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="retrospective-session-note">Training note</Label>
          <Textarea
            id="retrospective-session-note"
            rows={4}
            maxLength={8000}
            value={draft.sessionNote}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                sessionNote: event.target.value,
              }))
            }
          />
        </CardContent>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button
          render={<Link href={historyHref} />}
          nativeButton={false}
          variant="outline"
          size="touch"
        >
          Cancel — keep draft
        </Button>
        <Button type="button" size="touch" onClick={review}>
          Review workout
        </Button>
      </div>

      <StateNotice
        state="idle"
        title="Nothing is saved until final confirmation"
        description="This browser keeps a recovery draft. The Program and completed History remain unchanged while you edit."
        action={<AlertCircle aria-hidden="true" />}
      />
    </main>
  );
}
