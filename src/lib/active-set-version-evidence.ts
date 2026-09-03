export const ACTIVE_SET_VERSION_STATES = [
  "original",
  "corrected",
  "version_restored",
  "snapshot_restored",
] as const;

export type ActiveSetVersionState =
  (typeof ACTIVE_SET_VERSION_STATES)[number];

export type ActiveSetVersionEvidence =
  | { state: "original"; count: 0 }
  | {
      state: Exclude<ActiveSetVersionState, "original">;
      count: number;
    };

const ACTIVE_SET_VERSION_ACTIONS = new Set([
  "set.active_correction",
  "set.completed_correction",
  "set.version_restore",
  "set.snapshot_restore",
]);

/**
 * Converts newest-first immutable completed-set version actions into one
 * presentation facet. The latest applicable action owns the headline, while
 * count retains the full correction/restore history size.
 */
export function activeSetVersionEvidenceFromActions(
  actions: readonly string[],
): ActiveSetVersionEvidence {
  const relevantActions = actions.filter((action) =>
    ACTIVE_SET_VERSION_ACTIONS.has(action)
  );
  if (relevantActions.length === 0) {
    return { state: "original", count: 0 };
  }
  switch (relevantActions[0]) {
    case "set.snapshot_restore":
      return { state: "snapshot_restored", count: relevantActions.length };
    case "set.version_restore":
      return { state: "version_restored", count: relevantActions.length };
    default:
      return { state: "corrected", count: relevantActions.length };
  }
}

export function activeSetVersionEvidenceAfterCorrection(
  current: ActiveSetVersionEvidence | undefined,
  fallbackCount: number,
): ActiveSetVersionEvidence {
  return {
    state: "corrected",
    count: (current?.count ?? fallbackCount) + 1,
  };
}
