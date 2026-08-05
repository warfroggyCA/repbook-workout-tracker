import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  completedSets,
  healthActivities,
  painLogs,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  workoutSessions,
} from "@/db/schema";
import { convertWeight, KG_TO_LB, type LoadUnit } from "@/lib/units";
import { estimateOneRepMax } from "@/lib/one-rep-max";
import { activityDateKey, activityTypeLabel } from "@/lib/activities";
import {
  addLocalDays,
  localWeekStart,
  workoutLocalDate,
} from "@/lib/workout-calendar";
import {
  historyCalendarWindow,
  type HistoryCalendarView,
} from "@/lib/history-navigation";
import {
  analyticsWorkoutDurationMinutes,
  MAX_ANALYTICS_WORKOUT_DURATION_MINUTES,
  shouldExcludeWorkoutDuration,
} from "@/lib/workout-duration-quality";
import {
  buildPrescriptionOutcomeSummary,
  classifyPrescriptionOutcome,
  classifySetMetricContainment,
  summarizePrescriptionOutcomes,
  type PrescriptionOutcome,
  type SetLoadEntryMeaning,
  type SetMetricExclusionReason,
} from "@/lib/set-metric-semantics";
import {
  eligiblePrescriptionOutcomeSql,
  eligibleTotalSystemLoadSql,
  prescriptionOutcomeSql,
  setMetricExclusionReasonSql,
} from "@/lib/set-metric-semantics-sql";
import {
  buildHistoryLenses,
  type HistoryConstraintEvidence,
  type HistoryPainContextEvidence,
  type HistoryPainModificationEvidence,
  type HistoryProgramFitEvidence,
  type HistoryRecordEvidence,
} from "@/services/history-lenses";
import {
  buildTrainingCadence,
  type TrainingCadenceSession,
} from "@/lib/training-cadence";

export const HISTORY_RANGES = [
  { key: "4w", label: "4 weeks", days: 28 },
  { key: "12w", label: "12 weeks", days: 84 },
  { key: "6m", label: "6 months", days: 182 },
  { key: "1y", label: "1 year", days: 365 },
  { key: "all", label: "All time", days: null },
] as const;

export type HistoryRangeKey = (typeof HISTORY_RANGES)[number]["key"];

export function parseHistoryRange(value: string | undefined): HistoryRangeKey {
  return HISTORY_RANGES.some((range) => range.key === value)
    ? (value as HistoryRangeKey)
    : "12w";
}

