/**
 * Apply-time safety validation (plan §14: approve re-checks at apply time).
 * Pure; used by the approve action and unit-tested directly.
 */
import { progressionConfig as cfg } from "./config";
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
  const worstPain = recentPain.reduce((m, p) => Math.max(m, p.severity), 0);
  const isIncrease = fromLoad == null || toLoad > fromLoad;

  if (isIncrease && worstPain >= cfg.painFreezeThreshold) {
    return {
      ok: false,
      reason: `Pain (${worstPain}/10) was reported on this movement pattern in the last ${cfg.painWindowDays} days — load increases are frozen until two pain-free sessions.`,
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
