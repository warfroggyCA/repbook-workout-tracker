import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { KG_TO_LB } from "@/lib/units";
import type { SetMetricExclusionReason } from "@/lib/set-metric-semantics";
import {
  eligibleTotalSystemLoadSql,
  setMetricExclusionReasonSql,
} from "@/lib/set-metric-semantics-sql";

export type WeeklyVolumePoint = { weekStartISO: string; volume: number };
export type RecentPR = {
  exercise: string;
  weight: number;
  reps: number;
  est1RM: number;
};

export type DashboardStats = {
  hasHistory: boolean;
  streakWeeks: number;
  workoutsThisWeek: number;
  /** Oldest → newest, always exactly 8 points ending with the current week. */
  weeklyVolume: WeeklyVolumePoint[];
  totalVolumeThisWeek: number;
  recentPRs: RecentPR[];
  semanticExclusions: Array<{
    reason: SetMetricExclusionReason;
    count: number;
  }>;
};

type DashboardRow = {
  has_history: boolean;
  streak_weeks: number | string;
  workouts_this_week: number | string;
  weekly_volume: Array<{ weekStartISO: string; volume: number }>;
  total_volume_this_week: number | string;
  recent_prs: Array<{
    exercise: string;
    weight: number;
    reps: number;
    est1RM: number;
  }>;
  semantic_exclusions: Array<{
    reason: SetMetricExclusionReason;
    count: number | string;
  }>;
};

/**
 * The Today screen always receives a fixed-size summary. PostgreSQL performs
 * the historical aggregation and returns one row: eight weeks, the current
 * streak, and at most three PRs from the latest completed workout.
 */
