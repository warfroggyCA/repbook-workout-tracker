"use server";

import { and, desc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect, RedirectType } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  sessionExercises,
  completedSets,
  recordVersions,
  sessionOccurrences,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import {
  getCurrentUserIdFast,
  refreshCurrentUserIdFast,
} from "@/lib/user-id-cache";
import {
  archiveCompletedSetRecord,
  getSetParentSessionId,
} from "@/services/archive";
import {
  updateSessionExerciseWithVersion,
  updateSetWithVersion,
  restoreRecordVersion,
} from "@/services/record-versions";
import {
  getExerciseAlternativeOptions,
} from "@/services/exercise-alternatives";
import { getExerciseReplacementOptions } from "@/services/exercise-replacements";
import { getExerciseDiscoveryLibrary } from "@/services/exercise-discovery";
import { ALTERNATIVE_REASONS } from "@/lib/exercise-alternatives";
import { isValidIanaTimezone } from "@/lib/workout-calendar";
import {
  abandonWorkoutSession,
  addWorkoutExercise,
  appendWorkoutSetOccurrence,
  completeWorkoutSession,
  logWorkoutPain,
  logWorkoutSet,
  mutateWorkoutOccurrence,
  IncompleteWorkoutCreationError,
  StaleWorkoutTemplateError,
  buildWorkoutStartRequestHash,
  findOwnedActiveWorkout,
  findOwnedWorkoutByStartRequest,
  startWorkoutSession,
} from "@/services/session-lifecycle";
import { addWorkoutExerciseInputSchema } from "@/lib/add-workout-exercise";
import { workoutReplacementUnavailableReason } from "@/lib/exercise-replacements";
import { processProgressionJob } from "@/services/progression-jobs";
import { sessionTimeBudgetSchema } from "@/lib/session-time-budget";
import { actionFailure } from "@/lib/action-results";
import {
  categorizeDiagnosticError,
  logDiagnosticEvent,
} from "@/lib/server-log";
import { acceptanceWorkoutNow } from "@/lib/acceptance-workout-clock";
import type { WorkoutStartState } from "@/lib/workout-start";
import { isPhase0StartDisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";
import { mutateSessionEquipmentSelection } from "@/services/session-equipment-selection";
import {
  logSetSchema,
  painSchema,
  type LogSetInput,
} from "@/lib/session-action-validation";
import { SET_CORRECTION_CATEGORIES } from "@/lib/set-correction";
import { correctCompletedWorkoutActiveDuration } from "@/services/workout-timing-corrections";
import { ACTIVE_WORKOUT_DURATION_BASES } from "@/lib/workout-duration-quality";
import { incompleteSessionReasonSchema } from "@/lib/session-completion-semantics";

const appendSetSchema = z.object({
  sessionExerciseId: z.string().uuid(),
  occurrenceId: z.string().uuid(),
  expectedSetNo: z.number().int().min(1).max(100),
});

class Phase0AmbiguousStartError extends Error {}

async function requireOwnedSessionExercise(sessionExerciseId: string) {
  const user = await getCurrentUser();
  const db = await getDb();
  const se = await db.query.sessionExercises.findFirst({
    where: eq(sessionExercises.id, sessionExerciseId),
    with: { session: true },
  });
  if (
    !se ||
    se.session.userId !== user.id ||
    se.session.archivedAt != null ||
    se.session.status !== "in_progress"
  ) {
    return actionFailure(
      "not_active",
      "Only an active workout can be changed."
    );
  }
  return { ok: true as const, user, db, sessionExercise: se };
}

// --- Start ---

export async function startSession(
  templateId: string,
  _previousState: WorkoutStartState,
  formData: FormData,
): Promise<WorkoutStartState> {
  const user = await getCurrentUser();
  const db = await getDb();
  const submittedTimezone = formData.get("timezone");
  const timezoneResult = z.string().refine(isValidIanaTimezone).safeParse(
    typeof submittedTimezone === "string" && submittedTimezone.length > 0
      ? submittedTimezone
      : undefined,
  );
  const parsedTemplateId = z.string().uuid().safeParse(templateId);
  const parsedStartRequestKey = z.string().uuid().safeParse(
    formData.get("startRequestKey"),
  );
  const parsedIncludeWarmups = z
    .enum(["true"])
    .nullable()
    .safeParse(formData.get("includeWarmups"));
  const scheduledValues = {
    scheduledProgramEventId: formData.get("scheduledProgramEventId"),
    expectedEventRevision: formData.get("expectedEventRevision"),
    programScheduleVersionId: formData.get("programScheduleVersionId"),
    programScheduleVersionHash: formData.get("programScheduleVersionHash"),
  };
  const hasAnyScheduledValue = Object.values(scheduledValues).some(
    (value) => value !== null,
  );
  const parsedScheduledStart = hasAnyScheduledValue
    ? z
        .object({
          scheduledProgramEventId: z.string().uuid(),
          expectedEventRevision: z.coerce.number().int().min(0),
          programScheduleVersionId: z.string().uuid(),
          programScheduleVersionHash: z.string().regex(/^[0-9a-f]{64}$/u),
        })
        .safeParse(scheduledValues)
    : null;
  const submittedStartRequestKey = parsedStartRequestKey.success
    ? parsedStartRequestKey.data.toLowerCase()
    : null;
  const acceptanceFailure = isPhase0StartDisposableAcceptanceRuntime()
    ? formData.get("phase0StartFailure")
    : null;
  if (
    !timezoneResult.success ||
    !parsedTemplateId.success ||
    !parsedStartRequestKey.success ||
    !parsedIncludeWarmups.success ||
    (hasAnyScheduledValue && !parsedScheduledStart?.success)
  ) {
    logDiagnosticEvent("session.start_rejected", {
      rejection: "invalid_request",
    });
    return {
      status: "error" as const,
      code: "not_created" as const,
      message: "No workout was created. Check your device settings and try again.",
      workoutCreated: false as const,
      startRequestKey: submittedStartRequestKey,
    };
  }
  const timeBudgetMin = sessionTimeBudgetSchema.parse(undefined);
  const startRequestKey = submittedStartRequestKey!;
  const includeWarmups = parsedIncludeWarmups.data === "true";
  const scheduledStart = parsedScheduledStart?.success
    ? parsedScheduledStart.data
    : undefined;
  const startRequestHash = buildWorkoutStartRequestHash({
    templateId: parsedTemplateId.data,
    timezone: timezoneResult.data,
    timeBudgetMin: timeBudgetMin ?? null,
    includeWarmups,
    ...(scheduledStart ? { scheduledStart } : {}),
  });
  let result: Awaited<ReturnType<typeof startWorkoutSession>>;
  try {
    result = await startWorkoutSession(
      db,
      user.id,
      parsedTemplateId.data,
      timeBudgetMin,
      {
        timezone: timezoneResult.data,
        startRequestKey,
        includeWarmups,
        now: acceptanceWorkoutNow("start"),
        ...(scheduledStart ? { scheduledStart } : {}),
        ...(acceptanceFailure === "incomplete"
          ? { evaluateStartCounts: () => false }
          : {}),
        ...(acceptanceFailure === "ambiguous"
          ? {
              checkpoint: (boundary: string) => {
                if (boundary === "after-start-statement") {
                  throw new Phase0AmbiguousStartError();
                }
              },
            }
          : {}),
      }
    );
  } catch (error) {
    if (error instanceof StaleWorkoutTemplateError) {
      logDiagnosticEvent("session.start_rejected", {
        rejection: "program_updated",
      });
      revalidatePath("/today");
      return redirect("/today?program=updated", RedirectType.replace);
    }
    if (error instanceof IncompleteWorkoutCreationError) {
      return {
        status: "error" as const,
        code: "not_created" as const,
        message: "The workout was not created completely, so nothing was kept. Try again.",
        workoutCreated: false as const,
        startRequestKey,
      };
    }
    logDiagnosticEvent("session.start_failed", {
      failure: "unexpected_creation_failure",
      errorCategory: categorizeDiagnosticError(error, "persistence"),
    });
    let exact: Awaited<ReturnType<typeof findOwnedWorkoutByStartRequest>>;
    try {
      exact = await findOwnedWorkoutByStartRequest(
        db,
        user.id,
        startRequestKey,
      );
    } catch (reconciliationError) {
      logDiagnosticEvent("session.start_reconciliation_failed", {
        reconciliation: "start_request_status_unknown",
        errorCategory: categorizeDiagnosticError(
          reconciliationError,
          "persistence",
        ),
      });
      return {
        status: "error" as const,
        code: "status_unknown" as const,
        message: "We could not confirm whether the workout was created. Check Today before trying again.",
        workoutCreated: null,
        startRequestKey,
      };
    }
    if (exact?.startRequestHash === startRequestHash) {
      logDiagnosticEvent("session.start_reconciled", {
        reconciliation: "exact_start_request_found",
      });
      revalidatePath("/today");
      return redirect(`/session/${exact.id}`, RedirectType.push);
    }
    if (exact) {
      return {
        status: "error" as const,
        code: "request_conflict" as const,
        message: "This Start request no longer matches the workout you chose. Refresh Today and start again.",
        workoutCreated: false as const,
        startRequestKey,
      };
    }
    try {
      const active = await findOwnedActiveWorkout(db, user.id);
      if (active) {
        revalidatePath("/today");
        return redirect("/today?start=active", RedirectType.replace);
      }
    } catch (reconciliationError) {
      logDiagnosticEvent("session.start_reconciliation_failed", {
        reconciliation: "active_workout_status_unknown",
        errorCategory: categorizeDiagnosticError(
          reconciliationError,
          "persistence",
        ),
      });
      return {
        status: "error" as const,
        code: "status_unknown" as const,
        message: "We could not confirm whether the workout was created. Check Today before trying again.",
        workoutCreated: null,
        startRequestKey,
      };
    }
    return {
      status: "error" as const,
      code: "not_created" as const,
      message: "This workout could not be started. No workout was created. Try again.",
      workoutCreated: false as const,
      startRequestKey,
    };
  }
  if (result.outcome === "request_conflict") {
    return {
      status: "error" as const,
      code: "request_conflict" as const,
      message: "This Start request no longer matches the workout you chose. Refresh Today and start again.",
      workoutCreated: false as const,
      startRequestKey,
    };
  }
  if (result.outcome === "active_workout_exists") {
    revalidatePath("/today");
    return redirect("/today?start=active", RedirectType.replace);
  }
  revalidatePath("/today");
  redirect(
    acceptanceFailure === "render"
      ? `/session/${result.sessionId}?phase0RenderFailure=1`
      : `/session/${result.sessionId}`,
    RedirectType.push,
  );
}

// --- Set logging (the hot path) ---

export type LogSetResult =
  | Awaited<ReturnType<typeof logWorkoutSet>>
  | { outcome: "invalid" };

export async function logSet(input: LogSetInput): Promise<LogSetResult> {
  const validation = logSetSchema.safeParse(input);
  if (!validation.success) return { outcome: "invalid" };
  const db = await getDb();
  const userId = await getCurrentUserIdFast();
  // A cached id is safe only because logWorkoutSet inserts from its owned CTE,
  // whose workout-session ownership predicate includes this id. A stale or
  // wrong value can therefore produce only not_found, never a cross-user write.
  const result = await logWorkoutSet(db, userId, validation.data);
  if (result.outcome !== "not_found") return result;
  const refreshedUserId = await refreshCurrentUserIdFast(userId);
  return logWorkoutSet(db, refreshedUserId, validation.data);
}

const equipmentSelectionSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("select"),
    sessionExerciseId: z.string().uuid(),
    equipmentItemId: z.string().uuid(),
    attachmentItemId: z.string().uuid().nullable(),
    expectedCurrentSnapshotId: z.string().uuid().nullable(),
    clientKey: z.string().uuid(),
    provenance: z.enum(["auto_unique", "user_selected"]),
  }),
  z.object({
    operation: z.literal("clear"),
    sessionExerciseId: z.string().uuid(),
    expectedCurrentSnapshotId: z.string().uuid().nullable(),
    clientKey: z.string().uuid(),
  }),
]);

