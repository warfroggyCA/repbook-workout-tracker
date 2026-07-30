"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import {
  archiveAIHistory,
  type AIHistoryArchivePreview,
} from "@/services/ai-privacy";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";

const previewSchema = z
  .object({
    coachingInsights: z.number().int().nonnegative(),
    parsingInputs: z.number().int().nonnegative(),
  })
  .refine((value) => value.coachingInsights + value.parsingInputs > 0);

export async function archiveAIHistoryAction(
  expectedPreview: AIHistoryArchivePreview
) {
  const expected = previewSchema.parse(expectedPreview);
  const user = await getCurrentUser();
  const db = await getDb();
  const safety = await createAutomaticSafetySnapshot(
    db,
    user.id,
    "pre_ai_history_archive",
    `Automatic protection created before archiving ${expected.coachingInsights} Coach records and clearing ${expected.parsingInputs} retained AI inputs.`
  );
  if (!safety.ok) {
    return {
      ok: false as const,
      reason: `Nothing was changed because the safety snapshot could not be verified: ${safety.reason}`,
    };
  }
  const result = await archiveAIHistory(db, user.id, expected);
  if (result.ok) {
    for (const path of [
      "/settings",
      "/archive",
      "/coach",
      "/today",
      "/export",
      "/recovery",
    ]) {
      revalidatePath(path);
    }
  }
  return result;
}
