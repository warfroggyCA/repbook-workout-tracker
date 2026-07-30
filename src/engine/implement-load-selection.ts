import type { PlateMathConfig } from "@/engine/plate-math";

export type PlateLoadedImplementCandidate = {
  equipmentItemId: string;
  configurationId: string;
  label: string;
  loadingKind: "olympic" | "ez" | "trap_hex" | "specialty";
  emptyWeight: number;
  collarWeight: number;
  unit: "lb" | "kg";
  sharedPlatePoolCompatible: boolean;
  available: boolean;
};

export type SharedPlateInventory = {
  denomination: number;
  /** Total individual plates. */
  quantity: number;
};

export type ImplementLoadSelection =
  | {
      status: "unavailable";
      candidates: PlateLoadedImplementCandidate[];
      selected: null;
      plateConfig: null;
    }
  | {
      status: "selection_required";
      candidates: PlateLoadedImplementCandidate[];
      selected: null;
      plateConfig: null;
    }
  | {
      status: "selected";
      selection: "automatic" | "explicit";
      candidates: PlateLoadedImplementCandidate[];
      selected: PlateLoadedImplementCandidate;
      plateGuidance: "exact" | "unavailable";
      plateConfig: PlateMathConfig | null;
    };

function loadingKindForExercise(loadType: string) {
  if (loadType === "barbell") return "olympic";
  if (loadType === "ez_bar") return "ez";
  if (loadType === "trap_bar") return "trap_hex";
  if (loadType === "specialty_bar") return "specialty";
  return null;
}

function ordered(candidates: PlateLoadedImplementCandidate[]) {
  return [...candidates].sort(
    (left, right) =>
      left.label.localeCompare(right.label) ||
      left.equipmentItemId.localeCompare(right.equipmentItemId),
  );
}

/**
 * Resolve a physical plate-loaded implement without broad-type last-row-wins
 * behavior. Multiple plausible implements deliberately produce no plate
 * configuration until the user chooses one.
 */
export function resolveImplementLoadSelection(input: {
  loadType: string;
  candidates: PlateLoadedImplementCandidate[];
  selectedEquipmentItemId: string | null;
  sharedPlates: SharedPlateInventory[];
}): ImplementLoadSelection {
  const loadingKind = loadingKindForExercise(input.loadType);
  const candidates = ordered(
    input.candidates.filter(
      (candidate) =>
        loadingKind != null &&
        candidate.loadingKind === loadingKind &&
        candidate.available &&
        Number.isFinite(candidate.emptyWeight) &&
        candidate.emptyWeight > 0 &&
        Number.isFinite(candidate.collarWeight) &&
        candidate.collarWeight >= 0,
    ),
  );
  if (candidates.length === 0) {
    return { status: "unavailable", candidates, selected: null, plateConfig: null };
  }

  const selected = input.selectedEquipmentItemId
    ? candidates.find(
        (candidate) =>
          candidate.equipmentItemId === input.selectedEquipmentItemId,
      ) ?? null
    : candidates.length === 1
      ? candidates[0]
      : null;
  if (selected == null) {
    return {
      status: "selection_required",
      candidates,
      selected: null,
      plateConfig: null,
    };
  }

  if (!selected.sharedPlatePoolCompatible) {
    return {
      status: "selected",
      selection: input.selectedEquipmentItemId ? "explicit" : "automatic",
      candidates,
      selected,
      plateGuidance: "unavailable",
      plateConfig: null,
    };
  }

  const plateConfig: PlateMathConfig = {
    barWeight: selected.emptyWeight,
    collarWeight: selected.collarWeight,
    plates: input.sharedPlates
      .filter(
        (plate) =>
          Number.isFinite(plate.denomination) &&
          plate.denomination > 0 &&
          Number.isInteger(plate.quantity) &&
          plate.quantity >= 0,
      )
      .map((plate) => ({
        denomination: plate.denomination,
        countPerSide: Math.floor(plate.quantity / 2),
      })),
  };
  return {
    status: "selected",
    selection: input.selectedEquipmentItemId ? "explicit" : "automatic",
    candidates,
    selected,
    plateGuidance: "exact",
    plateConfig,
  };
}
