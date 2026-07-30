import { z } from "zod";
import {
  programDaySchema,
  programDayV3Schema,
  programWarmupSetSchema,
} from "@/lib/program-document";
import { programPreflightResultSchema } from "@/lib/program-preflight";

export const SESSION_COMPILER_ALGORITHM_VERSION = "phase3-deterministic-v2";
const LEGACY_SESSION_COMPILER_ALGORITHM_VERSION = "phase3-deterministic-v1";

const compilerExerciseSchema = z.object({
  slotLineageId: z.string().uuid(),
  templateExerciseId: z.string().uuid(),
  exerciseId: z.string().uuid(),
  exerciseName: z.string().min(1).max(300),
  orderIdx: z.number().int().min(0),
  supersetKey: z.string().uuid().nullable(),
  groupMemberOrderIdx: z.number().int().min(0).nullable().optional(),
  sets: z.number().int().min(1).max(20),
  repMin: z.number().int().min(1).max(100),
  repMax: z.number().int().min(1).max(100),
  targetLoad: z.number().nullable(),
  targetLoadUnit: z.enum(["lb", "kg"]).nullable(),
  restSec: z.number().int().min(0).max(1800),
  notes: z.string().nullable(),
  warmupNotes: z.string().nullable(),
  warmupSets: z.array(programWarmupSetSchema),
  setNotes: z.array(z.string().nullable()),
  intent: z.object({
    role: z.enum(["anchor", "support", "accessory", "skill", "conditioning", "recovery"]),
    priority: z.enum(["must", "should", "could"]),
    minimumDose: z.object({ unit: z.enum(["sets", "minutes", "repetitions"]), value: z.number().int().positive() }),
    idealDose: z.object({ unit: z.enum(["sets", "minutes", "repetitions"]), value: z.number().int().positive() }),
    protectedOrder: z.boolean(),
    substitutionPolicy: z.enum(["exact_only", "approved_family", "approved_movement_pattern", "no_substitution"]),
    omissionPolicy: z.enum(["never", "if_minimum_met", "allowed"]),
    calibrationEligible: z.boolean(),
    note: z.string().nullable(),
  }),
});

export const sessionCompilerInputSchema = z.object({
  algorithmVersion: z.union([
    z.literal(SESSION_COMPILER_ALGORITHM_VERSION),
    z.literal(LEGACY_SESSION_COMPILER_ALGORITHM_VERSION),
  ]),
  userId: z.string().uuid(),
  programId: z.string().uuid(),
  programVersionId: z.string().uuid(),
  programVersionNo: z.number().int().positive(),
  programReviewHash: z.string().nullable(),
  programDocumentHash: z.string().min(64).max(64),
  documentSchemaVersion: z.union([z.literal(2), z.literal(3)]),
  templateId: z.string().uuid(),
  // The richer shape must be attempted first because Zod object schemas strip
  // unknown fields; trying v2 first would erase v3 warm-ups and group timing.
  day: z.union([programDayV3Schema, programDaySchema]),
  exercises: z.array(compilerExerciseSchema).min(1),
  requestedMinutes: z.number().int().min(5).max(600),
  energy: z.enum(["low", "usual", "good"]),
  confirmedConstraintSlotLineageIds: z.array(z.string().uuid()).max(50),
  busyEquipmentSlotLineageIds: z.array(z.string().uuid()).max(50),
  preflight: programPreflightResultSchema,
  preflightEvidenceToken: z.string().length(32),
});

const compilerChangeSchema = z.object({
  slotLineageId: z.string().uuid().nullable(),
  kind: z.enum(["kept", "dose_reduced", "deferred", "order_preserved", "pairing_preserved"]),
  reason: z.string().min(1).max(1000),
});

const compilerPlanExerciseSchema = compilerExerciseSchema.extend({
  sourceSets: z.number().int().min(1).max(20),
  disposition: z.enum(["full", "partial"]),
});

export const sessionCompilerOutputSchema = z.object({
  algorithmVersion: z.union([
    z.literal(SESSION_COMPILER_ALGORITHM_VERSION),
    z.literal(LEGACY_SESSION_COMPILER_ALGORITHM_VERSION),
  ]),
  status: z.enum(["ready", "unable"]),
  reason: z.string().nullable(),
  duration: z.object({
    minMinutes: z.number().int().min(1).max(600),
    maxMinutes: z.number().int().min(1).max(600),
    basis: z.enum(["comparable_history", "sparse_history", "planned_fallback", "user_override"]),
    evidenceCount: z.number().int().min(0),
    explanation: z.string().min(1).max(1500),
  }).nullable(),
  exercises: z.array(compilerPlanExerciseSchema),
  changes: z.array(compilerChangeSchema),
  intentResults: z.array(z.object({
    key: z.string().min(1).max(200),
    label: z.string().min(1).max(300),
    status: z.enum(["full", "partial", "deferred"]),
    reason: z.string().min(1).max(1000),
  })),
  warnings: z.array(z.object({
    code: z.string().min(1).max(100),
    reason: z.string().min(1).max(1000),
    slotLineageId: z.string().uuid().nullable(),
    evidenceCount: z.number().int().min(0),
  })),
  evidenceStatement: z.string().min(1).max(2000),
});

