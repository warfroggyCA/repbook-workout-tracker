import { performance } from "node:perf_hooks";
import { describe, it, expect } from "vitest";
import {
  achievableLoads,
  solvePlates,
  roundToAchievable,
  nearestAchievableBounds,
  nextLoadUp,
  nextLoadDown,
  incrementalLoads,
  MAX_PLATE_SUM_ENTRIES,
  nextIncrementalUp,
  type PlateMathConfig,
} from "@/engine/plate-math";

// The demo user's actual home inventory (per side): 45×1, 25×1, 10×1, 5×2, 2.5×1
const homeGym: PlateMathConfig = {
  barWeight: 45,
  collarWeight: 0,
  plates: [
    { denomination: 45, countPerSide: 1 },
    { denomination: 25, countPerSide: 1 },
    { denomination: 10, countPerSide: 1 },
    { denomination: 5, countPerSide: 2 },
    { denomination: 2.5, countPerSide: 1 },
  ],
};

describe("solvePlates", () => {
  it("solves exact loads with plate list heaviest-first", () => {
    expect(solvePlates(95, homeGym)?.perSide).toEqual([25]);
    expect(solvePlates(115, homeGym)?.perSide).toEqual([25, 10]);
    expect(solvePlates(135, homeGym)?.perSide).toEqual([45]);
  });

  it("uses non-greedy combinations when greedy would fail", () => {
    // 65 lb → 10/side: greedy would try 10, fine; 75 → 15/side needs 10+5
    expect(solvePlates(75, homeGym)?.perSide).toEqual([10, 5]);
    // 25/side could be 25 exactly; 30/side must be 25+5 (only one 25)
    expect(solvePlates(105, homeGym)?.perSide).toEqual([25, 5]);
  });

  it("returns null for unloadable targets", () => {
    expect(solvePlates(96, homeGym)).toBeNull(); // 25.5/side impossible
    expect(solvePlates(40, homeGym)).toBeNull(); // below the bar
    expect(solvePlates(500, homeGym)).toBeNull(); // beyond owned plates
  });

  it("respects collar weight", () => {
    const withCollars = { ...homeGym, collarWeight: 1 };
    expect(solvePlates(96, withCollars)?.perSide).toEqual([25]);
  });

  it("uses assembled totals independently for Olympic and EZ bars", () => {
    expect(solvePlates(95, homeGym)?.totalLoad).toBe(95);
    const ez: PlateMathConfig = {
      barWeight: 25,
      collarWeight: 1,
      plates: [{ denomination: 10, countPerSide: 1 }],
    };
    expect(achievableLoads(ez)[0]).toBe(26);
    expect(solvePlates(46, ez)).toMatchObject({ totalLoad: 46, perSide: [10] });
  });
});

describe("achievableLoads", () => {
  it("starts at the bare bar and is strictly ascending", () => {
    const loads = achievableLoads(homeGym);
    expect(loads[0]).toBe(45);
    for (let i = 1; i < loads.length; i++) expect(loads[i]).toBeGreaterThan(loads[i - 1]);
  });

  it("tops out at all plates loaded", () => {
    const loads = achievableLoads(homeGym);
    // 45+25+10+5+5+2.5 = 92.5/side → 45 + 185 = 230
    expect(loads[loads.length - 1]).toBe(230);
  });
});

describe("roundToAchievable", () => {
  it("rounds to the nearest achievable load", () => {
    expect(roundToAchievable(117, homeGym).totalLoad).toBe(115);
    expect(roundToAchievable(119, homeGym).totalLoad).toBe(120);
  });

  it("breaks ties downward (conservative)", () => {
    // 112.5 is equidistant between 110 and 115 → pick 110
    expect(roundToAchievable(112.5, homeGym).totalLoad).toBe(110);
  });

  it("returns the bare bar for tiny targets", () => {
    expect(roundToAchievable(20, homeGym).totalLoad).toBe(45);
  });
});