export function historyRangeStart(
  range: HistoryRangeKey,
  now = new Date()
): Date | null {
  const days = HISTORY_RANGES.find((option) => option.key === range)?.days;
  if (days == null) return null;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

type HistorySetInput = {
  id: string;
  weight: number | null;
  weightUnit?: "lb" | "kg" | null;
  loadEntryMeaning?: SetLoadEntryMeaning | null;
  performedSemanticsVersion?: number | null;
  performedLoadType?: string | null;
  performedLoadSemantics?: string | null;
  reps: number | null;
  metricType?: "weight_reps" | "reps" | "assisted_reps" | "duration" | "distance_duration" | "activity";
  distanceKm?: number | null;
  durationSeconds?: number | null;
  excludeFromAnalytics?: boolean;
  rpe: number | null;
  isWarmup: boolean;
  targetMet: boolean | null;
};

export type HistoryCalendarSessionInput = {
  id: string;
  templateName: string | null;
  status: "completed" | "abandoned";
  source?: string;
  performedTimePrecision?: "instant" | "date_only";
  startedAt: Date;
  timezone: string;
  localDate: string;
  finishedAt: Date | null;
  excludeDurationFromAnalytics?: boolean;
  occurrences: Array<{
    kind: "day_warmup" | "exercise_warmup" | "working_set";
    origin: "planned" | "ad_hoc" | "imported" | "legacy";
    outcome: "pending" | "completed" | "skipped" | "abandoned" | "legacy_unrecorded";
    completedSetId: string | null;
    plannedRepsMin?: number | null;
    plannedRepsMax?: number | null;
    plannedLoad?: number | null;
    plannedLoadUnit?: LoadUnit | null;
    plannedLoadPercent?: number | null;
    plannedLoadText?: string | null;
  }>;
  exercises: Array<{
    modificationType: "as_planned" | "substituted" | "added" | "skipped";
    prescribedSemanticsVersion?: number | null;
    prescribedExerciseName?: string | null;
    prescribedMetricType?: HistorySetInput["metricType"] | null;
    prescribedLoadType?: string | null;
    prescribedLoadSemantics?: string | null;
    exercise?: {
      loadType: string;
      metricType?: HistorySetInput["metricType"];
      loadSemantics?: string;
    };
    sets: Array<
      Pick<
        HistorySetInput,
        | "id"
        | "weight"
        | "weightUnit"
        | "loadEntryMeaning"
        | "performedSemanticsVersion"
        | "performedLoadType"
        | "performedLoadSemantics"
        | "reps"
        | "metricType"
        | "distanceKm"
        | "durationSeconds"
        | "excludeFromAnalytics"
        | "isWarmup"
        | "targetMet"
      >
    >;
  }>;
  painLogs: unknown[];
};

export type HistoryCalendarActivityInput = {
  id: string;
  activityType: string;
  title: string | null;
  startedAt: Date;
  timezone: string;
  durationSeconds: number;
  distanceKm: number | null;
  averagePaceSecondsPerKm: number | null;
  intensity: string | null;
  elevationGainM: number | null;
  averageHeartRateBpm: number | null;
  energyKcal: number | null;
  source: string;
};

export type HistoryCalendarRecord =
  | ReturnType<typeof buildHistoryCalendarSessions>[number]
  | ReturnType<typeof buildHistoryCalendarActivities>[number];

export type HistorySessionInput = {
  id: string;
  templateName: string | null;
  status: "completed" | "abandoned";
  startedAt: Date;
  timezone: string;
  localDate: string;
  finishedAt: Date | null;
  excludeDurationFromAnalytics?: boolean;
  programLinked?: boolean;
  sourceDayLineageId?: string | null;
  occurrences: HistoryCalendarSessionInput["occurrences"];
  exercises: Array<{
    modificationType: "as_planned" | "substituted" | "added" | "skipped";
    skipReason: string | null;
    prescribedSemanticsVersion?: number | null;
    prescribedExerciseName?: string | null;
    prescribedMetricType?: HistorySetInput["metricType"] | null;
    prescribedLoadType?: string | null;
    prescribedLoadSemantics?: string | null;
    substitutionReason?: string | null;
    plannedSlotLinked?: boolean;
    plannedExerciseName?: string | null;
    exercise: {
      id: string;
      name: string;
      loadType: string;
      metricType?: HistorySetInput["metricType"];
      loadSemantics?: string;
      primaryMuscles: string[];
      family?: { id: string; name: string } | null;
    };
    sets: HistorySetInput[];
  }>;
  painLogs: Array<{
    severity: number;
    bodyPart?: string;
    exerciseName?: string | null;
  }>;
};

export type HistoryInsight = {
  tone: "positive" | "neutral" | "watch";
  title: string;
  detail: string;
};

type HistoryReportRecord = HistoryRecordEvidence & {
  exerciseId: string;
  sourceSessionId: string;
};

export type HistoryReport = ReturnType<typeof summarizeHistory>;

type HistoryTargetOccurrence =
  HistoryCalendarSessionInput["occurrences"][number];

function completedWorkingOccurrencesBySetId(
  occurrences: HistoryTargetOccurrence[],
) {
  const grouped = new Map<string, HistoryTargetOccurrence[]>();
  for (const occurrence of occurrences) {
    if (
      occurrence.kind !== "working_set" ||
      occurrence.outcome !== "completed" ||
      occurrence.completedSetId == null
    ) {
      continue;
    }
    const linked = grouped.get(occurrence.completedSetId) ?? [];
    linked.push(occurrence);
    grouped.set(occurrence.completedSetId, linked);
  }
  return grouped;
}

type HistoryTargetExercise = Pick<
  HistorySessionInput["exercises"][number],
  | "modificationType"
  | "prescribedSemanticsVersion"
  | "prescribedMetricType"
  | "prescribedLoadType"
  | "prescribedLoadSemantics"
  | "exercise"
>;

function targetOutcomeForHistorySet(input: {
  set: Pick<
    HistorySetInput,
    | "weight"
    | "weightUnit"
    | "reps"
    | "metricType"
    | "loadEntryMeaning"
    | "performedSemanticsVersion"
    | "performedLoadType"
    | "performedLoadSemantics"
    | "excludeFromAnalytics"
  >;
  exercise: HistoryTargetExercise;
  occurrences: HistoryTargetOccurrence[];
}): PrescriptionOutcome | null {
  const { set, exercise, occurrences } = input;
  const plannedOccurrences = occurrences.filter(
    (occurrence) => occurrence.origin === "planned",
  );
  if (
    plannedOccurrences.length === 0 ||
    exercise.modificationType !== "as_planned"
  ) {
    return null;
  }
  if (occurrences.length !== 1 || occurrences[0].origin !== "planned") {
    return "unknown";
  }
  const occurrence = occurrences[0];
  const usesPrescribedMeaning = exercise.prescribedSemanticsVersion === 1;
  const semantics = classifySetMetricContainment({
    recordedMetricType: set.metricType ?? exercise.exercise.metricType ?? "weight_reps",
    prescribedSemanticsVersion: exercise.prescribedSemanticsVersion,
    performedSemanticsVersion: set.performedSemanticsVersion,
    performedLoadType: set.performedLoadType,
    performedLoadSemantics: set.performedLoadSemantics,
    currentExerciseMetricType: usesPrescribedMeaning
      ? exercise.prescribedMetricType
      : exercise.exercise.metricType,
    loadType: usesPrescribedMeaning
      ? exercise.prescribedLoadType
      : exercise.exercise.loadType,
    loadSemantics: usesPrescribedMeaning
      ? exercise.prescribedLoadSemantics
      : exercise.exercise.loadSemantics,
    loadEntryMeaning: set.loadEntryMeaning,
    weight: set.weight,
    reps: set.reps,
    excludeFromAnalytics: set.excludeFromAnalytics,
  });
  return classifyPrescriptionOutcome({
    semantics,
    reps: set.reps,
    weight: set.weight,
    weightUnit: set.weightUnit ?? null,
    targetRepsMin: occurrence.plannedRepsMin ?? null,
    targetRepsMax: occurrence.plannedRepsMax ?? null,
    targetLoad: occurrence.plannedLoad ?? null,
    targetLoadUnit: occurrence.plannedLoadUnit ?? null,
    targetLoadPercent: occurrence.plannedLoadPercent,
    targetLoadText: occurrence.plannedLoadText,
  });
}

export function buildHistoryCalendarSessions(
  sessions: HistoryCalendarSessionInput[],
  displayUnit: LoadUnit = "lb"
) {
  return [...sessions]
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .map((session) => {
      const targetOccurrencesBySetId = completedWorkingOccurrencesBySetId(
        session.occurrences,
      );
      const sets = session.exercises.flatMap((exercise) =>
        exercise.sets
          .filter((set) => !set.isWarmup)
          .map((set) => ({
            set,
            modificationType: exercise.modificationType,
            semantics: classifySetMetricContainment({
              recordedMetricType:
                set.metricType ?? exercise.exercise?.metricType ?? "weight_reps",
              prescribedSemanticsVersion: exercise.prescribedSemanticsVersion,
              performedSemanticsVersion: set.performedSemanticsVersion,
              performedLoadType: set.performedLoadType,
              performedLoadSemantics: set.performedLoadSemantics,
              currentExerciseMetricType:
                exercise.exercise?.metricType ?? set.metricType ?? "weight_reps",
              loadType: exercise.exercise?.loadType,
              loadSemantics: exercise.exercise?.loadSemantics ?? "total",
              loadEntryMeaning: set.loadEntryMeaning ?? "legacy_unknown",
              weight: set.weight,
              reps: set.reps,
              excludeFromAnalytics: set.excludeFromAnalytics,
            }),
          }))
      );
      const targetOutcomes = summarizePrescriptionOutcomes(
        session.exercises.flatMap((exercise) =>
          exercise.sets.flatMap((set) => {
            if (set.isWarmup) return [];
            const outcome = targetOutcomeForHistorySet({
              set,
              exercise: {
                modificationType: exercise.modificationType,
                prescribedSemanticsVersion:
                  exercise.prescribedSemanticsVersion,
                prescribedMetricType: exercise.prescribedMetricType,
                prescribedLoadType: exercise.prescribedLoadType,
                prescribedLoadSemantics: exercise.prescribedLoadSemantics,
                exercise: {
                  id: "calendar-exercise",
                  name: exercise.prescribedExerciseName ?? "Exercise",
                  loadType: exercise.exercise?.loadType ?? "unknown",
                  metricType:
                    exercise.exercise?.metricType ?? set.metricType ?? "weight_reps",
                  loadSemantics: exercise.exercise?.loadSemantics ?? "none",
                  primaryMuscles: [],
                },
              },
              occurrences: targetOccurrencesBySetId.get(set.id) ?? [],
            });
            return outcome == null ? [] : [outcome];
          }),
        ),
      );
      const duration = analyticsWorkoutDurationMinutes(
        session.startedAt,
        session.finishedAt,
        session.excludeDurationFromAnalytics,
      );
      return {
        recordType: "workout" as const,
        id: session.id,
        name: session.templateName ?? "Workout",
        status: session.status,
        source: session.source ?? "tracker",
        performedTimePrecision: session.performedTimePrecision ?? "instant",
        startedAtISO: session.startedAt.toISOString(),
        timezone: session.timezone,
        calendarDateKey: session.localDate,
        durationMin: duration == null ? null : Math.round(duration),
        durationExcluded:
          session.finishedAt != null &&
          shouldExcludeWorkoutDuration(
            session.startedAt,
            session.finishedAt,
            session.excludeDurationFromAnalytics,
          ),
        sets: sets.length,
        volume: Math.round(
          sets.reduce(
            (total, { set, semantics }) =>
              total +
                (!semantics.loadedWorkEligible ||
                set.weight == null ||
                set.reps == null
                  ? 0
                  : convertWeight(set.weight, set.weightUnit, displayUnit) *
                    set.reps),
            0
          )
        ),
        targetOutcomes,
        targetHitRate: targetOutcomes.atOrAboveRate,
        skipped: session.exercises.filter(
          (exercise) => exercise.modificationType === "skipped"
        ).length,
        painEvents: session.painLogs.length,
      };
    });
}

export function buildHistoryCalendarActivities(
  activities: HistoryCalendarActivityInput[]
) {
  return [...activities]
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .map((activity) => ({
      recordType: "activity" as const,
      id: activity.id,
      name: activity.title ?? activityTypeLabel(activity.activityType),
      activityType: activity.activityType,
      startedAtISO: activity.startedAt.toISOString(),
      timezone: activity.timezone,
      calendarDateKey: activityDateKey(activity.startedAt, activity.timezone),
      durationMin: Math.round(activity.durationSeconds / 60),
      distanceKm: activity.distanceKm,
      averagePaceSecondsPerKm: activity.averagePaceSecondsPerKm,
      intensity: activity.intensity,
      elevationGainM: activity.elevationGainM,
      averageHeartRateBpm: activity.averageHeartRateBpm,
      energyKcal: activity.energyKcal,
      source: activity.source,
    }));
}

function round(value: number, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summarizeHistory(
  sessions: HistorySessionInput[],
  fatigue: Array<{ severity: number }>,
  plannedPerWeek: number,
  configuredSince: Date | string | null,
  now = new Date(),
  currentTimezone = "America/Toronto",
  displayUnit: LoadUnit = "lb"
) {
  const chronological = [...sessions].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime()
  );
  const completed = chronological.filter(
    (session) => session.status === "completed"
  );
  const abandoned = chronological.filter(
    (session) => session.status === "abandoned"
  );
  const nowLocalDate = workoutLocalDate(now, currentTimezone);
  const effectiveSince =
    typeof configuredSince === "string"
      ? configuredSince
      : configuredSince
        ? workoutLocalDate(configuredSince, currentTimezone)
        : (chronological[0]?.localDate ?? nowLocalDate);
  let workingSets = 0;
  let totalReps = 0;
  let loadedVolume = 0;
  let timedActivitySeconds = 0;
  let distanceKm = 0;
  let excludedMetricSets = 0;
  const prescriptionOutcomes: PrescriptionOutcome[] = [];
  let rpeTotal = 0;
  let rpeCount = 0;
  let skippedExercises = 0;
  let substitutions = 0;
  const durations: number[] = [];
  let excludedDurationSessions = 0;
  const muscleSets = new Map<string, number>();
  const weeklyValues = new Map<
    string,
    {
      sessions: number;
      sets: number;
      volume: number;
      durationMinutes: number;
      durationSessions: number;
    }
  >();
  const exerciseMap = new Map<
    string,
    {
      name: string;
      loadType: string;
      metricType: HistorySetInput["metricType"];
      loadSemantics: string;
      sessions: Set<string>;
      sets: number;
      volume: number;
      observations: Array<{
        sessionId: string;
        date: string;
        metric: "estimated_strength" | "reps";
        score: number;
        weight: number | null;
        reps: number;
        exclusionReason: SetMetricExclusionReason | null;
      }>;
    }
  >();
  const familyMap = new Map<
    string,
    { name: string; sessions: Set<string>; exercises: Set<string>; sets: number; volume: number }
  >();
  const semanticExclusions = new Map<SetMetricExclusionReason, number>();

  for (const session of completed) {
    const targetOccurrencesBySetId = completedWorkingOccurrencesBySetId(
      session.occurrences,
    );
    const sessionDuration = analyticsWorkoutDurationMinutes(
      session.startedAt,
      session.finishedAt,
      session.excludeDurationFromAnalytics,
    );
    if (sessionDuration != null) {
      durations.push(sessionDuration);
    } else if (session.finishedAt) {
      excludedDurationSessions += 1;
    }
    const weekKey = localWeekStart(session.localDate);
    const weekly = weeklyValues.get(weekKey) ?? {
      sessions: 0,
      sets: 0,
      volume: 0,
      durationMinutes: 0,
      durationSessions: 0,
    };
    weekly.sessions += 1;
    if (sessionDuration != null) {
      weekly.durationMinutes += sessionDuration;
      weekly.durationSessions += 1;
    }

    for (const sessionExercise of session.exercises) {
      if (sessionExercise.modificationType === "skipped") {
        skippedExercises += 1;
        continue;
      }
      if (sessionExercise.modificationType === "substituted") substitutions += 1;
      const usesPrescribedMeaning =
        sessionExercise.prescribedSemanticsVersion === 1 &&
        sessionExercise.modificationType !== "substituted" &&
        sessionExercise.modificationType !== "added";
      const exerciseName = usesPrescribedMeaning
        ? sessionExercise.prescribedExerciseName!
        : sessionExercise.exercise.name;
      const metricType = usesPrescribedMeaning
        ? sessionExercise.prescribedMetricType!
        : (sessionExercise.exercise.metricType ?? "weight_reps");
      const loadType = usesPrescribedMeaning
        ? sessionExercise.prescribedLoadType!
        : sessionExercise.exercise.loadType;
      const loadSemantics = usesPrescribedMeaning
        ? sessionExercise.prescribedLoadSemantics!
        : (sessionExercise.exercise.loadSemantics ?? "total");
      const sets = sessionExercise.sets.filter((set) => !set.isWarmup);
      if (!sets.length) continue;

      workingSets += sets.length;
      weekly.sets += sets.length;
      for (const muscle of sessionExercise.exercise.primaryMuscles) {
        muscleSets.set(muscle, (muscleSets.get(muscle) ?? 0) + sets.length);
      }

      let exerciseStats = exerciseMap.get(sessionExercise.exercise.id);
      if (!exerciseStats) {
        exerciseStats = {
          name: exerciseName,
          loadType,
          metricType,
          loadSemantics,
          sessions: new Set<string>(),
          sets: 0,
          volume: 0,
          observations: [],
        };
        exerciseMap.set(sessionExercise.exercise.id, exerciseStats);
      }
      exerciseStats.sessions.add(session.id);
      exerciseStats.sets += sets.length;

      const familyKey = sessionExercise.exercise.family?.id ?? `exercise:${sessionExercise.exercise.id}`;
      const familyStats = familyMap.get(familyKey) ?? {
        name: sessionExercise.exercise.family?.name ?? exerciseName,
        sessions: new Set<string>(),
        exercises: new Set<string>(),
        sets: 0,
        volume: 0,
      };
      familyStats.sessions.add(session.id);
      familyStats.exercises.add(sessionExercise.exercise.id);
      familyStats.sets += sets.length;

      let bestWeighted:
        | { score: number; weight: number; reps: number }
        | undefined;
      let bestReps = 0;
      let rawObservation:
        | {
            weight: number | null;
            reps: number;
            exclusionReason: SetMetricExclusionReason;
          }
        | undefined;
      for (const set of sets) {
        const semantics = classifySetMetricContainment({
          recordedMetricType:
            set.metricType ?? metricType,
          prescribedSemanticsVersion:
            sessionExercise.prescribedSemanticsVersion,
          performedSemanticsVersion: set.performedSemanticsVersion,
          performedLoadType: set.performedLoadType,
          performedLoadSemantics: set.performedLoadSemantics,
          currentExerciseMetricType: metricType ?? set.metricType ?? "weight_reps",
          loadType,
          loadSemantics,
          loadEntryMeaning: set.loadEntryMeaning ?? "legacy_unknown",
          weight: set.weight,
          reps: set.reps,
          excludeFromAnalytics: set.excludeFromAnalytics,
        });
        if (semantics.exclusionReason != null) {
          semanticExclusions.set(
            semantics.exclusionReason,
            (semanticExclusions.get(semantics.exclusionReason) ?? 0) + 1
          );
        }
        if (set.excludeFromAnalytics) {
          excludedMetricSets += 1;
          continue;
        }
        if (set.reps != null) {
          totalReps += set.reps;
          if (
            semantics.personalRecordEligible &&
            semantics.measurementMeaning === "reps"
          ) {
            bestReps = Math.max(bestReps, set.reps);
          }
          if (
            semantics.exclusionReason != null &&
            (!rawObservation || set.reps >= rawObservation.reps)
          ) {
            rawObservation = {
              weight:
                set.weight == null
                  ? null
                  : convertWeight(set.weight, set.weightUnit, displayUnit),
              reps: set.reps,
              exclusionReason: semantics.exclusionReason,
            };
          }
        }
        if (set.durationSeconds != null) timedActivitySeconds += set.durationSeconds;
        if (set.distanceKm != null) distanceKm += set.distanceKm;
        if (
          semantics.loadedWorkEligible &&
          set.weight != null &&
          set.reps != null
        ) {
          // Normalize only at this named reporting boundary; durable values
          // retain their recorded units.
          const normalizedWeight = convertWeight(
            set.weight,
            set.weightUnit,
            displayUnit
          );
          const volume = normalizedWeight * set.reps;
          loadedVolume += volume;
          weekly.volume += volume;
          exerciseStats.volume += volume;
          familyStats.volume += volume;
          const score = semantics.estimatedStrengthEligible
            ? estimateOneRepMax(normalizedWeight, set.reps)
            : null;
          if (score != null && (!bestWeighted || score > bestWeighted.score)) {
            bestWeighted = {
              score,
              weight: Math.round(normalizedWeight * 100) / 100,
              reps: set.reps,
            };
          }
        }
        const prescriptionOutcome = targetOutcomeForHistorySet({
          set,
          exercise: sessionExercise,
          occurrences: targetOccurrencesBySetId.get(set.id) ?? [],
        });
        if (prescriptionOutcome != null) {
          prescriptionOutcomes.push(prescriptionOutcome);
        }
        if (set.rpe != null) {
          rpeTotal += set.rpe;
          rpeCount += 1;
        }
      }

      familyMap.set(familyKey, familyStats);
      if (bestWeighted || bestReps > 0 || rawObservation) {
        exerciseStats.observations.push(
          bestWeighted
          ? {
              sessionId: session.id,
              date: session.localDate,
              metric: "estimated_strength",
              score: bestWeighted.score,
              weight: bestWeighted.weight,
              reps: bestWeighted.reps,
              exclusionReason: null,
            }
          : bestReps > 0
            ? {
                sessionId: session.id,
                date: session.localDate,
                metric: "reps",
                score: bestReps,
                weight: null,
                reps: bestReps,
                exclusionReason: null,
              }
            : {
                sessionId: session.id,
                date: session.localDate,
                metric: "reps",
                score: rawObservation!.reps,
                weight: rawObservation!.weight,
                reps: rawObservation!.reps,
                exclusionReason: rawObservation!.exclusionReason,
              }
        );
      }
    }
    weeklyValues.set(weekKey, weekly);
  }

  const allWeekly: Array<{
    weekStartISO: string;
    sessions: number;
    sets: number;
    volume: number;
    durationMinutes: number;
    durationSessions: number;
  }> = [];
  for (
    let week = localWeekStart(effectiveSince), guard = 0;
    week <= nowLocalDate && guard < 600;
    week = addLocalDays(week, 7), guard += 1
  ) {
    const values = weeklyValues.get(week) ?? {
      sessions: 0,
      sets: 0,
      volume: 0,
      durationMinutes: 0,
      durationSessions: 0,
    };
    allWeekly.push({
      weekStartISO: `${week}T00:00:00.000Z`,
      sessions: values.sessions,
      sets: values.sets,
      volume: Math.round(values.volume),
      durationMinutes: Math.round(values.durationMinutes),
      durationSessions: values.durationSessions,
    });
  }

  const exerciseProgress = [...exerciseMap.entries()]
    .filter(([, exercise]) => exercise.observations.length > 0)
    .map(([exerciseId, exercise]) => {
      const observations = exercise.observations.sort(
        (a, b) => a.date.localeCompare(b.date)
      );
      const first = observations[0];
      const latest = observations.at(-1)!;
      const comparable =
        observations.length > 1 &&
        first.metric === latest.metric &&
        first.score > 0 &&
        first.exclusionReason == null &&
        latest.exclusionReason == null;
      return {
        exerciseId,
        exercise: exercise.name,
        loadType: exercise.loadType,
        metricType: exercise.metricType,
        loadSemantics: exercise.loadSemantics,
        exclusionReason:
          latest.exclusionReason ?? first.exclusionReason ?? null,
        sessions: exercise.sessions.size,
        sets: exercise.sets,
        volume: Math.round(exercise.volume),
        metric: latest.metric,
        first: {
          sourceSessionId: first.sessionId,
          localDate: first.date,
          weight: first.weight,
          reps: first.reps,
          estimatedStrength:
            first.metric === "estimated_strength" ? Math.round(first.score) : null,
        },
        latest: {
          sourceSessionId: latest.sessionId,
          localDate: latest.date,
          weight: latest.weight,
          reps: latest.reps,
          estimatedStrength:
            latest.metric === "estimated_strength" ? Math.round(latest.score) : null,
        },
        changePercent: comparable
          ? round(((latest.score - first.score) / first.score) * 100, 1)
          : null,
        repChange:
          comparable && latest.metric === "reps"
            ? latest.reps - first.reps
            : null,
      };
    })
    .sort((a, b) => b.sessions - a.sessions || b.sets - a.sets);

  const records: HistoryReportRecord[] = [...exerciseMap.entries()]
    .filter(
      ([, exercise]) =>
        (exercise.metricType === "weight_reps" ||
          exercise.metricType === "reps") &&
        exercise.loadSemantics !== "assistance" &&
        exercise.observations.some(
          (observation) => observation.exclusionReason == null
        )
    )
    .map(([exerciseId, exercise]) => {
      const best = exercise.observations
        .filter((observation) => observation.exclusionReason == null)
        .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))[0];
      return {
        exerciseId,
        sourceSessionId: best.sessionId,
        exercise: exercise.name,
        sessions: exercise.sessions.size,
        localDate: best.date,
        metric: best.metric,
        weight: best.weight,
        reps: best.reps,
        estimatedStrength:
          best.metric === "estimated_strength" ? Math.round(best.score) : null,
      };
    })
    .sort((a, b) => b.sessions - a.sessions || a.exercise.localeCompare(b.exercise));

  const programFit: HistoryProgramFitEvidence = {
    completedSessions: 0,
    abandonedSessions: 0,
    unlinkedSessions: 0,
    asPlannedOccurrences: 0,
    substitutedOccurrences: 0,
    addedOccurrences: 0,
    skippedOccurrences: 0,
    unlinkedPlannedOccurrences: 0,
    skipReasons: [],
    substitutionReasons: [],
  };
  const skipReasonCounts = new Map<string, number>();
  const substitutionReasonCounts = new Map<string, number>();
  const painSkipCounts = new Map<string, number>();
  const discomfortSubstitutionCounts = new Map<
    string,
    { plannedExercise: string; actualExercise: string; events: number }
  >();
  for (const session of chronological) {
    if (!session.programLinked) {
      programFit.unlinkedSessions += 1;
      continue;
    }
    if (session.status === "completed") programFit.completedSessions += 1;
    if (session.status === "abandoned") programFit.abandonedSessions += 1;
    for (const exercise of session.exercises) {
      if (exercise.modificationType === "added") {
        programFit.addedOccurrences += 1;
        continue;
      }
      if (exercise.plannedSlotLinked === false) {
        programFit.unlinkedPlannedOccurrences += 1;
        continue;
      }
      if (exercise.modificationType === "as_planned") {
        programFit.asPlannedOccurrences += 1;
      } else if (exercise.modificationType === "substituted") {
        programFit.substitutedOccurrences += 1;
        if (exercise.substitutionReason) {
          substitutionReasonCounts.set(
            exercise.substitutionReason,
            (substitutionReasonCounts.get(exercise.substitutionReason) ?? 0) + 1
          );
        }
      } else if (exercise.modificationType === "skipped") {
        programFit.skippedOccurrences += 1;
        if (exercise.skipReason) {
          skipReasonCounts.set(
            exercise.skipReason,
            (skipReasonCounts.get(exercise.skipReason) ?? 0) + 1
          );
        }
      }
    }
  }
  programFit.skipReasons = [...skipReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  programFit.substitutionReasons = [...substitutionReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const painContextCounts = new Map<
    string,
    HistoryPainContextEvidence
  >();
  for (const session of chronological) {
    for (const pain of session.painLogs) {
      const exercise = pain.exerciseName ?? null;
      const bodyPart = pain.bodyPart ?? "unspecified context";
      const key = `${exercise ?? "session"}\u0000${bodyPart}`;
      const current = painContextCounts.get(key) ?? {
        exercise,
        bodyPart,
        events: 0,
        maxSeverity: 0,
      };
      current.events += 1;
      current.maxSeverity = Math.max(current.maxSeverity, pain.severity);
      painContextCounts.set(key, current);
    }
    for (const exercise of session.exercises) {
      const plannedExercise =
        exercise.plannedExerciseName ?? exercise.exercise.name;
      if (
        exercise.modificationType === "skipped" &&
        exercise.skipReason === "pain"
      ) {
        painSkipCounts.set(
          plannedExercise,
          (painSkipCounts.get(plannedExercise) ?? 0) + 1
        );
      }
      if (
        exercise.modificationType === "substituted" &&
        exercise.substitutionReason === "discomfort"
      ) {
        const key = `${plannedExercise}\u0000${exercise.exercise.name}`;
        const current = discomfortSubstitutionCounts.get(key) ?? {
          plannedExercise,
          actualExercise: exercise.exercise.name,
          events: 0,
        };
        current.events += 1;
        discomfortSubstitutionCounts.set(key, current);
      }
    }
  }
  const painContexts = [...painContextCounts.values()].sort(
    (a, b) =>
      b.events - a.events ||
      b.maxSeverity - a.maxSeverity ||
      (a.exercise ?? a.bodyPart).localeCompare(b.exercise ?? b.bodyPart)
  );
  const painSkips: HistoryPainModificationEvidence[] = [...painSkipCounts.entries()]
    .map(([plannedExercise, events]) => ({ plannedExercise, events }))
    .sort((a, b) => b.events - a.events || a.plannedExercise.localeCompare(b.plannedExercise));
  const discomfortSubstitutions: HistoryPainModificationEvidence[] = [
    ...discomfortSubstitutionCounts.values(),
  ].sort(
    (a, b) => b.events - a.events || a.plannedExercise.localeCompare(b.plannedExercise)
  );

  const painEvents = sessions.reduce(
    (count, session) => count + session.painLogs.length,
    0
  );
  const highPainEvents = sessions.reduce(
    (count, session) =>
      count + session.painLogs.filter((pain) => pain.severity >= 4).length,
    0
  );
  const targetOutcomes = summarizePrescriptionOutcomes(prescriptionOutcomes);
  const cadence = buildTrainingCadence({
    sessions: chronological.map((session) => ({
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      timezone: session.timezone,
      localDate: session.localDate,
      sourceDayLineageId: session.sourceDayLineageId,
      templateName: session.templateName,
    } satisfies TrainingCadenceSession)),
    rangeStartLocalDate: effectiveSince,
    now,
    currentTimezone,
    currentWeeklyFrequency: plannedPerWeek,
  });
  const averageFatigue = fatigue.length
    ? round(
        fatigue.reduce((total, entry) => total + entry.severity, 0) /
          fatigue.length,
        1
      )
    : null;

  const insights: HistoryInsight[] = [];
  if (!completed.length) {
    insights.push({
      tone: "neutral",
      title: "No completed workouts in this period",
      detail: "Choose a longer range or complete a workout to unlock trends.",
    });
  } else if (cadence.averageSessionsPerCompleteWeek != null) {
    insights.push({
      tone: "neutral",
      title: "Training cadence",
      detail: `${completed.length} completed sessions averaged ${cadence.averageSessionsPerCompleteWeek} per complete calendar week across ${cadence.completeWeeks} complete weeks. The current preference is ${plannedPerWeek} per week; historical preferences and scheduled opportunities are not reconstructed.`,
    });
  }

  const comparisonWeeks = allWeekly.slice(-8);
  if (comparisonWeeks.length >= 6) {
    const midpoint = Math.floor(comparisonWeeks.length / 2);
    const priorVolume = comparisonWeeks
      .slice(0, midpoint)
      .reduce((total, week) => total + week.volume, 0);
    const recentVolume = comparisonWeeks
      .slice(midpoint)
      .reduce((total, week) => total + week.volume, 0);
    if (priorVolume > 0) {
      const change = Math.round(((recentVolume - priorVolume) / priorVolume) * 100);
      insights.push({
        tone: change > 10 ? "positive" : change < -10 ? "watch" : "neutral",
        title:
          change > 10
            ? "Loaded workload is rising"
            : change < -10
              ? "Loaded workload has eased"
              : "Loaded workload is steady",
        detail: `The latest half of the eight-week view is ${Math.abs(change)}% ${change >= 0 ? "higher" : "lower"} than the prior half. Bodyweight and band work are excluded from this measure.`,
      });
    }
  }

  const strongestProgress = exerciseProgress
    .filter((exercise) => exercise.changePercent != null)
    .sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0))[0];
  if (strongestProgress && (strongestProgress.changePercent ?? 0) > 1) {
    insights.push({
      tone: "positive",
      title: `${strongestProgress.exercise} is the clearest progression`,
      detail:
        strongestProgress.metric === "estimated_strength"
          ? `Estimated top-set strength is up ${strongestProgress.changePercent}% from the first exposure in this period.`
          : `Best-set reps are up ${strongestProgress.repChange ?? 0} from the first exposure in this period.`,
    });
  }

  if (targetOutcomes.atOrAboveRate != null) {
    insights.push({
      tone: targetOutcomes.atOrAboveRate >= 80 ? "positive" : targetOutcomes.atOrAboveRate < 60 ? "watch" : "neutral",
      title:
        targetOutcomes.atOrAboveRate >= 80
          ? "Most working sets are landing on target"
          : targetOutcomes.atOrAboveRate < 60
            ? "Targets are being missed often"
            : "Target completion is mixed",
      detail: `${targetOutcomes.atOrAboveRate}% of ${targetOutcomes.supported} planned sets with supported targets landed at or above them. ${targetOutcomes.unknown} planned set outcomes remain unknown.`,
    });
  }

  if (highPainEvents > 0) {
    insights.push({
      tone: "watch",
      title: "Pain flags deserve attention",
      detail: `${highPainEvents} pain ${highPainEvents === 1 ? "entry was" : "entries were"} rated 4/10 or higher in this period.`,
    });
  } else if (averageFatigue != null) {
    insights.push({
      tone: averageFatigue >= 4 ? "watch" : "positive",
      title: averageFatigue >= 4 ? "Post-workout fatigue is high" : "Recovery signal looks manageable",
      detail: `Average post-workout fatigue is ${averageFatigue}/5 across ${fatigue.length} check-ins, with no pain flags at 4/10 or higher.`,
    });
  } else if (completed.length) {
    insights.push({
      tone: "neutral",
      title: "Recovery evidence is incomplete",
      detail: "Add the fatigue check-in when finishing workouts to make recovery trends more reliable.",
    });
  }

  const calendarSessions = buildHistoryCalendarSessions(sessions, displayUnit);
  const visibleWeekly = allWeekly.slice(-12);
  const averageDurationMin = durations.length
    ? Math.round(
        durations.reduce((total, duration) => total + duration, 0) /
          durations.length
      )
    : null;
  const lenses = buildHistoryLenses({
    unit: displayUnit,
    completedSessions: completed.length,
    abandonedSessions: abandoned.length,
    workingSets,
    averageDurationMin,
    weekly: visibleWeekly,
    exerciseProgress,
    programFit,
    pain: {
      painEvents,
      highPainEvents,
      attributedPainEvents: painContexts
        .filter((context) => context.exercise != null)
        .reduce((total, context) => total + context.events, 0),
      contexts: painContexts,
      painSkips,
      discomfortSubstitutions,
      constraints: [],
    },
    records,
  });

  return {
    overview: {
      completedSessions: completed.length,
      abandonedSessions: abandoned.length,
      workingSets,
      totalReps,
      loadedVolume: Math.round(loadedVolume),
      timedActivityMinutes: Math.round(timedActivitySeconds / 60),
      distanceKm: round(distanceKm, 2),
      excludedMetricSets,
      semanticExclusions: [...semanticExclusions.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort(
          (a, b) => b.count - a.count || a.reason.localeCompare(b.reason)
        ),
      excludedDurationSessions,
      averageDurationMin,
      targetOutcomes,
      targetHitRate: targetOutcomes.atOrAboveRate,
      averageRpe: rpeCount ? round(rpeTotal / rpeCount, 1) : null,
    },
    weekly: visibleWeekly,
    cadence,
    muscles: [...muscleSets.entries()]
      .map(([muscle, sets]) => ({
        muscle,
        sets,
        share: workingSets ? Math.round((sets / workingSets) * 100) : 0,
      }))
      .sort((a, b) => b.sets - a.sets),
    exerciseProgress,
    records,
    families: [...familyMap.entries()]
      .map(([familyKey, family]) => ({
        familyKey,
        family: family.name,
        sessions: family.sessions.size,
        exercises: family.exercises.size,
        sets: family.sets,
        volume: Math.round(family.volume),
      }))
      .sort((a, b) => b.sets - a.sets || b.sessions - a.sessions),
    recovery: {
      averageFatigue,
      fatigueCheckIns: fatigue.length,
      painEvents,
      highPainEvents,
      skippedExercises,
      substitutions,
    },
    lenses,
    insights,
    calendarSessions,
    recentSessions: calendarSessions.slice(0, 12),
  };
}

