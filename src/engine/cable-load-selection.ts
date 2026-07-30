/** Deterministic selection over explicit cable-stack positions. */

export type CableGeometryStatus = "known" | "partial" | "unknown";
export type CableStackTopology =
  | "shared_selection"
  | "independent_per_stack";

export type CableStackSchedule = {
  /** Shared schedules use 0; independent schedules use 1..stackCount. */
  stackOrdinal: number;
  steps: CableStackStep[];
};

export type CableStackStep = {
  stepIndex: number;
  displayedLoad: number;
  positionLabel: string | null;
};

export type CableLoadConfig = {
  geometryStatus: CableGeometryStatus;
  stackCount: number | null;
  topology: CableStackTopology | null;
  unit: "lb" | "kg" | null;
  schedules: CableStackSchedule[] | null;
  ratio:
    | { status: "unknown" }
    | { status: "known"; numerator: number; denominator: number };
};

export type CableStackSelection = {
  stackOrdinal: number;
  enteredTarget: number;
  exact: CableStackStep | null;
  nearestBelow: CableStackStep | null;
  nearestAbove: CableStackStep | null;
};

export type CableLoadSelectionResult =
  | {
      status: "unavailable";
      reason:
        | "geometry_unknown"
        | "stack_count_unknown"
        | "topology_unknown"
        | "unit_unknown"
        | "stack_steps_unknown"
        | "invalid_configuration"
        | "invalid_target";
    }
  | {
      status: "available";
      unit: "lb" | "kg";
      topology: CableStackTopology;
      selections: CableStackSelection[];
      ratio: CableLoadConfig["ratio"];
      nominalHandleResistance: number[] | null;
    };

export type CombinedCableSetup = {
  displayedTotal: number;
  selections: Array<{
    stackOrdinal: number;
    step: CableStackStep;
  }>;
  nominalHandleResistanceTotal: number | null;
};

export type CombinedCableLoadSelectionResult =
  | Extract<CableLoadSelectionResult, { status: "unavailable" }>
  | {
      status: "available";
      unit: "lb" | "kg";
      enteredTarget: number;
      exact: CombinedCableSetup | null;
      nearestBelow: CombinedCableSetup | null;
      nearestAbove: CombinedCableSetup | null;
      ratio: CableLoadConfig["ratio"];
    };

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function uniqueSortedSteps(steps: CableStackStep[]): CableStackStep[] {
  const byLoad = new Map<number, CableStackStep>();
  for (const step of steps) {
    const displayedLoad = round2(step.displayedLoad);
    const candidate = { ...step, displayedLoad };
    const current = byLoad.get(displayedLoad);
    if (
      current == null ||
      candidate.stepIndex < current.stepIndex ||
      (candidate.stepIndex === current.stepIndex &&
        (candidate.positionLabel ?? "").localeCompare(current.positionLabel ?? "") < 0)
    ) {
      byLoad.set(displayedLoad, candidate);
    }
  }
  return [...byLoad.values()].sort(
    (left, right) =>
      left.displayedLoad - right.displayedLoad || left.stepIndex - right.stepIndex,
  );
}

function selectOne(
  stackOrdinal: number,
  enteredTarget: number,
  steps: CableStackStep[],
): CableStackSelection {
  return {
    stackOrdinal,
    enteredTarget,
    exact:
      steps.find((step) => Math.abs(step.displayedLoad - enteredTarget) < 1e-9) ?? null,
    nearestBelow:
      steps.filter((step) => step.displayedLoad < enteredTarget - 1e-9).at(-1) ?? null,
    nearestAbove:
      steps.find((step) => step.displayedLoad > enteredTarget + 1e-9) ?? null,
  };
}

/**
 * Shared topology accepts one target. Independent topology requires one target
 * per stack, retaining both selections instead of collapsing them to a sum.
 */
