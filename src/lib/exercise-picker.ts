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
