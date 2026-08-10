"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { resultRows } from "@/db/result";
import { recordVersions } from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import {
  categorizeDiagnosticError,
  logDiagnosticEvent,
} from "@/lib/server-log";
import {
  restoreRecordVersion,
} from "@/services/record-versions";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";

export async function restoreEarlierVersion(
  versionId: string,
  clientMutationId: string,
) {
  const id = z.string().uuid().parse(versionId);
  const mutationId = z.string().uuid().parse(clientMutationId);
  const user = await getCurrentUser();
  const db = await getDb();
  const version = await db.query.recordVersions.findFirst({
    where: and(
      eq(recordVersions.id, id),
      eq(recordVersions.userId, user.id)
    ),
    columns: { id: true, entityType: true, entityId: true },
  });
  if (!version) return { ok: false as const, reason: "Version not found." };
  const replay = await db.query.recordVersions.findFirst({
    where: eq(recordVersions.id, mutationId),
    columns: {
      id: true,
      userId: true,
      entityType: true,
      entityId: true,
      action: true,
      sourceVersionId: true,
    },
  });
  if (replay) {
    if (
      replay.userId === user.id &&
      replay.entityType === version.entityType &&
      replay.entityId === version.entityId &&
      replay.action === `${
        version.entityType === "completed_set"
          ? "set"
          : version.entityType === "workout_session"
            ? "workout_session"
          : version.entityType === "health_activity"
            ? "activity"
            : "session_exercise"
      }.version_restore` &&
      replay.sourceVersionId === version.id
    ) {
      return {
        ok: true as const,
        id: replay.entityId,
        changed: false,
        versionId: replay.id,
      };
    }
    return {
      ok: false as const,
      reason: "That restore identity already belongs to a different operation.",
    };
  }
  const [historyRevision] = version.entityType === "completed_set"
    ? resultRows(await db.execute(sql`
        SELECT session.history_revision
        FROM completed_sets completed_set
        JOIN session_exercises exercise
          ON exercise.id = completed_set.session_exercise_id
        JOIN workout_sessions session ON session.id = exercise.session_id
        WHERE completed_set.id = ${version.entityId}::uuid
          AND session.user_id = ${user.id}::uuid
          AND session.archived_at IS NULL
      `))
    : version.entityType === "workout_session"
      ? resultRows(await db.execute(sql`
          SELECT session.history_revision
          FROM workout_sessions session
          WHERE session.id = ${version.entityId}::uuid
            AND session.user_id = ${user.id}::uuid
            AND session.status = 'completed'
            AND session.archived_at IS NULL
        `))
    : [];

  const safety = await createAutomaticSafetySnapshot(
    db,
    user.id,
    "pre_version_restore",
    `Automatic protection created before restoring ${version.entityType} ${version.entityId} from version ${version.id}.`
  );
  if (!safety.ok) {
    return {
      ok: false as const,
      reason: `Nothing was restored because the safety snapshot could not be verified: ${safety.reason}`,
    };
  }

  try {
    const result = await restoreRecordVersion(db, user.id, id, {
      clientMutationId: mutationId,
      activeOnly: version.entityType === "session_exercise",
      expectedHistoryRevision: historyRevision == null
        ? undefined
        : Number(historyRevision.history_revision),
    });
    if (!result.ok) return result;
    revalidatePath("/recovery");
    revalidatePath("/recovery/versions");
    revalidatePath("/history");
    revalidatePath("/today");
    revalidatePath("/coach");
    revalidatePath("/export");
    revalidatePath("/program");
    return result;
  } catch (error) {
    logDiagnosticEvent("record_version.restore_failed", {
      errorCategory: categorizeDiagnosticError(error, "conflict"),
    });
    return {
      ok: false as const,
      reason: "Nothing was restored because the record changed unexpectedly. Its safety snapshot remains available.",
    };
  }
}
