import { describe, expect, it } from "vitest";
import { amberFields } from "@/ai/tasks/equipment-parse/confirm";
import {
  checklistFromExisting,
  nextChecklistItemLabel,
} from "@/lib/setup-equipment-checklist";
import { equipmentQuantityCopy } from "@/lib/equipment-inventory-contract";

describe("first-time equipment checklist lossless revisit", () => {
  it("explains quantity for fixed and adjustable handheld configurations", () => {
    expect(equipmentQuantityCopy("dumbbell", true, false)).toEqual({
      label: "How many pairs at each weight",
      helper:
        "Quantity 1 means one matched pair at every selected weight. Add another entry if a weight has a different quantity or configuration.",
    });
    expect(equipmentQuantityCopy("dumbbell", false, true)).toEqual({
      label: "How many adjustable singles",
      helper: "Quantity counts individual adjustable weights when Single is selected.",
    });
    expect(equipmentQuantityCopy("dumbbell", null, false).label).toBe(
      "Choose Pair or Single first"
    );
    expect(equipmentQuantityCopy("barbell", null, null)).toEqual({
      label: "How many",
      helper: null,
    });
  });

  it("gives repeated equipment a visible unique default label", () => {
    const items = [
      { type: "dumbbell" as const, label: "Adjustable pair" },
      { type: "dumbbell" as const, label: "Dumbbells 2" },
      { type: "bench" as const, label: "Bench" },
    ];

    expect(nextChecklistItemLabel([], "dumbbell", "Dumbbells")).toBe(
      "Dumbbells"
    );
    expect(nextChecklistItemLabel(items, "dumbbell", "Dumbbells")).toBe(
      "Dumbbells 3"
    );
  });

  it("keeps repeated and specialty rows as separate stable items", () => {
    const existing = {
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "dumbbell",
          label: "Adjustable pair",
          quantity: 1,
          attrs: { unit: "lb", adjustable: true, pair: true, minWeight: 5, maxWeight: 50 },
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "dumbbell",
          label: "Fixed pair",
          quantity: 2,
          attrs: {
            unit: "lb",
            adjustable: false,
            pair: true,
            minWeight: 10,
            maxWeight: 20,
            increments: [10, 20],
          },
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          type: "trap_bar",
          label: "Open trap bar",
          quantity: 1,
          attrs: { unit: "kg", notes: "Keep this server-owned note" },
        },
      ],
      plates: [],
      bars: [],
    } as unknown as Parameters<typeof checklistFromExisting>[0];

    const result = checklistFromExisting(existing, "lb");

    expect(result).toHaveLength(3);
    expect(result.map((item) => item.id)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(result.filter((item) => item.type === "dumbbell")).toHaveLength(2);
    expect(result[1]).toMatchObject({
      increments: [10, 20],
      minWeight: 10,
      maxWeight: 20,
    });
    expect(result[2]).toMatchObject({ type: "trap_bar", unit: "kg" });
  });

  it("preserves contradictory fixed-weight facts and keeps them unresolved", () => {
    const [item] = checklistFromExisting({
      items: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "dumbbell",
        label: "Legacy fixed pair",
        quantity: 1,
        attrs: {
          unit: "lb",
          adjustable: false,
          pair: true,
          minWeight: 5,
          maxWeight: 50,
          increments: [5, 10, 15],
        },
      }],
      plates: [],
      bars: [],
    } as unknown as Parameters<typeof checklistFromExisting>[0], "lb");

    expect(item).toMatchObject({
      minWeight: 5,
      maxWeight: 50,
      increments: [5, 10, 15],
    });
    expect(amberFields(item)).toContain("increments");
  });

  it("does not invent a bar weight for a saved row without a configuration", () => {
    expect(
      amberFields({
        id: "44444444-4444-4444-8444-444444444444",
        type: "barbell",
        label: "Saved bar",
        quantity: 1,
        minWeight: null,
        maxWeight: null,
        unit: "lb",
        adjustable: null,
        pair: null,
        increments: null,
        denominations: null,
        brand: null,
        barWeight: null,
        adjustableBench: null,
      })
    ).not.toContain("barWeight");
  });

  it("loads the stable bar configuration and exact combined collar weight", () => {
    const result = checklistFromExisting({
      items: [{ id: "55555555-5555-4555-8555-555555555555", type: "ez_bar", label: "EZ bar", quantity: 1, attrs: {} }],
      plates: [],
      bars: [{ id: "66666666-6666-4666-8666-666666666666", userId: "77777777-7777-4777-8777-777777777777", barType: "ez", label: "EZ bar", quantity: 1, barWeight: 25, collarWeight: 1 }],
    } as unknown as Parameters<typeof checklistFromExisting>[0], "lb");
    expect(result[0]).toMatchObject({
      barConfigId: "66666666-6666-4666-8666-666666666666",
      barWeight: 25,
      collarWeight: 1,
    });
  });

  it("exposes the shared plate pool even without a legacy plate marker", () => {
    const result = checklistFromExisting({
      items: [{
        id: "77777777-7777-4777-8777-777777777777",
        type: "bodyweight",
        label: "Legacy bodyweight",
        quantity: 1,
        attrs: {},
      }],
      plates: [{
        id: "88888888-8888-4888-8888-888888888888",
        userId: "99999999-9999-4999-8999-999999999999",
        denomination: 45,
        quantity: 2,
      }],
      bars: [],
    } as unknown as Parameters<typeof checklistFromExisting>[0], "lb");

    expect(result.filter((item) => item.type === "plates")).toEqual([
      expect.objectContaining({
        clientKey: "shared-plate-pool",
        denominations: [{
          id: "88888888-8888-4888-8888-888888888888",
          weight: 45,
          quantity: 2,
        }],
      }),
    ]);
    expect(result.filter((item) => item.type === "bodyweight")).toHaveLength(1);
  });
});
