import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { addLocalDays, workoutLocalDate } from "@/lib/workout-calendar";
import { buildHistoryPatterns } from "@/lib/history-patterns";

export async function getHistoryPatterns(
  db: Db,
  userId: string,
  timezone: string,
  now = new Date(),
) {
  const today = workoutLocalDate(now, timezone);
  const since = addLocalDays(today, -83);
  const rows = resultRows(
    await db.execute(sql`
    SELECT s.id AS session_id, s.local_date::text, s.template_name,
      se.source_slot_lineage_id::text AS slot_id,
      min(o.planned_exercise_id::text) AS exercise_id,
      se.prescribed_exercise_name AS exercise_name,
      se.modification_type = 'skipped' AS skipped
    FROM workout_sessions s
    JOIN session_exercises se ON se.session_id = s.id
    JOIN session_occurrences o ON o.session_id = s.id AND o.session_exercise_id = se.id
      AND o.kind = 'working_set' AND o.origin = 'planned'
    WHERE s.user_id = ${userId}::uuid AND s.status = 'completed'
      AND s.archived_at IS NULL AND s.source_program_version_id IS NOT NULL
      AND s.local_date >= ${since}::date AND s.local_date <= ${today}::date
      AND se.source_slot_lineage_id IS NOT NULL
      AND se.prescribed_semantics_version = 1
      AND nullif(btrim(se.prescribed_exercise_name), '') IS NOT NULL
      AND se.modification_type IN ('as_planned', 'skipped', 'substituted')
    GROUP BY s.id, s.local_date, s.template_name, se.id
    HAVING count(DISTINCT o.planned_exercise_id) = 1
  `),
  );
  return buildHistoryPatterns(
    rows.map((row) => ({
      sessionId: String(row.session_id),
      localDate: String(row.local_date),
      workoutName: String(row.template_name ?? "Workout"),
      slotId: String(row.slot_id),
      exerciseId: String(row.exercise_id),
      exerciseName: String(row.exercise_name),
      skipped: row.skipped === true,
    })),
  );
}
