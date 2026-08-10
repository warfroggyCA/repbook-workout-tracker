import { describe, expect, it } from "vitest";
import {
  classifyExerciseEvidenceTier,
  classifyExerciseIdentityScope,
  hasOneExactCompletedWorkingOccurrence,
  resolveReviewedExerciseMapping,
  tierWithReviewedMapping,
} from "@/lib/history-exercise-evidence";

describe("V2 H03 adversarial identity boundaries", () => {
  it("fails closed for cross-owner exercise identities", () => {
    expect(
      classifyExerciseIdentityScope({
        ownerId: "owner-a",
        exerciseOwnerId: "owner-b",
        createdFromImportEventId: null,
      }),
    ).toBeNull();
  });

  it("rejects missing, duplicate, wrong-kind, and incomplete occurrence links", () => {
    const exact = {
      kind: "working_set",
      outcome: "completed",
      completedSetId: "set-1",
    };
    expect(hasOneExactCompletedWorkingOccurrence("set-1", [exact])).toBe(true);
    expect(hasOneExactCompletedWorkingOccurrence("set-1", [])).toBe(false);
    expect(hasOneExactCompletedWorkingOccurrence("set-1", [exact, exact])).toBe(
      false,
    );
    expect(
      hasOneExactCompletedWorkingOccurrence("set-1", [
        { ...exact, kind: "exercise_warmup" },
      ]),
    ).toBe(false);
  });

  it("uses conservative tier precedence", () => {
    const base = {
      source: "hevy",
      importBatchId: "batch",
      occurrenceOrigin: "imported",
      performedSemanticFacet: "supported" as const,
      exactOccurrenceLinked: true,
      corrected: false,
    };
    expect(classifyExerciseEvidenceTier(base)).toBe("imported");
    expect(classifyExerciseEvidenceTier({ ...base, corrected: true })).toBe(
      "corrected",
    );
    expect(
      classifyExerciseEvidenceTier({
        ...base,
        corrected: true,
        exactOccurrenceLinked: false,
      }),
    ).toBe("legacy");
    expect(
      classifyExerciseEvidenceTier({
        ...base,
        corrected: true,
        performedSemanticFacet: "unsupported",
      }),
    ).toBe("unsupported");
  });

  it("keeps reviewed mappings source-specific and fails closed on missing or mismatched bindings", () => {
    const mapping = {
      id: "mapping-1",
      source: "hevy",
      normalizedKey: "press|barbell|",
      sourceName: "Press",
      sourceEquipment: "barbell",
      exerciseId: "exercise-1",
      confirmedAtISO: "2026-08-01T12:00:00.000Z",
    };
    expect(
      resolveReviewedExerciseMapping({
        source: "hevy",
        performedExerciseId: "exercise-1",
        normalizedKey: "press|barbell|",
        mappings: [mapping],
      }),
    ).toEqual({ status: "confirmed", mapping });
    expect(
      resolveReviewedExerciseMapping({
        source: "other-source",
        performedExerciseId: "exercise-1",
        normalizedKey: "press|barbell|",
        mappings: [mapping],
      }),
    ).toEqual({ status: "not_applicable", mapping: null });
    expect(
      resolveReviewedExerciseMapping({
        source: "hevy",
        performedExerciseId: "exercise-2",
        normalizedKey: "press|barbell|",
        mappings: [mapping],
      }).status,
    ).toBe("inconsistent");
    expect(
      resolveReviewedExerciseMapping({
        source: "hevy",
        performedExerciseId: "exercise-1",
        normalizedKey: "missing|barbell|",
        mappings: [mapping],
      }).status,
    ).toBe("missing");
    expect(
      resolveReviewedExerciseMapping({
        source: "hevy",
        performedExerciseId: "exercise-1",
        normalizedKey: null,
        mappings: [mapping],
      }).status,
    ).toBe("missing");
    expect(tierWithReviewedMapping("imported", "missing")).toBe("legacy");
    expect(tierWithReviewedMapping("corrected", "inconsistent")).toBe(
      "unsupported",
    );
  });
});