export type EquipmentSelectionInput = z.infer<typeof equipmentSelectionSchema>;

export async function setSessionEquipmentSelection(
  input: EquipmentSelectionInput,
) {
  const parsed = equipmentSelectionSchema.safeParse(input);
  if (!parsed.success) return { outcome: "invalid_setup" as const };
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await mutateSessionEquipmentSelection(db, user.id, parsed.data);
  if (
    result.outcome === "applied" ||
    result.outcome === "no_change" ||
    result.outcome === "replayed"
  ) {
    revalidatePath("/session/[id]", "page");
    revalidatePath("/today");
  }
  return result;
}

const correctedSetValuesSchema = z.object({
  weight: z.number().finite().min(0).max(2000).nullable(),
  weightUnit: z.enum(["lb", "kg"]).nullable(),
  reps: z.number().int().min(0).max(100).nullable(),
  distanceKm: z.number().finite().min(0).max(10_000).nullable(),
  durationSeconds: z.number().int().min(0).max(604_800).nullable(),
  rpe: z.number().finite().min(1).max(10).nullable(),
  note: z.string().max(500).nullable(),
}).refine(
  (value) => (value.weight == null) === (value.weightUnit == null),
  { message: "A corrected load needs one explicit unit.", path: ["weightUnit"] },
);

