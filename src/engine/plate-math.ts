/**
 * Deterministic plate math (plan §5/§7). All loads are in the profile unit.
 * Solutions are exact over the owned plate counts — no impossible loadouts.
 */

export type PlateMathConfig = {
  barWeight: number;
  collarWeight: number; // total for both collars; 0 if unused
  plates: Array<{ denomination: number; countPerSide: number }>;
};

export type PlateSolution = {
  totalLoad: number;
  perSide: number[]; // denominations, heaviest first
};

export const MAX_PLATE_SUM_ENTRIES = 20_000;

type PerSideSumsResult = {
  sums: Map<number, number[]>;
  truncated: boolean;
};

/** A deterministic, bounded set of achievable per-side sums. */
function perSideSums(plates: PlateMathConfig["plates"]): PerSideSumsResult {
  const sums = new Map<number, number[]>([[0, []]]);
  let truncated = false;
  const ordered = [...plates].sort(
    (left, right) => right.denomination - left.denomination
  );
  enumeration: for (const { denomination, countPerSide } of ordered) {
    const current = [...sums.entries()];
    for (const [sum, combo] of current) {
      for (let n = 1; n <= countPerSide; n++) {
        const next = round2(sum + denomination * n);
        if (sums.has(next)) continue;
        if (sums.size >= MAX_PLATE_SUM_ENTRIES) {
          truncated = true;
          break enumeration;
        }
        sums.set(next, [...combo, ...Array(n).fill(denomination)]);
      }
    }
  }
  return { sums, truncated };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Every total load achievable on this bar, ascending. */
export function achievableLoads(config: PlateMathConfig): number[] {
  const base = config.barWeight + config.collarWeight;
  return [...perSideSums(config.plates).sums.keys()]
    .map((s) => round2(base + s * 2))
    .sort((a, b) => a - b);
}

/** Exact solution for a target total load, or null if not loadable. */
export function solvePlates(
  target: number,
  config: PlateMathConfig
): PlateSolution | null {
  const base = config.barWeight + config.collarWeight;
  const perSideTarget = round2((target - base) / 2);
  if (perSideTarget < 0) return null;
  const result = perSideSums(config.plates);
  const combo = result.sums.get(perSideTarget);
  if (!combo && result.truncated) return null;
  if (!combo) return null;
  return {
    totalLoad: target,
    perSide: [...combo].sort((a, b) => b - a),
  };
}

/**
 * Nearest achievable load to the target (ties round down — conservative).
 * Returns the bar alone when the target is below it.
 */
export function roundToAchievable(
  target: number,
  config: PlateMathConfig
): PlateSolution {
  const loads = achievableLoads(config);
  let best = loads[0];
  for (const load of loads) {
    const better =
      Math.abs(load - target) < Math.abs(best - target) ||
      (Math.abs(load - target) === Math.abs(best - target) && load < best);
    if (better) best = load;
  }
  return solvePlates(best, config)!;
}

/** Closest achievable totals on each side of an unavailable target. */
export function nearestAchievableBounds(
  target: number,
  config: PlateMathConfig,
): { lower: PlateSolution | null; upper: PlateSolution | null } {
  const loads = achievableLoads(config);
  const lowerLoad = loads.filter((load) => load < target - 1e-9).at(-1);
  const upperLoad = loads.find((load) => load > target + 1e-9);
  return {
    lower: lowerLoad == null ? null : solvePlates(lowerLoad, config),
    upper: upperLoad == null ? null : solvePlates(upperLoad, config),
  };
}

/** Smallest achievable load strictly above `current`, or null at the top. */
export function nextLoadUp(
  current: number,
  config: PlateMathConfig
): PlateSolution | null {
  const loads = achievableLoads(config);
  const next = loads.find((l) => l > current + 1e-9);
  return next == null ? null : solvePlates(next, config);
}

/** Largest achievable load strictly below `current`, or null at the bar. */
export function nextLoadDown(
  current: number,
  config: PlateMathConfig
): PlateSolution | null {
  const loads = achievableLoads(config);
  const below = loads.filter((l) => l < current - 1e-9);
  return below.length ? solvePlates(below[below.length - 1], config) : null;
}

// --- Dumbbells / kettlebells ---

export type IncrementalLoadConfig = {
  minWeight?: number;
  maxWeight?: number;
  increments?: number[]; // explicit selectable weights, preferred when present
};

export function incrementalLoads(config: IncrementalLoadConfig): number[] {
  if (config.increments?.length) {
    return [...config.increments].sort((a, b) => a - b);
  }
  const min = config.minWeight ?? 5;
  const max = config.maxWeight ?? min;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const loads: number[] = [];
  for (let w = min; w <= max + 1e-9; w += 5) loads.push(round2(w));
  return loads;
}

export function nextIncrementalUp(
  current: number,
  config: IncrementalLoadConfig
): number | null {
  return incrementalLoads(config).find((l) => l > current + 1e-9) ?? null;
}
