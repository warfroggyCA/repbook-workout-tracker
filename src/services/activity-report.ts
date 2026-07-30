import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { healthActivities } from "@/db/schema";
import {
  activityDateKey,
  activityTypeLabel,
  activityUsesSpeed,
} from "@/lib/activities";
import {
  historyRangeStart,
  type HistoryRangeKey,
} from "@/services/history-report";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export const ACTIVITY_ANALYTICS_RULE =
  "Independent health activities can provide health and recovery context, but they never change strength-workout progression or the program automatically.";

export type ActivityReportInput = Pick<
  typeof healthActivities.$inferSelect,
  | "id"
  | "activityType"
  | "title"
  | "startedAt"
  | "timezone"
  | "durationSeconds"
  | "distanceKm"
  | "averagePaceSecondsPerKm"
  | "intensity"
  | "elevationGainM"
  | "averageHeartRateBpm"
  | "energyKcal"
  | "source"
  | "excludeFromAnalytics"
>;

export type ActivityReport = ReturnType<typeof summarizeActivities>;

function round(value: number, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function dateKeyToUtcDate(key: string) {
  return new Date(`${key}T12:00:00.000Z`);
}

function utcWeekStart(date: Date) {
  const result = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7));
  return result;
}

function addUtcWeek(date: Date) {
  return new Date(date.getTime() + WEEK_MS);
}

function weightedPace(
  activities: Array<
    Pick<ActivityReportInput, "distanceKm" | "averagePaceSecondsPerKm">
  >
) {
  const measurable = activities.filter(
    (activity) =>
      activity.distanceKm != null &&
      activity.distanceKm > 0 &&
      activity.averagePaceSecondsPerKm != null
  );
  const distance = measurable.reduce(
    (total, activity) => total + (activity.distanceKm ?? 0),
    0
  );
  if (!distance) return null;
  return round(
    measurable.reduce(
      (total, activity) =>
        total +
        (activity.averagePaceSecondsPerKm ?? 0) *
          (activity.distanceKm ?? 0),
      0
    ) / distance,
    1
  );
}

