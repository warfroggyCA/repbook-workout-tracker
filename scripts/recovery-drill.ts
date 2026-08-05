import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { buildTrainingDigest } from "@/services/digest";
import { buildJsonBackup } from "@/services/export";
import {
  getHistoryCalendarRecords,
  getHistoryReport,
} from "@/services/history-report";
import {
  captureUserSnapshot,
  snapshotRecordCounts,
} from "@/services/snapshot-capture";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";

function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

function expectedCounts() {
  const raw = process.env.DRILL_EXPECTED_COUNTS;
  if (!raw) return null;
  return JSON.parse(raw) as Record<string, number>;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must point to an isolated restored database.");
  }
  const db = await getDb();
  const owners = await db.query.users.findMany({
    columns: { id: true },
    limit: 2,
  });
  if (owners.length !== 1) {
    throw new Error(`Expected exactly one owner, found ${owners.length}.`);
  }
  const userId = owners[0].id;
  const [countsRow] = resultRows(
    await db.execute(sql`
      WITH user_sessions AS (
        SELECT * FROM workout_sessions WHERE user_id = ${userId}::uuid
      ), user_exercises AS (
        SELECT se.* FROM session_exercises se
        JOIN user_sessions ws ON ws.id = se.session_id
      )
      SELECT
        (SELECT count(*)::int FROM user_sessions) AS workouts,
        (SELECT count(*)::int FROM user_exercises) AS exercise_occurrences,
        (SELECT count(*)::int FROM completed_sets cs JOIN user_exercises se ON se.id = cs.session_exercise_id) AS sets,
        (SELECT count(*)::int FROM completed_sets cs JOIN user_exercises se ON se.id = cs.session_exercise_id WHERE cs.is_warmup) AS warmup_sets,
        (SELECT count(*)::int FROM health_activities WHERE user_id = ${userId}::uuid) AS activities,
        (SELECT count(*)::int FROM programs WHERE user_id = ${userId}::uuid) AS programs,
        (SELECT count(*)::int FROM history_import_batches WHERE user_id = ${userId}::uuid) AS imports,
        (SELECT count(*)::int FROM data_snapshots WHERE user_id = ${userId}::uuid) AS app_snapshots,
        (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations
    `)
  );
  const counts = Object.fromEntries(
    Object.entries(countsRow).map(([key, value]) => [key, Number(value)])
  ) as Record<string, number>;
  const now = new Date();
  const since = new Date("2000-01-01T00:00:00.000Z");
  const [report, calendar, digest, backup, snapshot, findings] = await Promise.all([
    getHistoryReport(db, userId, "all", 3, now),
    getHistoryCalendarRecords(db, userId),
    buildTrainingDigest(db, userId, since, now),
    buildJsonBackup(db, userId),
    captureUserSnapshot(db, userId, now, "recovery-drill"),
    evaluateApplicationIntegrity(db, userId),
  ]);
  const snapshotCounts = snapshotRecordCounts(snapshot) as Record<string, number>;
  const calendarWorkouts = calendar.filter(
    (record) => record.recordType === "workout"
  ).length;
  const failures: string[] = [];
  const expected = expectedCounts();
  if (expected) {
    for (const [key, value] of Object.entries(expected)) {
      if (counts[key] !== value) {
        failures.push(`Expected ${key}=${value}, received ${counts[key]}.`);
      }
    }
  }
  if (report.overview.completedSessions !== counts.workouts) {
    failures.push("History report workout count differs from restored rows.");
  }
  if (calendarWorkouts !== counts.workouts) {
    failures.push("History calendar workout count differs from restored rows.");
  }
  if (digest.cadence.completedSessions !== counts.workouts) {
    failures.push("Coach digest workout count differs from restored rows.");
  }
  if (backup.canonical.tables.workout_sessions.length !== counts.workouts) {
    failures.push("Complete JSON backup workout count differs from restored rows.");
  }
  if (snapshotCounts.workout_sessions !== counts.workouts) {
    failures.push("Canonical snapshot workout count differs from restored rows.");
  }
  if (snapshotCounts.completed_sets !== counts.sets) {
    failures.push("Canonical snapshot set count differs from restored rows.");
  }
  const errors = findings.filter((finding) => finding.severity === "error");
  const output = {
    passed: failures.length === 0 && errors.length === 0,
    counts,
    applicationViews: {
      historySessions: report.overview.completedSessions,
      calendarWorkouts,
      coachSessions: digest.cadence.completedSessions,
      backupSessions: backup.canonical.tables.workout_sessions.length,
      snapshotRecords: snapshotCounts.total,
    },
    integrity: {
      errors: errors.length,
      warnings: findings.length - errors.length,
      findings: findings.map((finding) => ({
        checkKey: finding.checkKey,
        severity: finding.severity,
        message: finding.message,
      })),
    },
    failures,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.passed) process.exitCode = 1;
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
