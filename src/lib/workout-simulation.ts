import { z } from "zod";
import {
  SUBSTITUTION_REASONS,
  type ExerciseAlternativeReason,
} from "@/lib/exercise-alternatives";

export const SIMULATION_WORKSPACE_VERSION = 1 as const;
export const SIMULATION_MAX_DAYS = 20;
export const SIMULATION_MAX_EXERCISES_PER_DAY = 100;
export const SIMULATION_MAX_OCCURRENCES = 2_000;
export const SIMULATION_MAX_SETS = 1_000;
export const SIMULATION_MAX_FEEDBACK = 100;
export const SIMULATION_NOTE_MAX_LENGTH = 500;
export const SIMULATION_LABEL_MAX_LENGTH = 500;

const loadUnitSchema = z.enum(["lb", "kg"]);
const isoSchema = z.string().datetime({ offset: true });
const nonEmpty = z.string().trim().min(1).max(SIMULATION_LABEL_MAX_LENGTH);
const boundedWarmupLabel = z
  .string()
  .min(1)
  .max(SIMULATION_LABEL_MAX_LENGTH);
const sourceId = z.string().min(1).max(200);
const simulationIdSchema = z.string().regex(/^sim_(workspace|workout|exercise|occurrence|set|feedback)_[A-Za-z0-9_-]+$/).max(240);

const warmupSchema = z.object({
  id: sourceId,
  // A lossless chunk of one non-empty source line can be whitespace-only when
  // a long run crosses the fixed-size boundary.
  label: boundedWarmupLabel,
  orderIdx: z.number().int().min(0).max(2_000),
  note: z.string().max(SIMULATION_NOTE_MAX_LENGTH).nullable(),
});

const equipmentOptionSchema = z.object({
  key: sourceId,
  label: nonEmpty,
  guidance: z.string().max(1_000).nullable(),
});

const referenceMediaSchema = z.object({
  thumbnailUrl: z.string().max(2_000).nullable().optional(),
  kind: z.enum(["image", "video"]).nullable().optional(),
  images: z.array(z.object({
    url: z.string().min(1).max(2_000),
    alt: z.string().min(1).max(500),
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
  })).max(12).optional(),
  video: z.object({
    url: z.string().min(1).max(2_000),
    posterUrl: z.string().max(2_000).nullable().optional(),
    title: z.string().max(500).nullable().optional(),
  }).nullable().optional(),
});

const alternativeSchema = z.object({
  exerciseId: sourceId,
  name: nonEmpty,
  loadType: z.string().min(1).max(100),
  equipmentOptions: z.array(equipmentOptionSchema).max(100).optional(),
  painGuidance: z.array(z.string().min(1).max(1_000)).max(50).optional(),
  media: referenceMediaSchema.nullable().optional(),
});

const sourceExerciseSchema = z.object({
  id: sourceId,
  exerciseId: sourceId,
  name: nonEmpty,
  orderIdx: z.number().int().min(0).max(2_000),
  groupId: sourceId.nullable(),
  groupMemberOrderIdx: z.number().int().min(0).max(100).nullable(),
  sets: z.number().int().min(0).max(50),
  repsMin: z.number().int().min(0).max(100).nullable(),
  repsMax: z.number().int().min(0).max(100).nullable(),
  targetLoad: z.number().min(0).max(2_000).nullable(),
  targetLoadUnit: loadUnitSchema.nullable(),
  restSec: z.number().int().min(0).max(1_800),
  note: z.string().max(SIMULATION_NOTE_MAX_LENGTH).nullable(),
  warmups: z.array(warmupSchema).max(100),
  alternatives: z.array(alternativeSchema).max(250),
  equipmentOptions: z.array(equipmentOptionSchema).max(100),
  painGuidance: z.array(z.string().min(1).max(1_000)).max(50),
  media: referenceMediaSchema.nullable().optional(),
  loadType: z.string().min(1).max(100),
}).refine((value) => (value.targetLoad == null) === (value.targetLoadUnit == null), {
  message: "A simulated target load and unit must be supplied together.",
  path: ["targetLoadUnit"],
});

const sourceGroupSchema = z.object({
  id: sourceId,
  name: nonEmpty,
  orderIdx: z.number().int().min(0).max(100),
  plannedRounds: z.number().int().min(1).max(20),
  restBetweenMembersSec: z.number().int().min(0).max(1_800),
  restBetweenRoundsSec: z.number().int().min(0).max(1_800),
});

