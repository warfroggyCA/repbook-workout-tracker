export const MAX_ANALYTICS_WORKOUT_DURATION_MINUTES = 180;
export const LONG_WORKOUT_DURATION_FLAG = "workout_duration_over_3h";
export const LONG_WORKOUT_ELAPSED_FLAG = "workout_elapsed_over_3h";
export const UNKNOWN_ACTIVE_WORKOUT_DURATION_FLAG =
  "workout_active_duration_unknown";
export const ACTIVE_WORKOUT_DURATION_SEMANTICS_VERSION = 1 as const;
export const ACTIVE_WORKOUT_REVIEW_THRESHOLD_SECONDS =
  MAX_ANALYTICS_WORKOUT_DURATION_MINUTES * 60;
export const MAX_ACTIVE_WORKOUT_DURATION_SECONDS = 604_800;

export const ACTIVE_WORKOUT_DURATION_BASES = [
  "wall_clock_no_stale_signal",
  "owner_reported",
  "interruption_unknown",
] as const;

export type ActiveWorkoutDurationBasis =
  (typeof ACTIVE_WORKOUT_DURATION_BASES)[number];

export type WorkoutCompletionDurationDecision =
  | { basis: "wall_clock_no_stale_signal" }
  | { basis: "owner_reported"; activeDurationSeconds: number }
  | { basis: "interruption_unknown" };

export type WorkoutActiveDurationCorrectionDecision = Exclude<
  WorkoutCompletionDurationDecision,
  { basis: "wall_clock_no_stale_signal" }
>;

export type ActiveWorkoutDurationEvidence = {
  activeDurationSemanticsVersion?: number | null;
  activeDurationSeconds?: number | null;
  activeDurationBasis?: string | null;
};

export type WorkoutDurationReview = {
  wallClockElapsedSeconds: number;
  reviewRequired: boolean;
  reviewReason: "stale" | "clock_skew" | null;
};

export function classifyWorkoutDurationReview(
  startedAt: Date,
  now: Date,
): WorkoutDurationReview {
  const rawElapsedMilliseconds = now.getTime() - startedAt.getTime();
  const wallClockElapsedSeconds = Math.max(
    0,
    Math.floor(rawElapsedMilliseconds / 1_000),
  );
  const reviewReason = rawElapsedMilliseconds < 0
    ? "clock_skew"
    : wallClockElapsedSeconds > ACTIVE_WORKOUT_REVIEW_THRESHOLD_SECONDS
      ? "stale"
      : null;
  return {
    wallClockElapsedSeconds,
    reviewRequired: reviewReason != null,
    reviewReason,
  };
}

export type WorkoutCompletionDurationResolution =
  | {
      ok: true;
      wallClockElapsedSeconds: number;
      reviewRequired: boolean;
      activeDurationSemanticsVersion: typeof ACTIVE_WORKOUT_DURATION_SEMANTICS_VERSION;
      activeDurationSeconds: number | null;
      activeDurationBasis: ActiveWorkoutDurationBasis;
    }
  | {
      ok: false;
      code: "duration_review_required" | "invalid_duration_review";
      wallClockElapsedSeconds: number;
      reviewRequired: boolean;
      reason: string;
    };

export function resolveWorkoutCompletionDuration(input: {
  startedAt: Date;
  finishedAt: Date;
  decision?: WorkoutCompletionDurationDecision | null;
}): WorkoutCompletionDurationResolution {
  const review = classifyWorkoutDurationReview(input.startedAt, input.finishedAt);
  const decision = input.decision ?? null;

  if (review.reviewRequired && decision == null) {
    return {
      ok: false,
      code: "duration_review_required",
      ...review,
      reason:
        review.reviewReason === "clock_skew"
          ? "The recorded start time is later than the server clock. Keep active time unknown or correct the source time before finishing."
          : "This workout may include an interruption. Review its active duration before finishing.",
    };
  }
  if (
    review.reviewRequired &&
    decision?.basis === "wall_clock_no_stale_signal"
  ) {
    return {
      ok: false,
      code: "duration_review_required",
      ...review,
      reason:
        "The recorded elapsed time includes a possible interruption. Report active time or keep it unknown.",
    };
  }

  if (decision?.basis === "owner_reported") {
    if (
      !Number.isInteger(decision.activeDurationSeconds) ||
      decision.activeDurationSeconds < 0 ||
      decision.activeDurationSeconds > MAX_ACTIVE_WORKOUT_DURATION_SECONDS ||
      decision.activeDurationSeconds > review.wallClockElapsedSeconds
    ) {
      return {
        ok: false,
        code: "invalid_duration_review",
        ...review,
        reason:
          "Active duration must be a whole number of seconds no longer than the recorded elapsed time.",
      };
    }
    return {
      ok: true,
      ...review,
      activeDurationSemanticsVersion:
        ACTIVE_WORKOUT_DURATION_SEMANTICS_VERSION,
      activeDurationSeconds: decision.activeDurationSeconds,
      activeDurationBasis: "owner_reported",
    };
  }

  if (decision?.basis === "interruption_unknown") {
    return {
      ok: true,
      ...review,
      activeDurationSemanticsVersion:
        ACTIVE_WORKOUT_DURATION_SEMANTICS_VERSION,
      activeDurationSeconds: null,
      activeDurationBasis: "interruption_unknown",
    };
  }

  return {
    ok: true,
    ...review,
    activeDurationSemanticsVersion: ACTIVE_WORKOUT_DURATION_SEMANTICS_VERSION,
    activeDurationSeconds: review.wallClockElapsedSeconds,
    activeDurationBasis: "wall_clock_no_stale_signal",
  };
}

