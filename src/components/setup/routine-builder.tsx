"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  RoutineDraftDay,
  RoutineDraftExercise,
  RoutineWarmup,
  RoutineWarmupSet,
  SetupState,
} from "@/db/schema/user";
import {
  buildSetupRoutineDraft,
  saveRoutineDraft,
} from "@/app/actions/setup";
import { ExercisePicker } from "@/components/exercises/exercise-picker";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fitRoutineSetNotes, moveRoutineItem } from "@/lib/routine-builder";
import { formatRestTime } from "@/lib/rest-time";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import { ExerciseFamilyIcon } from "@/components/exercises/exercise-family-icon";
import {
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  Clock3,
  Plus,
  Sparkles,
  X,
} from "lucide-react";

const DAY_NAMES = ["Day A", "Day B", "Day C", "Day D", "Day E", "Day F", "Day G"];
const SUPERSET_LETTERS = [null, "A", "B", "C"] as const;
const REST_VALUES = Array.from({ length: 41 }, (_, i) => i * 15);

type EditableRoutineExercise = RoutineDraftExercise & { clientKey: string };
type EditableRoutineDay = Omit<RoutineDraftDay, "exercises"> & {
  exercises: EditableRoutineExercise[];
};

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeWarmup(warmup: RoutineWarmup | null | undefined) {
  if (!warmup) return null;
  return {
    notes: warmup.notes ?? null,
    sets: warmup.sets ?? [],
  };
}

function normalizeDay(day: RoutineDraftDay, dayIndex: number): EditableRoutineDay {
  return {
    ...day,
    exercises: day.exercises.map((ex, exerciseIndex) => ({
      ...ex,
      clientKey: `${dayIndex}-${exerciseIndex}-${ex.exerciseId}`,
      restSec: Math.max(0, Math.min(600, Math.trunc(ex.restSec))),
      warmup: normalizeWarmup(ex.warmup),
      setNotes: fitRoutineSetNotes(ex.setNotes, ex.sets),
    })),
  };
}

function routineExerciseForSave(
  exercise: EditableRoutineExercise
): RoutineDraftExercise {
  return {
    exerciseId: exercise.exerciseId,
    name: exercise.name,
    sets: exercise.sets,
    repMin: exercise.repMin,
    repMax: exercise.repMax,
    targetLoad: exercise.targetLoad,
    targetLoadUnit: exercise.targetLoadUnit,
    restSec: exercise.restSec,
    supersetGroup: exercise.supersetGroup,
    notes: exercise.notes,
    warmup: exercise.warmup,
    setNotes: exercise.setNotes,
  };
}

function SmallNumber({
  value,
  onChange,
  min = 0,
  width = "w-14",
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  width?: string;
}) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      min={min}
      value={value ?? ""}
      className={cn("h-9 rounded-lg px-2 text-center text-sm tabular-nums", width)}
      onChange={(e) => {
        const n = e.target.value === "" ? null : Number(e.target.value);
        onChange(n != null && Number.isFinite(n) ? n : null);
      }}
    />
  );
}

function RestSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <select
      className="h-9 rounded-lg border bg-background px-2 text-sm tabular-nums"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {!REST_VALUES.includes(value) && <option value={value}>Custom: {formatRestTime(value)}</option>}
      {REST_VALUES.map((seconds) => (
        <option key={seconds} value={seconds}>
          {formatRestTime(seconds)}
        </option>
      ))}
    </select>
  );
}

function emptyWarmupSet(): RoutineWarmupSet {
  return {
    label: "Warm-up set",
    reps: null,
    load: null,
    loadUnit: null,
    loadPercent: null,
    loadText: null,
    notes: null,
  };
}

