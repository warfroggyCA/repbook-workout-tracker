import {
  solveMachineLoad,
  type MachineLoadConfig,
  type MachineLoadSolution,
} from "@/engine/machine-load-math";

function platesText(plates: number[], unit: "lb" | "kg") {
  return plates.length > 0 ? `${plates.join(" + ")} ${unit}` : "no added plates";
}

function pointLabel(config: MachineLoadConfig) {
  return config.balancingRule === "identical_each_point" &&
    config.loadingPointCount === 2
    ? "side"
    : "loading point";
}

function describeSolution(
  solution: MachineLoadSolution,
  config: MachineLoadConfig,
  unit: "lb" | "kg",
) {
  const point = pointLabel(config);
  const points = config.loadingPointCount ?? 1;
  const start = config.startingResistance ?? 0;
  const pluralPoints =
    points === 1 ? "point" : point === "side" ? "sides" : "points";
  return `${platesText(solution.platesPerPoint, unit)} per ${point} · ${solution.canonicalTotalLoad} ${unit} total resistance (${start} ${unit} starting resistance + ${solution.addedLoadPerPoint} ${unit} × ${points} ${pluralPoints})`;
}

export function machineLoadEntryLabel(config: MachineLoadConfig): string {
  if (config.targetEntryMeaning === "total_system") {
    return "Total machine resistance";
  }
  if (config.targetEntryMeaning === "per_loading_point") {
    return `Added plate load per ${pointLabel(config)}`;
  }
  return "Displayed machine load";
}

export function formatMachineLoadGuidance(
  enteredLoad: number | null,
  config: MachineLoadConfig,
): string {
  if (enteredLoad == null) {
    return config.geometryStatus === "known"
      ? "Enter a load to calculate the exact plates."
      : "Machine geometry is incomplete. Log the displayed load only; effective total resistance is unknown.";
  }
  const result = solveMachineLoad(enteredLoad, config);
  if (result.status === "unavailable") {
    return result.reason === "invalid_target"
      ? "Enter a load of zero or more."
      : "Machine geometry is incomplete. Log the displayed load only; effective total resistance is unknown.";
  }
  const meaning =
    result.targetEntryMeaning === "total_system"
      ? `The entered ${enteredLoad} ${result.unit} means total machine resistance.`
      : `The entered ${enteredLoad} ${result.unit} means added plate load per ${pointLabel(config)}.`;
  if (result.exact) {
    return `${describeSolution(result.exact, config, result.unit)}. ${meaning}`;
  }
  const neighbours = [
    result.nearestBelow
      ? `Nearest lower: ${describeSolution(result.nearestBelow, config, result.unit)}`
      : null,
    result.nearestAbove
      ? `Nearest higher: ${describeSolution(result.nearestAbove, config, result.unit)}`
      : null,
  ].filter((value): value is string => value != null);
  return `${enteredLoad} ${result.unit} is not achievable with the compatible owned plates. ${neighbours.join(" · ")}. ${meaning}`;
}
