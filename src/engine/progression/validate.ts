/**
 * Apply-time safety validation (plan §14: approve re-checks at apply time).
 * Pure; used by the approve action and unit-tested directly.
 */
import { progressionConfig as cfg } from "./config";
import { classifyPainHold } from "./pain-hold";
import type { PainEvent } from "./rules";

export type ApplyCheck =
  | { ok: true }
  | { ok: false; reason: string };

export function validateLoadIncrease(input: {
  fromLoad: number | null;
  toLoad: number;
  recentPain: PainEvent[];
}): ApplyCheck {
  const { fromLoad, toLoad, recentPain } = input;
  const isIncrease = fromLoad == null || toLoad > fromLoad;
  const painHold = classifyPainHold({
    exerciseName: "This exercise",
    now: new Date(),
    evidence: recentPain.map((pain) => ({
      id: pain.id,
      sessionId: pain.sessionId,
      severity: pain.severity,
      createdAt: pain.date,
    })),
  });

  if (isIncrease && painHold.blocksProgression) {
    return {
      ok: false,
      reason: painHold.explanation!,
    };
  }
  if (isIncrease && fromLoad != null && toLoad > fromLoad * (1 + cfg.maxLoadJumpPct)) {
    return {
      ok: false,
      reason: `A jump from ${fromLoad} to ${toLoad} exceeds the ${Math.round(cfg.maxLoadJumpPct * 100)}% safety cap.`,
    };
  }
  if (toLoad < 0) return { ok: false, reason: "Load must be non-negative." };
  return { ok: true };
}
