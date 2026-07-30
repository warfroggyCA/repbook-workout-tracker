import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import {
  auditLogs,
  completedSets,
  externalExerciseMappings,
  exerciseEquipmentRequirements,
  exercises,
  importEvents,
  sessionOccurrences,
  users,
} from "@/db/schema";
import {
  buildHevyExerciseReviews,
  HEVY_HEADERS,
  parseHevyCsv,
  type StagedHevyPayload,
} from "@/services/hevy-import";
import {
  hevyResolutionSchema,
  persistHevyImport,
} from "@/services/hevy-import-persist";

function csvRow(values: Array<string | number>) {
  return values
    .map((value) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    })
    .join(",");
}

describe("Hevy import persistence", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  it("refuses custom exercise definitions with contradictory assistance semantics", () => {
    const baseExercise = {
      name: "Contradictory assistance",
      familyId: crypto.randomUUID(),
      movementPattern: "vertical_pull" as const,
      primaryMuscles: ["back"],
      secondaryMuscles: [],
      isUnilateral: false,
      loadType: "external" as const,
      equipment: ["machine"] as const,
      activityClass: "strength" as const,
      promoteToMainLibrary: false,
    };
    expect(
      hevyResolutionSchema.safeParse({
        key: "bad-reps-assistance",
        action: "create",
        exercise: {
          ...baseExercise,
          metricType: "reps",
          loadSemantics: "assistance",
        },
      }).success,
    ).toBe(false);
    expect(
      hevyResolutionSchema.safeParse({
        key: "bad-assisted-total",
        action: "create",
        exercise: {
          ...baseExercise,
          metricType: "assisted_reps",
          loadSemantics: "total",
        },
      }).success,
    ).toBe(false);
    expect(
      hevyResolutionSchema.safeParse({
        key: "valid-assisted",
        action: "create",
        exercise: {
          ...baseExercise,
          metricType: "assisted_reps",
          loadSemantics: "assistance",
        },
      }).success,
    ).toBe(true);
  });

  it("commits the final review decisions and audit with the imported batch", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `hevy-persist-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id, email: users.email });
    const [exercise] = await db
      .insert(exercises)
      .values({
        name: "Bench Press (Barbell)",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    await db.insert(exerciseEquipmentRequirements).values({
      exerciseId: exercise.id,
      equipmentType: "barbell",
    });

    const csv = [
      HEVY_HEADERS.join(","),
      csvRow([
        "Strength A",
        "Jun 1, 2026, 6:00 PM",
        "Jun 1, 2026, 7:00 PM",
        "Known good",
        "Bench Press (Barbell)",
        "",
        "Paused",
        0,
        "warmup",
        95,
        10,
        "",
        "",
        6,
      ]),
      csvRow([
        "Strength A",
        "Jun 1, 2026, 6:00 PM",
        "Jun 1, 2026, 7:00 PM",
        "Known good",
        "Bench Press (Barbell)",
        "",
        "Paused",
        1,
        "normal",
        135,
        8,
        "",
        "",
        8,
      ]),
    ].join("\n");
    const parsed = parseHevyCsv(csv, "America/Toronto");
    const reviews = await buildHevyExerciseReviews(db, user.id, parsed);
    const staged: StagedHevyPayload = {
      kind: "hevy_history",
      schemaVersion: "1",
      originalFilename: "reviewed-hevy.csv",
      fileHash: parsed.fileHash,
      timezone: parsed.timezone,
      profile: parsed.profile,
      exercises: reviews,
    };
    const [event] = await db
      .insert(importEvents)
      .values({
        userId: user.id,
        source: "csv",
        rawPayload: csv,
        parsedPayload: staged,
        status: "parsed",
      })
      .returning({ id: importEvents.id });
    const resolution = {
      key: parsed.exercises[0].key,
      action: "match" as const,
      exerciseId: exercise.id,
    };

    const result = await persistHevyImport(db, user, {
      importEventId: event.id,
      resolutions: [resolution],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    const [storedEvent, audits] = await Promise.all([
      db.query.importEvents.findFirst({
        where: (table, { eq }) => eq(table.id, event.id),
      }),
      db.query.auditLogs.findMany({
        where: (table, { eq }) => eq(table.entityId, result.batchId),
      }),
    ]);
    expect(storedEvent).toMatchObject({
      status: "confirmed",
      rawPayload: "",
      parsedPayload: null,
      confirmedPayload: {
        schemaVersion: "1",
        resolutions: [resolution],
      },
    });
    expect(storedEvent?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(storedEvent?.rawRedactedAt).toBeInstanceOf(Date);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "history_import.confirm",
      entityType: "history_import_batch",
    });
    expect(await db.select().from(auditLogs)).toHaveLength(1);

    const storedSets = await db.query.completedSets.findMany({
      orderBy: completedSets.setNo,
    });
    expect(storedSets).toEqual([
      expect.objectContaining({
        isWarmup: true,
        weight: 95,
        reps: 10,
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
        observedCompletedAt: null,
        observedCompletionProvenance: "unknown",
        observedCompletionQuality: "unknown",
      }),
      expect.objectContaining({
        isWarmup: false,
        weight: 135,
        reps: 8,
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
        observedCompletedAt: null,
        observedCompletionProvenance: "unknown",
        observedCompletionQuality: "unknown",
      }),
    ]);
    expect(await db.query.sessionOccurrences.findMany()).toEqual([
      expect.objectContaining({
        origin: "imported",
        kind: "working_set",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exercise.id,
        outcome: "completed",
        completedSetId: storedSets[1].id,
      }),
    ]);

    expect(
      await persistHevyImport(db, user, {
        importEventId: event.id,
        resolutions: [resolution],
      })
    ).toEqual({ ok: false, reason: "This Hevy import was already confirmed." });
    expect(await db.select().from(sessionOccurrences)).toHaveLength(1);
    expect(await db.select().from(completedSets)).toHaveLength(2);

    const [originalMapping] = await db.query.externalExerciseMappings.findMany();
    expect(originalMapping).toMatchObject({ exerciseId: exercise.id });
    expect(await db.query.recordVersions.findMany()).toHaveLength(0);

    const [alternate] = await db
      .insert(exercises)
      .values({
        name: `Reviewed Bench Press Alternate ${crypto.randomUUID()}`,
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    await db.insert(exerciseEquipmentRequirements).values({
      exerciseId: alternate.id,
      equipmentType: "barbell",
    });
    const revisedCsv = [
      HEVY_HEADERS.join(","),
      csvRow([
        "Strength B",
        "Jun 3, 2026, 6:00 PM",
        "Jun 3, 2026, 7:00 PM",
        "Reviewed again",
        "Bench Press (Barbell)",
        "",
        "Paused",
        0,
        "normal",
        140,
        8,
        "",
        "",
        8,
      ]),
    ].join("\n");
    const revisedParsed = parseHevyCsv(revisedCsv, "America/Toronto");
    const revisedReviews = await buildHevyExerciseReviews(db, user.id, revisedParsed);
    const revisedStaged: StagedHevyPayload = {
      kind: "hevy_history",
      schemaVersion: "1",
      originalFilename: "reviewed-hevy-revised.csv",
      fileHash: revisedParsed.fileHash,
      timezone: revisedParsed.timezone,
      profile: revisedParsed.profile,
      exercises: revisedReviews,
    };
    const [revisedEvent] = await db
      .insert(importEvents)
      .values({
        userId: user.id,
        source: "csv",
        rawPayload: revisedCsv,
        parsedPayload: revisedStaged,
        status: "parsed",
      })
      .returning({ id: importEvents.id });
    const revisedResult = await persistHevyImport(db, user, {
      importEventId: revisedEvent.id,
      resolutions: [
        {
          key: revisedParsed.exercises[0].key,
          action: "match",
          exerciseId: alternate.id,
        },
      ],
    });
    expect(revisedResult.ok).toBe(true);

    const [updatedMapping] = await db.query.externalExerciseMappings.findMany();
    expect(updatedMapping).toMatchObject({
      id: originalMapping.id,
      exerciseId: alternate.id,
    });
    const [mappingVersion] = await db.query.recordVersions.findMany();
    expect(mappingVersion).toMatchObject({
      entityType: "external_exercise_mapping",
      entityId: originalMapping.id,
      action: "mapping.update",
      beforeData: { exercise_id: exercise.id },
      afterData: { exercise_id: alternate.id },
    });
    expect(mappingVersion.changedFields).toEqual(
      expect.arrayContaining(["exercise_id", "confirmed_at"])
    );
    expect(await db.select().from(externalExerciseMappings)).toHaveLength(1);

    const repeatedCsv = revisedCsv
      .replace("Strength B", "Strength C")
      .replaceAll("Jun 3, 2026", "Jun 5, 2026");
    const repeatedParsed = parseHevyCsv(repeatedCsv, "America/Toronto");
    const repeatedReviews = await buildHevyExerciseReviews(db, user.id, repeatedParsed);
    const [repeatedEvent] = await db
      .insert(importEvents)
      .values({
        userId: user.id,
        source: "csv",
        rawPayload: repeatedCsv,
        parsedPayload: {
          kind: "hevy_history",
          schemaVersion: "1",
          originalFilename: "reviewed-hevy-repeated.csv",
          fileHash: repeatedParsed.fileHash,
          timezone: repeatedParsed.timezone,
          profile: repeatedParsed.profile,
          exercises: repeatedReviews,
        } satisfies StagedHevyPayload,
        status: "parsed",
      })
      .returning({ id: importEvents.id });
    expect(
      await persistHevyImport(db, user, {
        importEventId: repeatedEvent.id,
        resolutions: [
          {
            key: repeatedParsed.exercises[0].key,
            action: "match",
            exerciseId: alternate.id,
          },
        ],
      })
    ).toMatchObject({ ok: true });
    expect(await db.query.recordVersions.findMany()).toHaveLength(1);
  });
});
