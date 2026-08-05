import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { hevyMappingKey } from "@/services/exercise-map";
import {
  exercises,
  externalExerciseMappings,
  importEvents,
  sessionExercises,
  workoutSessions,
} from "@/db/schema";
import type { V2H02CadenceFixture } from "./v2-h02-cadence-targets-time";

export const V2_H03_IDS = {
  importEvent: "00000000-0000-4000-8000-000000000700",
  ownerExercise: "00000000-0000-4000-8000-000000000701",
  importExercise: "00000000-0000-4000-8000-000000000702",
  otherOwnerExercise: "00000000-0000-4000-8000-000000000703",
  ownerMapping: "00000000-0000-4000-8000-000000000704",
  otherOwnerMapping: "00000000-0000-4000-8000-000000000705",
  shadowOwnerMapping: "00000000-0000-4000-8000-000000000706",
  correctionVersion: "00000000-0000-4000-8000-000000000707",
} as const;

export const V2_H03_SOURCE_NAME = "H03 Imported Press";
export const V2_H03_NORMALIZED_KEY = hevyMappingKey(V2_H03_SOURCE_NAME);
export const V2_H03_CONFIRMED_AT = new Date("2026-07-26T12:00:00.000Z");

export async function addV2H03OwnedExerciseAndMappingEvidence(
  db: Db,
  fixture: V2H02CadenceFixture,
) {
  await db.insert(importEvents).values({
    id: V2_H03_IDS.importEvent,
    userId: fixture.userId,
    source: "csv",
    rawPayload: "synthetic H03 import provenance",
    payloadSha256: "h03-import-provenance",
    parsedPayload: {},
    confirmedPayload: { schemaVersion: "1", resolutions: [] },
    status: "confirmed",
    rawRedactedAt: V2_H03_CONFIRMED_AT,
  });
  await db.insert(exercises).values([
    {
      id: V2_H03_IDS.ownerExercise,
      userId: fixture.userId,
      name: "H03 Owner Press",
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "barbell",
      metricType: "weight_reps",
      loadSemantics: "total",
    },
    {
      id: V2_H03_IDS.importExercise,
      userId: fixture.userId,
      createdFromImportEventId: V2_H03_IDS.importEvent,
      name: "H03 Imported Press",
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "barbell",
      metricType: "weight_reps",
      loadSemantics: "total",
    },
    {
      id: V2_H03_IDS.otherOwnerExercise,
      userId: fixture.otherUserId,
      name: "Other owner private press",
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "barbell",
      metricType: "weight_reps",
      loadSemantics: "total",
    },
  ]);

  const importedSessionExercises = await db.query.sessionExercises.findMany({
    where: eq(sessionExercises.sessionId, fixture.sessionIds.dateOnly),
    columns: { id: true },
  });
  const ownerSessionExercises = await db.query.sessionExercises.findMany({
    where: eq(sessionExercises.sessionId, fixture.sessionIds.renamed),
    columns: { id: true },
  });
  const importedIds = importedSessionExercises.map((entry) => entry.id);
  const ownerIds = ownerSessionExercises.map((entry) => entry.id);
  await db
    .update(workoutSessions)
    .set({ source: "hevy" })
    .where(eq(workoutSessions.id, fixture.sessionIds.dateOnly));
  await db
    .update(sessionExercises)
    .set({
      exerciseId: V2_H03_IDS.importExercise,
      sourceExerciseKey: "h03-source-occurrence-1",
      sourceExerciseName: V2_H03_SOURCE_NAME,
      modificationType: "substituted",
      substitutedForExerciseId: fixture.exerciseId,
      substitutionReason: "other",
    })
    .where(inArray(sessionExercises.id, importedIds));
  await db
    .update(sessionExercises)
    .set({
      exerciseId: V2_H03_IDS.ownerExercise,
      modificationType: "substituted",
      substitutedForExerciseId: fixture.exerciseId,
      substitutionReason: "other",
    })
    .where(inArray(sessionExercises.id, ownerIds));

  await db.insert(externalExerciseMappings).values([
    {
      id: V2_H03_IDS.ownerMapping,
      userId: fixture.userId,
      source: "hevy",
      sourceName: V2_H03_SOURCE_NAME,
      sourceEquipment: "barbell",
      normalizedKey: V2_H03_NORMALIZED_KEY,
      exerciseId: V2_H03_IDS.importExercise,
      confirmedAt: V2_H03_CONFIRMED_AT,
    },
    {
      id: V2_H03_IDS.otherOwnerMapping,
      userId: fixture.otherUserId,
      source: "hevy",
      sourceName: V2_H03_SOURCE_NAME,
      sourceEquipment: "barbell",
      normalizedKey: V2_H03_NORMALIZED_KEY,
      exerciseId: V2_H03_IDS.otherOwnerExercise,
      confirmedAt: new Date("2026-07-27T12:00:00.000Z"),
    },
    {
      id: V2_H03_IDS.shadowOwnerMapping,
      userId: fixture.userId,
      source: "hevy",
      sourceName: V2_H03_SOURCE_NAME,
      sourceEquipment: "barbell",
      normalizedKey: "noncanonical-shadow-key",
      exerciseId: V2_H03_IDS.ownerExercise,
      confirmedAt: new Date("2026-07-28T12:00:00.000Z"),
    },
  ]);
}
