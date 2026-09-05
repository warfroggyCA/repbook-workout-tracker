/**
 * Deterministic plate-loaded machine math.
 *
 * This deliberately does not reuse free-bar math: machine starting resistance,
 * loading-point count, and inventory consumption have different meanings.
 */

export type MachineGeometryStatus = "known" | "partial" | "unknown";
export type MachineBalancingRule = "single_point" | "identical_each_point";
export type MachineTargetEntryMeaning =
  | "total_system"
  | "added_plates"
  | "per_loading_point";

export type MachinePlateInventory = {
  denomination: number;
  /** Total individual compatible plates, not pairs. */
  quantity: number;
};

export type MachineLoadConfig = {
  geometryStatus: MachineGeometryStatus;
  startingResistance: number | null;
  unit: "lb" | "kg" | null;
  loadingPointCount: number | null;
  balancingRule: MachineBalancingRule | null;
  targetEntryMeaning: MachineTargetEntryMeaning | null;
  compatiblePlates: MachinePlateInventory[] | null;
};

export type MachineLoadSolution = {
  enteredLoad: number;
  canonicalTotalLoad: number | null;
  addedLoadPerPoint: number;
  platesPerPoint: number[];
  inventoryConsumed: Array<{ denomination: number; quantity: number }>;
};

export type MachineLoadUnavailableReason =
  | "geometry_unknown"
  | "starting_resistance_unknown"
  | "unit_unknown"
  | "loading_points_unknown"
  | "balancing_rule_unknown"
  | "entry_meaning_unknown"
  | "compatible_plates_unknown"
  | "invalid_configuration"
  | "invalid_target"
  | "search_limit_exceeded";

export type MachineLoadResult =
  | {
      status: "unavailable";
      reason: MachineLoadUnavailableReason;
    }
  | {
      status: "available";
      unit: "lb" | "kg";
      targetEntryMeaning: MachineTargetEntryMeaning;
      enteredTarget: number;
      canonicalTargetTotal: number | null;
      exact: MachineLoadSolution | null;
      nearest: MachineLoadSolution;
      nearestBelow: MachineLoadSolution | null;
      nearestAbove: MachineLoadSolution | null;
    };

export const MAX_MACHINE_SUM_ENTRIES = 20_000;