export type SessionCompilerInput = z.infer<typeof sessionCompilerInputSchema>;
export type SessionCompilerOutput = z.infer<typeof sessionCompilerOutputSchema>;

const priorityRank = { could: 0, should: 1, must: 2 } as const;

type CompilerGroup = {
  key: string;
  structureStatus: "canonical" | "legacy_unequal";
  restBetweenMembersSec: number;
  restBetweenRoundsSec: number;
};

function compilerGroups(input: SessionCompilerInput) {
  if (input.day.supersets.length === 0) return new Map<string, CompilerGroup>();
  return new Map(input.day.supersets.map((group) => [
    group.key,
    "structureStatus" in group
      ? {
          key: group.key,
          structureStatus: group.structureStatus,
          restBetweenMembersSec: group.restBetweenMembersSec,
          restBetweenRoundsSec: group.restBetweenRoundsSec,
        }
      : {
          key: group.key,
          structureStatus: "legacy_unequal" as const,
          restBetweenMembersSec: 0,
          restBetweenRoundsSec: group.restAfterRoundSec,
        },
  ]));
}

function hasDayWarmup(input: SessionCompilerInput) {
  return "warmupItems" in input.day
    ? input.day.warmupItems.length > 0 || Boolean(input.day.warmupNotes)
    : Boolean(input.day.warmupNotes);
}

function estimateSeconds(
  exercises: SessionCompilerOutput["exercises"],
  groups: Map<string, CompilerGroup>,
  includesDayWarmup: boolean,
) {
  if (exercises.length === 0) return 0;
  const work = exercises.reduce((sum, exercise) => sum + exercise.sets * 45, 0);
  const ungroupedRest = exercises
    .filter((exercise) => exercise.supersetKey == null)
    .reduce((sum, exercise) => sum + Math.max(0, exercise.sets - 1) * exercise.restSec, 0);
  let groupedRest = 0;
  for (const [groupKey, group] of groups) {
    const members = exercises
      .filter((exercise) => exercise.supersetKey === groupKey)
      .sort((left, right) =>
        (left.groupMemberOrderIdx ?? left.orderIdx) -
        (right.groupMemberOrderIdx ?? right.orderIdx)
      );
    const maximumRounds = Math.max(0, ...members.map((member) => member.sets));
    for (let round = 1; round <= maximumRounds; round += 1) {
      const activeMembers = members.filter((member) => member.sets >= round);
      groupedRest += Math.max(0, activeMembers.length - 1) * group.restBetweenMembersSec;
      if (round < maximumRounds && activeMembers.length > 0) {
        groupedRest += group.restBetweenRoundsSec;
      }
    }
  }
  const executionUnits = exercises.filter((exercise) => exercise.supersetKey == null).length + groups.size;
  const transitions = Math.max(0, executionUnits - 1) * 120;
  return work + ungroupedRest + groupedRest + transitions + (includesDayWarmup ? 300 : 0);
}

function scaledDuration(
  source: NonNullable<SessionCompilerOutput["duration"]>,
  originalSeconds: number,
  compiledSeconds: number,
) {
  const ratio = originalSeconds > 0 ? compiledSeconds / originalSeconds : 1;
  return {
    minMinutes: Math.max(5, Math.floor((source.minMinutes * ratio) / 5) * 5),
    maxMinutes: Math.max(5, Math.ceil((source.maxMinutes * ratio) / 5) * 5),
    basis: source.basis,
    evidenceCount: source.evidenceCount,
    explanation: `${source.explanation} The compiled range scales that evidence only by explicit planned set, rest, warm-up, and transition changes; it is not an exact prediction.`,
  };
}

function unable(input: SessionCompilerInput, reason: string, warnings: SessionCompilerOutput["warnings"] = []): SessionCompilerOutput {
  return sessionCompilerOutputSchema.parse({
    algorithmVersion: input.algorithmVersion,
    status: "unable",
    reason,
    duration: null,
    exercises: [],
    changes: [],
    intentResults: [{ key: "day", label: input.day.intent.primaryOutcome.replaceAll("_", " "), status: "deferred", reason }],
    warnings,
    evidenceStatement: "No session proposal was emitted. The compiler abstained rather than infer missing intent, bypass a blocker, or claim unsupported certainty.",
  });
}

