import {
  addLocalDays,
  localDateDifference,
  localWeekStart,
  workoutLocalDate,
} from "@/lib/workout-calendar";

export const TRAINING_CADENCE_ALGORITHM_VERSION = "calendar-cadence-v1";

export type TrainingCadenceSession = {
  id: string;
  status: "completed" | "abandoned";
  startedAt: Date;
  timezone: string;
  localDate: string;
  sourceDayLineageId?: string | null;
  templateName?: string | null;
};

export type TrainingCadence = {
  algorithmVersion: typeof TRAINING_CADENCE_ALGORITHM_VERSION;
  completedSessions: number;
  completeWeeks: number;
  averageSessionsPerCompleteWeek: number | null;
  weekly: Array<{ weekStart: string; sessions: number }>;
  medianGapDays: number | null;
  currentGapDays: number | null;
  programDayExposures: Array<{
    lineageId: string;
    sessions: number;
    labels: Array<{ label: string; sessions: number }>;
  }>;
  unlinkedSessions: number;
  currentPreference: {
    sessionsPerWeek: number;
    comparison: "below" | "matches" | "above" | "unavailable";
    limitation: string;
  };
};

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[midpoint]
    : round((sorted[midpoint - 1] + sorted[midpoint]) / 2, 1);
}

function firstCompleteWeekStart(rangeStartLocalDate: string) {
  const weekStart = localWeekStart(rangeStartLocalDate);
  return weekStart === rangeStartLocalDate
    ? weekStart
    : addLocalDays(weekStart, 7);
}

export function buildTrainingCadence(input: {
  sessions: TrainingCadenceSession[];
  rangeStartLocalDate: string | null;
  now: Date;
  currentTimezone: string;
  currentWeeklyFrequency: number;
}): TrainingCadence {
  const completed = input.sessions
    .filter((session) => session.status === "completed")
    .sort(
      (left, right) =>
        left.localDate.localeCompare(right.localDate) ||
        left.startedAt.getTime() - right.startedAt.getTime() ||
        left.id.localeCompare(right.id),
    );
  const ownerToday = workoutLocalDate(input.now, input.currentTimezone);
  const effectiveStart =
    input.rangeStartLocalDate ?? completed[0]?.localDate ?? null;
  const currentWeekStart = localWeekStart(ownerToday);
  const weekly: TrainingCadence["weekly"] = [];

  if (effectiveStart != null) {
    for (
      let weekStart = firstCompleteWeekStart(effectiveStart), guard = 0;
      weekStart < currentWeekStart && guard < 600;
      weekStart = addLocalDays(weekStart, 7), guard += 1
    ) {
      weekly.push({
        weekStart,
        sessions: completed.filter(
          (session) => localWeekStart(session.localDate) === weekStart,
        ).length,
      });
    }
  }

  const gaps = completed.slice(1).map((session, index) =>
    localDateDifference(session.localDate, completed[index].localDate),
  );
  const latest = [...completed].sort(
    (left, right) =>
      right.startedAt.getTime() - left.startedAt.getTime() ||
      right.id.localeCompare(left.id),
  )[0];
  const currentGapDays = latest
    ? Math.max(
        0,
        localDateDifference(
          workoutLocalDate(input.now, latest.timezone),
          latest.localDate,
        ),
      )
    : null;

  const exposureMap = new Map<
    string,
    { sessions: number; labels: Map<string, number> }
  >();
  for (const session of completed) {
    if (!session.sourceDayLineageId) continue;
    const exposure = exposureMap.get(session.sourceDayLineageId) ?? {
      sessions: 0,
      labels: new Map<string, number>(),
    };
    const label = session.templateName?.trim() || "Unnamed Program day";
    exposure.sessions += 1;
    exposure.labels.set(label, (exposure.labels.get(label) ?? 0) + 1);
    exposureMap.set(session.sourceDayLineageId, exposure);
  }
  const programDayExposures = [...exposureMap.entries()]
    .map(([lineageId, exposure]) => ({
      lineageId,
      sessions: exposure.sessions,
      labels: [...exposure.labels.entries()]
        .map(([label, sessions]) => ({ label, sessions }))
        .sort(
          (left, right) =>
            right.sessions - left.sessions || left.label.localeCompare(right.label),
        ),
    }))
    .sort(
      (left, right) =>
        right.sessions - left.sessions || left.lineageId.localeCompare(right.lineageId),
    );

  const averageSessionsPerCompleteWeek = weekly.length
    ? round(
        weekly.reduce((total, week) => total + week.sessions, 0) /
          weekly.length,
        2,
      )
    : null;
  const comparison =
    averageSessionsPerCompleteWeek == null
      ? "unavailable"
      : Math.abs(
            averageSessionsPerCompleteWeek - input.currentWeeklyFrequency,
          ) < 0.005
        ? "matches"
        : averageSessionsPerCompleteWeek < input.currentWeeklyFrequency
          ? "below"
          : "above";

  return {
    algorithmVersion: TRAINING_CADENCE_ALGORITHM_VERSION,
    completedSessions: completed.length,
    completeWeeks: weekly.length,
    averageSessionsPerCompleteWeek,
    weekly,
    medianGapDays: median(gaps),
    currentGapDays,
    programDayExposures,
    unlinkedSessions:
      completed.length -
      programDayExposures.reduce(
        (total, exposure) => total + exposure.sessions,
        0,
      ),
    currentPreference: {
      sessionsPerWeek: input.currentWeeklyFrequency,
      comparison,
      limitation:
        "The preference is current. Historical preferences and scheduled opportunities are not reconstructed, so this is not an adherence percentage.",
    },
  };
}
