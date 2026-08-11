import { describe, expect, it } from "vitest";
import {
  isExerciseEquipmentItemFitRecommendationSafe,
  isExerciseEquipmentFitRecommendationSafe,
  resolveExerciseEquipmentFit,
  type ExerciseEquipmentFitAssertion,
} from "@/lib/exercise-equipment-fit";

const exerciseId = "10000000-0000-4000-8000-000000000001";
const cableId = "20000000-0000-4000-8000-000000000001";
const evidenceRevision = "a".repeat(32);

function assertion(
  verdict: "compatible" | "incompatible",
  overrides: Partial<ExerciseEquipmentFitAssertion> = {},
): ExerciseEquipmentFitAssertion {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    exerciseId,
    equipmentItemId: cableId,
    verdict,
    reasonCode: verdict === "compatible" ? "owner_verified" : "geometry_limit",
    reasonNote: verdict === "compatible" ? null : "The pulley cannot reach the required position.",
    provenance: "owner_review",
    semanticsVersion: 1,
    evidenceRevision,
    revision: 1,
    ...overrides,
  };
}

function resolve(assertions: ExerciseEquipmentFitAssertion[]) {
  return resolveExerciseEquipmentFit({
    exerciseId,
    requirements: [{
      id: "40000000-0000-4000-8000-000000000001",
      equipmentType: "cable",
      equipmentDefinitionId: null,
      minWeight: null,
    }],
    items: [{
      id: cableId,
      type: "cable",
      definitionId: null,
      available: true,
      attrs: {},
    }],
    assertions,
    currentEvidenceRevisions: new Map([[cableId, evidenceRevision]]),
  });
}

describe("durable exercise/equipment fit meaning", () => {
  it("keeps a broad matching cable station unknown when no assertion exists", () => {
    const result = resolve([]);

    expect(result).toMatchObject({
      status: "unknown",
      candidateEquipmentItemIds: [cableId],
      compatibleEquipmentItemIds: [],
      unknownEquipmentItemIds: [cableId],
    });
    expect(isExerciseEquipmentFitRecommendationSafe(result)).toBe(false);
  });

  it("retains an exact incompatible station by stable IDs even when labels could collide", () => {
    const result = resolve([assertion("incompatible")]);

    expect(result).toMatchObject({
      status: "incompatible",
      incompatibleEquipmentItemIds: [cableId],
      assertions: [{
        equipmentItemId: cableId,
        verdict: "incompatible",
        reasonCode: "geometry_limit",
        revision: 1,
      }],
    });
    expect(result.reason).toContain("explicitly incompatible");
    expect(isExerciseEquipmentFitRecommendationSafe(result)).toBe(false);
  });

  it("requires one explicit compatible candidate for every item-backed requirement", () => {
    const compatible = resolve([assertion("compatible")]);
    expect(compatible.status).toBe("compatible");
    expect(isExerciseEquipmentFitRecommendationSafe(compatible)).toBe(true);

    const missingSecondRequirement = resolveExerciseEquipmentFit({
      exerciseId,
      requirements: [
        { equipmentType: "cable", equipmentDefinitionId: null, minWeight: null },
        { equipmentType: "bench", equipmentDefinitionId: null, minWeight: null },
      ],
      items: [{ id: cableId, type: "cable", available: true, attrs: {} }],
      assertions: [assertion("compatible")],
    });
    expect(missingSecondRequirement.status).toBe("missing");
    expect(isExerciseEquipmentFitRecommendationSafe(missingSecondRequirement)).toBe(false);
    expect(
      isExerciseEquipmentItemFitRecommendationSafe(
        missingSecondRequirement,
        cableId,
      ),
    ).toBe(false);
  });

  it("does not treat cross-exercise, malformed, duplicate, or stale semantics as compatible", () => {
    const cases = [
      [assertion("compatible", { exerciseId: "10000000-0000-4000-8000-000000000099" })],
      [assertion("compatible", { semanticsVersion: 2 })],
      [assertion("compatible"), assertion("incompatible", { id: "30000000-0000-4000-8000-000000000002" })],
      [assertion("compatible", { revision: 0 })],
    ];

    for (const assertions of cases) {
      expect(resolve(assertions).status).toBe("unknown");
    }
  });

  it("makes a retained assertion stale when current pair evidence changes", () => {
    const result = resolveExerciseEquipmentFit({
      exerciseId,
      requirements: [{ equipmentType: "cable", minWeight: null }],
      items: [{ id: cableId, type: "cable", available: true, attrs: {} }],
      assertions: [assertion("compatible")],
      currentEvidenceRevisions: new Map([[cableId, "b".repeat(32)]]),
    });

    expect(result.status).toBe("unknown");
    expect(result.staleEquipmentItemIds).toEqual([cableId]);
    expect(result.reason).toContain("stale");
  });

  it("does not promote exact profile candidates into movement-specific compatibility", () => {
    const result = resolveExerciseEquipmentFit({
      exerciseId,
      requirements: [{ equipmentType: "cable", minWeight: null }],
      items: [{ id: cableId, type: "cable", available: true, attrs: {} }],
      assertions: [],
    });

    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("no current owner-reviewed");
  });

  it("does not require item assertions for bodyweight or the retained plate pool", () => {
    for (const equipmentType of ["bodyweight", "plates"]) {
      const result = resolveExerciseEquipmentFit({
        exerciseId,
        requirements: [{ equipmentType, minWeight: null }],
        items: [],
        assertions: [],
      });
      expect(result.status).toBe("not_required");
      expect(isExerciseEquipmentFitRecommendationSafe(result)).toBe(true);
    }
  });

  it("matches definitions and capacity without using display names", () => {
    const definitionId = "50000000-0000-4000-8000-000000000001";
    const result = resolveExerciseEquipmentFit({
      exerciseId,
      requirements: [{
        equipmentType: "dumbbell",
        equipmentDefinitionId: definitionId,
        minWeight: 40,
      }],
      items: [
        { id: cableId, type: "dumbbell", definitionId, available: true, attrs: { maxWeight: 35 } },
        { id: "20000000-0000-4000-8000-000000000002", type: "dumbbell", definitionId: null, available: true, attrs: { maxWeight: 80 } },
      ],
      assertions: [assertion("compatible")],
    });
    expect(result.status).toBe("missing");
    expect(result.candidateEquipmentItemIds).toEqual([]);
  });
});