export function summarizeActivities(
  activities: ActivityReportInput[],
  configuredSince: Date | null,
  now = new Date()
) {
  const included = activities
    .filter((activity) => !activity.excludeFromAnalytics)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const excludedActivities = activities.length - included.length;
  const effectiveSince =
    configuredSince ??
    (included[0]
      ? dateKeyToUtcDate(
          activityDateKey(included[0].startedAt, included[0].timezone)
        )
      : now);
  const weeksInRange = Math.max(
    1,
    Math.ceil(Math.max(0, now.getTime() - effectiveSince.getTime()) / WEEK_MS)
  );

  const totalSeconds = included.reduce(
    (total, activity) => total + activity.durationSeconds,
    0
  );
  const totalDistanceKm = included.reduce(
    (total, activity) => total + (activity.distanceKm ?? 0),
    0
  );
  const activeWeekKeys = new Set(
    included.map((activity) =>
      utcWeekStart(
        dateKeyToUtcDate(activityDateKey(activity.startedAt, activity.timezone))
      ).toISOString()
    )
  );

  const byTypeMap = new Map<string, ActivityReportInput[]>();
  for (const activity of included) {
    const current = byTypeMap.get(activity.activityType) ?? [];
    current.push(activity);
    byTypeMap.set(activity.activityType, current);
  }

  const byType = [...byTypeMap.entries()]
    .map(([activityType, records]) => {
      const paceRecords = records.filter(
        (activity) =>
          activity.distanceKm != null &&
          activity.distanceKm > 0 &&
          activity.averagePaceSecondsPerKm != null
      );
      const splitAt = Math.floor(paceRecords.length / 2);
      const earlierPace = splitAt
        ? weightedPace(paceRecords.slice(0, splitAt))
        : null;
      const latestPace = splitAt
        ? weightedPace(paceRecords.slice(splitAt))
        : null;
      let performanceChangePercent: number | null = null;
      if (earlierPace && latestPace) {
        performanceChangePercent = activityUsesSpeed(activityType)
          ? round((earlierPace / latestPace - 1) * 100, 1)
          : round(((earlierPace - latestPace) / earlierPace) * 100, 1);
      }

      return {
        activityType,
        label: activityTypeLabel(activityType),
        activities: records.length,
        totalMinutes: Math.round(
          records.reduce(
            (total, activity) => total + activity.durationSeconds,
            0
          ) / 60
        ),
        distanceKm: round(
          records.reduce(
            (total, activity) => total + (activity.distanceKm ?? 0),
            0
          ),
          2
        ),
        averagePaceSecondsPerKm: weightedPace(records),
        performanceChangePercent,
        performanceObservationCount: paceRecords.length,
      };
    })
    .sort(
      (a, b) =>
        b.totalMinutes - a.totalMinutes || b.activities - a.activities
    );

  const weeklyMap = new Map<
    string,
    { activities: number; durationSeconds: number; distanceKm: number }
  >();
  for (const activity of included) {
    const weekStartISO = utcWeekStart(
      dateKeyToUtcDate(activityDateKey(activity.startedAt, activity.timezone))
    ).toISOString();
    const week = weeklyMap.get(weekStartISO) ?? {
      activities: 0,
      durationSeconds: 0,
      distanceKm: 0,
    };
    week.activities += 1;
    week.durationSeconds += activity.durationSeconds;
    week.distanceKm += activity.distanceKm ?? 0;
    weeklyMap.set(weekStartISO, week);
  }

  const weekly = [];
  const firstWeek = utcWeekStart(effectiveSince);
  const lastWeek = utcWeekStart(now);
  for (
    let cursor = firstWeek, guard = 0;
    cursor.getTime() <= lastWeek.getTime() && guard < 600;
    cursor = addUtcWeek(cursor), guard += 1
  ) {
    const key = cursor.toISOString();
    const values = weeklyMap.get(key);
    weekly.push({
      weekStartISO: key,
      activities: values?.activities ?? 0,
      durationMinutes: Math.round((values?.durationSeconds ?? 0) / 60),
      distanceKm: round(values?.distanceKm ?? 0, 2),
    });
  }
  const visibleWeekly = weekly.slice(-12);
  const latestFour = weekly.slice(-4);
  const previousFour = weekly.slice(-8, -4);
  const latestFourMinutes = latestFour.reduce(
    (total, week) => total + week.durationMinutes,
    0
  );
  const previousFourMinutes = previousFour.reduce(
    (total, week) => total + week.durationMinutes,
    0
  );

  const coverage = (predicate: (activity: ActivityReportInput) => boolean) =>
    included.filter(predicate).length;

  return {
    rule: ACTIVITY_ANALYTICS_RULE,
    overview: {
      totalActivities: included.length,
      totalMinutes: Math.round(totalSeconds / 60),
      totalDistanceKm: round(totalDistanceKm, 2),
      averageDurationMinutes: included.length
        ? Math.round(totalSeconds / included.length / 60)
        : null,
      activitiesPerWeek: round(included.length / weeksInRange, 1),
      activeWeeks: activeWeekKeys.size,
      weeksInRange,
      consistencyPercent: Math.min(
        100,
        Math.round((activeWeekKeys.size / weeksInRange) * 100)
      ),
      excludedActivities,
    },
    trend: {
      latestFourWeeksMinutes: latestFourMinutes,
      previousFourWeeksMinutes: previousFourMinutes,
      minuteChangePercent:
        previousFourMinutes > 0
          ? round(
              ((latestFourMinutes - previousFourMinutes) /
                previousFourMinutes) *
                100,
              1
            )
          : null,
    },
    measurementCoverage: {
      activities: included.length,
      distance: coverage((activity) => activity.distanceKm != null),
      pace: coverage(
        (activity) => activity.averagePaceSecondsPerKm != null
      ),
      intensity: coverage((activity) => activity.intensity != null),
      elevation: coverage((activity) => activity.elevationGainM != null),
      heartRate: coverage(
        (activity) => activity.averageHeartRateBpm != null
      ),
      energy: coverage((activity) => activity.energyKcal != null),
    },
    byType,
    weekly: visibleWeekly,
    recent: [...included]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, 5)
      .map((activity) => ({
        id: activity.id,
        activityType: activity.activityType,
        label: activityTypeLabel(activity.activityType),
        title: activity.title,
        startedAtISO: activity.startedAt.toISOString(),
        timezone: activity.timezone,
        durationSeconds: activity.durationSeconds,
        distanceKm: activity.distanceKm,
        averagePaceSecondsPerKm: activity.averagePaceSecondsPerKm,
        intensity: activity.intensity,
        elevationGainM: activity.elevationGainM,
        averageHeartRateBpm: activity.averageHeartRateBpm,
        energyKcal: activity.energyKcal,
        source: activity.source,
      })),
  };
}

