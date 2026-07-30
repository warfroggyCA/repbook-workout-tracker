"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { isSettingsManagementEnabled } from "@/lib/settings-management-feature";
import { BODY_REGION_PATTERNS } from "@/lib/setup-steps";
import {
  saveCoachingPrefsReviewWithVersions,
  saveConstraintsWithVersions,
  saveProfileReviewWithVersions,
} from "@/services/setup-persistence";

type ReviewSaveResponse =
  | { ok: true; changed: boolean }
  | { ok: false; reason: string };

const DISABLED_REASON = "Setup review is not enabled on this deployment.";

const profileReviewSchema = z.object({
  ageRange: z.string().min(1).max(20),
  experience: z.enum(["novice", "intermediate", "advanced"]),
  // Older accounts can contain the original display labels (for example,
  // "muscle tone") rather than today's pill IDs. Returning-user review must
  // preserve those saved values when another Profile field is edited.
  goals: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
  sessionLengthMin: z.number().int().min(15).max(120),
  weeklyFrequency: z.number().int().min(1).max(7),
  // No unit field: the account unit stays read-only in review until a safe
  // conversion project exists (plate and bar rows depend on it).
});

/**
 * Returning-user Profile review save. Never marks setup steps or setup
 * completion; a meaningful change is versioned and audited, and a no-op
 * writes nothing.
 */
export async function saveProfileReview(
  input: z.infer<typeof profileReviewSchema>
): Promise<ReviewSaveResponse> {
  if (!isSettingsManagementEnabled()) return { ok: false, reason: DISABLED_REASON };
  const parsed = profileReviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the form values." };
  const user = await getCurrentUser();
  const db = await getDb();
  const saved = await saveProfileReviewWithVersions(db, user.id, parsed.data);
  if (!saved.ok) return saved;
  if (saved.changed) {
    revalidatePath("/settings");
    revalidatePath("/settings/setup");
    revalidatePath("/today");
  }
  return { ok: true, changed: saved.changed };
}

const coachingReviewSchema = z.object({
  aggressiveness: z.enum(["conservative", "moderate", "aggressive"]),
  deloadSuggestions: z.boolean(),
  substitutionSuggestions: z.boolean(),
  weeklyReview: z.boolean(),
});

/** Returning-user Coaching review save with the same no-op suppression. */
export async function saveCoachingReview(
  input: z.infer<typeof coachingReviewSchema>
): Promise<ReviewSaveResponse> {
  if (!isSettingsManagementEnabled()) return { ok: false, reason: DISABLED_REASON };
  const parsed = coachingReviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the preference values." };
  const user = await getCurrentUser();
  const db = await getDb();
  const saved = await saveCoachingPrefsReviewWithVersions(db, user.id, parsed.data);
  if (!saved.ok) return saved;
  if (saved.changed) {
    revalidatePath("/settings");
    revalidatePath("/settings/setup");
    revalidatePath("/coach");
  }
  return { ok: true, changed: saved.changed };
}

const constraintRegionSchema = z
  .object({
    bodyPart: z.enum(Object.keys(BODY_REGION_PATTERNS) as [string, ...string[]]),
    avoidPatterns: z.array(z.string()),
    cautiousPatterns: z.array(z.string()),
    painStopThreshold: z.number().int().min(1).max(10),
    note: z.string().max(500).nullable(),
  })
  .refine(
    (region) =>
      [...region.avoidPatterns, ...region.cautiousPatterns].every((pattern) =>
        BODY_REGION_PATTERNS[region.bodyPart]?.includes(pattern)
      ),
    { message: "Patterns must belong to the body region." }
  );

const constraintsReviewSchema = z.object({
  regions: z.array(constraintRegionSchema).max(10),
});

/**
 * Returning-user Constraints review save: the same atomic constraint diff as
 * onboarding, in review mode — no setup-step marking and no no-op audit.
 */
export async function saveConstraintsReview(
  input: z.infer<typeof constraintsReviewSchema>
): Promise<ReviewSaveResponse> {
  if (!isSettingsManagementEnabled()) return { ok: false, reason: DISABLED_REASON };
  const parsed = constraintsReviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the constraint values." };
  const user = await getCurrentUser();
  const db = await getDb();
  const saved = await saveConstraintsWithVersions(db, user.id, parsed.data.regions, {
    mode: "review",
  });
  if (!saved.ok) return saved;
  if (saved.changed) {
    revalidatePath("/settings");
    revalidatePath("/settings/setup");
    revalidatePath("/today");
  }
  return { ok: true, changed: saved.changed };
}
