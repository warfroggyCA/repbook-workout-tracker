import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  exercises,
  painLogs,
  programs,
  programVersions,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import type { LoadedEquipmentLoadProfile } from "@/services/equipment-load-profiles";
import {
  buildSimulationSourceSnapshot,
  loadWorkoutSimulationSource,
  SIMULATION_SOURCE_MAX_ALTERNATIVES_PER_SLOT,
  SIMULATION_SOURCE_MAX_DAYS,
  type BuildSimulationSourceInput,
} from "@/services/workout-simulation-source";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

const ownerId = "20000000-0000-4000-8000-000000000001";

function exercise(overrides: Partial<ExerciseDiscoveryItem> = {}): ExerciseDiscoveryItem {
  return {
    id: "ez-curl",
    name: "EZ-Bar Curl",
    family: "curl",
    movementPattern: "isolation",
    primaryMuscles: ["biceps"],
    secondaryMuscles: ["forearms"],
    equipment: ["ez_bar", "plates"],
    loadType: "ez_bar",
    metricType: "weight_reps",
    loadSemantics: "total_system",
    variantAttributes: {},
    cautionBodyParts: [],
    available: true,
    unavailableReason: null,
    ...overrides,
  };
}

function program() {
  return {
    program: { id: "program-1", name: "Published Program" },
    version: { id: "version-4", versionNo: 4 },
    days: [{
      id: "day-1",
      lineageId: "day-lineage-1",
      name: "Arms",
      notes: null,
      orderIdx: 0,
      intent: null,
      warmupLines: ["Five easy minutes"],
      slots: [{
        id: "slot-1",
        lineageId: "slot-lineage-1",
        exercise: {
          id: "ez-curl",
          name: "EZ-Bar Curl",
          family: "curl",
          movementPattern: "isolation",
        },
        orderIdx: 0,
        supersetGroupId: null,
        superset: null,
        restSec: 75,
        notes: null,
        warmupNotes: null,
        warmupSets: [{
          label: "Easy curl",
          reps: 10,
          load: null,
          loadUnit: null,
          loadPercent: 50,
          loadText: null,
          notes: null,
        }],
        prescription: {
          sets: 3,
          repRangeMin: 8,
          repRangeMax: 12,
          targetLoad: 40,
          targetLoadUnit: "lb" as const,
          progressionRuleId: "double-progression",
        },
      }],
    }],
  } as BuildSimulationSourceInput["program"];
}

function input(capturedAtISO = "2026-07-22T12:00:00.000Z"): BuildSimulationSourceInput {
  const ezProfile: LoadedEquipmentLoadProfile = {
    equipmentItemId: "ez-item",
    itemType: "ez_bar",
    itemLabel: "18 lb EZ curl bar",
    equipmentDefinitionId: null,
    equipmentDefinitionKey: null,
    available: true,
    profile: {
      kind: "plate_loaded_implement",
      id: null,
      loadingKind: "ez",
      emptyWeight: 18,
      collarWeight: 0,
      unit: "lb",
      sharedPlatePoolCompatible: true,
    },
  };
  return {
    ownerId,
    capturedAtISO,
    program: program(),
    library: [
      exercise(),
      exercise({ id: "db-curl", name: "Dumbbell Curl", equipment: ["dumbbell"], loadType: "dumbbell" }),
      exercise({ id: "unavailable-curl", name: "Unavailable Curl", available: false, unavailableReason: "Not owned" }),
    ],
    equipmentItems: [
      { type: "plates", available: true, maxWeight: null },
      { type: "ez_bar", available: true, maxWeight: null },
      { type: "dumbbell", available: true, maxWeight: 50 },
    ],
    plates: [
      { id: "plate-10", denomination: 10, quantity: 2, unit: "lb" },
      { id: "plate-2-5", denomination: 2.5, quantity: 2, unit: "lb" },
      { id: "plate-1-25", denomination: 1.25, quantity: 2, unit: "lb" },
    ],
    profiles: [ezProfile],
    constraints: [{
      id: "constraint-1",
      bodyPart: "elbow",
      affectedPatterns: ["isolation"],
      avoid: false,
      cautious: true,
      painStopThreshold: 3,
      note: "Keep the motion comfortable.",
    }],
    painEvidenceByExerciseId: { "ez-curl": 1, "db-curl": 2 },
    displayLoadUnit: "lb",
    broadRequirementsByExerciseId: {
      "ez-curl": [
        { equipmentType: "ez_bar", minWeight: null },
        { equipmentType: "plates", minWeight: null },
      ],
      "db-curl": [{ equipmentType: "dumbbell", minWeight: 40 }],
    },
    exactRequirementsByExerciseId: {},
    slotSupplementsById: {
      "slot-1": { groupMemberOrderIdx: null, setNotes: [] },
    },
    groupSupplementsById: {},
  };
}

