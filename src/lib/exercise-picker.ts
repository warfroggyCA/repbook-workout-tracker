export function exercisePickerSelectionState(input: {
  available: boolean;
  permitted: boolean;
  unavailableReason: string | null;
  disabledReason?: string;
}) {
  const selectable = input.available && input.permitted;
  return {
    selectable,
    reason: selectable
      ? null
      : !input.available
        ? input.unavailableReason
        : (input.disabledReason ?? "not a compatible choice here"),
  };
}

export function reconcileExercisePickerInspection<T extends { id: string }>(
  items: T[],
  inspected: T | null,
) {
  if (inspected == null) return { display: null, current: null };
  const current = items.find((item) => item.id === inspected.id) ?? null;
  return {
    display: current ?? inspected,
    current,
  };
}
