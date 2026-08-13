import {
  OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY,
  readOccurrenceMutationOutbox,
  removeOccurrenceMutationOutboxEntryForSession,
} from "@/lib/occurrence-mutation-outbox";
import {
  readWorkoutSetOutbox,
  removeWorkoutSetOutboxEntryForSession,
  WORKOUT_SET_OUTBOX_STORAGE_KEY,
} from "@/lib/workout-set-outbox";

export type ActiveWorkoutDiscardStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

type DiscardResult =
  | { ok: true }
  | { ok: false; reason: string };

function restoreRaw(
  storage: ActiveWorkoutDiscardStorage,
  key: string,
  raw: string | null,
) {
  if (raw == null) storage.removeItem(key);
  else storage.setItem(key, raw);
}

export function activeWorkoutDiscardDialogOpenState(input: {
  currentOpen: boolean;
  requestedOpen: boolean;
  pending: boolean;
}) {
  if (input.pending && !input.requestedOpen) return input.currentOpen;
  return input.requestedOpen;
}

export async function discardSessionCopiesAndAbandon(input: {
  storage: ActiveWorkoutDiscardStorage;
  ownerId: string;
  sessionId: string;
  abandon: () => Promise<{ ok: boolean }>;
}): Promise<DiscardResult> {
  let originalSets: string | null;
  let originalOccurrences: string | null;
  try {
    originalSets = input.storage.getItem(WORKOUT_SET_OUTBOX_STORAGE_KEY);
    originalOccurrences = input.storage.getItem(
      OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY,
    );
  } catch {
    return {
      ok: false,
      reason: "Repbook could not safely open the device copies. Nothing was discarded.",
    };
  }

  // The caller holds both durable-queue locks. Re-read now rather than using
  // a render-time list: another tab may have queued work while the dialog was
  // open. Unreadable/unscopable copies are deliberately preserved.
  const setClientKeys = readWorkoutSetOutbox(input.storage).entries
    .filter(
      (entry) =>
        entry.ownerId === input.ownerId && entry.sessionId === input.sessionId,
    )
    .map((entry) => entry.clientKey);
  const occurrenceClientKeys = readOccurrenceMutationOutbox(
    input.storage,
  ).entries
    .filter(
      (entry) =>
        entry.ownerId === input.ownerId && entry.sessionId === input.sessionId,
    )
    .map((entry) => entry.clientKey);

  const rollback = () => {
    try {
      restoreRaw(
        input.storage,
        WORKOUT_SET_OUTBOX_STORAGE_KEY,
        originalSets,
      );
      restoreRaw(
        input.storage,
        OCCURRENCE_MUTATION_OUTBOX_STORAGE_KEY,
        originalOccurrences,
      );
      return true;
    } catch {
      return false;
    }
  };

  for (const clientKey of setClientKeys) {
    const removed = removeWorkoutSetOutboxEntryForSession(
      input.storage,
      input.ownerId,
      input.sessionId,
      clientKey,
    );
    if (!removed.ok) {
      const restored = rollback();
      return {
        ok: false,
        reason: restored
          ? `${removed.reason} Nothing was discarded.`
          : "Repbook could not restore the device copies after a storage failure. Keep this workout open and review the device-copy trays.",
      };
    }
  }

  for (const clientKey of occurrenceClientKeys) {
    const removed = removeOccurrenceMutationOutboxEntryForSession(
      input.storage,
      input.ownerId,
      input.sessionId,
      clientKey,
    );
    if (!removed.ok) {
      const restored = rollback();
      return {
        ok: false,
        reason: restored
          ? `${removed.reason} Nothing was discarded.`
          : "Repbook could not restore the device copies after a storage failure. Keep this workout open and review the device-copy trays.",
      };
    }
  }

  try {
    const result = await input.abandon();
    if (!result.ok) throw new Error("Server did not abandon the workout");
    return { ok: true };
  } catch {
    const restored = rollback();
    return {
      ok: false,
      reason: restored
        ? "Repbook did not confirm the workout was abandoned. The device copies were restored."
        : "Repbook did not confirm the workout was abandoned and could not restore the device copies. Keep this workout open and review the device-copy trays.",
    };
  }
}