const sourceDaySchema = z.object({
  id: sourceId,
  name: nonEmpty,
  orderIdx: z.number().int().min(0).max(100),
  warmups: z.array(warmupSchema).max(100),
  groups: z.array(sourceGroupSchema).max(20),
  exercises: z.array(sourceExerciseSchema).max(SIMULATION_MAX_EXERCISES_PER_DAY),
});

export const simulationSourceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  ownerId: z.string().uuid(),
  program: z.object({
    id: sourceId,
    versionId: sourceId,
    versionNo: z.number().int().min(1),
    name: nonEmpty,
  }),
  sourceDigest: z.string().min(1).max(256),
  capturedAtISO: isoSchema,
  unit: loadUnitSchema,
  days: z.array(sourceDaySchema).min(1).max(SIMULATION_MAX_DAYS),
});

export type SimulationSourceSnapshot = z.infer<typeof simulationSourceSnapshotSchema>;
export type SimulationSourceExercise = SimulationSourceSnapshot["days"][number]["exercises"][number];
export type SimulationLoadUnit = z.infer<typeof loadUnitSchema>;

const simulationExerciseSchema = z.object({
  id: simulationIdSchema,
  sourceSlotId: sourceId,
  plannedExerciseId: sourceId,
  plannedName: nonEmpty,
  actualExerciseId: sourceId,
  actualName: nonEmpty,
  orderIdx: z.number().int().min(0),
  groupId: sourceId.nullable(),
  groupMemberOrderIdx: z.number().int().min(0).nullable(),
  setsPlanned: z.number().int().min(0).max(50),
  repsMin: z.number().int().min(0).max(100).nullable(),
  repsMax: z.number().int().min(0).max(100).nullable(),
  targetLoad: z.number().min(0).max(2_000).nullable(),
  targetLoadUnit: loadUnitSchema.nullable(),
  restSec: z.number().int().min(0).max(1_800),
  note: z.string().max(SIMULATION_NOTE_MAX_LENGTH).nullable(),
  alternatives: z.array(alternativeSchema).max(250),
  equipmentOptions: z.array(equipmentOptionSchema).max(100),
  selectedEquipmentKey: sourceId.nullable(),
  painGuidance: z.array(z.string().max(1_000)).max(50),
  media: referenceMediaSchema.nullable().optional(),
  painFlags: z.array(z.object({
    bodyPart: z.string().trim().min(1).max(100),
    severity: z.number().int().min(1).max(5),
    recordedAtISO: isoSchema,
  })).max(50),
  plannedLoadType: z.string().min(1).max(100),
  loadType: z.string().min(1).max(100),
  substitutionReason: z.enum(SUBSTITUTION_REASONS).nullable(),
});

const occurrenceSchema = z.object({
  id: simulationIdSchema,
  simulationExerciseId: simulationIdSchema.nullable(),
  kind: z.enum(["day_warmup", "exercise_warmup", "working_set"]),
  sequenceIdx: z.number().int().min(0),
  kindOrdinal: z.number().int().min(0),
  label: z.string().max(500).nullable(),
  groupId: sourceId.nullable(),
  groupRound: z.number().int().min(1).nullable(),
  groupMemberOrderIdx: z.number().int().min(0).nullable(),
  plannedExerciseId: sourceId.nullable(),
  actualExerciseId: sourceId.nullable(),
  plannedRepsMin: z.number().int().min(0).max(100).nullable(),
  plannedRepsMax: z.number().int().min(0).max(100).nullable(),
  plannedLoad: z.number().min(0).max(2_000).nullable(),
  plannedLoadUnit: loadUnitSchema.nullable(),
  plannedNote: z.string().max(SIMULATION_NOTE_MAX_LENGTH).nullable(),
  restAfterSec: z.number().int().min(0).max(1_800),
  outcome: z.enum(["pending", "completed", "skipped", "abandoned"]),
  outcomeReason: z.string().max(200).nullable(),
  outcomeNote: z.string().max(SIMULATION_NOTE_MAX_LENGTH).nullable(),
  completedSetId: simulationIdSchema.nullable(),
  revision: z.number().int().min(0),
  resolvedAtISO: isoSchema.nullable(),
});