export async function getHistoryReport(
  db: Db,
  userId: string,
  range: HistoryRangeKey,
  plannedPerWeek: number,
  now = new Date(),
  suppliedProfile?: { timezone: string; unit: LoadUnit }
) {
  const since = historyRangeStart(range, now);
  const profile =
    suppliedProfile ??
    (await db.query.userProfiles.findFirst({
      where: eq(userProfiles.userId, userId),
      columns: { timezone: true, unit: true },
    }));
  if (!profile) throw new Error("Profile not found");
  const sinceLocalDate = since
    ? addLocalDays(workoutLocalDate(now, profile.timezone), -(
        HISTORY_RANGES.find((option) => option.key === range)?.days ?? 0
      ))
    : null;
  const nowLocalDate = workoutLocalDate(now, profile.timezone);
  const sessionSince = sinceLocalDate
    ? sql`AND ws.local_date >= ${sinceLocalDate}::date`
    : sql``;
  const fatigueSince = since
    ? sql`AND fl.created_at >= ${since}`
    : sql``;
  const workingSetSemantics = {
    recordedMetricType: sql`cs.metric_type`,
    prescribedSemanticsVersion: sql`o.prescribed_semantics_version`,
    performedSemanticsVersion: sql`cs.performed_semantics_version`,
    performedLoadType: sql`cs.performed_load_type`,
    performedLoadSemantics: sql`cs.performed_load_semantics`,
    exerciseMetricType: sql`o.exercise_metric_type`,
    loadType: sql`o.load_type`,
    loadSemantics: sql`o.load_semantics`,
    loadEntryMeaning: sql`cs.load_entry_meaning`,
    weight: sql`cs.weight`,
    reps: sql`cs.reps`,
    excludeFromAnalytics: sql`cs.exclude_from_analytics`,
  };
  const workingSetOutcome = {
    ...workingSetSemantics,
    weightUnit: sql`cs.weight_unit`,
    targetRepsMin: sql`occurrence.planned_reps_min`,
    targetRepsMax: sql`occurrence.planned_reps_max`,
    targetLoad: sql`occurrence.planned_load`,
    targetLoadUnit: sql`occurrence.planned_load_unit`,
    targetLoadPercent: sql`occurrence.planned_load_percent`,
    targetLoadText: sql`occurrence.planned_load_text`,
  };
  const executed = await db.execute(sql`
    WITH selected_sessions AS MATERIALIZED (
      SELECT ws.*,
             date_trunc('week', ws.local_date::timestamp)::date AS week_start,
             ws.finished_at IS NOT NULL AND (
               ws.exclude_duration_from_analytics OR
               ws.finished_at < ws.started_at OR
               extract(epoch FROM ws.finished_at - ws.started_at) / 60 >
                 ${MAX_ANALYTICS_WORKOUT_DURATION_MINUTES}
             ) AS duration_excluded
      FROM workout_sessions ws
      WHERE ws.user_id = ${userId}::uuid
        AND ws.status IN ('completed', 'abandoned')
        AND ws.archived_at IS NULL
        ${sessionSince}
    ), completed_sessions AS MATERIALIZED (
      SELECT * FROM selected_sessions WHERE status = 'completed'
    ), valid_program_sessions AS MATERIALIZED (
      SELECT s.id, s.status, s.template_id
      FROM selected_sessions s
      WHERE (
        s.source_program_id IS NOT NULL
        AND s.source_program_version_id IS NOT NULL
        AND s.source_day_lineage_id IS NOT NULL
      ) OR EXISTS (
        SELECT 1
        FROM workout_templates wt
        JOIN program_versions pv ON pv.id = wt.program_version_id
        JOIN programs p ON p.id = pv.program_id
        WHERE wt.id = s.template_id
          AND p.user_id = ${userId}::uuid
      )
    ), selected_occurrences AS MATERIALIZED (
      SELECT se.id AS session_exercise_id, se.session_id, se.exercise_id,
             se.planned_from_template_exercise_id,
             se.source_slot_lineage_id,
             se.prescribed_semantics_version,
             se.modification_type, se.skip_reason, se.substitution_reason,
             s.status, s.template_id, s.local_date, s.week_start,
             CASE WHEN se.prescribed_semantics_version = 1
                    AND se.modification_type NOT IN ('substituted', 'added')
               THEN se.prescribed_exercise_name ELSE e.name END AS exercise_name,
             CASE WHEN se.prescribed_semantics_version = 1
                    AND se.modification_type NOT IN ('substituted', 'added')
               THEN se.prescribed_load_type ELSE e.load_type END AS load_type,
             CASE WHEN se.prescribed_semantics_version = 1
                    AND se.modification_type NOT IN ('substituted', 'added')
               THEN se.prescribed_metric_type ELSE e.metric_type END
               AS exercise_metric_type,
             CASE WHEN se.prescribed_semantics_version = 1
                    AND se.modification_type NOT IN ('substituted', 'added')
               THEN se.prescribed_load_semantics ELSE e.load_semantics END
               AS load_semantics,
             e.primary_muscles,
             replaced.name AS planned_exercise_name,
             planned_slot.id AS matched_planned_slot_id,
             EXISTS (
               SELECT 1 FROM session_occurrences ledger
               WHERE ledger.session_exercise_id = se.id
                 AND ledger.kind = 'working_set'
                 AND ledger.outcome = 'completed'
                 AND ledger.completed_set_id IS NOT NULL
             ) AS has_completed_working,
             EXISTS (
               SELECT 1 FROM session_occurrences ledger
               WHERE ledger.session_exercise_id = se.id
                 AND ledger.kind = 'working_set'
                 AND ledger.outcome = 'skipped'
             ) AS has_skipped_working,
             ef.id AS family_id, ef.name AS family_name
      FROM selected_sessions s
      JOIN session_exercises se ON se.session_id = s.id
      JOIN exercises e ON e.id = se.exercise_id
      LEFT JOIN exercises replaced ON replaced.id = se.substituted_for_exercise_id
      LEFT JOIN workout_template_exercises planned_slot
        ON planned_slot.id = se.planned_from_template_exercise_id
       AND planned_slot.workout_template_id = s.template_id
      LEFT JOIN exercise_families ef ON ef.id = e.family_id
    ), program_occurrences AS MATERIALIZED (
      SELECT o.*
      FROM selected_occurrences o
      JOIN valid_program_sessions s ON s.id = o.session_id
    ), occurrences AS MATERIALIZED (
      SELECT * FROM selected_occurrences WHERE status = 'completed'
    ), working_sets AS MATERIALIZED (
      SELECT o.*, occurrence.origin AS occurrence_origin,
             cs.id AS set_id, cs.set_no, cs.weight, cs.weight_unit,
             cs.reps, cs.rpe,
             cs.metric_type AS set_metric_type,
             cs.load_entry_meaning,
             cs.distance_km, cs.duration_seconds, cs.exclude_from_analytics,
             ${eligibleTotalSystemLoadSql(workingSetSemantics)}
               AS loaded_work_eligible,
             ${eligiblePrescriptionOutcomeSql(workingSetSemantics)}
               AS prescription_outcome_eligible,
             CASE
               WHEN o.modification_type = 'as_planned'
                 AND occurrence.origin = 'planned'
               THEN CASE
                 WHEN occurrence.occurrence_count = 1
                 THEN ${prescriptionOutcomeSql(workingSetOutcome)}
                 ELSE 'unknown'
               END
               ELSE 'unknown'
             END AS prescription_outcome,
             ${setMetricExclusionReasonSql(workingSetSemantics)}
               AS metric_exclusion_reason,
             CASE
               WHEN cs.weight IS NULL OR cs.weight_unit = ${profile.unit} THEN cs.weight
               WHEN cs.weight_unit = 'kg' AND ${profile.unit} = 'lb'
                 THEN cs.weight * ${KG_TO_LB}
               ELSE cs.weight / ${KG_TO_LB}
             END AS normalized_weight
      FROM occurrences o
      JOIN completed_sets cs ON cs.session_exercise_id = o.session_exercise_id
        AND cs.archived_at IS NULL
        AND NOT cs.is_warmup
      LEFT JOIN LATERAL (
        SELECT candidate.*, count(*) OVER ()::int AS occurrence_count
        FROM session_occurrences candidate
        WHERE candidate.completed_set_id = cs.id
          AND candidate.session_exercise_id = o.session_exercise_id
          AND candidate.kind = 'working_set'
          AND candidate.outcome = 'completed'
        ORDER BY candidate.sequence_idx, candidate.id
        LIMIT 1
      ) occurrence ON true
    ), week_duration_rows AS (
      SELECT week_start,
             round(coalesce(sum(
               extract(epoch FROM finished_at - started_at) / 60
             ) FILTER (
               WHERE finished_at IS NOT NULL
                 AND NOT duration_excluded
             ), 0))::int AS duration_minutes,
             count(*) FILTER (
               WHERE finished_at IS NOT NULL
                 AND NOT duration_excluded
             )::int AS duration_sessions
      FROM completed_sessions
      GROUP BY week_start
    ), week_rows AS (
      SELECT s.week_start,
             count(DISTINCT s.id)::int AS sessions,
             count(ws.set_id)::int AS sets,
             round(coalesce(sum(CASE
               WHEN NOT ws.loaded_work_eligible THEN 0
               ELSE ws.normalized_weight * ws.reps
             END), 0))::int AS volume,
             coalesce(duration.duration_minutes, 0)::int AS duration_minutes,
             coalesce(duration.duration_sessions, 0)::int AS duration_sessions
      FROM completed_sessions s
      LEFT JOIN working_sets ws ON ws.session_id = s.id
      LEFT JOIN week_duration_rows duration ON duration.week_start = s.week_start
      GROUP BY s.week_start, duration.duration_minutes, duration.duration_sessions
    ), muscle_rows AS (
      SELECT muscle, count(ws.set_id)::int AS sets
      FROM working_sets ws
      CROSS JOIN LATERAL jsonb_array_elements_text(ws.primary_muscles) AS muscles(muscle)
      GROUP BY muscle
    ), weighted_observations AS (
      SELECT DISTINCT ON (session_exercise_id)
             session_exercise_id,
             normalized_weight,
             reps,
             -- Mirrors EST_ONE_RM_MAX_REPS in src/lib/one-rep-max.ts.
             normalized_weight * (1 + reps / 30.0) AS score
      FROM working_sets
      WHERE loaded_work_eligible
        AND reps BETWEEN 1 AND 12 -- EST_ONE_RM_MAX_REPS
      ORDER BY session_exercise_id, score DESC, set_no
    ), rep_observations AS (
      SELECT session_exercise_id, max(reps)::int AS reps
      FROM working_sets
      WHERE prescription_outcome_eligible
        AND set_metric_type = 'reps'
        AND reps IS NOT NULL
      GROUP BY session_exercise_id
    ), raw_observations AS (
      SELECT DISTINCT ON (session_exercise_id)
             session_exercise_id, normalized_weight AS weight, reps,
             metric_exclusion_reason
      FROM working_sets
      WHERE NOT exclude_from_analytics
        AND reps IS NOT NULL
        AND metric_exclusion_reason IS NOT NULL
      ORDER BY session_exercise_id, reps DESC, set_no DESC
    ), observations AS (
      SELECT o.session_exercise_id, o.exercise_id, o.session_id, o.local_date,
             CASE WHEN wo.score IS NOT NULL THEN 'estimated_strength' ELSE 'reps' END AS metric,
             coalesce(wo.score, ro.reps::float8, raw.reps::float8) AS score,
             coalesce(wo.normalized_weight, raw.weight) AS weight,
             coalesce(wo.reps, ro.reps, raw.reps)::int AS reps,
             CASE
               WHEN wo.score IS NOT NULL OR ro.reps IS NOT NULL THEN NULL
               ELSE raw.metric_exclusion_reason
             END AS metric_exclusion_reason
      FROM occurrences o
      LEFT JOIN weighted_observations wo USING (session_exercise_id)
      LEFT JOIN rep_observations ro USING (session_exercise_id)
      LEFT JOIN raw_observations raw USING (session_exercise_id)
      WHERE wo.score IS NOT NULL OR ro.reps > 0 OR raw.reps IS NOT NULL
    ), exercise_base AS (
      SELECT ws.exercise_id, ws.exercise_name, ws.load_type,
             ws.exercise_metric_type, ws.load_semantics,
             count(DISTINCT ws.session_id)::int AS sessions,
             count(ws.set_id)::int AS sets,
             round(coalesce(sum(CASE
               WHEN NOT ws.loaded_work_eligible THEN 0
               ELSE ws.normalized_weight * ws.reps
             END), 0))::int AS volume
      FROM working_sets ws
      GROUP BY ws.exercise_id, ws.exercise_name, ws.load_type,
               ws.exercise_metric_type, ws.load_semantics
    ), exercise_rows AS (
      SELECT eb.*,
             counts.observations,
             first.metric AS first_metric, first.score AS first_score,
             first.weight AS first_weight, first.reps AS first_reps,
             first.metric_exclusion_reason AS first_exclusion_reason,
             first.session_id AS first_session_id,
             first.local_date AS first_local_date,
             latest.metric AS latest_metric, latest.score AS latest_score,
             latest.weight AS latest_weight, latest.reps AS latest_reps,
             latest.metric_exclusion_reason AS latest_exclusion_reason,
             latest.session_id AS latest_session_id,
             latest.local_date AS latest_local_date
      FROM exercise_base eb
      JOIN LATERAL (
        SELECT count(*)::int AS observations
        FROM observations WHERE exercise_id = eb.exercise_id
      ) counts ON counts.observations > 0
      JOIN LATERAL (
        SELECT * FROM observations
        WHERE exercise_id = eb.exercise_id
        ORDER BY local_date, session_exercise_id
        LIMIT 1
      ) first ON true
      JOIN LATERAL (
        SELECT * FROM observations
        WHERE exercise_id = eb.exercise_id
        ORDER BY local_date DESC, session_exercise_id DESC
        LIMIT 1
      ) latest ON true
    ), record_candidates AS (
      SELECT ws.exercise_id, ws.exercise_name, ws.session_id, ws.local_date,
             ws.set_no, ws.normalized_weight AS weight, ws.reps,
             CASE
               WHEN ws.loaded_work_eligible
                 AND ws.reps BETWEEN 1 AND 12 -- EST_ONE_RM_MAX_REPS
                 THEN 'estimated_strength'
               WHEN ws.prescription_outcome_eligible
                 AND ws.set_metric_type = 'reps'
                 THEN 'reps'
               ELSE NULL
             END AS metric,
             CASE
               WHEN ws.loaded_work_eligible
                 AND ws.reps BETWEEN 1 AND 12 -- EST_ONE_RM_MAX_REPS
                 -- Mirrors EST_ONE_RM_MAX_REPS in src/lib/one-rep-max.ts.
                 THEN ws.normalized_weight * (1 + ws.reps / 30.0)
               WHEN ws.prescription_outcome_eligible
                 AND ws.set_metric_type = 'reps'
                 THEN ws.reps::float8
               ELSE NULL
             END AS score
      FROM working_sets ws
      WHERE NOT ws.exclude_from_analytics
        AND ws.reps IS NOT NULL
        AND ws.reps > 0
    ), record_rows AS (
      SELECT DISTINCT ON (candidate.exercise_id)
             candidate.*, base.sessions
      FROM record_candidates candidate
      JOIN exercise_base base ON base.exercise_id = candidate.exercise_id
      WHERE candidate.metric IS NOT NULL AND candidate.score IS NOT NULL
      ORDER BY candidate.exercise_id, candidate.score DESC,
               candidate.local_date DESC, candidate.session_id DESC,
               candidate.set_no DESC
    ), program_skip_reason_rows AS (
      SELECT reason, count(*)::int AS count
      FROM (
        SELECT skip_reason::text AS reason
        FROM program_occurrences
        WHERE (matched_planned_slot_id IS NOT NULL
               OR source_slot_lineage_id IS NOT NULL)
          AND modification_type = 'skipped'
          AND skip_reason IS NOT NULL
        UNION ALL
        SELECT regexp_replace(ledger.outcome_reason, '^exercise:', '') AS reason
        FROM program_occurrences occurrence
        JOIN session_occurrences ledger
          ON ledger.session_exercise_id = occurrence.session_exercise_id
        WHERE (occurrence.matched_planned_slot_id IS NOT NULL
               OR occurrence.source_slot_lineage_id IS NOT NULL)
          AND occurrence.modification_type <> 'skipped'
          AND ledger.kind = 'working_set'
          AND ledger.outcome = 'skipped'
          AND ledger.outcome_reason IS NOT NULL
      ) reasons
      GROUP BY reason
    ), program_substitution_reason_rows AS (
      SELECT substitution_reason AS reason, count(*)::int AS count
      FROM program_occurrences
      WHERE matched_planned_slot_id IS NOT NULL
        AND modification_type = 'substituted'
        AND substitution_reason IS NOT NULL
      GROUP BY substitution_reason
    ), pain_context_rows AS (
      SELECT e.name AS exercise, pl.body_part,
             count(*)::int AS events, max(pl.severity)::int AS max_severity
      FROM pain_logs pl
      JOIN selected_sessions s ON s.id = pl.session_id
      LEFT JOIN exercises e ON e.id = pl.exercise_id
      WHERE pl.user_id = ${userId}::uuid
        AND pl.archived_at IS NULL
      GROUP BY e.name, pl.body_part
    ), pain_skip_rows AS (
      SELECT exercise_name AS planned_exercise, count(*)::int AS events
      FROM selected_occurrences
      WHERE modification_type = 'skipped' AND skip_reason = 'pain'
      GROUP BY exercise_name
    ), discomfort_substitution_rows AS (
      SELECT coalesce(planned_exercise_name, exercise_name) AS planned_exercise,
             exercise_name AS actual_exercise, count(*)::int AS events
      FROM selected_occurrences
      WHERE modification_type = 'substituted'
        AND substitution_reason = 'discomfort'
      GROUP BY planned_exercise, exercise_name
    ), constraint_rows AS (
      SELECT body_part, affected_patterns, avoid, cautious
      FROM constraints
      WHERE user_id = ${userId}::uuid
      ORDER BY avoid DESC, cautious DESC, body_part
      LIMIT 5
    ), family_rows AS (
      SELECT coalesce(o.family_id::text, 'exercise:' || o.exercise_id::text) AS family_key,
             coalesce(o.family_name, o.exercise_name) AS family,
             count(DISTINCT o.session_id)::int AS sessions,
             count(DISTINCT o.exercise_id)::int AS exercises,
             count(ws.set_id)::int AS sets,
             round(coalesce(sum(CASE
               WHEN NOT ws.loaded_work_eligible THEN 0
               ELSE ws.normalized_weight * ws.reps
             END), 0))::int AS volume
      FROM occurrences o
      JOIN working_sets ws ON ws.session_exercise_id = o.session_exercise_id
      GROUP BY family_key, family
    ), semantic_exclusion_rows AS (
      SELECT metric_exclusion_reason AS reason, count(*)::int AS count
      FROM working_sets
      WHERE metric_exclusion_reason IS NOT NULL
      GROUP BY metric_exclusion_reason
    ), fatigue_summary AS (
      SELECT count(*)::int AS check_ins, avg(fl.severity)::float8 AS average
      FROM fatigue_logs fl
      LEFT JOIN workout_sessions ws ON ws.id = fl.session_id
      WHERE fl.user_id = ${userId}::uuid
        AND fl.archived_at IS NULL
        AND (fl.session_id IS NULL OR ws.archived_at IS NULL)
        ${fatigueSince}
    ), recent_sessions AS (
      SELECT * FROM selected_sessions
      ORDER BY started_at DESC, id DESC
      LIMIT 12
    ), recent_rows AS (
      SELECT s.id, coalesce(s.template_name, 'Workout') AS name,
             s.status::text AS status, s.started_at, s.timezone,
             s.local_date::text AS calendar_date_key,
             CASE WHEN s.finished_at IS NOT NULL AND NOT s.duration_excluded
               THEN greatest(0, round(extract(epoch FROM s.finished_at - s.started_at) / 60))::int
               ELSE NULL END AS duration_min,
             s.duration_excluded,
             count(ws.set_id)::int AS sets,
             round(coalesce(sum(CASE
               WHEN NOT ws.loaded_work_eligible THEN 0
               ELSE ws.normalized_weight * ws.reps
             END), 0))::int AS volume,
             CASE WHEN count(ws.set_id) FILTER (
               WHERE ws.modification_type = 'as_planned'
                 AND ws.occurrence_origin = 'planned'
                 AND ws.prescription_outcome <> 'unknown'
             ) > 0 THEN round(
               count(ws.set_id) FILTER (
                 WHERE ws.modification_type = 'as_planned'
                   AND ws.occurrence_origin = 'planned'
                   AND ws.prescription_outcome IN ('at', 'above')
               ) * 100.0 /
               count(ws.set_id) FILTER (
                 WHERE ws.modification_type = 'as_planned'
                   AND ws.occurrence_origin = 'planned'
                   AND ws.prescription_outcome <> 'unknown'
               )
             )::int ELSE NULL END AS target_hit_rate,
             count(ws.set_id) FILTER (
               WHERE ws.modification_type = 'as_planned'
                 AND ws.occurrence_origin = 'planned'
                 AND ws.prescription_outcome = 'below'
             )::int AS target_below,
             count(ws.set_id) FILTER (
               WHERE ws.modification_type = 'as_planned'
                 AND ws.occurrence_origin = 'planned'
                 AND ws.prescription_outcome = 'at'
             )::int AS target_at,
             count(ws.set_id) FILTER (
               WHERE ws.modification_type = 'as_planned'
                 AND ws.occurrence_origin = 'planned'
                 AND ws.prescription_outcome = 'above'
             )::int AS target_above,
             count(ws.set_id) FILTER (
               WHERE ws.modification_type = 'as_planned'
                 AND ws.occurrence_origin = 'planned'
                 AND ws.prescription_outcome = 'unknown'
             )::int AS target_unknown,
             (SELECT count(*)::int FROM session_exercises se
               WHERE se.session_id = s.id AND se.modification_type = 'skipped') AS skipped,
             (SELECT count(*)::int FROM pain_logs pl
               WHERE pl.session_id = s.id AND pl.archived_at IS NULL) AS pain_events
      FROM recent_sessions s
      LEFT JOIN working_sets ws ON ws.session_id = s.id
      GROUP BY s.id, s.template_name, s.status, s.started_at, s.timezone,
               s.local_date, s.finished_at, s.duration_excluded
    )
    SELECT
      (SELECT min(local_date)::text FROM selected_sessions) AS earliest_local_date,
      (SELECT count(*)::int FROM completed_sessions) AS completed_sessions,
      (SELECT count(*)::int FROM selected_sessions WHERE status = 'abandoned') AS abandoned_sessions,
      (SELECT count(*)::int FROM working_sets) AS working_sets,
      coalesce((SELECT sum(reps)::int FROM working_sets
        WHERE NOT exclude_from_analytics), 0) AS total_reps,
      round(coalesce((SELECT sum(normalized_weight * reps) FROM working_sets
        WHERE loaded_work_eligible), 0))::int AS loaded_volume,
      round(coalesce((SELECT sum(duration_seconds) FROM working_sets
        WHERE NOT exclude_from_analytics), 0) / 60.0)::int AS timed_activity_minutes,
      round(coalesce((SELECT sum(distance_km) FROM working_sets
        WHERE NOT exclude_from_analytics), 0)::numeric, 2)::float8 AS distance_km,
      (SELECT count(*)::int FROM working_sets WHERE exclude_from_analytics) AS excluded_metric_sets,
      (SELECT count(*)::int FROM completed_sessions
        WHERE duration_excluded) AS excluded_duration_sessions,
      (SELECT round(avg(extract(epoch FROM finished_at - started_at) / 60))::int
        FROM completed_sessions
        WHERE finished_at IS NOT NULL AND NOT duration_excluded) AS average_duration_min,
      (SELECT count(*)::int FROM working_sets
        WHERE modification_type = 'as_planned'
          AND occurrence_origin = 'planned'
          AND prescription_outcome = 'below') AS target_below,
      (SELECT count(*)::int FROM working_sets
        WHERE modification_type = 'as_planned'
          AND occurrence_origin = 'planned'
          AND prescription_outcome = 'at') AS target_at,
      (SELECT count(*)::int FROM working_sets
        WHERE modification_type = 'as_planned'
          AND occurrence_origin = 'planned'
          AND prescription_outcome = 'above') AS target_above,
      (SELECT count(*)::int FROM working_sets
        WHERE modification_type = 'as_planned'
          AND occurrence_origin = 'planned'
          AND prescription_outcome = 'unknown') AS target_unknown,
      (SELECT avg(rpe)::float8 FROM working_sets
        WHERE NOT exclude_from_analytics AND rpe IS NOT NULL) AS average_rpe,
      (SELECT count(*)::int FROM occurrences WHERE modification_type = 'skipped') AS skipped_exercises,
      (SELECT count(*)::int FROM occurrences WHERE modification_type = 'substituted') AS substitutions,
      (SELECT count(*)::int FROM pain_logs pl JOIN selected_sessions s ON s.id = pl.session_id
        WHERE pl.user_id = ${userId}::uuid AND pl.archived_at IS NULL) AS pain_events,
      (SELECT count(*)::int FROM pain_logs pl JOIN selected_sessions s ON s.id = pl.session_id
        WHERE pl.user_id = ${userId}::uuid
          AND pl.archived_at IS NULL AND pl.severity >= 4) AS high_pain_events,
      (SELECT count(*)::int FROM valid_program_sessions
        WHERE status = 'completed') AS program_completed_sessions,
      (SELECT count(*)::int FROM valid_program_sessions
        WHERE status = 'abandoned') AS program_abandoned_sessions,
      ((SELECT count(*)::int FROM selected_sessions) -
        (SELECT count(*)::int FROM valid_program_sessions)) AS unlinked_sessions,
      (SELECT count(*)::int FROM program_occurrences
        WHERE (matched_planned_slot_id IS NOT NULL
               OR source_slot_lineage_id IS NOT NULL)
          AND modification_type = 'as_planned'
          AND has_completed_working) AS program_as_planned_occurrences,
      (SELECT count(*)::int FROM program_occurrences
        WHERE (matched_planned_slot_id IS NOT NULL
               OR source_slot_lineage_id IS NOT NULL)
          AND modification_type = 'substituted') AS program_substituted_occurrences,
      (SELECT count(*)::int FROM program_occurrences
        WHERE modification_type = 'added') AS program_added_occurrences,
      (SELECT count(*)::int FROM program_occurrences
        WHERE (matched_planned_slot_id IS NOT NULL
               OR source_slot_lineage_id IS NOT NULL)
          AND (
            modification_type = 'skipped'
            OR (modification_type = 'as_planned' AND has_skipped_working)
          )) AS program_skipped_occurrences,
      (SELECT count(*)::int FROM program_occurrences
        WHERE matched_planned_slot_id IS NULL
          AND source_slot_lineage_id IS NULL
          AND modification_type <> 'added') AS unlinked_planned_occurrences,
      coalesce((SELECT sum(events)::int FROM pain_context_rows
        WHERE exercise IS NOT NULL), 0) AS attributed_pain_events,
      (SELECT check_ins FROM fatigue_summary) AS fatigue_check_ins,
      (SELECT average FROM fatigue_summary) AS average_fatigue,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'status', status,
        'startedAtISO', to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'timezone', timezone,
        'localDate', local_date::text,
        'sourceDayLineageId', source_day_lineage_id,
        'templateName', template_name
      ) ORDER BY local_date, started_at, id) FROM selected_sessions), '[]'::jsonb)
        AS cadence_sessions,
      coalesce((SELECT jsonb_agg(to_jsonb(week_rows) ORDER BY week_start)
        FROM week_rows), '[]'::jsonb) AS weekly_rows,
      coalesce((SELECT jsonb_agg(to_jsonb(muscle_rows) ORDER BY sets DESC, muscle)
        FROM muscle_rows), '[]'::jsonb) AS muscles,
      coalesce((SELECT jsonb_agg(to_jsonb(exercise_rows)
        ORDER BY sessions DESC, sets DESC) FROM exercise_rows), '[]'::jsonb) AS exercise_progress,
      coalesce((SELECT jsonb_agg(to_jsonb(records)
        ORDER BY sessions DESC, exercise_name)
        FROM (
          SELECT * FROM record_rows
          ORDER BY sessions DESC, exercise_name
          LIMIT 8
        ) records), '[]'::jsonb) AS records,
      coalesce((SELECT jsonb_agg(to_jsonb(program_skip_reason_rows)
        ORDER BY count DESC, reason) FROM program_skip_reason_rows), '[]'::jsonb)
        AS program_skip_reasons,
      coalesce((SELECT jsonb_agg(to_jsonb(program_substitution_reason_rows)
        ORDER BY count DESC, reason) FROM program_substitution_reason_rows), '[]'::jsonb)
        AS program_substitution_reasons,
      coalesce((SELECT jsonb_agg(to_jsonb(contexts)
        ORDER BY events DESC, max_severity DESC, exercise, body_part)
        FROM (
          SELECT * FROM pain_context_rows
          ORDER BY events DESC, max_severity DESC, exercise, body_part
          LIMIT 5
        ) contexts), '[]'::jsonb) AS pain_contexts,
      coalesce((SELECT jsonb_agg(to_jsonb(skips)
        ORDER BY events DESC, planned_exercise)
        FROM (
          SELECT * FROM pain_skip_rows
          ORDER BY events DESC, planned_exercise
          LIMIT 5
        ) skips), '[]'::jsonb) AS pain_skips,
      coalesce((SELECT jsonb_agg(to_jsonb(substitutions)
        ORDER BY events DESC, planned_exercise, actual_exercise)
        FROM (
          SELECT * FROM discomfort_substitution_rows
          ORDER BY events DESC, planned_exercise, actual_exercise
          LIMIT 5
        ) substitutions), '[]'::jsonb) AS discomfort_substitutions,
      coalesce((SELECT jsonb_agg(to_jsonb(constraint_rows)
        ORDER BY avoid DESC, cautious DESC, body_part)
        FROM constraint_rows), '[]'::jsonb) AS constraints,
      coalesce((SELECT jsonb_agg(to_jsonb(family_rows)
        ORDER BY sets DESC, sessions DESC) FROM family_rows), '[]'::jsonb) AS families,
      coalesce((SELECT jsonb_agg(to_jsonb(semantic_exclusion_rows)
        ORDER BY count DESC, reason) FROM semantic_exclusion_rows), '[]'::jsonb)
        AS semantic_exclusions,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
          'id', id, 'name', name, 'status', status,
          'startedAtISO', to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'timezone', timezone, 'calendarDateKey', calendar_date_key,
          'durationMin', duration_min, 'durationExcluded', duration_excluded,
          'sets', sets, 'volume', volume,
          'targetHitRate', target_hit_rate,
          'targetBelow', target_below, 'targetAt', target_at,
          'targetAbove', target_above, 'targetUnknown', target_unknown,
          'skipped', skipped,
          'painEvents', pain_events
        ) ORDER BY started_at DESC, id DESC) FROM recent_rows), '[]'::jsonb) AS recent_sessions
  `);
  const row = resultRows(executed)[0];
  if (!row) throw new Error("History report query returned no result");

  const completedSessions = Number(row.completed_sessions);
  const workingSets = Number(row.working_sets);
  const effectiveSince =
    sinceLocalDate ?? String(row.earliest_local_date ?? nowLocalDate);
  const cadence = buildTrainingCadence({
    sessions: (row.cadence_sessions as Array<Record<string, unknown>>).map(
      (session) => ({
        id: String(session.id),
        status: session.status as "completed" | "abandoned",
        startedAt: new Date(String(session.startedAtISO)),
        timezone: String(session.timezone),
        localDate: String(session.localDate),
        sourceDayLineageId:
          session.sourceDayLineageId == null
            ? null
            : String(session.sourceDayLineageId),
        templateName:
          session.templateName == null ? null : String(session.templateName),
      }),
    ),
    rangeStartLocalDate: effectiveSince,
    now,
    currentTimezone: profile.timezone,
    currentWeeklyFrequency: plannedPerWeek,
  });
  const weeklyValues = new Map(
    (row.weekly_rows as Array<Record<string, unknown>>).map((week) => [
      String(week.week_start),
      {
        sessions: Number(week.sessions),
        sets: Number(week.sets),
        volume: Number(week.volume),
        durationMinutes: Number(week.duration_minutes),
        durationSessions: Number(week.duration_sessions),
      },
    ])
  );
  const weekly = [];
  for (
    let week = localWeekStart(effectiveSince), guard = 0;
    week <= nowLocalDate && guard < 600;
    week = addLocalDays(week, 7), guard += 1
  ) {
    const values = weeklyValues.get(week) ?? {
      sessions: 0,
      sets: 0,
      volume: 0,
      durationMinutes: 0,
      durationSessions: 0,
    };
    weekly.push({
      weekStartISO: `${week}T00:00:00.000Z`,
      sessions: values.sessions,
      sets: values.sets,
      volume: values.volume,
      durationMinutes: values.durationMinutes,
      durationSessions: values.durationSessions,
    });
  }
  const exerciseProgress = (
    row.exercise_progress as Array<Record<string, unknown>>
  ).map((exercise) => {
    const firstScore = Number(exercise.first_score);
    const latestScore = Number(exercise.latest_score);
    const firstMetric = String(exercise.first_metric) as
      | "estimated_strength"
      | "reps";
    const latestMetric = String(exercise.latest_metric) as
      | "estimated_strength"
      | "reps";
    const comparable =
      Number(exercise.observations) > 1 &&
      firstMetric === latestMetric &&
      firstScore > 0 &&
      exercise.first_exclusion_reason == null &&
      exercise.latest_exclusion_reason == null;
    return {
      exerciseId: String(exercise.exercise_id),
      exercise: String(exercise.exercise_name),
      loadType: String(exercise.load_type),
      metricType: String(exercise.exercise_metric_type) as
        | "weight_reps"
        | "reps"
        | "assisted_reps"
        | "duration"
        | "distance_duration"
        | "activity",
      loadSemantics: String(exercise.load_semantics),
      exclusionReason:
        exercise.latest_exclusion_reason == null
          ? exercise.first_exclusion_reason == null
            ? null
            : String(exercise.first_exclusion_reason) as SetMetricExclusionReason
          : String(exercise.latest_exclusion_reason) as SetMetricExclusionReason,
      sessions: Number(exercise.sessions),
      sets: Number(exercise.sets),
      volume: Number(exercise.volume),
      metric: latestMetric,
      first: {
        sourceSessionId: String(exercise.first_session_id),
        localDate: String(exercise.first_local_date),
        weight:
          exercise.first_weight == null ? null : round(Number(exercise.first_weight), 2),
        reps: Number(exercise.first_reps),
        estimatedStrength:
          firstMetric === "estimated_strength" ? Math.round(firstScore) : null,
      },
      latest: {
        sourceSessionId: String(exercise.latest_session_id),
        localDate: String(exercise.latest_local_date),
        weight:
          exercise.latest_weight == null ? null : round(Number(exercise.latest_weight), 2),
        reps: Number(exercise.latest_reps),
        estimatedStrength:
          latestMetric === "estimated_strength" ? Math.round(latestScore) : null,
      },
      changePercent: comparable
        ? round(((latestScore - firstScore) / firstScore) * 100, 1)
        : null,
      repChange:
        comparable && latestMetric === "reps"
          ? Number(exercise.latest_reps) - Number(exercise.first_reps)
          : null,
    };
  });
  const programFit: HistoryProgramFitEvidence = {
    completedSessions: Number(row.program_completed_sessions),
    abandonedSessions: Number(row.program_abandoned_sessions),
    unlinkedSessions: Number(row.unlinked_sessions),
    asPlannedOccurrences: Number(row.program_as_planned_occurrences),
    substitutedOccurrences: Number(row.program_substituted_occurrences),
    addedOccurrences: Number(row.program_added_occurrences),
    skippedOccurrences: Number(row.program_skipped_occurrences),
    unlinkedPlannedOccurrences: Number(row.unlinked_planned_occurrences),
    skipReasons: (
      row.program_skip_reasons as Array<Record<string, unknown>>
    ).map((reason) => ({
      reason: String(reason.reason),
      count: Number(reason.count),
    })),
    substitutionReasons: (
      row.program_substitution_reasons as Array<Record<string, unknown>>
    ).map((reason) => ({
      reason: String(reason.reason),
      count: Number(reason.count),
    })),
  };
  const painContexts: HistoryPainContextEvidence[] = (
    row.pain_contexts as Array<Record<string, unknown>>
  ).map((context) => ({
    exercise: context.exercise == null ? null : String(context.exercise),
    bodyPart: String(context.body_part),
    events: Number(context.events),
    maxSeverity: Number(context.max_severity),
  }));
  const painSkips: HistoryPainModificationEvidence[] = (
    row.pain_skips as Array<Record<string, unknown>>
  ).map((entry) => ({
    plannedExercise: String(entry.planned_exercise),
    events: Number(entry.events),
  }));
  const discomfortSubstitutions: HistoryPainModificationEvidence[] = (
    row.discomfort_substitutions as Array<Record<string, unknown>>
  ).map((entry) => ({
    plannedExercise: String(entry.planned_exercise),
    actualExercise: String(entry.actual_exercise),
    events: Number(entry.events),
  }));
  const constraintEvidence: HistoryConstraintEvidence[] = (
    row.constraints as Array<Record<string, unknown>>
  ).map((constraint) => ({
    bodyPart: String(constraint.body_part),
    affectedPatterns: Array.isArray(constraint.affected_patterns)
      ? constraint.affected_patterns.map(String)
      : [],
    avoid: Boolean(constraint.avoid),
    cautious: Boolean(constraint.cautious),
  }));
  const records: HistoryReportRecord[] = (
    row.records as Array<Record<string, unknown>>
  ).map((record) => {
    const metric = String(record.metric) as "estimated_strength" | "reps";
    return {
      exerciseId: String(record.exercise_id),
      sourceSessionId: String(record.session_id),
      exercise: String(record.exercise_name),
      sessions: Number(record.sessions),
      localDate: String(record.local_date),
      metric,
      weight: record.weight == null ? null : round(Number(record.weight), 2),
      reps: Number(record.reps),
      estimatedStrength:
        metric === "estimated_strength" ? Math.round(Number(record.score)) : null,
    };
  });
  const targetOutcomes = buildPrescriptionOutcomeSummary({
    below: Number(row.target_below),
    at: Number(row.target_at),
    above: Number(row.target_above),
    unknown: Number(row.target_unknown),
  });
  const averageFatigue =
    row.average_fatigue == null ? null : round(Number(row.average_fatigue), 1);
  const fatigueCheckIns = Number(row.fatigue_check_ins);
  const highPainEvents = Number(row.high_pain_events);

  const insights: HistoryInsight[] = [];
  if (!completedSessions) {
    insights.push({
      tone: "neutral",
      title: "No completed workouts in this period",
      detail: "Choose a longer range or complete a workout to unlock trends.",
    });
  } else if (cadence.averageSessionsPerCompleteWeek != null) {
    insights.push({
      tone: "neutral",
      title: "Training cadence",
      detail: `${completedSessions} completed sessions averaged ${cadence.averageSessionsPerCompleteWeek} per complete calendar week across ${cadence.completeWeeks} complete weeks. The current preference is ${plannedPerWeek} per week; historical preferences and scheduled opportunities are not reconstructed.`,
    });
  }
  const comparisonWeeks = weekly.slice(-8);
  if (comparisonWeeks.length >= 6) {
    const midpoint = Math.floor(comparisonWeeks.length / 2);
    const priorVolume = comparisonWeeks
      .slice(0, midpoint)
      .reduce((total, week) => total + week.volume, 0);
    const recentVolume = comparisonWeeks
      .slice(midpoint)
      .reduce((total, week) => total + week.volume, 0);
    if (priorVolume > 0) {
      const change = Math.round(
        ((recentVolume - priorVolume) / priorVolume) * 100
      );
      insights.push({
        tone: change > 10 ? "positive" : change < -10 ? "watch" : "neutral",
        title:
          change > 10
            ? "Loaded workload is rising"
            : change < -10
              ? "Loaded workload has eased"
              : "Loaded workload is steady",
        detail: `The latest half of the eight-week view is ${Math.abs(change)}% ${change >= 0 ? "higher" : "lower"} than the prior half. Bodyweight and band work are excluded from this measure.`,
      });
    }
  }
  const strongestProgress = exerciseProgress
    .filter((exercise) => exercise.changePercent != null)
    .sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0))[0];
  if (strongestProgress && (strongestProgress.changePercent ?? 0) > 1) {
    insights.push({
      tone: "positive",
      title: `${strongestProgress.exercise} is the clearest progression`,
      detail:
        strongestProgress.metric === "estimated_strength"
          ? `Estimated top-set strength is up ${strongestProgress.changePercent}% from the first exposure in this period.`
          : `Best-set reps are up ${strongestProgress.repChange ?? 0} from the first exposure in this period.`,
    });
  }
  if (targetOutcomes.atOrAboveRate != null) {
    insights.push({
      tone:
        targetOutcomes.atOrAboveRate >= 80
          ? "positive"
          : targetOutcomes.atOrAboveRate < 60
            ? "watch"
            : "neutral",
      title:
        targetOutcomes.atOrAboveRate >= 80
          ? "Most working sets are landing on target"
          : targetOutcomes.atOrAboveRate < 60
            ? "Targets are being missed often"
            : "Target completion is mixed",
      detail: `${targetOutcomes.atOrAboveRate}% of ${targetOutcomes.supported} planned sets with supported targets landed at or above them. ${targetOutcomes.unknown} planned set outcomes remain unknown.`,
    });
  }
  if (highPainEvents > 0) {
    insights.push({
      tone: "watch",
      title: "Pain flags deserve attention",
      detail: `${highPainEvents} pain ${highPainEvents === 1 ? "entry was" : "entries were"} rated 4/10 or higher in this period.`,
    });
  } else if (averageFatigue != null) {
    insights.push({
      tone: averageFatigue >= 4 ? "watch" : "positive",
      title:
        averageFatigue >= 4
          ? "Post-workout fatigue is high"
          : "Recovery signal looks manageable",
      detail: `Average post-workout fatigue is ${averageFatigue}/5 across ${fatigueCheckIns} check-ins, with no pain flags at 4/10 or higher.`,
    });
  } else if (completedSessions) {
    insights.push({
      tone: "neutral",
      title: "Recovery evidence is incomplete",
      detail:
        "Add the fatigue check-in when finishing workouts to make recovery trends more reliable.",
    });
  }

  const recentSessions = (row.recent_sessions as Array<Record<string, unknown>>).map(
    (session) => ({
      id: String(session.id),
      name: String(session.name),
      status: session.status as "completed" | "abandoned",
      startedAtISO: String(session.startedAtISO),
      timezone: String(session.timezone),
      calendarDateKey: String(session.calendarDateKey),
      durationMin:
        session.durationMin == null ? null : Number(session.durationMin),
      durationExcluded: Boolean(session.durationExcluded),
      sets: Number(session.sets),
      volume: Number(session.volume),
      targetOutcomes: buildPrescriptionOutcomeSummary({
        below: Number(session.targetBelow),
        at: Number(session.targetAt),
        above: Number(session.targetAbove),
        unknown: Number(session.targetUnknown),
      }),
      targetHitRate:
        session.targetHitRate == null ? null : Number(session.targetHitRate),
      skipped: Number(session.skipped),
      painEvents: Number(session.painEvents),
    }),
  ) as ReturnType<typeof buildHistoryCalendarSessions>;
  const abandonedSessions = Number(row.abandoned_sessions);
  const averageDurationMin =
    row.average_duration_min == null
      ? null
      : Number(row.average_duration_min);
  const visibleWeekly = weekly.slice(-12);
  const lenses = buildHistoryLenses({
    unit: profile.unit,
    completedSessions,
    abandonedSessions,
    workingSets,
    averageDurationMin,
    weekly: visibleWeekly,
    exerciseProgress,
    programFit,
    pain: {
      painEvents: Number(row.pain_events),
      highPainEvents,
      attributedPainEvents: Number(row.attributed_pain_events),
      contexts: painContexts,
      painSkips,
      discomfortSubstitutions,
      constraints: constraintEvidence,
    },
    records,
  });
  return {
    overview: {
      completedSessions,
      abandonedSessions,
      workingSets,
      totalReps: Number(row.total_reps),
      loadedVolume: Number(row.loaded_volume),
      timedActivityMinutes: Number(row.timed_activity_minutes),
      distanceKm: Number(row.distance_km),
      excludedMetricSets: Number(row.excluded_metric_sets),
      semanticExclusions: (
        row.semantic_exclusions as Array<Record<string, unknown>>
      ).map((entry) => ({
        reason: String(entry.reason) as SetMetricExclusionReason,
        count: Number(entry.count),
      })),
      excludedDurationSessions: Number(row.excluded_duration_sessions),
      averageDurationMin,
      targetOutcomes,
      targetHitRate: targetOutcomes.atOrAboveRate,
      averageRpe:
        row.average_rpe == null ? null : round(Number(row.average_rpe), 1),
    },
    weekly: visibleWeekly,
    cadence,
    muscles: (row.muscles as Array<Record<string, unknown>>).map((muscle) => ({
      muscle: String(muscle.muscle),
      sets: Number(muscle.sets),
      share: workingSets
        ? Math.round((Number(muscle.sets) / workingSets) * 100)
        : 0,
    })),
    exerciseProgress,
    records,
    families: (row.families as Array<Record<string, unknown>>).map((family) => ({
      familyKey: String(family.family_key),
      family: String(family.family),
      sessions: Number(family.sessions),
      exercises: Number(family.exercises),
      sets: Number(family.sets),
      volume: Number(family.volume),
    })),
    recovery: {
      averageFatigue,
      fatigueCheckIns,
      painEvents: Number(row.pain_events),
      highPainEvents,
      skippedExercises: Number(row.skipped_exercises),
      substitutions: Number(row.substitutions),
    },
    lenses,
    insights,
    calendarSessions: recentSessions,
    recentSessions,
  };
}

