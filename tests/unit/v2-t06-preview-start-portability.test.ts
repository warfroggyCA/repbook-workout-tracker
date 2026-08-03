import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import { exercises, sessionExercises, workoutSessions } from "@/db/schema";
import { buildTrainingDigest } from "@/services/digest";
import { getHistoryReport } from "@/services/history-report";
import { buildSetsCsv } from "@/services/export";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import { captureUserSnapshot, SNAPSHOT_SCHEMA_VERSION } from "@/services/snapshot-capture";
import { startWorkoutSession } from "@/services/session-lifecycle";
import { createMigratedTestDatabase, type TestDatabase } from "../helpers/database";
import { logWorkoutSet } from "../helpers/log-workout-set";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";
import { seedT06PreviewStart } from "../helpers/v2-t06-preview-start";

describe("Repbook v2 T06 Start portability", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("preserves Start and prescribed meaning in snapshot, CSV, digest, and integrity checks", async () => {
    const fixture = await seedT06PreviewStart(database.db);
    const startRequestKey = crypto.randomUUID();
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
      40,
      { startRequestKey, timezone: "America/Toronto" },
    );
    const sessionExercise = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, started.sessionId),
    });
    if (!sessionExercise) throw new Error("T06 workout exercise is missing.");
    await logWorkoutSet(database.db, fixture.userId, {
      sessionExerciseId: sessionExercise.id,
      setNo: 1,
      weight: 30,
      weightUnit: "lb",
      reps: 9,
      clientKey: "t06-portable-set",
    });
    await database.db
      .update(workoutSessions)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(workoutSessions.id, started.sessionId));

    const captured = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-02T18:00:00.000Z"),
      "v2-t06-portability",
    );
    expect(SNAPSHOT_SCHEMA_VERSION).toBe("28");
    expect(captured.schemaVersion).toBe("28");
    expect(
      (captured.tables.workout_sessions as Array<Record<string, unknown>>)
        .find((row) => row.id === started.sessionId),
    ).toMatchObject({
      start_request_key: startRequestKey,
      start_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(
      (captured.tables.session_exercises as Array<Record<string, unknown>>)
        .find((row) => row.id === sessionExercise.id),
    ).toMatchObject({
      prescribed_semantics_version: 1,
      prescribed_exercise_name: fixture.exerciseName,
      prescribed_metric_type: "weight_reps",
      prescribed_load_type: "dumbbell",
      prescribed_load_semantics: "per_implement",
    });

    const csv = parse(await buildSetsCsv(database.db, fixture.userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    expect(csv).toContainEqual(expect.objectContaining({
      start_request_key: startRequestKey,
      start_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      prescribed_semantics_version: "1",
      prescribed_exercise_name: fixture.exerciseName,
      prescribed_metric_type: "weight_reps",
      prescribed_load_type: "dumbbell",
      prescribed_load_semantics: "per_implement",
    }));

    await database.db
      .update(exercises)
      .set({
        name: `Changed catalog ${crypto.randomUUID()}`,
        metricType: "reps",
        loadType: "bodyweight",
        loadSemantics: "bodyweight",
      })
      .where(eq(exercises.id, fixture.exerciseId));
    const digest = await buildTrainingDigest(
      database.db,
      fixture.userId,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    const digestSession = digest.sessions.find(
      (session) => session.template === "T06 portable day",
    );
    expect(digestSession?.exercises[0]).toMatchObject({
      name: fixture.exerciseName,
    });
    expect(
      (await evaluateApplicationIntegrity(database.db, fixture.userId)).filter(
        (finding) =>
          finding.checkKey === "workout_session.start_request_identity" ||
          finding.checkKey === "session_exercise.prescribed_semantics",
      ),
    ).toEqual([]);
  });

  it("contains schema-27 meaning gaps while retaining complete performed-v1 facts", async () => {
    const fixture = await seedT06PreviewStart(database.db);
    await database.db
      .update(exercises)
      .set({
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
      })
      .where(eq(exercises.id, fixture.exerciseId));
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
      40,
      {
        startRequestKey: crypto.randomUUID(),
        timezone: "America/Toronto",
      },
    );
    const sessionExercise = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, started.sessionId),
    });
    if (!sessionExercise) throw new Error("T06 legacy exercise is missing.");
    const equipmentSnapshotId = await createTotalSystemTestSnapshot(
      database.db,
      {
        userId: fixture.userId,
        sessionId: started.sessionId,
        sessionExerciseId: sessionExercise.id,
        unit: "lb",
        selectAsCurrent: true,
      },
    );
    await expect(logWorkoutSet(database.db, fixture.userId, {
      sessionExerciseId: sessionExercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: crypto.randomUUID(),
      equipmentSnapshotId,
      loadEntryMeaning: "total_system",
    })).resolves.toMatchObject({ outcome: "saved" });
    await database.db
      .update(workoutSessions)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(workoutSessions.id, started.sessionId));

    await database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SET LOCAL workout_tracker.authorized_delete = 'snapshot_restore'`,
      );
      await tx.execute(sql`
        UPDATE session_exercises
        SET prescribed_semantics_version = NULL,
            prescribed_exercise_name = NULL,
            prescribed_metric_type = NULL,
            prescribed_load_type = NULL,
            prescribed_load_semantics = NULL
        WHERE id = ${sessionExercise.id}::uuid
      `);
    });
    const currentCatalogName = `Current assisted label ${crypto.randomUUID()}`;
    await database.db
      .update(exercises)
      .set({
        name: currentCatalogName,
        metricType: "assisted_reps",
        loadType: "external",
        loadSemantics: "assistance",
      })
      .where(eq(exercises.id, fixture.exerciseId));

    const [performedHistory, performedDigest] = await Promise.all([
      getHistoryReport(database.db, fixture.userId, "all", 3),
      buildTrainingDigest(
        database.db,
        fixture.userId,
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      ),
    ]);
    expect(performedHistory.overview).toMatchObject({
      workingSets: 1,
      totalReps: 8,
      loadedVolume: 800,
      targetHitRate: null,
      excludedMetricSets: 0,
      semanticExclusions: [],
    });
    expect(performedDigest.trends).toEqual([
      expect.objectContaining({
        exercise: currentCatalogName,
        topSets: [expect.stringContaining("100 lb×8")],
      }),
    ]);
    expect(performedDigest.sessions[0]?.exercises[0]).toMatchObject({
      target: null,
      sets: expect.stringContaining("100 lb"),
    });
    expect(performedDigest.dataGaps).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no retained prescribed baseline"),
      ]),
    );

  });
});
