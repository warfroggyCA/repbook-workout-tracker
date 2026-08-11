import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  auditLogs,
  barbellConfigs,
  equipmentDefinitions,
  equipmentItems,
  exerciseEquipmentRequirements,
  exercises,
  plateInventory,
  programs,
  recordVersions,
  userProfiles,
  users,
} from "@/db/schema";
import { equipmentTypeEnum } from "@/db/schema/enums";
import type { ConfirmedEquipmentItem } from "@/ai/tasks/equipment-parse/confirm";
import {
  saveInventoryDocumentForManagement,
  saveInventoryWithVersions,
} from "@/services/setup-persistence";
import {
  loadEquipmentInventoryDocument,
  previewInventoryDocumentChanges,
} from "@/services/equipment-inventory";
import { activateProgramAtomically } from "@/services/program-activation";
import { saveExerciseEquipmentFitAssertion } from "@/services/exercise-equipment-fit-management";
import {
  EQUIPMENT_TYPE_VALUES,
  validateEquipmentInventoryDocument,
  type EquipmentInventoryDocument,
} from "@/lib/equipment-inventory-contract";

function onboardingItem(
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

async function countHistory(db: PgliteDatabase<typeof schema>, userId: string) {
  const [versions, audits] = await Promise.all([
    db.query.recordVersions.findMany({ where: eq(recordVersions.userId, userId) }),
    db.select().from(auditLogs).where(eq(auditLogs.userId, userId)),
  ]);
  return { versions: versions.length, audits: audits.length };
}

describe("returning-user equipment management boundary", () => {
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
      .values({ email: `equipment-mgmt-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    [{ id: profileId }] = await db
      .insert(userProfiles)
      .values({ userId })
      .returning({ id: userProfiles.id });
  }, 60_000);

  afterEach(async () => {
    await client.close();
  });

  it("keeps the canonical contract type list identical to the database enum", () => {
    expect([...EQUIPMENT_TYPE_VALUES]).toEqual([...equipmentTypeEnum.enumValues]);
  });

  it(
    "round-trips every database equipment type, repeated types, specialty details, plates, bars, and collars byte-for-byte with zero history noise",
    async () => {
      const [definition] = await db
        .insert(equipmentDefinitions)
        .values({
          key: "trap-bar-gearforce",
          label: "GearForce trap bar",
          category: "trap_bar",
          description: "Hex bar with raised handles",
        })
        .returning({ id: equipmentDefinitions.id });

      // One row per current database enum value, plus a second row of one
      // type, a definition-backed specialty row with levels/notes, and a
      // retired row that must stay out of the active document.
      await db.insert(equipmentItems).values([
        ...EQUIPMENT_TYPE_VALUES.map((type) => ({
          userId,
          type,
          label: type === "barbell" ? "Olympic bar" : type === "ez_bar" ? "EZ bar" : `Primary ${type.replaceAll("_", " ")}`,
          quantity: type === "barbell" ? 2 : 1,
          attrs:
            type === "dumbbell"
              ? {
                  unit: "lb" as const,
                  minWeight: 5,
                  maxWeight: 50,
                  adjustable: false,
                  pair: true,
                  increments: [5, 10, 15],
                }
              : {},
          available: true,
        })),
        {
          userId,
          type: "dumbbell" as const,
          label: "Second fixed dumbbells",
          quantity: 2,
          attrs: { unit: "lb" as const, maxWeight: 20, adjustable: false, pair: true },
          available: true,
        },
        {
          userId,
          type: "trap_bar" as const,
          definitionId: definition.id,
          label: "GearForce trap bar",
          quantity: 1,
          attrs: {
            brand: "GearForce",
            levels: ["high handles", "low handles"],
            notes: "Knurled grips",
            futureAttribute: "preserved",
          } as Record<string, unknown>,
          available: true,
        },
        {
          userId,
          type: "sled" as const,
          label: "Retired push sled",
          quantity: 1,
          attrs: {},
          available: false,
        },
      ]);
      await db.insert(plateInventory).values([
        { userId, denomination: 45, quantity: 2 },
        { userId, denomination: 2.5, quantity: 1 },
        { userId, denomination: 1.25, quantity: 4 },
      ]);
      await db.insert(barbellConfigs).values([
        { userId, barType: "olympic", barWeight: 45, collarWeight: 5.5, quantity: 2, label: "Olympic bar" },
        { userId, barType: "ez", barWeight: 25, collarWeight: 1.25, quantity: 1, label: "EZ bar" },
      ]);

      const loaded = await loadEquipmentInventoryDocument(db, userId);
      expect(loaded).not.toBeNull();
      const document = loaded!.document;
      expect(loaded!.ambiguousBarTypes).toEqual([]);
      // Every enum value, the repeated type, and the specialty item survive;
      // the retired row is not part of the editable document.
      expect(document.items).toHaveLength(EQUIPMENT_TYPE_VALUES.length + 2);
      expect(
        document.items.filter((item) => item.type === "dumbbell")
      ).toHaveLength(2);
      const specialty = document.items.find(
        (item) => item.label === "GearForce trap bar"
      );
      expect(specialty?.attrs).toMatchObject({
        brand: "GearForce",
        levels: ["high handles", "low handles"],
        notes: "Knurled grips",
        futureAttribute: "preserved",
      });
      expect(document.plates.map((plate) => plate.denomination)).toEqual([
        45, 2.5, 1.25,
      ]);
      expect(document.bars).toHaveLength(2);
      expect(document.bars.find((bar) => bar.barType === "olympic")).toMatchObject({
        collarWeight: 5.5,
        quantity: 2,
      });
      expect(validateEquipmentInventoryDocument(document).ok).toBe(true);

      const before = await countHistory(db, userId);
      const unchanged = await saveInventoryDocumentForManagement(db, userId, document);
      expect(unchanged).toMatchObject({
        ok: true,
        changed: false,
        versionCount: 0,
      });
      expect(await countHistory(db, userId)).toEqual(before);

      const reloaded = await loadEquipmentInventoryDocument(db, userId);
      expect(JSON.stringify(reloaded!.document)).toBe(JSON.stringify(document));
      // Setup state was never touched by a management save.
      const profile = await db.query.userProfiles.findFirst({
        where: eq(userProfiles.id, profileId),
      });
      expect(profile?.setupState.completedSteps).toEqual([]);
      expect(profile?.setupCompletedAt).toBeNull();

      const retired = await db.query.equipmentItems.findMany({
        where: eq(equipmentItems.userId, userId),
      });
      expect(
        retired.find((row) => row.label === "Retired push sled")?.available
      ).toBe(false);
    },
    60_000
  );

  it(
    "applies management edits atomically: stable IDs, preserved server-owned attributes, preserved definitions, exact plate and bar diffs",
    async () => {
      const [definition] = await db
        .insert(equipmentDefinitions)
        .values({ key: "landmine-core", label: "Core landmine", category: "landmine" })
        .returning({ id: equipmentDefinitions.id });
      const [specialtyRow] = await db
        .insert(equipmentItems)
        .values({
          userId,
          type: "landmine",
          definitionId: definition.id,
          label: "Corner landmine",
          quantity: 1,
          attrs: { levels: ["single arm"], notes: "Sleeve adapter" },
          available: true,
        })
        .returning();
      const [dumbbellRow] = await db
        .insert(equipmentItems)
        .values({
          userId,
          type: "dumbbell",
          label: "Fixed dumbbells",
          quantity: 1,
          attrs: { unit: "lb", maxWeight: 50, adjustable: false, pair: true },
          available: true,
        })
        .returning();
      const [rackRow] = await db
        .insert(equipmentItems)
        .values({
          userId,
          type: "rack",
          label: "Squat stands",
          quantity: 1,
          attrs: {},
          available: true,
        })
        .returning();
      const [barItem] = await db
        .insert(equipmentItems)
        .values({
          userId,
          type: "barbell",
          label: "Olympic bar",
          quantity: 1,
          attrs: { unit: "lb" },
          available: true,
        })
        .returning();
      const [plate45] = await db
        .insert(plateInventory)
        .values({ userId, denomination: 45, quantity: 2 })
        .returning();
      const [plate25] = await db
        .insert(plateInventory)
        .values({ userId, denomination: 25, quantity: 2 })
        .returning();
      const [olympicBar] = await db
        .insert(barbellConfigs)
        .values({
          userId,
          barType: "olympic",
          barWeight: 45,
          collarWeight: 5.5,
          quantity: 1,
          label: "Olympic bar",
        })
        .returning();

      const loaded = await loadEquipmentInventoryDocument(db, userId);
      const document = loaded!.document;

      const edited: EquipmentInventoryDocument = {
        baseRevision: document.baseRevision,
        items: [
          // Rename + requantify the specialty row. The client also tries to
          // smuggle replacement server-owned attributes, which must be
          // ignored in favor of the stored values.
          {
            id: specialtyRow.id,
            type: "landmine",
            label: "Corner landmine station",
            quantity: 2,
            attrs: {
              brand: "NewBrand",
              levels: ["tampered"],
              notes: "tampered",
            },
          },
          // Reduce the dumbbell range (capability decrease).
          {
            id: dumbbellRow.id,
            type: "dumbbell",
            label: "Fixed dumbbells",
            quantity: 1,
            attrs: { unit: "lb", maxWeight: 35, adjustable: false, pair: true },
          },
          {
            id: barItem.id,
            type: "barbell",
            label: "Olympic bar",
            quantity: 1,
            attrs: { unit: "lb" },
          },
          // rackRow omitted → retired.
          // New item added.
          {
            id: null,
            type: "kettlebell",
            label: "Competition kettlebell",
            quantity: 1,
            attrs: { unit: "lb", maxWeight: 53, adjustable: false },
          },
        ],
        plates: [
          { id: plate45.id, denomination: 45, quantity: 3 },
          // plate25 omitted → removed.
          { id: null, denomination: 1.25, quantity: 2 },
        ],
        bars: [
          {
            id: olympicBar.id,
            barType: "olympic",
            barWeight: 44,
            collarWeight: 5.5,
            quantity: 1,
            label: "Olympic bar",
          },
        ],
      };

      const saved = await saveInventoryDocumentForManagement(db, userId, edited);
      expect(saved).toMatchObject({
        ok: true,
        changed: true,
        counts: {
          addedItems: 1,
          updatedItems: 2,
          retiredItems: 1,
          plateWrites: 3,
          barWrites: 1,
        },
      });

      const rows = await db.query.equipmentItems.findMany({
        where: eq(equipmentItems.userId, userId),
      });
      const specialtyAfter = rows.find((row) => row.id === specialtyRow.id)!;
      expect(specialtyAfter).toMatchObject({
        label: "Corner landmine station",
        quantity: 2,
        available: true,
        definitionId: definition.id,
      });
      // Server-owned attributes came from the stored row, not the client;
      // the editable brand key was accepted.
      expect(specialtyAfter.attrs).toMatchObject({
        brand: "NewBrand",
        levels: ["single arm"],
        notes: "Sleeve adapter",
      });
      expect(rows.find((row) => row.id === rackRow.id)).toMatchObject({
        available: false,
      });
      expect(rows.find((row) => row.type === "kettlebell")).toMatchObject({
        available: true,
        quantity: 1,
      });

      const plates = await db.query.plateInventory.findMany({
        where: eq(plateInventory.userId, userId),
      });
      expect(plates.find((plate) => plate.id === plate45.id)).toMatchObject({
        quantity: 3,
      });
      expect(plates.find((plate) => plate.id === plate25.id)).toBeUndefined();
      expect(
        plates.find((plate) => plate.denomination === 1.25)
      ).toMatchObject({ quantity: 2 });

      const bars = await db.query.barbellConfigs.findMany({
        where: eq(barbellConfigs.userId, userId),
      });
      expect(bars).toEqual([
        expect.objectContaining({
          id: olympicBar.id,
          barWeight: 44,
          collarWeight: 5.5,
        }),
      ]);

      const audits = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.userId, userId));
      expect(audits).toEqual([
        expect.objectContaining({ action: "equipment.manage.save" }),
      ]);
      const profile = await db.query.userProfiles.findFirst({
        where: eq(userProfiles.id, profileId),
      });
      expect(profile?.setupState.completedSteps).toEqual([]);
    },
    60_000
  );

  it("reactivates a retired item when it is intentionally re-added", async () => {
    const [retiredRow] = await db
      .insert(equipmentItems)
      .values({
        userId,
        type: "bench",
        label: "Flat bench",
        quantity: 1,
        attrs: { adjustableBench: false, brand: "OldBrand", notes: "Original pad" },
        available: false,
      })
      .returning();

    const loaded = await loadEquipmentInventoryDocument(db, userId);
    expect(loaded!.document.items).toHaveLength(0);
    const saved = await saveInventoryDocumentForManagement(db, userId, {
      baseRevision: loaded!.document.baseRevision,
      items: [
        {
          id: null,
          type: "bench",
          label: "Flat bench",
          quantity: 1,
          attrs: { adjustableBench: false },
        },
      ],
      plates: [],
      bars: [],
    });
    expect(saved).toMatchObject({ ok: true, changed: true });
    const rows = await db.query.equipmentItems.findMany({
      where: eq(equipmentItems.userId, userId),
    });
    expect(rows).toEqual([
      expect.objectContaining({
        id: retiredRow.id,
        available: true,
        // Reactivation preserves stored details the client never saw,
        // including editable keys the re-added item did not supply.
        attrs: expect.objectContaining({
          notes: "Original pad",
          brand: "OldBrand",
          adjustableBench: false,
        }),
      }),
    ]);
  });

  it("requires a matched last bar item and configuration to be removed together", async () => {
    await db.insert(equipmentItems).values({
      userId,
      type: "ez_bar",
      label: "EZ bar",
      quantity: 1,
      attrs: { unit: "lb" },
      available: true,
    });
    await db.insert(barbellConfigs).values({
      userId,
      barType: "ez",
      label: "EZ bar",
      quantity: 1,
      barWeight: 25,
      collarWeight: 1,
    });
    const loaded = await loadEquipmentInventoryDocument(db, userId);
    const keepConfigOnly = await saveInventoryDocumentForManagement(db, userId, {
      ...loaded!.document,
      items: [],
    });
    expect(keepConfigOnly).toMatchObject({ ok: false, code: "invalid" });
    const keepItemOnly = await saveInventoryDocumentForManagement(db, userId, {
      ...loaded!.document,
      bars: [],
    });
    expect(keepItemOnly).toMatchObject({ ok: false, code: "invalid" });
    const paired = await saveInventoryDocumentForManagement(db, userId, {
      ...loaded!.document,
      items: [],
      bars: [],
    });
    expect(paired).toMatchObject({ ok: true, changed: true, counts: { retiredItems: 1, barWrites: 1 } });
    expect(await db.query.barbellConfigs.findMany({ where: eq(barbellConfigs.userId, userId) })).toHaveLength(0);
    expect(await db.query.equipmentItems.findMany({ where: eq(equipmentItems.userId, userId) }))
      .toEqual([expect.objectContaining({ available: false })]);
  });

  it("rolls the entire inventory back when a late history write fails", async () => {
    await db.insert(equipmentItems).values({
      userId,
      type: "bench",
      label: "Original bench",
      quantity: 1,
      attrs: { adjustableBench: false },
      available: true,
    });
    const loaded = await loadEquipmentInventoryDocument(db, userId);
    const beforeItems = await db.query.equipmentItems.findMany({
      where: eq(equipmentItems.userId, userId),
    });

    await client.exec(`
      CREATE FUNCTION fail_equipment_version_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action LIKE 'equipment.%' THEN
          RAISE EXCEPTION 'injected equipment version failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_equipment_version_write_trigger
      BEFORE INSERT ON record_versions
      FOR EACH ROW EXECUTE FUNCTION fail_equipment_version_write();
    `);

    await expect(
      saveInventoryDocumentForManagement(db, userId, {
        ...loaded!.document,
        items: loaded!.document.items.map((item) => ({
          ...item,
          label: "Changed bench",
        })),
      })
    ).rejects.toThrow("Failed query");

    expect(
      await db.query.equipmentItems.findMany({
        where: eq(equipmentItems.userId, userId),
      })
    ).toEqual(beforeItems);
    expect(await countHistory(db, userId)).toEqual({ versions: 0, audits: 0 });
  });

  it("fails closed for stale revisions, unknown IDs, and foreign IDs without changing anything", async () => {
    const [itemRow] = await db
      .insert(equipmentItems)
      .values({
        userId,
        type: "cable",
        label: "Cable stack",
        quantity: 1,
        attrs: {},
        available: true,
      })
      .returning();
    const [{ id: otherUserId }] = await db
      .insert(users)
      .values({ email: `other-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    const [foreignRow] = await db
      .insert(equipmentItems)
      .values({
        userId: otherUserId,
        type: "bench",
        label: "Foreign bench",
        quantity: 1,
        attrs: {},
        available: true,
      })
      .returning();

    const loaded = await loadEquipmentInventoryDocument(db, userId);
    const document = loaded!.document;
    const before = await countHistory(db, userId);

    const stale = await saveInventoryDocumentForManagement(db, userId, {
      ...document,
      baseRevision: "not-the-current-revision",
      items: [],
    });
    expect(stale).toMatchObject({ ok: false, code: "stale" });

    const unknown = await saveInventoryDocumentForManagement(db, userId, {
      ...document,
      items: [
        ...document.items,
        {
          id: crypto.randomUUID(),
          type: "bench",
          label: "Ghost bench",
          quantity: 1,
          attrs: {},
        },
      ],
    });
    expect(unknown).toMatchObject({ ok: false, code: "unknown_ids" });

    const foreign = await saveInventoryDocumentForManagement(db, userId, {
      ...document,
      items: [
        ...document.items,
        {
          id: foreignRow.id,
          type: "bench",
          label: "Foreign bench",
          quantity: 1,
          attrs: {},
        },
      ],
    });
    expect(foreign).toMatchObject({ ok: false, code: "unknown_ids" });

    expect(await countHistory(db, userId)).toEqual(before);
    expect(
      await db.query.equipmentItems.findMany({
        where: eq(equipmentItems.userId, userId),
      })
    ).toEqual([expect.objectContaining({ id: itemRow.id, available: true })]);
    expect(
      await db.query.equipmentItems.findFirst({
        where: eq(equipmentItems.id, foreignRow.id),
      })
    ).toMatchObject({ userId: otherUserId, available: true });
  });

  it("preserves repeated saved configurations while unrelated inventory remains editable", async () => {
    await db.insert(barbellConfigs).values([
      { userId, barType: "olympic", barWeight: 45, collarWeight: 0, quantity: 1, label: "Bar A" },
      { userId, barType: "olympic", barWeight: 35, collarWeight: 0, quantity: 1, label: "Bar B" },
    ]);
    const loaded = await loadEquipmentInventoryDocument(db, userId);
    expect(loaded!.ambiguousBarTypes).toEqual(["olympic"]);

    expect(validateEquipmentInventoryDocument(loaded!.document).ok).toBe(true);
    const beforeBars = await db.query.barbellConfigs.findMany({
      where: eq(barbellConfigs.userId, userId),
    });
    const result = await saveInventoryDocumentForManagement(db, userId, {
      baseRevision: loaded!.document.baseRevision,
      items: [{ id: null, type: "bench", label: "Unrelated bench", quantity: 1, attrs: {} }],
      plates: [],
      bars: loaded!.document.bars,
    });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(
      await db.query.barbellConfigs.findMany({
        where: eq(barbellConfigs.userId, userId),
      })
    ).toEqual(beforeBars);

    const reloaded = await loadEquipmentInventoryDocument(db, userId);
    const editedBar = await saveInventoryDocumentForManagement(db, userId, {
      ...reloaded!.document,
      bars: reloaded!.document.bars.map((bar, index) =>
        index === 0 ? { ...bar, barWeight: 44 } : bar
      ),
    });
    expect(editedBar).toMatchObject({ ok: false, code: "invalid" });

    const bench = reloaded!.document.items.find((item) => item.type === "bench")!;
    const onboardingSave = await saveInventoryWithVersions(db, userId, [
      onboardingItem("bench", bench.label, { id: bench.id ?? undefined }),
    ]);
    expect(onboardingSave).toMatchObject({ ok: true });
    expect(await db.query.barbellConfigs.findMany({ where: eq(barbellConfigs.userId, userId) }))
      .toEqual(beforeBars);
  });

  it(
    "previews adds, changes, removals, plates, bars, and truthful availability impact from the server",
    async () => {
      const [cableExercise] = await db
        .insert(exercises)
        .values({
          name: `Cable Row ${crypto.randomUUID()}`,
          movementPattern: "horizontal_pull",
          primaryMuscles: ["back"],
          loadType: "cable",
        })
        .returning();
      const [benchExercise] = await db
        .insert(exercises)
        .values({
          name: `Bench Support Press ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "dumbbell",
        })
        .returning();
      await db.insert(exerciseEquipmentRequirements).values([
        { exerciseId: cableExercise.id, equipmentType: "cable", minWeight: null },
        { exerciseId: benchExercise.id, equipmentType: "bench", minWeight: null },
        { exerciseId: benchExercise.id, equipmentType: "dumbbell", minWeight: null },
      ]);
      const insertedItems = await db.insert(equipmentItems).values([
        { userId, type: "cable", label: "Cable stack", quantity: 1, attrs: {}, available: true },
        {
          userId,
          type: "dumbbell",
          label: "Dumbbells",
          quantity: 1,
          attrs: { unit: "lb", maxWeight: 50, adjustable: false, pair: true },
          available: true,
        },
      ]).returning();
      const cableItemForReview = insertedItems.find((item) => item.type === "cable")!;
      expect(await saveExerciseEquipmentFitAssertion(db, userId, {
        mutationId: crypto.randomUUID(),
        assertionId: null,
        exerciseId: cableExercise.id,
        equipmentItemId: cableItemForReview.id,
        verdict: "compatible",
        reasonCode: "owner_verified",
        reasonNote: null,
        expectedRevision: null,
      })).toMatchObject({ ok: true, changed: true });
      const activated = await activateProgramAtomically(db, {
        userId,
        loadUnit: "lb",
        programName: "Test program",
        days: [
          {
            name: "Pull day",
            exercises: [
              {
                exerciseId: cableExercise.id,
                sets: 3,
                repMin: 8,
                repMax: 12,
                targetLoad: 60,
                restSec: 90,
                supersetKey: null,
                notes: null,
              },
            ],
          },
        ],
        changeSummary: "fixture",
        auditAction: "program.activate",
        auditSummary: "fixture",
      });
      expect(activated.ok).toBe(true);

      const loaded = await loadEquipmentInventoryDocument(db, userId);
      const document = loaded!.document;
      const cableItem = document.items.find((item) => item.type === "cable")!;
      const dumbbellItem = document.items.find((item) => item.type === "dumbbell")!;

      const result = await previewInventoryDocumentChanges(db, userId, {
        baseRevision: document.baseRevision,
        items: [
          // Cable stack omitted → retire; bench added → new availability.
          dumbbellItem,
          { id: null, type: "bench", label: "Flat bench", quantity: 1, attrs: {} },
          { id: null, type: "barbell", label: "Olympic bar", quantity: 1, attrs: { unit: "lb" } },
        ],
        plates: [{ id: null, denomination: 45, quantity: 2 }],
        bars: [
          {
            id: null,
            barType: "olympic",
            barWeight: 45,
            collarWeight: 0,
            quantity: 1,
            label: "Olympic bar",
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const preview = result.preview;
      expect(preview.added).toEqual([
        { label: "Flat bench", type: "bench" },
        { label: "Olympic bar", type: "barbell" },
      ]);
      expect(preview.removed).toEqual([
        expect.objectContaining({ id: cableItem.id, label: "Cable stack" }),
      ]);
      expect(preview.plateChanges).toEqual([
        { denomination: 45, fromQuantity: null, toQuantity: 2 },
      ]);
      expect(preview.barChanges).toEqual([
        expect.objectContaining({ barType: "olympic", added: true }),
      ]);
      expect(preview.impact.exercisesBecomingUnavailable).toEqual([
        { id: cableExercise.id, name: cableExercise.name },
      ]);
      expect(preview.impact.exercisesBecomingAvailable).toEqual([
        { id: benchExercise.id, name: benchExercise.name },
      ]);
      expect(preview.impact.affectedProgramSlots).toEqual([
        { dayName: "Pull day", exerciseName: cableExercise.name },
      ]);
      expect(preview.requiresConfirmation).toBe(true);
      expect(preview.noChanges).toBe(false);

      const stale = await previewInventoryDocumentChanges(db, userId, {
        ...document,
        baseRevision: "stale-revision",
      });
      expect(stale).toMatchObject({ ok: false, code: "stale" });

      const unchanged = await previewInventoryDocumentChanges(db, userId, document);
      expect(unchanged.ok && unchanged.preview.noChanges).toBe(true);
      expect(unchanged.ok && unchanged.preview.requiresConfirmation).toBe(false);
    },
    60_000
  );

  it(
    "treats the final saved plate size as the capability boundary even when legacy plate and bodyweight rows remain",
    async () => {
      const [plateExercise] = await db
        .insert(exercises)
        .values({
          name: `Plate-loaded exercise ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "barbell",
        })
        .returning();
      await db.insert(exerciseEquipmentRequirements).values({
        exerciseId: plateExercise.id,
        equipmentType: "plates",
        minWeight: null,
      });
      const compatibilityRows = await db
        .insert(equipmentItems)
        .values([
          {
            userId,
            type: "plates",
            label: "Legacy plate marker",
            quantity: 1,
            attrs: {},
            available: true,
          },
          {
            userId,
            type: "bodyweight",
            label: "Legacy bodyweight marker",
            quantity: 1,
            attrs: {},
            available: true,
          },
        ])
        .returning();
      await db.insert(plateInventory).values({
        userId,
        denomination: 45,
        quantity: 1,
      });

      const loaded = await loadEquipmentInventoryDocument(db, userId);
      const preview = await previewInventoryDocumentChanges(db, userId, {
        ...loaded!.document,
        plates: [],
      });

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.preview.impact.exercisesBecomingUnavailable).toEqual([
        { id: plateExercise.id, name: plateExercise.name },
      ]);
      expect(preview.preview.requiresConfirmation).toBe(true);

      const saved = await saveInventoryDocumentForManagement(db, userId, {
        ...loaded!.document,
        plates: [],
      });
      expect(saved).toMatchObject({ ok: true, changed: true });
      expect(
        await db.query.equipmentItems.findMany({
          where: eq(equipmentItems.userId, userId),
        })
      ).toEqual(compatibilityRows);
      expect(
        await db.query.plateInventory.findMany({
          where: eq(plateInventory.userId, userId),
        })
      ).toEqual([]);
    },
    60_000
  );

  it("onboarding saves preserve stored collar weights and refuse unknown stable IDs", async () => {
    const first = await saveInventoryWithVersions(db, userId, [
      onboardingItem("barbell", "Olympic bar", { unit: "lb", barWeight: 45 }),
    ]);
    expect(first).toMatchObject({ ok: true });
    const [bar] = await db.query.barbellConfigs.findMany({
      where: eq(barbellConfigs.userId, userId),
    });
    await db
      .update(barbellConfigs)
      .set({ collarWeight: 5.5 })
      .where(eq(barbellConfigs.id, bar.id));

    const second = await saveInventoryWithVersions(db, userId, [
      onboardingItem("barbell", "Olympic bar", {
        barConfigId: bar.id,
        unit: "lb",
        barWeight: 44,
      }),
    ]);
    expect(second).toMatchObject({ ok: true });
    expect(
      await db.query.barbellConfigs.findFirst({
        where: eq(barbellConfigs.id, bar.id),
      })
    ).toMatchObject({ barWeight: 44, collarWeight: 5.5 });

    const third = await saveInventoryWithVersions(db, userId, [
      onboardingItem("barbell", "Olympic bar", {
        barConfigId: bar.id,
        unit: "lb",
        barWeight: 44,
        collarWeight: 0,
      }),
    ]);
    expect(third).toMatchObject({ ok: true });
    expect(await db.query.barbellConfigs.findFirst({ where: eq(barbellConfigs.id, bar.id) }))
      .toMatchObject({ barWeight: 44, collarWeight: 0 });

    const fourth = await saveInventoryWithVersions(db, userId, [
      onboardingItem("barbell", "Olympic bar", {
        barConfigId: bar.id,
        unit: "lb",
        barWeight: 44,
        collarWeight: 2.5,
      }),
    ]);
    expect(fourth).toMatchObject({ ok: true });
    expect(await db.query.barbellConfigs.findFirst({ where: eq(barbellConfigs.id, bar.id) }))
      .toMatchObject({ barWeight: 44, collarWeight: 2.5 });

    const before = await countHistory(db, userId);
    const unknown = await saveInventoryWithVersions(db, userId, [
      onboardingItem("bench", "Ghost bench", { id: crypto.randomUUID() }),
    ]);
    expect(unknown).toMatchObject({
      ok: false,
      reason:
        "This form no longer matches your saved equipment. Reload the page and try again.",
    });
    expect(await countHistory(db, userId)).toEqual(before);
  });

  it("refuses first-time setup activation for a completed account inside the database gate", async () => {
    const [exercise] = await db
      .insert(exercises)
      .values({
        name: `Completed guard squat ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
    await db
      .update(userProfiles)
      .set({ setupCompletedAt: new Date() })
      .where(eq(userProfiles.id, profileId));

    const result = await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
      programName: "Should not exist",
      days: [
        {
          name: "Day A",
          exercises: [
            {
              exerciseId: exercise.id,
              sets: 3,
              repMin: 5,
              repMax: 8,
              targetLoad: null,
              restSec: 90,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Should fail",
      auditAction: "program.activate",
      auditSummary: "Should fail",
      completeSetup: true,
    });
    expect(result.ok).toBe(false);
    expect(await db.query.programs.findMany({ where: eq(programs.userId, userId) })).toHaveLength(0);
    expect(await db.query.programVersions.findMany()).toHaveLength(0);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.userId, userId))).toHaveLength(0);

    // The same shape without completed setup still succeeds (control case).
    await db
      .update(userProfiles)
      .set({ setupCompletedAt: null })
      .where(eq(userProfiles.id, profileId));
    const allowed = await activateProgramAtomically(db, {
      userId,
      loadUnit: "lb",
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
              targetLoad: null,
              restSec: 90,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Created in guided setup",
      auditAction: "program.activate",
      auditSummary: "Program v1 activated from guided setup",
      completeSetup: true,
    });
    expect(allowed.ok).toBe(true);
  });

  it("reviews and atomically round-trips exact bar, machine, cable, and attachment profiles", async () => {
    const ids = {
      ez: crypto.randomUUID(), machine: crypto.randomUUID(), cable: crypto.randomUUID(),
      attachment: crypto.randomUUID(), plateSmall: crypto.randomUUID(), plateLarge: crypto.randomUUID(),
      machineProfile: crypto.randomUUID(), cableProfile: crypto.randomUUID(),
      attachmentProfile: crypto.randomUUID(),
    };
    await client.exec(`
      INSERT INTO equipment_items (id, user_id, type, label) VALUES
        ('${ids.ez}', '${userId}', 'ez_bar', '18 lb EZ-curl bar'),
        ('${ids.machine}', '${userId}', 'machine', 'Plate-loaded press'),
        ('${ids.cable}', '${userId}', 'cable', 'Cable station'),
        ('${ids.attachment}', '${userId}', 'other', 'Rope attachment');
      INSERT INTO plate_inventory (id, user_id, denomination, unit, quantity) VALUES
        ('${ids.plateSmall}', '${userId}', 1.25, 'lb', 2),
        ('${ids.plateLarge}', '${userId}', 10, 'lb', 4);
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, collar_weight, label
      ) VALUES ('${userId}', 'ez', '${ids.ez}', 'lb', 'ez', true, 18, 0, '18 lb EZ-curl bar');
      INSERT INTO plate_loaded_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty,
        starting_resistance, starting_resistance_unit, loading_point_count,
        balancing_rule, target_entry_meaning
      ) VALUES ('${ids.machineProfile}', '${userId}', '${ids.machine}', 'known', 20, 'lb', 2, 'identical_each_point', 'total_system');
      INSERT INTO cable_attachment_profiles (
        id, user_id, equipment_item_id, attachment_kind, connection_standard, status
      ) VALUES ('${ids.attachmentProfile}', '${userId}', '${ids.attachment}', 'rope', NULL, 'unknown');
      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty, stack_count,
        topology, displayed_unit, ratio_status
      ) VALUES ('${ids.cableProfile}', '${userId}', '${ids.cable}', 'partial', 1, 'shared_selection', 'lb', 'unknown');
      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index, displayed_load
      ) VALUES ('${userId}', '${ids.cableProfile}', 0, 0, 10);
    `);

    const loaded = await loadEquipmentInventoryDocument(db, userId);
    expect(loaded).not.toBeNull();
    const profiles = loaded!.document.loadProfiles!.map((entry) => {
      if (entry.profile.kind === "plate_loaded_machine") {
        return { ...entry, profile: { ...entry.profile, startingResistance: 25, compatiblePlateIds: [ids.plateSmall, ids.plateLarge] } };
      }
      if (entry.profile.kind === "cable_machine") {
        return { ...entry, profile: { ...entry.profile, geometryCertainty: "known" as const, ratioStatus: "known" as const, ratioNumerator: 2, ratioDenominator: 1, compatibleAttachmentItemIds: [ids.attachment], stackSteps: [{ ...entry.profile.stackSteps[0], displayedLoad: 12.5, positionLabel: "Pin 1" }] } };
      }
      if (entry.profile.kind === "attachment") {
        return { ...entry, profile: { ...entry.profile, status: "known" as const, connectionStandard: "carabiner" } };
      }
      return entry;
    });
    const edited = { ...loaded!.document, loadProfiles: profiles };
    const preview = await previewInventoryDocumentChanges(db, userId, edited);
    expect(preview.ok && preview.preview.loadProfileChanges).toHaveLength(3);

    const saved = await saveInventoryDocumentForManagement(db, userId, edited);
    expect(saved.ok).toBe(true);
    expect(saved.ok && saved.changed).toBe(true);

    const reloaded = await loadEquipmentInventoryDocument(db, userId);
    const machine = reloaded!.document.loadProfiles!.find((entry) => entry.equipmentItemId === ids.machine)?.profile;
    const cable = reloaded!.document.loadProfiles!.find((entry) => entry.equipmentItemId === ids.cable)?.profile;
    const attachment = reloaded!.document.loadProfiles!.find((entry) => entry.equipmentItemId === ids.attachment)?.profile;
    expect(machine).toMatchObject({ startingResistance: 25, compatiblePlateIds: expect.arrayContaining([ids.plateSmall, ids.plateLarge]) });
    expect(cable).toMatchObject({ ratioStatus: "known", ratioNumerator: 2, ratioDenominator: 1, compatibleAttachmentItemIds: [ids.attachment], stackSteps: [expect.objectContaining({ displayedLoad: 12.5, positionLabel: "Pin 1" })] });
    expect(attachment).toMatchObject({ status: "known", connectionStandard: "carabiner" });
    expect(reloaded!.document.loadProfiles!.find((entry) => entry.equipmentItemId === ids.ez)?.profile).toMatchObject({ emptyWeight: 18, sharedPlatePoolCompatible: true });

    const stale = await saveInventoryDocumentForManagement(db, userId, edited);
    expect(stale).toMatchObject({ ok: false, code: "stale" });
  });

  it("creates profile children together on first save and removes omitted profiles with version evidence", async () => {
    const machineId = crypto.randomUUID();
    const cableId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const plateId = crypto.randomUUID();
    await client.exec(`
      INSERT INTO equipment_items (id, user_id, type, label) VALUES
        ('${machineId}', '${userId}', 'machine', 'New plate machine'),
        ('${cableId}', '${userId}', 'cable', 'New cable station'),
        ('${attachmentId}', '${userId}', 'other', 'New rope');
      INSERT INTO plate_inventory (id, user_id, denomination, unit, quantity)
      VALUES ('${plateId}', '${userId}', 5, 'lb', 4);
    `);
    const loaded = await loadEquipmentInventoryDocument(db, userId);
    const firstSave: EquipmentInventoryDocument = {
      ...loaded!.document,
      loadProfiles: [
        {
          equipmentItemId: machineId,
          profile: {
            kind: "plate_loaded_machine", id: null, geometryCertainty: "known",
            startingResistance: 15, startingResistanceUnit: "lb", loadingPointCount: 2,
            balancingRule: "identical_each_point", targetEntryMeaning: "total_system",
            compatiblePlateIds: [plateId],
          },
        },
        {
          equipmentItemId: attachmentId,
          profile: {
            kind: "attachment", id: null, attachmentKind: "rope",
            connectionStandard: "carabiner", status: "known",
          },
        },
        {
          equipmentItemId: cableId,
          profile: {
            kind: "cable_machine", id: null, geometryCertainty: "known",
            stackCount: 1, topology: "shared_selection", displayedUnit: "lb",
            ratioStatus: "unknown", ratioNumerator: null, ratioDenominator: null,
            stackSteps: [{ id: null, stackIndex: 0, stepIndex: 0, displayedLoad: 7.5, positionLabel: "Top pin" }],
            compatibleAttachmentItemIds: [attachmentId],
          },
        },
      ],
    };
    const created = await saveInventoryDocumentForManagement(db, userId, firstSave);
    expect(created).toMatchObject({ ok: true });

    const afterCreate = await loadEquipmentInventoryDocument(db, userId);
    expect(afterCreate!.document.loadProfiles).toHaveLength(3);
    expect(afterCreate!.document.loadProfiles!.find((entry) => entry.equipmentItemId === machineId)?.profile).toMatchObject({ compatiblePlateIds: [plateId] });
    expect(afterCreate!.document.loadProfiles!.find((entry) => entry.equipmentItemId === cableId)?.profile).toMatchObject({ compatibleAttachmentItemIds: [attachmentId], stackSteps: [expect.objectContaining({ displayedLoad: 7.5, positionLabel: "Top pin" })] });
    await expect(
      saveInventoryDocumentForManagement(db, userId, afterCreate!.document),
    ).resolves.toMatchObject({ ok: true, changed: false });

    const afterNoop = await loadEquipmentInventoryDocument(db, userId);

    const foreignUserId = crypto.randomUUID();
    const foreignPlateId = crypto.randomUUID();
    await client.exec(`
      INSERT INTO users (id, email) VALUES ('${foreignUserId}', 'foreign-profile-${foreignUserId}@example.com');
      INSERT INTO user_profiles (user_id, unit) VALUES ('${foreignUserId}', 'lb');
      INSERT INTO plate_inventory (id, user_id, denomination, unit, quantity)
      VALUES ('${foreignPlateId}', '${foreignUserId}', 25, 'lb', 2);
    `);
    const foreignDraft: EquipmentInventoryDocument = {
      ...afterNoop!.document,
      loadProfiles: afterNoop!.document.loadProfiles!.map((entry) =>
        entry.profile.kind === "plate_loaded_machine"
          ? { ...entry, profile: { ...entry.profile, compatiblePlateIds: [foreignPlateId] } }
          : entry
      ),
    };
    await expect(saveInventoryDocumentForManagement(db, userId, foreignDraft)).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });

    const beforeRemove = await loadEquipmentInventoryDocument(db, userId);
    const removed = await saveInventoryDocumentForManagement(db, userId, {
      ...beforeRemove!.document,
      loadProfiles: [],
    });
    expect(removed.ok).toBe(true);
    const afterRemove = await loadEquipmentInventoryDocument(db, userId);
    expect(afterRemove!.document.loadProfiles).toEqual([]);
    const removalVersions = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM record_versions
      WHERE user_id = '${userId}' AND action = 'equipment_profile.remove'
    `);
    expect(removalVersions.rows[0]?.count).toBe(3);
  });

  it("atomically creates plate-loaded, weight-stack, and unknown machines from one draft", async () => {
    const plateId = crypto.randomUUID();
    await client.exec(`
      INSERT INTO plate_inventory (id, user_id, denomination, unit, quantity)
      VALUES ('${plateId}', '${userId}', 10, 'lb', 4);
    `);
    const loaded = await loadEquipmentInventoryDocument(db, userId);
    const draftId = crypto.randomUUID();
    const stackDraftId = crypto.randomUUID();
    const unknownDraftId = crypto.randomUUID();
    const draft: EquipmentInventoryDocument = {
      ...loaded!.document,
      items: [
        ...loaded!.document.items,
        {
          id: null,
          draftId,
          type: "machine",
          label: "Two-sided Lat Pulldown",
          quantity: 1,
          attrs: {},
        },
        {
          id: null,
          draftId: stackDraftId,
          type: "cable",
          label: "Selectorized Lat Pulldown",
          quantity: 1,
          attrs: {},
        },
        {
          id: null,
          draftId: unknownDraftId,
          type: "machine",
          label: "Unreviewed machine",
          quantity: 1,
          attrs: {},
        },
      ],
      loadProfiles: [
        ...(loaded!.document.loadProfiles ?? []),
        {
          equipmentItemId: draftId,
          profile: {
            kind: "plate_loaded_machine",
            id: null,
            geometryCertainty: "known",
            startingResistance: 20,
            startingResistanceUnit: "lb",
            loadingPointCount: 2,
            balancingRule: "identical_each_point",
            targetEntryMeaning: "total_system",
            compatiblePlateIds: [plateId],
          },
        },
        {
          equipmentItemId: stackDraftId,
          profile: {
            kind: "cable_machine",
            id: null,
            geometryCertainty: "unknown",
            stackCount: null,
            topology: null,
            displayedUnit: null,
            ratioStatus: "unknown",
            ratioNumerator: null,
            ratioDenominator: null,
            stackSteps: [],
            compatibleAttachmentItemIds: [],
          },
        },
      ],
    };

    expect(validateEquipmentInventoryDocument(draft)).toMatchObject({ ok: true });
    await expect(
      saveInventoryDocumentForManagement(db, userId, draft),
    ).resolves.toMatchObject({ ok: true });

    const reloaded = await loadEquipmentInventoryDocument(db, userId);
    expect(
      reloaded!.document.items.find((item) => item.id === draftId),
    ).toMatchObject({
      id: draftId,
      type: "machine",
      label: "Two-sided Lat Pulldown",
    });
    expect(
      reloaded!.document.loadProfiles!.find(
        (entry) => entry.equipmentItemId === draftId,
      )?.profile,
    ).toMatchObject({
      kind: "plate_loaded_machine",
      loadingPointCount: 2,
      targetEntryMeaning: "total_system",
      compatiblePlateIds: [plateId],
    });
    expect(
      reloaded!.document.loadProfiles!.find(
        (entry) => entry.equipmentItemId === stackDraftId,
      )?.profile,
    ).toMatchObject({
      kind: "cable_machine",
      geometryCertainty: "unknown",
    });
    expect(
      reloaded!.document.items.find((item) => item.id === unknownDraftId),
    ).toMatchObject({
      type: "machine",
      label: "Unreviewed machine",
    });
    expect(
      reloaded!.document.loadProfiles!.some(
        (entry) => entry.equipmentItemId === unknownDraftId,
      ),
    ).toBe(false);
  });

  it("changes one saved machine between plate-loaded, weight-stack, and unknown without changing item identity", async () => {
    const itemId = crypto.randomUUID();
    await client.exec(`
      INSERT INTO equipment_items (id, user_id, type, label, attrs, available)
      VALUES ('${itemId}', '${userId}', 'machine', 'Convertible station', '{}', true);
      INSERT INTO plate_loaded_machine_profiles (
        user_id, equipment_item_id, geometry_certainty, starting_resistance,
        starting_resistance_unit, loading_point_count, balancing_rule,
        target_entry_meaning
      )
      VALUES (
        '${userId}', '${itemId}', 'known', 20, 'lb', 2,
        'identical_each_point', 'total_system'
      );
    `);

    const plateLoaded = await loadEquipmentInventoryDocument(db, userId);
    const toStack: EquipmentInventoryDocument = {
      ...plateLoaded!.document,
      items: plateLoaded!.document.items.map((item) =>
        item.id === itemId ? { ...item, type: "cable" as const } : item,
      ),
      loadProfiles: [
        {
          equipmentItemId: itemId,
          profile: {
            kind: "cable_machine",
            id: null,
            geometryCertainty: "unknown",
            stackCount: null,
            topology: null,
            displayedUnit: null,
            ratioStatus: "unknown",
            ratioNumerator: null,
            ratioDenominator: null,
            stackSteps: [],
            compatibleAttachmentItemIds: [],
          },
        },
      ],
    };
    await expect(
      saveInventoryDocumentForManagement(db, userId, toStack),
    ).resolves.toMatchObject({ ok: true });

    const stacked = await loadEquipmentInventoryDocument(db, userId);
    expect(
      stacked!.document.items.find((item) => item.id === itemId),
    ).toMatchObject({ id: itemId, type: "cable" });
    expect(stacked!.document.loadProfiles).toEqual([
      expect.objectContaining({
        equipmentItemId: itemId,
        profile: expect.objectContaining({
          kind: "cable_machine",
          geometryCertainty: "unknown",
        }),
      }),
    ]);

    const toUnknown: EquipmentInventoryDocument = {
      ...stacked!.document,
      loadProfiles: [],
    };
    await expect(
      saveInventoryDocumentForManagement(db, userId, toUnknown),
    ).resolves.toMatchObject({ ok: true });
    const unknown = await loadEquipmentInventoryDocument(db, userId);
    expect(
      unknown!.document.items.find((item) => item.id === itemId),
    ).toMatchObject({ id: itemId, type: "cable" });
    expect(unknown!.document.loadProfiles).toEqual([]);

    const backToPlate: EquipmentInventoryDocument = {
      ...unknown!.document,
      items: unknown!.document.items.map((item) =>
        item.id === itemId ? { ...item, type: "machine" as const } : item,
      ),
      loadProfiles: [
        {
          equipmentItemId: itemId,
          profile: {
            kind: "plate_loaded_machine",
            id: null,
            geometryCertainty: "unknown",
            startingResistance: null,
            startingResistanceUnit: null,
            loadingPointCount: null,
            balancingRule: null,
            targetEntryMeaning: null,
            compatiblePlateIds: [],
          },
        },
      ],
    };
    await expect(
      saveInventoryDocumentForManagement(db, userId, backToPlate),
    ).resolves.toMatchObject({ ok: true });
    const reloaded = await loadEquipmentInventoryDocument(db, userId);
    expect(
      reloaded!.document.items.find((item) => item.id === itemId),
    ).toMatchObject({ id: itemId, type: "machine" });
    expect(reloaded!.document.loadProfiles).toEqual([
      expect.objectContaining({
        equipmentItemId: itemId,
        profile: expect.objectContaining({
          kind: "plate_loaded_machine",
          geometryCertainty: "unknown",
        }),
      }),
    ]);
  });

});