const acknowledgedSetCorrectionSchema = z.object({
  setId: z.string().uuid(),
  values: correctedSetValuesSchema,
  expected: correctedSetValuesSchema,
  expectedHistoryRevision: z.number().int().min(0),
  clientMutationId: z.string().uuid(),
  category: z.enum(SET_CORRECTION_CATEGORIES),
  reasonNote: z.string().trim().max(240).nullable(),
  source: z.enum(["active_workout", "workout_history"]),
  reviewed: z.literal(true),
});

export async function correctAcknowledgedSet(
  input: z.infer<typeof acknowledgedSetCorrectionSchema>,
) {
  const validation = acknowledgedSetCorrectionSchema.safeParse(input);
  if (!validation.success) {
    return actionFailure(
      "correction_invalid",
      "Review the complete correction and try again. Nothing was changed.",
    );
  }
  const parsed = validation.data;
  const user = await getCurrentUser();
  const db = await getDb();
  const set = await db.query.completedSets.findFirst({
    where: and(
      eq(completedSets.id, parsed.setId),
      isNull(completedSets.archivedAt),
    ),
    with: { sessionExercise: { with: { session: true } } },
  });
  if (
    !set ||
    set.sessionExercise.session.userId !== user.id ||
    set.sessionExercise.session.archivedAt != null
  ) {
    return actionFailure(
      "set_not_found",
      "Only an acknowledged set from your unarchived workout can be corrected.",
    );
  }
  const status = set.sessionExercise.session.status;
  const sourceMatchesStatus =
    (parsed.source === "active_workout" && status === "in_progress") ||
    (parsed.source === "workout_history" &&
      (status === "completed" || status === "abandoned"));
  if (!sourceMatchesStatus) {
    return actionFailure(
      "correction_stale_context",
      "The workout state changed after this correction opened. Reload and review the saved set again.",
    );
  }
  const performedOccurrence = await db.query.sessionOccurrences.findFirst({
    where: and(
      eq(sessionOccurrences.completedSetId, set.id),
      eq(sessionOccurrences.sessionId, set.sessionExercise.sessionId),
      eq(sessionOccurrences.sessionExerciseId, set.sessionExerciseId),
      eq(sessionOccurrences.kind, "working_set"),
      eq(sessionOccurrences.outcome, "completed"),
    ),
    columns: { id: true },
  });
  if (!performedOccurrence) {
    return actionFailure(
      "correction_rejected",
      "This result is not linked to completed working-set evidence, so it was not changed.",
    );
  }

  const corrected = await updateSetWithVersion(
    db,
    user.id,
    set.id,
    { ...parsed.values, note: parsed.values.note?.trim() || null },
    status === "in_progress"
      ? "set.active_correction"
      : "set.completed_correction",
    {
      expected: parsed.expected,
      expectedHistoryRevision: parsed.expectedHistoryRevision,
      clientMutationId: parsed.clientMutationId,
      correctionEvidence: {
        category: parsed.category,
        reasonNote: parsed.reasonNote?.trim() || null,
        source: parsed.source,
      },
    },
  );
  if (!corrected.ok) {
    return actionFailure("correction_rejected", corrected.reason);
  }

  const sessionId = set.sessionExercise.sessionId;
  revalidatePath(`/session/${sessionId}`);
  revalidatePath(`/history/${sessionId}`);
  revalidatePath("/today");
  revalidatePath("/history");
  revalidatePath("/coach");
  revalidatePath("/export");
  revalidatePath("/archive");
  revalidatePath("/recovery");
  revalidatePath("/recovery/versions");
  return corrected;
}

