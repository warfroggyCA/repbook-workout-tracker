import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  exerciseEquipmentRequirements,
  exerciseFamilies,
  exercises,
  equipmentItems,
  sessionExercises,
  users,
  workoutSessions,
} from "@/db/schema";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import {
  classifyExerciseAlternative,
  rankExerciseAlternatives,
} from "@/lib/exercise-alternatives";
import { getExerciseAlternativeOptions } from "@/services/exercise-alternatives";
import { getExerciseReplacementOptions } from "@/services/exercise-replacements";

function exercise(
  id: string,
  name: string,
  options: Partial<ExerciseDiscoveryItem> = {}
): ExerciseDiscoveryItem {
  return {
    id,
    name,
    family: "Bench Press",
    movementPattern: "horizontal_push",
    primaryMuscles: ["chest"],
    secondaryMuscles: ["triceps"],
    equipment: ["bench", "barbell", "rack"],
    loadType: "barbell",
    metricType: "weight_reps",
    loadSemantics: "total",
    variantAttributes: {},
    cautionBodyParts: [],
    available: true,
    unavailableReason: null,
    ...options,
  };
}

describe("exercise alternative ranking", () => {
  const planned = exercise("planned", "Barbell Bench Press");

  it("ranks family variants ahead of same-movement and broader same-muscle choices", () => {
    const ranked = rankExerciseAlternatives(planned, [
      exercise("muscle", "Cable Fly", {
        family: "Chest Fly",
        movementPattern: "isolation_arms",
        equipment: ["cable"],
      }),
      exercise("movement", "Push-up", {
        family: "Push-up",
        equipment: ["bodyweight"],
        loadType: "bodyweight",
      }),
      exercise("family", "Dumbbell Bench Press", {
        equipment: ["bench", "dumbbell"],
        loadType: "dumbbell",
      }),
    ]);

    expect(ranked.map((candidate) => candidate.item.id)).toEqual([
      "family",
      "movement",
      "muscle",
    ]);
    expect(ranked.map((candidate) => candidate.annotation.label)).toEqual([
      "Closest family variant",
      "Same movement",
      "Same primary muscle",
    ]);
    expect(ranked[2]?.annotation.description).toContain("not directly comparable");
  });

  it("does not treat secondary-muscle overlap alone as a safe alternative", () => {
    const curl = exercise("curl", "Biceps Curl", {
      family: "Biceps Curl",
      movementPattern: "isolation_arms",
      primaryMuscles: ["biceps"],
      secondaryMuscles: ["chest"],
      equipment: ["dumbbell"],
    });

    expect(classifyExerciseAlternative(planned, curl)).toBeNull();
  });

  it("keeps a same-family variant eligible even when its equipment changes", () => {
    const candidate = exercise("machine", "Machine Bench Press", {
      equipment: ["machine"],
      loadType: "external",
    });

    expect(classifyExerciseAlternative(planned, candidate)).toMatchObject({
      tier: "same_family",
      annotation: {
        description: expect.stringContaining("Equipment and loading setup differ"),
      },
    });
  });
});

