"use server";

import { and, eq, isNull, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { healthActivities } from "@/db/schema";
import type { ActivityInput } from "@/lib/activities";
import { getCurrentUser } from "@/lib/user";
import { audit } from "@/services/audit";
import { normalizeActivityInput } from "@/services/activities";
import {
  archiveActivityRecord,
  archiveAllManualActivityRecords,
  type ArchiveActionResult,
} from "@/services/archive";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";
import { updateActivityWithVersion } from "@/services/record-versions";

export type ActivityActionResult =
  | { ok: true; id: string }
  | { ok: false; reason: string };

function friendlyActivityError(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Check the activity details.";
  }
  if (
    error instanceof Error &&
    error.message.includes("health_activities_manual_fingerprint_uq")
  ) {
    return "That activity is already recorded. Open the existing record to make changes.";
  }
  if (
    error instanceof Error &&
    [
      "Choose an activity date after 1900.",
      "Activities cannot be recorded in the future.",
    ].includes(error.message)
  ) {
    return error.message;
  }
  return "The activity could not be saved. Please check the details and try again.";
}

function revalidateActivityPages(id?: string) {
  revalidatePath("/history");
  revalidatePath("/today");
  revalidatePath("/export");
  if (id) revalidatePath(`/activity/${id}`);
}

export async function createActivity(
  input: ActivityInput
): Promise<ActivityActionResult> {
  try {
    const values = normalizeActivityInput(input);
    const user = await getCurrentUser();
    const db = await getDb();
    const duplicate = await db.query.healthActivities.findFirst({
      where: and(
        eq(healthActivities.userId, user.id),
        eq(healthActivities.source, "manual"),
        eq(healthActivities.fingerprint, values.fingerprint)
      ),
      columns: { id: true, archivedAt: true },
    });
    if (duplicate) {
      return {
        ok: false,
        reason: duplicate.archivedAt
          ? "That activity is already recorded in Archive. Restore it instead of creating a duplicate."
          : "That activity is already recorded. Open the existing record to make changes.",
      };
    }

    const [activity] = await db
      .insert(healthActivities)
      .values({ userId: user.id, ...values })
      .returning({ id: healthActivities.id });
    await audit(db, {
      userId: user.id,
      actorType: "user",
      action: "activity.create",
      entityType: "health_activity",
      entityId: activity.id,
      summary: `Recorded manual ${values.activityType} activity from ${values.startedAt.toISOString()}`,
    });
    revalidateActivityPages(activity.id);
    return { ok: true, id: activity.id };
  } catch (error) {
    return { ok: false, reason: friendlyActivityError(error) };
  }
}

export async function updateActivity(
  activityId: string,
  input: ActivityInput
): Promise<ActivityActionResult> {
  try {
    const id = z.string().uuid().parse(activityId);
    const values = normalizeActivityInput(input);
    const user = await getCurrentUser();
    const db = await getDb();
    const existing = await db.query.healthActivities.findFirst({
      where: and(
        eq(healthActivities.id, id),
        eq(healthActivities.userId, user.id),
        isNull(healthActivities.archivedAt)
      ),
      columns: { id: true, source: true },
    });
    if (!existing) return { ok: false, reason: "Activity not found." };
    if (existing.source !== "manual") {
      return {
        ok: false,
        reason: "Imported activities must be corrected through their import review.",
      };
    }

    const duplicate = await db.query.healthActivities.findFirst({
      where: and(
        eq(healthActivities.userId, user.id),
        eq(healthActivities.source, "manual"),
        eq(healthActivities.fingerprint, values.fingerprint),
        ne(healthActivities.id, id)
      ),
      columns: { id: true, archivedAt: true },
    });
    if (duplicate) {
      return {
        ok: false,
        reason: duplicate.archivedAt
          ? "Those details match an activity in Archive. Restore that record instead."
          : "Those details match another recorded activity.",
      };
    }

    const updated = await updateActivityWithVersion(db, user.id, id, values);
    if (!updated.ok) return updated;
    revalidateActivityPages(id);
    return { ok: true, id };
  } catch (error) {
    return { ok: false, reason: friendlyActivityError(error) };
  }
}

export async function archiveActivity(
  activityId: string
): Promise<
  | { ok: true; id: string; operationId: string }
  | { ok: false; reason: string }
> {
  try {
    const id = z.string().uuid().parse(activityId);
    const user = await getCurrentUser();
    const db = await getDb();
    const activity = await db.query.healthActivities.findFirst({
      where: and(
        eq(healthActivities.id, id),
        eq(healthActivities.userId, user.id),
        isNull(healthActivities.archivedAt)
      ),
    });
    if (!activity) return { ok: false, reason: "Activity not found." };
    if (activity.source !== "manual") {
      return {
        ok: false,
        reason: "Imported activities must be removed through their import record.",
      };
    }

    const archived = await archiveActivityRecord(db, user.id, id);
    if (!archived.ok) return archived;
    revalidateActivityPages(id);
    revalidatePath("/archive");
    return { ok: true, id, operationId: archived.operationId };
  } catch (error) {
    return { ok: false, reason: friendlyActivityError(error) };
  }
}

/**
 * Bulk archive of every active manual activity. The previewed count the user
 * confirmed is revalidated inside the atomic operation, and nothing is
 * archived unless a verified encrypted safety snapshot exists first.
 */
export async function resetActivityHistory(
  expectedActivities: number
): Promise<ArchiveActionResult> {
  const expected = z.number().int().positive().parse(expectedActivities);
  const user = await getCurrentUser();
  const db = await getDb();
  const safety = await createAutomaticSafetySnapshot(
    db,
    user.id,
    "pre_bulk_archive",
    `Automatic protection created before archiving all ${expected} manual activities.`
  );
  if (!safety.ok) {
    return {
      ok: false as const,
      reason: `Nothing was archived because the safety snapshot could not be verified: ${safety.reason}`,
    };
  }
  const result = await archiveAllManualActivityRecords(db, user.id, expected);
  if (result.ok) {
    revalidateActivityPages();
    revalidatePath("/archive");
    revalidatePath("/coach");
    revalidatePath("/recovery");
  }
  return result;
}
