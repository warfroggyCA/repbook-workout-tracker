import { describe, expect, it } from "vitest";
import { equipmentTypeEnum } from "@/db/schema/enums";
import {
  COMMON_BAR_WEIGHTS,
  COMMON_FIXED_WEIGHTS,
  COMMON_PLATE_DENOMINATIONS,
  EQUIPMENT_TYPE_VALUES,
  associateBarConfigurations,
  describePlateRow,
  equipmentFieldApplicability,
  hasSparePlate,
  platePairsPerSide,
  validateEquipmentInventoryDocument,
} from "@/lib/equipment-inventory-contract";
import { mergeIncrementalEquipmentConfigs } from "@/services/progression";

const baseDocument = {
  baseRevision: "revision",
  items: [],
  plates: [],
  bars: [],
};

describe("equipment inventory contract", () => {
  it("keeps exact setup profiles item-scoped and preserves saved inactive-item profiles", () => {
    const itemId = "11111111-1111-4111-8111-111111111111";
    const valid = validateEquipmentInventoryDocument({
      ...baseDocument,
      items: [{ id: itemId, type: "ez_bar", label: "18 lb EZ-curl bar", quantity: 1, attrs: {} }],
      loadProfiles: [{
        equipmentItemId: itemId,
        profile: {
          kind: "plate_loaded_implement", id: "22222222-2222-4222-8222-222222222222",
          loadingKind: "ez", emptyWeight: 18, collarWeight: 0, unit: "lb",
          sharedPlatePoolCompatible: true,
        },
      }],
    });
    expect(valid.ok).toBe(true);

    const preservedInactive = validateEquipmentInventoryDocument({
      ...baseDocument,
      loadProfiles: valid.ok ? valid.document.loadProfiles : [],
    });
    expect(preservedInactive.ok).toBe(true);

    const mismatched = validateEquipmentInventoryDocument({
      ...baseDocument,
      items: [{ id: itemId, type: "barbell", label: "Olympic bar", quantity: 1, attrs: {} }],
      loadProfiles: valid.ok ? valid.document.loadProfiles : [],
    });
    expect(mismatched.ok).toBe(false);
  });

  it("rejects exact compatibility links outside the complete owned document", () => {
    const machineId = "11111111-1111-4111-8111-111111111111";
    const cableId = "22222222-2222-4222-8222-222222222222";
    const invalid = validateEquipmentInventoryDocument({
      ...baseDocument,
      items: [
        { id: machineId, type: "machine", label: "Machine", quantity: 1, attrs: {} },
        { id: cableId, type: "cable", label: "Cable", quantity: 1, attrs: {} },
      ],
      loadProfiles: [
        {
          equipmentItemId: machineId,
          profile: {
            kind: "plate_loaded_machine", id: null, geometryCertainty: "unknown",
            startingResistance: null, startingResistanceUnit: null, loadingPointCount: null,
            balancingRule: null, targetEntryMeaning: null,
            compatiblePlateIds: ["33333333-3333-4333-8333-333333333333"],
          },
        },
        {
          equipmentItemId: cableId,
          profile: {
            kind: "cable_machine", id: null, geometryCertainty: "unknown",
            stackCount: null, topology: null, displayedUnit: null, ratioStatus: "unknown",
            ratioNumerator: null, ratioDenominator: null, stackSteps: [],
            compatibleAttachmentItemIds: ["44444444-4444-4444-8444-444444444444"],
          },
        },
      ],
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.issues.map((issue) => issue.message).join(" ")).toContain("saved plate pool");
    expect(invalid.issues.map((issue) => issue.message).join(" ")).toContain("saved attachment profile");
  });

  it("keeps one canonical type list identical to the database enum", () => {
    expect([...EQUIPMENT_TYPE_VALUES]).toEqual([...equipmentTypeEnum.enumValues]);
  });

  it("asks for weight-related fields only where weight is meaningful (UI-002)", () => {
    for (const type of ["rack", "bench", "pullup_bar", "cable", "machine", "box", "foam_roller"] as const) {
      const applicability = equipmentFieldApplicability(type);
      expect(applicability.unit, type).toBe(false);
      expect(applicability.weightRange, type).toBe(false);
    }
    expect(equipmentFieldApplicability("bench").benchType).toBe(true);
    for (const type of ["dumbbell", "kettlebell"] as const) {
      const applicability = equipmentFieldApplicability(type);
      expect(applicability.unit).toBe(true);
      expect(applicability.weightRange).toBe(true);
      expect(applicability.adjustable).toBe(true);
      expect(applicability.pair).toBe(true);
    }
    expect(equipmentFieldApplicability("plates").plateDenominations).toBe(true);
    expect(equipmentFieldApplicability("barbell").barConfiguration).toBe(true);
    expect(equipmentFieldApplicability("ez_bar").unit).toBe(true);
  });

  it("offers common choices in descending plate order and sensible bar weights", () => {
    expect(COMMON_PLATE_DENOMINATIONS.lb).toEqual([45, 35, 25, 10, 5, 2.5]);
    expect(COMMON_PLATE_DENOMINATIONS.kg).toEqual([20, 15, 10, 5, 2.5, 1.25]);
    expect(COMMON_BAR_WEIGHTS.olympic.lb).toContain(45);
    expect(COMMON_BAR_WEIGHTS.olympic.kg).toContain(20);
    expect(COMMON_BAR_WEIGHTS.ez.lb).toContain(25);
    expect(COMMON_FIXED_WEIGHTS.dumbbell.lb.length).toBeGreaterThan(0);
  });

  it("derives loadable pairs and spare plates from total quantity", () => {
    expect(platePairsPerSide(2)).toBe(1);
    expect(platePairsPerSide(5)).toBe(2);
    expect(hasSparePlate(5)).toBe(true);
    expect(hasSparePlate(4)).toBe(false);
    expect(describePlateRow(45, 2, "lb")).toBe("45 lb × 2");
    expect(describePlateRow(2.5, 5, "kg")).toBe("2.5 kg × 5 (1 spare)");
  });

  it("rejects invalid plate denominations with named messages", () => {
    const invalid = validateEquipmentInventoryDocument({
      ...baseDocument,
      plates: [
        { id: null, denomination: 0, quantity: 1 },
        { id: null, denomination: 45.001, quantity: 1 },
      ],
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    const messages = invalid.issues.map((issue) => issue.message).join(" ");
    expect(messages).toContain("positive weight");
    expect(messages).toContain("two decimal places");

    const duplicate = validateEquipmentInventoryDocument({
      ...baseDocument,
      plates: [
        { id: null, denomination: 45, quantity: 2 },
        { id: null, denomination: 45, quantity: 4 },
      ],
    });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(
      duplicate.issues.map((issue) => issue.message).join(" ")
    ).toContain("appears twice");
  });

  it("rejects duplicate natural keys and duplicate IDs while preserving repeated legacy bar configs", () => {
    const duplicateKey = validateEquipmentInventoryDocument({
      ...baseDocument,
      items: [
        { id: null, type: "bench", label: "Bench", quantity: 1, attrs: {} },
        { id: null, type: "bench", label: " bench ", quantity: 1, attrs: {} },
      ],
    });
    expect(duplicateKey.ok).toBe(false);

    const id = crypto.randomUUID();
    const duplicateId = validateEquipmentInventoryDocument({
      ...baseDocument,
      items: [
        { id, type: "bench", label: "Bench A", quantity: 1, attrs: {} },
        { id, type: "rack", label: "Rack A", quantity: 1, attrs: {} },
      ],
    });
    expect(duplicateId.ok).toBe(false);

    const ambiguousBars = validateEquipmentInventoryDocument({
      ...baseDocument,
      bars: [
        { id: "11111111-1111-4111-8111-111111111111", barType: "olympic", barWeight: 45, collarWeight: 0, quantity: 1, label: "A" },
        { id: "22222222-2222-4222-8222-222222222222", barType: "olympic", barWeight: 35, collarWeight: 0, quantity: 1, label: "B" },
      ],
    });
    expect(ambiguousBars.ok).toBe(true);
  });

  it("matches bars only when one compatible item and one configuration are unique", () => {
    const olympic = { barType: "olympic" as const, label: "  Olympic   Bar " };
    expect(
      associateBarConfigurations(
        [{ type: "barbell", label: "Olympic bar" }],
        [olympic]
      )
    ).toMatchObject({ matched: [{ itemIndex: 0, barIndex: 0, match: "label" }], unmatchedBarIndexes: [] });

    expect(
      associateBarConfigurations(
        [
          { type: "barbell", label: "Bar A" },
          { type: "barbell", label: "Bar B" },
        ],
        [olympic]
      )
    ).toMatchObject({ matched: [], unmatchedBarIndexes: [0], missingItemIndexes: [0, 1], ambiguousTypes: ["olympic"] });

    expect(
      associateBarConfigurations([], [olympic])
    ).toMatchObject({ matched: [], unmatchedBarIndexes: [0] });
  });

  it("preserves unknown future attribute keys through validation", () => {
    const result = validateEquipmentInventoryDocument({
      ...baseDocument,
      items: [
        {
          id: null,
          type: "landmine",
          label: "Corner landmine",
          quantity: 1,
          attrs: { notes: "kept", futureAttribute: { nested: true } },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.items[0].attrs).toMatchObject({
      notes: "kept",
      futureAttribute: { nested: true },
    });
  });

  it("validates exact available weights against the owned range", () => {
    const result = validateEquipmentInventoryDocument({
      ...baseDocument,
      items: [
        {
          id: null,
          type: "dumbbell",
          label: "Adjustable dumbbells",
          quantity: 1,
          attrs: {
            unit: "lb",
            adjustable: true,
            pair: true,
            minWeight: 10,
            maxWeight: 30,
            increments: [10, 20, 35],
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.message).join(" ")).toContain(
      "outside its minimum-to-maximum range"
    );
  });

  it("merges repeated handheld items into one exact progression load set", () => {
    expect(
      mergeIncrementalEquipmentConfigs([
        {
          type: "dumbbell",
          available: true,
          attrs: { minWeight: 5, maxWeight: 25, increments: [5, 10, 15, 20, 25] },
        },
        {
          type: "dumbbell",
          available: true,
          attrs: { minWeight: 30, maxWeight: 50, increments: [30, 35, 40, 45, 50] },
        },
        {
          type: "dumbbell",
          available: false,
          attrs: { minWeight: 60, maxWeight: 80, increments: [60, 80] },
        },
      ]).dumbbell
    ).toEqual({
      minWeight: 5,
      maxWeight: 50,
      increments: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50],
    });
  });
});
