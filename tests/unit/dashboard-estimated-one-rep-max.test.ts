import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  completedSets,
  exercises,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { estimateOneRepMax } from "@/lib/one-rep-max";
import { getDashboardStats } from "@/services/dashboard";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("dashboard estimated one-rep max boundary", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("includes 12 reps but excludes fake PRs at 13 and 15 reps", async () => {
    const [user] = await database.db
      .insert(users)
      .values({ email: `one-rep-max-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId: user.id,
      timezone: "UTC",
      unit: "lb",
    });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: `Boundary press ${crypto.randomUUID()}`,
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id, name: exercises.name });

    const sessions = await database.db
      .insert(workoutSessions)
      .values([
        {
          userId: user.id,
          templateName: "Prior",
          status: "completed" as const,
          startedAt: new Date("2026-07-16T12:00:00.000Z"),
          finishedAt: new Date("2026-07-16T13:00:00.000Z"),
          timezone: "UTC",
          localDate: "2026-07-16",
        },
        {
          userId: user.id,
          templateName: "Latest",
          status: "completed" as const,
          startedAt: new Date("2026-07-17T12:00:00.000Z"),
          finishedAt: new Date("2026-07-17T13:00:00.000Z"),
          timezone: "UTC",
          localDate: "2026-07-17",
        },
      ])
      .returning({ id: workoutSessions.id });
    const occurrences = await database.db
      .insert(sessionExercises)
      .values(
        sessions.map((session) => ({
          sessionId: session.id,
          exerciseId: exercise.id,
          orderIdx: 0,
        }))
      )
      .returning({ id: sessionExercises.id });
    const equipmentSnapshotIds = await Promise.all(
      occurrences.map((occurrence, index) =>
        createTotalSystemTestSnapshot(database.db, {
          userId: user.id,
          sessionId: sessions[index].id,
          sessionExerciseId: occurrence.id,
          unit: "lb",
        }),
      ),
    );
    const savedSets = await database.db.insert(completedSets).values([
      {
        sessionExerciseId: occurrences[0].id,
        setNo: 1,
        weight: 200,
        weightUnit: "lb",
        reps: 5,
        equipmentSnapshotId: equipmentSnapshotIds[0],
        loadEntryMeaning: "total_system",
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
      },
      {
        sessionExerciseId: occurrences[1].id,
        setNo: 1,
        weight: 170,
        weightUnit: "lb",
        reps: 15,
        equipmentSnapshotId: equipmentSnapshotIds[1],
        loadEntryMeaning: "total_system",
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
      },
      {
        sessionExerciseId: occurrences[1].id,
        setNo: 2,
        weight: 175,
        weightUnit: "lb",
        reps: 12,
        equipmentSnapshotId: equipmentSnapshotIds[1],
        loadEntryMeaning: "total_system",
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
      },
      {
        sessionExerciseId: occurrences[1].id,
        setNo: 3,
        weight: 190,
        weightUnit: "lb",
        reps: 13,
        equipmentSnapshotId: equipmentSnapshotIds[1],
        loadEntryMeaning: "total_system",
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
      },
    ]).returning({ id: completedSets.id, sessionExerciseId: completedSets.sessionExerciseId, setNo: completedSets.setNo });
    await database.db.insert(sessionOccurrences).values(
      savedSets.map((set, index) => ({
        sessionId: index === 0 ? sessions[0].id : sessions[1].id,
        sessionExerciseId: set.sessionExerciseId,
        kind: "working_set" as const,
        origin: "planned" as const,
        sequenceIdx: index === 0 ? 0 : index - 1,
        kindOrdinal: set.setNo - 1,
        plannedExerciseId: exercise.id,
        outcome: "completed" as const,
        resolvedAt: new Date("2026-07-17T13:00:00.000Z"),
        completedSetId: set.id,
        equipmentSnapshotId:
          index === 0 ? equipmentSnapshotIds[0] : equipmentSnapshotIds[1],
      }))
    );

    expect(170 * (1 + 15 / 30)).toBeGreaterThan(
      estimateOneRepMax(200, 5)!
    );
    await database.db
      .update(exercises)
      .set({
        loadType: "external",
        metricType: "assisted_reps",
        loadSemantics: "assistance",
      })
      .where(eq(exercises.id, exercise.id));
    const dashboard = await getDashboardStats(database.db, user.id);
    expect(dashboard.recentPRs).toEqual([
      {
        exercise: exercise.name,
        weight: 175,
        reps: 12,
        est1RM: 245,
      },
    ]);
    expect(dashboard.semanticExclusions).toEqual([]);
  });

  it("keeps assisted work out of volume and PR claims with a stable reason", async () => {
    const [user] = await database.db
      .insert(users)
      .values({ email: `assisted-dashboard-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId: user.id,
      timezone: "UTC",
      unit: "lb",
    });
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: `Assisted pull-up ${crypto.randomUUID()}`,
        movementPattern: "vertical_pull",
        primaryMuscles: ["back"],
        loadType: "machine",
        metricType: "assisted_reps",
        loadSemantics: "assistance",
      })
      .returning({ id: exercises.id });
    const sessions = await database.db
      .insert(workoutSessions)
      .values([
        {
          userId: user.id,
          templateName: "Prior assisted",
          status: "completed" as const,
          startedAt: new Date("2026-07-20T12:00:00.000Z"),
          finishedAt: new Date("2026-07-20T13:00:00.000Z"),
          timezone: "UTC",
          localDate: "2026-07-20",
        },
        {
          userId: user.id,
          templateName: "Latest assisted",
          status: "completed" as const,
          startedAt: new Date("2026-07-27T12:00:00.000Z"),
          finishedAt: new Date("2026-07-27T13:00:00.000Z"),
          timezone: "UTC",
          localDate: "2026-07-27",
        },
      ])
      .returning({ id: workoutSessions.id });
    const sessionExerciseRows = await database.db
      .insert(sessionExercises)
      .values(
        sessions.map((session) => ({
          sessionId: session.id,
          exerciseId: exercise.id,
          orderIdx: 0,
        })),
      )
      .returning({ id: sessionExercises.id });
    const assistanceSnapshotIds = await Promise.all(
      sessionExerciseRows.map((sessionExercise, index) =>
        createTotalSystemTestSnapshot(database.db, {
          userId: user.id,
          sessionId: sessions[index].id,
          sessionExerciseId: sessionExercise.id,
          unit: "lb",
          label: "Test assistance machine",
        }),
      ),
    );
    const savedSets = await database.db
      .insert(completedSets)
      .values(
        sessionExerciseRows.map((sessionExercise, index) => ({
          sessionExerciseId: sessionExercise.id,
          setNo: 1,
          weight: index === 0 ? 100 : 150,
          weightUnit: "lb" as const,
          reps: 10,
          metricType: "assisted_reps" as const,
          equipmentSnapshotId: assistanceSnapshotIds[index],
          loadEntryMeaning: "displayed_stack",
          targetMet: true,
        })),
      )
      .returning({
        id: completedSets.id,
        sessionExerciseId: completedSets.sessionExerciseId,
      });
    await database.db.insert(sessionOccurrences).values(
      savedSets.map((set, index) => ({
        sessionId: sessions[index].id,
        sessionExerciseId: set.sessionExerciseId,
        kind: "working_set" as const,
        origin: "planned" as const,
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exercise.id,
        outcome: "completed" as const,
        resolvedAt: new Date(
          index === 0
            ? "2026-07-20T13:00:00.000Z"
            : "2026-07-27T13:00:00.000Z",
        ),
        completedSetId: set.id,
        equipmentSnapshotId: assistanceSnapshotIds[index],
      })),
    );

    const dashboard = await getDashboardStats(database.db, user.id);
    expect(dashboard.weeklyVolume.every((point) => point.volume === 0)).toBe(
      true,
    );
    expect(dashboard.totalVolumeThisWeek).toBe(0);
    expect(dashboard.recentPRs).toEqual([]);
    expect(dashboard.semanticExclusions).toEqual([
      { reason: "assistance_not_comparable", count: 2 },
    ]);
  });
});
