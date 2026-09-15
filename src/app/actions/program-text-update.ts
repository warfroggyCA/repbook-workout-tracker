"use server";

import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import { isAIAvailable } from "@/ai/provider";
import { programUpdateSchema } from "@/ai/tasks/program-update/schema";
import { PROGRAM_UPDATE_SYSTEM } from "@/ai/tasks/program-update/prompt";
import { getOpenProgramDraft } from "@/services/program-drafts";
import { getLibraryWithAvailability } from "@/services/routine-import";
import {
  runControlledStructuredGeneration,
  AIControlError,
} from "@/services/ai-control";
import {
  buildProgramTextProposal,
  type ProgramTextProposal,
} from "@/lib/program-text-update";
import { sanitizeAIProviderError } from "@/lib/ai-provider-error";
import { logDiagnosticEvent } from "@/lib/server-log";
import { programAIFailureMessage } from "@/lib/program-ai-failure";

const requestSchema = z
  .object({
    text: z.string().trim().min(1).max(20000),
    draftId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    activeDayId: z.string().uuid().nullable(),
  })
  .strict();
export async function proposeProgramTextUpdate(
  input: z.infer<typeof requestSchema>,
): Promise<
  { ok: true; proposal: ProgramTextProposal } | { ok: false; reason: string }
> {
  const user = await getCurrentUser();
  if (!isProgramEditorEnabled())
    return {
      ok: false,
      reason:
        "Program editing is currently unavailable. Your request is still here.",
    };
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      reason:
        "Enter a request of up to 20,000 characters and wait for the draft to save.",
    };
  if (!isAIAvailable())
    return {
      ok: false,
      reason:
        "AI access needs configuration before text changes can be prepared. Your request and Program are unchanged.",
    };
  const db = await getDb();
  const saved = await getOpenProgramDraft(db, user.id);
  if (
    !saved ||
    saved.draft.id !== parsed.data.draftId ||
    saved.draft.revision !== parsed.data.revision ||
    saved.baseAdvanced
  )
    return {
      ok: false,
      reason: "The draft changed. Wait for it to save, then compare again.",
    };
  const current = saved.draft.document;
  const library = await getLibraryWithAvailability(db, user.id);
  try {
    const result = await runControlledStructuredGeneration(db, user.id, {
      task: "routine_build",
      system: PROGRAM_UPDATE_SYSTEM,
      input: JSON.stringify({
        mode: "program-update",
        request: parsed.data.text,
        focusedDayId: parsed.data.activeDayId,
        currentProgram: current,
        exercises: library
          .filter(
            (item) =>
              item.available ||
              current.days.some((day) =>
                day.exercises.some((slot) => slot.exerciseId === item.id),
              ),
          )
          .map((item) => ({
            id: item.id,
            name: item.name,
            available: item.available,
            unavailableReason: item.unavailableReason,
          })),
      }),
      schema: programUpdateSchema,
      deadlineMs: 110000,
      logicalKey: `program-update:${saved.draft.id}:${saved.draft.revision}`,
    });
    // No raw request/provider output is persisted. The accepted document uses
    // the existing autosave, exact-revision review and publication boundaries.
    const proposal = buildProgramTextProposal(
      current,
      result.value,
      parsed.data.text,
      library,
    );
    const latest = await getOpenProgramDraft(db, user.id);
    if (
      !latest ||
      latest.draft.id !== saved.draft.id ||
      latest.draft.revision !== saved.draft.revision ||
      latest.baseAdvanced
    )
      return {
        ok: false,
        reason:
          "The draft changed while the proposal was being prepared. Compare again using the current draft.",
      };
    return { ok: true, proposal };
  } catch (error) {
    if (error instanceof AIControlError)
      return {
        ok: false,
        reason: `${error.message} Your request is still here.`,
      };
    const safe = sanitizeAIProviderError(error);
    logDiagnosticEvent("ai.setup_routine_build_failed", {
      errorKind: safe.errorKind,
      providerStatusCode: safe.providerStatusCode,
      providerRetryable: safe.providerRetryable,
      causeKind: safe.causeKind,
    });
    return { ok: false, reason: programAIFailureMessage(safe) };
  }
}
