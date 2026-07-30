import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EquipmentInventory } from "@/components/equipment/equipment-inventory";
import { groupEquipmentInventory } from "@/lib/equipment-families";

describe("Settings equipment inventory", () => {
  it("renders accessible collapsed family cards with complete saved details", () => {
    const groups = groupEquipmentInventory({
      profileUnit: "lb",
      items: [
        {
          id: "rack",
          type: "rack",
          label: "Fit505 rack with spotter arms",
          quantity: 1,
          attrs: { brand: "Fit505", notes: "Includes spotter arms" },
        },
        {
          id: "plates",
          type: "plates",
          label: "Olympic plates",
          quantity: 1,
          attrs: {},
        },
      ],
      plates: [{ id: "plate-45", denomination: 45, quantity: 2 }],
      bars: [],
    });

    const html = renderToStaticMarkup(<EquipmentInventory groups={groups} />);

    expect(html).toContain('aria-label="Equipment inventory"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="region"');
    expect(html).toContain("hidden");
    expect(html).toContain("Bars &amp; weight plates");
    expect(html).toContain("Racks, benches &amp; stations");
    expect(html).toContain('data-equipment-icon="bars_and_plates"');
    expect(html).toContain('data-equipment-icon="stations_and_supports"');
    expect(html).toContain("Fit505 rack with spotter arms");
    expect(html).toContain("1 item");
    expect(html).toContain("Brand: Fit505");
    expect(html).toContain("Includes spotter arms");
    expect(html).toContain("45 lb × 2");
    expect(html).not.toContain("Olympic plates");
    expect(html).not.toContain("Quantity 1");
  });

  it("keeps the empty state useful without offering a destructive action", () => {
    const html = renderToStaticMarkup(<EquipmentInventory groups={[]} />);

    expect(html).toContain("No equipment recorded.");
    expect(html).toContain("Your workouts, program, and history remain");
    expect(html).not.toContain("Delete");
    expect(html).not.toContain("Reset");
  });
});
