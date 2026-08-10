// Intent suite: proves preview remains read-only while one explicit Start
// intent creates at most one owner-scoped workout with durable prescribed
// meaning, truthful collision outcomes, and replay before Program freshness.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { resultRows } from "@/db/result";
import {
  exercisePrescriptions,
  completedSets,
  exercises,
  programs,
  programVersions,
  sessionExercises,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import {
  buildWorkoutStartRequestHash,
  logWorkoutSet,
  StaleWorkoutTemplateError,
  startWorkoutSession,
} from "@/services/session-lifecycle";
import {
  createMigratedTestDatabase,
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  runSimultaneously,
  type TestDatabase,
} from "../helpers/database";

describe("Repbook v2 T06 preview and Start contract", () => {
  let database: TestDatabase;
  let userId: string;
  let programId: string;
  let templateId: string;
  let exerciseId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `t06-start-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId,
      timezone: "America/Toronto",
    });
    [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: `T06 prescribed press ${crypto.randomUUID()}`,
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "dumbbell",
        metricType: "weight_reps",
        loadSemantics: "per_implement",
      })
      .returning({ id: exercises.id });

    await database.db.transaction(async (tx) => {
      const [program] = await tx
        .insert(programs)
        .values({
          userId,
          name: "T06 Program",
          status: "archived",
          archivedAt: new Date(),
        })
        .returning({ id: programs.id });
      programId = program.id;
      const [version] = await tx
        .insert(programVersions)
        .values({ programId, activatedAt: new Date() })
        .returning({ id: programVersions.id });
      const [template] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: version.id,
          name: "T06 Preview Day",
        })
        .returning({ id: workoutTemplates.id });
      templateId = template.id;
      const [slot] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: templateId,
          exerciseId,
          orderIdx: 0,
        })
        .returning({ id: workoutTemplateExercises.id });
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: slot.id,
        sets: 2,
        repRangeMin: 8,
        repRangeMax: 10,
        targetLoad: 30,
        targetLoadUnit: "lb",
      });
      await tx
        .update(programs)
        .set({
          status: "active",
          archivedAt: null,
          currentVersionId: version.id,
        })
        .where(eq(programs.id, programId));
    });
  }, 30_000);

  afterEach(async () => database.close());

  it("creates once with canonical request identity and immutable prescribed meaning", async () => {
    const startRequestKey = crypto.randomUUID();
    const started = await startWorkoutSession(
      database.db,
      userId,
      templateId,
      45,
      {
        startRequestKey,
        timezone: "America/Vancouver",
        now: () => new Date("2026-11-01T08:30:00.000Z"),
      },
    );

    expect(started).toMatchObject({ outcome: "created", existing: false });
    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, started.sessionId),
    });
    expect(session).toMatchObject({
      startRequestKey,
      startRequestHash: buildWorkoutStartRequestHash({
        templateId,
        timezone: "America/Vancouver",
        timeBudgetMin: 45,
      }),
      timezone: "America/Vancouver",
      localDate: "2026-11-01",
      sourceProgramId: programId,
    });
    const [sessionExercise] = await database.db
      .select()
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    expect(sessionExercise).toMatchObject({
      prescribedSemanticsVersion: 1,
      prescribedExerciseName: expect.stringContaining("T06 prescribed press"),
      prescribedMetricType: "weight_reps",
      prescribedLoadType: "dumbbell",
      prescribedLoadSemantics: "per_implement",
    });

    await database.db
      .update(exercises)
      .set({
        name: `Catalog renamed ${crypto.randomUUID()}`,
        metricType: "reps",
        loadType: "bodyweight",
        loadSemantics: "bodyweight",
      })
      .where(eq(exercises.id, exerciseId));
    const unchanged = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, sessionExercise.id),
    });
    expect(unchanged).toMatchObject({
      prescribedExerciseName: sessionExercise.prescribedExerciseName,
      prescribedMetricType: "weight_reps",
      prescribedLoadType: "dumbbell",
      prescribedLoadSemantics: "per_implement",
    });
    const saved = await logWorkoutSet(database.db, userId, {
      sessionExerciseId: sessionExercise.id,
      performedExerciseId: exerciseId,
      performedSemanticsVersion: 1,
      performedLoadType: "dumbbell",
      performedLoadSemantics: "per_implement",
      metricType: "weight_reps",
      setNo: 1,
      weight: 30,
      weightUnit: "lb",
      reps: 9,
      distanceKm: null,
      durationSeconds: null,
      clientKey: crypto.randomUUID(),
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown",
    });
    expect(saved).toMatchObject({ outcome: "saved" });
    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.sessionExerciseId, sessionExercise.id),
      }),
    ).toMatchObject({
      metricType: "weight_reps",
      performedLoadType: "dumbbell",
      performedLoadSemantics: "per_implement",
      weight: 30,
      reps: 9,
    });
    await expect(logWorkoutSet(database.db, userId, {
      sessionExerciseId: sessionExercise.id,
      performedExerciseId: exerciseId,
      performedSemanticsVersion: 1,
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight",
      metricType: "reps",
      setNo: 2,
      weight: null,
      weightUnit: null,
      reps: 9,
      distanceKm: null,
      durationSeconds: null,
      clientKey: crypto.randomUUID(),
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown",
    })).resolves.toEqual({
      outcome: "performed_evidence_conflict",
      reason: "metric_changed",
    });
    await expect(
      database.db
        .update(sessionExercises)
        .set({ prescribedExerciseName: "Reinterpreted" })
        .where(eq(sessionExercises.id, sessionExercise.id)),
    ).rejects.toThrow();
  });

  it("replays the exact request before active or Program-freshness checks", async () => {
    const startRequestKey = crypto.randomUUID();
    const first = await startWorkoutSession(
      database.db,
      userId,
      templateId,
      undefined,
      { startRequestKey, timezone: "America/Toronto" },
    );
    await database.db
      .update(workoutSessions)
      .set({ status: "abandoned", finishedAt: new Date() })
      .where(eq(workoutSessions.id, first.sessionId));
    await database.db
      .update(programs)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(programs.id, programId));

    await expect(
      startWorkoutSession(database.db, userId, templateId, undefined, {
        startRequestKey,
        timezone: "America/Toronto",
      }),
    ).resolves.toEqual({
      outcome: "replayed",
      sessionId: first.sessionId,
      existing: true,
    });
    await expect(
      startWorkoutSession(database.db, userId, templateId, undefined, {
        startRequestKey: crypto.randomUUID(),
        timezone: "America/Toronto",
      }),
    ).rejects.toBeInstanceOf(StaleWorkoutTemplateError);
    expect(await database.db.select().from(workoutSessions)).toHaveLength(1);
  });

  it("refuses contradictory reuse and reports an unrelated active workout truthfully", async () => {
    const firstKey = crypto.randomUUID();
    const first = await startWorkoutSession(
      database.db,
      userId,
      templateId,
      undefined,
      { startRequestKey: firstKey, timezone: "America/Toronto" },
    );

    await expect(
      startWorkoutSession(database.db, userId, templateId, 30, {
        startRequestKey: firstKey,
        timezone: "America/Toronto",
      }),
    ).resolves.toEqual({
      outcome: "request_conflict",
      sessionId: first.sessionId,
      existing: true,
    });

    const otherKey = crypto.randomUUID();
    await expect(
      startWorkoutSession(database.db, userId, templateId, undefined, {
        startRequestKey: otherKey,
        timezone: "America/Toronto",
        now: () => new Date(Date.now() + 86_400_000),
      }),
    ).resolves.toEqual({
      outcome: "active_workout_exists",
      sessionId: first.sessionId,
      activeSessionId: first.sessionId,
      existing: true,
    });
    expect(await database.db.select().from(workoutSessions)).toHaveLength(1);
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.startRequestKey, otherKey),
      }),
    ).toBeUndefined();
  });

  it("converges simultaneous same-key and different-key delivery", async () => {
    const sameKey = crypto.randomUUID();
    const same = await runSimultaneously(6, () =>
      startWorkoutSession(database.db, userId, templateId, undefined, {
        startRequestKey: sameKey,
        timezone: "America/Toronto",
      }),
    );
    expect(same.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(new Set(same.map((result) => result.sessionId))).toHaveLength(1);

    await database.db
      .update(workoutSessions)
      .set({ status: "abandoned", finishedAt: new Date() })
      .where(eq(workoutSessions.id, same[0].sessionId));
    const different = await runSimultaneously(4, () =>
      startWorkoutSession(database.db, userId, templateId, undefined, {
        startRequestKey: crypto.randomUUID(),
        timezone: "America/Toronto",
      }),
    );
    expect(different.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(
      different.filter((result) => result.outcome === "active_workout_exists"),
    ).toHaveLength(3);
    const active = await database.db
      .select()
      .from(workoutSessions)
      .where(sql`${workoutSessions.status} = 'in_progress'`);
    expect(active).toHaveLength(1);
  });

  it("rejects malformed keyed Start inputs before any write", async () => {
    await expect(
      startWorkoutSession(database.db, userId, templateId, undefined, {
        startRequestKey: "not-a-uuid",
        timezone: "America/Toronto",
      }),
    ).rejects.toThrow(/valid Start request identity/i);
    await expect(
      startWorkoutSession(database.db, userId, templateId, undefined, {
        startRequestKey: crypto.randomUUID(),
        timezone: "Invalid/Timezone",
      }),
    ).rejects.toThrow(/valid Start request identity/i);
    expect(await database.db.select().from(workoutSessions)).toHaveLength(0);
  });
});

describe("Repbook v2 T06 migration boundary", () => {
  for (const base of [
    "0069_bodyweight_bulgarian_split_squat",
    "0071_warmup_occurrence_reversal",
  ]) {
    it(`adds explicit null unknowns to legacy rows from ${base}`, async () => {
      const database = await createTestDatabaseAtMigration(base);
      try {
        const userId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();
        const exerciseId = crypto.randomUUID();
        await database.db.execute(sql`
          INSERT INTO users (id, email)
          VALUES (${userId}::uuid, ${`t06-migration-${crypto.randomUUID()}@example.com`})
        `);
        await database.db.execute(sql`
          INSERT INTO exercises (
            id, name, movement_pattern, primary_muscles, secondary_muscles,
            load_type, metric_type, load_semantics
          ) VALUES (
            ${exerciseId}::uuid, ${`T06 migration exercise ${crypto.randomUUID()}`},
            'squat', '[]'::jsonb, '[]'::jsonb,
            'dumbbell', 'weight_reps', 'per_implement'
          )
        `);
        await database.db.execute(sql`
          INSERT INTO workout_sessions (
            id, user_id, status, started_at, timezone, local_date
          ) VALUES (
            ${sessionId}::uuid, ${userId}::uuid, 'completed',
            '2026-08-01T12:00:00.000Z'::timestamptz,
            'America/Toronto', '2026-08-01'::date
          )
        `);
        await database.db.execute(sql`
          INSERT INTO session_exercises (session_id, exercise_id, order_idx)
          VALUES (${sessionId}::uuid, ${exerciseId}::uuid, 0)
        `);

        await migrateTestDatabaseThrough(database, "0072_preview_start_semantics");
        const [workout] = resultRows(
          await database.db.execute(sql`
            SELECT
              start_request_key AS "startRequestKey",
              start_request_hash AS "startRequestHash"
            FROM workout_sessions
            WHERE id = ${sessionId}::uuid
          `),
        );
        const [exercise] = resultRows(
          await database.db.execute(sql`
            SELECT
              prescribed_semantics_version AS "prescribedSemanticsVersion",
              prescribed_exercise_name AS "prescribedExerciseName",
              prescribed_metric_type AS "prescribedMetricType",
              prescribed_load_type AS "prescribedLoadType",
              prescribed_load_semantics AS "prescribedLoadSemantics"
            FROM session_exercises
            WHERE session_id = ${sessionId}::uuid
          `),
        );
        expect(workout).toMatchObject({
          startRequestKey: null,
          startRequestHash: null,
        });
        expect(exercise).toMatchObject({
          prescribedSemanticsVersion: null,
          prescribedExerciseName: null,
          prescribedMetricType: null,
          prescribedLoadType: null,
          prescribedLoadSemantics: null,
        });
      } finally {
        await database.close();
      }
    }, 30_000);
  }
});
