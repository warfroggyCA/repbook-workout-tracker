export function fitRoutineSetNotes(
  notes: Array<string | null> | undefined,
  sets: number
): Array<string | null> {
  return Array.from({ length: sets }, (_, index) => notes?.[index] ?? null);
}

export function moveRoutineItem<T>(
  items: T[],
  fromIndex: number,
  toIndex: number
): T[] {
  if (
    fromIndex < 0 ||
    fromIndex >= items.length ||
    toIndex < 0 ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
