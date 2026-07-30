import { describe, expect, it } from "vitest";
import { achievableLoads } from "@/engine/plate-math";
import {
  resolveImplementLoadSelection,
  type PlateLoadedImplementCandidate,
} from "@/engine/implement-load-selection";

const ez18: PlateLoadedImplementCandidate = {
  equipmentItemId: "00000000-0000-4000-8000-000000000018",
  configurationId: "10000000-0000-4000-8000-000000000018",
  label: "18 lb curl bar",
  loadingKind: "ez",
  emptyWeight: 18,
  collarWeight: 0,
  unit: "lb",
  sharedPlatePoolCompatible: true,
  available: true,
};

describe("resolveImplementLoadSelection", () => {
  it("requires an explicit choice instead of letting the last EZ row win", () => {
    const result = resolveImplementLoadSelection({
      loadType: "ez_bar",
      candidates: [
        { ...ez18, equipmentItemId: "bar-25", label: "25 lb curl bar", emptyWeight: 25 },
        ez18,
      ],
      selectedEquipmentItemId: null,
      sharedPlates: [{ denomination: 1.25, quantity: 4 }],
    });

    expect(result).toMatchObject({
      status: "selection_required",
      selected: null,
      plateConfig: null,
    });
    expect(result.candidates.map((candidate) => candidate.label)).toEqual([
      "18 lb curl bar",
      "25 lb curl bar",
    ]);
  });

  it("auto-selects the sole compatible identity and preserves the 18 lb matrix", () => {
    const result = resolveImplementLoadSelection({
      loadType: "ez_bar",
      candidates: [ez18],
      selectedEquipmentItemId: null,
      sharedPlates: [{ denomination: 1.25, quantity: 6 }],
    });

    expect(result.status).toBe("selected");
    if (result.status !== "selected" || result.plateConfig == null) {
      throw new Error("Expected a selected implement with exact plate guidance.");
    }
    expect(result).toMatchObject({
      selection: "automatic",
      selected: { equipmentItemId: ez18.equipmentItemId, emptyWeight: 18 },
      plateGuidance: "exact",
    });
    expect(achievableLoads(result.plateConfig).slice(0, 4)).toEqual([
      18, 20.5, 23, 25.5,
    ]);
  });

  it("uses only the exact selected same-type implement", () => {
    const other = {
      ...ez18,
      equipmentItemId: "bar-25",
      configurationId: "config-25",
      label: "25 lb curl bar",
      emptyWeight: 25,
    };
    const result = resolveImplementLoadSelection({
      loadType: "ez_bar",
      candidates: [ez18, other],
      selectedEquipmentItemId: other.equipmentItemId,
      sharedPlates: [{ denomination: 2.5, quantity: 2 }],
    });

    expect(result).toMatchObject({
      status: "selected",
      selection: "explicit",
      selected: { label: "25 lb curl bar" },
      plateConfig: { barWeight: 25 },
    });
  });

  it("keeps physical identity selectable while withholding incompatible plate guidance", () => {
    expect(resolveImplementLoadSelection({
      loadType: "ez_bar",
      candidates: [{ ...ez18, sharedPlatePoolCompatible: false }],
      selectedEquipmentItemId: ez18.equipmentItemId,
      sharedPlates: [],
    })).toMatchObject({
      status: "selected",
      selected: { equipmentItemId: ez18.equipmentItemId },
      plateGuidance: "unavailable",
      plateConfig: null,
    });
  });

  it("makes every owned plate denomination available to the 18 lb EZ bar", () => {
    const result = resolveImplementLoadSelection({
      loadType: "ez_bar",
      candidates: [ez18],
      selectedEquipmentItemId: ez18.equipmentItemId,
      sharedPlates: [
        { denomination: 1.25, quantity: 4 },
        { denomination: 2.5, quantity: 2 },
        { denomination: 5, quantity: 2 },
        { denomination: 10, quantity: 2 },
      ],
    });
    expect(result.status).toBe("selected");
    if (result.status !== "selected" || result.plateConfig == null) {
      throw new Error("Expected exact EZ-bar plate guidance.");
    }
    expect(result.plateConfig.plates).toEqual([
      { denomination: 1.25, countPerSide: 2 },
      { denomination: 2.5, countPerSide: 1 },
      { denomination: 5, countPerSide: 1 },
      { denomination: 10, countPerSide: 1 },
    ]);
    expect(achievableLoads(result.plateConfig)).toEqual(
      expect.arrayContaining([18, 20.5, 23, 25.5, 28, 33, 38, 43, 48]),
    );
  });

  it("never offers precise guidance for a stale selection", () => {

    expect(
      resolveImplementLoadSelection({
        loadType: "ez_bar",
        candidates: [ez18, { ...ez18, equipmentItemId: "bar-25" }],
        selectedEquipmentItemId: "retired-bar",
        sharedPlates: [],
      }),
    ).toMatchObject({ status: "selection_required", plateConfig: null });
  });
});
