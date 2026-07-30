import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import {
  sessionExercises,
  workoutSessions,
} from "@/db/schema";
import {
  exerciseDiscoveryItemFromLibrary,
  type ExerciseDiscoveryItem,
} from "@/lib/exercise-discovery";
import { getLibraryWithAvailability } from "@/services/routine-import";
import {
  getActiveProgramVersion,
  getTemplatesWithSlots,
} from "@/services/program";
import { getApprovedExerciseMedia } from "@/services/exercise-media";

/**
 * Complete user-visible catalog plus server-calculated availability and usage
 * signals. Rights/provenance records are deliberately never selected here.
 */
export async function getExerciseDiscoveryLibrary(
  db: Db,
  userId: string
): Promise<ExerciseDiscoveryItem[]> {
  const activeProgram = await getActiveProgramVersion(db, userId);
  const [library, currentTemplates, usageRows] = await Promise.all([
    getLibraryWithAvailability(db, userId),
    activeProgram
      ? getTemplatesWithSlots(db, activeProgram.version.id)
      : Promise.resolve([]),
    db
      .select({
        exerciseId: sessionExercises.exerciseId,
        startedAt: workoutSessions.startedAt,
      })
      .from(sessionExercises)
      .innerJoin(
        workoutSessions,
        eq(sessionExercises.sessionId, workoutSessions.id)
      )
      .where(
        and(
          eq(workoutSessions.userId, userId),
          eq(workoutSessions.status, "completed"),
          isNull(workoutSessions.archivedAt)
        )
      )
      .orderBy(desc(workoutSessions.startedAt)),
  ]);

  const currentProgramIds = new Set(
    currentTemplates.flatMap((template) =>
      template.slots.map(({ exercise }) => exercise.id)
    )
  );
  const useCount = new Map<string, number>();
  const recentRank = new Map<string, number>();
  for (const row of usageRows) {
    useCount.set(row.exerciseId, (useCount.get(row.exerciseId) ?? 0) + 1);
    if (recentRank.size < 12 && !recentRank.has(row.exerciseId)) {
      recentRank.set(row.exerciseId, recentRank.size);
    }
  }
  const frequentlyUsedIds = new Set(
    [...useCount.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([exerciseId]) => exerciseId)
  );
  const mediaByExercise = await getApprovedExerciseMedia(db, library);

  return library.map((exercise) =>
    exerciseDiscoveryItemFromLibrary({
      ...exercise,
      missingEquipment: exercise.missing,
      constraintBlocked: exercise.constraintBlocked,
    }, {
      inCurrentProgram: currentProgramIds.has(exercise.id),
      recentRank: recentRank.get(exercise.id) ?? null,
      useCount: useCount.get(exercise.id) ?? 0,
      frequentlyUsed: frequentlyUsedIds.has(exercise.id),
      media: mediaByExercise.get(exercise.id) ?? null,
    })
  );
}
