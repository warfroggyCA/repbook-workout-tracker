import {
  sessionEquipmentGeometrySnapshotSchema,
  type SessionEquipmentGeometrySnapshot,
} from "@/lib/session-equipment-snapshot-contract";
import { solvePlates } from "@/engine/plate-math";
import { solveMachineLoad } from "@/engine/machine-load-math";
import {
  selectCableLoad,
  selectCombinedIndependentCableLoad,
  type CableLoadConfig,
  type CableStackStep,
} from "@/engine/cable-load-selection";

const MAX_HISTORY_SETUP_SUMS = 20_000;

export type HistoryLoadEntryMeaning =
  | "total_system"
  | "per_loading_point"
  | "displayed_stack"
  | "per_stack"
  | "combined_stacks"
  | "legacy_unknown";

export type HistoryEquipmentSnapshotInput = {
  id: string;
  equipmentLabel: string;
  attachmentLabel: string | null;
  geometrySnapshot: unknown;
};

export type HistoryEquipmentSetInput = {
  id: string;
  weight: number | null;
  weightUnit: "lb" | "kg" | null;
  loadEntryMeaning: string;
  equipmentSnapshot: HistoryEquipmentSnapshotInput | null;
};

export type HistoryEquipmentSetupPresentation = {
  snapshotId: string;
  title: string;
  details: string[];
};

export type HistoryEquipmentSetPresentation<T extends HistoryEquipmentSetInput> = {
  set: T;
  setup: HistoryEquipmentSetupPresentation | null;
  loadMeaning: string;
  performedSetup: string | null;
};

function loadText(weight: number | null, unit: "lb" | "kg" | null) {
  return weight != null && unit != null ? `${weight} ${unit}` : "The recorded load";
}

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function uniquePlateCombination(
  target: number,
  plates: Array<{ denomination: number; capacity: number }>,
) {
  type Choice = { count: 1 | 2; plates: number[] };
  let sums = new Map<number, Choice>([[0, { count: 1, plates: [] }]]);
  for (const plate of [...plates].sort((left, right) => right.denomination - left.denomination)) {
    const next = new Map<number, Choice>();
    for (const [sum, choice] of sums) {
      for (let quantity = 0; quantity <= plate.capacity; quantity += 1) {
        const nextSum = round2(sum + plate.denomination * quantity);
        const candidate = {
          count: choice.count,
          plates: [
            ...choice.plates,
            ...Array<number>(quantity).fill(plate.denomination),
          ],
        } satisfies Choice;
        const current = next.get(nextSum);
        if (current) {
          current.count = 2;
        } else {
          next.set(nextSum, candidate);
        }
        if (next.size > MAX_HISTORY_SETUP_SUMS) return null;
      }
    }
    sums = next;
  }
  const exact = sums.get(round2(target));
  return exact?.count === 1 ? exact.plates : null;
}

function equipmentTitle(snapshot: HistoryEquipmentSnapshotInput) {
  return snapshot.attachmentLabel
    ? `${snapshot.equipmentLabel} · ${snapshot.attachmentLabel}`
    : snapshot.equipmentLabel;
}

function implementName(geometry: Extract<SessionEquipmentGeometrySnapshot, { kind: "plate_loaded_implement" }>) {
  if (geometry.loadingKind === "ez") return "EZ-curl bar";
  if (geometry.loadingKind === "trap_hex") return "trap/hex bar";
  if (geometry.loadingKind === "olympic") return "bar";
  return "implement";
}

function platesText(plates: number[], unit: "lb" | "kg") {
  return plates.length > 0
    ? plates.map((plate) => `${plate} ${unit}`).join(" + ")
    : "no added plates";
}

function cableConfig(
  geometry: Extract<SessionEquipmentGeometrySnapshot, { kind: "cable_machine" }>,
): CableLoadConfig {
  const stackIndexes = [...new Set(geometry.stackSteps.map((step) => step.stackIndex))]
    .sort((left, right) => left - right);
  return {
    geometryStatus: geometry.geometryCertainty,
    stackCount: geometry.stackCount,
    topology: geometry.topology,
    unit: geometry.displayedUnit,
    schedules: stackIndexes.map((stackOrdinal) => ({
      stackOrdinal,
      steps: geometry.stackSteps
        .filter((step) => step.stackIndex === stackOrdinal)
        .map((step) => ({
          stepIndex: step.stepIndex,
          displayedLoad: step.displayedLoad,
          positionLabel: step.positionLabel,
        })),
    })),
    ratio: geometry.ratioStatus === "known" &&
      geometry.ratioNumerator != null && geometry.ratioDenominator != null
      ? {
          status: "known",
          numerator: geometry.ratioNumerator,
          denominator: geometry.ratioDenominator,
        }
      : { status: "unknown" },
  };
}

