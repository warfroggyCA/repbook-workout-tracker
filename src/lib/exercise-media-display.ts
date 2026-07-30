import type { ExerciseMediaPreview } from "@/lib/exercise-discovery";

export type ExerciseMediaDisplayState = "missing" | "available" | "unavailable";

/** Shared fallback decision so failed assets never block the surrounding flow. */
export function exerciseMediaDisplayState(
  media: ExerciseMediaPreview | null | undefined,
  failedImageUrls: ReadonlySet<string> = new Set(),
  videoFailed = false
): ExerciseMediaDisplayState {
  const images = media?.images ?? [];
  const video = media?.video ?? null;
  if (images.length === 0 && !video) return "missing";
  if (
    images.every((image) => failedImageUrls.has(image.url)) &&
    (!video || videoFailed)
  ) {
    return "unavailable";
  }
  return "available";
}