type SumChoice = { sum: number; plates: number[] };

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function comparePlateLists(left: number[], right: number[]): number {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

function preferredChoice(candidate: number[], current: number[]): boolean {
  return comparePlateLists(candidate, current) < 0;
}

function validateConfig(config: MachineLoadConfig): MachineLoadUnavailableReason | null {
  if (config.geometryStatus !== "known") return "geometry_unknown";
  if (config.startingResistance == null && config.targetEntryMeaning !== "added_plates") return "starting_resistance_unknown";
  if (config.unit == null) return "unit_unknown";
  if (config.loadingPointCount == null) return "loading_points_unknown";
  if (config.balancingRule == null) return "balancing_rule_unknown";
  if (config.targetEntryMeaning == null) return "entry_meaning_unknown";
  if (config.compatiblePlates == null) return "compatible_plates_unknown";
  if (
    (config.startingResistance != null && (!Number.isFinite(config.startingResistance) ||
    config.startingResistance < 0)) ||
    !Number.isInteger(config.loadingPointCount) ||
    config.loadingPointCount < 1 ||
    (config.balancingRule === "single_point" && config.loadingPointCount !== 1) ||
    config.compatiblePlates.some(
      (plate) =>
        !Number.isFinite(plate.denomination) ||
        plate.denomination <= 0 ||
        !Number.isInteger(plate.quantity) ||
        plate.quantity < 0,
    )
  ) {
    return "invalid_configuration";
  }
  return null;
}

function perPointChoices(
  config: MachineLoadConfig & {
    loadingPointCount: number;
    balancingRule: MachineBalancingRule;
    compatiblePlates: MachinePlateInventory[];
  },
): { choices: SumChoice[]; truncated: boolean } {
  const multiplier =
    config.balancingRule === "identical_each_point"
      ? config.loadingPointCount
      : 1;
  const aggregated = new Map<number, number>();
  for (const plate of config.compatiblePlates) {
    const denomination = round2(plate.denomination);
    aggregated.set(
      denomination,
      (aggregated.get(denomination) ?? 0) + plate.quantity,
    );
  }
  const plates = [...aggregated.entries()]
    .map(([denomination, quantity]) => ({
      denomination,
      countPerPoint: Math.floor(quantity / multiplier),
    }))
    .filter((plate) => plate.countPerPoint > 0)
    .sort((left, right) => right.denomination - left.denomination);

  const sums = new Map<number, number[]>([[0, []]]);
  let truncated = false;
  enumeration: for (const { denomination, countPerPoint } of plates) {
    const current = [...sums.entries()];
    for (const [sum, existing] of current) {
      for (let count = 1; count <= countPerPoint; count += 1) {
        const nextSum = round2(sum + denomination * count);
        const candidate = [
          ...existing,
          ...Array<number>(count).fill(denomination),
        ].sort((left, right) => right - left);
        const previous = sums.get(nextSum);
        if (previous && preferredChoice(candidate, previous)) {
          sums.set(nextSum, candidate);
          continue;
        }
        if (previous) continue;
        if (sums.size >= MAX_MACHINE_SUM_ENTRIES) {
          truncated = true;
          break enumeration;
        }
        sums.set(nextSum, candidate);
      }
    }
  }
  return {
    choices: [...sums.entries()]
      .map(([sum, selected]) => ({ sum, plates: selected }))
      .sort((left, right) => left.sum - right.sum),
    truncated,
  };
}

function solutionFor(
  choice: SumChoice,
  config: MachineLoadConfig & {
    loadingPointCount: number;
    balancingRule: MachineBalancingRule;
    targetEntryMeaning: MachineTargetEntryMeaning;
  },
): MachineLoadSolution {
  const pointMultiplier =
    config.balancingRule === "identical_each_point"
      ? config.loadingPointCount
      : 1;
  const canonicalTotalLoad = config.targetEntryMeaning === "added_plates"
    ? null
    : round2(config.startingResistance! + choice.sum * pointMultiplier);
  const enteredLoad =
    config.targetEntryMeaning === "total_system"
      ? canonicalTotalLoad!
      : config.targetEntryMeaning === "added_plates"
        ? round2(choice.sum * pointMultiplier)
        : choice.sum;
  const counts = new Map<number, number>();
  for (const denomination of choice.plates) {
    counts.set(
      denomination,
      (counts.get(denomination) ?? 0) + pointMultiplier,
    );
  }
  return {
    enteredLoad,
    canonicalTotalLoad,
    addedLoadPerPoint: choice.sum,
    platesPerPoint: choice.plates,
    inventoryConsumed: [...counts.entries()]
      .map(([denomination, quantity]) => ({ denomination, quantity }))
      .sort((left, right) => right.denomination - left.denomination),
  };
}

/**
 * Solve one entered machine target without manufacturing unknown geometry.
 * A per-loading-point entry is the added plate load on each point; starting
 * resistance remains a machine-wide value in the canonical total.
 */
export function solveMachineLoad(
  enteredTarget: number,
  config: MachineLoadConfig,
): MachineLoadResult {
  const invalid = validateConfig(config);
  if (invalid) return { status: "unavailable", reason: invalid };
  if (!Number.isFinite(enteredTarget) || enteredTarget < 0) {
    return { status: "unavailable", reason: "invalid_target" };
  }

  const known = config as MachineLoadConfig & {
    unit: "lb" | "kg";
    loadingPointCount: number;
    balancingRule: MachineBalancingRule;
    targetEntryMeaning: MachineTargetEntryMeaning;
    compatiblePlates: MachinePlateInventory[];
  };
  const { choices, truncated } = perPointChoices(known);
  if (truncated) {
    return { status: "unavailable", reason: "search_limit_exceeded" };
  }
  const solutions = choices.map((choice) => solutionFor(choice, known));
  const canonicalTargetTotal = known.targetEntryMeaning === "added_plates" ? null : round2(
    known.targetEntryMeaning === "total_system"
      ? enteredTarget
      : known.startingResistance! + enteredTarget * known.loadingPointCount,
  );
  const exact =
    solutions.find(
      (solution) => Math.abs(solution.enteredLoad - enteredTarget) < 1e-9,
    ) ?? null;
  const nearestBelow =
    solutions.filter((solution) => solution.enteredLoad < enteredTarget - 1e-9).at(-1) ??
    null;
  const nearestAbove =
    solutions.find((solution) => solution.enteredLoad > enteredTarget + 1e-9) ??
    null;
  const nearest = solutions.reduce((best, candidate) => {
    const candidateDistance = Math.abs(candidate.enteredLoad - enteredTarget);
    const bestDistance = Math.abs(best.enteredLoad - enteredTarget);
    return candidateDistance < bestDistance ||
      (candidateDistance === bestDistance &&
        candidate.enteredLoad < best.enteredLoad)
      ? candidate
      : best;
  });

  return {
    status: "available",
    unit: known.unit,
    targetEntryMeaning: known.targetEntryMeaning,
    enteredTarget,
    canonicalTargetTotal,
    exact,
    nearest,
    nearestBelow,
    nearestAbove,
  };
}
