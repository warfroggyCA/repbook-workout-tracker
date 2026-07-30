import { z } from "zod";

const MAX_INITIAL_SETS = 10;
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DRAFT_KEY_PREFIX = "workout-tracker:add-exercise:v1";

export const addWorkoutExerciseInputSchema = z.object({
  sessionId: z.string().uuid(),
  exerciseId: z.string().uuid(),
  mutationId: z.string().uuid(),
  expectedSessionRevision: z.number().int().min(0),
  initialSetCount: z.number().int().min(1).max(MAX_INITIAL_SETS),
  insertion: z.literal("end"),
});

export type AddWorkoutExerciseInput = z.infer<
  typeof addWorkoutExerciseInputSchema
>;

const storedDraftSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().uuid(),
  savedAt: z.number().int().nonnegative(),
  input: addWorkoutExerciseInputSchema,
});

export type StoredAddWorkoutExerciseDraft = z.infer<typeof storedDraftSchema>;

function draftKey(ownerId: string, sessionId: string) {
  return `${DRAFT_KEY_PREFIX}:${ownerId}:${sessionId}`;
}

export function readAddWorkoutExerciseDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
  ownerId: string,
  sessionId: string,
  now = Date.now(),
): StoredAddWorkoutExerciseDraft | null {
  const key = draftKey(ownerId, sessionId);
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = storedDraftSchema.parse(JSON.parse(raw));
    if (
      parsed.ownerId !== ownerId ||
      parsed.input.sessionId !== sessionId ||
      now - parsed.savedAt > DRAFT_MAX_AGE_MS
    ) {
      storage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writeAddWorkoutExerciseDraft(
  storage: Pick<Storage, "setItem">,
  ownerId: string,
  input: AddWorkoutExerciseInput,
  now = Date.now(),
) {
  const parsed = addWorkoutExerciseInputSchema.parse(input);
  storage.setItem(
    draftKey(ownerId, parsed.sessionId),
    JSON.stringify({
      version: 1,
      ownerId,
      savedAt: now,
      input: parsed,
    } satisfies StoredAddWorkoutExerciseDraft),
  );
}

export function clearAddWorkoutExerciseDraft(
  storage: Pick<Storage, "removeItem">,
  ownerId: string,
  sessionId: string,
) {
  storage.removeItem(draftKey(ownerId, sessionId));
}
