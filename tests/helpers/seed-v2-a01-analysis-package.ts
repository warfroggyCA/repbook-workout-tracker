import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  constraints,
  exercises,
  fatigueLogs,
  healthActivities,
  painLogs,
  userProfiles,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { createContextualNote } from "@/services/contextual-notes";
import { seedV2H01HistoryFixture } from "./seed-v2-h01-history";
import {
  V2_H01_HISTORY_EMAIL,
  V2_H01_HISTORY_IDS as ids,
} from "./v2-h01-history";

export async function seedV2A01AnalysisPackageFixture() {
  await seedV2H01HistoryFixture();
  const db = await getDb();

  await db
    .update(userProfiles)
    .set({
      goals: ["build strength", "train consistently"],
      experience: "intermediate",
      weeklyFrequency: 3,
      sessionLengthMin: 50,
    })
    .where(eq(userProfiles.userId, ids.user));
  await db.insert(constraints).values({
    id: "00000000-0000-4000-8000-000000000350",
    userId: ids.user,
    bodyPart: "knee",
    affectedPatterns: ["lunge"],
    cautious: true,
    painStopThreshold: 3,
    note: "Owner-recorded synthetic constraint",
  });
  await db.insert(exercises).values({
    id: "00000000-0000-4000-8000-000000000358",
    userId: ids.user,
    name: "A01 Owner-created Step-up",
    movementPattern: "lunge",
    primaryMuscles: ["quadriceps", "glutes"],
    loadType: "dumbbell",
    metricType: "weight_reps",
    loadSemantics: "per_implement",
  });

  const activation = await activateProgramAtomically(db, {
    userId: ids.user,
    loadUnit: "lb",
    programName: "A01 synthetic current Program",
    days: [
      {
        name: "Lower A",
        exercises: [
          {
            exerciseId: ids.plannedExercise,
            sets: 3,
            repMin: 8,
            repMax: 12,
            targetLoad: 40,
            restSec: 120,
            supersetKey: null,
            notes: "Current intent only",
          },
          {
            exerciseId: "00000000-0000-4000-8000-000000000358",
            sets: 2,
            repMin: 8,
            repMax: 10,
            targetLoad: null,
            restSec: 90,
            supersetKey: null,
            notes: "Owner-created identity scope fixture",
          },
        ],
      },
    ],
    changeSummary: "Synthetic A01 current Program",
    auditAction: "program.activate",
    auditSummary: "Synthetic A01 current Program",
    structuredIntentReviewed: true,
  });
  if (!activation.ok) throw new Error(activation.reason);

  await db.insert(healthActivities).values({
    id: "00000000-0000-4000-8000-000000000351",
    userId: ids.user,
    activityType: "walk",
    title: "Synthetic recovery walk",
    startedAt: new Date("2026-08-05T13:00:00.000Z"),
    timezone: "America/Toronto",
    durationSeconds: 2_400,
    distanceKm: 3.5,
    intensity: "easy",
    notes: "Independent context only",
    source: "manual",
    fingerprint: "a01-synthetic-recovery-walk",
  });
  await db.insert(painLogs).values({
    id: "00000000-0000-4000-8000-000000000352",
    userId: ids.user,
    sessionId: ids.importedSession,
    exerciseId: ids.performedExercise,
    completedSetId: ids.importedSet,
    bodyPart: "knee",
    severity: 2,
    source: "set_flag",
    note: "Synthetic retained pain evidence",
    createdAt: new Date("2026-08-01T14:13:00.000Z"),
  });
  await db.insert(fatigueLogs).values({
    id: "00000000-0000-4000-8000-000000000353",
    userId: ids.user,
    sessionId: ids.finishedEarlySession,
    severity: 3,
    note: "Synthetic retained fatigue evidence",
    createdAt: new Date("2026-08-02T14:21:00.000Z"),
  });
  for (const note of [
    {
      clientKey: "00000000-0000-4000-8000-000000000355",
      body: "Synthetic coach-visible analysis context",
      coachVisible: true,
      inputMode: "typed",
      attachmentKind: "general",
      capturedContext: {
        schemaVersion: 1,
        destination: "export",
        workflow: "A01 synthetic package",
        workoutPhase: null,
        originatedFromSimulation: false,
        programDay: null,
        plannedExercise: null,
        performedExercise: null,
        occurrence: null,
        loadRepetitions: null,
        restContext: null,
        reviewContext: null,
      },
      recordedAt: "2026-08-05T15:00:00.000Z",
    },
    {
      clientKey: "00000000-0000-4000-8000-000000000357",
      body: "SYNTHETIC PRIVATE NOTE MUST NOT LEAVE REPBOOK",
      coachVisible: false,
      inputMode: "typed",
      attachmentKind: "general",
      capturedContext: {
        schemaVersion: 1,
        destination: "export",
        workflow: "A01 private omission check",
        workoutPhase: null,
        originatedFromSimulation: false,
        programDay: null,
        plannedExercise: null,
        performedExercise: null,
        occurrence: null,
        loadRepetitions: null,
        restContext: null,
        reviewContext: null,
      },
      recordedAt: "2026-08-05T15:05:00.000Z",
    },
  ] as const) {
    const saved = await createContextualNote(db, ids.user, note);
    if (saved.outcome !== "saved") {
      throw new Error(`A01 contextual note seed failed: ${saved.outcome}`);
    }
  }

  console.log(`Seeded A01 analysis package fixture for ${V2_H01_HISTORY_EMAIL}.`);
}

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void seedV2A01AnalysisPackageFixture().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
