import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import {
  completedSets,
  exercises,
  sessionExercises,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import {
  buildLiveCoachingContext,
  startLiveCoachTurn,
} from "@/services/live-coaching";
import { logWorkoutPain } from "@/services/session-lifecycle";

const historyFixture = vi.hoisted(() => ({
  userId: "00000000-0000-4000-8000-000000000101",
  sessionId: "00000000-0000-4000-8000-000000000102",
  plannedExerciseId: "00000000-0000-4000-8000-000000000103",
  performedExerciseId: "00000000-0000-4000-8000-000000000104",
  occurrenceId: "00000000-0000-4000-8000-000000000105",
  performedSetId: "00000000-0000-4000-8000-000000000106",
  plannedName: "Barbell Bench Press",
  performedName: "Neutral-Grip Dumbbell Press",
  setNote: "Stable shoulder path after the swap.",
  importedWarmupNote: "Imported warm-up result must not count.",
  skippedResultNote: "Skipped working result must not appear.",
  abandonedResultNote: "Abandoned working result must not appear.",
  unlinkedResultNote: "Unlinked working result must not appear.",
  painNote: "Sharp at the bottom before changing movements.",
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/lib/user", () => ({
  getCurrentUser: vi.fn(async () => ({ id: historyFixture.userId })),
}));
vi.mock("@/services/archive", () => ({
  getWorkoutArchivePreview: vi.fn(async () => ({
    sets: 1,
    notes: 0,
    painLogs: 1,
    fatigueLogs: 0,
    coachingMessages: 0,
    recommendations: 0,
  })),
}));
vi.mock("@/services/live-coaching", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/live-coaching")>();
  return {
    ...actual,
    listLiveCoachMessages: vi.fn(async () => []),
  };
});
vi.mock("@/services/history-page", () => ({
  getCompletedHistoryContextualNotes: vi.fn(async () => []),
}));
vi.mock("@/components/history/workout-archive-button", () => ({
  WorkoutArchiveButton: () => null,
}));
vi.mock("@/components/history/live-coach-history", () => ({
  LiveCoachHistory: () => null,
}));
vi.mock("@/components/history/completed-set-correction", () => ({
  CompletedSetCorrection: () => null,
}));
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const session = {
    id: historyFixture.sessionId,
    userId: historyFixture.userId,
    templateName: "Pain-sensitive workout",
    source: "tracker",
    status: "completed",
    historyRevision: 0,
    performedTimePrecision: "instant",
    timezone: "America/Toronto",
    localDate: "2026-07-21",
    startedAt: new Date("2026-07-21T14:00:00.000Z"),
    finishedAt: new Date("2026-07-21T14:30:00.000Z"),
    excludeDurationFromAnalytics: false,
    dayWarmupNotes: null,
    exercises: [
      {
        id: historyFixture.occurrenceId,
        exerciseId: historyFixture.performedExerciseId,
        exercise: { id: historyFixture.performedExerciseId, name: historyFixture.performedName },
        sourceExerciseName: null,
        modificationType: "substituted",
        skipReason: null,
        substitutionReason: "discomfort",
        substitutedForExerciseId: historyFixture.plannedExerciseId,
        targetSets: 1,
        targetRepsMin: 8,
        targetRepsMax: 10,
        targetLoad: 40,
        targetLoadUnit: "lb",
        warmupNotes: null,
        warmupSets: [],
        notes: null,
        sets: [
          {
            id: historyFixture.performedSetId,
            setNo: 1,
            weight: 40,
            weightUnit: "lb",
            reps: 10,
            distanceKm: null,
            durationSeconds: null,
            metricType: "reps",
            isWarmup: false,
            rpe: 7,
            targetMet: true,
            note: historyFixture.setNote,
          },
          {
            id: "00000000-0000-4000-8000-000000000108",
            setNo: 2,
            weight: 20,
            weightUnit: "lb",
            reps: 10,
            distanceKm: null,
            durationSeconds: null,
            metricType: "reps",
            isWarmup: true,
            rpe: null,
            targetMet: true,
            note: historyFixture.importedWarmupNote,
          },
          {
            id: "00000000-0000-4000-8000-000000000109",
            setNo: 3,
            weight: 40,
            weightUnit: "lb",
            reps: 10,
            distanceKm: null,
            durationSeconds: null,
            metricType: "reps",
            isWarmup: false,
            rpe: null,
            targetMet: true,
            note: historyFixture.skippedResultNote,
          },
          {
            id: "00000000-0000-4000-8000-000000000110",
            setNo: 4,
            weight: 40,
            weightUnit: "lb",
            reps: 10,
            distanceKm: null,
            durationSeconds: null,
            metricType: "reps",
            isWarmup: false,
            rpe: null,
            targetMet: true,
            note: historyFixture.abandonedResultNote,
          },
          {
            id: "00000000-0000-4000-8000-000000000111",
            setNo: 5,
            weight: 40,
            weightUnit: "lb",
            reps: 10,
            distanceKm: null,
            durationSeconds: null,
            metricType: "reps",
            isWarmup: false,
            rpe: null,
            targetMet: true,
            note: historyFixture.unlinkedResultNote,
          },
        ],
      },
    ],
    painLogs: [
      {
        id: "00000000-0000-4000-8000-000000000107",
        exerciseId: historyFixture.performedExerciseId,
        bodyPart: "shoulder",
        severity: 5,
        note: historyFixture.painNote,
      },
    ],
    notes: [],
    occurrences: [
      {
        id: "00000000-0000-4000-8000-000000000112",
        kind: "exercise_warmup",
        origin: "imported",
        sequenceIdx: 0,
        kindOrdinal: 0,
        label: "Hevy warm-up",
        plannedExerciseId: historyFixture.performedExerciseId,
        plannedRepsMin: 10,
        plannedRepsMax: 10,
        plannedLoad: 20,
        plannedLoadUnit: "lb",
        plannedLoadPercent: null,
        plannedLoadText: null,
        plannedRestSec: null,
        plannedNote: null,
        groupSnapshotId: null,
        groupRound: null,
        groupMemberOrderIdx: null,
        outcome: "completed",
        outcomeReason: null,
        outcomeNote: "Imported warm-up preserved",
        completedSetId: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000113",
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 1,
        kindOrdinal: 0,
        label: null,
        plannedExerciseId: historyFixture.performedExerciseId,
        plannedRepsMin: 8,
        plannedRepsMax: 10,
        plannedLoad: 40,
        plannedLoadUnit: "lb",
        plannedLoadPercent: null,
        plannedLoadText: null,
        plannedRestSec: 90,
        plannedNote: null,
        groupSnapshotId: null,
        groupRound: null,
        groupMemberOrderIdx: null,
        outcome: "completed",
        outcomeReason: null,
        outcomeNote: null,
        completedSetId: historyFixture.performedSetId,
      },
      {
        id: "00000000-0000-4000-8000-000000000114",
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 2,
        kindOrdinal: 1,
        label: null,
        plannedExerciseId: historyFixture.performedExerciseId,
        plannedRepsMin: 8,
        plannedRepsMax: 10,
        plannedLoad: 40,
        plannedLoadUnit: "lb",
        plannedLoadPercent: null,
        plannedLoadText: null,
        plannedRestSec: 90,
        plannedNote: null,
        groupSnapshotId: null,
        groupRound: null,
        groupMemberOrderIdx: null,
        outcome: "skipped",
        outcomeReason: "pain",
        outcomeNote: null,
        completedSetId: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000115",
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 3,
        kindOrdinal: 2,
        label: null,
        plannedExerciseId: historyFixture.performedExerciseId,
        plannedRepsMin: 8,
        plannedRepsMax: 10,
        plannedLoad: 40,
        plannedLoadUnit: "lb",
        plannedLoadPercent: null,
        plannedLoadText: null,
        plannedRestSec: 90,
        plannedNote: null,
        groupSnapshotId: null,
        groupRound: null,
        groupMemberOrderIdx: null,
        outcome: "abandoned",
        outcomeReason: null,
        outcomeNote: null,
        completedSetId: null,
      },
    ],
  };
  const fakeDb = {
    query: {
      workoutSessions: { findFirst: vi.fn(async () => session) },
      exercises: {
        findMany: vi.fn(async () => [
          { id: historyFixture.plannedExerciseId, name: historyFixture.plannedName },
        ]),
      },
      recommendations: { findMany: vi.fn(async () => []) },
      recordVersions: { findMany: vi.fn(async () => []) },
    },
  };
  return { ...actual, getDb: vi.fn(async () => fakeDb) };
});

