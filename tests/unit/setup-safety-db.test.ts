import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  aiParsingEvents,
  auditLogs,
  barbellConfigs,
  constraints,
  equipmentItems,
  exerciseEquipmentRequirements,
  exercises,
  importEvents,
  plateInventory,
  programs,
  programVersions,
  recordVersions,
  sessionExerciseGroups,
  sessionOccurrences,
  userProfiles,
  users,
  workoutTemplates,
} from "@/db/schema";
import type { ConfirmedEquipmentItem } from "@/ai/tasks/equipment-parse/confirm";
import {
  saveConstraintsWithVersions,
  saveInventoryWithVersions,
} from "@/services/setup-persistence";
import { activateProgramAtomically } from "@/services/program-activation";
import { getOwnedProgramVersionDocument } from "@/services/program-documents";
import { startWorkoutSession } from "@/services/session-lifecycle";
import { loadOwnerEquipmentFitReviewRevision } from "@/services/equipment-fit-review-revision";

function item(
  type: ConfirmedEquipmentItem["type"],
  label: string,
  overrides: Partial<ConfirmedEquipmentItem> = {}
): ConfirmedEquipmentItem {
  return {
    type,
    label,
    quantity: 1,
    minWeight: null,
    maxWeight: null,
    unit: null,
    adjustable: null,
    pair: null,
    increments: null,
    denominations: null,
    brand: null,
    barWeight: null,
    adjustableBench: null,
    ...overrides,
  };
}

