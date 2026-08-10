import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { exercises, painLogs, workoutSessions } from "@/db/schema";
import {
  classifyPainHold,
  type PainHoldClassification,
} from "@/engine/progression/pain-hold";
import { progressionConfig as cfg } from "@/engine/progression/config";

export async function loadExercisePainHold(
  db: Db,
  input: {
    userId: string;
    exerciseId: string;
    now?: Date;
  }
): Promise<PainHoldClassification> {
  const now = input.now ?? new Date();
  const windowStart = new Date(
    now.getTime() - cfg.painWindowDays * 24 * 60 * 60 * 1000
  );
  const [exercise, evidence] = await Promise.all([
    db.query.exercises.findFirst({
      where: eq(exercises.id, input.exerciseId),
      columns: { name: true },
    }),
    db
      .select({
        id: painLogs.id,
        sessionId: painLogs.sessionId,
        severity: painLogs.severity,
        createdAt: painLogs.createdAt,
      })
      .from(painLogs)
      .innerJoin(workoutSessions, eq(painLogs.sessionId, workoutSessions.id))
      .where(
        and(
          eq(painLogs.userId, input.userId),
          eq(painLogs.exerciseId, input.exerciseId),
          eq(workoutSessions.userId, input.userId),
          eq(workoutSessions.status, "completed"),
          isNull(workoutSessions.archivedAt),
          isNull(painLogs.archivedAt),
          gt(painLogs.severity, 0),
          lte(painLogs.severity, 10),
          sql`length(btrim(${painLogs.bodyPart})) BETWEEN 1 AND 50`,
          gt(painLogs.createdAt, windowStart)
        )
      )
      .orderBy(desc(painLogs.createdAt), desc(painLogs.id)),
  ]);

  return classifyPainHold({
    exerciseName: exercise?.name ?? "This exercise",
    now,
    evidence,
  });
}
