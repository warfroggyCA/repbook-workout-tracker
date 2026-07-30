import { describe, expect, it } from "vitest";
import {
  compileSession,
  SESSION_COMPILER_ALGORITHM_VERSION,
  sessionCompilerInputSchema,
  sessionCompilerOutputSchema,
  type SessionCompilerInput,
} from "@/lib/session-compiler";

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  program: "00000000-0000-4000-8000-000000000002",
  version: "00000000-0000-4000-8000-000000000003",
  template: "00000000-0000-4000-8000-000000000004",
  day: "00000000-0000-4000-8000-000000000005",
  anchor: "00000000-0000-4000-8000-000000000006",
  optional: "00000000-0000-4000-8000-000000000007",
  anchorSlot: "00000000-0000-4000-8000-000000000008",
  optionalSlot: "00000000-0000-4000-8000-000000000009",
  anchorExercise: "00000000-0000-4000-8000-000000000010",
  optionalExercise: "00000000-0000-4000-8000-000000000011",
};

function intent(priority: "must" | "should" | "could", minimum: number, ideal: number, protectedOrder = false) {
  return {
    role: priority === "must" ? "anchor" as const : "accessory" as const,
    priority,
    minimumDose: { unit: "sets" as const, value: minimum },
    idealDose: { unit: "sets" as const, value: ideal },
    protectedOrder,
    substitutionPolicy: priority === "must" ? "exact_only" as const : "approved_family" as const,
    omissionPolicy: priority === "must" ? "never" as const : "allowed" as const,
    calibrationEligible: priority === "must",
    note: null,
  };
}

function input(overrides: Partial<SessionCompilerInput> = {}): SessionCompilerInput {
  const day = {
    lineageId: ids.day,
    name: "Upper strength",
    notes: null,
    warmupNotes: null,
    intent: {
      primaryOutcome: "strength" as const,
      secondaryOutcomes: ["hypertrophy" as const],
      identity: { kind: "anchor_slots" as const, anchorSlotLineageIds: [ids.anchor] },
      targetDuration: { minMinutes: 35, maxMinutes: 50 },
      minimumUsefulDurationMinutes: 20,
      fatigueTolerance: "normal" as const,
      orderingPolicy: "preserve" as const,
      pairingPolicy: "preserve" as const,
      durationOverride: null,
      note: null,
    },
    supersets: [],
    exercises: [
      { lineageId: ids.anchor, exerciseId: ids.anchorExercise, sets: 3, repMin: 5, repMax: 8, targetLoad: 100, targetLoadUnit: "lb" as const, progressionRuleId: "hold", restSec: 180, supersetKey: null, notes: null, warmupNotes: null, warmupSets: [], setNotes: [null, null, null], intent: intent("must", 3, 3, true) },
      { lineageId: ids.optional, exerciseId: ids.optionalExercise, sets: 4, repMin: 8, repMax: 12, targetLoad: null, targetLoadUnit: null, progressionRuleId: "hold", restSec: 90, supersetKey: null, notes: null, warmupNotes: null, warmupSets: [], setNotes: [null, null, null, null], intent: intent("could", 2, 4) },
    ],
  };
  return {
    algorithmVersion: SESSION_COMPILER_ALGORITHM_VERSION,
    userId: ids.user,
    programId: ids.program,
    programVersionId: ids.version,
    programVersionNo: 2,
    programReviewHash: null,
    programDocumentHash: "a".repeat(64),
    documentSchemaVersion: 2,
    templateId: ids.template,
    day,
    exercises: [
      { slotLineageId: ids.anchor, templateExerciseId: ids.anchorSlot, exerciseId: ids.anchorExercise, exerciseName: "Bench press", orderIdx: 0, supersetKey: null, sets: 3, repMin: 5, repMax: 8, targetLoad: 100, targetLoadUnit: "lb", restSec: 180, notes: null, warmupNotes: null, warmupSets: [], setNotes: [null, null, null], intent: intent("must", 3, 3, true) },
      { slotLineageId: ids.optional, templateExerciseId: ids.optionalSlot, exerciseId: ids.optionalExercise, exerciseName: "Lateral raise", orderIdx: 1, supersetKey: null, sets: 4, repMin: 8, repMax: 12, targetLoad: null, targetLoadUnit: null, restSec: 90, notes: null, warmupNotes: null, warmupSets: [], setNotes: [null, null, null, null], intent: intent("could", 2, 4) },
    ],
    requestedMinutes: 40,
    energy: "usual",
    confirmedConstraintSlotLineageIds: [],
    busyEquipmentSlotLineageIds: [],
    preflight: {
      algorithmVersion: "phase2-rule-range-v1",
      checkedAt: "2026-07-18T00:00:00.000Z",
      durations: [{ dayLineageId: ids.day, minMinutes: 35, maxMinutes: 50, basis: "planned_fallback", evidenceCount: 0, explanation: "No comparable sessions; planned fallback." }],
      findings: [],
      environment: { equipmentEvidenceCount: 2, constraintEvidenceCount: 0, painEvidenceCount: 0 },
    },
    preflightEvidenceToken: "a".repeat(32),
    ...overrides,
  };
}

