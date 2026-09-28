import type { WorkoutCommand } from "@/lib/workout-command-queue";

/**
 * Recorded workout work that this device still holds for one session.
 * Equipment selections, notes and Coach messages are excluded: they are not
 * performed-set evidence and never decide whether the workout is saved.
 */
export type SessionDeviceWork = {
  savingSets: number;
  attentionSets: number;
  savingChanges: number;
  attentionChanges: number;
};

export const NO_SESSION_DEVICE_WORK: SessionDeviceWork = {
  savingSets: 0,
  attentionSets: 0,
  savingChanges: 0,
  attentionChanges: 0,
};

export function summarizeSessionDeviceWork(
  commands: readonly WorkoutCommand[],
  sessionId: string,
): SessionDeviceWork {
  const summary = { ...NO_SESSION_DEVICE_WORK };
  for (const command of commands) {
    if (command.kind !== "set" && command.kind !== "occurrence") continue;
    if (command.entry.sessionId !== sessionId) continue;
    const attention = command.entry.status === "needs_attention";
    if (command.kind === "set") {
      if (attention) summary.attentionSets += 1;
      else summary.savingSets += 1;
    } else if (attention) {
      summary.attentionChanges += 1;
    } else {
      summary.savingChanges += 1;
    }
  }
  return summary;
}

export function hasSessionDeviceWork(work: SessionDeviceWork) {
  return (
    work.savingSets +
      work.attentionSets +
      work.savingChanges +
      work.attentionChanges >
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

/** Plain-language device status for the Today resume card. */
export function describeSessionDeviceWork(work: SessionDeviceWork): {
  tone: "neutral" | "attention";
  title: string;
  detail: string;
} {
  const attention = countLabel(work.attentionSets, work.attentionChanges);
  const saving = countLabel(work.savingSets, work.savingChanges);
  if (attention) {
    const plural = work.attentionSets + work.attentionChanges > 1;
    return {
      tone: "attention",
      title: `${attention} need${plural ? "" : "s"} attention on this device`,
      detail: saving
        ? `${saving} also still saving. Resume to retry or discard the device copy.`
        : "Resume to retry or discard the device copy.",
    };
  }
  if (saving) {
    return {
      tone: "neutral",
      title: `${saving} still saving from this device`,
      detail: "Open the workout to finish saving and see where you are.",
    };
  }
  return {
    tone: "neutral",
    title: "Nothing from this workout is waiting on this device",
    detail: "",
  };
}
