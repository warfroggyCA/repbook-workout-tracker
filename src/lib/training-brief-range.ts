export const TRAINING_BRIEF_RANGE_OPTIONS = [
  { key: "4w", label: "Last 4 weeks", weeks: 4 },
  { key: "12w", label: "Last 12 weeks", weeks: 12 },
  { key: "6m", label: "Last 6 months", weeks: 26 },
  { key: "1y", label: "Last year", weeks: 52 },
] as const;

export const DEFAULT_TRAINING_BRIEF_RANGE_KEY = "12w";

export function resolveTrainingBriefRange(
  value: string | string[] | undefined,
) {
  const selected =
    typeof value === "string"
      ? TRAINING_BRIEF_RANGE_OPTIONS.find((option) => option.key === value)
      : undefined;

  return {
    option:
      selected ??
      TRAINING_BRIEF_RANGE_OPTIONS.find(
        (option) => option.key === DEFAULT_TRAINING_BRIEF_RANGE_KEY,
      )!,
    selectedFromAllTime: value === "all",
  };
}