function WarmupEditor({
  warmup,
  onChange,
}: {
  warmup: RoutineWarmup | null;
  onChange: (warmup: RoutineWarmup | null) => void;
}) {
  if (!warmup) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={() => onChange({ notes: null, sets: [emptyWarmupSet()] })}
      >
        <Plus className="size-3.5" /> Add warm-up
      </Button>
    );
  }
  const activeWarmup = warmup;

  function updateSet(index: number, patch: Partial<RoutineWarmupSet>) {
    onChange({
      ...activeWarmup,
      sets: activeWarmup.sets.map((set, i) =>
        i === index ? { ...set, ...patch } : set
      ),
    });
  }

  return (
    <div className="mt-2 rounded-md border bg-muted/20 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium">Warm-up</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Remove warm-up"
          onClick={() => onChange(null)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <Textarea
        value={activeWarmup.notes ?? ""}
        placeholder="Warm-up notes or ramp-up guidance…"
        className="min-h-14 text-xs"
        onChange={(e) =>
          onChange({ ...activeWarmup, notes: e.target.value || null })
        }
      />
      <div className="mt-2 flex flex-col gap-2">
        {activeWarmup.sets.map((set, i) => (
          <div key={i} className="rounded-md border bg-background p-2">
            <div className="flex items-center gap-1.5">
              <Input
                value={set.label}
                className="h-7 flex-1 text-xs"
                placeholder="Empty bar, ~55%, prep set…"
                onChange={(e) => updateSet(i, { label: e.target.value })}
              />
              <SmallNumber
                value={set.reps}
                min={0}
                width="w-12"
                onChange={(v) => updateSet(i, { reps: v })}
              />
              <span className="text-xs text-muted-foreground">reps</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove warm-up set"
                onClick={() =>
                  onChange({
                    ...activeWarmup,
                    sets: activeWarmup.sets.filter((_, j) => j !== i),
                  })
                }
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <Input
              value={
                set.loadText ??
                (set.loadPercent != null
                  ? `${set.loadPercent}%`
                  : set.load != null
                    ? `${set.load} ${set.loadUnit ?? "unit missing"}`
                    : "")
              }
              className="mt-1 h-7 text-xs"
              placeholder="Load note, such as empty bar or 55%"
              onChange={(e) =>
                updateSet(i, {
                  load: null,
                  loadUnit: null,
                  loadPercent: null,
                  loadText: e.target.value || null,
                })
              }
            />
            <Input
              value={set.notes ?? ""}
              className="mt-1 h-7 text-xs"
              placeholder="Optional set note…"
              onChange={(e) => updateSet(i, { notes: e.target.value || null })}
            />
          </div>
        ))}
      </div>
      {warmup.sets.length < 8 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 h-7 px-1 text-xs"
          onClick={() =>
            onChange({
              ...activeWarmup,
              sets: [...activeWarmup.sets, emptyWarmupSet()],
            })
          }
        >
          <Plus className="size-3.5" /> Add warm-up set
        </Button>
      )}
    </div>
  );
}

