import { isAIAvailable } from "@/ai/provider";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { exerciseFamilies, historyImportBatches } from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import {
  getLatestStagedImport,
  getLibraryWithAvailability,
} from "@/services/routine-import";
import { RoutineImport } from "@/components/import/routine-import";
import { HevyHistoryImport } from "@/components/import/hevy-history-import";
import type { RoutineParseResponse } from "@/app/actions/import";
import { getLatestStagedHevyImport } from "@/services/hevy-import";
import { getImportBatchArchivePreview } from "@/services/archive";
import { getApprovedExerciseMedia } from "@/services/exercise-media";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function ImportPage() {
  const user = await getCurrentUser();
  const db = await getDb();

  // Resume a staged parse if one is waiting for review (plan §5: raw and
  // parsed data live on the ImportEvent until confirmed or discarded).
  const [staged, stagedHevy, library, families, batches] = await Promise.all([
    getLatestStagedImport(db, user.id),
    getLatestStagedHevyImport(db, user.id),
    getLibraryWithAvailability(db, user.id),
    db.query.exerciseFamilies.findMany({
      orderBy: asc(exerciseFamilies.name),
    }),
    db.query.historyImportBatches.findMany({
      where: and(
        eq(historyImportBatches.userId, user.id),
        eq(historyImportBatches.status, "confirmed"),
        isNull(historyImportBatches.archivedAt)
      ),
      orderBy: desc(historyImportBatches.confirmedAt),
    }),
  ]);
  const mediaByExercise = await getApprovedExerciseMedia(db, library);
  const routineLibrary = library.map((exercise) => ({
    ...exercise,
    media: mediaByExercise.get(exercise.id) ?? null,
  }));
  const initialParse: Extract<RoutineParseResponse, { ok: true }> | null = staged
    ? {
        ok: true,
        importEventId: staged.importEventId,
        envelope: staged.envelope,
        mappings: staged.mappings,
        library: routineLibrary,
      }
    : null;
  const batchPreviews = await Promise.all(
    batches.map((batch) => getImportBatchArchivePreview(db, user.id, batch.id))
  );
  return (
    <main className="flex flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-semibold">Import</h1>
        <p className="text-sm text-muted-foreground">
          Review everything before it changes your program or workout history.
        </p>
      </header>
      <HevyHistoryImport
        key={stagedHevy?.importEventId ?? "no-staged-hevy-import"}
        initialStage={stagedHevy}
        library={library}
        families={families.map((family) => ({
          id: family.id,
          name: family.name,
          movementPattern: family.movementPattern,
          primaryMuscles: family.primaryMuscles,
        }))}
        batches={batches.map((batch, index) => ({
          id: batch.id,
          filename: batch.originalFilename,
          confirmedAtISO: batch.confirmedAt.toISOString(),
          summary: batch.summary,
          archivePreview: batchPreviews[index],
        }))}
      />
      <section className="flex flex-col gap-3 rounded-xl border p-3">
        <header>
          <h2 className="font-medium">Routine from text</h2>
          <p className="text-xs text-muted-foreground">
            Paste → review every row → confirm. Nothing becomes your program until you confirm.
          </p>
        </header>
      <RoutineImport aiAvailable={isAIAvailable()} initialParse={initialParse} />
      </section>
    </main>
  );
}
