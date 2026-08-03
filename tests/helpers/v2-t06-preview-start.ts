import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import {
  exercisePrescriptions,
  exercises,
  programs,
  programVersions,
  userProfiles,
  users,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";

export async function seedT06PreviewStart(db: Db) {
  const [{ id: userId }] = await db
    .insert(users)
    .values({ email: `t06-portable-${crypto.randomUUID()}@example.com` })
    .returning({ id: users.id });
  await db.insert(userProfiles).values({ userId, timezone: "America/Toronto" });
  const [exercise] = await db
    .insert(exercises)
    .values({
      name: `T06 portable press ${crypto.randomUUID()}`,
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "dumbbell",
      metricType: "weight_reps",
      loadSemantics: "per_implement",
    })
    .returning({ id: exercises.id, name: exercises.name });
  let programId = "";
  let templateId = "";
  let slotId = "";
  await db.transaction(async (tx) => {
    const [program] = await tx
      .insert(programs)
      .values({
        userId,
        name: "T06 portable Program",
        status: "archived",
        archivedAt: new Date(),
      })
      .returning({ id: programs.id });
    programId = program.id;
    const [version] = await tx
      .insert(programVersions)
      .values({ programId, activatedAt: new Date() })
      .returning({ id: programVersions.id });
    const [template] = await tx
      .insert(workoutTemplates)
      .values({ programVersionId: version.id, name: "T06 portable day" })
      .returning({ id: workoutTemplates.id });
    templateId = template.id;
    const [slot] = await tx
      .insert(workoutTemplateExercises)
      .values({ workoutTemplateId: templateId, exerciseId: exercise.id, orderIdx: 0 })
      .returning({ id: workoutTemplateExercises.id });
    slotId = slot.id;
    await tx.insert(exercisePrescriptions).values({
      templateExerciseId: slotId,
      sets: 1,
      repRangeMin: 8,
      repRangeMax: 10,
      targetLoad: 30,
      targetLoadUnit: "lb",
    });
    await tx
      .update(programs)
      .set({ status: "active", archivedAt: null, currentVersionId: version.id })
      .where(eq(programs.id, programId));
  });
  return {
    userId,
    programId,
    templateId,
    slotId,
    exerciseId: exercise.id,
    exerciseName: exercise.name,
  };
}
