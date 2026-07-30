import { describe, expect, it } from "vitest";
import {
  buildHistoryEquipmentSetProjection,
  formatHistoryEquipmentSetup,
  formatHistoryPerformedSetup,
  formatHistoryLoadEntryMeaning,
  type HistoryEquipmentSetInput,
} from "@/lib/history-equipment-presentation";

const ezSnapshot = {
  id: "10000000-0000-4000-8000-000000000001",
  equipmentLabel: "18 lb EZ-curl bar",
  attachmentLabel: null,
  geometrySnapshot: {
    version: 1,
    kind: "plate_loaded_implement",
    loadingKind: "ez",
    emptyWeight: 18,
    collarWeight: 0,
    unit: "lb",
    sharedPlatePoolCompatible: true,
    compatiblePlates: [
      { denomination: 1.25, quantity: 2, unit: "lb" },
      { denomination: 2.5, quantity: 2, unit: "lb" },
      { denomination: 5, quantity: 2, unit: "lb" },
      { denomination: 10, quantity: 2, unit: "lb" },
    ],
  },
} as const;

describe("History equipment presentation", () => {
  it("shows the immutable 18 lb EZ bar and treats the entered load as the assembled total", () => {
    expect(formatHistoryEquipmentSetup(ezSnapshot)).toEqual({
      snapshotId: ezSnapshot.id,
      title: "18 lb EZ-curl bar",
      details: [
        "Recorded EZ-curl bar: 18 lb empty weight with no added collar weight.",
        "The account plate pool available at workout time is preserved in this snapshot.",
      ],
    });
    expect(formatHistoryLoadEntryMeaning({
      weight: 23,
      weightUnit: "lb",
      loadEntryMeaning: "total_system",
      equipmentSnapshot: ezSnapshot,
    })).toBe("23 lb assembled total (implement, collars, and plates).");
    expect(formatHistoryPerformedSetup({
      weight: 23,
      weightUnit: "lb",
      loadEntryMeaning: "total_system",
      equipmentSnapshot: ezSnapshot,
    })).toBe(
      "18 lb EZ-curl bar; plates on each side: 2.5 lb; assembled total: 23 lb.",
    );
  });

  it.each([
    [18, "18 lb EZ-curl bar; plates on each side: no added plates; assembled total: 18 lb."],
    [20.5, "18 lb EZ-curl bar; plates on each side: 1.25 lb; assembled total: 20.5 lb."],
    [25.5, "18 lb EZ-curl bar; plates on each side: 2.5 lb + 1.25 lb; assembled total: 25.5 lb."],
    [38, "18 lb EZ-curl bar; plates on each side: 10 lb; assembled total: 38 lb."],
  ])("reconstructs the 18 lb EZ bar with any exact balanced owned-plate combination at %s lb", (weight, expected) => {
    expect(formatHistoryPerformedSetup({
      weight,
      weightUnit: "lb",
      loadEntryMeaning: "total_system",
      equipmentSnapshot: ezSnapshot,
    })).toBe(expected);
  });

  it("shows the exact saved machine plates per loading point and canonical total", () => {
    const snapshot = {
      id: "30000000-0000-4000-8000-000000000002",
      equipmentLabel: "Plate-loaded press",
      attachmentLabel: null,
      geometrySnapshot: {
        version: 1,
        kind: "plate_loaded_machine",
        geometryCertainty: "known",
        startingResistance: 10,
        startingResistanceUnit: "lb",
        loadingPointCount: 4,
        balancingRule: "identical_each_point",
        targetEntryMeaning: "per_loading_point",
        compatiblePlates: [
          { denomination: 10, quantity: 4, unit: "lb" },
          { denomination: 5, quantity: 4, unit: "lb" },
        ],
      },
    } as const;
    expect(formatHistoryPerformedSetup({
      weight: 15,
      weightUnit: "lb",
      loadEntryMeaning: "per_loading_point",
      equipmentSnapshot: snapshot,
    })).toBe(
      "plates on each of 4 loading points: 10 lb + 5 lb; starting resistance: 10 lb; canonical total resistance: 70 lb.",
    );
  });

  it("shows exact saved cable positions and names known ratios as nominal, not measured force", () => {
    const snapshot = {
      id: "50000000-0000-4000-8000-000000000002",
      equipmentLabel: "Dual cable",
      attachmentLabel: "Lat bar",
      geometrySnapshot: {
        version: 1,
        kind: "cable_machine",
        geometryCertainty: "known",
        stackCount: 2,
        topology: "independent_per_stack",
        displayedUnit: "lb",
        ratioStatus: "known",
        ratioNumerator: 1,
        ratioDenominator: 2,
        stackSteps: [
          { stackIndex: 1, stepIndex: 5, displayedLoad: 40, positionLabel: "Left pin 5" },
          { stackIndex: 1, stepIndex: 6, displayedLoad: 50, positionLabel: "Left pin 6" },
          { stackIndex: 2, stepIndex: 4, displayedLoad: 30, positionLabel: "Right pin 4" },
          { stackIndex: 2, stepIndex: 5, displayedLoad: 40, positionLabel: "Right pin 5" },
        ],
      },
    } as const;
    expect(formatHistoryPerformedSetup({
      weight: 70,
      weightUnit: "lb",
      loadEntryMeaning: "combined_stacks",
      equipmentSnapshot: snapshot,
    })).toBe(
      "stack 1: Left pin 5 at 40 lb; stack 2: Right pin 4 at 30 lb. 35 lb combined nominal handle resistance; this is not measured force.",
    );
    expect(formatHistoryPerformedSetup({
      weight: 80,
      weightUnit: "lb",
      loadEntryMeaning: "combined_stacks",
      equipmentSnapshot: snapshot,
    })).toContain("does not prove one unique stack-position combination");
  });

  it("keeps unknown and impossible historical setups explicitly unknown", () => {
    expect(formatHistoryPerformedSetup({
      weight: 24,
      weightUnit: "lb",
      loadEntryMeaning: "total_system",
      equipmentSnapshot: ezSnapshot,
    })).toContain("Exact performed setup is unknown");
    expect(formatHistoryPerformedSetup({
      weight: 28,
      weightUnit: "lb",
      loadEntryMeaning: "total_system",
      equipmentSnapshot: {
        ...ezSnapshot,
        geometrySnapshot: {
          ...ezSnapshot.geometrySnapshot,
          compatiblePlates: ezSnapshot.geometrySnapshot.compatiblePlates.map((plate) =>
            plate.denomination === 2.5 ? { ...plate, quantity: 4 } : plate
          ),
        },
      },
    })).toContain("does not prove one unique plate combination");
    expect(formatHistoryPerformedSetup({
      weight: 40,
      weightUnit: "kg",
      loadEntryMeaning: "legacy_unknown",
      equipmentSnapshot: null,
    })).toBe(
      "Exact performed setup is unknown; the historical record has not been relabelled.",
    );
  });

  it.each([
    ["total_system", "80 lb total system resistance."],
    ["per_loading_point", "20 lb added plate load per loading point. The recorded geometry gives 90 lb canonical total resistance (10 lb start + 20 lb × 4 points)."],
    ["displayed_stack", "50 lb displayed stack setting. Recorded 1:1 ratio gives 50 lb nominal handle resistance; this is not measured force."],
    ["per_stack", "50 lb on each independently selected stack. Recorded 1:1 ratio gives 50 lb nominal handle resistance for each stack; this is not measured force."],
    ["combined_stacks", "100 lb combined across the independently selected stacks. Recorded 1:1 ratio gives 100 lb nominal handle resistance combined; this is not measured force."],
  ] as const)("distinguishes the %s load-entry meaning", (loadEntryMeaning, expected) => {
    const kind = loadEntryMeaning === "displayed_stack" ||
      loadEntryMeaning === "per_stack" ||
      loadEntryMeaning === "combined_stacks"
      ? "cable_machine"
      : "plate_loaded_machine";
    const equipmentSnapshot = kind === "cable_machine"
      ? (() => {
          const shared = loadEntryMeaning === "displayed_stack";
          return {
          id: "20000000-0000-4000-8000-000000000001",
          equipmentLabel: "Cable tower",
          attachmentLabel: "Rope",
          geometrySnapshot: {
            version: 1,
            kind,
            geometryCertainty: "known",
            stackCount: shared ? 1 : 2,
            topology: shared ? "shared_selection" : "independent_per_stack",
            displayedUnit: "lb",
            ratioStatus: "known",
            ratioNumerator: 1,
            ratioDenominator: 1,
            stackSteps: shared
              ? [{ stackIndex: 0, stepIndex: 5, displayedLoad: 50, positionLabel: "Pin 5" }]
              : [
                  { stackIndex: 1, stepIndex: 5, displayedLoad: 50, positionLabel: "Left 5" },
                  { stackIndex: 2, stepIndex: 5, displayedLoad: 50, positionLabel: "Right 5" },
                ],
          },
        };
        })()
      : {
          id: "30000000-0000-4000-8000-000000000001",
          equipmentLabel: "Plate-loaded press",
          attachmentLabel: null,
          geometrySnapshot: {
            version: 1,
            kind,
            geometryCertainty: "known",
            startingResistance: 10,
            startingResistanceUnit: "lb",
            loadingPointCount: 4,
            balancingRule: "identical_each_point",
            targetEntryMeaning: loadEntryMeaning,
            compatiblePlates: [],
          },
        };
    expect(formatHistoryLoadEntryMeaning({
      weight: loadEntryMeaning === "per_loading_point" ? 20 : loadEntryMeaning === "combined_stacks" ? 100 : loadEntryMeaning === "displayed_stack" || loadEntryMeaning === "per_stack" ? 50 : 80,
      weightUnit: "lb",
      loadEntryMeaning,
      equipmentSnapshot,
    })).toBe(expected);
  });

  it("keeps an unknown cable ratio unknown instead of deriving an effective load", () => {
    const snapshot = {
      id: "40000000-0000-4000-8000-000000000001",
      equipmentLabel: "Garage cable tower",
      attachmentLabel: "Straight bar",
      geometrySnapshot: {
        version: 1,
        kind: "cable_machine",
        geometryCertainty: "unknown",
        stackCount: null,
        topology: null,
        displayedUnit: null,
        ratioStatus: "unknown",
        ratioNumerator: null,
        ratioDenominator: null,
        stackSteps: [],
      },
    } as const;
    expect(formatHistoryEquipmentSetup(snapshot)).toEqual({
      snapshotId: snapshot.id,
      title: "Garage cable tower · Straight bar",
      details: [
        "Cable geometry was recorded as unknown; the historical stack setup is not fully known.",
        "Pulley ratio was recorded as unknown, so effective handle load remains unknown.",
      ],
    });
    expect(formatHistoryLoadEntryMeaning({
      weight: 50,
      weightUnit: "lb",
      loadEntryMeaning: "displayed_stack",
      equipmentSnapshot: snapshot,
    })).toBe(
      "50 lb displayed stack setting. Pulley ratio was unknown, so effective handle load is unknown.",
    );
  });

  it("uses only a complete recorded ratio to name nominal—not measured—handle resistance", () => {
    const snapshot = {
      id: "50000000-0000-4000-8000-000000000001",
      equipmentLabel: "Half-ratio cable",
      attachmentLabel: null,
      geometrySnapshot: {
        version: 1,
        kind: "cable_machine",
        geometryCertainty: "known",
        stackCount: 1,
        topology: "shared_selection",
        displayedUnit: "lb",
        ratioStatus: "known",
        ratioNumerator: 1,
        ratioDenominator: 2,
        stackSteps: [
          { stackIndex: 0, stepIndex: 5, displayedLoad: 50, positionLabel: "Pin 5" },
        ],
      },
    } as const;
    expect(formatHistoryLoadEntryMeaning({
      weight: 50,
      weightUnit: "lb",
      loadEntryMeaning: "displayed_stack",
      equipmentSnapshot: snapshot,
    })).toBe(
      "50 lb displayed stack setting. Recorded 1:2 ratio gives 25 lb nominal handle resistance; this is not measured force.",
    );
    expect(formatHistoryLoadEntryMeaning({
      weight: 50,
      weightUnit: "kg",
      loadEntryMeaning: "displayed_stack",
      equipmentSnapshot: snapshot,
    })).toBe("50 kg displayed stack setting.");
  });

  it("does not relabel imported or other legacy history", () => {
    expect(formatHistoryLoadEntryMeaning({
      weight: 40,
      weightUnit: "kg",
      loadEntryMeaning: "legacy_unknown",
      equipmentSnapshot: null,
    })).toBe("40 kg has historical load meaning unknown. It has not been relabelled.");
  });

  it("groups adjacent sets by immutable snapshot while retaining each set's explicit meaning", () => {
    const sets: HistoryEquipmentSetInput[] = [
      { id: "set-1", weight: 23, weightUnit: "lb", loadEntryMeaning: "total_system", equipmentSnapshot: ezSnapshot },
      { id: "set-2", weight: 28, weightUnit: "lb", loadEntryMeaning: "total_system", equipmentSnapshot: ezSnapshot },
      { id: "set-3", weight: 40, weightUnit: "lb", loadEntryMeaning: "legacy_unknown", equipmentSnapshot: null },
    ];
    const projection = buildHistoryEquipmentSetProjection(sets);
    expect(projection.map((row) => row.setup?.snapshotId ?? null)).toEqual([
      ezSnapshot.id,
      null,
      null,
    ]);
    expect(projection.map((row) => row.loadMeaning)).toEqual([
      "23 lb assembled total (implement, collars, and plates).",
      "28 lb assembled total (implement, collars, and plates).",
      "40 lb has historical load meaning unknown. It has not been relabelled.",
    ]);
    expect(projection.map((row) => row.performedSetup)).toEqual([
      "18 lb EZ-curl bar; plates on each side: 2.5 lb; assembled total: 23 lb.",
      "18 lb EZ-curl bar; plates on each side: 5 lb; assembled total: 28 lb.",
      "Exact performed setup is unknown; the historical record has not been relabelled.",
    ]);
  });
});
