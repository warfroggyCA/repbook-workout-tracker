import type { OccurrenceMutationOutboxSnapshot } from "@/lib/occurrence-mutation-outbox";
import { sessionScopedDeviceCopies } from "@/lib/session-runner";
import type { WorkoutSetOutboxSnapshot } from "@/lib/workout-set-outbox";

/**
 * Recorded workout work that this device may still hold for one session:
 * logged sets and workout changes (skips, restores, warm-up completions and
 * other occurrence changes). Equipment choices, contextual notes and Live
 * Coach messages are not recorded work and are deliberately not read here.
 *
 * Unreadable evidence is never counted as "nothing waiting". A quarantined
 * set copy has no trustworthy session identity, so, as Finish does, it is
 * treated as possibly belonging to this workout.
 */
export type SessionDeviceWork = {
  savingSets: number;
  attentionSets: number;
  savingChanges: number;
  attentionChanges: number;
  /** Set copies kept for review because they could not be read. */
  unreadableSetCopies: number;
  setQueueUnreadable: boolean;
  changeQueueUnreadable: boolean;
  /** This browser refused access to device storage altogether. */
  storageUnavailable: boolean;
};

export const NO_SESSION_DEVICE_WORK: SessionDeviceWork = {
  savingSets: 0,
  attentionSets: 0,
  savingChanges: 0,
  attentionChanges: 0,
  unreadableSetCopies: 0,
  setQueueUnreadable: false,
  changeQueueUnreadable: false,
  storageUnavailable: false,
};

export const UNAVAILABLE_SESSION_DEVICE_WORK: SessionDeviceWork = {
  ...NO_SESSION_DEVICE_WORK,
  storageUnavailable: true,
};

export function summarizeSessionDeviceWork(input: {
  ownerId: string;
  sessionId: string;
  sets: Pick<WorkoutSetOutboxSnapshot, "entries" | "quarantined" | "error">;
  changes: Pick<OccurrenceMutationOutboxSnapshot, "entries" | "error">;
}): SessionDeviceWork {
  const scoped = sessionScopedDeviceCopies({
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    setCopies: input.sets.entries,
    occurrenceCopies: input.changes.entries,
  });
  const attention = (entry: { status: string }) =>
    entry.status === "needs_attention";
  return {
    savingSets: scoped.setCopies.filter((entry) => !attention(entry)).length,
    attentionSets: scoped.setCopies.filter(attention).length,
    savingChanges: scoped.occurrenceCopies.filter((entry) => !attention(entry))
      .length,
    attentionChanges: scoped.occurrenceCopies.filter(attention).length,
    unreadableSetCopies: input.sets.quarantined.length,
    setQueueUnreadable: input.sets.error != null,
    changeQueueUnreadable: input.changes.error != null,
    storageUnavailable: false,
  };
}

export function sessionDeviceWorkIsUnknown(work: SessionDeviceWork) {
  return (
    work.storageUnavailable ||
    work.setQueueUnreadable ||
    work.changeQueueUnreadable ||
    work.unreadableSetCopies > 0
  );
}

/** True only when every recorded-work queue was read and holds nothing. */
export function sessionDeviceWorkIsClear(work: SessionDeviceWork) {
  return (
    !sessionDeviceWorkIsUnknown(work) &&
    work.savingSets +
      work.attentionSets +
      work.savingChanges +
      work.attentionChanges ===
      0
  );
}

function countLabel(sets: number, changes: number) {
  const parts: string[] = [];
  if (sets > 0) parts.push(`${sets} set${sets === 1 ? "" : "s"}`);
  if (changes > 0) {
    parts.push(`${changes} workout change${changes === 1 ? "" : "s"}`);
  }
  return parts.join(" and ");
}

function deviceCopies(count: number) {
  return count === 1 ? "device copy" : "device copies";
}

export type SessionDeviceWorkDescription = {
  state: "clear" | "saving" | "attention" | "unknown";
  title: string;
  detail: string;
};

/** Plain-language device status for the Today resume card. */
export function describeSessionDeviceWork(
  work: SessionDeviceWork,
): SessionDeviceWorkDescription {
  const attention = countLabel(work.attentionSets, work.attentionChanges);
  const saving = countLabel(work.savingSets, work.savingChanges);

  if (sessionDeviceWorkIsUnknown(work)) {
    const reasons: string[] = [];
    if (work.storageUnavailable) {
      reasons.push("This browser would not open this device's saved workout copies.");
    } else {
      if (work.setQueueUnreadable) {
        reasons.push("The list of sets saved on this device could not be read.");
      }
      if (work.unreadableSetCopies > 0) {
        const copies = work.unreadableSetCopies;
        reasons.push(
          `${copies} set ${copies === 1 ? "copy" : "copies"} on this device could not be read and may belong to this workout.`,
        );
      }
      if (work.changeQueueUnreadable) {
        reasons.push(
          "The list of workout changes saved on this device could not be read.",
        );
      }
    }
    const known = [
      attention ? `${attention} need${work.attentionSets + work.attentionChanges === 1 ? "s" : ""} attention.` : null,
      saving ? `${saving} still saving.` : null,
    ].filter(Boolean);
    return {
      state: "unknown",
      title: "Repbook can't confirm what's waiting on this device",
      detail: [
        ...reasons,
        ...known,
        "Resume to review before relying on this workout's saved position.",
      ].join(" "),
    };
  }
  if (attention) {
    const count = work.attentionSets + work.attentionChanges;
    return {
      state: "attention",
      title: `${attention} need${count === 1 ? "s" : ""} attention on this device`,
      detail: saving
        ? `${saving} also still saving. Resume to retry or discard the ${deviceCopies(count)}.`
        : `Resume to retry or discard the ${deviceCopies(count)}.`,
    };
  }
  if (saving) {
    return {
      state: "saving",
      title: `${saving} still saving from this device`,
      detail: "Open the workout to finish saving and see where you are.",
    };
  }
  return {
    state: "clear",
    title: "No sets or workout changes from this workout are waiting on this device",
    detail: "",
  };
}
