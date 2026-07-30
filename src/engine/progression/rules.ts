/**
 * Deterministic per-slot progression rules (plan §7). Pure functions: no IO,
 * fully unit-testable. The service layer feeds exposures and pain context and
 * turns decisions into pending Recommendations — never direct plan changes.
 */
import { progressionConfig as cfg } from "./config";

export type ExposureSet = {
  id: string;
  weight: number | null;
  reps: number;
  rpe: number | null;
};

export type Exposure = {
  sessionId: string;
  date: Date;
  sets: ExposureSet[]; // working sets only
};

export type SlotPrescription = {
  sets: number;
  repRangeMin: number;
  repRangeMax: number;
  targetLoad: number | null;
};

export type PainEvent = { severity: number; date: Date; bodyPart: string };

export type RuleDecision = {
  ruleId:
    | "pain_freeze"
    | "pain_substitute"
    | "double_progression"
    | "regression";
  kind: "hold" | "load_change" | "substitution_needed";
  toLoad?: number;
  reason: string;
  evidence: {
    signals: Record<string, unknown>;
    sessionIds?: string[];
    setIds?: string[];
  };
};

/** An exposure is "clean" when every prescribed set hit the top of the rep
 * range at (or above) target load without grinding. */
export function isCleanExposure(
  exposure: Exposure,
  rx: SlotPrescription
): boolean {
  if (exposure.sets.length < rx.sets) return false;
  return exposure.sets.every(
    (s) =>
      s.reps >= rx.repRangeMax &&
      (rx.targetLoad == null || (s.weight ?? 0) >= rx.targetLoad) &&
      (s.rpe == null || s.rpe <= cfg.rpeCapForIncrease)
  );
}

/** An exposure is a "hard miss" when ≥2 sets fell well short of the floor. */
export function isHardMissExposure(
  exposure: Exposure,
  rx: SlotPrescription
): boolean {
  const shortSets = exposure.sets.filter(
    (s) =>
      (rx.targetLoad == null || (s.weight ?? 0) >= rx.targetLoad) &&
      s.reps <= rx.repRangeMin - cfg.regressionRepShortfall
  );
  return shortSets.length >= 2;
}

export type EvaluateSlotInput = {
  exerciseName: string;
  prescription: SlotPrescription;
  /** Most recent first, including today's. Working sets only. */
  exposures: Exposure[];
  /** Pain events for this exercise's movement pattern within the window. */
  recentPain: PainEvent[];
  /** Next achievable load above current (plate math / dumbbell increments). */
  nextLoadUp: (current: number) => number | null;
  /** Nearest achievable load at/below the given target. */
  roundDown: (target: number) => number | null;
  /** Preference override; omitted keeps the conservative default. */
  exposuresRequiredForIncrease?: number;
};

export function evaluateSlot(input: EvaluateSlotInput): RuleDecision | null {
  const { prescription: rx, exposures, recentPain } = input;

  // --- Hard stop: pain rules run first and veto everything else (plan §7) ---
  const worstPain = recentPain.reduce(
    (max, p) => Math.max(max, p.severity),
    0
  );
  if (
    worstPain >= cfg.painSubstituteThreshold ||
    recentPain.length >= cfg.painRepeatCount
  ) {
    return {
      ruleId: "pain_substitute",
      kind: "substitution_needed",
      reason:
        `You've reported ${recentPain[0]?.bodyPart ?? "joint"} pain ` +
        `(worst ${worstPain}/10, ${recentPain.length} report${recentPain.length > 1 ? "s" : ""} in ${cfg.painWindowDays} days) ` +
        `around ${input.exerciseName}. Progression is paused — consider an alternative that keeps the movement pattern with less stress. ` +
        (worstPain >= cfg.painSubstituteThreshold
          ? "Pain at this level is worth a professional opinion if it persists."
          : ""),
      evidence: {
        signals: {
          worstPainSeverity: worstPain,
          painReports: recentPain.length,
          windowDays: cfg.painWindowDays,
        },
      },
    };
  }
  if (worstPain >= cfg.painFreezeThreshold) {
    return {
      ruleId: "pain_freeze",
      kind: "hold",
      reason:
        `Pain (${worstPain}/10) was flagged around ${input.exerciseName} recently. ` +
        `Loads hold until you get two pain-free sessions on this pattern.`,
      evidence: {
        signals: {
          worstPainSeverity: worstPain,
          painReports: recentPain.length,
          windowDays: cfg.painWindowDays,
        },
      },
    };
  }

  if (exposures.length === 0) return null;

  // --- Double progression: N clean exposures → next achievable load ---
  const required = Math.max(
    1,
    input.exposuresRequiredForIncrease ?? cfg.exposuresRequiredForIncrease
  );
  const recent = exposures.slice(0, required);
  if (
    rx.targetLoad != null &&
    recent.length >= required &&
    recent.every((e) => isCleanExposure(e, rx))
  ) {
    const next = input.nextLoadUp(rx.targetLoad);
    if (next != null) {
      const cappedMax = rx.targetLoad * (1 + cfg.maxLoadJumpPct);
      const toLoad = next <= cappedMax ? next : null;
      if (toLoad != null && toLoad > rx.targetLoad) {
        const dates = recent
          .map((e) =>
            e.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
          )
          .join(", ");
        return {
          ruleId: "double_progression",
          kind: "load_change",
          toLoad,
          reason:
            `${rx.sets}×${rx.repRangeMax} at ${rx.targetLoad} without grinding, ` +
            `${required} sessions running (${dates}). Next: ${toLoad}.`,
          evidence: {
            signals: {
              cleanExposures: required,
              fromLoad: rx.targetLoad,
              toLoad,
            },
            sessionIds: recent.map((e) => e.sessionId),
            setIds: recent.flatMap((e) => e.sets.map((s) => s.id)),
          },
        };
      }
    }
  }

  // --- Regression: repeated hard misses → small reset ---
  const regressionWindow = exposures.slice(0, cfg.regressionExposures);
  if (
    rx.targetLoad != null &&
    regressionWindow.length >= cfg.regressionExposures &&
    regressionWindow.every((e) => isHardMissExposure(e, rx))
  ) {
    const target = rx.targetLoad * cfg.regressionFactor;
    const toLoad = input.roundDown(target);
    if (toLoad != null && toLoad < rx.targetLoad) {
      return {
        ruleId: "regression",
        kind: "load_change",
        toLoad,
        reason:
          `The last ${cfg.regressionExposures} sessions came in well short of ` +
          `${rx.repRangeMin} reps at ${rx.targetLoad}. A small reset to ${toLoad} ` +
          `ends the grind cycle and restarts progress.`,
        evidence: {
          signals: {
            hardMissExposures: cfg.regressionExposures,
            fromLoad: rx.targetLoad,
            toLoad,
          },
          sessionIds: regressionWindow.map((e) => e.sessionId),
          setIds: regressionWindow.flatMap((e) => e.sets.map((s) => s.id)),
        },
      };
    }
  }

  return null;
}

/** Stall = no clean exposure and no load change across the window. */
export function isStalled(
  exposures: Exposure[],
  rx: SlotPrescription,
  window = 3
): boolean {
  const recent = exposures.slice(0, window);
  if (recent.length < window) return false;
  return recent.every((e) => !isCleanExposure(e, rx));
}
