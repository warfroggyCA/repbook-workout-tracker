import { describe, it, expect } from "vitest";
import {
  evaluateSlot,
  isCleanExposure,
  isHardMissExposure,
  isStalled,
  type Exposure,
  type SlotPrescription,
  type EvaluateSlotInput,
} from "@/engine/progression/rules";
import { validateLoadIncrease } from "@/engine/progression/validate";
import { steppersForLoadType } from "@/services/progression";

const rx: SlotPrescription = {
  sets: 3,
  repRangeMin: 6,
  repRangeMax: 8,
  targetLoad: 95,
};

let setSeq = 0;
function exposure(
  sets: Array<[number | null, number, number?]>,
  daysAgo = 0
): Exposure {
  return {
    sessionId: `s-${daysAgo}`,
    date: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    sets: sets.map(([weight, reps, rpe]) => ({
      id: `set-${setSeq++}`,
      weight,
      reps,
      rpe: rpe ?? null,
    })),
  };
}

// Steppers matching the demo home gym (5 lb barbell steps).
const steppers = {
  nextLoadUp: (current: number) => current + 5,
  roundDown: (target: number) => Math.floor(target / 5) * 5,
};

function evaluate(input: Partial<EvaluateSlotInput>) {
  return evaluateSlot({
    exerciseName: "Barbell Back Squat",
    prescription: rx,
    exposures: [],
    recentPain: [],
    ...steppers,
    ...input,
  });
}

const cleanExposure = () =>
  exposure([
    [95, 8, 7],
    [95, 8, 7],
    [95, 8, 8],
  ]);

describe("isCleanExposure", () => {
  it("requires every set at top of range, at load, without grinding", () => {
    expect(isCleanExposure(cleanExposure(), rx)).toBe(true);
    expect(isCleanExposure(exposure([[95, 8], [95, 8], [95, 7]]), rx)).toBe(false); // last set 7 < 8
    expect(isCleanExposure(exposure([[90, 8], [95, 8], [95, 8]]), rx)).toBe(false); // under load
    expect(isCleanExposure(exposure([[95, 8], [95, 8], [95, 8, 9.5]]), rx)).toBe(false); // grind
    expect(isCleanExposure(exposure([[95, 8], [95, 8]]), rx)).toBe(false); // missing a set
  });

  it("treats missing RPE as acceptable (no data ≠ grinding)", () => {
    expect(isCleanExposure(exposure([[95, 8], [95, 8], [95, 8]]), rx)).toBe(true);
  });
});

describe("double progression", () => {
  it("steps EZ-bar progression from the saved empty bar and combined collars", () => {
    const ezSteppers = steppersForLoadType(
      "ez_bar",
      {
        ez_bar: {
          barWeight: 25,
          collarWeight: 1,
          plates: [{ denomination: 10, countPerSide: 1 }],
        },
      },
      {}
    );
    expect(ezSteppers.nextLoadUp(26)).toBe(46);
    expect(ezSteppers.roundDown(45)).toBe(26);
  });

  it("fires after exactly 2 clean exposures", () => {
    const decision = evaluate({
      exposures: [cleanExposure(), cleanExposure()],
    });
    expect(decision?.ruleId).toBe("double_progression");
    expect(decision?.kind).toBe("load_change");
    expect(decision?.toLoad).toBe(100);
  });

  it("does NOT fire after only 1 clean exposure (conservative)", () => {
    expect(evaluate({ exposures: [cleanExposure()] })).toBeNull();
  });

  it("can use one clean exposure when aggressive progression is selected", () => {
    const decision = evaluate({
      exposures: [cleanExposure()],
      exposuresRequiredForIncrease: 1,
    });
    expect(decision?.ruleId).toBe("double_progression");
    expect(decision?.toLoad).toBe(100);
    expect(decision?.evidence.sessionIds).toHaveLength(1);
  });

  it("does NOT fire when the older exposure was dirty", () => {
    expect(
      evaluate({
        exposures: [cleanExposure(), exposure([[95, 8], [95, 7], [95, 7]])],
      })
    ).toBeNull();
  });

  it("cites both sessions and all sets as evidence", () => {
    const decision = evaluate({ exposures: [cleanExposure(), cleanExposure()] });
    expect(decision?.evidence.sessionIds).toHaveLength(2);
    expect(decision?.evidence.setIds).toHaveLength(6);
  });

  // Safety proof: >10% jumps are refused even when plates force one
  it("refuses increases beyond the 10% cap", () => {
    const bigStep = { ...steppers, nextLoadUp: (c: number) => c + 15 }; // 95→110 ≈ 15.8%
    const decision = evaluate({
      exposures: [cleanExposure(), cleanExposure()],
      ...bigStep,
    });
    expect(decision).toBeNull();
  });
});

