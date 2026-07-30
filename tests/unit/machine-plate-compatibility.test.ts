import { describe, expect, it } from "vitest";
import { resolveProspectiveMachinePlates } from "@/lib/machine-plate-compatibility";

const plates = [
  { id: "10000000-0000-4000-8000-000000000001", denomination: 25, quantity: 4, unit: "lb" as const },
  { id: "10000000-0000-4000-8000-000000000002", denomination: 10, quantity: 2, unit: "lb" as const },
  { id: "10000000-0000-4000-8000-000000000003", denomination: 20, quantity: 4, unit: "kg" as const },
];

describe("prospective machine plate compatibility", () => {
  it("uses every owned matching-unit plate when no restriction is configured", () => {
    expect(resolveProspectiveMachinePlates({
      startingResistanceUnit: "lb",
      compatiblePlateIds: [],
    }, plates)).toEqual(plates.slice(0, 2));
  });

  it("never mixes opposite-unit plates into the default pool", () => {
    expect(resolveProspectiveMachinePlates({
      startingResistanceUnit: "kg",
      compatiblePlateIds: [],
    }, plates)).toEqual([plates[2]]);
  });

  it("honors a non-empty equipment-specific restriction", () => {
    expect(resolveProspectiveMachinePlates({
      startingResistanceUnit: "lb",
      compatiblePlateIds: [plates[1].id, plates[2].id],
    }, plates)).toEqual([plates[1]]);
  });

  it("does not infer a plate unit when machine geometry has none", () => {
    expect(resolveProspectiveMachinePlates({
      startingResistanceUnit: null,
      compatiblePlateIds: [],
    }, plates)).toEqual([]);
  });
});
