"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import {
  approveRecommendationDecision,
  dismissAutomaticHoldNotice,
  rejectRecommendationDecision,
} from "@/services/recommendation-decisions";
import { publishRecommendationProgramVersion } from "@/services/program-publication";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";

const approveSchema = z.object({
  recommendationId: z.string().uuid(),
  /** For load changes the user may tweak the number before approving. */
  editedToLoad: z.number().min(0).max(2000).optional(),
});

export async function approveRecommendation(
  input: z.infer<typeof approveSchema>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = approveSchema.parse(input);
  if (!isProgramEditorEnabled()) {
    return { ok: false, reason: "Program version changes are temporarily unavailable." };
  }
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await approveRecommendationDecision(db, user.id, parsed, {
    publishProgramVersion: async (publicationDb, publicationUserId, publication) => {
      const safety = await createAutomaticSafetySnapshot(
        publicationDb,
        publicationUserId,
        "pre_recommendation_program_version",
        "Automatic protection created before applying a recommendation as a new Program version."
      );
      if (!safety.ok) return { ok: false as const, reason: "invalid" as const };
      return publishRecommendationProgramVersion(
        publicationDb,
        publicationUserId,
        publication
      );
    },
  });
  if (!result.ok) return result;
  revalidatePath("/coach");
  revalidatePath("/today");
  revalidatePath("/program");
  return result;
}

const rejectSchema = z.object({
  recommendationId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

export async function rejectRecommendation(input: z.infer<typeof rejectSchema>) {
  const parsed = rejectSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await rejectRecommendationDecision(db, user.id, parsed);
  if (!result.ok) return result;
  revalidatePath("/coach");
  revalidatePath("/today");
  return result;
}

const dismissNoticeSchema = z.object({
  recommendationId: z.string().uuid(),
});

export async function dismissRecommendationNotice(
  input: z.infer<typeof dismissNoticeSchema>
) {
  const parsed = dismissNoticeSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await dismissAutomaticHoldNotice(db, user.id, parsed);
  if (!result.ok) return result;
  revalidatePath("/coach");
  revalidatePath("/today");
  return result;
}
