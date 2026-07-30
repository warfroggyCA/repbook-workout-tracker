"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { importEvents } from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import {
  confirmHevyImportSchema,
  persistHevyImport,
  type ConfirmHevyImportInput,
} from "@/services/hevy-import-persist";
import {
  archiveImportBatchRecord,
  type ImportBatchArchivePreview,
} from "@/services/archive";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";
import { runExpensiveOperation } from "@/services/expensive-operations";

function refreshImportedHistory() {
  revalidatePath("/program/import");
  revalidatePath("/history");
  revalidatePath("/coach");
  revalidatePath("/export");
  revalidatePath("/today");
}

export async function confirmHevyHistoryImport(input: ConfirmHevyImportInput) {
  const parsed = confirmHevyImportSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const controlled = await runExpensiveOperation(
    db,
    user.id,
    "import",
    async () => {
      const staged = await db.query.importEvents.findFirst({
        columns: { id: true },
        where: and(
          eq(importEvents.id, parsed.importEventId),
          eq(importEvents.userId, user.id),
          eq(importEvents.source, "csv"),
          eq(importEvents.status, "parsed")
        ),
      });
      if (!staged) {
        return {
          ok: false as const,
          reason: "This staged Hevy import is no longer waiting for confirmation.",
        };
      }
      const safety = await createAutomaticSafetySnapshot(
        db,
        user.id,
        "pre_import",
        "Automatic protection created before confirming a Hevy history import."
      );
      if (!safety.ok) {
        return {
          ok: false as const,
          reason: `Import did not start because its safety snapshot could not be verified: ${safety.reason}`,
        };
      }
      return persistHevyImport(db, user, parsed);
    }
  );
  if (!controlled.ok) {
    return { ok: false as const, reason: controlled.reason };
  }
  const result = controlled.value;
  if (!result.ok) return result;
  refreshImportedHistory();
  return result;
}

export async function discardHevyHistoryImport(importEventId: string) {
  const id = z.string().uuid().parse(importEventId);
  const user = await getCurrentUser();
  const db = await getDb();
  const [event] = await db
    .update(importEvents)
    // Drop the raw CSV as well — a discarded stage is never re-parsed.
    .set({
      status: "discarded",
      rawPayload: "",
      parsedPayload: null,
      rawRedactedAt: new Date(),
      retentionExpiresAt: null,
    })
    .where(
      and(
        eq(importEvents.id, id),
        eq(importEvents.userId, user.id),
        eq(importEvents.source, "csv"),
        eq(importEvents.status, "parsed")
      )
    )
    .returning({ id: importEvents.id });
  if (!event) return { ok: false as const, reason: "Staged Hevy import not found." };
  revalidatePath("/program/import");
  return { ok: true as const };
}

const archivePreviewSchema = z.object({
  importBatches: z.number().int().nonnegative(),
  importFiles: z.number().int().nonnegative(),
  workouts: z.number().int().nonnegative(),
  previouslyArchivedWorkouts: z.number().int().nonnegative(),
  sessionExerciseGroups: z.number().int().nonnegative(),
  exerciseOccurrences: z.number().int().nonnegative(),
  sessionOccurrences: z.number().int().nonnegative(),
  sessionOccurrenceMutations: z.number().int().nonnegative(),
  sets: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  contextualNotes: z.number().int().nonnegative(),
  painLogs: z.number().int().nonnegative(),
  fatigueLogs: z.number().int().nonnegative(),
  coachingMessages: z.number().int().nonnegative(),
  recommendations: z.number().int().nonnegative(),
  progressionJobs: z.number().int().nonnegative(),
  progressionJobInputSessions: z.number().int().nonnegative(),
  recordVersions: z.number().int().nonnegative(),
  reviewedMappings: z.number().int().nonnegative(),
  reviewDecisions: z.number().int().nonnegative(),
  customExercises: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
});

export async function removeHevyHistoryImport(
  batchId: string,
  expectedPreview: ImportBatchArchivePreview
) {
  const id = z.string().uuid().parse(batchId);
  const expected = archivePreviewSchema.parse(expectedPreview);
  const user = await getCurrentUser();
  const db = await getDb();
  const safety = await createAutomaticSafetySnapshot(
    db,
    user.id,
    "pre_import_archive",
    `Automatic protection created before archiving Hevy import batch ${id}.`
  );
  if (!safety.ok) {
    return {
      ok: false as const,
      reason: `Nothing was archived because the safety snapshot could not be verified: ${safety.reason}`,
    };
  }
  const result = await archiveImportBatchRecord(db, user.id, id, expected);
  if (result.ok) refreshImportedHistory();
  revalidatePath("/archive");
  revalidatePath("/recovery");
  return result;
}
