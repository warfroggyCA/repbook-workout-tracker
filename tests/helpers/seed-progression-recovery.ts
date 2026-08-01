import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  programs,
  progressionJobs,
  programVersions,
  sessionExercises,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplates,
} from "@/db/schema";
import {
  completeWorkoutSession,
  startWorkoutSession,
} from "@/services/session-lifecycle";
import { logWorkoutSet } from "./log-workout-set";
import { loadEquipmentLoadProfiles } from "@/services/equipment-load-profiles";
import { mutateSessionEquipmentSelection } from "@/services/session-equipment-selection";

const ownerEmail = "owner@example.com";
const targetTemplateName = "Day A — Squat";

async function main() {
  if (!process.env.PGLITE_DIR || process.env.DATABASE_URL) {
    throw new Error(
      "Progression recovery fixtures require the disposable local PGlite harness."
    );
  }

  const db = await getDb();
  const [owner] = await db
    .select({
      userId: users.id,
      coachingPrefs: userProfiles.coachingPrefs,
    })
    .from(users)
    .innerJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.email, ownerEmail));
  if (!owner) {
    throw new Error("The progression recovery owner was not seeded.");
  }

  const [template] = await db
    .select({ id: workoutTemplates.id })
    .from(workoutTemplates)
    .innerJoin(
      programVersions,
      eq(programVersions.id, workoutTemplates.programVersionId)
    )
    .innerJoin(programs, eq(programs.id, programVersions.programId))
    .where(
      and(
        eq(programs.userId, owner.userId),
        eq(workoutTemplates.name, targetTemplateName)
      )
    );
  if (!template) {
    throw new Error("The progression recovery template was not seeded.");
  }

  const { sessionId } = await startWorkoutSession(
    db,
    owner.userId,
    template.id,
    45
  );
  const targetExercise = await db.query.sessionExercises.findFirst({
    where: and(
      eq(sessionExercises.sessionId, sessionId),
      eq(sessionExercises.orderIdx, 0)
    ),
  });
  if (
    !targetExercise ||
    !targetExercise.targetSets ||
    targetExercise.targetLoad == null ||
    targetExercise.targetLoadUnit == null ||
    targetExercise.targetRepsMax == null
  ) {
    throw new Error("The progression recovery exercise target is incomplete.");
  }

  const profiles = await loadEquipmentLoadProfiles(db, owner.userId);
  const olympicBar = profiles.find(
    (entry) =>
      entry.available &&
      entry.profile.kind === "plate_loaded_implement" &&
      entry.profile.loadingKind === "olympic",
  );
  if (!olympicBar) {
    throw new Error("The progression recovery Olympic-bar profile was not seeded.");
  }
  const selected = await mutateSessionEquipmentSelection(db, owner.userId, {
    operation: "select",
    sessionExerciseId: targetExercise.id,
    equipmentItemId: olympicBar.equipmentItemId,
    attachmentItemId: null,
    expectedCurrentSnapshotId: null,
    clientKey: crypto.randomUUID(),
    provenance: "auto_unique",
  });
  if (
    (selected.outcome !== "applied" &&
      selected.outcome !== "no_change" &&
      selected.outcome !== "replayed") ||
    !selected.snapshotId
  ) {
    throw new Error(
      `The progression recovery equipment selection failed (${selected.outcome}).`,
    );
  }

  for (let setNo = 1; setNo <= targetExercise.targetSets; setNo += 1) {
    const saved = await logWorkoutSet(db, owner.userId, {
      sessionExerciseId: targetExercise.id,
      setNo,
      weight: targetExercise.targetLoad,
      weightUnit: targetExercise.targetLoadUnit,
      reps: targetExercise.targetRepsMax,
      rpe: 7,
      clientKey: `progression-recovery-${setNo}`,
      equipmentSnapshotId: selected.snapshotId,
      loadEntryMeaning: "total_system",
    });
    if (saved.outcome !== "saved") {
      throw new Error(
        `The progression recovery set was not saved (${saved.outcome}).`
      );
    }
  }

  const completed = await completeWorkoutSession(
    db,
    {
      id: owner.userId,
      coachingPrefs: {
        ...owner.coachingPrefs,
        aggressiveness: "aggressive",
      },
    },
    { sessionId }
  );
  if (completed.alreadyFinished || !completed.progressionJobId) {
    throw new Error("The progression recovery job was not queued.");
  }

  const [job] = await db
    .update(progressionJobs)
    .set({ nextAttemptAt: new Date(0) })
    .where(
      and(
        eq(progressionJobs.id, completed.progressionJobId),
        eq(progressionJobs.sessionId, sessionId)
      )
    )
    .returning({ id: progressionJobs.id });
  if (!job) {
    throw new Error("The progression recovery job was not made ready.");
  }

  const [target] = await db
    .select({ sessionId: workoutSessions.id })
    .from(workoutSessions)
    .innerJoin(
      progressionJobs,
      eq(progressionJobs.sessionId, workoutSessions.id)
    )
    .where(eq(progressionJobs.id, job.id));
  if (!target) throw new Error("The progression recovery job is not durable.");

  const client = (db as { $client?: { close?: () => Promise<void> } }).$client;
  await client?.close?.();
  console.log(
    JSON.stringify({
      progressionJobId: job.id,
      sessionId: target.sessionId,
      templateName: targetTemplateName,
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