export async function archiveSet(setId: string) {
  const user = await getCurrentUser();
  const db = await getDb();
  const parsedId = z.string().uuid().parse(setId);
  const sessionId = await getSetParentSessionId(db, parsedId);
  const result = await archiveCompletedSetRecord(db, user.id, parsedId, {
    activeOnly: true,
  });
  if (!result.ok) return actionFailure("archive_rejected", result.reason);
  if (sessionId) revalidatePath(`/session/${sessionId}`);
  revalidatePath("/history");
  revalidatePath("/today");
  revalidatePath("/coach");
  revalidatePath("/export");
  revalidatePath("/archive");
  return result;
}

// --- Mid-session modifications ---

export async function getAddWorkoutExerciseOptions(sessionId: string) {
  const parsedSessionId = z.string().uuid().parse(sessionId);
  const user = await getCurrentUser();
  const db = await getDb();
  const ownedSession = await db.query.workoutSessions.findFirst({
    where: (workout, { and: all, eq: equal, isNull: nullValue }) =>
      all(
        equal(workout.id, parsedSessionId),
        equal(workout.userId, user.id),
        equal(workout.status, "in_progress"),
        nullValue(workout.archivedAt),
      ),
    columns: { id: true, historyRevision: true },
  });
  if (!ownedSession) {
    return actionFailure(
      "not_active",
      "Only an active workout can have an exercise added.",
    );
  }
  const items = await getExerciseDiscoveryLibrary(db, user.id);
  const disabledReasons = Object.fromEntries(
    items.flatMap((item) => {
      const reason = workoutReplacementUnavailableReason(item);
      return reason ? [[item.id, reason]] : [];
    }),
  );
  return {
    ok: true as const,
    sessionRevision: ownedSession.historyRevision,
    items,
    allowedIds: items
      .filter((item) => workoutReplacementUnavailableReason(item) == null)
      .map((item) => item.id),
    disabledReasons,
  };
}

