import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import {
  exerciseMediaAssets,
  exerciseMediaAssociations,
} from "@/db/schema";
import type { ExerciseVariantAttributes } from "@/db/schema/exercise";
import type { ExerciseMediaPreview } from "@/lib/exercise-discovery";

export type MediaMatchExercise = {
  id: string;
  familyId: string | null;
  equipment: string[];
  variantAttributes: ExerciseVariantAttributes;
};

export type MediaMatchAssociation = {
  exerciseId: string | null;
  familyId: string | null;
  matchScope: "exact_variant" | "equivalent_family";
  equipmentSignature: string[];
  variantAttributes: Record<string, string | boolean | null>;
};

function normalizedEquipment(values: string[]) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function normalizedAttributes(
  values: Record<string, string | boolean | null | undefined>
) {
  return Object.fromEntries(
    Object.entries(values)
      .filter((entry): entry is [string, string | boolean | null] =>
        entry[1] !== undefined
      )
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

/** Family sharing fails closed unless equipment and variant identity are exact. */
export function mediaAssociationMatchesExercise(
  exercise: MediaMatchExercise,
  association: MediaMatchAssociation
) {
  if (association.matchScope === "exact_variant") {
    return association.exerciseId === exercise.id && association.familyId === null;
  }
  if (
    association.exerciseId !== null ||
    association.familyId === null ||
    association.familyId !== exercise.familyId
  ) {
    return false;
  }
  return (
    JSON.stringify(normalizedEquipment(association.equipmentSignature)) ===
      JSON.stringify(normalizedEquipment(exercise.equipment)) &&
    JSON.stringify(normalizedAttributes(association.variantAttributes)) ===
      JSON.stringify(normalizedAttributes(exercise.variantAttributes))
  );
}

type MediaRow = {
  assetId: string;
  mediaType: "image" | "video";
  displayUrl: string;
  hosting: "app_managed" | "external";
  redistributionAllowed: boolean;
  width: number | null;
  height: number | null;
  altText: string;
  title: string | null;
  exerciseId: string | null;
  familyId: string | null;
  matchScope: "exact_variant" | "equivalent_family";
  equipmentSignature: string[];
  variantAttributes: Record<string, string | boolean | null>;
  sortOrder: number;
  isThumbnail: boolean;
  isPreferred: boolean;
};

function projectMedia(rows: MediaRow[]): ExerciseMediaPreview | null {
  const safeRows = rows.filter((row) =>
    row.hosting === "app_managed"
      ? row.redistributionAllowed &&
        /^\/exercise-media\/[a-z0-9][a-z0-9._/-]*$/i.test(row.displayUrl)
      : /^https:\/\//i.test(row.displayUrl)
  );
  const images = safeRows
    .filter(
      (row): row is MediaRow & { width: number; height: number } =>
        row.mediaType === "image" && row.width != null && row.height != null
    )
    .map((row) => ({
      url: row.displayUrl,
      alt: row.altText,
      width: row.width,
      height: row.height,
    }));
  const videos = safeRows.filter((row) => row.mediaType === "video");
  const video = videos.find((row) => row.isPreferred) ?? videos[0] ?? null;
  if (images.length === 0 && !video) return null;
  const thumbnailRow =
    safeRows.find(
      (row) =>
        row.mediaType === "image" &&
        row.isThumbnail &&
        row.width != null &&
        row.height != null
    ) ?? safeRows.find((row) => row.mediaType === "image");
  return {
    thumbnailUrl: thumbnailRow?.displayUrl ?? null,
    kind: video?.isPreferred ? "video" : images.length > 0 ? "image" : "video",
    images,
    video: video
      ? {
          url: video.displayUrl,
          posterUrl: null,
          title: video.title,
        }
      : null,
  };
}

/**
 * Returns a training-only projection. Source pages, creators, licences,
 * attribution, checksums, review notes, and approval fields stay server-only.
 */
export async function getApprovedExerciseMedia(
  db: Db,
  library: MediaMatchExercise[]
): Promise<Map<string, ExerciseMediaPreview>> {
  if (library.length === 0) return new Map();
  const rows = await db
    .select({
      assetId: exerciseMediaAssets.id,
      mediaType: exerciseMediaAssets.mediaType,
      displayUrl: exerciseMediaAssets.displayUrl,
      hosting: exerciseMediaAssets.hosting,
      redistributionAllowed: exerciseMediaAssets.redistributionAllowed,
      width: exerciseMediaAssets.width,
      height: exerciseMediaAssets.height,
      altText: exerciseMediaAssets.altText,
      title: exerciseMediaAssets.title,
      exerciseId: exerciseMediaAssociations.exerciseId,
      familyId: exerciseMediaAssociations.familyId,
      matchScope: exerciseMediaAssociations.matchScope,
      equipmentSignature: exerciseMediaAssociations.equipmentSignature,
      variantAttributes: exerciseMediaAssociations.variantAttributes,
      sortOrder: exerciseMediaAssociations.sortOrder,
      isThumbnail: exerciseMediaAssociations.isThumbnail,
      isPreferred: exerciseMediaAssociations.isPreferred,
    })
    .from(exerciseMediaAssociations)
    .innerJoin(
      exerciseMediaAssets,
      eq(exerciseMediaAssociations.assetId, exerciseMediaAssets.id)
    )
    .where(
      and(
        eq(exerciseMediaAssets.status, "approved"),
        isNull(exerciseMediaAssets.disabledAt),
        isNull(exerciseMediaAssets.withdrawnAt)
      )
    )
    .orderBy(asc(exerciseMediaAssociations.sortOrder), asc(exerciseMediaAssets.id));

  const result = new Map<string, ExerciseMediaPreview>();
  for (const exercise of library) {
    const matched = rows.filter((row) =>
      mediaAssociationMatchesExercise(exercise, row)
    );
    const projected = projectMedia(matched);
    if (projected) result.set(exercise.id, projected);
  }
  return result;
}