export function compileSession(rawInput: SessionCompilerInput): SessionCompilerOutput {
  const input = sessionCompilerInputSchema.parse(rawInput);
  if (input.algorithmVersion !== SESSION_COMPILER_ALGORITHM_VERSION) {
    throw new Error("That Session Compiler algorithm is historical and must be rebuilt before acceptance.");
  }
  const dayFindings = input.preflight.findings.filter((finding) => finding.dayLineageId === input.day.lineageId);
  const warnings = dayFindings.filter((finding) => finding.severity === "warning").map((finding) => ({
    code: finding.code,
    reason: finding.reason,
    slotLineageId: finding.slotLineageId,
    evidenceCount: finding.evidenceCount,
  }));
  const blockers = dayFindings.filter((finding) => finding.severity === "blocking");
  if (blockers.length > 0) {
    return unable(input, `Program Preflight has ${blockers.length} blocking execution problem${blockers.length === 1 ? "" : "s"} for this day. Resolve and publish reviewed intent before compiling.`, warnings);
  }
  if (input.confirmedConstraintSlotLineageIds.length > 0 || input.busyEquipmentSlotLineageIds.length > 0) {
    return unable(input, "A confirmed session constraint or temporary equipment conflict affects planned work. This first compiler has no reviewed occurrence-level alternative list, so it will not guess a substitution or omit the work silently.", warnings);
  }
  if (input.requestedMinutes < input.day.intent.minimumUsefulDurationMinutes) {
    return unable(input, `The available ${input.requestedMinutes} minutes is below the reviewed ${input.day.intent.minimumUsefulDurationMinutes}-minute minimum useful duration.`, warnings);
  }
  if (input.exercises.some((exercise) => exercise.intent.minimumDose.unit !== "sets" || exercise.intent.idealDose.unit !== "sets")) {
    return unable(input, "Algorithm v1 can only compile reviewed set-based minimum and ideal doses. It will not invent conversions for minutes or repetitions.", warnings);
  }
  const durationEvidence = input.preflight.durations.find((duration) => duration.dayLineageId === input.day.lineageId);
  if (!durationEvidence) return unable(input, "An explainable duration range is unavailable for this Program day.", warnings);

  const sourceExercises: SessionCompilerOutput["exercises"] = [...input.exercises]
    .sort((a, b) => a.orderIdx - b.orderIdx)
    .map((exercise) => ({ ...exercise, sourceSets: exercise.sets, disposition: "full" as const }));
  const groups = compilerGroups(input);
  const includesDayWarmup = hasDayWarmup(input);
  const originalSeconds = estimateSeconds(sourceExercises, groups, includesDayWarmup);
  const exercises = sourceExercises.map((exercise) => ({ ...exercise }));
  const changes: SessionCompilerOutput["changes"] = [];

  const candidates = [...exercises].sort((a, b) => {
    const priority = priorityRank[a.intent.priority] - priorityRank[b.intent.priority];
    return priority || b.orderIdx - a.orderIdx;
  });
  let duration = scaledDuration(durationEvidence, originalSeconds, estimateSeconds(exercises, groups, includesDayWarmup));

  const reducedGroups = new Set<string>();

  for (const exercise of candidates) {
    const group = exercise.supersetKey ? groups.get(exercise.supersetKey) : null;
    if (group) {
      if (reducedGroups.has(group.key) || group.structureStatus === "legacy_unequal") continue;
      reducedGroups.add(group.key);
      const members = exercises.filter((member) => member.supersetKey === group.key);
      while (duration.maxMinutes > input.requestedMinutes) {
        const canReduceWholeRound = members.every((member) => {
          const minimumSets = member.intent.minimumDose.unit === "sets"
            ? member.intent.minimumDose.value
            : member.sets;
          return member.intent.priority !== "must" &&
            !member.intent.protectedOrder &&
            member.sets > minimumSets;
        });
        if (!canReduceWholeRound) break;
        for (const member of members) {
          member.sets -= 1;
          member.setNotes = member.setNotes.slice(0, member.sets);
          member.disposition = "partial";
        }
        duration = scaledDuration(
          durationEvidence,
          originalSeconds,
          estimateSeconds(exercises, groups, includesDayWarmup),
        );
      }
      for (const member of members) {
        if (member.sets >= member.sourceSets) continue;
        const minimumSets = member.intent.minimumDose.unit === "sets"
          ? member.intent.minimumDose.value
          : member.sets;
        changes.push({
          slotLineageId: member.slotLineageId,
          kind: "dose_reduced",
          reason: `${member.exerciseName} is reduced from ${member.sourceSets} to ${member.sets} sets as part of ${member.sourceSets - member.sets} complete grouped round${member.sourceSets - member.sets === 1 ? "" : "s"}, never below its reviewed ${minimumSets}-set minimum.`,
        });
      }
      continue;
    }
    const minimumSets = exercise.intent.minimumDose.unit === "sets" ? exercise.intent.minimumDose.value : exercise.sets;
    const reducible = exercise.intent.priority !== "must" && !exercise.intent.protectedOrder;
    while (
      reducible &&
      exercise.sets > minimumSets &&
      duration.maxMinutes > input.requestedMinutes
    ) {
      exercise.sets -= 1;
      exercise.setNotes = exercise.setNotes.slice(0, exercise.sets);
      exercise.disposition = "partial";
      duration = scaledDuration(durationEvidence, originalSeconds, estimateSeconds(exercises, groups, includesDayWarmup));
    }
    if (exercise.sets < exercise.sourceSets) {
      changes.push({
        slotLineageId: exercise.slotLineageId,
        kind: "dose_reduced",
        reason: `${exercise.exerciseName} is reduced from ${exercise.sourceSets} to ${exercise.sets} sets, never below its reviewed ${minimumSets}-set minimum. Lower-priority work was reduced to fit the available time.`,
      });
    }
  }

  duration = scaledDuration(durationEvidence, originalSeconds, estimateSeconds(exercises, groups, includesDayWarmup));
  if (duration.maxMinutes > input.requestedMinutes) {
    return unable(input, `The protected minimum still has an explainable ${duration.minMinutes}–${duration.maxMinutes} minute range, which does not fit the available ${input.requestedMinutes} minutes.`, warnings);
  }

  for (const exercise of exercises) {
    if (exercise.sets === exercise.sourceSets) {
      changes.push({
        slotLineageId: exercise.slotLineageId,
        kind: "kept",
        reason: `${exercise.exerciseName} remains as published because its reviewed ${exercise.intent.priority} priority and ideal dose fit. Its ${exercise.intent.substitutionPolicy.replaceAll("_", " ")} substitution policy and ${exercise.intent.omissionPolicy.replaceAll("_", " ")} omission policy are preserved; no substitution or omission is proposed.`,
      });
    }
  }
  changes.push({ slotLineageId: null, kind: "order_preserved", reason: `Published order is preserved under the day’s ${input.day.intent.orderingPolicy.replaceAll("_", " ")} ordering policy.` });
  changes.push({ slotLineageId: null, kind: "pairing_preserved", reason: `Published pairings are preserved under the day’s ${input.day.intent.pairingPolicy.replaceAll("_", " ")} pairing policy; this compiler does not invent a new superset.` });

  const partial = exercises.some((exercise) => exercise.disposition === "partial") || input.requestedMinutes < input.day.intent.targetDuration.minMinutes;
  const intentResults = [
    {
      key: `day:${input.day.lineageId}`,
      label: input.day.intent.primaryOutcome.replaceAll("_", " "),
      status: partial ? "partial" as const : "full" as const,
      reason: partial ? "Every reviewed minimum is retained, with lower-priority ideal dose reduced." : "The published exercise order and ideal doses are retained.",
    },
    ...exercises.map((exercise) => ({
      key: `slot:${exercise.slotLineageId}`,
      label: exercise.exerciseName,
      status: exercise.disposition,
      reason: exercise.disposition === "full" ? "Published ideal dose is retained." : `Reviewed minimum dose is retained; ${exercise.sourceSets - exercise.sets} optional set${exercise.sourceSets - exercise.sets === 1 ? " is" : "s are"} deferred for this proposal only.`,
    })),
  ];

  return sessionCompilerOutputSchema.parse({
    algorithmVersion: input.algorithmVersion,
    status: "ready",
    reason: null,
    duration,
    exercises,
    changes,
    intentResults,
    warnings,
    evidenceStatement: `${duration.evidenceCount} comparable duration record${duration.evidenceCount === 1 ? "" : "s"}; basis ${duration.basis.replaceAll("_", " ")}. The reviewed day fatigue tolerance is ${input.day.intent.fatigueTolerance}. Energy was recorded as ${input.energy} context, but this deterministic algorithm gives it no dose authority because the reviewed Program defines no energy-to-dose rule. Pain and caution records are associative, non-diagnostic warnings and were not treated as active session constraints without confirmation.`,
  });
}
