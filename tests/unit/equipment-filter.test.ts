import { describe, it, expect } from "vitest";
import {
  buildEquipmentAvailability,
  exerciseIsAvailable,
  missingRequirementsSummary,
  missingRequirements,
  type InventoryItem,
} from "@/engine/equipment-filter";
import {
  patternFlags,
  isPatternAllowedForSuggestions,
} from "@/engine/constraint-filter";

// The demo user's inventory: no cable machine, no pull-up bar, DBs max 35 lb
const inventory: InventoryItem[] = [
  { type: "rack", available: true, attrs: {} },
  { type: "bench", available: true, attrs: {} },
  { type: "barbell", available: true, attrs: { maxWeight: 45 } },
  { type: "ez_bar", available: true, attrs: { maxWeight: 15 } },
  { type: "dumbbell", available: true, attrs: { maxWeight: 35 } },
  { type: "kettlebell", available: true, attrs: { maxWeight: 35 } },
  { type: "bands", available: true, attrs: {} },
  { type: "plates", available: true, attrs: {} },
  { type: "jump_rope", available: true, attrs: {} },
  { type: "elliptical", available: true, attrs: {} },
];

describe("exerciseIsAvailable", () => {
  it("uses the shared plate pool instead of legacy marker rows", () => {
    const requirement = [{ equipmentType: "plates", minWeight: null }];
    const withoutMarker = buildEquipmentAvailability([], [{ denomination: 45 }]);
    const markerWithoutPool = buildEquipmentAvailability(
      [{ type: "plates", available: true, attrs: {} }],
      []
    );

    expect(exerciseIsAvailable(requirement, withoutMarker)).toBe(true);
    expect(exerciseIsAvailable(requirement, markerWithoutPool)).toBe(false);
  });

  it("drops saved bodyweight rows because bodyweight is implicit", () => {
    expect(
      buildEquipmentAvailability(
        [{ type: "bodyweight", available: true, attrs: {} }],
        []
      )
    ).toEqual([]);
    expect(
      exerciseIsAvailable(
        [{ equipmentType: "bodyweight", minWeight: null }],
        buildEquipmentAvailability([], [])
      )
    ).toBe(true);
  });

  it("passes barbell bench press (barbell+plates+bench+rack all owned)", () => {
    expect(
      exerciseIsAvailable(
        [
          { equipmentType: "barbell", minWeight: null },
          { equipmentType: "plates", minWeight: null },
          { equipmentType: "bench", minWeight: null },
          { equipmentType: "rack", minWeight: null },
        ],
        inventory
      )
    ).toBe(true);
  });

  it("fails cable exercises (no cable machine owned)", () => {
    expect(
      exerciseIsAvailable([{ equipmentType: "cable", minWeight: null }], inventory)
    ).toBe(false);
  });

  it("fails pull-ups (no pull-up bar owned)", () => {
    expect(
      exerciseIsAvailable(
        [{ equipmentType: "pullup_bar", minWeight: null }],
        inventory
      )
    ).toBe(false);
  });

  it("enforces minWeight against owned dumbbell range", () => {
    expect(
      exerciseIsAvailable([{ equipmentType: "dumbbell", minWeight: 35 }], inventory)
    ).toBe(true);
    expect(
      exerciseIsAvailable([{ equipmentType: "dumbbell", minWeight: 50 }], inventory)
    ).toBe(false);
  });

  it("treats bodyweight as always satisfied", () => {
    expect(
      exerciseIsAvailable([{ equipmentType: "bodyweight", minWeight: null }], [])
    ).toBe(true);
  });

  it("ignores unavailable items", () => {
    const benchBroken = inventory.map((i) =>
      i.type === "bench" ? { ...i, available: false } : i
    );
    expect(
      exerciseIsAvailable([{ equipmentType: "bench", minWeight: null }], benchBroken)
    ).toBe(false);
  });

  it("names exactly what is missing", () => {
    const missing = missingRequirements(
      [
        { equipmentType: "cable", minWeight: null },
        { equipmentType: "bench", minWeight: null },
      ],
      inventory
    );
    expect(missing).toEqual([{ equipmentType: "cable", minWeight: null }]);
  });

  it("explains missing rack-like support without relaxing the safety gate", () => {
    const noRack = inventory.filter((item) => item.type !== "rack");
    const requirements = [
      { equipmentType: "barbell", minWeight: null },
      { equipmentType: "plates", minWeight: null },
      { equipmentType: "bench", minWeight: null },
      { equipmentType: "rack", minWeight: null },
    ];
    const missing = missingRequirements(requirements, noRack);

    expect(exerciseIsAvailable(requirements, noRack)).toBe(false);
    expect(missingRequirementsSummary(missing)).toBe(
      "Needs rack-like support (rack, squat stands, bench press station, or uprights)."
    );
  });
});

describe("constraint flags", () => {
  const constraints = [
    {
      bodyPart: "shoulder",
      affectedPatterns: ["vertical_push", "horizontal_push"],
      avoid: false,
      cautious: true,
      painStopThreshold: 3,
    },
    {
      bodyPart: "knee",
      affectedPatterns: ["lunge"],
      avoid: true,
      cautious: true,
      painStopThreshold: 3,
    },
  ];

  it("flags cautious patterns without excluding them", () => {
    const flags = patternFlags(constraints);
    expect(flags.get("vertical_push")).toMatchObject({ avoid: false, cautious: true });
    expect(isPatternAllowedForSuggestions("vertical_push", constraints)).toBe(true);
  });

  it("excludes avoid patterns from suggestions", () => {
    expect(isPatternAllowedForSuggestions("lunge", constraints)).toBe(false);
  });

  it("leaves unconstrained patterns untouched", () => {
    expect(patternFlags(constraints).get("hinge")).toBeUndefined();
    expect(isPatternAllowedForSuggestions("hinge", constraints)).toBe(true);
  });
});
