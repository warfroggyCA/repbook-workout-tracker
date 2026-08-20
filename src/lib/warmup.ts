export type WarmupSetDisplayInput = {
  label: string;
  reps?: number | null;
  load?: number | null;
  loadUnit?: "lb" | "kg" | null;
  loadPercent?: number | null;
  loadText?: string | null;
  notes?: string | null;
};

export function hasProgrammedWarmupActions(input: {
  dayWarmupItems: readonly unknown[];
  exerciseWarmupSets: ReadonlyArray<readonly unknown[]>;
}): boolean {
  return (
    input.dayWarmupItems.length > 0 ||
    input.exerciseWarmupSets.some((sets) => sets.length > 0)
  );
}

function normalizedPart(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** A concise training instruction, shared by Program, workout, and History. */
export function formatWarmupSetLine(set: WarmupSetDisplayInput): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    const key = normalizedPart(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(trimmed);
  };

  add(set.label);
  if (set.load != null) {
    add(`${set.load}${set.loadUnit ? ` ${set.loadUnit}` : ""}`);
  } else if (set.loadPercent != null) {
    add(`${set.loadPercent}% of work weight`);
  } else {
    add(set.loadText);
  }
  if (set.reps != null) add(`${set.reps} reps`);
  add(set.notes);

  return parts.join(" · ");
}
