/**
 * Progression thresholds (plan §7). Conservative by design for this user;
 * a single place to tune, and referenced by rule IDs in the audit trail.
 */
export const progressionConfig = {
  /** Clean exposures required before a load increase (conservative = 2). */
  exposuresRequiredForIncrease: 2,
  /** RPE above this disqualifies an exposure from counting as "clean". */
  rpeCapForIncrease: 8,
  /** Never recommend a load jump above this fraction of current load. */
  maxLoadJumpPct: 0.1,
  /** Fallback increment when no plate/dumbbell data constrains the step. */
  defaultIncrement: 5,

  /** Pain at/above this severity freezes progression for the pattern. */
  painFreezeThreshold: 3,
  /** Pain at/above this severity triggers a substitution suggestion. */
  painSubstituteThreshold: 5,
  /** Repeated pain reports in the window also trigger substitution. */
  painRepeatCount: 3,
  /** Days of pain history considered. */
  painWindowDays: 14,

  /** Sets short of rep-range floor by this many reps count as hard misses. */
  regressionRepShortfall: 2,
  /** Hard-missing exposures required before recommending a load reduction. */
  regressionExposures: 2,
  /** Load reduction factor for regressions. */
  regressionFactor: 0.925,

  /** Stalled main lifts + fatigue reports that together suggest a deload. */
  deloadStalledLifts: 2,
  deloadFatigueReports: 2,
  deloadVolumeFactor: 0.6,
  deloadLoadFactor: 0.9,

  /** After this many rejections of the same rule+slot, stop re-suggesting. */
  rejectionSnoozeCount: 2,
  rejectionSnoozeDays: 14,
} as const;
