"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { userProfiles } from "@/db/schema";
import { FONT_SIZE_OPTIONS, type FontSizeKey } from "@/lib/font-size";
import {
  categorizeDiagnosticError,
  logDiagnosticEvent,
} from "@/lib/server-log";
import { getCurrentUser } from "@/lib/user";
import { audit } from "@/services/audit";
import { isValidIanaTimezone } from "@/lib/workout-calendar";
import { signOut } from "@/lib/auth";

export async function signOutCurrentUser() {
  await signOut({ redirectTo: "/sign-in" });
}

export async function saveTimezonePreference(
  input: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isValidIanaTimezone(input)) {
    return { ok: false, reason: "Choose a valid device timezone." };
  }
  try {
    const user = await getCurrentUser();
    const db = await getDb();
    await db.execute(sql`
      WITH updated AS (
        UPDATE user_profiles
        SET timezone = ${input}, updated_at = now()
        WHERE id = ${user.profile.id}::uuid
          AND user_id = ${user.id}::uuid
        RETURNING id
      ), audited AS (
        INSERT INTO audit_logs (
          user_id, actor_type, action, entity_type, entity_id, summary
        )
        SELECT
          ${user.id}::uuid, 'user', 'settings.timezone.update',
          'user_profile', id::text, ${`Changed workout timezone to ${input}`}
        FROM updated
      )
      SELECT id FROM updated
    `);
    revalidatePath("/settings");
    return { ok: true };
  } catch (error) {
    logDiagnosticEvent("settings.timezone_save_failed", {
      errorCategory: categorizeDiagnosticError(error, "persistence"),
    });
    return { ok: false, reason: "The timezone could not be saved. Try again." };
  }
}

const fontSizeSchema = z.enum(
  FONT_SIZE_OPTIONS.map((option) => option.key) as [
    FontSizeKey,
    ...FontSizeKey[],
  ]
);

export async function saveFontSizePreference(
  input: FontSizeKey
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = fontSizeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "Choose a valid app size." };
  }

  try {
    const user = await getCurrentUser();
    const db = await getDb();
    await db
      .update(userProfiles)
      .set({ fontSize: parsed.data, updatedAt: new Date() })
      .where(eq(userProfiles.id, user.profile.id));
    await audit(db, {
      userId: user.id,
      actorType: "user",
      action: "settings.font_size.update",
      entityType: "user_profile",
      entityId: user.profile.id,
      summary: `Changed app size to ${parsed.data}`,
    });
    return { ok: true };
  } catch (error) {
    logDiagnosticEvent("settings.font_size_save_failed", {
      errorCategory: categorizeDiagnosticError(error, "persistence"),
    });
    return {
      ok: false,
      reason: "The app size could not be saved to your profile. Try again.",
    };
  }
}
