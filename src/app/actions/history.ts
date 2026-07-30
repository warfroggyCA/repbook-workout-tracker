"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { audit } from "@/services/audit";
import {
  archiveSampleHistoryRecords,
  archiveWorkoutRecord,
  type ArchiveActionResult,
  type SampleHistoryArchivePreview,
} from "@/services/archive";
import { createAutomaticSafetySnapshot } from "@/services/snapshots";
import {
  getWorkoutTestDataCount,
  insertWorkoutTestData,
} from "@/services/workout-test-data";
import { actionFailure } from "@/lib/action-results";
import {
  retrospectiveWorkoutSchema,
  type RetrospectiveWorkoutInput,
} from "@/lib/retrospective-workout";
import { createRetrospectiveWorkout } from "@/services/retrospective-workouts";
import { logServerEvent } from "@/lib/server-log";
import { safeErrorName } from "@/lib/safe-error-name";
import {
  workoutTimingCorrectionSchema,
  type WorkoutTimingCorrectionInput,
} from "@/lib/workout-timing-correction";
import { correctCompletedWorkoutTiming } from "@/services/workout-timing-corrections";

function revalidateWorkoutHistory() {
  revalidatePath("/history");
  revalidatePath("/today");
  revalidatePath("/coach");
  revalidatePath("/export");
  revalidatePath("/archive");
}

export type RetrospectiveWorkoutActionResult =
  | { ok: true; outcome: "created" | "replayed"; sessionId: string }
  | {
      ok: false;
      code:
        | "conflict"
        | "stale_program"
        | "invalid_reference"
        | "count_mismatch"
        | "duplicate_warning_required"
        | "failed"
        | "invalid_request";
      reason: string;
      sessionId?: string;
    };

export async function recordRetrospectiveWorkout(
  input: RetrospectiveWorkoutInput,
): Promise<RetrospectiveWorkoutActionResult> {
  const user = await getCurrentUser();
  const db = await getDb();
  try {
    const parsed = retrospectiveWorkoutSchema.parse(input);
    if (
      !parsed.exercises.some((exercise) =>
        exercise.outcomes.some(
          (outcome) => outcome.outcome !== "legacy_unrecorded",
        ),
      )
    ) {
      return {
        ok: false,
        code: "invalid_request",
        reason:
          "Record at least one completed or intentionally skipped set before saving.",
      };
    }
    const result = await createRetrospectiveWorkout(db, user.id, parsed);
    if (result.ok) {
      revalidateWorkoutHistory();
      revalidatePath(`/history/${result.sessionId}`);
    }
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        code: "invalid_request",
        reason: error.issues[0]?.message ?? "Review the workout facts and try again.",
      };
    }
    const safeMessages = new Set([
      "Choose a workout date after 1900.",
      "Retrospective workouts must use a past local date.",
      "The workout time does not match its local calendar date.",
      "Retrospective workouts cannot start in the future.",
      "Retrospective workouts cannot finish in the future.",
      "Workout finish time cannot be before its start.",
      "Observed set completion must use the workout's local calendar date.",
      "Observed set completion must fall within the reviewed workout time.",
      "Observed set completion cannot be in the future.",
      "Load and load unit must be supplied together.",
      "Record at least one completed or intentionally skipped set before saving.",
    ]);
    if (error instanceof Error && safeMessages.has(error.message)) {
      return { ok: false, code: "invalid_request", reason: error.message };
    }
    logServerEvent("error", "history.retrospective_create_failed", {
      userId: user.id,
      category: "unexpected_creation_failure",
      errorName: safeErrorName(error),
    });
    return {
      ok: false,
      code: "failed",
      reason:
        "The workout was not saved. Your reviewed draft is still on this device; try again.",
    };
  }
}

export async function correctWorkoutTiming(
  input: WorkoutTimingCorrectionInput,
) {
  const user = await getCurrentUser();
  const db = await getDb();
  try {
    const parsed = workoutTimingCorrectionSchema.parse(input);
    const result = await correctCompletedWorkoutTiming(db, user.id, parsed);
    if (result.ok) {
      revalidateWorkoutHistory();
      revalidatePath(`/history/${result.sessionId}`);
      revalidatePath("/recovery");
      revalidatePath("/recovery/versions");
    }
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false as const,
        code: "failed" as const,
        reason:
          error.issues[0]?.message ??
          "Review the corrected workout timing and try again.",
      };
    }
    const safeMessages = new Set([
      "Choose a workout date after 1900.",
      "A completed workout cannot be moved to a future date.",
      "A completed workout cannot start in the future.",
      "A completed workout cannot finish in the future.",
      "The date-only technical anchor could not be resolved.",
    ]);
    if (
      error instanceof Error &&
      (safeMessages.has(error.message) ||
        error.message.includes("because of daylight-saving time") ||
        error.message.includes("choose the earlier or later occurrence"))
    ) {
      return {
        ok: false as const,
        code: "failed" as const,
        reason: error.message,
      };
    }
    logServerEvent("error", "history.timing_correction_failed", {
      userId: user.id,
      sessionId:
        typeof input === "object" && input && "sessionId" in input
          ? String(input.sessionId)
          : null,
      errorName: safeErrorName(error),
    });
    return {
      ok: false as const,
      code: "failed" as const,
      reason:
        "The correction was not saved. Reload the workout and review the latest timing before trying again.",
    };
  }
}

export async function archiveWorkoutDay(
  sessionId: string
): Promise<ArchiveActionResult> {
  const id = z.string().uuid().parse(sessionId);
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await archiveWorkoutRecord(db, user.id, id);
  if (result.ok) revalidateWorkoutHistory();
  return result;
}

const sampleHistoryPreviewSchema = z.object({
  workouts: z.number().int().positive(),
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
});

/**
 * Bulk archive of the labelled sample history. Snapshot-gated, and the exact
 * previewed scope is revalidated inside the atomic operation so a stale
 * confirmation makes no changes.
 */
export async function archiveWorkoutTestData(
  expectedPreview: SampleHistoryArchivePreview
): Promise<ArchiveActionResult> {
  const expected = sampleHistoryPreviewSchema.parse(expectedPreview);
  const user = await getCurrentUser();
  const db = await getDb();
  const safety = await createAutomaticSafetySnapshot(
    db,
    user.id,
    "pre_bulk_archive",
    `Automatic protection created before archiving ${expected.workouts} sample workouts.`
  );
  if (!safety.ok) {
    return {
      ok: false as const,
      reason: `Nothing was archived because the safety snapshot could not be verified: ${safety.reason}`,
    };
  }
  const result = await archiveSampleHistoryRecords(db, user.id, expected);
  if (result.ok) {
    revalidateWorkoutHistory();
    revalidatePath("/settings");
    revalidatePath("/recovery");
  }
  return result;
}

export async function loadWorkoutTestData() {
  const user = await getCurrentUser();
  const db = await getDb();
  const existingCount = await getWorkoutTestDataCount(db, user.id);
  if (existingCount > 0) {
    return actionFailure(
      "sample_history_exists",
      "Sample history is already loaded. Archive it from Settings before loading a fresh copy."
    );
  }

  const count = await insertWorkoutTestData(
    db,
    user.id,
    user.profile.unit,
    user.profile.timezone
  );

  await audit(db, {
    userId: user.id,
    actorType: "user",
    action: "history.test_data.load",
    entityType: "workout_history",
    summary: `Loaded ${count} clearly labelled sample workout sessions`,
  });
  revalidatePath("/history");
  revalidatePath("/settings");
  revalidatePath("/today");
  return { ok: true as const, count };
}