describe("setup overwrite safety", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let profileId: string;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `setup-safety-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    [{ id: profileId }] = await db
      .insert(userProfiles)
      .values({ userId })
      .returning({ id: userProfiles.id });
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  it("diffs inventory in one save, preserves retained IDs, versions changes, and suppresses no-op versions", async () => {
    const initial = await saveInventoryWithVersions(db, userId, [
      item("barbell", "Olympic bar", { unit: "lb", barWeight: 45 }),
      item("plates", "Weight plates", {
        unit: "lb",
        denominations: [{ weight: 45, quantity: 2 }],
      }),
      item("dumbbell", "Dumbbells", {
        unit: "lb",
        adjustable: false,
        pair: true,
        maxWeight: 35,
      }),
    ]);
    expect(initial).toMatchObject({ ok: true, changed: true, versionCount: 5 });

    const [savedItems, savedPlates, savedBars] = await Promise.all([
      db.query.equipmentItems.findMany({ where: eq(equipmentItems.userId, userId) }),
      db.query.plateInventory.findMany({ where: eq(plateInventory.userId, userId) }),
      db.query.barbellConfigs.findMany({ where: eq(barbellConfigs.userId, userId) }),
    ]);
    const barItem = savedItems.find((row) => row.type === "barbell")!;
    const plateItem = savedItems.find((row) => row.type === "plates")!;
    const dumbbellItem = savedItems.find((row) => row.type === "dumbbell")!;
    const plate = savedPlates[0];
    const bar = savedBars[0];

    const changed = await saveInventoryWithVersions(db, userId, [
      item("barbell", "Main Olympic bar", {
        id: barItem.id,
        barConfigId: bar.id,
        unit: "lb",
        barWeight: 44,
        quantity: 2,
      }),
      item("plates", "Weight plates", {
        id: plateItem.id,
        unit: "lb",
        denominations: [{ id: plate.id, weight: 45, quantity: 3 }],
      }),
    ]);
    expect(changed).toMatchObject({ ok: true, changed: true, versionCount: 4 });

    const [afterItems, afterPlate, afterBar] = await Promise.all([
      db.query.equipmentItems.findMany({ where: eq(equipmentItems.userId, userId) }),
      db.query.plateInventory.findFirst({ where: eq(plateInventory.userId, userId) }),
      db.query.barbellConfigs.findFirst({ where: eq(barbellConfigs.userId, userId) }),
    ]);
    expect(afterItems.find((row) => row.type === "barbell")).toMatchObject({
      id: barItem.id,
      label: "Main Olympic bar",
      quantity: 2,
      available: true,
    });
    expect(afterItems.find((row) => row.type === "dumbbell")).toMatchObject({
      id: dumbbellItem.id,
      available: false,
    });
    expect(afterPlate).toMatchObject({ id: plate.id, quantity: 3 });
    expect(afterBar).toMatchObject({ id: bar.id, barWeight: 44, quantity: 2 });

    const versionsAfterChange = await db.query.recordVersions.findMany({
      where: eq(recordVersions.userId, userId),
    });
    expect(versionsAfterChange).toHaveLength(9);
    expect(versionsAfterChange.map((version) => version.action)).toEqual(
      expect.arrayContaining([
        "equipment.update",
        "equipment.retire",
        "plate.update",
        "bar.update",
      ])
    );

    const identical = await saveInventoryWithVersions(db, userId, [
      item("barbell", "Main Olympic bar", {
        id: barItem.id,
        barConfigId: bar.id,
        unit: "lb",
        barWeight: 44,
        quantity: 2,
      }),
      item("plates", "Weight plates", {
        id: plateItem.id,
        unit: "lb",
        denominations: [{ id: plate.id, weight: 45, quantity: 3 }],
      }),
    ]);
    expect(identical).toMatchObject({ ok: true, changed: false, versionCount: 0 });
    expect(await db.query.recordVersions.findMany()).toHaveLength(9);
    expect(
      (await db.query.userProfiles.findFirst({ where: eq(userProfiles.id, profileId) }))
        ?.setupState.completedSteps
    ).toContain("equipment");
  });

  it("confirms an AI equipment review in the same atomic save and refuses reuse", async () => {
    const [event] = await db
      .insert(aiParsingEvents)
      .values({
        userId,
        scope: "setup",
        task: "equipment_parse",
        rawInput: "a bench",
      })
      .returning({ id: aiParsingEvents.id });
    const input = [item("bench", "Bench", { adjustableBench: true })];
    expect(await saveInventoryWithVersions(db, userId, input, event.id)).toMatchObject({
      ok: true,
    });
    expect(
      await db.query.aiParsingEvents.findFirst({ where: eq(aiParsingEvents.id, event.id) })
    ).toMatchObject({ confirmed: true, confirmedPayload: { items: input } });

    const versionsBefore = await db.query.recordVersions.findMany();
    expect(await saveInventoryWithVersions(db, userId, input, event.id)).toEqual({
      ok: false,
      reason: "This equipment review was already saved or is no longer current.",
    });
    expect(await db.query.recordVersions.findMany()).toHaveLength(versionsBefore.length);
  });

  it("updates and removes constraints atomically while retaining the stable row ID and history", async () => {
    const initial = await saveConstraintsWithVersions(db, userId, [
      {
        bodyPart: "knee",
        avoidPatterns: ["squat"],
        cautiousPatterns: ["lunge"],
        painStopThreshold: 3,
        note: "Old knee issue",
      },
    ]);
    expect(initial).toMatchObject({ ok: true, versionCount: 2 });
    const rows = await db.query.constraints.findMany({ where: eq(constraints.userId, userId) });
    const avoid = rows.find((row) => row.avoid)!;

    const changed = await saveConstraintsWithVersions(db, userId, [
      {
        bodyPart: "knee",
        avoidPatterns: ["hinge", "squat"],
        cautiousPatterns: [],
        painStopThreshold: 4,
        note: "Updated knee guidance",
      },
    ]);
    expect(changed).toMatchObject({ ok: true, versionCount: 2 });
    expect(await db.query.constraints.findMany()).toEqual([
      expect.objectContaining({
        id: avoid.id,
        affectedPatterns: ["hinge", "squat"],
        painStopThreshold: 4,
        note: "Updated knee guidance",
      }),
    ]);
    expect(
      (await db.query.recordVersions.findMany()).map((version) => version.action)
    ).toEqual(
      expect.arrayContaining(["constraint.update", "constraint.remove"])
    );

    expect(
      await saveConstraintsWithVersions(db, userId, [
        {
          bodyPart: "knee",
          avoidPatterns: ["hinge", "squat"],
          cautiousPatterns: [],
          painStopThreshold: 4,
          note: "Updated knee guidance",
        },
      ])
    ).toMatchObject({ ok: true, changed: false, versionCount: 0 });
  });

  it("builds and activates the complete setup program atomically and versions the replaced program", async () => {
    const [exercise] = await db
      .insert(exercises)
      .values({
        name: `Atomic squat ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
    await db.insert(exerciseEquipmentRequirements).values({
      exerciseId: exercise.id,
      equipmentType: "barbell",
    });
    await db.insert(equipmentItems).values({
      userId,
      type: "barbell",
      label: "Guided-setup barbell",
      quantity: 1,
      attrs: { unit: "kg", maxWeight: 500 },
      available: true,
    });
    const [oldProgram] = await db
      .insert(programs)
      .values({ userId, name: "Old program", status: "archived", archivedAt: new Date() })
      .returning({ id: programs.id });
    const [oldVersion] = await db
      .insert(programVersions)
      .values({ programId: oldProgram.id, name: "Old program", versionNo: 1 })
      .returning({ id: programVersions.id });
    await db
      .update(programs)
      .set({ status: "active", currentVersionId: oldVersion.id, archivedAt: null })
      .where(eq(programs.id, oldProgram.id));
    const draft = {
      days: [
        {
          name: "Day A",
          exercises: [
            {
              exerciseId: exercise.id,
              name: "Squat",
              sets: 3,
              repMin: 5,
              repMax: 8,
              targetLoad: 10.075,
              targetLoadUnit: "kg" as const,
              restSec: 120,
              supersetGroup: null,
              notes: "Controlled reps",
              warmup: null,
              setNotes: [],
            },
          ],
        },
      ],
    };
    await db
      .update(userProfiles)
      .set({ setupState: { completedSteps: ["routine"], routineDraft: draft } })
      .where(eq(userProfiles.id, profileId));

    const reviewedFitRevision = await loadOwnerEquipmentFitReviewRevision(db, userId);
    expect(reviewedFitRevision).not.toBeNull();
    const activationInput: Parameters<typeof activateProgramAtomically>[1] = {
      userId,
      loadUnit: "kg",
      programName: "My program",
      days: [
        {
          name: "Day A",
          exercises: [
            {
              exerciseId: exercise.id,
              sets: 3,
              repMin: 5,
              repMax: 8,
              targetLoad: 10.08,
              restSec: 120,
              supersetKey: null,
              notes: "Controlled reps",
            },
          ],
        },
      ],
      changeSummary: "Created in guided setup",
      auditAction: "program.activate",
      auditSummary: "Program v1 activated from guided setup",
      expectedSetupDraft: draft,
      completeSetup: true,
      structuredIntentReviewed: true,
      allowReviewedUnknownEquipmentFit: false,
    };
    await expect(activateProgramAtomically(db, {
      ...activationInput,
      expectedEquipmentFitReviewRevision: "0".repeat(32),
    })).resolves.toMatchObject({ ok: false });
    await db.update(exerciseEquipmentRequirements)
      .set({ minWeight: 100 })
      .where(eq(exerciseEquipmentRequirements.exerciseId, exercise.id));
    await expect(activateProgramAtomically(db, {
      ...activationInput,
      allowReviewedUnknownEquipmentFit: true,
      expectedEquipmentFitReviewRevision: reviewedFitRevision!,
    })).resolves.toMatchObject({
      ok: false,
      reason:
        "Your equipment or retained movement compatibility changed after the final review. Nothing was published; reload this review and check the exact setup again.",
    });
    const refreshedFitRevision = await loadOwnerEquipmentFitReviewRevision(db, userId);
    expect(refreshedFitRevision).not.toBe(reviewedFitRevision);
    await expect(activateProgramAtomically(db, {
      ...activationInput,
      expectedEquipmentFitReviewRevision: refreshedFitRevision!,
    })).resolves.toMatchObject({
      ok: false,
      reason:
        "Saved equipment candidates exist, but no current owner-reviewed or exact stable-item fit proves that this exercise can use them.",
    });
    const result = await activateProgramAtomically(db, {
      ...activationInput,
      allowReviewedUnknownEquipmentFit: true,
      expectedEquipmentFitReviewRevision: refreshedFitRevision!,
    });
    expect(result).toMatchObject({ ok: true, replacedPrograms: 0, programId: oldProgram.id });
    if (!result.ok) throw new Error(result.reason);

    expect(
      await db.query.programs.findFirst({ where: eq(programs.id, oldProgram.id) })
    ).toMatchObject({ status: "active", archivedAt: null });
    expect(
      await db.query.programs.findFirst({ where: eq(programs.id, result.programId) })
    ).toMatchObject({ status: "active", name: "My program" });
    expect(await db.query.programVersions.findMany()).toHaveLength(2);
    expect(await db.query.programVersions.findFirst({
      where: eq(programVersions.id, result.programVersionId),
    })).toMatchObject({
      documentSchemaVersion: 2,
      publicationPreflight: expect.objectContaining({
        algorithmVersion: "phase2-rule-range-v1",
      }),
    });
    expect(await db.query.workoutTemplates.findMany()).toEqual([
      expect.objectContaining({
        warmupItems: [],
        intent: expect.objectContaining({ primaryOutcome: "strength" }),
      }),
    ]);
    expect(await db.query.workoutTemplateExercises.findMany()).toEqual([
      expect.objectContaining({ intent: expect.objectContaining({ role: "anchor", priority: "must" }) }),
    ]);
    expect(await db.query.exercisePrescriptions.findMany()).toEqual([
      expect.objectContaining({ targetLoad: 10.08, targetLoadUnit: "kg" }),
    ]);
    expect(await db.query.supersetGroups.findMany()).toHaveLength(0);
    expect(await db.query.recordVersions.findMany()).toEqual([
      expect.objectContaining({
        entityType: "program",
        entityId: oldProgram.id,
        action: "program.publish_version",
      }),
    ]);
    expect(
      await db.query.userProfiles.findFirst({ where: eq(userProfiles.id, profileId) })
    ).toMatchObject({
      setupState: { completedSteps: ["routine", "review"], routineDraft: draft },
    });
    expect(await db.query.auditLogs.findMany()).toEqual([
      expect.objectContaining({ action: "program.activate" }),
    ]);
  });

  it("publishes explicitly reviewed schema-3 intent and ordered day warm-ups without regenerating them", async () => {
    const exerciseRows = await db
      .insert(exercises)
      .values([
        {
          name: `Atomic press ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "dumbbell",
        },
        {
          name: `Atomic row ${crypto.randomUUID()}`,
          movementPattern: "horizontal_pull",
          primaryMuscles: ["back"],
          loadType: "dumbbell",
        },
      ])
      .returning({ id: exercises.id });
    const [event] = await db
      .insert(importEvents)
      .values({ userId, source: "paste", rawPayload: "Day A", status: "parsed" })
      .returning({ id: importEvents.id });
    const dayLineageId = crypto.randomUUID();
    const pressLineageId = crypto.randomUUID();
    const rowLineageId = crypto.randomUUID();
    const warmupItems = [
      {
        key: crypto.randomUUID(),
        label: "Raise body temperature",
        reps: null,
        load: null,
        loadUnit: null,
        loadPercent: null,
        loadText: "Move easily for five minutes",
        notes: "Stop before fatigue",
      },
    ];
    const pressWarmupSets = [{
      label: "Press ramp-up",
      reps: 8,
      load: null,
      loadUnit: null,
      loadPercent: 40,
      loadText: null,
      notes: null,
    }];
    const rowWarmupSets = [{
      label: "Row ramp-up",
      reps: 5,
      load: 20,
      loadUnit: "kg" as const,
      loadPercent: null,
      loadText: null,
      notes: "Pause at the top",
    }];
    const dayIntent = {
      primaryOutcome: "conditioning" as const,
      secondaryOutcomes: ["skill" as const],
      identity: {
        kind: "anchor_slots" as const,
        anchorSlotLineageIds: [rowLineageId],
      },
      targetDuration: { minMinutes: 45, maxMinutes: 55 },
      minimumUsefulDurationMinutes: 25,
      fatigueTolerance: "high" as const,
      orderingPolicy: "flexible" as const,
      pairingPolicy: "preserve" as const,
      durationOverride: null,
      note: "Keep the reviewed conditioning emphasis.",
    };
    const pressIntent = {
      role: "recovery" as const,
      priority: "could" as const,
      minimumDose: { unit: "sets" as const, value: 1 },
      idealDose: { unit: "sets" as const, value: 3 },
      protectedOrder: false,
      substitutionPolicy: "no_substitution" as const,
      omissionPolicy: "allowed" as const,
      calibrationEligible: false,
      note: "Explicitly reviewed first slot.",
    };
    const rowIntent = {
      role: "skill" as const,
      priority: "must" as const,
      minimumDose: { unit: "sets" as const, value: 2 },
      idealDose: { unit: "sets" as const, value: 3 },
      protectedOrder: true,
      substitutionPolicy: "exact_only" as const,
      omissionPolicy: "never" as const,
      calibrationEligible: false,
      note: "Explicitly reviewed anchor.",
    };

    const result = await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
      programName: "Reviewed import",
      days: [
        {
          lineageId: dayLineageId,
          name: "Day A",
          warmupItems,
          intent: dayIntent,
          exercises: [
            {
              lineageId: pressLineageId,
              exerciseId: exerciseRows[0].id,
              sets: 3,
              repMin: 8,
              repMax: 10,
              targetLoad: 30,
              targetLoadUnit: "kg",
              restSec: 30,
              supersetKey: "pair-a",
              notes: null,
              warmupSets: pressWarmupSets,
              intent: pressIntent,
            },
            {
              lineageId: rowLineageId,
              exerciseId: exerciseRows[1].id,
              sets: 3,
              repMin: 8,
              repMax: 10,
              targetLoad: 35,
              targetLoadUnit: "lb",
              restSec: 75,
              supersetKey: "pair-a",
              notes: null,
              warmupSets: rowWarmupSets,
              intent: rowIntent,
            },
          ],
        },
      ],
      changeSummary: "Imported from reviewed structured input",
      auditAction: "import.confirm",
      auditSummary: "Reviewed structured import activated",
      importEventId: event.id,
      confirmedPayload: { reviewed: true },
      expectedCurrentProgramVersionId: null,
      structuredIntentReviewed: true,
    });
    if (!result.ok) throw new Error(result.reason);

    expect(await db.query.programVersions.findFirst({
      where: eq(programVersions.id, result.programVersionId),
    })).toMatchObject({
      documentSchemaVersion: 3,
      publicationPreflight: expect.objectContaining({
        algorithmVersion: "phase2-rule-range-v1",
      }),
    });
    const publishedTemplate = await db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, result.programVersionId),
    });
    expect(publishedTemplate).toMatchObject({
      lineageId: dayLineageId,
      warmupItems,
      intent: dayIntent,
    });
    const publishedSlots = (await db.query.workoutTemplateExercises.findMany())
      .sort((left, right) => left.orderIdx - right.orderIdx);
    expect(publishedSlots).toEqual([
      expect.objectContaining({
        lineageId: pressLineageId,
        groupMemberOrderIdx: 0,
        warmupSets: pressWarmupSets,
        intent: pressIntent,
      }),
      expect.objectContaining({
        lineageId: rowLineageId,
        groupMemberOrderIdx: 1,
        warmupSets: rowWarmupSets,
        intent: rowIntent,
      }),
    ]);
    const publishedPrescriptions = await db.query.exercisePrescriptions.findMany();
    expect(publishedPrescriptions.find(
      (prescription) => prescription.templateExerciseId === publishedSlots[0].id,
    )).toMatchObject({ targetLoad: 30, targetLoadUnit: "kg" });
    expect(publishedPrescriptions.find(
      (prescription) => prescription.templateExerciseId === publishedSlots[1].id,
    )).toMatchObject({ targetLoad: 35, targetLoadUnit: "lb" });
    const publishedDocument = await getOwnedProgramVersionDocument(
      db,
      userId,
      result.programVersionId,
    );
    expect(publishedDocument?.schemaVersion).toBe("3");
    expect(publishedDocument?.days[0].exercises.map((exercise) => ({
      targetLoad: exercise.targetLoad,
      targetLoadUnit: exercise.targetLoadUnit,
    }))).toEqual([
      { targetLoad: 30, targetLoadUnit: "kg" },
      { targetLoad: 35, targetLoadUnit: "lb" },
    ]);
    expect(await db.query.supersetGroups.findFirst()).toMatchObject({
      plannedRounds: 3,
      restBetweenMembersSec: 30,
      restAfterRoundSec: 75,
    });
    if (!publishedTemplate) throw new Error("Expected the reviewed Program day.");
    const started = await startWorkoutSession(db, userId, publishedTemplate.id);
    expect(await db.query.sessionExerciseGroups.findFirst({
      where: eq(sessionExerciseGroups.sessionId, started.sessionId),
    })).toMatchObject({
      plannedRounds: 3,
      memberCount: 2,
      restBetweenMembersSec: 30,
      restBetweenRoundsSec: 75,
    });
    const startedOccurrences = await db.query.sessionOccurrences.findMany({
      where: eq(sessionOccurrences.sessionId, started.sessionId),
      orderBy: (occurrence, { asc }) => [asc(occurrence.sequenceIdx)],
    });
    expect(startedOccurrences
      .filter((occurrence) => occurrence.kind === "working_set")
      .map((occurrence) => occurrence.groupMemberOrderIdx)).toEqual([
      0, 1, 0, 1, 0, 1,
    ]);

    const mismatchedRestLineages = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    const versionsBeforeRestMismatch = (await db.query.programVersions.findMany()).length;
    expect(await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
      programName: "Inconsistent paired rest must not publish",
      days: [{
        lineageId: crypto.randomUUID(),
        name: "Rest mismatch",
        warmupItems: [],
        intent: {
          ...dayIntent,
          identity: {
            kind: "anchor_slots",
            anchorSlotLineageIds: [mismatchedRestLineages[0]],
          },
        },
        exercises: mismatchedRestLineages.map((lineageId, index) => ({
          lineageId,
          exerciseId: exerciseRows[index % exerciseRows.length]!.id,
          sets: 3,
          repMin: 8,
          repMax: 10,
          targetLoad: null,
          targetLoadUnit: null,
          restSec: [20, 30, 90][index]!,
          supersetKey: "pair-a",
          notes: null,
          intent: index === 0 ? pressIntent : rowIntent,
        })),
      }],
      changeSummary: "Must not publish",
      auditAction: "import.confirm",
      auditSummary: "Must not publish",
      structuredIntentReviewed: true,
    })).toEqual({
      ok: false,
      reason:
        "A reviewed paired group needs one shared rest time before the next paired exercise.",
    });
    expect(await db.query.programVersions.findMany()).toHaveLength(
      versionsBeforeRestMismatch,
    );

    const countsBeforeMissingUnit = {
      versions: (await db.query.programVersions.findMany()).length,
      templates: (await db.query.workoutTemplates.findMany()).length,
      slots: (await db.query.workoutTemplateExercises.findMany()).length,
      audits: (await db.query.auditLogs.findMany()).length,
    };
    const missingUnitSlotLineageId = crypto.randomUUID();
    expect(await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
      programName: "Missing unit must not publish",
      days: [{
        lineageId: crypto.randomUUID(),
        name: "Missing unit day",
        warmupItems: [],
        intent: {
          ...dayIntent,
          identity: {
            kind: "anchor_slots",
            anchorSlotLineageIds: [missingUnitSlotLineageId],
          },
        },
        exercises: [{
          lineageId: missingUnitSlotLineageId,
          exerciseId: exerciseRows[0].id,
          sets: 3,
          repMin: 8,
          repMax: 10,
          targetLoad: 30,
          restSec: 60,
          supersetKey: null,
          notes: null,
          intent: pressIntent,
        }],
      }],
      changeSummary: "Must not publish",
      auditAction: "import.confirm",
      auditSummary: "Must not publish",
      structuredIntentReviewed: true,
    })).toEqual({
      ok: false,
      reason: "A reviewed target load is missing its recorded unit.",
    });
    expect({
      versions: (await db.query.programVersions.findMany()).length,
      templates: (await db.query.workoutTemplates.findMany()).length,
      slots: (await db.query.workoutTemplateExercises.findMany()).length,
      audits: (await db.query.auditLogs.findMany()).length,
    }).toEqual(countsBeforeMissingUnit);

    const [staleEvent] = await db
      .insert(importEvents)
      .values({ userId, source: "paste", rawPayload: "Stale Day", status: "parsed" })
      .returning({ id: importEvents.id });
    const countsBeforeStale = {
      versions: (await db.query.programVersions.findMany()).length,
      templates: (await db.query.workoutTemplates.findMany()).length,
      slots: (await db.query.workoutTemplateExercises.findMany()).length,
      audits: (await db.query.auditLogs.findMany()).length,
    };
    expect(await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
      programName: "Stale import must not publish",
      days: [{
        name: "Stale Day",
        exercises: [{
          exerciseId: exerciseRows[0].id,
          sets: 1,
          repMin: 1,
          repMax: 1,
          targetLoad: null,
          restSec: 0,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Must not publish",
      auditAction: "import.confirm",
      auditSummary: "Must not publish",
      importEventId: staleEvent.id,
      expectedCurrentProgramVersionId: crypto.randomUUID(),
    })).toEqual({
      ok: false,
      reason: "This routine import was already confirmed or is no longer current.",
    });
    expect(await db.query.importEvents.findFirst({
      where: eq(importEvents.id, staleEvent.id),
    })).toMatchObject({ status: "parsed" });
    expect({
      versions: (await db.query.programVersions.findMany()).length,
      templates: (await db.query.workoutTemplates.findMany()).length,
      slots: (await db.query.workoutTemplateExercises.findMany()).length,
      audits: (await db.query.auditLogs.findMany()).length,
    }).toEqual(countsBeforeStale);

    const countsBeforePartial = {
      versions: (await db.query.programVersions.findMany()).length,
      templates: (await db.query.workoutTemplates.findMany()).length,
      slots: (await db.query.workoutTemplateExercises.findMany()).length,
      groups: (await db.query.supersetGroups.findMany()).length,
      audits: (await db.query.auditLogs.findMany()).length,
    };
    expect(await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
      programName: "Partial review must not publish",
      days: [{
        lineageId: crypto.randomUUID(),
        name: "Partial day",
        exercises: [{
          exerciseId: exerciseRows[0].id,
          sets: 1,
          repMin: 1,
          repMax: 1,
          targetLoad: null,
          restSec: 0,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Must not publish",
      auditAction: "import.confirm",
      auditSummary: "Must not publish",
      structuredIntentReviewed: true,
    })).toEqual({
      ok: false,
      reason: "The reviewed Program intent is incomplete. Review every day and exercise before publishing.",
    });
    expect({
      versions: (await db.query.programVersions.findMany()).length,
      templates: (await db.query.workoutTemplates.findMany()).length,
      slots: (await db.query.workoutTemplateExercises.findMany()).length,
      groups: (await db.query.supersetGroups.findMany()).length,
      audits: (await db.query.auditLogs.findMany()).length,
    }).toEqual(countsBeforePartial);
  });

  it("confirms routine-import provenance with activation and fails closed for invalid structure", async () => {
    const [exercise] = await db
      .insert(exercises)
      .values({
        name: `Atomic row ${crypto.randomUUID()}`,
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "dumbbell",
      })
      .returning({ id: exercises.id });
    const [event] = await db
      .insert(importEvents)
      .values({ userId, source: "paste", rawPayload: "Day A", status: "parsed" })
      .returning({ id: importEvents.id });
    const aiRows = await db
      .insert(aiParsingEvents)
      .values([
        { userId, scope: "import", task: "routine_parse", rawInput: "Day A" },
        { userId, scope: "import", task: "exercise_map", rawInput: "Row" },
      ])
      .returning({ id: aiParsingEvents.id });

    const result = await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
      programName: "Imported program",
      days: [
        {
          name: "Day A",
          exercises: [
            {
              exerciseId: exercise.id,
              sets: 3,
              repMin: 8,
              repMax: 12,
              targetLoad: 30,
              restSec: 90,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Imported from pasted routine (confirmed in review)",
      auditAction: "import.confirm",
      auditSummary: "Imported program activated",
      importEventId: event.id,
      aiEventIds: aiRows.map((row) => row.id),
      confirmedPayload: { reviewed: true },
      structuredIntentReviewed: true,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.ok).toBe(true);
    expect(await db.query.programVersions.findFirst({
      where: eq(programVersions.id, result.programVersionId),
    })).toMatchObject({
      documentSchemaVersion: 2,
      publicationPreflight: expect.objectContaining({
        algorithmVersion: "phase2-rule-range-v1",
      }),
    });
    expect(
      await db.query.importEvents.findFirst({ where: eq(importEvents.id, event.id) })
    ).toMatchObject({ status: "confirmed" });
    expect(await db.query.aiParsingEvents.findMany()).toEqual([
      expect.objectContaining({ confirmed: true, confirmedPayload: { reviewed: true } }),
      expect.objectContaining({ confirmed: true, confirmedPayload: { reviewed: true } }),
    ]);

    const countsBefore = {
      programs: (await db.query.programs.findMany()).length,
      versions: (await db.query.programVersions.findMany()).length,
      templates: (await db.query.workoutTemplates.findMany()).length,
      audits: (await db.select().from(auditLogs)).length,
    };
    const invalid = await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
      programName: "Must not exist",
      days: [
        {
          name: "Broken day",
          exercises: [
            {
              exerciseId: crypto.randomUUID(),
              sets: 1,
              repMin: 1,
              repMax: 1,
              targetLoad: null,
              restSec: 0,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Should fail",
      auditAction: "program.activate",
      auditSummary: "Should fail",
    });
    expect(invalid.ok).toBe(false);
    expect({
      programs: (await db.query.programs.findMany()).length,
      versions: (await db.query.programVersions.findMany()).length,
      templates: (await db.query.workoutTemplates.findMany()).length,
      audits: (await db.select().from(auditLogs)).length,
    }).toEqual(countsBefore);
  });
});
