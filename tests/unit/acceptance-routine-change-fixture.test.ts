import { describe, expect, it } from "vitest";
import {
  BA_ROUTINE_CHANGE_PROVIDER_REQUESTS,
  buildBaRoutineChangeFixture,
} from "@/ai/acceptance-routine-change-fixture";
import { splitRoutineBuildRequests } from "@/lib/routine-build-chunks";
import { createSuggestedDayIntent, type ProgramDocument } from "@/lib/program-document";
import { createDefaultProgramSlot } from "@/lib/program-editor-client";
import {
  applyProgramUpdateChanges,
  buildProgramUpdateProposal,
} from "@/lib/program-update-reconciliation";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import type { RoutineDraft } from "@/app/actions/setup";
import {
  BA_ROUTINE_CHANGE_BASELINE,
  BA_ROUTINE_CHANGE_REQUEST,
} from "../fixtures/ba-routine-change-contract";

const names = [
  "Barbell Bench Press",
  "Incline Dumbbell Curl",
  "Bulgarian Split Squat",
  "Cable Face Pull",
  "Barbell Back Squat",
  "Romanian Deadlift",
  "Cable Rear Delt Fly",
  "Zottman Curl",
  "Overhead Cable Triceps Extension",
  "Lat Pulldown",
  "Incline Barbell Bench Press",
  "Barbell Overhead Press",
  "EZ-Bar Curl",
  "Dumbbell Lateral Raise",
  "Dumbbell Curl",
  "Triceps Pushdown",
];

const availableExercises = names.map((name, index) => ({
  exerciseId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  name,
  movementPattern: "test",
}));

