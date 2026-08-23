/**
 * Deterministic per-slot progression rules (plan §7). Pure functions: no IO,
 * fully unit-testable. The service layer feeds exposures and pain context and
 * turns decisions into pending Recommendations — never direct plan changes.
 */
import { progressionConfig as cfg } from "./config";
import { classifyPainHold } from "./pain-hold";

export type ExposureSet = {
  id: string;
  weight: number | null;
  reps: number;
  rpe: number | null;
  rir?: number | null;
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

export type PainEvent = {
  id: string;
  sessionId: string | null;
  severity: number | null;
  date: Date;
  bodyPart: string;
};

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
    painLogIds?: string[];
  };
};

/** An exposure is "clean" when every prescribed set hit the top of the rep
 * range at (or above) target load with explicit, non-grinding effort. */
export function isCleanExposure(
  exposure: Exposure,
  rx: SlotPrescription
): boolean {
  if (exposure.sets.length < rx.sets) return false;
  return exposure.sets.every(
    (s) =>
      s.reps >= rx.repRangeMax &&
      (rx.targetLoad == null || (s.weight ?? 0) >= rx.targetLoad) &&
      ((s.rpe != null &&
        s.rir == null &&
        s.rpe <= cfg.rpeCapForIncrease) ||
        (s.rir != null &&
          s.rpe == null &&
          s.rir >= cfg.rirFloorForIncrease))
  );
}

function comparablePerformedBaseline(
  exposures: Exposure[],
): number | null {
  const loads = exposures.flatMap((exposure) =>
    exposure.sets.map((set) => set.weight),
  );
  if (loads.length === 0 || loads.some((load) => load == null)) return null;
  const baseline = loads[0]!;
  return baseline > 0 && loads.every((load) => load === baseline)
    ? baseline
    : null;
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
  /** Active pain observations for this exact exercise. */
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

  // Pain is a recording-time evidence window. A missing entry is never
  // interpreted as a pain-free workout or as early release evidence.
  const painHold = classifyPainHold({
    exerciseName: input.exerciseName,
    now: new Date(),
    evidence: recentPain.map((pain) => ({
      id: pain.id,
      sessionId: pain.sessionId,
      severity: pain.severity,
      createdAt: pain.date,
    })),
  });
  if (painHold.state === "substitution_review") {
    return {
      ruleId: "pain_substitute",
      kind: "substitution_needed",
      reason: painHold.explanation!,
      evidence: {
        signals: painHold.signals,
        sessionIds: painHold.sessionIds,
        painLogIds: painHold.evidenceIds,
      },
    };
  }
  if (painHold.state === "hold") {
    return {
      ruleId: "pain_freeze",
      kind: "hold",
      reason: painHold.explanation!,
      evidence: {
        signals: painHold.signals,
        sessionIds: painHold.sessionIds,
        painLogIds: painHold.evidenceIds,
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
  const progressionBaseline =
    rx.targetLoad ?? comparablePerformedBaseline(recent);
  if (
    progressionBaseline != null &&
    recent.length >= required &&
    recent.every((e) =>
      isCleanExposure(e, { ...rx, targetLoad: progressionBaseline }),
    )
  ) {
    const next = input.nextLoadUp(progressionBaseline);
    if (next != null) {
      const cappedMax = progressionBaseline * (1 + cfg.maxLoadJumpPct);
      const toLoad = next <= cappedMax ? next : null;
      if (toLoad != null && toLoad > progressionBaseline) {
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
            `${rx.sets}×${rx.repRangeMax} at ${progressionBaseline} with explicit RPE ${cfg.rpeCapForIncrease} or lower (or RIR ${cfg.rirFloorForIncrease} or higher), ` +
            `${required} sessions running (${dates}). Next: ${toLoad}.`,
          evidence: {
            signals: {
              cleanExposures: required,
              ...(rx.targetLoad == null
                ? {
                    baselineLoad: progressionBaseline,
                    baselineSource: "Comparable performed sets",
                  }
                : { fromLoad: rx.targetLoad }),
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