/** Calendar navigation is independent from the report-period filter. */
export async function getHistoryCalendarRecords(
  db: Db,
  userId: string,
  displayUnit: LoadUnit = "lb",
  visible?: { view: HistoryCalendarView; date: string }
) {
  if (visible) {
    const window = historyCalendarWindow(visible.view, visible.date);
    const calendarSetSemantics = {
      recordedMetricType: sql`cs.metric_type`,
      prescribedSemanticsVersion: sql`se.prescribed_semantics_version`,
      performedSemanticsVersion: sql`cs.performed_semantics_version`,
      performedLoadType: sql`cs.performed_load_type`,
      performedLoadSemantics: sql`cs.performed_load_semantics`,
      exerciseMetricType: sql`e.metric_type`,
      loadType: sql`e.load_type`,
      loadSemantics: sql`e.load_semantics`,
      loadEntryMeaning: sql`cs.load_entry_meaning`,
      weight: sql`cs.weight`,
      reps: sql`cs.reps`,
      excludeFromAnalytics: sql`cs.exclude_from_analytics`,
    };
    const calendarSetOutcome = {
      ...calendarSetSemantics,
      weightUnit: sql`cs.weight_unit`,
      targetRepsMin: sql`occurrence.planned_reps_min`,
      targetRepsMax: sql`occurrence.planned_reps_max`,
      targetLoad: sql`occurrence.planned_load`,
      targetLoadUnit: sql`occurrence.planned_load_unit`,
      targetLoadPercent: sql`occurrence.planned_load_percent`,
      targetLoadText: sql`occurrence.planned_load_text`,
    };
    const calendarPrescriptionOutcome = sql`CASE
      WHEN occurrence.occurrence_count = 1
      THEN ${prescriptionOutcomeSql(calendarSetOutcome)}
      ELSE 'unknown'
    END`;
    const executed = await db.execute(sql`
      WITH visible_workouts AS MATERIALIZED (
        SELECT ws.*
        FROM workout_sessions ws
        WHERE ws.user_id = ${userId}::uuid
          AND ws.status IN ('completed', 'abandoned')
          AND ws.archived_at IS NULL
          AND ws.local_date BETWEEN ${window.start}::date AND ${window.end}::date
      ), workout_records AS (
        SELECT
          'workout'::text AS record_type,
          ws.id,
          coalesce(ws.template_name, 'Workout') AS name,
          ws.status::text AS status,
          NULL::text AS activity_type,
          ws.source,
          ws.performed_time_precision,
          ws.started_at,
          ws.timezone,
          ws.local_date::text AS calendar_date_key,
          CASE WHEN ws.finished_at IS NOT NULL
              AND NOT ws.exclude_duration_from_analytics
              AND ws.finished_at >= ws.started_at
              AND extract(epoch FROM ws.finished_at - ws.started_at) / 60 <=
                ${MAX_ANALYTICS_WORKOUT_DURATION_MINUTES}
            THEN greatest(0, round(extract(epoch FROM ws.finished_at - ws.started_at) / 60))::int
            ELSE NULL END AS duration_min,
          ws.finished_at IS NOT NULL AND (
            ws.exclude_duration_from_analytics OR
            ws.finished_at < ws.started_at OR
            extract(epoch FROM ws.finished_at - ws.started_at) / 60 >
              ${MAX_ANALYTICS_WORKOUT_DURATION_MINUTES}
          ) AS duration_excluded,
          coalesce(metrics.sets, 0)::int AS sets,
          coalesce(metrics.volume, 0)::int AS volume,
          CASE WHEN coalesce(metrics.targetable, 0) > 0
            THEN round(metrics.targets_met * 100.0 / metrics.targetable)::int
            ELSE NULL END AS target_hit_rate,
          coalesce(metrics.target_below, 0)::int AS target_below,
          coalesce(metrics.target_at, 0)::int AS target_at,
          coalesce(metrics.target_above, 0)::int AS target_above,
          coalesce(metrics.target_unknown, 0)::int AS target_unknown,
          coalesce(metrics.skipped, 0)::int AS skipped,
          coalesce(pain.events, 0)::int AS pain_events,
          NULL::float8 AS distance_km,
          NULL::float8 AS average_pace_seconds_per_km,
          NULL::text AS intensity,
          NULL::float8 AS elevation_gain_m,
          NULL::int AS average_heart_rate_bpm,
          NULL::float8 AS energy_kcal
        FROM visible_workouts ws
        LEFT JOIN LATERAL (
          SELECT
            count(cs.id) FILTER (WHERE NOT cs.is_warmup)::int AS sets,
            round(coalesce(sum(CASE
              WHEN cs.is_warmup
                OR NOT ${eligibleTotalSystemLoadSql(calendarSetSemantics)}
                THEN 0
              WHEN cs.weight_unit = ${displayUnit} THEN cs.weight * cs.reps
              WHEN cs.weight_unit = 'kg' AND ${displayUnit} = 'lb'
                THEN cs.weight * ${KG_TO_LB} * cs.reps
              ELSE cs.weight / ${KG_TO_LB} * cs.reps
            END), 0))::int AS volume,
            count(cs.id) FILTER (
              WHERE NOT cs.is_warmup
                AND se.modification_type = 'as_planned'
                AND occurrence.origin = 'planned'
                AND ${calendarPrescriptionOutcome}::text <> 'unknown'
            )::int AS targetable,
            count(cs.id) FILTER (
              WHERE NOT cs.is_warmup
                AND se.modification_type = 'as_planned'
                AND occurrence.origin = 'planned'
                AND ${calendarPrescriptionOutcome}::text IN ('at', 'above')
            )::int AS targets_met,
            count(cs.id) FILTER (
              WHERE NOT cs.is_warmup
                AND se.modification_type = 'as_planned'
                AND occurrence.origin = 'planned'
                AND ${calendarPrescriptionOutcome}::text = 'below'
            )::int AS target_below,
            count(cs.id) FILTER (
              WHERE NOT cs.is_warmup
                AND se.modification_type = 'as_planned'
                AND occurrence.origin = 'planned'
                AND ${calendarPrescriptionOutcome}::text = 'at'
            )::int AS target_at,
            count(cs.id) FILTER (
              WHERE NOT cs.is_warmup
                AND se.modification_type = 'as_planned'
                AND occurrence.origin = 'planned'
                AND ${calendarPrescriptionOutcome}::text = 'above'
            )::int AS target_above,
            count(cs.id) FILTER (
              WHERE NOT cs.is_warmup
                AND se.modification_type = 'as_planned'
                AND occurrence.origin = 'planned'
                AND ${calendarPrescriptionOutcome}::text = 'unknown'
            )::int AS target_unknown,
            count(DISTINCT se.id) FILTER (WHERE se.modification_type = 'skipped')::int AS skipped
          FROM session_exercises se
          JOIN exercises e ON e.id = se.exercise_id
          LEFT JOIN completed_sets cs
            ON cs.session_exercise_id = se.id
           AND cs.archived_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM session_occurrences linked
             WHERE linked.completed_set_id = cs.id
               AND linked.session_exercise_id = se.id
               AND linked.kind = 'working_set'
               AND linked.outcome = 'completed'
           )
          LEFT JOIN LATERAL (
            SELECT candidate.*, count(*) OVER ()::int AS occurrence_count
            FROM session_occurrences candidate
            WHERE candidate.completed_set_id = cs.id
              AND candidate.session_exercise_id = se.id
              AND candidate.kind = 'working_set'
              AND candidate.outcome = 'completed'
            ORDER BY candidate.sequence_idx, candidate.id
            LIMIT 1
          ) occurrence ON true
          WHERE se.session_id = ws.id
        ) metrics ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS events
          FROM pain_logs pl
          WHERE pl.session_id = ws.id AND pl.archived_at IS NULL
        ) pain ON true
      ), activity_records AS (
        SELECT
          'activity'::text AS record_type,
          ha.id,
          coalesce(ha.title, ha.activity_type) AS name,
          NULL::text AS status,
          ha.activity_type,
          ha.source,
          NULL::text AS performed_time_precision,
          ha.started_at,
          ha.timezone,
          timezone(ha.timezone, ha.started_at)::date::text AS calendar_date_key,
          round(ha.duration_seconds / 60.0)::int AS duration_min,
          false AS duration_excluded,
          NULL::int AS sets,
          NULL::int AS volume,
          NULL::int AS target_hit_rate,
          NULL::int AS target_below,
          NULL::int AS target_at,
          NULL::int AS target_above,
          NULL::int AS target_unknown,
          NULL::int AS skipped,
          NULL::int AS pain_events,
          ha.distance_km,
          ha.average_pace_seconds_per_km,
          ha.intensity,
          ha.elevation_gain_m,
          ha.average_heart_rate_bpm,
          ha.energy_kcal
        FROM health_activities ha
        WHERE ha.user_id = ${userId}::uuid
          AND ha.archived_at IS NULL
          AND timezone(ha.timezone, ha.started_at)::date
            BETWEEN ${window.start}::date AND ${window.end}::date
      )
      SELECT * FROM workout_records
      UNION ALL
      SELECT * FROM activity_records
      ORDER BY started_at DESC, id DESC
    `);
    const rows = resultRows(executed);

    return rows.map((row) => {
      const startedAt =
        row.started_at instanceof Date
          ? row.started_at
          : new Date(String(row.started_at));
      if (row.record_type === "activity") {
        const activityType = String(row.activity_type);
        return {
          recordType: "activity" as const,
          id: String(row.id),
          name:
            row.name === activityType
              ? activityTypeLabel(activityType)
              : String(row.name),
          activityType,
          startedAtISO: startedAt.toISOString(),
          timezone: String(row.timezone),
          calendarDateKey: String(row.calendar_date_key),
          durationMin: Number(row.duration_min),
          distanceKm: row.distance_km == null ? null : Number(row.distance_km),
          averagePaceSecondsPerKm:
            row.average_pace_seconds_per_km == null
              ? null
              : Number(row.average_pace_seconds_per_km),
          intensity: row.intensity == null ? null : String(row.intensity),
          elevationGainM:
            row.elevation_gain_m == null ? null : Number(row.elevation_gain_m),
          averageHeartRateBpm:
            row.average_heart_rate_bpm == null
              ? null
              : Number(row.average_heart_rate_bpm),
          energyKcal:
            row.energy_kcal == null ? null : Number(row.energy_kcal),
          source: String(row.source),
        };
      }
      return {
        recordType: "workout" as const,
        id: String(row.id),
        name: String(row.name),
        status: row.status as "completed" | "abandoned",
        source: String(row.source),
        performedTimePrecision:
          row.performed_time_precision === "date_only"
            ? "date_only" as const
            : "instant" as const,
        startedAtISO: startedAt.toISOString(),
        timezone: String(row.timezone),
        calendarDateKey: String(row.calendar_date_key),
        durationMin: row.duration_min == null ? null : Number(row.duration_min),
        durationExcluded: Boolean(row.duration_excluded),
        sets: Number(row.sets),
        volume: Number(row.volume),
        targetOutcomes: buildPrescriptionOutcomeSummary({
          below: Number(row.target_below),
          at: Number(row.target_at),
          above: Number(row.target_above),
          unknown: Number(row.target_unknown),
        }),
        targetHitRate:
          row.target_hit_rate == null ? null : Number(row.target_hit_rate),
        skipped: Number(row.skipped),
        painEvents: Number(row.pain_events),
      };
    });
  }

  const [sessions, activities] = await Promise.all([
    db.query.workoutSessions.findMany({
      where: and(
        eq(workoutSessions.userId, userId),
        inArray(workoutSessions.status, ["completed", "abandoned"]),
        isNull(workoutSessions.archivedAt)
      ),
      orderBy: desc(workoutSessions.startedAt),
      columns: {
        id: true,
        templateName: true,
        status: true,
        source: true,
        performedTimePrecision: true,
        startedAt: true,
        timezone: true,
        localDate: true,
        finishedAt: true,
        excludeDurationFromAnalytics: true,
      },
      with: {
        exercises: {
          orderBy: sessionExercises.orderIdx,
          columns: { modificationType: true },
          with: {
            exercise: {
              columns: {
                loadType: true,
                metricType: true,
                loadSemantics: true,
              },
            },
            sets: {
              orderBy: completedSets.setNo,
              where: isNull(completedSets.archivedAt),
              columns: {
                id: true,
                weight: true,
                weightUnit: true,
                loadEntryMeaning: true,
                reps: true,
                metricType: true,
                distanceKm: true,
                durationSeconds: true,
                excludeFromAnalytics: true,
                isWarmup: true,
              },
            },
          },
        },
        painLogs: {
          where: isNull(painLogs.archivedAt),
          columns: { id: true },
        },
        occurrences: {
          orderBy: sessionOccurrences.sequenceIdx,
          columns: {
            kind: true,
            origin: true,
            outcome: true,
            completedSetId: true,
            plannedRepsMin: true,
            plannedRepsMax: true,
            plannedLoad: true,
            plannedLoadUnit: true,
            plannedLoadPercent: true,
            plannedLoadText: true,
          },
        },
      },
    }),
    db.query.healthActivities.findMany({
      where: and(
        eq(healthActivities.userId, userId),
        isNull(healthActivities.archivedAt)
      ),
      orderBy: desc(healthActivities.startedAt),
      columns: {
        id: true,
        activityType: true,
        title: true,
        startedAt: true,
        timezone: true,
        durationSeconds: true,
        distanceKm: true,
        averagePaceSecondsPerKm: true,
        intensity: true,
        elevationGainM: true,
        averageHeartRateBpm: true,
        energyKcal: true,
        source: true,
      },
    }),
  ]);

  return [
    ...buildHistoryCalendarSessions(
      sessions as HistoryCalendarSessionInput[],
      displayUnit
    ),
    ...buildHistoryCalendarActivities(
      activities as HistoryCalendarActivityInput[]
    ),
  ].sort(
    (a, b) =>
      new Date(b.startedAtISO).getTime() - new Date(a.startedAtISO).getTime()
  );
}
