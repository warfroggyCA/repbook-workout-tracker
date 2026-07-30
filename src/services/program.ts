import { and, eq, isNull, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import {
  programs,
  workoutTemplates,
  workoutTemplateExercises,
  exercisePrescriptions,
} from "@/db/schema";

export async function getActiveProgramVersion(db: Db, userId: string) {
  const row = await db.query.programs.findFirst({
    where: and(
      eq(programs.userId, userId),
      eq(programs.status, "active"),
      isNull(programs.archivedAt)
    ),
    with: { currentVersion: true },
  });
  if (
    !row?.currentVersionId ||
    !row.currentVersion ||
    row.currentVersion.id !== row.currentVersionId ||
    row.currentVersion.programId !== row.id
  ) {
    return null;
  }
  const { currentVersion: version, ...program } = row;
  return { program, version };
}

/** Template by id, only when it belongs to the user's current active version. */
export async function getOwnedTemplate(
  db: Db,
  templateId: string,
  userId: string
) {
  const template = await db.query.workoutTemplates.findFirst({
    where: eq(workoutTemplates.id, templateId),
    with: { programVersion: { with: { program: true } } },
  });
  if (
    !template ||
    template.programVersion.program.userId !== userId ||
    template.programVersion.program.status !== "active" ||
    template.programVersion.program.archivedAt != null ||
    template.programVersion.program.currentVersionId !==
      template.programVersion.id
  ) {
    return null;
  }
  return template;
}

/** Slot by id, only when it belongs to the user's current active version. */
export async function getOwnedTemplateExercise(
  db: Db,
  templateExerciseId: string,
  userId: string
) {
  const slot = await db.query.workoutTemplateExercises.findFirst({
    where: eq(workoutTemplateExercises.id, templateExerciseId),
    with: {
      exercise: true,
      template: { with: { programVersion: { with: { program: true } } } },
    },
  });
  if (
    !slot ||
    slot.template.programVersion.program.userId !== userId ||
    slot.template.programVersion.program.status !== "active" ||
    slot.template.programVersion.program.archivedAt != null ||
    slot.template.programVersion.program.currentVersionId !==
      slot.template.programVersion.id
  ) {
    return null;
  }
  return slot;
}

export type TemplateWithSlots = {
  template: typeof workoutTemplates.$inferSelect;
  slots: Array<{
    slot: typeof workoutTemplateExercises.$inferSelect;
    exercise: {
      id: string;
      name: string;
      family: string | null;
      movementPattern: string;
      primaryMuscles: string[];
      loadType: string;
    };
    prescription: typeof exercisePrescriptions.$inferSelect | null;
  }>;
};

/** Templates of a program version with their active prescriptions. */
export async function getTemplatesWithSlots(
  db: Db,
  programVersionId: string
): Promise<TemplateWithSlots[]> {
  const templates = await db.query.workoutTemplates.findMany({
    where: eq(workoutTemplates.programVersionId, programVersionId),
    orderBy: workoutTemplates.orderIdx,
    with: {
      exercises: {
        orderBy: workoutTemplateExercises.orderIdx,
        with: { exercise: { with: { family: true } } },
      },
    },
  });

  const slotIds = templates.flatMap((t) => t.exercises.map((e) => e.id));
  const activePrescriptions = slotIds.length
    ? await db.query.exercisePrescriptions.findMany({
        where: and(
          inArray(exercisePrescriptions.templateExerciseId, slotIds),
          isNull(exercisePrescriptions.supersededById)
        ),
      })
    : [];
  const prescriptionBySlot = new Map(
    activePrescriptions.map((p) => [p.templateExerciseId, p])
  );

  return templates.map((t) => ({
    template: t,
    slots: t.exercises.map((e) => ({
      slot: e,
      exercise: {
        id: e.exercise.id,
        name: e.exercise.name,
        family: e.exercise.family?.name ?? null,
        movementPattern: e.exercise.movementPattern,
        primaryMuscles: e.exercise.primaryMuscles,
        loadType: e.exercise.loadType,
      },
      prescription: prescriptionBySlot.get(e.id) ?? null,
    })),
  }));
}
