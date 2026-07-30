import { describe, expect, it } from "vitest";
import {
  amberFields,
  confirmedEquipmentItemSchema,
  type ConfirmedEquipmentItem,
} from "@/ai/tasks/equipment-parse/confirm";
import {
  expandRackLikeSupportItems,
  normalizeParsedEquipmentItem,
} from "@/ai/tasks/equipment-parse/normalize";

type ParsedEquipmentItem = Parameters<typeof normalizeParsedEquipmentItem>[0];
type ParsedEquipmentItemOverrides = Omit<
  Partial<ParsedEquipmentItem>,
  "attrs"
> & {
  type: ParsedEquipmentItem["type"];
  label: string;
  attrs?: Partial<ParsedEquipmentItem["attrs"]>;
};

function item(
  overrides: Partial<ConfirmedEquipmentItem> & {
    type: ConfirmedEquipmentItem["type"];
  }
): ConfirmedEquipmentItem {
  return {
    label: "Test item",
    quantity: 1,
    minWeight: null,
    maxWeight: null,
    unit: null,
    adjustable: null,
    pair: null,
    increments: null,
    denominations: null,
    brand: null,
    barWeight: null,
    adjustableBench: null,
    ...overrides,
  };
}

function parsed({
  attrs,
  ...overrides
}: ParsedEquipmentItemOverrides): ParsedEquipmentItem {
  return {
    quantity: 1,
    ...overrides,
    attrs: {
      minWeight: null,
      maxWeight: null,
      unit: null,
      adjustable: null,
      pair: null,
      increments: null,
      denominations: null,
      brand: null,
      barWeight: null,
      adjustableBench: null,
      ...attrs,
    },
  };
}

describe("amberFields (equipment confirmation gate)", () => {
  it("normalizes stored equipment loads and rejects numeric overflow", () => {
    const normalized = confirmedEquipmentItemSchema.parse(
      item({
        type: "plates",
        unit: "lb",
        denominations: [{ weight: 32.305, quantity: 2 }],
      })
    );
    expect(normalized.denominations?.[0]?.weight).toBe(32.31);
    expect(
      confirmedEquipmentItemSchema.safeParse(
        item({ type: "barbell", unit: "lb", barWeight: 100_000 })
      ).success
    ).toBe(false);
  });

  it("dumbbells with everything unstated need unit, adjustable, and pair", () => {
    expect(amberFields(item({ type: "dumbbell", maxWeight: 35 }))).toEqual([
      "unit",
      "adjustable",
      "pair",
    ]);
  });

  it("fully resolved dumbbells pass", () => {
    expect(
      amberFields(
        item({
          type: "dumbbell",
          maxWeight: 35,
          unit: "lb",
          adjustable: false,
          pair: true,
        })
      )
    ).toEqual([]);
  });

  it("plates need denominations and unit", () => {
    expect(amberFields(item({ type: "plates" }))).toEqual([
      "unit",
      "denominations",
    ]);
    expect(amberFields(item({ type: "plates", denominations: [] }))).toContain(
      "denominations"
    );
  });

  it("plates with denominations and unit pass", () => {
    expect(
      amberFields(
        item({
          type: "plates",
          unit: "lb",
          denominations: [{ weight: 45, quantity: 2 }],
        })
      )
    ).toEqual([]);
  });

  it("kettlebells need unit, adjustable/fixed, and pair/single choices", () => {
    expect(amberFields(item({ type: "kettlebell" }))).toEqual([
      "unit",
      "adjustable",
      "pair",
    ]);
  });

  it("barbells need a unit and an explicitly selected bar weight", () => {
    expect(amberFields(item({ type: "barbell" }))).toEqual(["unit", "barWeight"]);
    expect(amberFields(item({ type: "barbell", unit: "lb" }))).toEqual([
      "barWeight",
    ]);
    expect(
      amberFields(item({ type: "barbell", unit: "lb", barWeight: 45 }))
    ).toEqual([]);
  });

  it("unweighted gear never ambers", () => {
    expect(amberFields(item({ type: "rack" }))).toEqual([]);
    expect(amberFields(item({ type: "bands", brand: "Bodylastics" }))).toEqual([]);
    expect(amberFields(item({ type: "jump_rope" }))).toEqual([]);
  });

  it("any stated weight forces a unit confirmation, even on 'other'", () => {
    expect(amberFields(item({ type: "other", maxWeight: 50 }))).toEqual(["unit"]);
  });
});

