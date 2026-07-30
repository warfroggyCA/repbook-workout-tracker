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
  exercises,
  importEvents,
  plateInventory,
  programs,
  programVersions,
  recordVersions,
  userProfiles,
  users,
} from "@/db/schema";
import type { ConfirmedEquipmentItem } from "@/ai/tasks/equipment-parse/confirm";
import {
  saveConstraintsWithVersions,
  saveInventoryWithVersions,
} from "@/services/setup-persistence";
import { activateProgramAtomically } from "@/services/program-activation";

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

    const result = await activateProgramAtomically(db, {
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
      expect.objectContaining({ intent: expect.objectContaining({ primaryOutcome: "strength" }) }),
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
