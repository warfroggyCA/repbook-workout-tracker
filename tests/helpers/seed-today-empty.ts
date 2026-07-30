import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
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

export const TODAY_EMPTY_EMAIL = "today-empty.e2e@example.com";
export const HISTORY_CALENDAR_EMAIL = "history-calendar.e2e@example.com";
export const HISTORY_WORKSPACE_SPARSE_EMAIL =
  "history-workspace-sparse.e2e@example.com";

async function main() {
  if (!process.env.PGLITE_DIR || process.env.DATABASE_URL) {
    throw new Error(
      "The empty Today fixture requires the disposable local PGlite harness."
    );
  }

  const db = await getDb();
  for (const email of [
    TODAY_EMPTY_EMAIL,
    HISTORY_CALENDAR_EMAIL,
    HISTORY_WORKSPACE_SPARSE_EMAIL,
  ]) {
    const existing = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true },
    });
    if (existing) {
      throw new Error(`The ${email} fixture was already seeded.`);
    }
  }

  const exercise = await db.query.exercises.findFirst({
    where: eq(exercises.name, "Barbell Back Squat"),
    columns: { id: true },
  });
  if (!exercise) {
    throw new Error("The empty Today fixture exercise was not seeded.");
  }

  const localDb = db as Db & {
    transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  };
  const seedUser = (email: string, name: string) =>
    localDb.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email, name })
        .returning({ id: users.id });
      await tx.insert(userProfiles).values({
        userId: user.id,
        setupCompletedAt: new Date(),
        timezone: "America/Toronto",
      });
      const [program] = await tx
        .insert(programs)
        .values({
          userId: user.id,
          name: "Starter Program",
          status: "archived",
          archivedAt: new Date(),
        })
        .returning({ id: programs.id });
      const [version] = await tx
        .insert(programVersions)
        .values({ programId: program.id, name: "Starter Program" })
        .returning({ id: programVersions.id });
      const [template] = await tx
        .insert(workoutTemplates)
        .values({
          programVersionId: version.id,
          name: "Day One — Foundation",
          orderIdx: 0,
        })
        .returning({ id: workoutTemplates.id });
      const [slot] = await tx
        .insert(workoutTemplateExercises)
        .values({
          workoutTemplateId: template.id,
          exerciseId: exercise.id,
          orderIdx: 0,
          restSec: 120,
        })
        .returning({ id: workoutTemplateExercises.id });
      await tx.insert(exercisePrescriptions).values({
        templateExerciseId: slot.id,
        sets: 3,
        repRangeMin: 8,
        repRangeMax: 10,
        targetLoad: 45,
        targetLoadUnit: "lb",
      });
      await tx
        .update(programs)
        .set({
          status: "active",
          archivedAt: null,
          currentVersionId: version.id,
        })
        .where(eq(programs.id, program.id));
      return { userId: user.id, templateId: template.id };
    });
  const fixture = {
    todayEmpty: await seedUser(TODAY_EMPTY_EMAIL, "Empty Today"),
    historyCalendar: await seedUser(
      HISTORY_CALENDAR_EMAIL,
      "History Calendar",
    ),
    historyWorkspaceSparse: await seedUser(
      HISTORY_WORKSPACE_SPARSE_EMAIL,
      "History Workspace Sparse",
    ),
  };

  const client = (db as { $client?: { close?: () => Promise<void> } }).$client;
  await client?.close?.();
  console.log(JSON.stringify(fixture));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