export async function addExerciseToWorkout(
  input: z.infer<typeof addWorkoutExerciseInputSchema>,
) {
  const parsed = addWorkoutExerciseInputSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await addWorkoutExercise(db, user.id, parsed);
  if (result.outcome === "added" || result.outcome === "replayed") {
    revalidatePath(`/session/${parsed.sessionId}`);
    return {
      ok: true as const,
      replayed: result.outcome === "replayed",
      sessionExerciseId: result.sessionExerciseId,
      occurrenceIds: result.occurrenceIds,
      sessionRevision: result.sessionRevision,
    };
  }
  if (result.outcome === "conflict") {
    return actionFailure(
      "add_exercise_key_conflict",
      result.reason ??
        "This retry identity was already used for a different exercise.",
    );
  }
  if (result.outcome === "stale") {
    return actionFailure(
      "workout_changed",
      "The workout changed while this exercise was being reviewed. Review the latest workout and try again.",
    );
  }
  if (result.outcome === "exercise_unavailable") {
    return actionFailure(
      "exercise_unavailable",
      result.reason ??
        "That exercise is no longer available with the current equipment and constraints.",
    );
  }
  if (result.outcome === "workout_not_active" || result.outcome === "not_found") {
    return actionFailure(
      "not_active",
      "Only an active workout can have an exercise added.",
    );
  }
  return actionFailure(
    "add_exercise_failed",
    "The exercise was not added. Your reviewed choice is still available to retry.",
  );
}

export async function appendWorkoutSet(input: z.infer<typeof appendSetSchema>) {
  const parsed = appendSetSchema.parse(input);
  const owned = await requireOwnedSessionExercise(parsed.sessionExerciseId);
  if (!owned.ok) return owned;
  const result = await appendWorkoutSetOccurrence(
    owned.db,
    owned.user.id,
    parsed,
  );
  if (result.outcome === "stale") {
    return actionFailure(
      "set_list_changed",
      "The set list changed before this set was added. Review the latest sets and try again.",
    );
  }
  if (result.outcome === "workout_not_active" || result.outcome === "not_found") {
    return actionFailure(
      "not_active",
      "Only an active workout can have another set.",
    );
  }
  if (result.outcome === "appended" || result.outcome === "replayed") {
    revalidatePath(`/session/${owned.sessionExercise.sessionId}`);
    return { ok: true as const, occurrence: result.occurrence };
  }
  return actionFailure("append_rejected", "The set could not be added.");
}

const skipSchema = z.object({
  sessionExerciseId: z.string().uuid(),
  reason: z.union([
    z.enum(["time", "pain", "fatigue", "equipment", "other"]),
    incompleteSessionReasonSchema,
  ]),
  expectedHistoryRevision: z.number().int().nonnegative(),
});

export async function skipExercise(input: z.infer<typeof skipSchema>) {
  const parsed = skipSchema.parse(input);
  const owned = await requireOwnedSessionExercise(
    parsed.sessionExerciseId
  );
  if (!owned.ok) return owned;
  const { user, db, sessionExercise } = owned;
  const updated = await updateSessionExerciseWithVersion(
    db,
    user.id,
    sessionExercise.id,
    { modificationType: "skipped", skipReason: parsed.reason },
    "session_exercise.skip",
    {
      activeOnly: true,
      expectedHistoryRevision: parsed.expectedHistoryRevision,
      fenceSessionExerciseIntent: true,
    },
  );
  if (!updated.ok) {
    return actionFailure(
      updated.reason.includes("saved workout changed")
        ? "skip_stale"
        : "skip_rejected",
      updated.reason,
    );
  }
  if (updated.historyRevision == null) {
    return actionFailure(
      "skip_rejected",
      "Repbook could not fence this exercise choice. Review the workout before trying again.",
    );
  }
  revalidatePath(`/session/${sessionExercise.sessionId}`);
  return { ...updated, historyRevision: updated.historyRevision };
}

export async function confirmExerciseUnskipped(input: {
  sessionExerciseId: string;
  expectedHistoryRevision: number;
}) {
  const parsed = z.object({
    sessionExerciseId: z.string().uuid(),
    expectedHistoryRevision: z.number().int().nonnegative(),
  }).parse(input);
  const owned = await requireOwnedSessionExercise(parsed.sessionExerciseId);
  if (!owned.ok) return owned;
  const { user, db, sessionExercise } = owned;
  let restoreModificationType = sessionExercise.modificationType;
  if (sessionExercise.modificationType === "skipped") {
    const skipVersions = await db.query.recordVersions.findMany({
      where: and(
        eq(recordVersions.userId, user.id),
        eq(recordVersions.entityType, "session_exercise"),
        eq(recordVersions.entityId, sessionExercise.id),
        eq(recordVersions.action, "session_exercise.skip"),
      ),
      orderBy: desc(recordVersions.createdAt),
    });
    const retainedType = skipVersions.find((version) =>
      version.afterData.modification_type === "skipped" &&
      version.beforeData.modification_type !== "skipped"
    )?.beforeData.modification_type;
    const parsedRetainedType = z.enum([
      "as_planned",
      "substituted",
      "added",
    ]).safeParse(retainedType);
    if (!parsedRetainedType.success) {
      return actionFailure(
        "previous_state_unavailable",
        "The exercise's previous workout-only state is unavailable. Reload the workout before trying Undo again.",
      );
    }
    restoreModificationType = parsedRetainedType.data;
  }
  const updated = await updateSessionExerciseWithVersion(
    db,
    user.id,
    sessionExercise.id,
    {
      modificationType: restoreModificationType,
      skipReason: null,
    },
    "session_exercise.unskip",
    {
      activeOnly: true,
      expectedHistoryRevision: parsed.expectedHistoryRevision,
      fenceSessionExerciseIntent: true,
    },
  );
  if (!updated.ok) {
    return actionFailure(
      updated.reason.includes("saved workout changed")
        ? "unskip_stale"
        : "unskip_rejected",
      updated.reason,
    );
  }
  if (updated.historyRevision == null) {
    return actionFailure(
      "unskip_rejected",
      "Repbook could not fence this exercise choice. Review the workout before trying again.",
    );
  }
  revalidatePath(`/session/${sessionExercise.sessionId}`);
  return {
    ...updated,
    historyRevision: updated.historyRevision,
    modificationType: restoreModificationType,
  };
}

