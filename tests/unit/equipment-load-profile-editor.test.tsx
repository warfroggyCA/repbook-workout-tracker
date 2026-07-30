import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canEditExactEquipmentProfile,
  EquipmentLoadProfileEditor,
  MachineLoadingMethodEditor,
  machineLoadingMethodFor,
  summarizeExactEquipmentProfile,
} from "@/components/equipment/equipment-load-profile-editor";

const baseItem = {
  id: "10000000-0000-4000-8000-000000000001",
  label: "Equipment",
  quantity: 1,
  attrs: {},
} as const;

describe("equipment exact-profile editor", () => {
  it("waits for a stable physical-item identity before exact setup editing", () => {
    expect(canEditExactEquipmentProfile({ id: null })).toBe(false);
    expect(canEditExactEquipmentProfile({
      id: null,
      draftId: "10000000-0000-4000-8000-000000000099",
    })).toBe(true);
    expect(canEditExactEquipmentProfile({ id: baseItem.id })).toBe(true);
  });

  it("makes plate-loaded, weight-stack, and unknown loading methods explicit", () => {
    const html = renderToStaticMarkup(
      <MachineLoadingMethodEditor
        item={{ ...baseItem, type: "machine", label: "Lat Pulldown" }}
        profile={null}
        onChange={vi.fn()}
      />,
    );
    expect(html).toContain("How is this machine loaded?");
    expect(html).toContain("Plate-loaded");
    expect(html).toContain("Weight stack");
    expect(html).toContain("Not yet known");
    expect(html).toContain("will not guess");
    expect(machineLoadingMethodFor(null)).toBe("unknown");
    expect(machineLoadingMethodFor({
      kind: "plate_loaded_machine", id: null, geometryCertainty: "unknown",
      startingResistance: null, startingResistanceUnit: null,
      loadingPointCount: null, balancingRule: null, targetEntryMeaning: null,
      compatiblePlateIds: [],
    })).toBe("plate_loaded");
  });

  it("summarizes certainty without turning unknown geometry into a number", () => {
    expect(summarizeExactEquipmentProfile({
      kind: "cable_machine", id: null, geometryCertainty: "unknown",
      stackCount: null, topology: null, displayedUnit: null, ratioStatus: "unknown",
      ratioNumerator: null, ratioDenominator: null, stackSteps: [],
      compatibleAttachmentItemIds: [],
    })).toBe("Cable geometry unknown");
  });
  it("states that the exact 18 lb EZ-curl bar uses every owned account plate size", () => {
    const html = renderToStaticMarkup(
      <EquipmentLoadProfileEditor
        item={{ ...baseItem, type: "ez_bar", label: "18 lb EZ-curl bar" }}
        profile={{
          kind: "plate_loaded_implement", id: "20000000-0000-4000-8000-000000000001",
          loadingKind: "ez", emptyWeight: 18, collarWeight: 0, unit: "lb",
          sharedPlatePoolCompatible: true,
        }}
        profileUnit="lb"
        plates={[
          { id: "30000000-0000-4000-8000-000000000001", denomination: 1.25, quantity: 2 },
          { id: "30000000-0000-4000-8000-000000000002", denomination: 10, quantity: 4 },
        ]}
        cableStations={[]}
        attachments={[]}
        onChange={vi.fn()}
      />,
    );
    expect(html).toContain("EZ-curl");
    expect(html).toContain("every owned plate size");
    expect(html).toContain("balanced pairs");
  });

  it("shows only machine geometry and compatible owned plates for a plate-loaded machine", () => {
    const html = renderToStaticMarkup(
      <EquipmentLoadProfileEditor
        item={{ ...baseItem, type: "machine", label: "Leg press" }}
        profile={{
          kind: "plate_loaded_machine", id: null, geometryCertainty: "known",
          startingResistance: 40, startingResistanceUnit: "lb", loadingPointCount: 4,
          balancingRule: "identical_each_point", targetEntryMeaning: "total_system",
          compatiblePlateIds: ["30000000-0000-4000-8000-000000000001"],
        }}
        profileUnit="lb"
        plates={[{ id: "30000000-0000-4000-8000-000000000001", denomination: 45, quantity: 4 }]}
        cableStations={[]}
        attachments={[]}
        onChange={vi.fn()}
      />,
    );
    expect(html).toContain("Starting resistance");
    expect(html).toContain("Loading points");
    expect(html).toContain("Compatible plate pool");
    expect(html).toContain("equipment-specific restriction");
    expect(html).not.toContain("Pulley ratio");
  });

  it("keeps unknown cable geometry visibly unknown without invented ratio values", () => {
    const html = renderToStaticMarkup(
      <EquipmentLoadProfileEditor
        item={{ ...baseItem, type: "cable", label: "Cable station" }}
        profile={{
          kind: "cable_machine", id: null, geometryCertainty: "unknown",
          stackCount: null, topology: null, displayedUnit: null, ratioStatus: "unknown",
          ratioNumerator: null, ratioDenominator: null, stackSteps: [],
          compatibleAttachmentItemIds: [],
        }}
        profileUnit="lb"
        plates={[]}
        cableStations={[]}
        attachments={[]}
        onChange={vi.fn()}
      />,
    );
    expect(html).toContain("Unknown — do not calculate");
    expect(html).not.toContain("Ratio numerator");
    expect(html).not.toContain("Recorded stack positions");
  });
});
