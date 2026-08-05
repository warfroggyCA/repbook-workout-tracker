import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  completedSets,
  painLogs,
  sessionExercises,
  sessionOccurrences,
} from "@/db/schema";
import { V2_H01_HISTORY_IDS as h01 } from "./v2-h01-history";
import { seedV2H01HistoryFixture } from "./seed-v2-h01-history";
import { V2_H04_PAIN_IDS as ids } from "./v2-h04-pain-consistency";

async function main() {
  await seedV2H01HistoryFixture();
  const db = await getDb();

  await db
    .update(completedSets)
    .set({
      techniqueIssue: "bracing",
      limitationCause: "strength_fatigue",
    })
    .where(eq(completedSets.id, h01.importedSet));

  await db.insert(painLogs).values([
    {
      id: ids.positivePain,
      userId: h01.user,
      sessionId: h01.importedSession,
      exerciseId: h01.performedExercise,
      completedSetId: h01.importedSet,
      bodyPart: "knee",
      severity: 4,
      source: "set_exception",
      note: "Pain at depth; retained separately from technique and limitation.",
      createdAt: new Date("2026-08-01T14:13:00.000Z"),
    },
    {
      id: ids.noIssuePain,
      userId: h01.user,
      sessionId: h01.finishedEarlySession,
      exerciseId: h01.performedExercise,
      bodyPart: "knee",
      severity: 0,
      source: "set_flag",
      note: "Explicitly checked after the workout.",
      createdAt: new Date("2026-08-02T14:21:00.000Z"),
    },
  ]);

  await db.insert(sessionExercises).values({
    id: ids.activeSessionExercise,
    sessionId: h01.activeSession,
    exerciseId: h01.performedExercise,
    prescribedSemanticsVersion: 1,
    prescribedExerciseName: "H01 Bodyweight Bulgarian Split Squat",
    prescribedMetricType: "reps",
    prescribedLoadType: "bodyweight",
    prescribedLoadSemantics: "bodyweight",
    orderIdx: 0,
    targetSets: 1,
    targetRepsMin: 8,
    targetRepsMax: 10,
  });
  await db.insert(sessionOccurrences).values({
    id: ids.activeOccurrence,
    sessionId: h01.activeSession,
    sessionExerciseId: ids.activeSessionExercise,
    kind: "working_set",
    origin: "planned",
    sequenceIdx: 0,
    kindOrdinal: 0,
    plannedExerciseId: h01.performedExercise,
    plannedRepsMin: 8,
    plannedRepsMax: 10,
    outcome: "pending",
  });

  console.log("Seeded Repbook v2 H04 pain-consistency browser fixture.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