export async function getActivityReport(
  db: Db,
  userId: string,
  range: HistoryRangeKey,
  now = new Date()
) {
  const since = historyRangeStart(range, now);
  const sinceFilter = since ? sql`AND started_at >= ${since}` : sql``;
  const executed = await db.execute(sql`
    WITH base AS MATERIALIZED (
      SELECT *,
             timezone(timezone, started_at)::date AS local_date,
             date_trunc('week', timezone(timezone, started_at))::date AS week_start
      FROM health_activities
      WHERE user_id = ${userId}::uuid
        AND archived_at IS NULL
        ${sinceFilter}
    ), included AS MATERIALIZED (
      SELECT * FROM base WHERE NOT exclude_from_analytics
    ), pace_ranked AS (
      SELECT activity_type, distance_km, average_pace_seconds_per_km,
             row_number() OVER (
               PARTITION BY activity_type ORDER BY started_at, id
             ) AS position,
             count(*) OVER (PARTITION BY activity_type) AS observations
      FROM included
      WHERE distance_km > 0 AND average_pace_seconds_per_km IS NOT NULL
    ), pace_halves AS (
      SELECT activity_type,
             count(*)::int AS observations,
             sum(distance_km * average_pace_seconds_per_km)
               FILTER (WHERE position <= floor(observations / 2.0)) /
               nullif(sum(distance_km)
                 FILTER (WHERE position <= floor(observations / 2.0)), 0)
               AS earlier_pace,
             sum(distance_km * average_pace_seconds_per_km)
               FILTER (WHERE position > floor(observations / 2.0)) /
               nullif(sum(distance_km)
                 FILTER (WHERE position > floor(observations / 2.0)), 0)
               AS latest_pace
      FROM pace_ranked
      GROUP BY activity_type
    ), type_rows AS (
      SELECT i.activity_type,
             count(*)::int AS activities,
             round(sum(i.duration_seconds) / 60.0)::int AS total_minutes,
             round(coalesce(sum(i.distance_km), 0)::numeric, 2)::float8 AS distance_km,
             sum(i.average_pace_seconds_per_km * i.distance_km)
               FILTER (WHERE i.distance_km > 0 AND i.average_pace_seconds_per_km IS NOT NULL) /
               nullif(sum(i.distance_km)
                 FILTER (WHERE i.distance_km > 0 AND i.average_pace_seconds_per_km IS NOT NULL), 0)
               AS average_pace,
             coalesce(ph.observations, 0)::int AS observations,
             ph.earlier_pace,
             ph.latest_pace
      FROM included i
      LEFT JOIN pace_halves ph ON ph.activity_type = i.activity_type
      GROUP BY i.activity_type, ph.observations, ph.earlier_pace, ph.latest_pace
    ), weekly_rows AS (
      SELECT week_start,
             count(*)::int AS activities,
             sum(duration_seconds)::int AS duration_seconds,
             coalesce(sum(distance_km), 0)::float8 AS distance_km
      FROM included
      WHERE week_start >= date_trunc('week', ${now}::timestamptz)::date - 77
      GROUP BY week_start
    ), recent_rows AS (
      SELECT * FROM included ORDER BY started_at DESC, id DESC LIMIT 5
    )
    SELECT
      (SELECT count(*)::int FROM included) AS total_activities,
      coalesce((SELECT sum(duration_seconds)::int FROM included), 0) AS total_seconds,
      coalesce((SELECT sum(distance_km)::float8 FROM included), 0) AS total_distance_km,
      (SELECT count(DISTINCT week_start)::int FROM included) AS active_weeks,
      (SELECT count(*)::int FROM base WHERE exclude_from_analytics) AS excluded_activities,
      (SELECT min(local_date)::text FROM included) AS earliest_local_date,
      (SELECT count(*)::int FROM included WHERE distance_km IS NOT NULL) AS coverage_distance,
      (SELECT count(*)::int FROM included WHERE average_pace_seconds_per_km IS NOT NULL) AS coverage_pace,
      (SELECT count(*)::int FROM included WHERE intensity IS NOT NULL) AS coverage_intensity,
      (SELECT count(*)::int FROM included WHERE elevation_gain_m IS NOT NULL) AS coverage_elevation,
      (SELECT count(*)::int FROM included WHERE average_heart_rate_bpm IS NOT NULL) AS coverage_heart_rate,
      (SELECT count(*)::int FROM included WHERE energy_kcal IS NOT NULL) AS coverage_energy,
      coalesce((SELECT jsonb_agg(to_jsonb(type_rows) ORDER BY total_minutes DESC, activities DESC)
        FROM type_rows), '[]'::jsonb) AS by_type,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
          'weekStart', week_start::text,
          'activities', activities,
          'durationSeconds', duration_seconds,
          'distanceKm', distance_km
        ) ORDER BY week_start) FROM weekly_rows), '[]'::jsonb) AS weekly,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
          'id', id,
          'activityType', activity_type,
          'title', title,
          'startedAtISO', to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'timezone', timezone,
          'durationSeconds', duration_seconds,
          'distanceKm', distance_km,
          'averagePaceSecondsPerKm', average_pace_seconds_per_km,
          'intensity', intensity,
          'elevationGainM', elevation_gain_m,
          'averageHeartRateBpm', average_heart_rate_bpm,
          'energyKcal', energy_kcal,
          'source', source
        ) ORDER BY started_at DESC, id DESC) FROM recent_rows), '[]'::jsonb) AS recent
  `);
  const row = resultRows(executed)[0];
  if (!row) throw new Error("Activity report query returned no result");

  const includedCount = Number(row.total_activities);
  const effectiveSince =
    since ??
    (row.earliest_local_date
      ? dateKeyToUtcDate(String(row.earliest_local_date))
      : now);
  const weeksInRange = Math.max(
    1,
    Math.ceil(Math.max(0, now.getTime() - effectiveSince.getTime()) / WEEK_MS)
  );
  const actualWeeks = new Map(
    (row.weekly as Array<{
      weekStart: string;
      activities: number;
      durationSeconds: number;
      distanceKm: number;
    }>).map((week) => [week.weekStart, week])
  );
  const weekly = [];
  const firstWeek = utcWeekStart(effectiveSince);
  const lastWeek = utcWeekStart(now);
  for (
    let cursor = firstWeek, guard = 0;
    cursor.getTime() <= lastWeek.getTime() && guard < 600;
    cursor = addUtcWeek(cursor), guard += 1
  ) {
    const key = cursor.toISOString().slice(0, 10);
    const values = actualWeeks.get(key);
    weekly.push({
      weekStartISO: `${key}T00:00:00.000Z`,
      activities: Number(values?.activities ?? 0),
      durationMinutes: Math.round(Number(values?.durationSeconds ?? 0) / 60),
      distanceKm: round(Number(values?.distanceKm ?? 0), 2),
    });
  }
  const latestFour = weekly.slice(-4);
  const previousFour = weekly.slice(-8, -4);
  const latestFourMinutes = latestFour.reduce(
    (total, week) => total + week.durationMinutes,
    0
  );
  const previousFourMinutes = previousFour.reduce(
    (total, week) => total + week.durationMinutes,
    0
  );
  const byType = (row.by_type as Array<Record<string, unknown>>).map((type) => {
    const earlier = type.earlier_pace == null ? null : Number(type.earlier_pace);
    const latest = type.latest_pace == null ? null : Number(type.latest_pace);
    const activityType = String(type.activity_type);
    return {
      activityType,
      label: activityTypeLabel(activityType),
      activities: Number(type.activities),
      totalMinutes: Number(type.total_minutes),
      distanceKm: Number(type.distance_km),
      averagePaceSecondsPerKm:
        type.average_pace == null ? null : round(Number(type.average_pace), 1),
      performanceChangePercent:
        earlier && latest
          ? activityUsesSpeed(activityType)
            ? round((earlier / latest - 1) * 100, 1)
            : round(((earlier - latest) / earlier) * 100, 1)
          : null,
      performanceObservationCount: Number(type.observations),
    };
  });
  const totalSeconds = Number(row.total_seconds);
  const recent = (row.recent as Array<Record<string, unknown>>).map((activity) => ({
    id: String(activity.id),
    activityType: String(activity.activityType),
    label: activityTypeLabel(String(activity.activityType)),
    title: activity.title == null ? null : String(activity.title),
    startedAtISO: String(activity.startedAtISO),
    timezone: String(activity.timezone),
    durationSeconds: Number(activity.durationSeconds),
    distanceKm: activity.distanceKm == null ? null : Number(activity.distanceKm),
    averagePaceSecondsPerKm:
      activity.averagePaceSecondsPerKm == null
        ? null
        : Number(activity.averagePaceSecondsPerKm),
    intensity: activity.intensity == null ? null : String(activity.intensity),
    elevationGainM:
      activity.elevationGainM == null ? null : Number(activity.elevationGainM),
    averageHeartRateBpm:
      activity.averageHeartRateBpm == null
        ? null
        : Number(activity.averageHeartRateBpm),
    energyKcal:
      activity.energyKcal == null ? null : Number(activity.energyKcal),
    source: String(activity.source),
  }));

  return {
    rule: ACTIVITY_ANALYTICS_RULE,
    overview: {
      totalActivities: includedCount,
      totalMinutes: Math.round(totalSeconds / 60),
      totalDistanceKm: round(Number(row.total_distance_km), 2),
      averageDurationMinutes: includedCount
        ? Math.round(totalSeconds / includedCount / 60)
        : null,
      activitiesPerWeek: round(includedCount / weeksInRange, 1),
      activeWeeks: Number(row.active_weeks),
      weeksInRange,
      consistencyPercent: Math.min(
        100,
        Math.round((Number(row.active_weeks) / weeksInRange) * 100)
      ),
      excludedActivities: Number(row.excluded_activities),
    },
    trend: {
      latestFourWeeksMinutes: latestFourMinutes,
      previousFourWeeksMinutes: previousFourMinutes,
      minuteChangePercent:
        previousFourMinutes > 0
          ? round(
              ((latestFourMinutes - previousFourMinutes) /
                previousFourMinutes) *
                100,
              1
            )
          : null,
    },
    measurementCoverage: {
      activities: includedCount,
      distance: Number(row.coverage_distance),
      pace: Number(row.coverage_pace),
      intensity: Number(row.coverage_intensity),
      elevation: Number(row.coverage_elevation),
      heartRate: Number(row.coverage_heart_rate),
      energy: Number(row.coverage_energy),
    },
    byType,
    weekly: weekly.slice(-12),
    recent,
  };
}
