"use client";

import Image from "next/image";
import { useState } from "react";
import { Dumbbell, ImageOff } from "lucide-react";
import type { ExerciseMediaPreview } from "@/lib/exercise-discovery";
import { exerciseMediaDisplayState } from "@/lib/exercise-media-display";

function UnavailableMedia() {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center rounded-2xl border border-dashed bg-muted/25 px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ImageOff className="size-5" aria-hidden="true" />
      </span>
      <p className="mt-3 font-medium">Reference media unavailable right now</p>
      <p className="mt-1 max-w-md text-sm leading-5 text-muted-foreground">
        You can still choose this exercise and log your workout normally.
      </p>
    </div>
  );
}

export function ExerciseReferenceMedia({
  media,
  exerciseName,
}: {
  media: ExerciseMediaPreview | null | undefined;
  exerciseName: string;
}) {
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [videoFailed, setVideoFailed] = useState(false);
  const images = media?.images ?? [];
  const video = media?.video ?? null;
  const displayState = exerciseMediaDisplayState(
    media,
    failedImages,
    videoFailed
  );

  if (displayState === "missing") {
    return (
      <div className="flex min-h-44 flex-col items-center justify-center rounded-2xl border border-dashed bg-muted/25 px-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Dumbbell className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-3 font-medium">Reference media not added yet</p>
        <p className="mt-1 max-w-md text-sm leading-5 text-muted-foreground">
          This exercise is still fully usable. Media appears here only after an exact
          demonstration has been reviewed.
        </p>
      </div>
    );
  }

  if (displayState === "unavailable") return <UnavailableMedia />;

  return (
    <div className="space-y-3">
      {video && !videoFailed && (
        <video
          controls
          muted
          playsInline
          preload="metadata"
          poster={video.posterUrl ?? undefined}
          aria-label={video.title ?? `${exerciseName} demonstration`}
          className="aspect-video w-full rounded-2xl bg-black object-contain"
          onError={() => setVideoFailed(true)}
        >
          <source src={video.url} type="video/webm" />
          This browser cannot play the exercise demonstration.
        </video>
      )}
      {images.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {images.map((image) =>
            failedImages.has(image.url) ? (
              <UnavailableMedia key={image.url} />
            ) : (
              <Image
                key={image.url}
                src={image.url}
                alt={image.alt}
                width={image.width}
                height={image.height}
                sizes="(max-width: 640px) calc(100vw - 3rem), 24rem"
                className="aspect-[4/3] w-full rounded-xl border bg-muted object-contain"
                onError={() =>
                  setFailedImages((current) => new Set(current).add(image.url))
                }
              />
            )
          )}
        </div>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        General demonstration only—not personalized coaching. Stop if the movement
        causes pain.
      </p>
    </div>
  );
}