const simulationSetSchema = z.object({
  id: simulationIdSchema,
  occurrenceId: simulationIdSchema,
  simulationExerciseId: simulationIdSchema,
  reps: z.number().int().min(0).max(100),
  load: z.number().min(0).max(2_000).nullable(),
  loadUnit: loadUnitSchema.nullable(),
  rpe: z.number().min(1).max(10).nullable(),
  note: z.string().max(SIMULATION_NOTE_MAX_LENGTH).nullable(),
  revision: z.number().int().min(0),
  createdAtISO: isoSchema,
  updatedAtISO: isoSchema,
}).refine((value) => (value.load == null) === (value.loadUnit == null), {
  message: "A simulated set load and unit must be supplied together.",
  path: ["loadUnit"],
});

const restSchema = z.object({
  occurrenceId: simulationIdSchema,
  phase: z.enum(["running", "ready", "skipped"]),
  plannedSeconds: z.number().int().min(1).max(1_800),
  remainingSeconds: z.number().int().min(0).max(1_800),
  updatedAtISO: isoSchema,
});

const simulationWorkoutSchema = z.object({
  id: simulationIdSchema,
  sourceDayId: sourceId,
  sourceDayIndex: z.number().int().min(0).max(SIMULATION_MAX_DAYS - 1),
  dayName: nonEmpty,
  startedAtISO: isoSchema,
  updatedAtISO: isoSchema,
  groups: z.array(sourceGroupSchema).max(20),
  exercises: z.array(simulationExerciseSchema).max(SIMULATION_MAX_EXERCISES_PER_DAY),
  occurrences: z.array(occurrenceSchema).max(SIMULATION_MAX_OCCURRENCES),
  sets: z.array(simulationSetSchema).max(SIMULATION_MAX_SETS),
  rest: restSchema.nullable(),
});

const workoutSummarySchema = z.object({
  id: simulationIdSchema,
  sourceDayId: sourceId,
  dayName: nonEmpty,
  startedAtISO: isoSchema,
  finishedAtISO: isoSchema,
  completed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  abandoned: z.number().int().min(0),
});

const feedbackSchema = z.object({
  id: simulationIdSchema,
  contextKind: z.enum(["screen", "exercise", "occurrence", "moment"]),
  contextKey: z.string().min(1).max(240),
  screenLabel: z.string().trim().min(1).max(200).nullable(),
  note: z.string().trim().min(1).max(SIMULATION_NOTE_MAX_LENGTH),
  createdAtISO: isoSchema,
});

export const simulationWorkspaceSchema = z.object({
  version: z.literal(SIMULATION_WORKSPACE_VERSION),
  ownerId: z.string().uuid(),
  simulationId: simulationIdSchema,
  source: simulationSourceSnapshotSchema,
  createdAtISO: isoSchema,
  updatedAtISO: isoSchema,
  revision: z.number().int().min(0),
  status: z.enum(["active", "completed"]),
  selectedDayIndex: z.number().int().min(0).max(SIMULATION_MAX_DAYS - 1),
  activeWorkout: simulationWorkoutSchema.nullable(),
  completedWorkouts: z.array(workoutSummarySchema).max(SIMULATION_MAX_DAYS * 10),
  feedback: z.array(feedbackSchema).max(SIMULATION_MAX_FEEDBACK),
}).superRefine((workspace, context) => {
  if (workspace.ownerId !== workspace.source.ownerId) {
    context.addIssue({ code: "custom", message: "Simulation source owner does not match workspace owner.", path: ["source", "ownerId"] });
  }
  if (workspace.selectedDayIndex >= workspace.source.days.length) {
    context.addIssue({ code: "custom", message: "Selected simulation day is unavailable.", path: ["selectedDayIndex"] });
  }
});

export type SimulationWorkspace = z.infer<typeof simulationWorkspaceSchema>;
export type SimulationWorkout = NonNullable<SimulationWorkspace["activeWorkout"]>;
export type SimulationOccurrence = SimulationWorkout["occurrences"][number];
export type SimulationFeedbackEntry = SimulationWorkspace["feedback"][number];

export type SimulationDependencies = {
  createId?: () => string;
  nowISO?: string;
};

function defaultId() {
  return crypto.randomUUID();
}

function prefixedId(kind: "workspace" | "workout" | "exercise" | "occurrence" | "set" | "feedback", createId: () => string) {
  const suffix = createId().replace(/[^A-Za-z0-9_-]/g, "_");
  return `sim_${kind}_${suffix}`;
}

function now(dependencies?: SimulationDependencies) {
  return dependencies?.nowISO ?? new Date().toISOString();
}

function touch(workspace: SimulationWorkspace, updatedAtISO: string, patch: Partial<SimulationWorkspace>): SimulationWorkspace {
  return simulationWorkspaceSchema.parse({
    ...workspace,
    ...patch,
    updatedAtISO,
    revision: workspace.revision + 1,
  });
}