import SessionDetailPage from "@/app/(main)/history/[id]/page";

describe("LIVE-03 deterministic safety ownership", () => {
  it("keeps severity-five stop and seek-help guidance in the workout UI", () => {
    const source = readFileSync(
      new URL("../../src/components/session/exercise-card.tsx", import.meta.url),
      "utf8"
    );

    expect(source).toContain("severity >= 5");
    expect(source).toContain("Stop this movement today.");
    expect(source).toContain("professional opinion, not a workaround");
    expect(source).not.toMatch(/getAIProvider[\s\S]{0,300}Stop this movement today/);
  });
});

describe("LIVE-03 Coach context continuity", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let sessionId: string;
  let occurrenceId: string;
  let plannedName: string;
  let performedName: string;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });

    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `live03-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(userProfiles).values({ userId });

    plannedName = `Planned press ${crypto.randomUUID()}`;
    performedName = `Performed press ${crypto.randomUUID()}`;
    const [planned, performed] = await db
      .insert(exercises)
      .values([
        {
          name: plannedName,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          secondaryMuscles: ["triceps"],
          loadType: "barbell",
        },
        {
          name: performedName,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          secondaryMuscles: ["triceps"],
          loadType: "dumbbell",
        },
      ])
      .returning({ id: exercises.id });

    [{ id: sessionId }] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "LIVE-03 classification",
        status: "in_progress",
        startedAt: new Date("2026-07-21T14:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-21",
      })
      .returning({ id: workoutSessions.id });
    [{ id: occurrenceId }] = await db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId: performed.id,
        orderIdx: 0,
        targetSets: 1,
        targetRepsMin: 8,
        targetRepsMax: 10,
        targetLoad: 40,
        targetLoadUnit: "lb",
        restSec: 90,
        modificationType: "substituted",
        substitutedForExerciseId: planned.id,
        substitutionReason: "discomfort",
        substitutedAt: new Date("2026-07-21T14:05:00.000Z"),
      })
      .returning({ id: sessionExercises.id });
    await db.insert(completedSets).values({
      sessionExerciseId: occurrenceId,
      setNo: 1,
      weight: 40,
      weightUnit: "lb",
      reps: 10,
      rpe: 7,
      note: "Stable shoulder path after the swap.",
      targetMet: true,
    });
    await logWorkoutPain(db as Db, userId, {
      sessionExerciseId: occurrenceId,
      bodyPart: "shoulder",
      severity: 5,
      note: "Sharp at the bottom before changing movements.",
    });
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("names performed and planned exercises, reason, and pain identity in Coach context", async () => {
    const turn = await startLiveCoachTurn(db as Db, userId, {
      sessionId,
      sessionExerciseId: occurrenceId,
      completedSetId: null,
      messageKind: "question",
      inputMode: "text",
      content: "What should I do after this pain-sensitive substitution?",
      clientKey: crypto.randomUUID(),
    });
    const context = await buildLiveCoachingContext(
      db as Db,
      userId,
      {
        aggressiveness: "conservative",
        deloadSuggestions: true,
        substitutionSuggestions: true,
        weeklyReview: false,
      },
      turn.pendingResponse!.id,
      null
    );

    expect(context.liveWorkout.selectedExercise).toMatchObject({
      name: performedName,
      plannedExercise: plannedName,
      substitutionReason: "discomfort",
    });
    const painFlag = context.liveWorkout.painFlags.find(
      (entry) => entry.bodyPart === "shoulder" && entry.severity === 5
    );
    expect(painFlag).toBeDefined();
    expect(JSON.stringify(painFlag)).toContain(performedName);
  });
});

describe("LIVE-03 History reconstruction", () => {
  it("names the pain-associated exercise alongside planned/performed lineage and notes", async () => {
    const page = await SessionDetailPage({
      params: Promise.resolve({ id: historyFixture.sessionId }),
      searchParams: Promise.resolve({}),
    } as never);
    const html = renderToStaticMarkup(page);

    expect(html).toContain(historyFixture.plannedName);
    expect(html).toContain(historyFixture.performedName);
    expect(html).toContain("alternative · discomfort");
    expect(html).toContain(historyFixture.setNote);
    expect(html).toContain(historyFixture.painNote);
    expect(html).toMatch(
      new RegExp(
        `Pain flags[\\s\\S]*${historyFixture.performedName}[\\s\\S]*shoulder 5/10`
      )
    );
  });

  it("counts and lists only linked completed working-set results", async () => {
    const page = await SessionDetailPage({
      params: Promise.resolve({ id: historyFixture.sessionId }),
      searchParams: Promise.resolve({}),
    } as never);
    const html = renderToStaticMarkup(page);

    expect(html).toContain("30 min · 1 sets");
    expect(html).not.toContain("at target");
    expect(html).toContain(
      "Comparable load calculation unavailable because required measurements are missing.",
    );
    expect(html).toContain(historyFixture.setNote);
    expect(html).not.toContain(historyFixture.importedWarmupNote);
    expect(html).not.toContain(historyFixture.skippedResultNote);
    expect(html).not.toContain(historyFixture.abandonedResultNote);
    expect(html).not.toContain(historyFixture.unlinkedResultNote);
    expect(html).toContain("Hevy warm-up");
    expect(html).toContain("Imported warm-up preserved");
    expect(html).toContain("skipped");
    expect(html).toContain("not completed before finish");
  });
});