const occurrenceMutationSchema = z.object({
  occurrenceId: z.string().uuid(),
  clientKey: z.string().uuid(),
  expectedRevision: z.number().int().min(0),
  operation: z.enum(["complete", "skip", "restore", "note"]),
  reason: z.string().trim().min(1).max(160).nullable().optional(),
  reasonCode: incompleteSessionReasonSchema.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export async function mutateOccurrence(
  input: z.infer<typeof occurrenceMutationSchema>,
) {
  const parsed = occurrenceMutationSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await mutateWorkoutOccurrence(db, user.id, parsed);
  if (result.outcome === "saved" || result.outcome === "replayed") {
    revalidatePath("/today");
    revalidatePath("/history");
  }
  return result;
}

/** Complete inspectable library; only server-ranked safe alternatives are selectable. */
export async function getAlternativeOptions(sessionExerciseId: string) {
  const parsedId = z.string().uuid().parse(sessionExerciseId);
  const owned = await requireOwnedSessionExercise(parsedId);
  if (!owned.ok) return owned;
  const options = await getExerciseAlternativeOptions(
    owned.db,
    owned.user.id,
    parsedId
  );
  return { ok: true as const, ...options };
}

/** Authorized catalog for deliberate workout-only replacement, separate from ranked alternatives. */
export async function getReplacementOptions(sessionExerciseId: string) {
  const parsedId = z.string().uuid().parse(sessionExerciseId);
  const owned = await requireOwnedSessionExercise(parsedId);
  if (!owned.ok) return owned;
  const options = await getExerciseReplacementOptions(
    owned.db,
    owned.user.id,
    parsedId,
  );
  return { ok: true as const, ...options };
}

export async function substituteExercise(input: {
  sessionExerciseId: string;
  newExerciseId: string;
  reason: (typeof ALTERNATIVE_REASONS)[number];
}) {
  const parsed = z
    .object({
      sessionExerciseId: z.string().uuid(),
      newExerciseId: z.string().uuid(),
      reason: z.enum(ALTERNATIVE_REASONS),
    })
    .parse(input);
  const owned = await requireOwnedSessionExercise(
    parsed.sessionExerciseId
  );
  if (!owned.ok) return owned;
  const { user, db, sessionExercise } = owned;

  const options = await getExerciseAlternativeOptions(
    db,
    user.id,
    sessionExercise.id
  );
  const target = options.items.find((item) => item.id === parsed.newExerciseId);
  if (!target?.available) {
    return actionFailure(
      "alternative_unavailable",
      target?.unavailableReason ??
        "That exercise is not a safe alternative for this workout."
    );
  }

  const updated = await updateSessionExerciseWithVersion(
    db,
    user.id,
    sessionExercise.id,
    {
      exerciseId: target.id,
      modificationType: "substituted",
      skipReason: null,
      substitutedForExerciseId:
        sessionExercise.substitutedForExerciseId ?? sessionExercise.exerciseId,
      substitutionReason: parsed.reason,
      substitutedAt: new Date(),
      // Load targets no longer apply to a different movement.
      targetLoad: null,
      targetLoadUnit: null,
      // Exercise-specific plan cues do not carry to a different movement.
      notes: null,
      warmupNotes: null,
      warmupSets: [],
      setNotes: [],
    },
    "session_exercise.substitute",
    { activeOnly: true }
  );
  if (!updated.ok) return actionFailure("substitution_rejected", updated.reason);
  revalidatePath(`/session/${sessionExercise.sessionId}`);
  return updated;
}

export async function replaceExercise(input: {
  sessionExerciseId: string;
  expectedExerciseId: string;
  newExerciseId: string;
  reason: (typeof ALTERNATIVE_REASONS)[number];
  clientMutationId: string;
}) {
  const parsed = z
    .object({
      sessionExerciseId: z.string().uuid(),
      expectedExerciseId: z.string().uuid(),
      newExerciseId: z.string().uuid(),
      reason: z.enum(ALTERNATIVE_REASONS),
      clientMutationId: z.string().uuid(),
    })
    .parse(input);
  const owned = await requireOwnedSessionExercise(parsed.sessionExerciseId);
  if (!owned.ok) return owned;
  const { user, db, sessionExercise } = owned;

  const options = await getExerciseReplacementOptions(
    db,
    user.id,
    sessionExercise.id,
  );
  const target = options.items.find((item) => item.id === parsed.newExerciseId);
  const targetIsCurrent = target?.id === options.currentExerciseId;
  if (!target || (!target.available && !targetIsCurrent)) {
    return actionFailure(
      "replacement_unavailable",
      target?.unavailableReason ??
        "That exercise cannot be represented safely in this workout.",
    );
  }

  const updated = await updateSessionExerciseWithVersion(
    db,
    user.id,
    sessionExercise.id,
    {
      exerciseId: target.id,
      modificationType: "substituted",
      skipReason: null,
      substitutedForExerciseId:
        sessionExercise.substitutedForExerciseId ?? sessionExercise.exerciseId,
      substitutionReason: parsed.reason,
      substitutedAt: new Date(),
      targetLoad: null,
      targetLoadUnit: null,
      notes: null,
      warmupNotes: null,
      warmupSets: [],
      setNotes: [],
    },
    "session_exercise.substitute",
    {
      activeOnly: true,
      expectedExerciseId: parsed.expectedExerciseId,
      versionId: parsed.clientMutationId,
    },
  );
  if (!updated.ok) {
    return actionFailure(
      updated.reason.includes("request identity")
        ? "replacement_key_conflict"
        : updated.reason.includes("changed after replacement opened")
          ? "replacement_stale"
          : "replacement_rejected",
      updated.reason,
    );
  }
  if (!updated.changed && updated.versionId == null) {
    return actionFailure(
      "replacement_unavailable",
      "That exercise is already selected for this workout.",
    );
  }
  revalidatePath(`/session/${sessionExercise.sessionId}`);
  return {
    ...updated,
    exercise: target,
    equipmentWarning: options.warnings[target.id] ?? null,
    replayed: !updated.changed,
  };
}

export async function undoExerciseSubstitution(sessionExerciseId: string) {
  const parsedId = z.string().uuid().parse(sessionExerciseId);
  const owned = await requireOwnedSessionExercise(parsedId);
  if (!owned.ok) return owned;
  const { user, db, sessionExercise } = owned;
  if (
    sessionExercise.session.status !== "in_progress" ||
    !sessionExercise.substitutedForExerciseId
  ) {
    return actionFailure(
      "no_active_alternative",
      "This exercise does not have an active alternative to undo."
    );
  }

  const substitutionVersions = await db.query.recordVersions.findMany({
    where: and(
      eq(recordVersions.userId, user.id),
      eq(recordVersions.entityType, "session_exercise"),
      eq(recordVersions.entityId, sessionExercise.id),
      eq(recordVersions.action, "session_exercise.substitute")
    ),
    orderBy: desc(recordVersions.createdAt),
  });
  const version = substitutionVersions.find(
    (candidate) =>
      candidate.afterData.exercise_id === sessionExercise.exerciseId &&
      candidate.afterData.substituted_for_exercise_id ===
        sessionExercise.substitutedForExerciseId
  );
  const previousExerciseId = String(version?.beforeData.exercise_id ?? "");
  if (!version || !z.string().uuid().safeParse(previousExerciseId).success) {
    return actionFailure(
      "previous_state_unavailable",
      "The previous exercise state is no longer available."
    );
  }
  const library = await getExerciseDiscoveryLibrary(db, user.id);
  const previousExercise = library.find((item) => item.id === previousExerciseId);
  if (!previousExercise?.available) {
    return actionFailure(
      "previous_exercise_unavailable",
      previousExercise?.unavailableReason ??
        "The previous exercise is not available with your current equipment and constraints."
    );
  }

  const restored = await restoreRecordVersion(db, user.id, version.id, {
    activeOnly: true,
  });
  if (!restored.ok) return actionFailure("restore_rejected", restored.reason);
  const current = await db.query.sessionExercises.findFirst({
    where: eq(sessionExercises.id, sessionExercise.id),
  });
  if (!current) throw new Error("The restored exercise could not be loaded.");
  const currentExercise = library.find((item) => item.id === current.exerciseId);
  if (!currentExercise) throw new Error("The restored exercise could not be loaded.");

  revalidatePath(`/session/${sessionExercise.sessionId}`);
  return {
    ok: true as const,
    exercise: currentExercise,
    modificationType: current.modificationType,
    skipReason: current.skipReason,
    substitutedForExerciseId: current.substitutedForExerciseId,
    substitutionReason: current.substitutionReason,
    substitutedAt: current.substitutedAt?.toISOString() ?? null,
    targetLoad: current.targetLoad,
    targetLoadUnit: current.targetLoadUnit,
    notes: current.notes,
    warmupNotes: current.warmupNotes,
    warmupSets: current.warmupSets,
    setNotes: current.setNotes,
  };
}

// --- Pain / notes ---

export async function logPain(input: z.infer<typeof painSchema>) {
  const parsed = painSchema.parse(input);
  const owned = await requireOwnedSessionExercise(
    parsed.sessionExerciseId
  );
  if (!owned.ok) return owned;
  const { user, db, sessionExercise } = owned;
  await logWorkoutPain(db, user.id, parsed);
  revalidatePath(`/session/${sessionExercise.sessionId}`);
  return { ok: true as const };
}

export async function saveExerciseNote(sessionExerciseId: string, note: string) {
  const owned = await requireOwnedSessionExercise(sessionExerciseId);
  if (!owned.ok) return owned;
  const { user, db, sessionExercise } = owned;
  const updated = await updateSessionExerciseWithVersion(
    db,
    user.id,
    sessionExercise.id,
    { notes: note.slice(0, 1000).trim() || null },
    "session_exercise.note_update",
    { activeOnly: true }
  );
  if (!updated.ok) return actionFailure("note_rejected", updated.reason);
  revalidatePath(`/session/${sessionExercise.sessionId}`);
  return updated;
}

// --- Finish ---

const completeSchema = z.object({
  sessionId: z.string().uuid(),
  note: z.string().max(2000).optional(),
  fatigue: z.number().int().min(1).max(5).optional(),
  durationDecision: z
    .discriminatedUnion("basis", [
      z.object({ basis: z.literal("wall_clock_no_stale_signal") }),
      z.object({
        basis: z.literal("owner_reported"),
        activeDurationSeconds: z.number().int().min(0).max(604_800),
      }),
      z.object({ basis: z.literal("interruption_unknown") }),
    ])
    .optional(),
  completionReason: incompleteSessionReasonSchema.optional(),
});

export async function completeSession(input: z.infer<typeof completeSchema>) {
  const parsed = completeSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await completeWorkoutSession(
    db,
    { id: user.id, coachingPrefs: user.profile.coachingPrefs },
    parsed,
    { now: acceptanceWorkoutNow("finish") },
  );
  if (
    result.outcome === "duration_review_required" ||
    result.outcome === "invalid_duration_review" ||
    result.outcome === "completion_reason_required" ||
    result.outcome === "completion_reason_not_applicable" ||
    result.outcome === "finish_payload_conflict"
  ) {
    return actionFailure(result.outcome, result.reason);
  }
  if (!result.alreadyFinished && result.progressionJobId) {
    const progressionJobId = result.progressionJobId;
    after(async () => {
      const workerDb = await getDb();
      await processProgressionJob(workerDb, progressionJobId);
    });
  }
  if (result.alreadyFinished) redirect(`/history/${result.sessionId}`);
  revalidatePath("/today");
  redirect(`/history/${result.sessionId}?finished=1`);
}

const activeDurationCorrectionSchema = z.object({
  sessionId: z.string().uuid(),
  clientMutationId: z.string().uuid(),
  expectedHistoryRevision: z.number().int().nonnegative(),
  expected: z.object({
    activeDurationSemanticsVersion: z.number().int().nullable().refine(
      (value) => value == null || value === 1,
      "Active-duration semantics changed. Reload this workout.",
    ),
    activeDurationSeconds: z.number().int().min(0).max(604_800).nullable(),
    activeDurationBasis: z.string().max(50).nullable().refine(
      (value) =>
        value == null || ACTIVE_WORKOUT_DURATION_BASES.some(
          (basis) => basis === value,
        ),
      "Active-duration evidence changed. Reload this workout.",
    ),
  }),
  decision: z.discriminatedUnion("basis", [
    z.object({
      basis: z.literal("owner_reported"),
      activeDurationSeconds: z.number().int().min(0).max(604_800),
    }),
    z.object({ basis: z.literal("interruption_unknown") }),
  ]),
});

export async function correctWorkoutActiveDuration(
  input: z.input<typeof activeDurationCorrectionSchema>,
) {
  const parsed = activeDurationCorrectionSchema.parse(input);
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await correctCompletedWorkoutActiveDuration(
    db,
    user.id,
    parsed,
  );
  if (!result.ok) {
    return actionFailure("duration_correction_rejected", result.reason);
  }
  revalidatePath(`/history/${result.sessionId}`);
  revalidatePath("/history");
  return result;
}

export async function abandonSession(sessionId: string) {
  const user = await getCurrentUser();
  const db = await getDb();
  const result = await abandonWorkoutSession(
    db,
    user.id,
    z.string().uuid().parse(sessionId),
  );
  if (result.alreadyFinished && result.status !== "abandoned") {
    return actionFailure(
      "abandon_rejected",
      "This workout was completed elsewhere and was not abandoned.",
    );
  }
  revalidatePath("/today");
  return { ok: true as const };
}