describe("pain hard-stops (safety proofs)", () => {
  const painEvent = (severity: number, daysAgo = 2) => ({
    severity,
    date: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    bodyPart: "shoulder",
  });

  it("pain ≥3 freezes an otherwise-qualified increase", () => {
    const decision = evaluate({
      exposures: [cleanExposure(), cleanExposure()],
      recentPain: [painEvent(3)],
    });
    expect(decision?.ruleId).toBe("pain_freeze");
    expect(decision?.kind).toBe("hold");
    expect(decision?.toLoad).toBeUndefined();
  });

  it("pain ≥5 escalates to a substitution suggestion", () => {
    const decision = evaluate({
      exposures: [cleanExposure(), cleanExposure()],
      recentPain: [painEvent(5)],
    });
    expect(decision?.ruleId).toBe("pain_substitute");
    expect(decision?.reason).toContain("professional");
  });

  it("3 repeated reports escalate even when each is mild", () => {
    const decision = evaluate({
      exposures: [cleanExposure(), cleanExposure()],
      recentPain: [painEvent(2, 1), painEvent(2, 5), painEvent(2, 9)],
    });
    expect(decision?.ruleId).toBe("pain_substitute");
  });

  it("pain below threshold does not block progression", () => {
    const decision = evaluate({
      exposures: [cleanExposure(), cleanExposure()],
      recentPain: [painEvent(2)],
    });
    expect(decision?.ruleId).toBe("double_progression");
  });
});

describe("regression", () => {
  const hardMiss = () =>
    exposure([
      [95, 4],
      [95, 4],
      [95, 3],
    ]);

  it("recommends a small reset after 2 hard-miss exposures", () => {
    const decision = evaluate({ exposures: [hardMiss(), hardMiss()] });
    expect(decision?.ruleId).toBe("regression");
    // 95 * 0.925 = 87.875 → rounds down to 85
    expect(decision?.toLoad).toBe(85);
  });

  it("does not fire on a single bad day", () => {
    expect(evaluate({ exposures: [hardMiss(), cleanExposure()] })).toBeNull();
  });

  it("near-misses are not hard misses", () => {
    // 5 reps vs floor of 6 is a 1-rep miss — hold, not regress
    const nearMiss = exposure([
      [95, 6],
      [95, 5],
      [95, 5],
    ]);
    expect(isHardMissExposure(nearMiss, rx)).toBe(false);
  });
});

describe("stall detection", () => {
  it("flags 3 consecutive not-clean exposures", () => {
    const grindy = () => exposure([[95, 7], [95, 6, 9], [95, 6, 9]]);
    expect(isStalled([grindy(), grindy(), grindy()], rx)).toBe(true);
    expect(isStalled([cleanExposure(), grindy(), grindy()], rx)).toBe(false);
    expect(isStalled([grindy(), grindy()], rx)).toBe(false); // not enough data
  });
});

describe("apply-time validation (plan §14 re-check)", () => {
  it("blocks an increase when pain appeared after the recommendation", () => {
    const check = validateLoadIncrease({
      fromLoad: 95,
      toLoad: 100,
      recentPain: [{ severity: 4, date: new Date(), bodyPart: "shoulder" }],
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("frozen");
  });

  it("blocks edited loads that exceed the 10% cap", () => {
    const check = validateLoadIncrease({ fromLoad: 95, toLoad: 120, recentPain: [] });
    expect(check.ok).toBe(false);
  });

  it("allows decreases even with pain (de-loading is always safe)", () => {
    const check = validateLoadIncrease({
      fromLoad: 95,
      toLoad: 85,
      recentPain: [{ severity: 4, date: new Date(), bodyPart: "shoulder" }],
    });
    expect(check.ok).toBe(true);
  });

  it("allows a normal 5 lb increase with no pain", () => {
    expect(validateLoadIncrease({ fromLoad: 95, toLoad: 100, recentPain: [] }).ok).toBe(true);
  });
});
