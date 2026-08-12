import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  barbellConfigs,
  equipmentItems,
  exerciseEquipmentRequirements,
  exercises,
  plateInventory,
  programs,
  recommendations,
  workoutSessions,
  sessionExercises,
  completedSets,
  userProfiles,
  users,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { saveInventoryDocumentForManagement } from "@/services/setup-persistence";
import { loadEquipmentInventoryDocument } from "@/services/equipment-inventory";
import { getLibraryWithAvailability } from "@/services/routine-import";
import { achievableLoads, solvePlates } from "@/engine/plate-math";
import { platePairsPerSide } from "@/lib/equipment-inventory-contract";
import { saveExerciseEquipmentFitAssertion } from "@/services/exercise-equipment-fit-management";

/**
 * Stage 3 downstream consistency: after a management save, exercise
 * availability, plate math inputs, and the current Program all agree with the
 * saved inventory — and nothing about the Program or its versions changes as
 * a side effect.
 */
describe("equipment management downstream consistency", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `equipment-downstream-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(userProfiles).values({ userId });
  }, 60_000);

  afterEach(async () => {
    await client.close();
  });

  it(
    "keeps the Program untouched while availability, plate math, and alternatives inputs follow the saved inventory exactly",
    async () => {
      const [cableExercise] = await db
        .insert(exercises)
        .values({
          name: `Cable Row DS ${crypto.randomUUID()}`,
          movementPattern: "horizontal_pull",
          primaryMuscles: ["back"],
          loadType: "cable",
        })
        .returning();
      const [benchExercise] = await db
        .insert(exercises)
        .values({
          name: `Bench Press DS ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "barbell",
        })
        .returning();
      await db.insert(exerciseEquipmentRequirements).values([
        { exerciseId: cableExercise.id, equipmentType: "cable", minWeight: null },
        { exerciseId: benchExercise.id, equipmentType: "bench", minWeight: null },
      ]);
      const [cableItem] = await db.insert(equipmentItems).values([
        { userId, type: "cable", label: "Cable stack", quantity: 1, attrs: {}, available: true },
        { userId, type: "barbell", label: "Olympic bar", quantity: 1, attrs: { unit: "lb" }, available: true },
      ]).returning({ id: equipmentItems.id, type: equipmentItems.type });
      if (cableItem.type !== "cable") throw new Error("Cable fixture order changed.");
      await expect(saveExerciseEquipmentFitAssertion(db, userId, {
        mutationId: crypto.randomUUID(),
        assertionId: null,
        exerciseId: cableExercise.id,
        equipmentItemId: cableItem.id,
        verdict: "compatible",
        reasonCode: "owner_verified",
        reasonNote: null,
        expectedRevision: null,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await db.insert(plateInventory).values([
        { userId, denomination: 45, quantity: 4 },
        { userId, denomination: 25, quantity: 2 },
      ]);
      await db.insert(barbellConfigs).values([
        { userId, barType: "olympic", barWeight: 45, collarWeight: 0, quantity: 1, label: "Olympic bar" },
      ]);

      const activated = await activateProgramAtomically(db, {
        userId,
        loadUnit: "lb",
        programName: "Downstream program",
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
      if (!activated.ok) return;

      const programBefore = await db.query.programs.findFirst({
        where: eq(programs.id, activated.programId),
      });
      const versionsBefore = await db.query.programVersions.findMany();
      const templatesBefore = await db.query.workoutTemplates.findMany();
      const slotsBefore = await db.query.workoutTemplateExercises.findMany();
      const prescriptionsBefore = await db.query.exercisePrescriptions.findMany();

      const [template] = templatesBefore;
      const [slot] = slotsBefore;
      const [completedSession, activeSession] = await db
        .insert(workoutSessions)
        .values([
          {
            userId,
            templateId: template.id,
            templateName: template.name,
            status: "completed",
            timezone: "America/Toronto",
            localDate: "2026-07-13",
            startedAt: new Date("2026-07-13T14:00:00Z"),
            finishedAt: new Date("2026-07-13T15:00:00Z"),
          },
          {
            userId,
            templateId: template.id,
            templateName: template.name,
            status: "in_progress",
            timezone: "America/Toronto",
            localDate: "2026-07-15",
            startedAt: new Date("2026-07-15T14:00:00Z"),
          },
        ])
        .returning();
      const [completedExercise, activeExercise] = await db
        .insert(sessionExercises)
        .values([
          {
            sessionId: completedSession.id,
            exerciseId: cableExercise.id,
            plannedFromTemplateExerciseId: slot.id,
            orderIdx: 0,
            targetSets: 3,
            targetRepsMin: 8,
            targetRepsMax: 12,
            targetLoad: 60,
            targetLoadUnit: "lb",
          },
          {
            sessionId: activeSession.id,
            exerciseId: cableExercise.id,
            plannedFromTemplateExerciseId: slot.id,
            orderIdx: 0,
            targetSets: 3,
            targetRepsMin: 8,
            targetRepsMax: 12,
            targetLoad: 60,
            targetLoadUnit: "lb",
          },
        ])
        .returning();
      await db.insert(completedSets).values({
        sessionExerciseId: completedExercise.id,
        setNo: 1,
        weight: 60,
        weightUnit: "lb",
        reps: 10,
      });
      const sessionsBefore = await db.query.workoutSessions.findMany();
      const sessionExercisesBefore = await db.query.sessionExercises.findMany();
      const setsBefore = await db.query.completedSets.findMany();
      expect(activeExercise.sessionId).toBe(activeSession.id);

      const libraryBefore = await getLibraryWithAvailability(db, userId);
      expect(
        libraryBefore.find((entry) => entry.id === cableExercise.id)?.available
      ).toBe(true);
      expect(
        libraryBefore.find((entry) => entry.id === benchExercise.id)?.available
      ).toBe(false);

      // Management save: retire the cable stack, add a bench, change plate
      // pairs, add a fractional plate, and set an exact collar weight.
      const loaded = await loadEquipmentInventoryDocument(db, userId);
      const document = loaded!.document;
      const saved = await saveInventoryDocumentForManagement(db, userId, {
        baseRevision: document.baseRevision,
        items: [
          ...document.items.filter((item) => item.type !== "cable"),
          { id: null, type: "bench", label: "Flat bench", quantity: 1, attrs: { adjustableBench: false } },
        ],
        plates: [
          {
            ...document.plates.find((plate) => plate.denomination === 45)!,
            quantity: 6,
          },
          document.plates.find((plate) => plate.denomination === 25)!,
          { id: null, denomination: 1.25, quantity: 2 },
        ],
        bars: [
          { ...document.bars[0], barWeight: 44, collarWeight: 5.5 },
        ],
      });
      expect(saved).toMatchObject({ ok: true, changed: true });

      // The Program and every version, template, slot, and prescription are
      // byte-for-byte unchanged, and no recommendation appeared.
      expect(
        await db.query.programs.findFirst({ where: eq(programs.id, activated.programId) })
      ).toEqual(programBefore);
      expect(await db.query.programVersions.findMany()).toEqual(versionsBefore);
      expect(await db.query.workoutTemplates.findMany()).toEqual(templatesBefore);
      expect(await db.query.workoutTemplateExercises.findMany()).toEqual(slotsBefore);
      expect(await db.query.exercisePrescriptions.findMany()).toEqual(
        prescriptionsBefore
      );
      expect(await db.query.workoutSessions.findMany()).toEqual(sessionsBefore);
      expect(await db.query.sessionExercises.findMany()).toEqual(
        sessionExercisesBefore
      );
      expect(await db.query.completedSets.findMany()).toEqual(setsBefore);
      expect(
        await db.query.recommendations.findMany({
          where: eq(recommendations.userId, userId),
        })
      ).toHaveLength(0);

      // Discovery and alternatives read availability from the saved rows.
      const libraryAfter = await getLibraryWithAvailability(db, userId);
      const cableAfter = libraryAfter.find((entry) => entry.id === cableExercise.id);
      expect(cableAfter?.available).toBe(false);
      expect(cableAfter?.missing).toEqual(["cable"]);
      expect(
        libraryAfter.find((entry) => entry.id === benchExercise.id)?.available
      ).toBe(true);

      // Plate math consumes the exact saved plate, bar, and collar values.
      const [barRow] = await db.query.barbellConfigs.findMany({
        where: eq(barbellConfigs.userId, userId),
      });
      const plateRows = await db.query.plateInventory.findMany({
        where: eq(plateInventory.userId, userId),
      });
      const config = {
        barWeight: barRow.barWeight,
        collarWeight: barRow.collarWeight,
        plates: plateRows.map((plate) => ({
          denomination: plate.denomination,
          countPerSide: platePairsPerSide(plate.quantity),
        })),
      };
      expect(config).toMatchObject({ barWeight: 44, collarWeight: 5.5 });
      const loads = achievableLoads(config);
      // Bar + collars alone.
      expect(loads[0]).toBe(49.5);
      // 45×3 per side now solvable: 44 + 5.5 + 270 = 319.5.
      expect(solvePlates(319.5, config)?.perSide).toEqual([45, 45, 45]);
      // The new fractional plate creates exact 2.5 lb total steps.
      expect(loads).toContain(52);
    },
    60_000
  );
});