function requireActive(workspace: SimulationWorkspace): SimulationWorkout {
  if (!workspace.activeWorkout) throw new Error("No simulated workout is active.");
  return workspace.activeWorkout;
}

function replaceWorkout(workspace: SimulationWorkspace, workout: SimulationWorkout, updatedAtISO: string) {
  return touch(workspace, updatedAtISO, { activeWorkout: { ...workout, updatedAtISO } });
}

export function createSimulationWorkspace(source: SimulationSourceSnapshot, dependencies: SimulationDependencies = {}): SimulationWorkspace {
  const validated = simulationSourceSnapshotSchema.parse(source);
  const createdAtISO = now(dependencies);
  const createId = dependencies.createId ?? defaultId;
  return simulationWorkspaceSchema.parse({
    version: SIMULATION_WORKSPACE_VERSION,
    ownerId: validated.ownerId,
    simulationId: prefixedId("workspace", createId),
    source: validated,
    createdAtISO,
    updatedAtISO: createdAtISO,
    revision: 0,
    status: "active",
    selectedDayIndex: 0,
    activeWorkout: null,
    completedWorkouts: [],
    feedback: [],
  });
}

export function startSimulationWorkout(workspace: SimulationWorkspace, dayIndex: number, dependencies: SimulationDependencies = {}): SimulationWorkspace {
  if (workspace.activeWorkout) throw new Error("A simulated workout is already active.");
  const day = workspace.source.days[dayIndex];
  if (!day) throw new Error("That simulated Program day is unavailable.");
  const createId = dependencies.createId ?? defaultId;
  const updatedAtISO = now(dependencies);
  const workoutId = prefixedId("workout", createId);
  const exercises = [...day.exercises].sort((a, b) => a.orderIdx - b.orderIdx).map((exercise) => ({
    id: prefixedId("exercise", createId),
    sourceSlotId: exercise.id,
    plannedExerciseId: exercise.exerciseId,
    plannedName: exercise.name,
    actualExerciseId: exercise.exerciseId,
    actualName: exercise.name,
    orderIdx: exercise.orderIdx,
    groupId: exercise.groupId,
    groupMemberOrderIdx: exercise.groupMemberOrderIdx,
    setsPlanned: exercise.sets,
    repsMin: exercise.repsMin,
    repsMax: exercise.repsMax,
    targetLoad: exercise.targetLoad,
    targetLoadUnit: exercise.targetLoadUnit,
    restSec: exercise.restSec,
    note: exercise.note,
    alternatives: exercise.alternatives,
    equipmentOptions: exercise.equipmentOptions,
    selectedEquipmentKey: exercise.equipmentOptions.length === 1 ? exercise.equipmentOptions[0].key : null,
    painGuidance: exercise.painGuidance,
    media: exercise.media ?? null,
    painFlags: [],
    plannedLoadType: exercise.loadType,
    loadType: exercise.loadType,
    substitutionReason: null,
  }));
  const simulationExerciseBySlot = new Map(exercises.map((exercise) => [exercise.sourceSlotId, exercise]));
  const occurrences: SimulationOccurrence[] = [];
  const addOccurrence = (input: Omit<SimulationOccurrence, "id" | "sequenceIdx" | "revision" | "outcome" | "outcomeReason" | "outcomeNote" | "completedSetId" | "resolvedAtISO">) => {
    occurrences.push({
      ...input,
      id: prefixedId("occurrence", createId),
      sequenceIdx: occurrences.length,
      revision: 0,
      outcome: "pending",
      outcomeReason: null,
      outcomeNote: null,
      completedSetId: null,
      resolvedAtISO: null,
    });
  };
  [...day.warmups].sort((a, b) => a.orderIdx - b.orderIdx).forEach((warmup, index) => addOccurrence({
    simulationExerciseId: null, kind: "day_warmup", kindOrdinal: index, label: warmup.label,
    groupId: null, groupRound: null, groupMemberOrderIdx: null, plannedExerciseId: null,
    actualExerciseId: null, plannedRepsMin: null, plannedRepsMax: null, plannedLoad: null,
    plannedLoadUnit: null, plannedNote: warmup.note, restAfterSec: 0,
  }));
  let exerciseWarmupOrdinal = 0;
  for (const sourceExercise of [...day.exercises].sort((a, b) => a.orderIdx - b.orderIdx)) {
    const exercise = simulationExerciseBySlot.get(sourceExercise.id)!;
    for (const warmup of [...sourceExercise.warmups].sort((a, b) => a.orderIdx - b.orderIdx)) {
      addOccurrence({
        simulationExerciseId: exercise.id, kind: "exercise_warmup", kindOrdinal: exerciseWarmupOrdinal++,
        label: warmup.label, groupId: null, groupRound: null, groupMemberOrderIdx: null,
        plannedExerciseId: exercise.plannedExerciseId, actualExerciseId: exercise.actualExerciseId,
        plannedRepsMin: null, plannedRepsMax: null, plannedLoad: null, plannedLoadUnit: null,
        plannedNote: warmup.note, restAfterSec: 0,
      });
    }
  }
  const handledGroups = new Set<string>();
  for (const sourceExercise of [...day.exercises].sort((a, b) => a.orderIdx - b.orderIdx)) {
    const exercise = simulationExerciseBySlot.get(sourceExercise.id)!;
    if (!sourceExercise.groupId) {
      for (let set = 0; set < sourceExercise.sets; set += 1) addOccurrence({
        simulationExerciseId: exercise.id, kind: "working_set", kindOrdinal: set, label: null,
        groupId: null, groupRound: null, groupMemberOrderIdx: null,
        plannedExerciseId: exercise.plannedExerciseId, actualExerciseId: exercise.actualExerciseId,
        plannedRepsMin: exercise.repsMin, plannedRepsMax: exercise.repsMax,
        plannedLoad: exercise.targetLoad, plannedLoadUnit: exercise.targetLoadUnit,
        plannedNote: exercise.note, restAfterSec: exercise.restSec,
      });
      continue;
    }
    if (handledGroups.has(sourceExercise.groupId)) continue;
    handledGroups.add(sourceExercise.groupId);
    const group = day.groups.find((candidate) => candidate.id === sourceExercise.groupId);
    if (!group) throw new Error("A simulated grouped exercise is missing its group definition.");
    const members = day.exercises.filter((candidate) => candidate.groupId === group.id).sort((a, b) => (a.groupMemberOrderIdx ?? a.orderIdx) - (b.groupMemberOrderIdx ?? b.orderIdx));
    for (let round = 1; round <= group.plannedRounds; round += 1) {
      const activeMembers = members.filter((member) => member.sets >= round);
      activeMembers.forEach((member, memberIndex) => {
        const target = simulationExerciseBySlot.get(member.id)!;
        const finalMember = memberIndex === activeMembers.length - 1;
        const finalRound = round === group.plannedRounds;
        addOccurrence({
          simulationExerciseId: target.id, kind: "working_set", kindOrdinal: round - 1, label: null,
          groupId: group.id, groupRound: round, groupMemberOrderIdx: member.groupMemberOrderIdx ?? memberIndex,
          plannedExerciseId: target.plannedExerciseId, actualExerciseId: target.actualExerciseId,
          plannedRepsMin: target.repsMin, plannedRepsMax: target.repsMax,
          plannedLoad: target.targetLoad, plannedLoadUnit: target.targetLoadUnit,
          plannedNote: target.note,
          restAfterSec: finalMember ? (finalRound ? 0 : group.restBetweenRoundsSec) : group.restBetweenMembersSec,
        });
      });
    }
  }
  const workout: SimulationWorkout = simulationWorkoutSchema.parse({
    id: workoutId, sourceDayId: day.id, sourceDayIndex: dayIndex, dayName: day.name,
    startedAtISO: updatedAtISO, updatedAtISO, groups: day.groups, exercises, occurrences, sets: [], rest: null,
  });
  return touch(workspace, updatedAtISO, { activeWorkout: workout, selectedDayIndex: dayIndex, status: "active" });
}