export function selectCableLoad(
  enteredTarget: number | readonly number[],
  config: CableLoadConfig,
): CableLoadSelectionResult {
  if (config.geometryStatus === "unknown") {
    return { status: "unavailable", reason: "geometry_unknown" };
  }
  if (config.stackCount == null) {
    return { status: "unavailable", reason: "stack_count_unknown" };
  }
  if (config.topology == null) {
    return { status: "unavailable", reason: "topology_unknown" };
  }
  if (config.unit == null) {
    return { status: "unavailable", reason: "unit_unknown" };
  }
  if (config.schedules == null) {
    return { status: "unavailable", reason: "stack_steps_unknown" };
  }
  if (
    !Number.isInteger(config.stackCount) ||
    config.stackCount < 1 ||
    config.schedules.some(
      (schedule) =>
        !Number.isInteger(schedule.stackOrdinal) ||
        schedule.steps.length === 0 ||
        schedule.steps.some(
          (step) =>
            !Number.isInteger(step.stepIndex) ||
            step.stepIndex < 0 ||
            !Number.isFinite(step.displayedLoad) ||
            step.displayedLoad < 0 ||
            (step.positionLabel != null && step.positionLabel.trim().length === 0),
        ),
    ) ||
    (config.ratio.status === "known" &&
      (!Number.isInteger(config.ratio.numerator) ||
        !Number.isInteger(config.ratio.denominator) ||
        config.ratio.numerator <= 0 ||
        config.ratio.denominator <= 0))
  ) {
    return { status: "unavailable", reason: "invalid_configuration" };
  }

  const targets = Array.isArray(enteredTarget)
    ? [...enteredTarget]
    : [enteredTarget as number];
  if (targets.some((target) => !Number.isFinite(target) || target < 0)) {
    return { status: "unavailable", reason: "invalid_target" };
  }

  let schedules: CableStackSchedule[];
  if (config.topology === "shared_selection") {
    if (
      targets.length !== 1 ||
      config.schedules.length !== 1 ||
      config.schedules[0].stackOrdinal !== 0
    ) {
      return { status: "unavailable", reason: "invalid_configuration" };
    }
    schedules = config.schedules;
  } else {
    const expectedOrdinals = Array.from(
      { length: config.stackCount },
      (_, index) => index + 1,
    );
    const actualOrdinals = config.schedules
      .map((schedule) => schedule.stackOrdinal)
      .sort((left, right) => left - right);
    if (
      targets.length !== config.stackCount ||
      config.schedules.length !== config.stackCount ||
      actualOrdinals.some((ordinal, index) => ordinal !== expectedOrdinals[index])
    ) {
      return { status: "unavailable", reason: "invalid_configuration" };
    }
    schedules = [...config.schedules].sort(
      (left, right) => left.stackOrdinal - right.stackOrdinal,
    );
  }

  const selections = schedules.map((schedule, index) =>
    selectOne(
      schedule.stackOrdinal,
      targets[index],
      uniqueSortedSteps(schedule.steps),
    ),
  );
  const nominalHandleResistance =
    config.ratio.status === "known" &&
    selections.every((selection) => selection.exact != null)
      ? selections.map((selection) =>
          round2(
            selection.exact!.displayedLoad *
              (config.ratio.status === "known"
                ? config.ratio.numerator / config.ratio.denominator
                : 1),
          ),
        )
      : null;

  return {
    status: "available",
    unit: config.unit,
    topology: config.topology,
    selections,
    ratio: config.ratio,
    nominalHandleResistance,
  };
}

/**
 * Solves a single combined target across independently selected stacks. The
 * returned setup always retains the exact pin chosen on every stack.
 */
export function selectCombinedIndependentCableLoad(
  enteredTarget: number,
  config: CableLoadConfig,
): CombinedCableLoadSelectionResult {
  if (config.topology !== "independent_per_stack") {
    return { status: "unavailable", reason: "invalid_configuration" };
  }
  const targetCount = config.stackCount ?? 0;
  const validation = selectCableLoad(
    Array.from({ length: targetCount }, () => 0),
    config,
  );
  if (validation.status === "unavailable") return validation;
  if (!Number.isFinite(enteredTarget) || enteredTarget < 0) {
    return { status: "unavailable", reason: "invalid_target" };
  }

  const schedules = [...config.schedules!].sort(
    (left, right) => left.stackOrdinal - right.stackOrdinal,
  );
  let combinations = new Map<number, CombinedCableSetup>([
    [0, { displayedTotal: 0, selections: [], nominalHandleResistanceTotal: null }],
  ]);
  for (const schedule of schedules) {
    const next = new Map<number, CombinedCableSetup>();
    for (const existing of combinations.values()) {
      for (const step of uniqueSortedSteps(schedule.steps)) {
        const displayedTotal = round2(existing.displayedTotal + step.displayedLoad);
        const candidate: CombinedCableSetup = {
          displayedTotal,
          selections: [
            ...existing.selections,
            { stackOrdinal: schedule.stackOrdinal, step },
          ],
          nominalHandleResistanceTotal: null,
        };
        const current = next.get(displayedTotal);
        const candidateKey = candidate.selections
          .map((selection) => `${selection.step.stepIndex}:${selection.step.positionLabel ?? ""}`)
          .join("|");
        const currentKey = current?.selections
          .map((selection) => `${selection.step.stepIndex}:${selection.step.positionLabel ?? ""}`)
          .join("|");
        if (current == null || candidateKey.localeCompare(currentKey!) < 0) {
          next.set(displayedTotal, candidate);
        }
      }
    }
    combinations = next;
  }

  const setups = [...combinations.values()]
    .sort((left, right) => left.displayedTotal - right.displayedTotal)
    .map((setup) => ({
      ...setup,
      nominalHandleResistanceTotal:
        config.ratio.status === "known"
          ? round2(
              setup.displayedTotal *
                config.ratio.numerator /
                config.ratio.denominator,
            )
          : null,
    }));
  return {
    status: "available",
    unit: validation.unit,
    enteredTarget: round2(enteredTarget),
    exact:
      setups.find((setup) => Math.abs(setup.displayedTotal - enteredTarget) < 1e-9) ??
      null,
    nearestBelow:
      setups.filter((setup) => setup.displayedTotal < enteredTarget - 1e-9).at(-1) ??
      null,
    nearestAbove:
      setups.find((setup) => setup.displayedTotal > enteredTarget + 1e-9) ?? null,
    ratio: config.ratio,
  };
}
