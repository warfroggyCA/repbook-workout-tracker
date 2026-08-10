import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import { eq } from "drizzle-orm";
import { externalExerciseMappings } from "@/db/schema";
import { buildSetsCsv } from "@/services/export";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedV2H02CadenceTargetsTime,
  type V2H02CadenceFixture,
} from "../helpers/v2-h02-cadence-targets-time";
import {
  addV2H03OwnedExerciseAndMappingEvidence,
  V2_H03_IDS,
  V2_H03_NORMALIZED_KEY,
} from "../helpers/v2-h03-exercise-evidence";

describe("V2 H03 evidence portability", () => {
  let database: TestDatabase;
  let fixture: V2H02CadenceFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedV2H02CadenceTargetsTime(database.db);
  }, 30_000);
  afterEach(async () => database.close());

  it("exports exact identity, scope, tier, link status, and algorithm provenance", async () => {
    const rows = parse(await buildSetsCsv(database.db, fixture.userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    expect(rows).toContainEqual(
      expect.objectContaining({
        exercise_id: fixture.exerciseId,
        exercise_scope: "shared",
        exercise_evidence_tier: "native",
        exercise_history_algorithm_version: "exercise-history-v1",
        exact_occurrence_linked: "true",
      }),
    );
  });

  it("exports frozen source occurrence evidence separately from the reviewed owner mapping", async () => {
    await addV2H03OwnedExerciseAndMappingEvidence(database.db, fixture);
    const rows = parse(await buildSetsCsv(database.db, fixture.userId, null), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    const imported = rows.find(
      (row) => row.exercise_id === V2_H03_IDS.importExercise,
    );
    expect(
      rows.filter((row) => row.exercise_id === V2_H03_IDS.importExercise),
    ).toHaveLength(2);
    expect(imported).toMatchObject({
      exercise_scope: "import_created",
      exercise_evidence_tier: "imported",
      exact_occurrence_linked: "true",
      source_exercise_key: "h03-source-occurrence-1",
    });
    const mapping = JSON.parse(imported!.source_mapping_context_json);
    expect(mapping).toMatchObject({
      status: "confirmed",
      frozenSourceOccurrence: {
        key: "h03-source-occurrence-1",
        name: "H03 Imported Press",
      },
      reviewedMapping: {
        id: V2_H03_IDS.ownerMapping,
        source: "hevy",
        normalizedKey: V2_H03_NORMALIZED_KEY,
        exerciseId: V2_H03_IDS.importExercise,
      },
    });
    expect(JSON.stringify(rows)).not.toContain(V2_H03_IDS.otherOwnerMapping);
    expect(JSON.stringify(rows)).not.toContain(V2_H03_IDS.shadowOwnerMapping);

    await database.db
      .update(externalExerciseMappings)
      .set({ exerciseId: V2_H03_IDS.ownerExercise })
      .where(eq(externalExerciseMappings.id, V2_H03_IDS.ownerMapping));
    const inconsistentRows = parse(
      await buildSetsCsv(database.db, fixture.userId, null),
      { columns: true, skip_empty_lines: true },
    ) as Array<Record<string, string>>;
    const inconsistent = inconsistentRows.find(
      (row) => row.exercise_id === V2_H03_IDS.importExercise,
    );
    expect(inconsistent?.exercise_evidence_tier).toBe("unsupported");
    expect(
      JSON.parse(inconsistent!.source_mapping_context_json).status,
    ).toBe("inconsistent");
  });
});
