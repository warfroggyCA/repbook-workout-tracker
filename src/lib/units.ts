export const KG_TO_LB = 2.2046226218487757;
// Half the smallest meaningful load step (0.01). This absorbs storage and
// conversion noise without treating distinct hundredth-unit loads as equal.
export const LOAD_COMPARISON_EPSILON = 0.005;
export const MAX_STORED_LOAD = 99_999.99;
export type LoadUnit = "lb" | "kg";

/** Match numeric(7,2) storage before hashing or comparing durable loads. */
export function normalizeStoredLoad(load: number): number {
  // PostgreSQL renders an existing float4 at its meaningful decimal precision
  // before casting it to numeric. Mirror that bridge for legacy JS float32
  // values, while leaving new double-precision input untouched.
  const decimalLoad =
    Math.fround(load) === load ? Number(load.toPrecision(7)) : load;
  const [coefficient, exponent = "0"] = decimalLoad.toString().split("e");
  const shifted = Number(`${coefficient}e${Number(exponent) + 2}`);
  const rounded = Math.round(shifted);
  const [roundedCoefficient, roundedExponent = "0"] = rounded
    .toString()
    .split("e");
  return Number(
    `${roundedCoefficient}e${Number(roundedExponent) - 2}`
  );
}

export function loadsEqual(
  left: number | null | undefined,
  right: number | null | undefined
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return Math.abs(left - right) < LOAD_COMPARISON_EPSILON;
}

/**
 * Sets carry their own weight_unit (Hevy imports are pounds), so mixed-unit
 * values must be converted at a named reporting or comparison boundary. A
 * missing unit is invalid rather than an implicit pound value.
 */
export function weightInPounds(
  weight: number,
  unit: LoadUnit | null | undefined
): number {
  if (!unit) throw new Error("A weighted value is missing its load unit.");
  return unit === "kg" ? weight * KG_TO_LB : weight;
}

export function convertWeight(
  weight: number,
  from: LoadUnit | null | undefined,
  to: LoadUnit
): number {
  if (!from) throw new Error("A weighted value is missing its load unit.");
  if (from === to) return weight;
  return from === "kg" ? weight * KG_TO_LB : weight / KG_TO_LB;
}

export function requireLoadUnit(
  unit: LoadUnit | null | undefined
): LoadUnit {
  if (!unit) throw new Error("A weighted value is missing its load unit.");
  return unit;
}

export function unitForLoad(
  load: number | null,
  unit: LoadUnit
): LoadUnit | null {
  return load == null ? null : unit;
}