export type WorkoutActiveDurationCorrectionResolution =
  | {
      ok: true;
      wallClockElapsedSeconds: number | null;
      activeDurationSemanticsVersion: typeof ACTIVE_WORKOUT_DURATION_SEMANTICS_VERSION;
      activeDurationSeconds: number | null;
      activeDurationBasis: Extract<
        ActiveWorkoutDurationBasis,
        "owner_reported" | "interruption_unknown"
      >;
    }
  | {
      ok: false;
      code: "invalid_duration_review";
      wallClockElapsedSeconds: number | null;
      reason: string;
    };

/**
 * Resolves an owner correction without inventing elapsed time. A retained
 * finish timestamp supplies the usual upper bound; date-only records use only
 * the global safety bound.
 */
export function resolveWorkoutActiveDurationCorrection(input: {
  startedAt: Date;
  finishedAt: Date | null;
  decision: WorkoutActiveDurationCorrectionDecision;
}): WorkoutActiveDurationCorrectionResolution {
  if (input.finishedAt != null) {
    const resolved = resolveWorkoutCompletionDuration({
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      decision: input.decision,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        code: "invalid_duration_review",
        wallClockElapsedSeconds: resolved.wallClockElapsedSeconds,
        reason: resolved.reason,
      };
    }
    return {
      ok: true,
      wallClockElapsedSeconds: resolved.wallClockElapsedSeconds,
      activeDurationSemanticsVersion:
        resolved.activeDurationSemanticsVersion,
      activeDurationSeconds: resolved.activeDurationSeconds,
      activeDurationBasis: input.decision.basis,
    };
  }

  if (input.decision.basis === "interruption_unknown") {
    return {
      ok: true,
      wallClockElapsedSeconds: null,
      activeDurationSemanticsVersion:
        ACTIVE_WORKOUT_DURATION_SEMANTICS_VERSION,
      activeDurationSeconds: null,
      activeDurationBasis: "interruption_unknown",
    };
  }
  if (
    !Number.isInteger(input.decision.activeDurationSeconds) ||
    input.decision.activeDurationSeconds < 0 ||
    input.decision.activeDurationSeconds > MAX_ACTIVE_WORKOUT_DURATION_SECONDS
  ) {
    return {
      ok: false,
      code: "invalid_duration_review",
      wallClockElapsedSeconds: null,
      reason:
        "Active duration must be a whole number of seconds between 0 and 604800.",
    };
  }
  return {
    ok: true,
    wallClockElapsedSeconds: null,
    activeDurationSemanticsVersion:
      ACTIVE_WORKOUT_DURATION_SEMANTICS_VERSION,
    activeDurationSeconds: input.decision.activeDurationSeconds,
    activeDurationBasis: "owner_reported",
  };
}

/** Raw source-timestamp elapsed time for labelled display and provenance only. */
export function wallClockElapsedWorkoutMinutes(
  startedAt: Date,
  finishedAt: Date | null,
): number | null {
  if (!finishedAt) return null;
  return (finishedAt.getTime() - startedAt.getTime()) / 60_000;
}

export function shouldExcludeWorkoutDuration(
  startedAt: Date,
  finishedAt: Date | null,
  explicitlyExcluded = false,
  evidence?: ActiveWorkoutDurationEvidence,
): boolean {
  const duration = effectiveWorkoutDurationMinutes(
    startedAt,
    finishedAt,
    evidence,
  );
  return (
    explicitlyExcluded ||
    duration == null ||
    duration < 0 ||
    duration > MAX_ANALYTICS_WORKOUT_DURATION_MINUTES
  );
}

export function analyticsWorkoutDurationMinutes(
  startedAt: Date,
  finishedAt: Date | null,
  explicitlyExcluded = false,
  evidence?: ActiveWorkoutDurationEvidence,
): number | null {
  if (
    shouldExcludeWorkoutDuration(
      startedAt,
      finishedAt,
      explicitlyExcluded,
      evidence,
    )
  ) {
    return null;
  }
  return effectiveWorkoutDurationMinutes(startedAt, finishedAt, evidence);
}

export function effectiveWorkoutDurationMinutes(
  startedAt: Date,
  finishedAt: Date | null,
  evidence?: ActiveWorkoutDurationEvidence,
): number | null {
  if (
    evidence?.activeDurationSemanticsVersion ===
    ACTIVE_WORKOUT_DURATION_SEMANTICS_VERSION
  ) {
    if (
      evidence.activeDurationBasis === "interruption_unknown" ||
      evidence.activeDurationSeconds == null
    ) {
      return null;
    }
    if (
      evidence.activeDurationBasis !== "wall_clock_no_stale_signal" &&
      evidence.activeDurationBasis !== "owner_reported"
    ) {
      return null;
    }
    return evidence.activeDurationSeconds / 60;
  }
  // Legacy source timestamps prove wall-clock elapsed time only. They do not
  // prove active training time and must never feed analysis or decisions.
  void startedAt;
  void finishedAt;
  return null;
}