export async function getDashboardStats(
  db: Db,
  userId: string
): Promise<DashboardStats> {
  const setSemantics = {
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
  const rows = resultRows<DashboardRow>(
    await db.execute(sql`
      WITH profile AS (
        SELECT unit, timezone,
               date_trunc('week', timezone(timezone, current_timestamp))::date AS this_week
        FROM user_profiles
        WHERE user_id = ${userId}::uuid
      ), valid_sessions AS MATERIALIZED (
        SELECT ws.id, ws.local_date, ws.started_at,
               date_trunc('week', ws.local_date::timestamp)::date AS week_start
        FROM workout_sessions ws
        WHERE ws.user_id = ${userId}::uuid
          AND ws.status = 'completed'
          AND ws.archived_at IS NULL
      ), active_weeks AS (
        SELECT DISTINCT week_start FROM valid_sessions
      ), ranked_weeks AS (
        SELECT week_start,
               row_number() OVER (ORDER BY week_start DESC) AS position,
               max(week_start) OVER () AS newest_week
        FROM active_weeks
      ), streak AS (
        SELECT count(*)::int AS weeks
        FROM ranked_weeks
        WHERE week_start = newest_week - ((position - 1)::int * 7)
      ), semantic_exclusion_rows AS (
        SELECT evidence.reason, count(*)::int AS count
        FROM (
          SELECT ${setMetricExclusionReasonSql(setSemantics)} AS reason
          FROM valid_sessions vs
          JOIN session_exercises se ON se.session_id = vs.id
          JOIN exercises e ON e.id = se.exercise_id
          JOIN completed_sets cs ON cs.session_exercise_id = se.id
            AND cs.archived_at IS NULL
            AND NOT cs.is_warmup
          JOIN session_occurrences occurrence
            ON occurrence.completed_set_id = cs.id
           AND occurrence.session_exercise_id = se.id
           AND occurrence.kind = 'working_set'
           AND occurrence.outcome = 'completed'
        ) evidence
        WHERE evidence.reason IS NOT NULL
        GROUP BY evidence.reason
      ), recent_volume AS (
        SELECT vs.week_start,
               round(sum(
                 CASE
                   WHEN cs.is_warmup
                     OR NOT ${eligibleTotalSystemLoadSql(setSemantics)} THEN 0
                   WHEN cs.weight_unit = p.unit THEN cs.weight * cs.reps
                   WHEN cs.weight_unit = 'kg' AND p.unit = 'lb'
                     THEN cs.weight * ${KG_TO_LB} * cs.reps
                   WHEN cs.weight_unit = 'lb' AND p.unit = 'kg'
                     THEN cs.weight / ${KG_TO_LB} * cs.reps
                   ELSE 0
                 END
               ))::int AS volume
        FROM valid_sessions vs
        CROSS JOIN profile p
        JOIN session_exercises se ON se.session_id = vs.id
        JOIN exercises e ON e.id = se.exercise_id
        JOIN completed_sets cs ON cs.session_exercise_id = se.id
          AND cs.archived_at IS NULL
        JOIN session_occurrences occurrence
          ON occurrence.completed_set_id = cs.id
         AND occurrence.session_exercise_id = se.id
         AND occurrence.kind = 'working_set'
         AND occurrence.outcome = 'completed'
        WHERE vs.week_start >= p.this_week - 49
        GROUP BY vs.week_start
      ), volume_points AS (
        SELECT jsonb_agg(
          jsonb_build_object(
            'weekStartISO', to_char(weeks.week_start, 'YYYY-MM-DD') || 'T00:00:00.000Z',
            'volume', coalesce(rv.volume, 0)
          ) ORDER BY weeks.week_start
        ) AS points
        FROM profile p
        CROSS JOIN LATERAL generate_series(
          p.this_week - 49, p.this_week, interval '7 days'
        ) AS weeks(week_start)
        LEFT JOIN recent_volume rv ON rv.week_start = weeks.week_start
      ), latest_session AS (
        SELECT id
        FROM valid_sessions
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      ), latest_best AS (
        SELECT DISTINCT ON (se.exercise_id)
               se.exercise_id, e.name,
               round((CASE
                 WHEN cs.weight_unit = p.unit THEN cs.weight
                 WHEN cs.weight_unit = 'kg' AND p.unit = 'lb'
                   THEN cs.weight * ${KG_TO_LB}
                 ELSE cs.weight / ${KG_TO_LB}
               END)::numeric, 2)::float8 AS display_weight,
               cs.reps,
               (CASE
                 WHEN cs.weight_unit = p.unit THEN cs.weight
                 WHEN cs.weight_unit = 'kg' AND p.unit = 'lb'
                   THEN cs.weight * ${KG_TO_LB}
                 ELSE cs.weight / ${KG_TO_LB}
               -- Mirrors EST_ONE_RM_MAX_REPS in src/lib/one-rep-max.ts.
               END) * (1 + cs.reps / 30.0) AS estimate
        FROM latest_session ls
        JOIN session_exercises se ON se.session_id = ls.id
        JOIN exercises e ON e.id = se.exercise_id
        JOIN completed_sets cs ON cs.session_exercise_id = se.id
          AND cs.archived_at IS NULL
          AND NOT cs.is_warmup
          AND NOT cs.exclude_from_analytics
          AND cs.weight IS NOT NULL
          AND cs.weight_unit IS NOT NULL
          AND cs.reps IS NOT NULL
          AND cs.reps BETWEEN 1 AND 12 -- EST_ONE_RM_MAX_REPS
          AND ${eligibleTotalSystemLoadSql(setSemantics)}
        JOIN session_occurrences occurrence
          ON occurrence.completed_set_id = cs.id
         AND occurrence.session_exercise_id = se.id
         AND occurrence.kind = 'working_set'
         AND occurrence.outcome = 'completed'
        CROSS JOIN profile p
        ORDER BY se.exercise_id, estimate DESC, cs.set_no
      ), prior_best AS (
        SELECT se.exercise_id,
               max((CASE
                 WHEN cs.weight_unit = p.unit THEN cs.weight
                 WHEN cs.weight_unit = 'kg' AND p.unit = 'lb'
                   THEN cs.weight * ${KG_TO_LB}
                 ELSE cs.weight / ${KG_TO_LB}
               -- Mirrors EST_ONE_RM_MAX_REPS in src/lib/one-rep-max.ts.
               END) * (1 + cs.reps / 30.0)) AS estimate
        FROM latest_best lb
        JOIN session_exercises se ON se.exercise_id = lb.exercise_id
        JOIN exercises e ON e.id = se.exercise_id
        JOIN valid_sessions vs ON vs.id = se.session_id
        LEFT JOIN latest_session ls ON ls.id = vs.id
        JOIN completed_sets cs ON cs.session_exercise_id = se.id
          AND cs.archived_at IS NULL
          AND NOT cs.is_warmup
          AND NOT cs.exclude_from_analytics
          AND cs.weight IS NOT NULL
          AND cs.weight_unit IS NOT NULL
          AND cs.reps IS NOT NULL
          AND cs.reps BETWEEN 1 AND 12 -- EST_ONE_RM_MAX_REPS
          AND ${eligibleTotalSystemLoadSql(setSemantics)}
        JOIN session_occurrences occurrence
          ON occurrence.completed_set_id = cs.id
         AND occurrence.session_exercise_id = se.id
         AND occurrence.kind = 'working_set'
         AND occurrence.outcome = 'completed'
        CROSS JOIN profile p
        WHERE ls.id IS NULL
        GROUP BY se.exercise_id
      ), prs AS (
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'exercise', name,
            'weight', display_weight,
            'reps', reps,
            'est1RM', round(estimate)::int
          ) ORDER BY estimate DESC
        ), '[]'::jsonb) AS items
        FROM (
          SELECT lb.*
          FROM latest_best lb
          JOIN prior_best pb ON pb.exercise_id = lb.exercise_id
          WHERE lb.estimate > pb.estimate * 1.001
          ORDER BY lb.estimate DESC
          LIMIT 3
        ) new_records
      )
      SELECT
        EXISTS (SELECT 1 FROM valid_sessions) AS has_history,
        coalesce((SELECT weeks FROM streak), 0) AS streak_weeks,
        (SELECT count(*)::int FROM valid_sessions vs CROSS JOIN profile p
          WHERE vs.week_start = p.this_week) AS workouts_this_week,
        coalesce((SELECT points FROM volume_points), '[]'::jsonb) AS weekly_volume,
        coalesce((SELECT volume FROM recent_volume rv CROSS JOIN profile p
          WHERE rv.week_start = p.this_week), 0) AS total_volume_this_week,
        (SELECT items FROM prs) AS recent_prs,
        coalesce((SELECT jsonb_agg(to_jsonb(semantic_exclusion_rows)
          ORDER BY count DESC, reason) FROM semantic_exclusion_rows), '[]'::jsonb)
          AS semantic_exclusions
    `)
  );
  const row = rows[0];
  if (!row) throw new Error("Profile not found");

  return {
    hasHistory: row.has_history,
    streakWeeks: Number(row.streak_weeks),
    workoutsThisWeek: Number(row.workouts_this_week),
    weeklyVolume: row.weekly_volume.map((point) => ({
      weekStartISO: point.weekStartISO,
      volume: Number(point.volume),
    })),
    totalVolumeThisWeek: Number(row.total_volume_this_week),
    recentPRs: row.recent_prs.map((record) => ({
      exercise: record.exercise,
      weight: Number(record.weight),
      reps: Number(record.reps),
      est1RM: Number(record.est1RM),
    })),
    semanticExclusions: row.semantic_exclusions.map((entry) => ({
      reason: entry.reason,
      count: Number(entry.count),
    })),
  };
}