function cablePosition(step: CableStackStep) {
  return step.positionLabel ?? `recorded position ${step.stepIndex}`;
}

function cableRatioMeaning(
  geometry: Extract<SessionEquipmentGeometrySnapshot, { kind: "cable_machine" }>,
  nominal: string | null,
) {
  if (geometry.ratioStatus === "unknown") {
    return "Pulley ratio was unknown, so effective handle load remains unknown.";
  }
  return nominal
    ? `${nominal} nominal handle resistance; this is not measured force.`
    : null;
}

function uniqueCombinedCableSteps(
  target: number,
  config: CableLoadConfig,
) {
  type Selection = { stackOrdinal: number; step: CableStackStep };
  type Choice = { count: 1 | 2; selections: Selection[] };
  let sums = new Map<number, Choice>([[0, { count: 1, selections: [] }]]);
  for (const schedule of [...(config.schedules ?? [])].sort(
    (left, right) => left.stackOrdinal - right.stackOrdinal,
  )) {
    const next = new Map<number, Choice>();
    for (const [sum, choice] of sums) {
      for (const step of schedule.steps) {
        const nextSum = round2(sum + step.displayedLoad);
        const candidate = {
          count: choice.count,
          selections: [
            ...choice.selections,
            { stackOrdinal: schedule.stackOrdinal, step },
          ],
        } satisfies Choice;
        const current = next.get(nextSum);
        if (current) {
          current.count = 2;
        } else {
          next.set(nextSum, candidate);
        }
        if (next.size > MAX_HISTORY_SETUP_SUMS) return null;
      }
    }
    sums = next;
  }
  const exact = sums.get(round2(target));
  return exact?.count === 1 ? exact.selections : null;
}

/**
 * Reconstructs only an exact performed setup proven by the immutable workout
 * snapshot and the completed set's own load evidence. It never consults live
 * equipment and never substitutes a nearest setup for historical fact.
 */
