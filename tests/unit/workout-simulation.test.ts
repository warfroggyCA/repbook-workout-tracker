import { describe, expect, it } from "vitest";
import {
  addSimulationFeedback,
  advanceSimulationRest,
  completeSimulationSet,
  completeSimulationOccurrence,
  correctSimulationSet,
  createSimulationWorkspace,
  finishSimulationWorkout,
  flagSimulationPain,
  noteSimulationExercise,
  noteSimulationOccurrence,
  restoreSimulationOccurrence,
  selectSimulationEquipment,
  skipSimulationOccurrence,
  skipSimulationRest,
  startSimulationWorkout,
  substituteSimulationExercise,
  undoSimulationSubstitution,
  type SimulationSourceSnapshot,
} from "@/lib/workout-simulation";
import { logSetSchema, painSchema } from "@/lib/session-action-validation";
import { continueSimulationRest } from "@/lib/workout-simulation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function source(): SimulationSourceSnapshot {
  return {
    schemaVersion: 1,
    ownerId: "20000000-0000-4000-8000-000000000001",
    program: { id: "program", versionId: "version", versionNo: 4, name: "Published Program" },
    sourceDigest: "digest",
    capturedAtISO: "2026-07-22T12:00:00.000Z",
    unit: "lb",
    days: [
      {
        id: "day-1", name: "Day 1", orderIdx: 0,
        warmups: [{ id: "day-warmup", label: "Five easy minutes", orderIdx: 0, note: null }],
        groups: [{ id: "tri", name: "Tri-set", orderIdx: 0, plannedRounds: 2, restBetweenMembersSec: 15, restBetweenRoundsSec: 60 }],
        exercises: [
          {
            id: "bench-slot", exerciseId: "bench", name: "Bench Press", orderIdx: 0,
            groupId: null, groupMemberOrderIdx: null, sets: 2, repsMin: 5, repsMax: 8,
            targetLoad: 115, targetLoadUnit: "lb", restSec: 90, note: null,
            warmups: [{ id: "bench-warmup", label: "Ramp bench", orderIdx: 0, note: null }],
            alternatives: [{ exerciseId: "incline", name: "Incline Press", loadType: "barbell" }],
            equipmentOptions: [{ key: "bench-bar", label: "Olympic bar", guidance: "45 lb bar" }],
            painGuidance: ["Stop if shoulder pain increases."], loadType: "barbell",
          },
          {
            id: "rear-slot", exerciseId: "rear", name: "Rear Delt Fly", orderIdx: 1,
            groupId: "tri", groupMemberOrderIdx: 0, sets: 2, repsMin: 15, repsMax: 20,
            targetLoad: 15, targetLoadUnit: "lb", restSec: 15, note: null,
            warmups: [], alternatives: [], equipmentOptions: [], painGuidance: [], loadType: "cable",
          },
          {
            id: "curl-slot", exerciseId: "curl", name: "Zottman Curl", orderIdx: 2,
            groupId: "tri", groupMemberOrderIdx: 1, sets: 2, repsMin: 10, repsMax: 12,
            targetLoad: 20, targetLoadUnit: "lb", restSec: 15, note: null,
            warmups: [], alternatives: [], equipmentOptions: [], painGuidance: [], loadType: "dumbbell",
          },
          {
            id: "triceps-slot", exerciseId: "triceps", name: "Overhead Triceps Extension", orderIdx: 3,
            groupId: "tri", groupMemberOrderIdx: 2, sets: 2, repsMin: 10, repsMax: 15,
            targetLoad: 25, targetLoadUnit: "lb", restSec: 60, note: null,
            warmups: [], alternatives: [], equipmentOptions: [], painGuidance: [], loadType: "cable",
          },
        ],
      },
      {
        id: "day-2", name: "Day 2", orderIdx: 1, warmups: [], groups: [],
        exercises: [{
          id: "ez-slot", exerciseId: "ez", name: "EZ-Bar Curl", orderIdx: 0,
          groupId: null, groupMemberOrderIdx: null, sets: 1, repsMin: 10, repsMax: 15,
          targetLoad: 38, targetLoadUnit: "lb", restSec: 75, note: null,
          warmups: [], alternatives: [],
          equipmentOptions: [{ key: "ez-18", label: "18 lb EZ curl bar", guidance: "10 lb per side" }],
          painGuidance: [], loadType: "barbell",
        }],
      },
    ],
  };
}

function ids() {
  let value = 0;
  return () => String(++value);
}