const currentProgram = {
  name: BA_ROUTINE_CHANGE_BASELINE.program.name,
  days: BA_ROUTINE_CHANGE_BASELINE.program.days.map((day, dayIndex) => ({
    lineageId: `10000000-0000-4000-8000-${String(dayIndex + 1).padStart(12, "0")}`,
    name: day.name,
    exercises: day.exercises.map((exercise, index) => ({
      ...exercise,
      exerciseId: availableExercises.find((item) => item.name === exercise.name)?.exerciseId
        ?? `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      group: null,
    })),
  })),
};

function build(day: 1 | 2 | 3) {
  const request = splitRoutineBuildRequests(BA_ROUTINE_CHANGE_REQUEST)[day - 1];
  return buildBaRoutineChangeFixture({
    request,
    availableExercises,
    currentProgram,
  }).data.days[0]!;
}

describe("deterministic BA routine-change fixture", () => {
  it("receives the exact provider request block for each split day", () => {
    const requests = splitRoutineBuildRequests(BA_ROUTINE_CHANGE_REQUEST);
    expect(requests).toEqual([
      BA_ROUTINE_CHANGE_PROVIDER_REQUESTS[1],
      BA_ROUTINE_CHANGE_PROVIDER_REQUESTS[2],
      BA_ROUTINE_CHANGE_PROVIDER_REQUESTS[3],
    ]);
    expect(() =>
      buildBaRoutineChangeFixture({
        request: `${requests[0]}\n\nUnexpected extra instruction`,
        availableExercises,
        currentProgram,
      }),
    ).toThrow("exact Day 1 provider request block");
  });

  it("returns the complete Day 1 replacement and optional accessory dose", () => {
    const day = build(1);
    expect(day.exercises.map(({ requestedName, sets, repMin, repMax }) => ({ requestedName, sets, repMin, repMax }))).toEqual([
      { requestedName: "Barbell Bench Press", sets: 4, repMin: 5, repMax: 8 },
      { requestedName: "Incline Dumbbell Curl", sets: 3, repMin: 8, repMax: 12 },
      { requestedName: "Bulgarian Split Squat", sets: 2, repMin: 8, repMax: 10 },
      { requestedName: "Face Pull", sets: 2, repMin: 15, repMax: 20 },
    ]);
    expect(day.exercises[3]?.notes).toContain("one set is the minimum");
  });

  it("returns the complete Day 2 replacement and ordered three-member group", () => {
    const day = build(2);
    expect(day.exercises.map((exercise) => exercise.requestedName)).toEqual([
      "Barbell Back Squat",
      "Romanian Deadlift",
      "Cable Rear Delt Fly",
      "Zottman Curl",
      "Overhead Cable Triceps Extension",
    ]);
    expect(day.exercises.slice(2).map((exercise) => [exercise.sets, exercise.supersetGroup])).toEqual([
      [2, "A"],
      [2, "A"],
      [2, "A"],
    ]);
  });

  it("returns the complete Day 3 replacement and ordered superset", () => {
    const day = build(3);
    expect(day.exercises.map((exercise) => [exercise.requestedName, exercise.sets, exercise.repMin, exercise.repMax])).toEqual([
      ["Lat Pulldown", 3, 10, 15],
      ["Incline Barbell Bench Press", 3, 8, 12],
      ["Barbell Overhead Press", 3, 6, 10],
      ["Overhead Cable Triceps Extension", 3, 10, 15],
      ["EZ-Bar Curl", 3, 10, 15],
      ["Dumbbell Lateral Raise", 2, 15, 25],
    ]);
    expect(day.exercises.slice(3, 5).map((exercise) => exercise.supersetGroup)).toEqual(["A", "A"]);
  });

  it("fails specifically when the request or available library is incomplete", () => {
    expect(() => buildBaRoutineChangeFixture({ availableExercises, currentProgram })).toThrow(
      "without Day 1, Day 2, or Day 3",
    );
    expect(() => buildBaRoutineChangeFixture({
      request: splitRoutineBuildRequests(BA_ROUTINE_CHANGE_REQUEST)[0],
      availableExercises: availableExercises.filter((exercise) => exercise.name !== "Cable Face Pull"),
      currentProgram,
    })).toThrow("missing available exercise: Cable Face Pull");
    expect(() => buildBaRoutineChangeFixture({
      request: splitRoutineBuildRequests(BA_ROUTINE_CHANGE_REQUEST)[1]?.replace(
        "- Romanian Deadlift: change to 3×8–10\n",
        "",
      ),
      availableExercises,
      currentProgram,
    })).toThrow("exact Day 2 provider request block");
  });

  it("reconciles every exact change without a blocking decision", () => {
    let nextId = 100;
    const createId = () =>
      `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
    const library = availableExercises.map((exercise) => ({
      id: exercise.exerciseId,
      name: exercise.name,
    })) as ExerciseDiscoveryItem[];
    const currentDays = currentProgram.days.map((day) => {
      const exercises = day.exercises.map((exercise, index) => ({
        ...createDefaultProgramSlot(exercise.exerciseId, createId(), index),
        sets: exercise.sets,
        repMin: exercise.repMin,
        repMax: exercise.repMax,
        restSec: exercise.restSec,
        targetLoad: 10,
        targetLoadUnit: "lb" as const,
      }));
      return {
        lineageId: day.lineageId,
        name: day.name,
        notes: null,
        warmupNotes: null,
        intent: createSuggestedDayIntent(exercises),
        supersets: [],
        exercises,
      };
    });
    const current: ProgramDocument = {
      schemaVersion: "2",
      programId: createId(),
      baseVersionId: createId(),
      name: currentProgram.name,
      days: currentDays,
    };
    const candidate: RoutineDraft = {
      days: ([1, 2, 3] as const).map((dayNumber) => {
        const day = build(dayNumber);
        return {
          name: day.name,
          notes: day.notes,
          warmupNotes: day.warmupNotes,
          exercises: day.exercises.map((exercise) => ({
            exerciseId: exercise.exerciseId,
            name: library.find((item) => item.id === exercise.exerciseId)?.name ?? exercise.requestedName,
            sets: exercise.sets,
            repMin: exercise.repMin,
            repMax: exercise.repMax,
            targetLoad: exercise.targetLoad,
            targetLoadUnit: exercise.targetLoad == null ? null : "lb" as const,
            restSec: exercise.restSec,
            supersetGroup: exercise.supersetGroup,
            notes: exercise.notes,
            warmup: null,
            setNotes: exercise.setNotes,
          })),
        };
      }),
    };
    const noisyLibrary = [
      {
        id: "30000000-0000-4000-8000-000000000001",
        name: "Barbell Romanian Deadlift",
      },
      {
        id: "30000000-0000-4000-8000-000000000002",
        name: "Wide-Grip Lat Pulldown",
      },
      ...library,
    ] as ExerciseDiscoveryItem[];
    const proposal = buildProgramUpdateProposal({
      current,
      candidate,
      library: noisyLibrary,
      sourceText: BA_ROUTINE_CHANGE_REQUEST,
      mode: "update",
      createId,
    });
    expect(proposal.changes.map((change) => change.summary)).toEqual(
      expect.arrayContaining([
        "Change Barbell Bench Press: 4 sets, 5–8 reps",
        "Change Barbell Back Squat: 4 sets, 5–8 reps",
        "Change Romanian Deadlift: 3 sets, 8–10 reps",
        "Change Lat Pulldown: 3 sets, 10–15 reps",
      ]),
    );
    expect(proposal.changes.filter((change) => change.category === "decision")).toEqual([]);
    const accepted = new Set(
      proposal.changes
        .filter((change) => change.acceptedByDefault)
        .map((change) => change.id),
    );
    const published = applyProgramUpdateChanges(current, proposal.changes, accepted);
    const exerciseByName = (dayIndex: number, name: string) =>
      published.days[dayIndex]?.exercises.find(
        (slot) => library.find((item) => item.id === slot.exerciseId)?.name === name,
      );
    expect(exerciseByName(0, "Barbell Bench Press")).toMatchObject({ sets: 4, repMin: 5, repMax: 8 });
    expect(exerciseByName(1, "Barbell Back Squat")).toMatchObject({ sets: 4, repMin: 5, repMax: 8 });
    expect(exerciseByName(1, "Romanian Deadlift")).toMatchObject({ sets: 3, repMin: 8, repMax: 10 });
    expect(exerciseByName(2, "Lat Pulldown")).toMatchObject({ sets: 3, repMin: 10, repMax: 15 });
    const day1FacePull = published.days[0]?.exercises.find(
      (slot) => library.find((item) => item.id === slot.exerciseId)?.name === "Cable Face Pull",
    );
    expect(day1FacePull?.intent).toMatchObject({
      minimumDose: { unit: "sets", value: 1 },
      idealDose: { unit: "sets", value: 2 },
      omissionPolicy: "if_minimum_met",
    });
    expect(exerciseByName(0, "EZ-Bar Curl")).toBeUndefined();
    expect(exerciseByName(1, "Dumbbell Curl")).toBeUndefined();
    expect(exerciseByName(2, "Triceps Pushdown")).toBeUndefined();
    expect(
      published.days.map((day) =>
        day.exercises.map((slot) => {
          const exercise = library.find((item) => item.id === slot.exerciseId);
          return {
            name: exercise?.name,
            sets: slot.sets,
            repMin: slot.repMin,
            repMax: slot.repMax,
            grouped: slot.supersetKey != null,
          };
        }),
      ),
    ).toEqual([
      [
        { name: "Barbell Bench Press", sets: 4, repMin: 5, repMax: 8, grouped: false },
        { name: "Incline Dumbbell Curl", sets: 3, repMin: 8, repMax: 12, grouped: false },
        { name: "Bulgarian Split Squat", sets: 2, repMin: 8, repMax: 10, grouped: false },
        { name: "Cable Face Pull", sets: 2, repMin: 15, repMax: 20, grouped: false },
      ],
      [
        { name: "Barbell Back Squat", sets: 4, repMin: 5, repMax: 8, grouped: false },
        { name: "Romanian Deadlift", sets: 3, repMin: 8, repMax: 10, grouped: false },
        { name: "Cable Rear Delt Fly", sets: 2, repMin: 12, repMax: 15, grouped: true },
        { name: "Zottman Curl", sets: 2, repMin: 10, repMax: 12, grouped: true },
        { name: "Overhead Cable Triceps Extension", sets: 2, repMin: 10, repMax: 15, grouped: true },
      ],
      [
        { name: "Lat Pulldown", sets: 3, repMin: 10, repMax: 15, grouped: false },
        { name: "Incline Barbell Bench Press", sets: 3, repMin: 8, repMax: 12, grouped: false },
        { name: "Barbell Overhead Press", sets: 3, repMin: 6, repMax: 10, grouped: false },
        { name: "Overhead Cable Triceps Extension", sets: 3, repMin: 10, repMax: 15, grouped: true },
        { name: "EZ-Bar Curl", sets: 3, repMin: 10, repMax: 15, grouped: true },
        { name: "Dumbbell Lateral Raise", sets: 2, repMin: 15, repMax: 25, grouped: false },
      ],
    ]);
    expect(published.days[1]?.supersets).toHaveLength(1);
    expect(published.days[2]?.supersets).toHaveLength(1);
  });
});