describe("normalizeParsedEquipmentItem", () => {
  it("preserves parsed quantities and derives bar weight from stated Olympic bar load", () => {
    expect(
      normalizeParsedEquipmentItem(
        parsed({
          type: "barbell",
          label: "45 lb Olympic bar",
          quantity: 2,
          attrs: { maxWeight: 45 },
        })
      )
    ).toMatchObject({
      type: "barbell",
      quantity: 2,
      unit: "lb",
      barWeight: 45,
      minWeight: null,
      maxWeight: null,
    });
  });

  it("keeps fixed dumbbell pairs fully resolved", () => {
    const item = normalizeParsedEquipmentItem(
      parsed({
        type: "dumbbell",
        label: "Pair of 25 lb dumbbells",
        attrs: {
          minWeight: 25,
          maxWeight: 25,
          unit: "lb",
          adjustable: false,
          pair: true,
        },
      })
    );
    expect(item).toMatchObject({
      type: "dumbbell",
      minWeight: 25,
      maxWeight: 25,
      unit: "lb",
      adjustable: false,
      pair: true,
    });
    expect(amberFields(item)).toEqual([]);
  });

  it("maps known attachments into useful app equipment types", () => {
    expect(
      normalizeParsedEquipmentItem(
        parsed({
          type: "other",
          label: "Fit505 lat pull-down attachment model 4376",
          attrs: { maxWeight: 4376, unit: "lb" },
        })
      )
    ).toMatchObject({ type: "cable", minWeight: null, maxWeight: null, unit: null });

    expect(
      normalizeParsedEquipmentItem(
        parsed({ type: "other", label: "set of dip bars" })
      )
    ).toMatchObject({ type: "machine" });
  });

  it("recognizes rack-like support without treating loose J-hooks as equipment", () => {
    expect(
      normalizeParsedEquipmentItem(
        parsed({ type: "other", label: "bench press stands" })
      )
    ).toMatchObject({ type: "rack" });

    const benchStation = normalizeParsedEquipmentItem(
      parsed({ type: "bench", label: "bench press station" })
    );
    expect(
      expandRackLikeSupportItems([benchStation]).map((entry) => entry.type)
    ).toEqual(["bench", "rack"]);

    const flatBench = normalizeParsedEquipmentItem(
      parsed({ type: "bench", label: "flat bench" })
    );
    const hooks = normalizeParsedEquipmentItem(
      parsed({ type: "other", label: "J-hooks" })
    );
    expect(
      expandRackLikeSupportItems([flatBench, hooks]).map((entry) => entry.type)
    ).toEqual(["bench", "other"]);
  });

  it("keeps trap/hex bars out of Olympic calculations", () => {
    const trapBar = normalizeParsedEquipmentItem(
      parsed({ type: "barbell", label: "trap bar", attrs: { unit: "lb" } })
    );
    expect(trapBar).toMatchObject({ type: "trap_bar", unit: "lb", barWeight: null });
    expect(amberFields(trapBar)).toEqual([]);

    const bands = normalizeParsedEquipmentItem(
      parsed({
        type: "bands",
        label: "Bodylastics resistance band set",
        attrs: { maxWeight: 80, unit: "lb", brand: "Bodylastics" },
      })
    );
    expect(bands).toMatchObject({ type: "bands", unit: null, maxWeight: null });
    expect(amberFields(bands)).toEqual([]);
  });

  it("uses the profile unit without inventing an unstated common bar weight", () => {
    expect(
      normalizeParsedEquipmentItem(
        parsed({ type: "ez_bar", label: "EZ curl bar" }),
        "lb"
      )
    ).toMatchObject({
      type: "ez_bar",
      unit: "lb",
      barWeight: null,
    });
  });

  it("shows and requires confirmation for a converted cross-unit bar weight", () => {
    const result = normalizeParsedEquipmentItem(
      parsed({ type: "barbell", label: "20 kg Olympic bar", attrs: { unit: "kg", barWeight: 20 } }),
      "lb"
    );
    expect(result).toMatchObject({
      unit: "lb",
      barWeight: 44.09,
      statedBarWeight: 20,
      statedBarUnit: "kg",
      barWeightConfirmed: false,
    });
    expect(amberFields(result)).toContain("barWeight");
    expect(amberFields({ ...result, barWeightConfirmed: true })).not.toContain("barWeight");
  });
});
