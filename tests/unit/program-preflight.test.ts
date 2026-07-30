import { describe, expect, it } from "vitest";
import {
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
  programDocumentSchema,
} from "@/lib/program-document";
import { runProgramPreflight } from "@/lib/program-preflight";

function fixture() {
  const slot = {
    lineageId: crypto.randomUUID(),
    exerciseId: crypto.randomUUID(),
    sets: 3,
    repMin: 5,
    repMax: 8,
    targetLoad: null,
    targetLoadUnit: null,
    progressionRuleId: "double_progression" as const,
    restSec: 120,
    supersetKey: null,
    notes: null,
    warmupNotes: null,
    warmupSets: [],
    setNotes: [null, null, null],
    intent: createSuggestedSlotIntent(3, 0),
  };
  const day = {
    lineageId: crypto.randomUUID(),
    name: "Strength A",
    notes: null,
    warmupNotes: null,
    intent: createSuggestedDayIntent([slot]),
    supersets: [],
    exercises: [slot],
  };
  return programDocumentSchema.parse({
    schemaVersion: "2",
    programId: crypto.randomUUID(),
    baseVersionId: crypto.randomUUID(),
    name: "Reviewed Program",
    days: [day],
  });
}

describe("Program Preflight", () => {
  it("uses a conservative planned range and states that comparable history is absent", () => {
    const document = fixture();
    const result = runProgramPreflight(document, {
      checkedAt: new Date("2026-07-17T12:00:00.000Z"),
    });

    expect(result.durations[0]).toMatchObject({
      basis: "planned_fallback",
      evidenceCount: 0,
    });
    expect(result.durations[0].minMinutes).toBeLessThanOrEqual(
      result.durations[0].maxMinutes,
    );
    expect(result.durations[0].explanation).toContain(
      "No comparable completed sessions",
    );
  });

  it("uses comparable day-lineage history only after enough completed sessions exist", () => {
    const document = fixture();
    const dayId = document.days[0].lineageId;

    const sparse = runProgramPreflight(document, {
      comparableDurationsByDay: { [dayId]: [42, 48] },
    });
    expect(sparse.durations[0]).toMatchObject({
      basis: "sparse_history",
      evidenceCount: 2,
    });

    const comparable = runProgramPreflight(document, {
      comparableDurationsByDay: { [dayId]: [40, 45, 50, 55] },
    });
    expect(comparable.durations[0]).toMatchObject({
      basis: "comparable_history",
      evidenceCount: 4,
      minMinutes: 40,
      maxMinutes: 50,
    });
  });

  it("honors a reviewed range override without presenting it as measured history", () => {
    const document = fixture();
    document.days[0].intent.durationOverride = {
      minMinutes: 35,
      maxMinutes: 50,
      note: "Reviewed after timing the commute and setup.",
    };
    const result = runProgramPreflight(document, {
      comparableDurationsByDay: {
        [document.days[0].lineageId]: [20, 21, 22],
      },
    });

    expect(result.durations[0]).toMatchObject({
      basis: "user_override",
      minMinutes: 35,
      maxMinutes: 50,
      evidenceCount: 3,
    });
    expect(result.durations[0].explanation).toContain("Reviewed user override");
  });

  it("separates impossible execution from cautious, non-diagnostic warnings", () => {
    const document = fixture();
    const slotId = document.days[0].exercises[0].lineageId;
    const result = runProgramPreflight(document, {
      unavailableSlotLineageIds: new Set([slotId]),
      cautiousSlotLineageIds: new Set([slotId]),
      painEvidenceBySlot: { [slotId]: 2 },
      equipmentEvidenceCount: 4,
      constraintEvidenceCount: 1,
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "blocking",
          code: "equipment_unavailable",
          slotLineageId: slotId,
          evidenceCount: 1,
          editPath: `slots.${slotId}.intent`,
        }),
        expect.objectContaining({
          severity: "warning",
          code: "active_caution_constraint",
        }),
        expect.objectContaining({
          severity: "warning",
          code: "recent_pain_association",
          evidenceCount: 2,
        }),
      ]),
    );
    expect(
      result.findings.find((finding) => finding.code === "recent_pain_association")
        ?.reason,
    ).toContain("does not prove");
  });
});
