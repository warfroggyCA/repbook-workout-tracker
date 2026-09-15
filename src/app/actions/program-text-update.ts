"use server";

import { z } from "zod";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { isProgramEditorEnabled } from "@/lib/program-editor-feature";
import { getOpenProgramDraft } from "@/services/program-drafts";
import { getLibraryWithAvailability } from "@/services/routine-import";
import { loadVisibleExercises } from "@/services/exercise-map";
import { parseProgramTextUpdate } from "@/lib/program-text-parser";
import {
  buildProgramTextProposal,
  type ProgramTextProposal,
} from "@/lib/program-text-update";

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
  try {
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
    const [library, visible] = await Promise.all([
      getLibraryWithAvailability(db, user.id),
      loadVisibleExercises(db, user.id),
    ]);
    const aliases = new Map(
      visible.map((exercise) => [
        exercise.id,
        exercise.aliases.map((item) => item.alias),
      ]),
    );
    const result = parseProgramTextUpdate(
      current,
      parsed.data.text,
      library.map((exercise) => ({
        ...exercise,
        aliases: aliases.get(exercise.id) ?? [],
      })),
      parsed.data.activeDayId,
    );
    // Parsing is local: no provider request, AI quota claim, or raw paste storage.
    // Accepted edits use existing autosave, revision and publication boundaries.
    const proposal = buildProgramTextProposal(
      current,
      result,
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
  } catch {
    return {
      ok: false,
      reason:
        "These changes could not be validated against the saved Program. Your text is still here and no proposal was applied. Check conflicting instructions and numeric limits, then compare again.",
    };
  }
}