function updateOccurrence(workspace: SimulationWorkspace, occurrenceId: string, updatedAtISO: string, updater: (occurrence: SimulationOccurrence) => SimulationOccurrence) {
  const workout = requireActive(workspace);
  let found = false;
  const occurrences = workout.occurrences.map((occurrence) => {
    if (occurrence.id !== occurrenceId) return occurrence;
    found = true;
    return updater(occurrence);
  });
  if (!found) throw new Error("That simulated occurrence is unavailable.");
  return replaceWorkout(workspace, { ...workout, occurrences }, updatedAtISO);
}

export function completeSimulationOccurrence(workspace: SimulationWorkspace, occurrenceId: string, updatedAtISO: string) {
  return updateOccurrence(workspace, occurrenceId, updatedAtISO, (occurrence) => {
    if (occurrence.outcome !== "pending") throw new Error("Only a pending simulated occurrence can be completed.");
    return { ...occurrence, outcome: "completed", revision: occurrence.revision + 1, resolvedAtISO: updatedAtISO };
  });
}

export function noteSimulationOccurrence(workspace: SimulationWorkspace, occurrenceId: string, note: string, updatedAtISO: string) {
  const value = z.string().trim().min(1).max(SIMULATION_NOTE_MAX_LENGTH).parse(note);
  return updateOccurrence(workspace, occurrenceId, updatedAtISO, (occurrence) => ({ ...occurrence, outcomeNote: value, revision: occurrence.revision + 1 }));
}

