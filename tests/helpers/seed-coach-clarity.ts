import { isDisposableVercelPreviewRuntime } from "@/lib/acceptance-runtime";
import { activateProgramAtomically } from "@/services/program-activation";
import { getDb } from "@/db";
import {
  users,
  userProfiles,
  exercises,
  workoutSessions,
  sessionExercises,
  sessionOccurrences,
  coachingInsights,
} from "@/db/schema";
import { workoutLocalDate } from "@/lib/workout-calendar";
async function main() {
  if (
    (!process.env.PGLITE_DIR || process.env.DATABASE_URL) &&
    !(
      isDisposableVercelPreviewRuntime() &&
      process.env.SEED_DISPOSABLE_PREVIEW === "1"
    )
  )
    throw new Error("Coach fixtures require disposable PGlite.");
  const db = await getDb();
  const [owner] = await db
    .insert(users)
    .values({ email: "coach-clarity.e2e@example.com", name: "Coach example" })
    .returning();
  await db
    .insert(userProfiles)
    .values({
      userId: owner.id,
      timezone: "America/Toronto",
      unit: "lb",
      setupCompletedAt: new Date(),
      fontSize: "extra-large",
    });
  const [exercise] = await db
    .insert(exercises)
    .values({
      name: "Coach example calf raises",
      movementPattern: "squat",
      primaryMuscles: ["calves"],
      loadType: "bodyweight",
      metricType: "reps",
      loadSemantics: "bodyweight",
    })
    .returning();
  const activated = await activateProgramAtomically(db, {
    userId: owner.id, loadUnit: "lb", programName: "Example training plan",
    days: [{ name: "Example leg workout", exercises: [{ exerciseId: exercise.id, sets: 1, repMin: 8, repMax: 12, targetLoad: null, restSec: 60, supersetKey: null, notes: null }] }],
    changeSummary: "Synthetic preview plan", auditAction: "program.activate", auditSummary: "Created synthetic preview plan",
  });
  if (!activated.ok) throw new Error(activated.reason);
  const slot = crypto.randomUUID();
  for (let i = 1; i <= 4; i++) {
    const date = new Date();
    date.setUTCHours(16, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - i);
    const [session] = await db
      .insert(workoutSessions)
      .values({
        userId: owner.id,
        templateName: "Example leg workout",
        status: "completed",
        startedAt: date,
        finishedAt: new Date(date.getTime() + 30 * 60_000),
        localDate: workoutLocalDate(date, "America/Toronto"),
        timezone: "America/Toronto",
        sourceProgramId: crypto.randomUUID(),
        sourceProgramVersionId: crypto.randomUUID(),
        sourceDayLineageId: crypto.randomUUID(),
      })
      .returning();
    const [row] = await db
      .insert(sessionExercises)
      .values({
        sessionId: session.id,
        exerciseId: exercise.id,
        modificationType: i === 2 ? "as_planned" : "skipped",
        sourceSlotLineageId: slot,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: exercise.name,
        prescribedMetricType: "reps",
        prescribedLoadType: "bodyweight",
        prescribedLoadSemantics: "bodyweight",
      })
      .returning();
    await db
      .insert(sessionOccurrences)
      .values({
        sessionId: session.id,
        sessionExerciseId: row.id,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exercise.id,
      });
  }
  await db
    .insert(coachingInsights)
    .values({
      userId: owner.id,
      kind: "manual_review",
      model: "synthetic",
      dataDigest: {},
      createdAt: new Date("2026-07-29T16:00:00Z"),
      contentMd: JSON.stringify({
        summary: "Synthetic older review for freshness verification.",
        overallTone: "neutral",
        highlights: [
          {
            title: "Older observation",
            detail: "This observation belongs to the older review.",
            tone: "neutral",
            evidence: [],
          },
        ],
        nextFocus: ["Review current records."],
        dataGaps: [],
      }),
    });
  // More than twelve newer questions must not displace the saved review.
  await db
    .insert(coachingInsights)
    .values(
      Array.from({ length: 13 }, (_, i) => ({
        userId: owner.id,
        kind: "qa" as const,
        model: "synthetic",
        dataDigest: { question: `Example earlier question ${i}` },
        contentMd: JSON.stringify({
          answer: "Example saved answer.",
          evidence: [],
          dataGaps: [],
          safetyNote: null,
        }),
      })),
    );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