export function formatHistoryPerformedSetup(
  set: Pick<HistoryEquipmentSetInput, "weight" | "weightUnit" | "loadEntryMeaning" | "equipmentSnapshot">,
): string | null {
  if (set.weight == null) return null;
  if (
    set.weightUnit == null ||
    set.equipmentSnapshot == null ||
    set.loadEntryMeaning === "legacy_unknown"
  ) {
    return "Exact performed setup is unknown; the historical record has not been relabelled.";
  }
  const parsed = sessionEquipmentGeometrySnapshotSchema.safeParse(
    set.equipmentSnapshot.geometrySnapshot,
  );
  if (!parsed.success) {
    return "Exact performed setup is unknown because the saved equipment geometry is unavailable.";
  }

  const geometry = parsed.data;
  if (geometry.kind === "plate_loaded_implement") {
    if (
      set.loadEntryMeaning !== "total_system" ||
      set.weightUnit !== geometry.unit
    ) {
      return "Exact performed setup is unknown because the recorded load does not match the saved implement meaning and unit.";
    }
    const solution = solvePlates(set.weight, {
      barWeight: geometry.emptyWeight,
      collarWeight: geometry.collarWeight,
      plates: geometry.compatiblePlates.map((plate) => ({
        denomination: plate.denomination,
        countPerSide: Math.floor(plate.quantity / 2),
      })),
    });
    if (!solution) {
      return "Exact performed setup is unknown because the recorded total is not loadable from the saved plate snapshot.";
    }
    const uniquePlates = uniquePlateCombination(
      (set.weight - geometry.emptyWeight - geometry.collarWeight) / 2,
      geometry.compatiblePlates.map((plate) => ({
        denomination: plate.denomination,
        capacity: Math.floor(plate.quantity / 2),
      })),
    );
    if (uniquePlates == null) {
      return "Exact performed setup is unknown because the saved evidence does not prove one unique plate combination for the recorded total.";
    }
    return `${geometry.emptyWeight} ${geometry.unit} ${implementName(geometry)}; plates on each side: ${platesText(uniquePlates, geometry.unit)}; assembled total: ${solution.totalLoad} ${geometry.unit}.`;
  }

  if (geometry.kind === "plate_loaded_machine") {
    if (
      geometry.geometryCertainty !== "known" ||
      geometry.targetEntryMeaning !== set.loadEntryMeaning ||
      geometry.startingResistanceUnit !== set.weightUnit
    ) {
      return "Exact performed setup is unknown because complete matching machine geometry was not recorded.";
    }
    const result = solveMachineLoad(set.weight, {
      geometryStatus: geometry.geometryCertainty,
      startingResistance: geometry.startingResistance,
      unit: geometry.startingResistanceUnit,
      loadingPointCount: geometry.loadingPointCount,
      balancingRule: geometry.balancingRule,
      targetEntryMeaning: geometry.targetEntryMeaning,
      compatiblePlates: geometry.compatiblePlates.map((plate) => ({
        denomination: plate.denomination,
        quantity: plate.quantity,
      })),
    });
    if (result.status === "unavailable" || result.exact == null) {
      return "Exact performed setup is unknown because the recorded load is not exactly loadable from the saved machine snapshot.";
    }
    const pointMultiplier = geometry.balancingRule === "identical_each_point"
      ? geometry.loadingPointCount!
      : 1;
    const uniquePlates = uniquePlateCombination(
      result.exact.addedLoadPerPoint,
      geometry.compatiblePlates.map((plate) => ({
        denomination: plate.denomination,
        capacity: Math.floor(plate.quantity / pointMultiplier),
      })),
    );
    if (uniquePlates == null) {
      return "Exact performed setup is unknown because the saved evidence does not prove one unique machine plate combination for the recorded load.";
    }
    const points = uniquePlates.length > 0
      ? geometry.loadingPointCount === 1
        ? `plates on the loading point: ${platesText(uniquePlates, result.unit)}`
        : `plates on each of ${geometry.loadingPointCount} loading points: ${platesText(uniquePlates, result.unit)}`
      : `no added plates on the ${geometry.loadingPointCount === 1 ? "loading point" : `${geometry.loadingPointCount} loading points`}`;
    return `${points}; starting resistance: ${geometry.startingResistance} ${result.unit}; canonical total resistance: ${result.exact.canonicalTotalLoad} ${result.unit}.`;
  }

  if (
    geometry.geometryCertainty !== "known" ||
    geometry.displayedUnit !== set.weightUnit
  ) {
    return "Exact performed cable setup is unknown because complete matching stack geometry was not recorded.";
  }
  const config = cableConfig(geometry);
  if (
    geometry.topology === "shared_selection" &&
    set.loadEntryMeaning === "displayed_stack"
  ) {
    const result = selectCableLoad(set.weight, config);
    if (result.status === "unavailable" || result.selections[0]?.exact == null) {
      return "Exact performed cable setup is unknown because the displayed load does not match a saved stack position.";
    }
    const step = result.selections[0].exact;
    const exactPositions = config.schedules?.[0]?.steps.filter(
      (candidate) => Math.abs(candidate.displayedLoad - set.weight!) < 1e-9,
    ) ?? [];
    if (exactPositions.length !== 1) {
      return "Exact performed cable setup is unknown because the saved stack has more than one position for the recorded load.";
    }
    const ratio = cableRatioMeaning(
      geometry,
      result.nominalHandleResistance?.[0] != null
        ? `${result.nominalHandleResistance[0]} ${result.unit}`
        : null,
    );
    return [
      `Stack: ${cablePosition(step)} at ${step.displayedLoad} ${result.unit}.`,
      ratio,
    ].filter((value): value is string => value != null).join(" ");
  }
  if (
    geometry.topology === "independent_per_stack" &&
    set.loadEntryMeaning === "per_stack"
  ) {
    const result = selectCableLoad(
      Array.from({ length: geometry.stackCount ?? 0 }, () => set.weight!),
      config,
    );
    if (
      result.status === "unavailable" ||
      result.selections.some((selection) => selection.exact == null)
    ) {
      return "Exact performed cable setup is unknown because the per-stack load does not match every saved stack position.";
    }
    const uniquePositions = result.selections.every((selection) =>
      config.schedules?.find(
        (schedule) => schedule.stackOrdinal === selection.stackOrdinal,
      )?.steps.filter(
        (candidate) => Math.abs(candidate.displayedLoad - set.weight!) < 1e-9,
      ).length === 1
    );
    if (!uniquePositions) {
      return "Exact performed cable setup is unknown because at least one saved stack has more than one position for the recorded load.";
    }
    const positions = result.selections.map((selection) =>
      `stack ${selection.stackOrdinal}: ${cablePosition(selection.exact!)} at ${selection.exact!.displayedLoad} ${result.unit}`
    ).join("; ");
    const nominal = result.nominalHandleResistance
      ? result.nominalHandleResistance.map((load, index) =>
          `stack ${result.selections[index].stackOrdinal} ${load} ${result.unit}`
        ).join(", ")
      : null;
    const ratio = cableRatioMeaning(geometry, nominal);
    return [`${positions}.`, ratio].filter((value): value is string => value != null).join(" ");
  }
  if (
    geometry.topology === "independent_per_stack" &&
    set.loadEntryMeaning === "combined_stacks"
  ) {
    const result = selectCombinedIndependentCableLoad(set.weight, config);
    if (result.status === "unavailable" || result.exact == null) {
      return "Exact performed cable setup is unknown because the combined load does not match saved positions across all stacks.";
    }
    const uniqueSelections = uniqueCombinedCableSteps(set.weight, config);
    if (uniqueSelections == null) {
      return "Exact performed cable setup is unknown because the saved evidence does not prove one unique stack-position combination for the recorded combined load.";
    }
    const positions = uniqueSelections.map(({ stackOrdinal, step }) =>
      `stack ${stackOrdinal}: ${cablePosition(step)} at ${step.displayedLoad} ${result.unit}`
    ).join("; ");
    const ratio = cableRatioMeaning(
      geometry,
      result.exact.nominalHandleResistanceTotal != null
        ? `${result.exact.nominalHandleResistanceTotal} ${result.unit} combined`
        : null,
    );
    return [`${positions}.`, ratio].filter((value): value is string => value != null).join(" ");
  }
  return "Exact performed cable setup is unknown because the recorded load meaning does not match the saved stack topology.";
}

