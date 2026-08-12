import { z } from "zod";
import type { ProgramDocument } from "@/lib/program-document";

export const PROGRAM_PREFLIGHT_ALGORITHM_VERSION = "phase2-rule-range-v1";

export const programPreflightFindingSchema = z.object({
  id: z.string().min(1).max(200),
  severity: z.enum(["blocking", "warning"]),
  code: z.string().min(1).max(80),
  reason: z.string().min(1).max(1000),
  dayLineageId: z.string().uuid(),
  slotLineageId: z.string().uuid().nullable(),
  evidenceCount: z.number().int().min(0),
  editPath: z.string().min(1).max(500),
});

export const programDurationRangeSchema = z.object({
  dayLineageId: z.string().uuid(),
  minMinutes: z.number().int().min(1).max(600),
  maxMinutes: z.number().int().min(1).max(600),
  basis: z.enum([
    "comparable_history",
    "sparse_history",
    "planned_fallback",
    "user_override",
  ]),
  evidenceCount: z.number().int().min(0),
  explanation: z.string().min(1).max(1000),
});

export const programPreflightResultSchema = z.object({
  algorithmVersion: z.literal(PROGRAM_PREFLIGHT_ALGORITHM_VERSION),
  checkedAt: z.string().datetime(),
  durations: z.array(programDurationRangeSchema),
  findings: z.array(programPreflightFindingSchema),
  environment: z.object({
    equipmentEvidenceCount: z.number().int().min(0),
    constraintEvidenceCount: z.number().int().min(0),
    painEvidenceCount: z.number().int().min(0),
  }),
});

export type ProgramPreflightFinding = z.infer<typeof programPreflightFindingSchema>;
export type ProgramDurationRange = z.infer<typeof programDurationRangeSchema>;
export type ProgramPreflightResult = z.infer<typeof programPreflightResultSchema>;

export type ProgramPreflightContext = {
  checkedAt?: Date;
  comparableDurationsByDay?: Record<string, number[]>;
  unavailableSlotLineageIds?: Set<string>;
  avoidedSlotLineageIds?: Set<string>;
  cautiousSlotLineageIds?: Set<string>;
  painEvidenceBySlot?: Record<string, number>;
  equipmentFitBySlot?: Record<string, {
    status: "incompatible" | "unknown" | "missing";
    reason: string;
    equipmentItemIds: string[];
  }>;
  equipmentEvidenceCount?: number;
  constraintEvidenceCount?: number;
};

function roundDownFive(value: number) {
  return Math.max(5, Math.floor(value / 5) * 5);
}

function roundUpFive(value: number) {
  return Math.min(600, Math.max(5, Math.ceil(value / 5) * 5));
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index];
}

function plannedFallbackMinutes(day: ProgramDocument["days"][number]) {
  const handlingSeconds = day.exercises.reduce(
    (total, slot) => total + slot.sets * 45,
    0,
  );
  const groupedKeys = new Set(day.exercises.map((slot) => slot.supersetKey).filter(Boolean));
  const ordinaryRestSeconds = day.exercises.reduce((total, slot) => {
    if (slot.supersetKey) return total;
    return total + Math.max(0, slot.sets - 1) * slot.restSec;
  }, 0);
  const groupRestSeconds = day.supersets.reduce((total, group) => {
    const members = day.exercises.filter((slot) => slot.supersetKey === group.key);
    const rounds = Math.max(0, ...members.map((slot) => slot.sets));
    return total + Math.max(0, rounds - 1) * group.restAfterRoundSec;
  }, 0);
  const ordinaryUnits = day.exercises.filter((slot) => !slot.supersetKey).length;
  const transitionSeconds = Math.max(0, ordinaryUnits + groupedKeys.size - 1) * 120;
  const warmupSeconds = day.warmupNotes ? 300 : 0;
  return (handlingSeconds + ordinaryRestSeconds + groupRestSeconds + transitionSeconds + warmupSeconds) / 60;
}

function durationForDay(
  day: ProgramDocument["days"][number],
  comparable: number[],
): ProgramDurationRange {
  if (day.intent.durationOverride) {
    return {
      dayLineageId: day.lineageId,
      minMinutes: day.intent.durationOverride.minMinutes,
      maxMinutes: day.intent.durationOverride.maxMinutes,
      basis: "user_override",
      evidenceCount: comparable.length,
      explanation: `Reviewed user override: ${day.intent.durationOverride.note}`,
    };
  }
  const usable = comparable.filter((minutes) => Number.isFinite(minutes) && minutes >= 1 && minutes <= 600).slice(-8);
  if (usable.length >= 3) {
    return {
      dayLineageId: day.lineageId,
      minMinutes: roundDownFive(percentile(usable, 0.25)),
      maxMinutes: roundUpFive(percentile(usable, 0.75)),
      basis: "comparable_history",
      evidenceCount: usable.length,
      explanation: `Range from ${usable.length} completed sessions on this Program day lineage.`,
    };
  }
  const fallback = plannedFallbackMinutes(day);
  if (usable.length > 0) {
    return {
      dayLineageId: day.lineageId,
      minMinutes: roundDownFive(Math.min(...usable, fallback * 0.85) - 5),
      maxMinutes: roundUpFive(Math.max(...usable, fallback * 1.25) + 5),
      basis: "sparse_history",
      evidenceCount: usable.length,
      explanation: `${usable.length} comparable completed session${usable.length === 1 ? "" : "s"}; widened with planned sets, rest, warm-up, and conservative transition allowances.`,
    };
  }
  return {
    dayLineageId: day.lineageId,
    minMinutes: roundDownFive(fallback * 0.85),
    maxMinutes: roundUpFive(fallback * 1.25 + 5),
    basis: "planned_fallback",
    evidenceCount: 0,
    explanation: "No comparable completed sessions. Range uses planned sets, rest, superset rounds, warm-up guidance, and a conservative two-minute transition allowance between work units.",
  };
}