describe("nearestAchievableBounds", () => {
  it("reports both conservative neighbours without silently choosing one", () => {
    expect(nearestAchievableBounds(117, homeGym)).toMatchObject({
      lower: { totalLoad: 115 },
      upper: { totalLoad: 120 },
    });
  });

  it("keeps a missing side explicit at inventory limits", () => {
    expect(nearestAchievableBounds(20, homeGym)).toMatchObject({
      lower: null,
      upper: { totalLoad: 45 },
    });
    expect(nearestAchievableBounds(500, homeGym)).toMatchObject({
      lower: { totalLoad: 230 },
      upper: null,
    });
  });
});

describe("nextLoadUp / nextLoadDown", () => {
  it("finds the smallest jump the plates allow", () => {
    expect(nextLoadUp(95, homeGym)?.totalLoad).toBe(100);
    expect(nextLoadUp(115, homeGym)?.totalLoad).toBe(120);
    expect(nextLoadDown(95, homeGym)?.totalLoad).toBe(90);
  });

  it("returns null at the extremes", () => {
    expect(nextLoadUp(230, homeGym)).toBeNull();
    expect(nextLoadDown(45, homeGym)).toBeNull();
  });
});

describe("bounded plate enumeration", () => {
  const pathological: PlateMathConfig = {
    barWeight: 45,
    collarWeight: 0,
    plates: Array.from({ length: 100 }, (_, index) => ({
      denomination: 100 - index / 100,
      countPerSide: 99,
    })),
  };

  it("caps pathological valid inventories deterministically within the time budget", () => {
    const started = performance.now();
    const loads = achievableLoads(pathological);
    const durationMs = performance.now() - started;
    const reversed = achievableLoads({
      ...pathological,
      plates: [...pathological.plates].reverse(),
    });

    expect(loads.length).toBeLessThanOrEqual(MAX_PLATE_SUM_ENTRIES);
    expect(durationMs).toBeLessThan(1_000);
    expect(reversed).toEqual(loads);
  });

  it("returns a conservative miss when truncation omits a truly loadable target", () => {
    const omittedDenomination = pathological.plates.at(-1)!.denomination;
    const target = 45 + omittedDenomination * 2;
    expect(
      solvePlates(target, {
        barWeight: 45,
        collarWeight: 0,
        plates: [{ denomination: omittedDenomination, countPerSide: 99 }],
      })
    ).not.toBeNull();
    expect(solvePlates(target, pathological)).toBeNull();
  });

  it("keeps established normal-inventory results byte-identical", () => {
    expect(
      JSON.stringify({
        loads: achievableLoads(homeGym),
        solve: solvePlates(105, homeGym),
        round: roundToAchievable(117, homeGym),
        up: nextLoadUp(115, homeGym),
        down: nextLoadDown(95, homeGym),
      })
    ).toBe(
      '{"loads":[45,50,55,60,65,70,75,80,85,90,95,100,105,110,115,120,125,130,135,140,145,150,155,160,165,170,175,180,185,190,195,200,205,210,215,220,225,230],"solve":{"totalLoad":105,"perSide":[25,5]},"round":{"totalLoad":115,"perSide":[25,10]},"up":{"totalLoad":120,"perSide":[25,10,2.5]},"down":{"totalLoad":90,"perSide":[10,5,5,2.5]}}'
    );
  });
});

describe("incremental (dumbbell/kettlebell) loads", () => {
  const adjustableDbs = { minWeight: 5, maxWeight: 35, increments: [5, 10, 15, 20, 25, 30, 35] };

  it("uses explicit increments when present", () => {
    expect(incrementalLoads(adjustableDbs)).toEqual([5, 10, 15, 20, 25, 30, 35]);
  });

  it("steps by 5 from min to max without explicit increments", () => {
    expect(incrementalLoads({ minWeight: 18, maxWeight: 35 })).toEqual([18, 23, 28, 33]);
  });

  it("returns no generated loads for non-finite bounds", () => {
    expect(incrementalLoads({ minWeight: Number.NaN, maxWeight: 35 })).toEqual([]);
    expect(
      incrementalLoads({ minWeight: 5, maxWeight: Number.POSITIVE_INFINITY })
    ).toEqual([]);
  });

  it("finds the next weight up and stops at the top", () => {
    expect(nextIncrementalUp(30, adjustableDbs)).toBe(35);
    expect(nextIncrementalUp(35, adjustableDbs)).toBeNull();
  });
});