export function formatHistoryEquipmentSetup(
  snapshot: HistoryEquipmentSnapshotInput,
): HistoryEquipmentSetupPresentation {
  const parsed = sessionEquipmentGeometrySnapshotSchema.safeParse(
    snapshot.geometrySnapshot,
  );
  if (!parsed.success) {
    return {
      snapshotId: snapshot.id,
      title: equipmentTitle(snapshot),
      details: [
        "The saved equipment label is preserved, but its historical setup details are unavailable.",
      ],
    };
  }

  const geometry = parsed.data;
  if (geometry.kind === "plate_loaded_implement") {
    const name = implementName(geometry);
    return {
      snapshotId: snapshot.id,
      title: equipmentTitle(snapshot),
      details: [
        `Recorded ${name}: ${geometry.emptyWeight} ${geometry.unit} empty weight${geometry.collarWeight > 0 ? ` plus ${geometry.collarWeight} ${geometry.unit} total collar weight` : " with no added collar weight"}.`,
        geometry.sharedPlatePoolCompatible
          ? "The account plate pool available at workout time is preserved in this snapshot."
          : "This implement was recorded as not compatible with the shared plate pool.",
      ],
    };
  }

  if (geometry.kind === "plate_loaded_machine") {
    const details = geometry.geometryCertainty === "known"
      ? [
          `Recorded machine geometry: ${geometry.loadingPointCount} loading ${geometry.loadingPointCount === 1 ? "point" : "points"}; ${geometry.balancingRule === "identical_each_point" ? "the same plates on every point" : "one loading point"}.`,
          geometry.startingResistance != null && geometry.startingResistanceUnit != null
            ? `Starting resistance at workout time: ${geometry.startingResistance} ${geometry.startingResistanceUnit}.`
            : "Starting resistance was not recorded.",
        ]
      : [
          `Machine geometry was recorded as ${geometry.geometryCertainty}; an exact historical plate setup cannot be reconstructed.`,
        ];
    return { snapshotId: snapshot.id, title: equipmentTitle(snapshot), details };
  }

  const details: string[] = [];
  if (geometry.geometryCertainty === "known") {
    const topology = geometry.topology === "independent_per_stack"
      ? `${geometry.stackCount} independently selected stacks`
      : "one shared stack selection";
    details.push(`Recorded cable geometry: ${topology}${geometry.displayedUnit ? ` displayed in ${geometry.displayedUnit}` : ""}.`);
  } else {
    details.push(
      `Cable geometry was recorded as ${geometry.geometryCertainty}; the historical stack setup is not fully known.`,
    );
  }
  if (geometry.ratioStatus === "unknown") {
    details.push(
      "Pulley ratio was recorded as unknown, so effective handle load remains unknown.",
    );
  } else {
    details.push(
      `Recorded pulley ratio: ${geometry.ratioNumerator}:${geometry.ratioDenominator}.`,
    );
  }
  return { snapshotId: snapshot.id, title: equipmentTitle(snapshot), details };
}

