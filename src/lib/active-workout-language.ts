export const ACTIVE_WORKOUT_LANGUAGE = {
  nextSet:
    "The next unfinished working set in the active workout. It does not advance until the save is safely acknowledged.",
  primaryAction:
    "The single dominant action that completes the current step: Log set.",
  adjustment:
    "A change to this workout occurrence only, such as a note, pain flag, approved alternative, or skip. It never changes the saved Program.",
  saved: "The server has safely acknowledged this set.",
  pending: "This device is retaining the set while it waits to send it.",
  retrying: "The device is trying the same stable set identity again.",
  failed:
    "The set needs attention and remains on this device until it is retried or explicitly removed.",
  effortCategory:
    "A quick human description: Easy, OK, Hard, or Grind. It is broader than an exact RPE value.",
  exactEffort:
    "A deliberately entered numeric RPE. Existing numeric RPE history remains unchanged.",
} as const;

export const EFFORT_CHOICES = [
  {
    category: "easy",
    label: "Easy",
    meaning: "about 4+ reps in reserve",
    legacyRpe: 6,
  },
  {
    category: "ok",
    label: "OK",
    meaning: "about 3 reps in reserve",
    legacyRpe: 7,
  },
  {
    category: "hard",
    label: "Hard",
    meaning: "about 1–2 reps in reserve",
    legacyRpe: 8,
  },
  {
    category: "grind",
    label: "Grind",
    meaning: "0 reps in reserve or visible slowing",
    legacyRpe: 9.5,
  },
] as const;

export type EffortCategory = (typeof EFFORT_CHOICES)[number]["category"];

export function effortChoiceForLegacyRpe(rpe: number | null) {
  return EFFORT_CHOICES.find((choice) => choice.legacyRpe === rpe) ?? null;
}
