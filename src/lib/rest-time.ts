export const REST_SECOND_CHOICES = [0, 15, 30, 45] as const;

export function formatRestTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.trunc(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) return `${remainder} sec`;
  if (remainder === 0) return `${minutes} min`;
  return `${minutes} min ${remainder} sec`;
}

export function restTimeParts(totalSeconds: number) {
  const seconds = Math.max(0, Math.trunc(totalSeconds));
  return {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
    isCustom: seconds % 15 !== 0,
  };
}

export function restTimeFromParts(minutes: number, seconds: number): number {
  return Math.max(0, Math.min(1800, Math.trunc(minutes) * 60 + Math.trunc(seconds)));
}