function SetNotesEditor({
  sets,
  notes,
  onChange,
}: {
  sets: number;
  notes: Array<string | null>;
  onChange: (notes: Array<string | null>) => void;
}) {
  const fitted = fitRoutineSetNotes(notes, sets);
  return (
    <div className="mt-2 rounded-md border bg-muted/20 p-2">
      <p className="mb-2 text-xs font-medium">Work set notes</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {fitted.map((note, i) => (
          <label key={i} className="flex items-center gap-1.5 text-xs">
            <span className="w-10 shrink-0 text-muted-foreground">
              Set {i + 1}
            </span>
            <Input
              value={note ?? ""}
              className="h-7 text-xs"
              placeholder="Optional note…"
              onChange={(e) => {
                const next = [...fitted];
                next[i] = e.target.value || null;
                onChange(next);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

export function RoutineBuilder({
  draft,
  unit,
  aiAvailable,
  exerciseMetadata,
  exerciseLibrary,
}: {
  draft: SetupState["routineDraft"];
  unit: "lb" | "kg";
  aiAvailable: boolean;
  exerciseMetadata: Record<
    string,
    { movementPattern: string; primaryMuscles: string[] }
  >;
  exerciseLibrary: ExerciseDiscoveryItem[];
}) {
  const router = useRouter();
  const exerciseLibraryById = useMemo(
    () => new Map(exerciseLibrary.map((exercise) => [exercise.id, exercise])),
    [exerciseLibrary]
  );
  const [days, setDays] = useState<EditableRoutineDay[]>(
    draft?.days.map((day, index) => normalizeDay(day, index)) ?? [
      { name: "Day A", notes: null, exercises: [] },
    ]
  );
  const [error, setError] = useState<string | null>(null);
  const [buildText, setBuildText] = useState("");
  const [buildWarnings, setBuildWarnings] = useState<string[]>([]);
  const [showAllBuildWarnings, setShowAllBuildWarnings] = useState(false);
  const [activeTab, setActiveTab] = useState("manual");
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const [insertPosition, setInsertPosition] = useState(
    draft?.days[0]?.exercises.length ?? 0
  );
  const [pending, startTransition] = useTransition();

  const selectedDay = days[selectedDayIndex] ?? days[0];
  const selectedExercises = selectedDay?.exercises ?? [];
  const selectedSetCount = selectedExercises.reduce(
    (total, exercise) => total + exercise.sets,
    0
  );
  const estimatedMinutes = Math.max(
    0,
    Math.round(
      selectedExercises.reduce(
        (total, exercise) =>
          total + exercise.sets * (45 + exercise.restSec),
        0
      ) / 60
    )
  );
  const muscleTotals = new Map<string, number>();
  for (const exercise of selectedExercises) {
    const metadata = exerciseMetadata[exercise.exerciseId];
    const labels = metadata?.primaryMuscles.length
      ? metadata.primaryMuscles
      : metadata?.movementPattern
        ? [metadata.movementPattern]
        : [];
    for (const label of labels) {
      muscleTotals.set(label, (muscleTotals.get(label) ?? 0) + exercise.sets);
    }
  }
  const muscleSummary = [...muscleTotals.entries()].sort((a, b) => b[1] - a[1]);
  const maxMuscleSets = Math.max(1, ...muscleSummary.map(([, sets]) => sets));

  function updateDay(dayIdx: number, patch: Partial<EditableRoutineDay>) {
    setDays((d) =>
      d.map((day, i) => (i === dayIdx ? { ...day, ...patch } : day))
    );
  }

  function updateExercise(
    dayIdx: number,
    exIdx: number,
    patch: Partial<RoutineDraftExercise>
  ) {
    setDays((d) =>
      d.map((day, i) =>
        i === dayIdx
          ? {
              ...day,
              exercises: day.exercises.map((ex, j) =>
                j === exIdx
                  ? {
                      ...ex,
                      ...patch,
                      setNotes:
                        patch.sets != null
                          ? fitRoutineSetNotes(patch.setNotes ?? ex.setNotes, patch.sets)
                          : (patch.setNotes ?? ex.setNotes),
                    }
                  : ex
              ),
            }
          : day
      )
    );
  }

  function moveExercise(dayIdx: number, fromIndex: number, toIndex: number) {
    if (toIndex < 0) return;
    setDays((current) =>
      current.map((day, index) => {
        if (index !== dayIdx || toIndex >= day.exercises.length) return day;
        return {
          ...day,
          exercises: moveRoutineItem(day.exercises, fromIndex, toIndex),
        };
      })
    );
  }

  function exerciseFromHit(hit: ExerciseDiscoveryItem): EditableRoutineExercise {
    return {
      clientKey: `added-${hit.id}-${Date.now()}`,
      exerciseId: hit.id,
      name: hit.name,
      sets: 3,
      repMin: 8,
      repMax: 12,
      targetLoad: null,
      targetLoadUnit: null,
      restSec: 90,
      supersetGroup: null,
      notes: null,
      warmup: null,
      setNotes: [null, null, null],
    };
  }

  function insertExercise(hit: ExerciseDiscoveryItem) {
    if (!selectedDay) return;
    const position = Math.min(insertPosition, selectedDay.exercises.length);
    const exercises = [...selectedDay.exercises];
    exercises.splice(position, 0, exerciseFromHit(hit));
    updateDay(selectedDayIndex, { exercises });
    setInsertPosition(position + 1);
  }

  function handleSave() {
    setError(null);
    const nonEmpty = days.filter((d) => d.exercises.length > 0);
    if (!nonEmpty.length) {
      setError("Add at least one exercise to one day.");
      return;
    }
    if (days.some((d) => d.exercises.length === 0)) {
      setError("Every day needs at least one exercise — remove empty days.");
      return;
    }
    startTransition(async () => {
      const result = await saveRoutineDraft({
        days: days.map((day) => ({
          name: day.name,
          notes: day.notes ?? null,
          warmupNotes: day.warmupNotes ?? null,
          exercises: day.exercises.map(routineExerciseForSave),
        })),
      });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      router.push("/setup/coaching");
    });
  }

  function handleBuildRoutine() {
    setError(null);
    setBuildWarnings([]);
    setShowAllBuildWarnings(false);
    startTransition(async () => {
      const result = await buildSetupRoutineDraft(buildText);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      const nextDays = result.draft.days.map((day, index) =>
        normalizeDay(day, index)
      );
      setDays(nextDays);
      setSelectedDayIndex(0);
      setInsertPosition(nextDays[0]?.exercises.length ?? 0);
      setBuildWarnings([
        `Draft built by AI (${Math.round(result.confidence * 100)}% confidence). Review before saving.`,
        ...result.warnings,
      ]);
      setActiveTab("manual");
    });
  }

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Build your week around the equipment you own. Loads are in {unit};
          leave load empty for bodyweight or band work.
        </p>
        <TabsList className="h-10 w-full rounded-xl bg-muted p-1 sm:w-auto">
          <TabsTrigger value="manual" className="flex-1 px-4 sm:flex-none">
            Edit routine
          </TabsTrigger>
          <TabsTrigger value="describe" className="flex-1 px-4 sm:flex-none">
            <Sparkles className="size-3.5" /> Build with AI
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="describe">
        <div className="max-w-3xl rounded-2xl border bg-card p-5 shadow-[var(--shadow-soft)] sm:p-6">
          <p className="mb-2 flex items-center gap-2 font-semibold">
            <ClipboardPaste className="size-4 text-primary" /> Paste or describe a routine
          </p>
          <p className="mb-4 text-sm leading-6 text-muted-foreground">
            The draft will use your profile, available equipment and safety
            constraints. Nothing becomes active until you review and save it.
          </p>
          <Textarea
            placeholder={"e.g.\nBuild me a 3-day full-body routine for strength and consistency.\nKeep sessions around 45 minutes.\nUse barbell lifts where they make sense, plus dumbbells and pull-ups.\nOr paste an existing plan here."}
            value={buildText}
            onChange={(e) => setBuildText(e.target.value)}
            rows={10}
            className="text-sm leading-6"
          />
          {!aiAvailable && (
            <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              AI routine building is not configured on this deployment.
            </p>
          )}
          {error && activeTab === "describe" && (
            <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            size="lg"
            className="mt-4 min-w-36"
            disabled={pending || !buildText.trim() || !aiAvailable}
            onClick={handleBuildRoutine}
          >
            {pending ? "Building…" : "Build draft"}
          </Button>
        </div>
      </TabsContent>

      <TabsContent value="manual">
        {buildWarnings.length > 0 && (
          <div className="mb-4 rounded-xl border border-amber-300/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
            <ul className="flex flex-col gap-1">
              {(showAllBuildWarnings ? buildWarnings : buildWarnings.slice(0, 4)).map(
                (warning, index) => (
                  <li key={`${index}-${warning}`}>{warning}</li>
                )
              )}
            </ul>
            {buildWarnings.length > 4 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 h-7 px-0 text-xs text-amber-900 hover:bg-transparent dark:text-amber-200"
                onClick={() => setShowAllBuildWarnings((value) => !value)}
              >
                {showAllBuildWarnings
                  ? "Show fewer notes"
                  : `Show ${buildWarnings.length - 4} more notes`}
              </Button>
            )}
          </div>
        )}

        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <section className="min-w-0 overflow-visible rounded-2xl border bg-card shadow-[var(--shadow-soft)]">
            <div className="border-b bg-muted/35 px-4 py-3 sm:px-5">
              <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Routine days">
                {days.map((day, index) => (
                  <button
                    key={`${index}-${day.name}`}
                    type="button"
                    role="tab"
                    aria-selected={index === selectedDayIndex}
                    className={cn(
                      "shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      index === selectedDayIndex
                        ? "bg-card text-primary shadow-sm"
                        : "text-muted-foreground hover:bg-card/70 hover:text-foreground"
                    )}
                    onClick={() => {
                      setSelectedDayIndex(index);
                      setInsertPosition(days[index]?.exercises.length ?? 0);
                    }}
                  >
                    Day {index + 1}
                  </button>
                ))}
                {days.length < 7 && (
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-primary hover:bg-card/70"
                    onClick={() => {
                      const nextIndex = days.length;
                      setDays((current) => [
                        ...current,
                        {
                          name: DAY_NAMES[current.length] ?? `Day ${current.length + 1}`,
                          notes: null,
                          warmupNotes: null,
                          exercises: [],
                        },
                      ]);
                      setSelectedDayIndex(nextIndex);
                      setInsertPosition(0);
                    }}
                  >
                    <Plus className="size-4" /> Add day
                  </button>
                )}
              </div>
            </div>

            {selectedDay && (
              <div>
                <div className="flex items-center gap-2 border-b px-4 py-4 sm:px-5">
                  <Input
                    aria-label="Day name"
                    value={selectedDay.name}
                    className="h-11 flex-1 border-0 bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:ring-0 sm:text-xl"
                    onChange={(event) =>
                      updateDay(selectedDayIndex, { name: event.target.value })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove day"
                    disabled={days.length === 1}
                    onClick={() => {
                      const nextDays = days.filter(
                        (_, index) => index !== selectedDayIndex
                      );
                      setDays(nextDays);
                      const nextIndex = Math.max(
                        0,
                        Math.min(selectedDayIndex, nextDays.length - 1)
                      );
                      setSelectedDayIndex(nextIndex);
                      setInsertPosition(nextDays[nextIndex]?.exercises.length ?? 0);
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                </div>

                <div className="grid gap-3 border-b p-4 sm:grid-cols-2 sm:p-5">
                  <label className="text-sm font-medium">Day notes
                    <Textarea className="mt-1" value={selectedDay.notes ?? ""} onChange={(event) => updateDay(selectedDayIndex, { notes: event.target.value.trim() ? event.target.value : null })} />
                  </label>
                  <label className="text-sm font-medium">Warm-up
                    <Textarea className="mt-1" value={selectedDay.warmupNotes ?? ""} placeholder="One warm-up for this workout day" onChange={(event) => updateDay(selectedDayIndex, { warmupNotes: event.target.value.trim() ? event.target.value : null })} />
                  </label>
                </div>

                <div className="divide-y">
                  {selectedDay.exercises.map((exercise, exerciseIndex) => {
                    const metadata = exerciseMetadata[exercise.exerciseId];
                    const libraryExercise = exerciseLibraryById.get(
                      exercise.exerciseId
                    );
                    return (
                      <article
                        key={exercise.clientKey}
                        className={cn(
                          "px-4 py-5 sm:px-5",
                          exercise.supersetGroup && "border-l-4 border-l-violet-400"
                        )}
                      >
                        {exercise.supersetGroup && (
                          <Badge className="mb-3 bg-violet-100 text-violet-700 hover:bg-violet-100">
                            Superset {exercise.supersetGroup}
                          </Badge>
                        )}
                        <div className="flex items-start gap-3 sm:gap-4">
                          <ExerciseFamilyIcon
                            family={libraryExercise?.family}
                            exerciseName={exercise.name}
                            movementPattern={
                              metadata?.movementPattern ??
                              libraryExercise?.movementPattern ??
                              ""
                            }
                            media={libraryExercise?.media}
                            className="size-14 rounded-full bg-muted/70 text-muted-foreground"
                            iconClassName="size-6"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <h3 className="truncate font-semibold">{exercise.name}</h3>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {metadata
                                    ? titleCase(metadata.movementPattern)
                                    : "Exercise"}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-0.5">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Move ${exercise.name} up`}
                                  title="Move up"
                                  disabled={exerciseIndex === 0}
                                  onClick={() =>
                                    moveExercise(
                                      selectedDayIndex,
                                      exerciseIndex,
                                      exerciseIndex - 1
                                    )
                                  }
                                >
                                  <ArrowUp className="size-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Move ${exercise.name} down`}
                                  title="Move down"
                                  disabled={
                                    exerciseIndex === selectedDay.exercises.length - 1
                                  }
                                  onClick={() =>
                                    moveExercise(
                                      selectedDayIndex,
                                      exerciseIndex,
                                      exerciseIndex + 1
                                    )
                                  }
                                >
                                  <ArrowDown className="size-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Remove ${exercise.name}`}
                                  title="Remove exercise"
                                  onClick={() =>
                                    updateDay(selectedDayIndex, {
                                      exercises: selectedDay.exercises.filter(
                                        (_, index) => index !== exerciseIndex
                                      ),
                                    })
                                  }
                                >
                                  <X className="size-4" />
                                </Button>
                              </div>
                            </div>

                            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                              <label className="text-xs font-medium text-muted-foreground">
                                Sets
                                <SmallNumber
                                  value={exercise.sets}
                                  min={1}
                                  width="mt-1 w-full"
                                  onChange={(value) =>
                                    updateExercise(selectedDayIndex, exerciseIndex, {
                                      sets: value ?? 1,
                                    })
                                  }
                                />
                              </label>
                              <label className="text-xs font-medium text-muted-foreground">
                                Reps
                                <span className="mt-1 flex items-center gap-1">
                                  <SmallNumber
                                    value={exercise.repMin}
                                    min={1}
                                    width="min-w-0 flex-1"
                                    onChange={(value) =>
                                      updateExercise(selectedDayIndex, exerciseIndex, {
                                        repMin: value ?? 1,
                                      })
                                    }
                                  />
                                  <span>–</span>
                                  <SmallNumber
                                    value={exercise.repMax}
                                    min={1}
                                    width="min-w-0 flex-1"
                                    onChange={(value) =>
                                      updateExercise(selectedDayIndex, exerciseIndex, {
                                        repMax: value ?? 1,
                                      })
                                    }
                                  />
                                </span>
                              </label>
                              <label className="text-xs font-medium text-muted-foreground">
                                Load ({unit})
                                <SmallNumber
                                  value={exercise.targetLoad}
                                  width="mt-1 w-full"
                                  onChange={(value) =>
                                    updateExercise(selectedDayIndex, exerciseIndex, {
                                      targetLoad: value,
                                      targetLoadUnit: value == null ? null : unit,
                                    })
                                  }
                                />
                              </label>
                              <label className="text-xs font-medium text-muted-foreground">
                                Rest
                                <span className="mt-1 block [&>select]:w-full">
                                  <RestSelect
                                    value={exercise.restSec}
                                    onChange={(value) =>
                                      updateExercise(selectedDayIndex, exerciseIndex, {
                                        restSec: value,
                                      })
                                    }
                                  />
                                </span>
                              </label>
                            </div>

                            <label className="mt-3 block text-xs font-medium text-muted-foreground">
                              Superset group
                              <select
                                className="mt-1 h-9 w-full rounded-lg border bg-background px-2 text-sm sm:w-32"
                                value={exercise.supersetGroup ?? ""}
                                onChange={(event) =>
                                  updateExercise(selectedDayIndex, exerciseIndex, {
                                    supersetGroup: event.target.value || null,
                                  })
                                }
                              >
                                {SUPERSET_LETTERS.map((letter) => (
                                  <option key={letter ?? "none"} value={letter ?? ""}>
                                    {letter ?? "None"}
                                  </option>
                                ))}
                              </select>
                            </label>

                            {exercise.notes && (
                              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                {exercise.notes}
                              </p>
                            )}

                            <details className="group mt-3 rounded-lg bg-muted/35 px-3 py-2">
                              <summary className="cursor-pointer list-none text-sm font-medium text-primary">
                                Edit notes, warm-up and set cues
                              </summary>
                              <div className="mt-3 border-t pt-3">
                                <Textarea
                                  value={exercise.notes ?? ""}
                                  placeholder="Exercise cues, substitutions, per-side details, or optional status…"
                                  className="min-h-20 text-sm"
                                  onChange={(event) =>
                                    updateExercise(selectedDayIndex, exerciseIndex, {
                                      notes: event.target.value || null,
                                    })
                                  }
                                />
                                <WarmupEditor
                                  warmup={exercise.warmup}
                                  onChange={(warmup) =>
                                    updateExercise(selectedDayIndex, exerciseIndex, {
                                      warmup,
                                    })
                                  }
                                />
                                <SetNotesEditor
                                  sets={exercise.sets}
                                  notes={exercise.setNotes}
                                  onChange={(setNotes) =>
                                    updateExercise(selectedDayIndex, exerciseIndex, {
                                      setNotes,
                                    })
                                  }
                                />
                              </div>
                            </details>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>

                <div className="border-t bg-muted/20 p-4 sm:p-5">
                  <div className="mb-3">
                    <p className="text-sm font-medium">Add exercise</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Choose its exact position now, or use the arrow buttons to
                      reorder it later.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
                    <label className="text-xs font-medium text-muted-foreground">
                      Insert position
                      <select
                        aria-label="Insert position"
                        className="mt-1 h-10 w-full rounded-lg border bg-card px-3 text-sm text-foreground"
                        value={Math.min(
                          insertPosition,
                          selectedDay.exercises.length
                        )}
                        onChange={(event) =>
                          setInsertPosition(Number(event.target.value))
                        }
                      >
                        {selectedDay.exercises.length === 0 ? (
                          <option value={0}>First exercise</option>
                        ) : (
                          Array.from(
                            { length: selectedDay.exercises.length + 1 },
                            (_, position) => {
                              const label =
                                position === 0
                                  ? "At the start"
                                  : position === selectedDay.exercises.length
                                    ? "At the end"
                                    : `After ${selectedDay.exercises[position - 1].name}`;
                              return (
                                <option key={position} value={position}>
                                  {label}
                                </option>
                              );
                            }
                          )
                        )}
                      </select>
                    </label>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        Exercise
                      </p>
                      <div className="mt-1">
                        <ExercisePicker
                          items={exerciseLibrary}
                          onSelect={insertExercise}
                          triggerLabel="Browse and add exercise"
                          title={`Add exercise to ${selectedDay.name}`}
                          confirmLabel="Add to routine"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          <aside className="min-w-0 flex flex-col gap-4 xl:sticky xl:top-6">
            <div className="rounded-2xl border bg-card p-5 shadow-[var(--shadow-soft)]">
              <h2 className="font-semibold">Routine summary</h2>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Exercises</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">
                    {selectedExercises.length}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Total sets</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">
                    {selectedSetCount}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Estimated</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">
                    {estimatedMinutes}m
                  </p>
                </div>
              </div>

              <div className="mt-5 border-t pt-4">
                <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Muscle</span>
                  <span>Sets</span>
                </div>
                {muscleSummary.length > 0 ? (
                  <div className="flex flex-col gap-2.5">
                    {muscleSummary.slice(0, 8).map(([muscle, sets]) => (
                      <div key={muscle} className="grid grid-cols-[80px_1fr_22px] items-center gap-2 text-sm">
                        <span className="truncate">{titleCase(muscle)}</span>
                        <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{ width: `${Math.max(12, (sets / maxMuscleSets) * 100)}%` }}
                          />
                        </span>
                        <span className="text-right tabular-nums text-muted-foreground">
                          {sets}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Add exercises to see the day&apos;s training balance.
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-2xl border bg-card p-4 shadow-[var(--shadow-soft)]">
              <Button size="lg" className="h-11 w-full" disabled={pending} onClick={handleSave}>
                {pending ? "Saving…" : "Save & continue"}
              </Button>
              <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <Clock3 className="size-3.5" /> Changes stay a draft until review
              </p>
            </div>

            {error && activeTab === "manual" && (
              <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
          </aside>
        </div>
      </TabsContent>
    </Tabs>
  );
}
