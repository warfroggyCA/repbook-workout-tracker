export const ACTIVE_WORKOUT_LANGUAGE = {
  nextSet:
    "Your next set. It advances when your result finishes saving.",
  primaryAction:
    "Tap Log set when you finish the set.",
  adjustment:
    "Add a note, record pain, replace an exercise, or skip it for this workout. Your saved plan stays the same.",
  saved: "Your set has finished saving.",
  pending: "Your set is kept on this device while it waits to save.",
  retrying: "Retrying the save without adding a duplicate set.",
  failed:
    "This set needs attention. Retry saving it or discard the copy on this device.",
  effortCategory:
    "Choose how the set felt: Easy, OK, Hard, or Grind.",
  exactEffort:
    "Rate your effort on the RPE scale. Earlier ratings stay the same.",
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