export function noteSimulationExercise(
  workspace: SimulationWorkspace,
  exerciseId: string,
  note: string,
  updatedAtISO: string,
) {
  const value = z.string().trim().max(SIMULATION_NOTE_MAX_LENGTH).parse(note);
  const { next } = updateExercise(workspace, exerciseId, updatedAtISO, (exercise) => ({
    ...exercise,
    note: value || null,
  }));
  return replaceWorkout(workspace, next, updatedAtISO);
}

export function skipSimulationOccurrence(workspace: SimulationWorkspace, occurrenceId: string, reason: string, note: string | null, updatedAtISO: string) {
  return updateOccurrence(workspace, occurrenceId, updatedAtISO, (occurrence) => {
    if (occurrence.outcome !== "pending") throw new Error("Only a pending simulated occurrence can be skipped.");
    return {
      ...occurrence, outcome: "skipped", outcomeReason: z.string().trim().min(1).max(200).parse(reason),
      outcomeNote: note == null ? occurrence.outcomeNote : z.string().trim().max(SIMULATION_NOTE_MAX_LENGTH).parse(note),
      completedSetId: null, revision: occurrence.revision + 1, resolvedAtISO: updatedAtISO,
    };
  });
}

export function restoreSimulationOccurrence(workspace: SimulationWorkspace, occurrenceId: string, updatedAtISO: string) {
  return updateOccurrence(workspace, occurrenceId, updatedAtISO, (occurrence) => {
    if (occurrence.outcome !== "skipped") throw new Error("Only a skipped simulated occurrence can be restored.");
    return { ...occurrence, outcome: "pending", outcomeReason: null, outcomeNote: null, completedSetId: null, revision: occurrence.revision + 1, resolvedAtISO: null };
  });
}

export function completeSimulationSet(
  workspace: SimulationWorkspace,
  occurrenceId: string,
  input: { reps: number; load: number | null; loadUnit: SimulationLoadUnit | null; rpe: number | null; note: string | null },
  dependencies: SimulationDependencies = {},
) {
  const workout = requireActive(workspace);
  const occurrence = workout.occurrences.find((item) => item.id === occurrenceId);
  if (!occurrence || occurrence.kind !== "working_set" || !occurrence.simulationExerciseId) throw new Error("That simulated working set is unavailable.");
  if (occurrence.outcome !== "pending") throw new Error("Only a pending simulated set can be completed.");
  const exercise = workout.exercises.find((item) => item.id === occurrence.simulationExerciseId);
  if (!exercise) throw new Error("That simulated exercise is unavailable.");
  if (exercise.equipmentOptions.length > 0 && exercise.selectedEquipmentKey == null) {
    throw new Error("Choose simulated equipment before completing this set.");
  }
  const createId = dependencies.createId ?? defaultId;
  const updatedAtISO = now(dependencies);
  const set = simulationSetSchema.parse({
    id: prefixedId("set", createId), occurrenceId, simulationExerciseId: occurrence.simulationExerciseId,
    reps: input.reps, load: input.load, loadUnit: input.loadUnit, rpe: input.rpe,
    note: input.note?.trim() || null, revision: 0, createdAtISO: updatedAtISO, updatedAtISO,
  });
  const occurrences = workout.occurrences.map((item) => item.id === occurrenceId ? {
    ...item, outcome: "completed" as const, completedSetId: set.id, revision: item.revision + 1, resolvedAtISO: updatedAtISO,
  } : item);
  const rest = occurrence.restAfterSec > 0 ? {
    occurrenceId, phase: "running" as const, plannedSeconds: occurrence.restAfterSec,
    remainingSeconds: occurrence.restAfterSec, updatedAtISO,
  } : null;
  return replaceWorkout(workspace, { ...workout, occurrences, sets: [...workout.sets, set], rest }, updatedAtISO);
}

