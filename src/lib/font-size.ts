export const FONT_SIZE_OPTIONS = [
  { key: "compact", label: "Compact", detail: "100%" },
  { key: "default", label: "Default", detail: "115%" },
  { key: "large", label: "Large", detail: "130%" },
  { key: "extra-large", label: "Extra large", detail: "145%" },
] as const;

export type FontSizeKey = (typeof FONT_SIZE_OPTIONS)[number]["key"];

export const DEFAULT_FONT_SIZE: FontSizeKey = "default";
export const FONT_SIZE_STORAGE_KEY = "workout-font-size";
export const FONT_SIZE_EVENT = "workout-font-size-change";

export function isFontSizeKey(value: unknown): value is FontSizeKey {
  return (
    typeof value === "string" &&
    FONT_SIZE_OPTIONS.some((option) => option.key === value)
  );
}

export function normalizeFontSize(value: unknown): FontSizeKey {
  return isFontSizeKey(value) ? value : DEFAULT_FONT_SIZE;
}