describe("workout simulation local model", () => {
  it("uses unmistakable non-UUID identities and orders warm-ups, ordinary work, then group rounds", () => {
    const createId = ids();
    let workspace = createSimulationWorkspace(source(), { createId, nowISO: "2026-07-22T12:01:00.000Z" });
    expect(workspace.simulationId).toMatch(/^sim_workspace_/);
    expect(workspace.simulationId).not.toMatch(UUID);

    workspace = startSimulationWorkout(workspace, 0, { createId, nowISO: "2026-07-22T12:02:00.000Z" });
    const workout = workspace.activeWorkout!;
    expect(workout.groups).toEqual(source().days[0].groups);
    expect(workout.id).toMatch(/^sim_workout_/);
    expect(workout.occurrences.map((item) => item.kind)).toEqual([
      "day_warmup", "exercise_warmup", "working_set", "working_set",
      "working_set", "working_set", "working_set", "working_set", "working_set", "working_set",
    ]);
    expect(workout.occurrences.filter((item) => item.groupId === "tri").map((item) => [item.groupRound, item.groupMemberOrderIdx])).toEqual([
      [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2],
    ]);
    expect(workout.occurrences.every((item) => item.id.startsWith("sim_occurrence_") && !UUID.test(item.id))).toBe(true);
    workspace = completeSimulationOccurrence(workspace, workout.occurrences[0].id, "2026-07-22T12:02:30.000Z");
    expect(workspace.activeWorkout?.occurrences[0].outcome).toBe("completed");
  });

  it("supports local workout decisions, rest, feedback, finish, and the next consecutive day", () => {
    const createId = ids();
    let workspace = createSimulationWorkspace(source(), { createId, nowISO: "2026-07-22T12:01:00.000Z" });
    workspace = startSimulationWorkout(workspace, 0, { createId, nowISO: "2026-07-22T12:02:00.000Z" });
    const bench = workspace.activeWorkout!.exercises.find((item) => item.sourceSlotId === "bench-slot")!;
    const benchOccurrences = workspace.activeWorkout!.occurrences.filter((item) => item.simulationExerciseId === bench.id && item.kind === "working_set");

    workspace = noteSimulationOccurrence(workspace, benchOccurrences[0].id, "Pause cleanly.", "2026-07-22T12:03:00.000Z");
    workspace = noteSimulationExercise(workspace, bench.id, "Keep the simulated setup tidy.", "2026-07-22T12:03:30.000Z");
    expect(workspace.activeWorkout!.exercises.find((item) => item.id === bench.id)?.note).toBe("Keep the simulated setup tidy.");
    workspace = substituteSimulationExercise(workspace, bench.id, "incline", "variety", "2026-07-22T12:04:00.000Z");
    expect(workspace.activeWorkout!.exercises.find((item) => item.id === bench.id)?.actualName).toBe("Incline Press");
    workspace = undoSimulationSubstitution(workspace, bench.id, "2026-07-22T12:05:00.000Z");
    workspace = selectSimulationEquipment(workspace, bench.id, "bench-bar", "2026-07-22T12:05:30.000Z");
    expect(workspace.activeWorkout!.exercises.find((item) => item.id === bench.id)?.selectedEquipmentKey).toBe("bench-bar");
    workspace = flagSimulationPain(workspace, bench.id, "shoulder", 3, "2026-07-22T12:06:00.000Z");
    workspace = completeSimulationSet(workspace, benchOccurrences[0].id, {
      reps: 6, load: 115, loadUnit: "lb", rpe: 7, note: "Simulated only",
    }, { createId, nowISO: "2026-07-22T12:07:00.000Z" });
    expect(workspace.activeWorkout!.rest).toMatchObject({ phase: "running", plannedSeconds: 90 });
    workspace = advanceSimulationRest(workspace, 90, "2026-07-22T12:08:00.000Z");
    expect(workspace.activeWorkout!.rest?.phase).toBe("ready");
    workspace = skipSimulationRest(workspace, "2026-07-22T12:08:10.000Z");
    expect(workspace.activeWorkout!.rest?.phase).toBe("skipped");
    workspace = continueSimulationRest(workspace, "2026-07-22T12:08:20.000Z");
    expect(workspace.activeWorkout!.rest).toBeNull();

    const firstSetId = workspace.activeWorkout!.sets[0].id;
    workspace = correctSimulationSet(workspace, firstSetId, { reps: 7, note: "Corrected locally" }, "2026-07-22T12:09:00.000Z");
    expect(workspace.activeWorkout!.sets[0]).toMatchObject({ reps: 7, note: "Corrected locally", revision: 1 });

    workspace = skipSimulationOccurrence(workspace, benchOccurrences[1].id, "testing", "Skip scenario", "2026-07-22T12:10:00.000Z");
    expect(workspace.activeWorkout!.occurrences.find((item) => item.id === benchOccurrences[1].id)?.outcome).toBe("skipped");
    workspace = restoreSimulationOccurrence(workspace, benchOccurrences[1].id, "2026-07-22T12:11:00.000Z");
    expect(workspace.activeWorkout!.occurrences.find((item) => item.id === benchOccurrences[1].id)?.outcome).toBe("pending");

    workspace = addSimulationFeedback(workspace, {
      contextKind: "exercise", contextKey: bench.id, screenLabel: "Next set", note: "Check spacing",
    }, { createId, nowISO: "2026-07-22T12:12:00.000Z" });
    expect(workspace.feedback[0].id).toMatch(/^sim_feedback_/);

    workspace = finishSimulationWorkout(workspace, "2026-07-22T12:13:00.000Z");
    expect(workspace.activeWorkout).toBeNull();
    expect(workspace.completedWorkouts).toHaveLength(1);
    expect(workspace.selectedDayIndex).toBe(1);
    workspace = startSimulationWorkout(workspace, workspace.selectedDayIndex, { createId, nowISO: "2026-07-22T12:14:00.000Z" });
    expect(workspace.activeWorkout?.sourceDayId).toBe("day-2");
  });

  it("is rejected by the real set and pain mutation identity schemas", () => {
    const createId = ids();
    let workspace = createSimulationWorkspace(source(), { createId, nowISO: "2026-07-22T12:01:00.000Z" });
    workspace = startSimulationWorkout(workspace, 0, { createId, nowISO: "2026-07-22T12:02:00.000Z" });
    const exerciseId = workspace.activeWorkout!.exercises[0].id;

    expect(logSetSchema.safeParse({
      sessionExerciseId: exerciseId,
      setNo: 1,
      weight: null,
      weightUnit: null,
      reps: 8,
      clientKey: "simulation-only",
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown",
    }).success).toBe(false);
    expect(painSchema.safeParse({
      sessionExerciseId: exerciseId,
      bodyPart: "elbow",
      severity: 3,
    }).success).toBe(false);
  });
});