export function correctSimulationSet(workspace: SimulationWorkspace, setId: string, patch: Partial<Pick<SimulationWorkout["sets"][number], "reps" | "load" | "loadUnit" | "rpe" | "note">>, updatedAtISO: string) {
  const workout = requireActive(workspace);
  let found = false;
  const sets = workout.sets.map((set) => {
    if (set.id !== setId) return set;
    found = true;
    return simulationSetSchema.parse({ ...set, ...patch, note: patch.note?.trim() || (patch.note === null ? null : set.note), revision: set.revision + 1, updatedAtISO });
  });
  if (!found) throw new Error("That simulated set is unavailable.");
  return replaceWorkout(workspace, { ...workout, sets }, updatedAtISO);
}

function updateExercise(workspace: SimulationWorkspace, exerciseId: string, updatedAtISO: string, updater: (exercise: SimulationWorkout["exercises"][number], workout: SimulationWorkout) => SimulationWorkout["exercises"][number]) {
  const workout = requireActive(workspace);
  let found = false;
  const exercises = workout.exercises.map((exercise) => {
    if (exercise.id !== exerciseId) return exercise;
    found = true;
    return updater(exercise, workout);
  });
  if (!found) throw new Error("That simulated exercise is unavailable.");
  return { workout, next: { ...workout, exercises } };
}

export function substituteSimulationExercise(workspace: SimulationWorkspace, exerciseId: string, alternativeExerciseId: string, reason: ExerciseAlternativeReason, updatedAtISO: string) {
  const { next } = updateExercise(workspace, exerciseId, updatedAtISO, (exercise, workout) => {
    const alternative = exercise.alternatives.find((item) => item.exerciseId === alternativeExerciseId);
    if (!alternative) throw new Error("That simulation alternative is unavailable.");
    if (workout.sets.some((set) => set.simulationExerciseId === exerciseId)) throw new Error("A simulated exercise cannot be substituted after a set is completed.");
    const equipmentOptions = alternative.equipmentOptions ?? [];
    return {
      ...exercise,
      actualExerciseId: alternative.exerciseId,
      actualName: alternative.name,
      loadType: alternative.loadType,
      substitutionReason: reason,
      equipmentOptions,
      selectedEquipmentKey: equipmentOptions.length === 1 ? equipmentOptions[0].key : null,
      painGuidance: alternative.painGuidance ?? exercise.painGuidance,
      media: alternative.media ?? null,
    };
  });
  const actualExerciseId = next.exercises.find((exercise) => exercise.id === exerciseId)!.actualExerciseId;
  return replaceWorkout(workspace, { ...next, occurrences: next.occurrences.map((occurrence) => occurrence.simulationExerciseId === exerciseId && occurrence.outcome === "pending" ? { ...occurrence, actualExerciseId } : occurrence) }, updatedAtISO);
}

export function undoSimulationSubstitution(workspace: SimulationWorkspace, exerciseId: string, updatedAtISO: string) {
  const { next } = updateExercise(workspace, exerciseId, updatedAtISO, (exercise, workout) => {
    if (workout.sets.some((set) => set.simulationExerciseId === exerciseId)) throw new Error("A simulated substitution cannot be undone after a set is completed.");
    const source = workspace.source.days[workout.sourceDayIndex]?.exercises.find((item) => item.id === exercise.sourceSlotId);
    if (!source) throw new Error("The planned simulation exercise is unavailable.");
    return {
      ...exercise,
      actualExerciseId: exercise.plannedExerciseId,
      actualName: exercise.plannedName,
      loadType: exercise.plannedLoadType,
      substitutionReason: null,
      equipmentOptions: source.equipmentOptions,
      selectedEquipmentKey: source.equipmentOptions.length === 1 ? source.equipmentOptions[0].key : null,
      painGuidance: source.painGuidance,
      media: source.media ?? null,
    };
  });
  const actualExerciseId = next.exercises.find((exercise) => exercise.id === exerciseId)!.actualExerciseId;
  return replaceWorkout(workspace, { ...next, occurrences: next.occurrences.map((occurrence) => occurrence.simulationExerciseId === exerciseId && occurrence.outcome === "pending" ? { ...occurrence, actualExerciseId } : occurrence) }, updatedAtISO);
}

