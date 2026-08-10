import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  completedSets,
  exercises,
  sessionExercises,
  sessionOccurrenceMutations,
  sessionOccurrences,
} from "@/db/schema";
import { logWorkoutSet } from "@/services/session-lifecycle";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  recordT01SupportedSets,
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

describe("V2 T01 truthful performed measurement", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  it("writes supported performed shapes without collapsing prescription, identity, units, or provenance", async () => {
    const saved = await recordT01SupportedSets(database.db, fixture);
    const rows = await database.db
      .select()
      .from(completedSets)
      .where(inArray(
        completedSets.id,
        Object.values(saved).map((result) => result.setId),
      ));
    const byClientKey = new Map(rows.map((row) => [row.clientKey, row]));

    expect(byClientKey.get("v2-t01-loaded")).toMatchObject({
      metricType: "weight_reps",
      weight: 100,
      weightUnit: "kg",
      reps: 5,
      distanceKm: null,
      durationSeconds: null,
      performedSemanticsVersion: 1,
      performedLoadType: "dumbbell",
      performedLoadSemantics: "total",
      targetMet: null,
      observedCompletionProvenance: "live_client",
      observedCompletionQuality: "trustworthy",
    });
    expect(byClientKey.get("v2-t01-bodyweight-substitution")).toMatchObject({
      metricType: "reps",
      weight: null,
      weightUnit: null,
      reps: 8,
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight",
      targetMet: null,
    });
    expect(byClientKey.get("v2-t01-assisted")).toMatchObject({
      metricType: "assisted_reps",
      weight: 25,
      weightUnit: "kg",
      reps: 6,
      performedLoadSemantics: "assistance",
      targetMet: null,
    });
    expect(byClientKey.get("v2-t01-duration")).toMatchObject({
      metricType: "duration",
      weight: null,
      weightUnit: null,
      reps: null,
      distanceKm: null,
      durationSeconds: 45,
      targetMet: null,
    });
    expect(byClientKey.get("v2-t01-distance")).toMatchObject({
      metricType: "distance_duration",
      weight: null,
      weightUnit: null,
      reps: null,
      distanceKm: 1.2,
      durationSeconds: 600,
      targetMet: null,
    });
    expect(rows.every((row) => row.observedCompletedAt != null)).toBe(true);

    const substitution = await database.db.query.sessionExercises.findFirst({
      where: eq(
        sessionExercises.id,
        fixture.sessionExerciseIds.bodyweightSubstitution,
      ),
    });
    const substitutionOccurrence = await database.db.query.sessionOccurrences.findFirst({
      where: eq(
        sessionOccurrences.id,
        saved.bodyweightSubstitution.occurrenceId,
      ),
    });
    expect(substitution).toMatchObject({
      exerciseId: fixture.exerciseIds.bodyweightSubstitution,
      substitutedForExerciseId: fixture.exerciseIds.plannedSubstitution,
      modificationType: "substituted",
    });
    expect(substitutionOccurrence).toMatchObject({
      plannedExerciseId: fixture.exerciseIds.plannedSubstitution,
      completedSetId: saved.bodyweightSubstitution.setId,
      outcome: "completed",
    });

    expect(
      await database.db
        .select()
        .from(sessionOccurrenceMutations)
        .where(inArray(
          sessionOccurrenceMutations.occurrenceId,
          Object.values(saved).map((result) => result.occurrenceId),
        )),
    ).toHaveLength(5);
  });

  it("reconciles an exact lost acknowledgement from the saved snapshot after catalog meaning changes", async () => {
    const first = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.loaded,
    );
    expect(first).toMatchObject({ outcome: "saved" });

    await database.db
      .update(exercises)
      .set({ loadSemantics: "per_implement" })
      .where(eq(exercises.id, fixture.exerciseIds.loaded));

    await expect(logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.loaded,
    )).resolves.toEqual(first);
    await expect(logWorkoutSet(
      database.db,
      fixture.userId,
      { ...fixture.commands.loaded, reps: 4 },
    )).resolves.toEqual({ outcome: "retry_identity_conflict" });

    const durable = await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, "setId" in first ? first.setId : ""),
    });
    expect(durable).toMatchObject({
      performedLoadSemantics: "total",
      weight: 100,
      weightUnit: "kg",
      reps: 5,
    });
  });
});