describe("workout simulation source snapshot", () => {
  let database: TestDatabase | null = null;

  afterEach(async () => {
    await database?.close();
    database = null;
  });

  it("uses the owned 18 lb EZ bar and complete shared plate pool without hardcoded substitutions", () => {
    const snapshot = buildSimulationSourceSnapshot(input());
    const curl = snapshot.days[0]!.exercises[0]!;

    expect(curl.equipmentOptions).toHaveLength(1);
    expect(curl.equipmentOptions[0]!.label).toBe("18 lb EZ curl bar");
    expect(curl.equipmentOptions[0]!.guidance).toContain("18 lb");
    expect(curl.equipmentOptions[0]!.guidance).toContain("38 lb");
    expect(curl.equipmentOptions[0]!.guidance).toContain("40.5 lb");
    expect(curl.alternatives.map((alternative) => alternative.exerciseId)).toContain("db-curl");
    expect(curl.alternatives.map((alternative) => alternative.exerciseId)).not.toContain("unavailable-curl");
    expect(curl.painGuidance.join(" ")).toContain("elbow");
    expect(curl.painGuidance.join(" ")).toContain("1 recent pain entry");
    expect(curl.painGuidance.join(" ")).toContain("3/10 or higher");
    expect(curl.painGuidance.join(" ")).not.toContain("/5");
    expect(curl.alternatives.find((alternative) => alternative.exerciseId === "db-curl")?.painGuidance)
      .toContain("2 recent pain entries apply to this exercise.");
  });

  it("distinguishes avoid, cautious, and threshold-only constraints on the 0–10 pain scale", () => {
    const constrained = input();
    constrained.constraints = [
      {
        id: "avoid",
        bodyPart: "wrist",
        affectedPatterns: ["isolation"],
        avoid: true,
        cautious: false,
        painStopThreshold: 2,
        note: null,
      },
      {
        id: "cautious",
        bodyPart: "elbow",
        affectedPatterns: ["isolation"],
        avoid: false,
        cautious: true,
        painStopThreshold: 3,
        note: null,
      },
      {
        id: "recorded",
        bodyPart: "shoulder",
        affectedPatterns: ["isolation"],
        avoid: false,
        cautious: false,
        painStopThreshold: 4,
        note: null,
      },
    ];

    const guidance = buildSimulationSourceSnapshot(constrained).days[0]!.exercises[0]!.painGuidance;
    expect(guidance).toContain("Avoid isolation movements involving wrist. Stop if pain reaches 2/10 or higher.");
    expect(guidance).toContain("Use caution with elbow. Stop if pain reaches 3/10 or higher.");
    expect(guidance).toContain("A shoulder constraint is recorded for this movement. Stop if pain reaches 4/10 or higher.");
  });

  it("excludes exact alternatives without a compatible attachment and preserves unknown-geometry honesty", () => {
    const cableItemId = "30000000-0000-4000-8000-000000000001";
    const compatibleAttachmentId = "30000000-0000-4000-8000-000000000002";
    const unlinkedAttachmentId = "30000000-0000-4000-8000-000000000003";
    const candidate = input();
    candidate.library.push(
      exercise({
        id: "cable-compatible",
        name: "Compatible Cable Curl",
        equipment: ["cable"],
        loadType: "cable",
      }),
      exercise({
        id: "cable-unlinked",
        name: "Unlinked Cable Curl",
        equipment: ["cable"],
        loadType: "cable",
      }),
    );
    candidate.equipmentItems.push({ type: "cable", available: true, maxWeight: null });
    candidate.profiles.push(
      {
        equipmentItemId: cableItemId,
        itemType: "cable",
        itemLabel: "Garage cable station",
        equipmentDefinitionId: null,
        equipmentDefinitionKey: null,
        available: true,
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
          compatibleAttachmentItemIds: [compatibleAttachmentId],
        },
      },
      {
        equipmentItemId: compatibleAttachmentId,
        itemType: "cable_attachment",
        itemLabel: "Compatible rope",
        equipmentDefinitionId: null,
        equipmentDefinitionKey: null,
        available: true,
        profile: {
          kind: "attachment",
          id: null,
          attachmentKind: "rope",
          connectionStandard: null,
          status: "known",
        },
      },
      {
        equipmentItemId: unlinkedAttachmentId,
        itemType: "cable_attachment",
        itemLabel: "Owned but unlinked lat bar",
        equipmentDefinitionId: null,
        equipmentDefinitionKey: null,
        available: true,
        profile: {
          kind: "attachment",
          id: null,
          attachmentKind: "lat_bar",
          connectionStandard: null,
          status: "known",
        },
      },
    );
    candidate.broadRequirementsByExerciseId["cable-compatible"] = [
      { equipmentType: "cable", minWeight: null },
    ];
    candidate.broadRequirementsByExerciseId["cable-unlinked"] = [
      { equipmentType: "cable", minWeight: null },
    ];
    candidate.exactRequirementsByExerciseId["cable-compatible"] = {
      requiredProfileKind: "cable_machine",
      requiredEquipmentDefinitionId: null,
      requiredAttachmentKind: "rope",
      requiredAttachmentDefinitionId: null,
      requiresKnownGeometry: false,
    };
    candidate.exactRequirementsByExerciseId["cable-unlinked"] = {
      requiredProfileKind: "cable_machine",
      requiredEquipmentDefinitionId: null,
      requiredAttachmentKind: "lat_bar",
      requiredAttachmentDefinitionId: null,
      requiresKnownGeometry: false,
    };

    const alternatives = buildSimulationSourceSnapshot(candidate).days[0]!.exercises[0]!.alternatives;
    const compatible = alternatives.find((alternative) => alternative.exerciseId === "cable-compatible");
    expect(compatible?.equipmentOptions).toEqual([expect.objectContaining({
      label: "Garage cable station + Compatible rope",
      guidance: "Cable geometry is unknown. Record the displayed stack setting only; effective load is unknown.",
    })]);
    expect(JSON.stringify(compatible)).not.toMatch(/exact pin|nominal handle|effective load [0-9]/i);
    expect(alternatives.map((alternative) => alternative.exerciseId)).not.toContain("cable-unlinked");
  });

  it("applies the alternative limit after removing unsafe exact candidates", () => {
    const bounded = input();
    bounded.library.push(...Array.from(
      { length: SIMULATION_SOURCE_MAX_ALTERNATIVES_PER_SLOT + 4 },
      (_, index) => exercise({
        id: `safe-curl-${index}`,
        name: `Safe Curl ${String(index).padStart(2, "0")}`,
        equipment: ["dumbbell"],
        loadType: "dumbbell",
      }),
    ));
    expect(buildSimulationSourceSnapshot(bounded).days[0]!.exercises[0]!.alternatives)
      .toHaveLength(SIMULATION_SOURCE_MAX_ALTERNATIVES_PER_SLOT);
  });

  it("has a stable digest for unchanged source facts and a different capture timestamp", () => {
    const first = buildSimulationSourceSnapshot(input("2026-07-22T12:00:00.000Z"));
    const reordered = input("2026-07-22T13:00:00.000Z");
    reordered.library.reverse();
    reordered.plates.reverse();
    reordered.equipmentItems.reverse();
    const second = buildSimulationSourceSnapshot(reordered);

    expect(second.sourceDigest).toBe(first.sourceDigest);
    expect(second.capturedAtISO).not.toBe(first.capturedAtISO);
    expect(JSON.parse(JSON.stringify(second))).toEqual(second);
  });

  it("rejects an unbounded source instead of silently truncating it", () => {
    const oversized = input();
    oversized.program.days = Array.from({ length: SIMULATION_SOURCE_MAX_DAYS + 1 }, (_, index) => ({
      ...oversized.program.days[0]!,
      id: `day-${index}`,
      orderIdx: index,
    }));
    expect(() => buildSimulationSourceSnapshot(oversized)).toThrow(/day count/i);
  });

  it("keeps the source service read-only and scopes every owner-controlled query", () => {
    const source = readFileSync("src/services/workout-simulation-source.ts", "utf8");
    expect(source).not.toMatch(/@\/app\/actions|\.insert\(|\.update\(|\.delete\(/);
    expect(source).toContain("getActiveProgramPresentation(db, userId)");
    expect(source).toContain("getExerciseDiscoveryLibrary(db, userId)");
    expect(source).toContain("loadEquipmentLoadProfiles(db, userId)");
    expect(source).toContain("eq(equipmentItems.userId, userId)");
    expect(source).toContain("eq(plateInventory.userId, userId)");
    expect(source).toContain("eq(constraintsTable.userId, userId)");
    expect(source).toContain("eq(userProfiles.userId, userId)");
    expect(source).toContain("eq(painLogs.userId, userId)");
  });

  it("loads only the requested owner's Program and pain evidence without changing either owner's data", async () => {
    database = await createMigratedTestDatabase();
    const db = database.db;
    const [owner, otherOwner] = await db.insert(users).values([
      { email: `simulation-owner-${crypto.randomUUID()}@example.com` },
      { email: `simulation-other-${crypto.randomUUID()}@example.com` },
    ]).returning({ id: users.id });
    await db.insert(userProfiles).values([
      { userId: owner.id, unit: "lb" },
      { userId: otherOwner.id, unit: "kg" },
    ]);
    const [planned, alternative] = await db.insert(exercises).values([
      {
        name: `Owner planned ${crypto.randomUUID()}`,
        movementPattern: "isolation_arms" as const,
        primaryMuscles: ["biceps"],
        loadType: "bodyweight" as const,
        metricType: "weight_reps" as const,
      },
      {
        name: `Owner alternative ${crypto.randomUUID()}`,
        movementPattern: "isolation_arms" as const,
        primaryMuscles: ["biceps"],
        loadType: "bodyweight" as const,
        metricType: "weight_reps" as const,
      },
    ]).returning({ id: exercises.id });

    async function addActiveProgram(userId: string, name: string) {
      await db.transaction(async (tx) => {
        const [programRow] = await tx.insert(programs).values({
          userId,
          name,
          status: "archived",
          archivedAt: new Date("2026-07-01T00:00:00.000Z"),
        }).returning({ id: programs.id });
        const [version] = await tx.insert(programVersions).values({
          programId: programRow.id,
          name,
        }).returning({ id: programVersions.id });
        const [day] = await tx.insert(workoutTemplates).values({
          programVersionId: version.id,
          name: `${name} day`,
        }).returning({ id: workoutTemplates.id });
        await tx.insert(workoutTemplateExercises).values({
          workoutTemplateId: day.id,
          exerciseId: planned.id,
        });
        await tx.update(programs).set({
          status: "active",
          archivedAt: null,
          currentVersionId: version.id,
        }).where(eq(programs.id, programRow.id));
      });
    }
    await addActiveProgram(owner.id, "Requested owner Program");
    await addActiveProgram(otherOwner.id, "Other owner private Program");
    const evidenceTime = new Date("2026-07-21T12:00:00.000Z");
    const [ownerPainSession, otherPainSession] = await db
      .insert(workoutSessions)
      .values([
        {
          userId: owner.id,
          status: "completed",
          startedAt: evidenceTime,
          finishedAt: new Date("2026-07-21T13:00:00.000Z"),
          timezone: "UTC",
          localDate: "2026-07-21",
        },
        {
          userId: otherOwner.id,
          status: "completed",
          startedAt: evidenceTime,
          finishedAt: new Date("2026-07-21T13:00:00.000Z"),
          timezone: "UTC",
          localDate: "2026-07-21",
        },
      ])
      .returning({ id: workoutSessions.id });
    await db.insert(painLogs).values([
      {
        userId: owner.id,
        sessionId: ownerPainSession.id,
        exerciseId: alternative.id,
        bodyPart: "elbow",
        severity: 2,
        createdAt: evidenceTime,
      },
      {
        userId: otherOwner.id,
        sessionId: otherPainSession.id,
        exerciseId: alternative.id,
        bodyPart: "elbow",
        severity: 5,
        createdAt: evidenceTime,
      },
    ]);
    const before = {
      programs: await db.select().from(programs),
      profiles: await db.select().from(userProfiles),
      pain: await db.select().from(painLogs),
    };

    const snapshot = await loadWorkoutSimulationSource(
      db,
      owner.id,
      new Date("2026-07-22T12:00:00.000Z"),
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.ownerId).toBe(owner.id);
    expect(snapshot?.program.name).toBe("Requested owner Program");
    expect(JSON.stringify(snapshot)).not.toContain("Other owner private Program");
    expect(snapshot?.days[0]?.exercises[0]?.alternatives.find(
      (candidate) => candidate.exerciseId === alternative.id,
    )?.painGuidance).toContain("1 recent pain entry applies to this exercise.");
    expect({
      programs: await db.select().from(programs),
      profiles: await db.select().from(userProfiles),
      pain: await db.select().from(painLogs),
    }).toEqual(before);
  }, 30_000);
});