export function formatHistoryLoadEntryMeaning(
  set: Pick<HistoryEquipmentSetInput, "weight" | "weightUnit" | "loadEntryMeaning" | "equipmentSnapshot">,
) {
  const value = loadText(set.weight, set.weightUnit);
  const knownMeaning = new Set<HistoryLoadEntryMeaning>([
    "total_system",
    "per_loading_point",
    "displayed_stack",
    "per_stack",
    "combined_stacks",
    "legacy_unknown",
  ]).has(set.loadEntryMeaning as HistoryLoadEntryMeaning);
  if (
    !knownMeaning ||
    set.loadEntryMeaning === "legacy_unknown" ||
    set.equipmentSnapshot == null
  ) {
    return `${value} has historical load meaning unknown. It has not been relabelled.`;
  }

  const geometry = sessionEquipmentGeometrySnapshotSchema.safeParse(
    set.equipmentSnapshot.geometrySnapshot,
  );
  const kind = geometry.success ? geometry.data.kind : null;
  const unknownCableRatio = geometry.success &&
    geometry.data.kind === "cable_machine" &&
    geometry.data.ratioStatus === "unknown";
  let meaning: string;
  if (set.loadEntryMeaning === "total_system") {
    meaning = kind === "plate_loaded_implement"
      ? `${value} assembled total (implement, collars, and plates).`
      : `${value} total system resistance.`;
  } else if (set.loadEntryMeaning === "per_loading_point") {
    meaning = `${value} added plate load per loading point.`;
  } else if (set.loadEntryMeaning === "displayed_stack") {
    meaning = `${value} displayed stack setting.`;
  } else if (set.loadEntryMeaning === "per_stack") {
    meaning = `${value} on each independently selected stack.`;
  } else {
    meaning = `${value} combined across the independently selected stacks.`;
  }
  if (unknownCableRatio) {
    return `${meaning} Pulley ratio was unknown, so effective handle load is unknown.`;
  }

  if (
    geometry.success &&
    geometry.data.kind === "plate_loaded_machine" &&
    set.loadEntryMeaning === "per_loading_point" &&
    set.weight != null &&
    set.weightUnit != null &&
    geometry.data.geometryCertainty === "known" &&
    geometry.data.startingResistance != null &&
    geometry.data.startingResistanceUnit === set.weightUnit &&
    geometry.data.loadingPointCount != null
  ) {
    const canonicalTotal = round2(
      geometry.data.startingResistance +
        set.weight * geometry.data.loadingPointCount,
    );
    return `${meaning} The recorded geometry gives ${canonicalTotal} ${set.weightUnit} canonical total resistance (${geometry.data.startingResistance} ${set.weightUnit} start + ${set.weight} ${set.weightUnit} × ${geometry.data.loadingPointCount} points).`;
  }

  if (
    geometry.success &&
    geometry.data.kind === "cable_machine" &&
    geometry.data.ratioStatus === "known" &&
    geometry.data.ratioNumerator != null &&
    geometry.data.ratioDenominator != null &&
    geometry.data.displayedUnit === set.weightUnit &&
    set.weight != null &&
    set.weightUnit != null &&
    ["displayed_stack", "per_stack", "combined_stacks"].includes(
      set.loadEntryMeaning,
    )
  ) {
    const nominal = round2(
      set.weight *
        (geometry.data.ratioNumerator / geometry.data.ratioDenominator),
    );
    const scope = set.loadEntryMeaning === "per_stack"
      ? " for each stack"
      : set.loadEntryMeaning === "combined_stacks"
        ? " combined"
        : "";
    return `${meaning} Recorded ${geometry.data.ratioNumerator}:${geometry.data.ratioDenominator} ratio gives ${nominal} ${set.weightUnit} nominal handle resistance${scope}; this is not measured force.`;
  }
  return meaning;
}

/**
 * Keeps performed set order intact and introduces a setup heading only when
 * the immutable snapshot changes. Every set retains its own entry meaning.
 */
export function buildHistoryEquipmentSetProjection<
  T extends HistoryEquipmentSetInput,
>(sets: T[]): HistoryEquipmentSetPresentation<T>[] {
  let priorSnapshotId: string | null = null;
  return sets.map((set) => {
    const snapshotId = set.equipmentSnapshot?.id ?? null;
    const setup = snapshotId != null && snapshotId !== priorSnapshotId
      ? formatHistoryEquipmentSetup(set.equipmentSnapshot!)
      : null;
    priorSnapshotId = snapshotId;
    return {
      set,
      setup,
      loadMeaning: formatHistoryLoadEntryMeaning(set),
      performedSetup: formatHistoryPerformedSetup(set),
    };
  });
}
