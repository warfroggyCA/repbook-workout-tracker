import { describe, expect, it } from "vitest";
import { equipmentTypeEnum } from "@/db/schema/enums";
import {
  EQUIPMENT_TYPE_FAMILY,
  familyForEquipmentType,
  groupEquipmentInventory,
} from "@/lib/equipment-families";

describe("equipment families", () => {
  it("deliberately covers every current equipment type", () => {
    expect(Object.keys(EQUIPMENT_TYPE_FAMILY).sort()).toEqual(
      [...equipmentTypeEnum.enumValues].sort()
    );
    for (const type of equipmentTypeEnum.enumValues) {
      expect(familyForEquipmentType(type), type).not.toBe("uncategorized");
    }
  });

  it("uses a clearly labelled fallback for a future equipment type", () => {
    expect(familyForEquipmentType("future_rotating_handle")).toBe(
      "uncategorized"
    );
  });

  it("keeps every saved item distinct in stable family and item order", () => {
    const groups = groupEquipmentInventory({
      profileUnit: "lb",
      plates: [],
      bars: [],
      items: [
        {
          id: "cable-rope",
          type: "cable",
          label: "Rope handle",
          quantity: 1,
          attrs: {},
          definitionLabel: "Cable rope attachment",
          definitionDescription: "A flexible two-ended cable attachment.",
        },
        {
          id: "bodyweight",
          type: "bodyweight",
          label: "Bodyweight",
          quantity: 1,
          attrs: {},
        },
        {
          id: "cable-station",
          type: "cable",
          label: "Lat-pulldown station",
          quantity: 1,
          attrs: {},
          definitionLabel: "Lat-pulldown station",
        },
        {
          id: "dumbbells",
          type: "dumbbell",
          label: "Adjustable dumbbells",
          quantity: 2,
          attrs: { minWeight: 5, maxWeight: 35, unit: "lb" },
        },
        {
          id: "rack",
          type: "rack",
          label: "Fit505 power rack",
          quantity: 1,
          attrs: { brand: "Fit505" },
        },
      ],
    });

    expect(groups.map((group) => group.key)).toEqual([
      "handheld_weights",
      "stations_and_supports",
      "cables_and_machines",
    ]);
    const cableItems = groups.find(
      (group) => group.key === "cables_and_machines"
    )!.items;
    expect(cableItems.map((item) => item.id)).toEqual([
      "cable-station",
      "cable-rope",
    ]);
    expect(cableItems).toHaveLength(2);
    expect(cableItems[1]).toMatchObject({
      label: "Rope handle",
      quantity: 1,
      definitionDescription: "A flexible two-ended cable attachment.",
    });
    expect(cableItems[1].details).toContain(
      "Specific type: Cable rope attachment"
    );

    const dumbbells = groups[0].items[0];
    expect(dumbbells.quantity).toBe(2);
    expect(dumbbells.details).toContain("Range: 5–35 lb");
    expect(
      groups.find((group) => group.key === "stations_and_supports")!.items[0]
        .details
    ).toContain("Brand: Fit505");
    expect(groups.some((group) => group.key === "no_equipment")).toBe(false);
  });

  it("keeps specialty equipment out of misleading broad buckets", () => {
    const groups = groupEquipmentInventory({
      profileUnit: "kg",
      plates: [],
      bars: [],
      items: [
        {
          id: "trap",
          type: "trap_bar",
          label: "Open trap bar",
          quantity: 1,
          attrs: {},
        },
        {
          id: "landmine",
          type: "landmine",
          label: "Rack-mounted landmine",
          quantity: 1,
          attrs: {},
        },
        {
          id: "future",
          type: "future_rotating_handle",
          label: "Prototype rotating handle",
          quantity: 1,
          attrs: {},
        },
      ],
    });

    expect(groups.find((group) => group.key === "bars_and_plates")!.items[0])
      .toMatchObject({ id: "trap", typeLabel: "Trap / hex bar" });
    expect(
      groups.find((group) => group.key === "specialty_and_attachments")!.items[0]
    ).toMatchObject({ id: "landmine", typeLabel: "Landmine attachment" });
    expect(groups.find((group) => group.key === "uncategorized")).toMatchObject({
      name: "Other / uncategorized equipment",
      items: [{ id: "future", typeLabel: "Future rotating handle" }],
    });
  });

  it("shows one shared plate-pool supplement and hides its legacy marker", () => {
    const groups = groupEquipmentInventory({
      profileUnit: "lb",
      items: [
        {
          id: "plates",
          type: "plates",
          label: "Colour bumper plates",
          quantity: 1,
          attrs: {},
        },
        {
          id: "bar",
          type: "barbell",
          label: "Garage Olympic bar",
          quantity: 2,
          attrs: {},
        },
      ],
      plates: [
        { id: "small", denomination: 2.5, quantity: 2 },
        { id: "large", denomination: 45, quantity: 1 },
        { id: "middle", denomination: 10, quantity: 1 },
      ],
      bars: [
        {
          id: "bar-config",
          barType: "olympic",
          barWeight: 45,
          collarWeight: 2.5,
          quantity: 2,
          label: "Garage Olympic bar",
        },
      ],
    });
    const items = groups[0].items;

    expect(items.map((item) => item.id)).toEqual(["bar"]);
    expect(items[0].quantity).toBe(2);
    expect(items[0].details).toEqual([
      "Empty bar weight: 45 lb",
      "Both collars, total: 2.5 lb",
    ]);
    expect(groups[0].supplements).toEqual([{
      id: "shared-plate-pool",
      label: "Weight plates",
      details: [
      "45 lb × 1 (1 spare)",
      "10 lb × 1 (1 spare)",
      "2.5 lb × 2",
      ],
    }]);
  });
});
