import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  completedSets,
  externalExerciseMappings,
  sessionExercises,
  sessionOccurrences,
} from "@/db/schema";
import { getHistoryReport } from "@/services/history-report";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedV2H02CadenceTargetsTime,
  V2_H02_NOW,
  type V2H02CadenceFixture,
} from "../helpers/v2-h02-cadence-targets-time";
import {
  addV2H03OwnedExerciseAndMappingEvidence,
  V2_H03_CONFIRMED_AT,
  V2_H03_IDS,
  V2_H03_NORMALIZED_KEY,
} from "../helpers/v2-h03-exercise-evidence";

describe("V2 H03 exact exercise evidence", () => {
  let database: TestDatabase;
  let fixture: V2H02CadenceFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedV2H02CadenceTargetsTime(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("retains an unlinked fact but removes it from exercise calculations", async () => {
    await database.db.execute(sql`
      WITH authorized AS (
        SELECT set_config('workout_tracker.authorized_delete', 'permanent', true)
      )
      DELETE FROM session_occurrences occurrence
      USING authorized
      WHERE occurrence.completed_set_id = ${fixture.setIds.below}::uuid
    `);

    const report = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    const exercise = report.exerciseEvidence.find(
      (entry) => entry.exerciseId === fixture.exerciseId,
    );
    expect(exercise).toMatchObject({
      scope: "shared",
      retainedSets: 6,
      exactLinkedSets: 5,
    });
    expect(exercise?.evidence).toContainEqual(
      expect.objectContaining({
        setId: fixture.setIds.below,
        tier: "legacy",
        exactLinked: false,
      }),
    );
    expect(report.overview.workingSets).toBe(5);
    expect(report.exerciseProgress[0]?.sets).toBe(5);
  });

  it("labels an unsupported performed metric without inventing a derived claim", async () => {
    const sourceSet = await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, fixture.setIds.at),
      columns: { sessionExerciseId: true },
    });
    if (!sourceSet) throw new Error("H03 source set missing");
    const sourceExercise = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, sourceSet.sessionExerciseId),
      columns: { sessionId: true },
    });
    if (!sourceExercise) throw new Error("H03 source exercise missing");
    const unsupportedSetId = crypto.randomUUID();
    await database.db.insert(completedSets).values({
      id: unsupportedSetId,
      sessionExerciseId: sourceSet.sessionExerciseId,
      setNo: 99,
      durationSeconds: 60,
      metricType: "duration",
      performedSemanticsVersion: 1,
      performedLoadType: "cardio",
      performedLoadSemantics: "none",
    });
    await database.db.insert(sessionOccurrences).values({
      sessionId: sourceExercise.sessionId,
      sessionExerciseId: sourceSet.sessionExerciseId,
      kind: "working_set",
      origin: "ad_hoc",
      sequenceIdx: 99,
      kindOrdinal: 99,
      plannedExerciseId: fixture.exerciseId,
      outcome: "completed",
      resolvedAt: new Date("2026-07-22T16:00:00.000Z"),
      completedSetId: unsupportedSetId,
    });
    const report = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    expect(
      report.exerciseEvidence
        .flatMap((exercise) => exercise.evidence)
        .find((entry) => entry.setId === unsupportedSetId),
    ).toMatchObject({ tier: "unsupported", exactLinked: true });
  });

  it("uses only the owner's confirmed source mapping and fails closed when it is stale or missing", async () => {
    await addV2H03OwnedExerciseAndMappingEvidence(database.db, fixture);

    const confirmed = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    expect(
      confirmed.exerciseEvidence.find(
        (entry) => entry.exerciseId === V2_H03_IDS.ownerExercise,
      )?.scope,
    ).toBe("owner_created");
    const imported = confirmed.exerciseEvidence.find(
      (entry) => entry.exerciseId === V2_H03_IDS.importExercise,
    );
    expect(imported).toMatchObject({
      scope: "import_created",
      retainedSets: 2,
      exactLinkedSets: 2,
      calculationEligibleSets: 2,
      reviewedMappings: [
        {
          id: V2_H03_IDS.ownerMapping,
          source: "hevy",
          normalizedKey: V2_H03_NORMALIZED_KEY,
          exerciseId: V2_H03_IDS.importExercise,
          confirmedAtISO: V2_H03_CONFIRMED_AT.toISOString(),
        },
      ],
    });
    expect(imported?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tier: "imported",
          exactLinked: true,
          calculationEligible: true,
          mappingStatus: "confirmed",
          reviewedMapping: expect.objectContaining({
            id: V2_H03_IDS.ownerMapping,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(confirmed)).not.toContain("Other owner private press");
    expect(JSON.stringify(confirmed)).not.toContain(
      V2_H03_IDS.otherOwnerMapping,
    );
    expect(JSON.stringify(confirmed)).not.toContain(
      V2_H03_IDS.shadowOwnerMapping,
    );

    await database.db
      .update(externalExerciseMappings)
      .set({ exerciseId: V2_H03_IDS.ownerExercise })
      .where(eq(externalExerciseMappings.id, V2_H03_IDS.ownerMapping));
    const inconsistent = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    const inconsistentImport = inconsistent.exerciseEvidence.find(
      (entry) => entry.exerciseId === V2_H03_IDS.importExercise,
    );
    expect(inconsistentImport).toMatchObject({ calculationEligibleSets: 0 });
    expect(inconsistentImport?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tier: "unsupported",
          mappingStatus: "inconsistent",
          calculationEligible: false,
        }),
      ]),
    );
    expect(
      inconsistent.exerciseProgress.some(
        (entry) => entry.exerciseId === V2_H03_IDS.importExercise,
      ),
    ).toBe(false);

    await database.db
      .update(externalExerciseMappings)
      .set({
        exerciseId: V2_H03_IDS.importExercise,
        normalizedKey: "moved-canonical-key",
      })
      .where(eq(externalExerciseMappings.id, V2_H03_IDS.ownerMapping));
    const missing = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    const missingImport = missing.exerciseEvidence.find(
      (entry) => entry.exerciseId === V2_H03_IDS.importExercise,
    );
    expect(missingImport).toMatchObject({
      calculationEligibleSets: 0,
      reviewedMappings: [],
    });
    expect(missingImport?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tier: "legacy",
          mappingStatus: "missing",
          reviewedMapping: null,
          calculationEligible: false,
        }),
      ]),
    );
  });
});
