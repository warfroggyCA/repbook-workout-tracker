import { describe, expect, it } from "vitest";
import { amberFields } from "@/ai/tasks/equipment-parse/confirm";
import {
  checklistFromExisting,
  equipmentQuantityLabel,
  nextChecklistItemLabel,
} from "@/lib/setup-equipment-checklist";

describe("first-time equipment checklist lossless revisit", () => {
  it("labels quantity in complete pairs or individual singles", () => {
    expect(equipmentQuantityLabel("dumbbell", true)).toBe("How many pairs");
    expect(equipmentQuantityLabel("dumbbell", false)).toBe("How many singles");
    expect(equipmentQuantityLabel("dumbbell", null)).toBe(
      "Choose pair or single first"
    );
    expect(equipmentQuantityLabel("barbell", null)).toBe("How many");
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
          attrs: { unit: "lb", adjustable: false, pair: true, increments: [10, 20] },
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
    expect(result[2]).toMatchObject({ type: "trap_bar", unit: "kg" });
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
