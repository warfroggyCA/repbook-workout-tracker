import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import {
  constraints,
  exerciseEquipmentRequirements,
  exerciseFamilies,
  exercises,
  sessionExercises,
  users,
  workoutSessions,
} from "@/db/schema";
import {
  workoutReplacementEquipmentWarning,
  workoutReplacementUnavailableReason,
} from "@/lib/exercise-replacements";
import { workoutLocalDate } from "@/lib/workout-calendar";
import { getExerciseReplacementOptions } from "@/services/exercise-replacements";

describe("workout replacement contract", () => {
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

  it("searches unrelated exercises, warns for missing equipment, and enforces performed-shape and constraint boundaries", async () => {
    const fixtureTimezone = "America/Toronto";
    const fixtureStartedAt = new Date("2026-07-25T04:11:21.555Z");
    const fixtureLocalDate = workoutLocalDate(fixtureStartedAt, fixtureTimezone);
    expect(fixtureLocalDate).toBe("2026-07-25");
    const [{ id: userId }] = await db
      .insert(users)
      .values({ email: `replacement-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    const families = await db
      .insert(exerciseFamilies)
      .values([
        {
          key: `press-${crypto.randomUUID()}`,
          name: `Press ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
        },
        {
          key: `hinge-${crypto.randomUUID()}`,
          name: `Hinge ${crypto.randomUUID()}`,
          movementPattern: "hinge",
          primaryMuscles: ["hamstrings"],
        },
        {
          key: `pull-${crypto.randomUUID()}`,
          name: `Pull ${crypto.randomUUID()}`,
          movementPattern: "vertical_pull",
          primaryMuscles: ["back"],
        },
        {
          key: `conditioning-${crypto.randomUUID()}`,
          name: `Conditioning ${crypto.randomUUID()}`,
          movementPattern: "conditioning",
          primaryMuscles: ["whole body"],
        },
        {
          key: `carry-${crypto.randomUUID()}`,
          name: `Carry ${crypto.randomUUID()}`,
          movementPattern: "carry",
          primaryMuscles: ["core"],
        },
      ])
      .returning();
    const [planned, unrelated, missingEquipment, unsupported, constrained] =
      await db
        .insert(exercises)
        .values([
          {
            familyId: families[0]!.id,
            name: `Planned press ${crypto.randomUUID()}`,
            movementPattern: "horizontal_push",
            primaryMuscles: ["chest"],
            loadType: "barbell",
          },
          {
            familyId: families[1]!.id,
            name: `Unrelated hinge ${crypto.randomUUID()}`,
            movementPattern: "hinge",
            primaryMuscles: ["hamstrings"],
            loadType: "dumbbell",
          },
          {
            familyId: families[2]!.id,
            name: `Unavailable cable pull ${crypto.randomUUID()}`,
            movementPattern: "vertical_pull",
            primaryMuscles: ["back"],
            loadType: "external",
          },
          {
            familyId: families[3]!.id,
            name: `Unsupported interval ${crypto.randomUUID()}`,
            movementPattern: "conditioning",
            primaryMuscles: ["whole body"],
            activityClass: "conditioning",
            metricType: "duration",
            loadType: "bodyweight",
            loadSemantics: "none",
          },
          {
            familyId: families[4]!.id,
            name: `Blocked carry ${crypto.randomUUID()}`,
            movementPattern: "carry",
            primaryMuscles: ["core"],
            loadType: "dumbbell",
          },
        ])
        .returning();
    await db.insert(exerciseEquipmentRequirements).values({
      exerciseId: missingEquipment.id,
      equipmentType: "cable",
    });
    await db.insert(constraints).values({
      userId,
      bodyPart: "back",
      affectedPatterns: ["carry"],
      avoid: true,
      cautious: false,
      painStopThreshold: 2,
    });
    const [{ id: sessionId }] = await db
      .insert(workoutSessions)
      .values({
        userId,
        status: "in_progress",
        startedAt: fixtureStartedAt,
        timezone: fixtureTimezone,
        localDate: fixtureLocalDate,
      })
      .returning({ id: workoutSessions.id });
    const [{ id: sessionExerciseId }] = await db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId: planned.id,
        targetSets: 3,
        targetRepsMin: 8,
        targetRepsMax: 10,
      })
      .returning({ id: sessionExercises.id });

    const options = await getExerciseReplacementOptions(
      db,
      userId,
      sessionExerciseId,
    );
    const byId = new Map(options.items.map((item) => [item.id, item]));

    expect(byId.get(unrelated.id)).toMatchObject({
      available: true,
      unavailableReason: null,
    });
    expect(byId.get(missingEquipment.id)).toMatchObject({
      available: true,
      unavailableReason: null,
      missingEquipment: ["cable"],
    });
    expect(options.warnings[missingEquipment.id]).toMatch(
      /Needs cable station.*will not invent or reuse an incompatible setup/i,
    );
    expect(byId.get(unsupported.id)).toMatchObject({
      available: true,
      unavailableReason: null,
    });
    expect(byId.get(constrained.id)).toMatchObject({
      available: false,
      unavailableReason: "Blocked by your current safety constraints.",
    });
  });
});

describe("replacement presentation rules", () => {
  it("keeps unavailable equipment advisory while unsupported performed shapes stay blocked", () => {
    expect(
      workoutReplacementEquipmentWarning({
        id: "missing",
        name: "Cable exercise",
        family: null,
        movementPattern: "vertical_pull",
        primaryMuscles: ["back"],
        secondaryMuscles: [],
        equipment: ["cable"],
        loadType: "external",
        metricType: "weight_reps",
        loadSemantics: "machine_stack",
        variantAttributes: {},
        cautionBodyParts: [],
        available: false,
        unavailableReason: "Needs cable station.",
        missingEquipment: ["cable"],
      }),
    ).toMatch(/You can still replace/);
    expect(
      workoutReplacementUnavailableReason({
        id: "duration",
        name: "Timed hold",
        family: null,
        movementPattern: "core",
        primaryMuscles: ["core"],
        secondaryMuscles: [],
        equipment: [],
        loadType: "bodyweight",
        metricType: "duration",
        loadSemantics: "none",
        variantAttributes: {},
        cautionBodyParts: [],
        available: true,
        unavailableReason: null,
      }),
    ).toBeNull();
    expect(
      workoutReplacementUnavailableReason({
        id: "loaded-duration",
        name: "Loaded timed carry",
        family: null,
        movementPattern: "carry",
        primaryMuscles: ["core"],
        secondaryMuscles: [],
        equipment: ["dumbbell"],
        loadType: "external",
        metricType: "duration",
        loadSemantics: "added_weight",
        variantAttributes: {},
        cautionBodyParts: [],
        available: true,
        unavailableReason: null,
      }),
    ).toMatch(/load plus time or distance/i);
    expect(
      workoutReplacementUnavailableReason({
        id: "activity",
        name: "Independent activity",
        family: null,
        movementPattern: "conditioning",
        primaryMuscles: ["whole body"],
        secondaryMuscles: [],
        equipment: [],
        loadType: "bodyweight",
        metricType: "activity",
        loadSemantics: "none",
        variantAttributes: {},
        cautionBodyParts: [],
        available: true,
        unavailableReason: null,
      }),
    ).toMatch(/activity flow/i);
  });
});