export function selectSimulationEquipment(workspace: SimulationWorkspace, exerciseId: string, equipmentKey: string, updatedAtISO: string) {
  const { next } = updateExercise(workspace, exerciseId, updatedAtISO, (exercise) => {
    if (!exercise.equipmentOptions.some((option) => option.key === equipmentKey)) throw new Error("That simulated equipment option is unavailable.");
    return { ...exercise, selectedEquipmentKey: equipmentKey };
  });
  return replaceWorkout(workspace, next, updatedAtISO);
}

export function flagSimulationPain(workspace: SimulationWorkspace, exerciseId: string, bodyPart: string, severity: number, updatedAtISO: string) {
  const { next } = updateExercise(workspace, exerciseId, updatedAtISO, (exercise) => ({
    ...exercise,
    painFlags: [...exercise.painFlags, {
      bodyPart: z.string().trim().min(1).max(100).parse(bodyPart),
      severity: z.number().int().min(1).max(5).parse(severity),
      recordedAtISO: updatedAtISO,
    }],
  }));
  return replaceWorkout(workspace, next, updatedAtISO);
}

export function advanceSimulationRest(workspace: SimulationWorkspace, seconds: number, updatedAtISO: string) {
  const workout = requireActive(workspace);
  if (!workout.rest || workout.rest.phase !== "running") throw new Error("No simulated rest is running.");
  const remainingSeconds = Math.max(0, workout.rest.remainingSeconds - z.number().int().min(0).parse(seconds));
  return replaceWorkout(workspace, { ...workout, rest: { ...workout.rest, remainingSeconds, phase: remainingSeconds === 0 ? "ready" : "running", updatedAtISO } }, updatedAtISO);
}

export function skipSimulationRest(workspace: SimulationWorkspace, updatedAtISO: string) {
  const workout = requireActive(workspace);
  if (!workout.rest) throw new Error("No simulated rest is available.");
  return replaceWorkout(workspace, { ...workout, rest: { ...workout.rest, phase: "skipped", remainingSeconds: 0, updatedAtISO } }, updatedAtISO);
}

export function continueSimulationRest(workspace: SimulationWorkspace, updatedAtISO: string) {
  const workout = requireActive(workspace);
  if (!workout.rest || (workout.rest.phase !== "ready" && workout.rest.phase !== "skipped")) throw new Error("Simulated rest is not ready to continue.");
  return replaceWorkout(workspace, { ...workout, rest: null }, updatedAtISO);
}

export function addSimulationFeedback(workspace: SimulationWorkspace, input: {
  contextKind: SimulationFeedbackEntry["contextKind"];
  contextKey: string;
  screenLabel?: string | null;
  note: string;
}, dependencies: SimulationDependencies = {}) {
  if (workspace.feedback.length >= SIMULATION_MAX_FEEDBACK) throw new Error("The simulation feedback limit has been reached.");
  const createId = dependencies.createId ?? defaultId;
  const updatedAtISO = now(dependencies);
  const feedback = feedbackSchema.parse({ ...input, screenLabel: input.screenLabel?.trim() || null, note: input.note.trim(), id: prefixedId("feedback", createId), createdAtISO: updatedAtISO });
  return touch(workspace, updatedAtISO, { feedback: [...workspace.feedback, feedback] });
}

export function finishSimulationWorkout(workspace: SimulationWorkspace, finishedAtISO: string) {
  const workout = requireActive(workspace);
  if (workout.rest) throw new Error("Finish or skip simulated rest before finishing the workout.");
  const occurrences = workout.occurrences.map((occurrence) => occurrence.outcome === "pending" ? {
    ...occurrence, outcome: "abandoned" as const, outcomeReason: "simulation_finished_early",
    revision: occurrence.revision + 1, resolvedAtISO: finishedAtISO,
  } : occurrence);
  const working = occurrences.filter((occurrence) => occurrence.kind === "working_set");
  const summary = workoutSummarySchema.parse({
    id: workout.id, sourceDayId: workout.sourceDayId, dayName: workout.dayName,
    startedAtISO: workout.startedAtISO, finishedAtISO,
    completed: working.filter((item) => item.outcome === "completed").length,
    skipped: working.filter((item) => item.outcome === "skipped").length,
    abandoned: working.filter((item) => item.outcome === "abandoned").length,
  });
  const selectedDayIndex = (workout.sourceDayIndex + 1) % workspace.source.days.length;
  return touch(workspace, finishedAtISO, {
    activeWorkout: null,
    completedWorkouts: [...workspace.completedWorkouts, summary],
    selectedDayIndex,
    status: "active",
  });
}