describe("Session Compiler", () => {
  it("is deterministic and reduces only lower-priority sets without crossing the reviewed minimum", () => {
    const source = input();
    const first = compileSession(source);
    const second = compileSession(structuredClone(source));
    expect(second).toEqual(first);
    expect(first.status).toBe("ready");
    expect(first.duration?.maxMinutes).toBeLessThanOrEqual(source.requestedMinutes);
    expect(first.exercises[0]).toMatchObject({ exerciseName: "Bench press", sets: 3, sourceSets: 3, disposition: "full" });
    expect(first.exercises[1].sets).toBeGreaterThanOrEqual(2);
    expect(first.exercises[1].sets).toBeLessThan(4);
    expect(source.exercises[1].sets).toBe(4);
  });

  it("keeps released v1 proposal evidence readable but refuses to execute it", () => {
    const current = input();
    const currentOutput = compileSession(current);
    const historicalInput = {
      ...current,
      algorithmVersion: "phase3-deterministic-v1" as const,
    };
    const historicalOutput = {
      ...currentOutput,
      algorithmVersion: "phase3-deterministic-v1" as const,
    };
    expect(sessionCompilerInputSchema.safeParse(historicalInput).success).toBe(true);
    expect(sessionCompilerOutputSchema.safeParse(historicalOutput).success).toBe(true);
    expect(() => compileSession(historicalInput)).toThrow(/historical/i);
  });

  it("abstains below the reviewed day minimum, on Preflight blockers, and on unsupported dose units", () => {
    expect(compileSession(input({ requestedMinutes: 19 }))).toMatchObject({ status: "unable", exercises: [] });
    expect(compileSession(input({ confirmedConstraintSlotLineageIds: [ids.anchor] }))).toMatchObject({ status: "unable", exercises: [] });
    expect(compileSession(input({ busyEquipmentSlotLineageIds: [ids.optional] }))).toMatchObject({ status: "unable", exercises: [] });
    const blocked = input();
    blocked.preflight.findings.push({ id: `equipment:${ids.anchor}`, severity: "blocking", code: "equipment_unavailable", reason: "Unavailable", dayLineageId: ids.day, slotLineageId: ids.anchor, evidenceCount: 1, editPath: `slots.${ids.anchor}.intent` });
    expect(compileSession(blocked)).toMatchObject({ status: "unable", exercises: [] });
    const unsupported = input();
    unsupported.exercises[1].intent.minimumDose.unit = "minutes";
    unsupported.exercises[1].intent.idealDose.unit = "minutes";
    unsupported.day.exercises[1].intent.minimumDose.unit = "minutes";
    unsupported.day.exercises[1].intent.idealDose.unit = "minutes";
    expect(compileSession(unsupported)).toMatchObject({ status: "unable", exercises: [] });
  });

  it("never treats energy or old pain evidence as silent dose authority", () => {
    const painContext = input({ energy: "low", requestedMinutes: 50 });
    painContext.preflight.findings.push({ id: `pain:${ids.anchor}`, severity: "warning", code: "recent_pain_association", reason: "One recent association", dayLineageId: ids.day, slotLineageId: ids.anchor, evidenceCount: 1, editPath: `slots.${ids.anchor}.intent` });
    const low = compileSession(painContext);
    const good = compileSession(input({ energy: "good", requestedMinutes: 50 }));
    expect(low.exercises.map((exercise) => exercise.sets)).toEqual(good.exercises.map((exercise) => exercise.sets));
    expect(low.evidenceStatement).toContain("no dose authority");
    expect(low.evidenceStatement).toContain("fatigue tolerance is normal");
    expect(low.warnings).toEqual([expect.objectContaining({ code: "recent_pain_association", evidenceCount: 1 })]);
  });

  it("reduces canonical groups only by whole rounds and never trims unequal legacy members independently", () => {
    const canonical = input({ requestedMinutes: 35 });
    canonical.documentSchemaVersion = 3;
    canonical.exercises = canonical.exercises.map((exercise, index) => ({
      ...exercise,
      supersetKey: ids.template,
      groupMemberOrderIdx: index,
      sets: 4,
      setNotes: [null, null, null, null],
      intent: intent("could", 2, 4),
    }));
    canonical.day = {
      ...canonical.day,
      warmupItems: [],
      supersets: [{
        key: ids.template,
        name: "Canonical pair",
        structureStatus: "canonical",
        plannedRounds: 4,
        restBetweenMembersSec: 30,
        restBetweenRoundsSec: 120,
        restAfterRoundSec: 120,
      }],
      exercises: canonical.day.exercises.map((exercise, index) => ({
        ...exercise,
        supersetKey: ids.template,
        groupMemberOrderIdx: index,
        sets: 4,
        setNotes: [null, null, null, null],
        intent: intent("could", 2, 4),
      })),
    };

    const compiled = compileSession(canonical);
    expect(compiled.status).toBe("ready");
    expect(compiled.exercises.map((exercise) => exercise.sets)).toEqual([
      compiled.exercises[0].sets,
      compiled.exercises[0].sets,
    ]);
    expect(compiled.exercises[0].sets).toBeLessThan(4);
    expect(compiled.changes.filter((change) => change.kind === "dose_reduced"))
      .toHaveLength(2);

    const legacy = structuredClone(canonical);
    legacy.day.supersets[0] = {
      ...legacy.day.supersets[0],
      structureStatus: "legacy_unequal",
      plannedRounds: null,
    };
    legacy.exercises[1].sets = 3;
    legacy.exercises[1].setNotes = [null, null, null];
    legacy.day.exercises[1].sets = 3;
    legacy.day.exercises[1].setNotes = [null, null, null];
    expect(compileSession(legacy)).toMatchObject({ status: "unable", exercises: [] });
  });
});