describe("server-approved exercise alternative options", () => {
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

  it("shows the full library but makes only compatible, currently available choices executable", async () => {
    const [{ id: userId }] = await db
      .insert(users)
      .values({ email: `alternatives-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    const [benchFamily, flyFamily, rowFamily] = await db
      .insert(exerciseFamilies)
      .values([
        {
          key: `bench-${crypto.randomUUID()}`,
          name: `Bench family ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
        },
        {
          key: `fly-${crypto.randomUUID()}`,
          name: `Fly family ${crypto.randomUUID()}`,
          movementPattern: "isolation_arms",
          primaryMuscles: ["chest"],
        },
        {
          key: `row-${crypto.randomUUID()}`,
          name: `Row family ${crypto.randomUUID()}`,
          movementPattern: "horizontal_pull",
          primaryMuscles: ["back"],
        },
      ])
      .returning();
    const [planned, familyAlternative, muscleAlternative, secondaryOnly, unavailable] =
      await db
        .insert(exercises)
        .values([
          {
            familyId: benchFamily.id,
            name: `Planned press ${crypto.randomUUID()}`,
            movementPattern: "horizontal_push",
            primaryMuscles: ["chest"],
            secondaryMuscles: ["triceps"],
            loadType: "barbell",
            variantKey: "barbell",
          },
          {
            familyId: benchFamily.id,
            name: `Family press ${crypto.randomUUID()}`,
            movementPattern: "horizontal_push",
            primaryMuscles: ["chest"],
            loadType: "dumbbell",
            variantKey: "dumbbell",
          },
          {
            familyId: flyFamily.id,
            name: `Chest fly ${crypto.randomUUID()}`,
            movementPattern: "isolation_arms",
            primaryMuscles: ["chest"],
            loadType: "dumbbell",
          },
          {
            familyId: rowFamily.id,
            name: `Secondary chest row ${crypto.randomUUID()}`,
            movementPattern: "horizontal_pull",
            primaryMuscles: ["back"],
            secondaryMuscles: ["chest"],
            loadType: "dumbbell",
          },
          {
            familyId: benchFamily.id,
            name: `Cable press ${crypto.randomUUID()}`,
            movementPattern: "horizontal_push",
            primaryMuscles: ["chest"],
            loadType: "external",
            variantKey: "cable",
          },
        ])
        .returning();
    await db.insert(exerciseEquipmentRequirements).values({
      exerciseId: unavailable.id,
      equipmentType: "cable",
    });
    const [cableItem] = await db
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
    const [{ id: sessionId }] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Alternative test",
        status: "in_progress",
        startedAt: new Date("2026-07-13T14:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-13",
      })
      .returning({ id: workoutSessions.id });
    const [{ id: sessionExerciseId }] = await db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId: planned.id,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: planned.name,
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
      })
      .returning({ id: sessionExercises.id });

    const options = await getExerciseAlternativeOptions(
      db,
      userId,
      sessionExerciseId
    );
    const byId = new Map(options.items.map((item) => [item.id, item]));

    expect(options.priorityIds).toEqual(
      expect.arrayContaining([familyAlternative.id, muscleAlternative.id])
    );
    expect(byId.get(familyAlternative.id)?.available).toBe(true);
    expect(byId.get(muscleAlternative.id)?.available).toBe(true);
    expect(byId.get(secondaryOnly.id)).toMatchObject({
      available: false,
      unavailableReason: "Not close enough to the planned exercise for this workout",
    });
    expect(byId.get(unavailable.id)).toMatchObject({
      available: false,
      equipmentFitStatus: "unknown",
      unavailableReason: expect.stringContaining("owner-reviewed"),
    });

    // This represents a drawer left open while equipment changes elsewhere.
    // It remains blocked and the next read exposes the now-missing candidate.
    await db
      .update(equipmentItems)
      .set({ available: false })
      .where(eq(equipmentItems.id, cableItem.id));
    const afterEquipmentChange = await getExerciseAlternativeOptions(
      db,
      userId,
      sessionExerciseId
    );
    expect(
      afterEquipmentChange.items.find((item) => item.id === unavailable.id)
    ).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining("cable"),
    });

    const currentCatalogName = `Current catalog pull ${crypto.randomUUID()}`;
    await db
      .update(exercises)
      .set({
        name: currentCatalogName,
        familyId: rowFamily.id,
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        secondaryMuscles: ["biceps"],
      })
      .where(eq(exercises.id, planned.id));

    const reranked = await getExerciseAlternativeOptions(
      db,
      userId,
      sessionExerciseId,
    );
    expect(reranked).toMatchObject({
      plannedExerciseName: planned.name,
      plannedExercise: { name: currentCatalogName },
    });
    expect(
      reranked.items.find((item) => item.id === secondaryOnly.id),
    ).toMatchObject({ available: true });
    expect(
      reranked.items.find((item) => item.id === familyAlternative.id),
    ).toMatchObject({
      available: false,
      unavailableReason: "Not close enough to the planned exercise for this workout",
    });

    const replacements = await getExerciseReplacementOptions(
      db,
      userId,
      sessionExerciseId,
    );
    expect(replacements.plannedExerciseName).toBe(planned.name);
    expect(
      replacements.items.find((item) => item.id === secondaryOnly.id),
    ).toMatchObject({ available: true });
  });
});
