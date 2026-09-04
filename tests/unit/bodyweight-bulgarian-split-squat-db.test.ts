import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { resultRows } from "@/db/result";
import {
  completedSets,
  exerciseAliases,
  exerciseEquipmentRequirements,
  exerciseFamilies,
  exercises,
  exerciseSources,
  recordVersions,
  sessionExercises,
  sessionOccurrences,
} from "@/db/schema";
import { buildJsonBackup } from "@/services/export";
import { getExerciseReplacementOptions } from "@/services/exercise-replacements";
import {
  restoreRecordVersion,
  updateSessionExerciseWithVersion,
} from "@/services/record-versions";
import { logWorkoutSet } from "../helpers/log-workout-set";
import {
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

async function applyCandidateMigration(database: TestDatabase) {
  const source = await readFile(
    "src/db/migrations/0069_bodyweight_bulgarian_split_squat.sql",
    "utf8",
  );
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.client.exec(statement);
  }
}

function snapshotRow(rows: unknown[], id: string) {
  return rows.find(
    (row): row is Record<string, unknown> =>
      row != null &&
      typeof row === "object" &&
      (row as Record<string, unknown>).id === id,
  );
}

describe("0069 bodyweight Bulgarian split-squat performed variant", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("adds the reviewed variant idempotently and preserves planned and historical evidence", async () => {
    database = await createTestDatabaseAtMigration(
      "0068_performed_semantics_expand",
    );
    const { db } = database;
    const userId = crypto.randomUUID();
    const loadedExerciseId = crypto.randomUUID();
    const historicalSessionId = crypto.randomUUID();
    const historicalSessionExerciseId = crypto.randomUUID();
    const historicalSetId = crypto.randomUUID();
    const activeSessionId = crypto.randomUUID();
    const activeSessionExerciseId = crypto.randomUUID();
    const workingOccurrenceId = crypto.randomUUID();

    await database.client.query(
      "INSERT INTO users (id, email) VALUES ($1, $2)",
      [userId, `bodyweight-bss-${crypto.randomUUID()}@example.test`],
    );
    const [family] = await db
      .insert(exerciseFamilies)
      .values({
        key: "bulgarian_split_squat",
        name: "Bulgarian Split Squat",
        movementPattern: "lunge",
        primaryMuscles: ["quads", "glutes"],
      })
      .returning();
    await db.insert(exercises).values({
      id: loadedExerciseId,
      familyId: family.id,
      name: "Bulgarian Split Squat",
      movementPattern: "lunge",
      primaryMuscles: ["quads", "glutes"],
      isUnilateral: true,
      loadType: "dumbbell",
      metricType: "weight_reps",
      loadSemantics: "per_implement",
      variantKey: "bulgarian_split_squat",
      variantAttributes: { laterality: "unilateral" },
      catalogReviewed: true,
    });
    // This fixture intentionally starts at 0068. Limit setup SQL to columns
    // that existed at that boundary instead of letting the latest ORM emit
    // fields introduced by later migrations.
    await db.execute(sql`
      INSERT INTO workout_sessions (
        id, user_id, template_name, status, started_at, finished_at,
        timezone, local_date
      ) VALUES
        (
          ${historicalSessionId}::uuid, ${userId}::uuid, 'Historical evidence',
          'completed', ${new Date("2026-07-28T14:00:00.000Z")},
          ${new Date("2026-07-28T15:00:00.000Z")}, 'America/Toronto',
          '2026-07-28'
        ),
        (
          ${activeSessionId}::uuid, ${userId}::uuid, 'Bodyweight substitution',
          'in_progress', ${new Date("2026-07-29T14:00:00.000Z")}, NULL,
          'America/Toronto', '2026-07-29'
        )
    `);
    await db.execute(sql`
      INSERT INTO session_exercises (
        id, session_id, exercise_id, order_idx, target_sets,
        target_reps_min, target_reps_max, target_load, target_load_unit,
        notes, warmup_notes, set_notes
      ) VALUES
        (
          ${historicalSessionExerciseId}::uuid, ${historicalSessionId}::uuid,
          ${loadedExerciseId}::uuid, 0, 1, 8, 12, 25, 'lb', NULL, NULL,
          '[]'::jsonb
        ),
        (
          ${activeSessionExerciseId}::uuid, ${activeSessionId}::uuid,
          ${loadedExerciseId}::uuid, 0, 1, 8, 12, 25, 'lb',
          'Loaded Program cue', 'Loaded warm-up cue',
          '["Loaded set cue"]'::jsonb
        )
    `);
    await db.execute(sql`
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit, reps,
        metric_type, performed_semantics_version, performed_load_type,
        performed_load_semantics
      ) VALUES (
        ${historicalSetId}::uuid, ${historicalSessionExerciseId}::uuid,
        1, 25, 'lb', 10, 'weight_reps', 1, 'dumbbell', 'per_implement'
      )
    `);
    await db.execute(sql`
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, planned_reps_min, planned_reps_max,
        planned_load, planned_load_unit, outcome
      ) VALUES (
        ${workingOccurrenceId}::uuid, ${activeSessionId}::uuid,
        ${activeSessionExerciseId}::uuid, 'working_set', 'planned', 0, 0,
        ${loadedExerciseId}::uuid, 8, 12, 25, 'lb', 'pending'
      )
    `);

    const [historicalBefore] = resultRows(
      await db.execute(sql`
        SELECT
          to_jsonb(session_exercise) AS session_exercise,
          to_jsonb(completed_set) AS completed_set
        FROM session_exercises session_exercise
        JOIN completed_sets completed_set
          ON completed_set.session_exercise_id = session_exercise.id
        WHERE completed_set.id = ${historicalSetId}::uuid
      `),
    );

    await applyCandidateMigration(database);
    await applyCandidateMigration(database);

    const bodyweight = await db.query.exercises.findFirst({
      where: eq(exercises.name, "Bodyweight Bulgarian Split Squat"),
      with: {
        family: true,
        aliases: true,
        equipmentRequirements: true,
        sources: true,
      },
    });
    expect(bodyweight).toMatchObject({
      familyId: family.id,
      name: "Bodyweight Bulgarian Split Squat",
      movementPattern: "lunge",
      primaryMuscles: ["quads", "glutes"],
      isUnilateral: true,
      loadType: "bodyweight",
      activityClass: "strength",
      metricType: "reps",
      loadSemantics: "bodyweight",
      variantKey: "bodyweight",
      variantAttributes: {
        laterality: "unilateral",
        assistance: "none",
      },
      catalogReviewed: true,
      family: {
        key: "bulgarian_split_squat",
        name: "Bulgarian Split Squat",
      },
    });
    expect(
      bodyweight?.aliases.map(({ alias }) => alias).sort(),
    ).toEqual([
      "bodyweight bss",
      "bodyweight rear foot elevated split squat",
      "bulgarian split squat bodyweight",
    ]);
    expect(
      bodyweight?.equipmentRequirements
        .map(({ equipmentType }) => equipmentType)
        .sort(),
    ).toEqual(["bench", "bodyweight"]);
    expect(bodyweight?.sources).toHaveLength(1);
    expect(bodyweight?.sources[0]).toMatchObject({
      sourceName: "Workout Tracker curated catalog",
      sourceId: "bodyweight_bulgarian_split_squat",
      license: "Project-authored metadata",
    });
    await expect(
      db.select().from(exerciseAliases).where(
        eq(exerciseAliases.exerciseId, bodyweight!.id),
      ),
    ).resolves.toHaveLength(3);
    await expect(
      db.select().from(exerciseEquipmentRequirements).where(
        eq(exerciseEquipmentRequirements.exerciseId, bodyweight!.id),
      ),
    ).resolves.toHaveLength(2);
    await expect(
      db.select().from(exerciseSources).where(
        eq(exerciseSources.exerciseId, bodyweight!.id),
      ),
    ).resolves.toHaveLength(1);

    const [historicalAfter] = resultRows(
      await db.execute(sql`
        SELECT
          to_jsonb(session_exercise) AS session_exercise,
          to_jsonb(completed_set) AS completed_set
        FROM session_exercises session_exercise
        JOIN completed_sets completed_set
          ON completed_set.session_exercise_id = session_exercise.id
        WHERE completed_set.id = ${historicalSetId}::uuid
      `),
    );
    expect(historicalAfter).toEqual(historicalBefore);

    // The 0069 result is now proven. Bring the same preserved rows through
    // the remaining additive migrations before exercising current services.
    await migrateTestDatabaseThrough(
      database,
      "0084_restore_finish_command_receipts",
    );

    const options = await getExerciseReplacementOptions(
      db,
      userId,
      activeSessionExerciseId,
    );
    expect(options).toMatchObject({
      currentExerciseId: loadedExerciseId,
      plannedExerciseId: loadedExerciseId,
      plannedExerciseName: "Bulgarian Split Squat",
    });
    expect(
      options.items.find(({ id }) => id === bodyweight!.id),
    ).toMatchObject({
      name: "Bodyweight Bulgarian Split Squat",
      loadType: "bodyweight",
      metricType: "reps",
      loadSemantics: "bodyweight",
      available: false,
      missingEquipment: ["bench"],
    });
    expect(options.permittedIds).toContain(bodyweight!.id);
    expect(options.warnings[bodyweight!.id]).toMatch(/Needs bench/i);

    const firstVersionId = crypto.randomUUID();
    const firstSubstitution = await updateSessionExerciseWithVersion(
      db,
      userId,
      activeSessionExerciseId,
      {
        exerciseId: bodyweight!.id,
        modificationType: "substituted",
        skipReason: null,
        substitutedForExerciseId: loadedExerciseId,
        substitutionReason: "other",
        substitutedAt: new Date("2026-07-29T14:05:00.000Z"),
        targetLoad: null,
        targetLoadUnit: null,
        notes: null,
        warmupNotes: null,
        warmupSets: [],
        setNotes: [],
      },
      "session_exercise.substitute",
      {
        activeOnly: true,
        expectedExerciseId: loadedExerciseId,
        versionId: firstVersionId,
      },
    );
    expect(firstSubstitution).toMatchObject({
      ok: true,
      changed: true,
      versionId: firstVersionId,
    });
    const firstVersion = await db.query.recordVersions.findFirst({
      where: eq(recordVersions.id, firstVersionId),
    });
    expect(firstVersion?.beforeData).toMatchObject({
      exercise_id: loadedExerciseId,
      target_load: 25,
      target_load_unit: "lb",
      substituted_for_exercise_id: null,
    });
    expect(firstVersion?.afterData).toMatchObject({
      exercise_id: bodyweight!.id,
      target_load: null,
      target_load_unit: null,
      modification_type: "substituted",
      substituted_for_exercise_id: loadedExerciseId,
      substitution_reason: "other",
    });
    expect(
      await db.query.sessionOccurrences.findFirst({
        where: eq(sessionOccurrences.id, workingOccurrenceId),
      }),
    ).toMatchObject({
      plannedExerciseId: loadedExerciseId,
      plannedLoad: 25,
      plannedLoadUnit: "lb",
      outcome: "pending",
    });

    const restored = await restoreRecordVersion(
      db,
      userId,
      firstVersionId,
      {
        activeOnly: true,
        clientMutationId: crypto.randomUUID(),
      },
    );
    expect(restored).toMatchObject({ ok: true, changed: true });
    expect(
      await db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, activeSessionExerciseId),
      }),
    ).toMatchObject({
      exerciseId: loadedExerciseId,
      targetLoad: 25,
      targetLoadUnit: "lb",
      notes: "Loaded Program cue",
      warmupNotes: "Loaded warm-up cue",
      setNotes: ["Loaded set cue"],
      modificationType: "as_planned",
      substitutedForExerciseId: null,
    });

    const performedVersionId = crypto.randomUUID();
    const performedSubstitution = await updateSessionExerciseWithVersion(
      db,
      userId,
      activeSessionExerciseId,
      {
        exerciseId: bodyweight!.id,
        modificationType: "substituted",
        skipReason: null,
        substitutedForExerciseId: loadedExerciseId,
        substitutionReason: "other",
        substitutedAt: new Date("2026-07-29T14:06:00.000Z"),
        targetLoad: null,
        targetLoadUnit: null,
        notes: null,
        warmupNotes: null,
        warmupSets: [],
        setNotes: [],
      },
      "session_exercise.substitute",
      {
        activeOnly: true,
        expectedExerciseId: loadedExerciseId,
        versionId: performedVersionId,
      },
    );
    expect(performedSubstitution).toMatchObject({
      ok: true,
      changed: true,
      versionId: performedVersionId,
    });

    await expect(
      logWorkoutSet(db, userId, {
        sessionExerciseId: activeSessionExerciseId,
        setNo: 1,
        weight: 0,
        weightUnit: "lb",
        reps: 10,
        rpe: 8,
        isWarmup: false,
        clientKey: crypto.randomUUID(),
      }),
    ).resolves.toEqual({
      outcome: "unsupported_set_shape",
      metricType: "reps",
      reason: "reps_cannot_include_load",
    });
    await expect(
      db.query.completedSets.findFirst({
        where: eq(completedSets.sessionExerciseId, activeSessionExerciseId),
      }),
    ).resolves.toBeUndefined();

    await expect(
      logWorkoutSet(db, userId, {
        sessionExerciseId: activeSessionExerciseId,
        setNo: 1,
        weight: null,
        weightUnit: null,
        reps: 10,
        rpe: 8,
        isWarmup: false,
        note: "Performed without external load",
        clientKey: crypto.randomUUID(),
      }),
    ).resolves.toEqual({ outcome: "equipment_selection_required" });
    await expect(
      db.query.completedSets.findFirst({
        where: eq(completedSets.sessionExerciseId, activeSessionExerciseId),
      }),
    ).resolves.toBeUndefined();

    await database.client.query(
      `INSERT INTO equipment_items (id, user_id, type, label, available)
       VALUES ($1, $2, 'bench', 'Training bench', true)`,
      [crypto.randomUUID(), userId],
    );

    const saved = await logWorkoutSet(db, userId, {
      sessionExerciseId: activeSessionExerciseId,
      setNo: 1,
      weight: null,
      weightUnit: null,
      reps: 10,
      rpe: 8,
      isWarmup: false,
      note: "Performed without external load",
      clientKey: crypto.randomUUID(),
    });
    expect(saved).toMatchObject({ outcome: "saved" });
    const completed = await db.query.completedSets.findFirst({
      where: eq(completedSets.sessionExerciseId, activeSessionExerciseId),
    });
    expect(completed).toMatchObject({
      weight: null,
      weightUnit: null,
      reps: 10,
      metricType: "reps",
      targetMet: null,
      performedSemanticsVersion: 1,
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight",
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown",
    });
    expect(
      await db.query.sessionOccurrences.findFirst({
        where: eq(sessionOccurrences.id, workingOccurrenceId),
      }),
    ).toMatchObject({
      plannedExerciseId: loadedExerciseId,
      plannedLoad: 25,
      plannedLoadUnit: "lb",
      outcome: "completed",
      completedSetId: completed!.id,
    });

    const backup = await buildJsonBackup(
      db,
      userId,
      () => undefined,
      {
        now: new Date("2026-07-29T16:00:00.000Z"),
        appVersion: "bodyweight-bss-test",
      },
    );
    expect(
      snapshotRow(
        backup.canonical.tables.session_exercises,
        activeSessionExerciseId,
      ),
    ).toMatchObject({
      exercise_id: bodyweight!.id,
      substituted_for_exercise_id: loadedExerciseId,
      modification_type: "substituted",
      target_load: null,
      target_load_unit: null,
    });
    expect(
      snapshotRow(backup.canonical.tables.completed_sets, completed!.id),
    ).toMatchObject({
      weight: null,
      weight_unit: null,
      reps: 10,
      metric_type: "reps",
      performed_semantics_version: 1,
      performed_load_type: "bodyweight",
      performed_load_semantics: "bodyweight",
    });

    await expect(
      restoreRecordVersion(db, userId, performedVersionId, {
        activeOnly: true,
      }),
    ).resolves.toEqual({
      ok: false,
      reason:
        "The workout exercise structure or provenance has changed. Nothing was restored.",
    });
    expect(
      await db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, activeSessionExerciseId),
      }),
    ).toMatchObject({
      exerciseId: bodyweight!.id,
      substitutedForExerciseId: loadedExerciseId,
    });
  }, 60_000);
});