export function runProgramPreflight(
  document: ProgramDocument,
  context: ProgramPreflightContext = {},
): ProgramPreflightResult {
  const findings: ProgramPreflightFinding[] = [];
  const durations = document.days.map((day) => {
    const duration = durationForDay(
      day,
      context.comparableDurationsByDay?.[day.lineageId] ?? [],
    );
    if (duration.maxMinutes > day.intent.targetDuration.maxMinutes) {
      findings.push({
        id: `duration-overrun:${day.lineageId}`,
        severity: "warning",
        code: "duration_target_overrun",
        reason: `The explainable ${duration.minMinutes}–${duration.maxMinutes} minute range extends beyond the reviewed ${day.intent.targetDuration.minMinutes}–${day.intent.targetDuration.maxMinutes} minute target.`,
        dayLineageId: day.lineageId,
        slotLineageId: null,
        evidenceCount: duration.evidenceCount,
        editPath: `days.${day.lineageId}.intent.targetDuration`,
      });
    }
    if (duration.minMinutes > day.intent.minimumUsefulDurationMinutes) {
      const protectedSlots = day.exercises.filter(
        (slot) => slot.intent.priority === "must" || slot.intent.protectedOrder,
      );
      if (protectedSlots.length === day.exercises.length) {
        findings.push({
          id: `protected-minimum:${day.lineageId}`,
          severity: "warning",
          code: "protected_minimum_tension",
          reason: "Every exercise is protected or must-do, so a future minimum-duration occurrence may have no reviewable work to reduce.",
          dayLineageId: day.lineageId,
          slotLineageId: null,
          evidenceCount: 0,
          editPath: `days.${day.lineageId}.exercises`,
        });
      }
    }
    return duration;
  });

  for (const day of document.days) {
    for (const slot of day.exercises) {
      const editPath = `slots.${slot.lineageId}.intent`;
      const equipmentFit = context.equipmentFitBySlot?.[slot.lineageId];
      if (equipmentFit) {
        findings.push({
          id: `equipment-fit:${slot.lineageId}`,
          severity: "blocking",
          code: `equipment_fit_${equipmentFit.status}`,
          reason: equipmentFit.reason,
          dayLineageId: day.lineageId,
          slotLineageId: slot.lineageId,
          evidenceCount: equipmentFit.equipmentItemIds.length,
          editPath,
        });
      } else if (context.unavailableSlotLineageIds?.has(slot.lineageId)) {
        findings.push({
          id: `equipment:${slot.lineageId}`,
          severity: "blocking",
          code: "equipment_unavailable",
          reason: "The exercise cannot be executed with the currently reviewed equipment inventory.",
          dayLineageId: day.lineageId,
          slotLineageId: slot.lineageId,
          evidenceCount: 1,
          editPath,
        });
      }
      if (context.avoidedSlotLineageIds?.has(slot.lineageId)) {
        findings.push({
          id: `constraint:${slot.lineageId}`,
          severity: "blocking",
          code: "active_avoid_constraint",
          reason: "A current structured avoid constraint conflicts with this exercise.",
          dayLineageId: day.lineageId,
          slotLineageId: slot.lineageId,
          evidenceCount: 1,
          editPath,
        });
      } else if (context.cautiousSlotLineageIds?.has(slot.lineageId)) {
        findings.push({
          id: `caution:${slot.lineageId}`,
          severity: "warning",
          code: "active_caution_constraint",
          reason: "A current structured caution is associated with this exercise's movement pattern.",
          dayLineageId: day.lineageId,
          slotLineageId: slot.lineageId,
          evidenceCount: 1,
          editPath,
        });
      }
      const painEvidence = context.painEvidenceBySlot?.[slot.lineageId] ?? 0;
      if (painEvidence > 0) {
        findings.push({
          id: `pain:${slot.lineageId}`,
          severity: "warning",
          code: "recent_pain_association",
          reason: "Recent structured pain records are associated with this movement. This is descriptive and non-diagnostic, and does not prove the exercise caused pain.",
          dayLineageId: day.lineageId,
          slotLineageId: slot.lineageId,
          evidenceCount: painEvidence,
          editPath,
        });
      }
    }
  }

  return programPreflightResultSchema.parse({
    algorithmVersion: PROGRAM_PREFLIGHT_ALGORITHM_VERSION,
    checkedAt: (context.checkedAt ?? new Date()).toISOString(),
    durations,
    findings,
    environment: {
      equipmentEvidenceCount: context.equipmentEvidenceCount ?? 0,
      constraintEvidenceCount: context.constraintEvidenceCount ?? 0,
      painEvidenceCount: Object.values(context.painEvidenceBySlot ?? {}).reduce((sum, count) => sum + count, 0),
    },
  });
}
