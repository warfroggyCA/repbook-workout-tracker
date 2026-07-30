import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import {
  exerciseMediaAssets,
  exerciseMediaAssociations,
  exercises,
} from "@/db/schema";

const reviewedAt = new Date("2026-07-12T00:00:00.000Z");

const trustedMedia = [
  {
    exerciseName: "Romanian Deadlift",
    associationId: "11f44cc2-7f6f-47d3-900d-1034987fdd1e",
    sortOrder: 0,
    isThumbnail: true,
    asset: {
      id: "ab6a79d4-8043-4558-9f91-4ebcd24aa39c",
      mediaType: "image" as const,
      displayUrl: "/exercise-media/romanian-deadlift-start-a85465a0.png",
      originalAssetUrl:
        "https://upload.wikimedia.org/wikipedia/commons/e/e8/Romanian-deadlift-1.png",
      sourcePageUrl:
        "https://commons.wikimedia.org/wiki/File:Romanian-deadlift-1.png",
      creator: "Everkinetic",
      license: "CC BY-SA 3.0",
      attributionText:
        "Romanian Deadlift illustration by Everkinetic, CC BY-SA 3.0, via Wikimedia Commons; unchanged.",
      checksumSha256:
        "a85465a0715d9df543a10c3c3cea5d3ce968d91564b4583b3699b3b7aa6ce5f2",
      width: 620,
      height: 900,
      altText: "Romanian Deadlift standing start position with a barbell",
      title: "Romanian Deadlift start position",
      rightsEvidence: {
        licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
        sourceFileSha1: "d8e9999a1511c45f881937c545ece05f45f747ff",
        sourcePageRevisionId: "1026583798",
        attributionRequired: true,
        reviewNotes:
          "Exact barbell Romanian Deadlift start position; source file and licence reviewed independently.",
      },
    },
  },
  {
    exerciseName: "Romanian Deadlift",
    associationId: "66e55d2b-3c1b-4907-8451-1e283690e9b3",
    sortOrder: 1,
    isThumbnail: false,
    asset: {
      id: "71aceaa7-99af-4b31-ac9e-141e6db2f2ec",
      mediaType: "image" as const,
      displayUrl: "/exercise-media/romanian-deadlift-hinge-85acc562.png",
      originalAssetUrl:
        "https://upload.wikimedia.org/wikipedia/commons/5/58/Romanian-deadlift-2.png",
      sourcePageUrl:
        "https://commons.wikimedia.org/wiki/File:Romanian-deadlift-2.png",
      creator: "Everkinetic",
      license: "CC BY-SA 3.0",
      attributionText:
        "Romanian Deadlift illustration by Everkinetic, CC BY-SA 3.0, via Wikimedia Commons; unchanged.",
      checksumSha256:
        "85acc5626dcf39401e60f71092c8940f520968420b076033d39ec32eae0b72d0",
      width: 620,
      height: 900,
      altText: "Romanian Deadlift bottom hinge position with a barbell",
      title: "Romanian Deadlift hinge position",
      rightsEvidence: {
        licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
        sourceFileSha1: "2d48968b4c44c154598d5391cd6d9e4f1a929cea",
        sourcePageRevisionId: "1180567879",
        attributionRequired: true,
        reviewNotes:
          "Exact barbell Romanian Deadlift hinge position; source file and licence reviewed independently.",
      },
    },
  },
  {
    exerciseName: "Hammer Curl",
    associationId: "387cb44a-5f82-426e-855b-9f7c5d07f3c3",
    sortOrder: 0,
    isThumbnail: true,
    asset: {
      id: "b79fcce2-026b-40d9-b2a5-0bf775c191a8",
      mediaType: "image" as const,
      displayUrl: "/exercise-media/hammer-curl-start-b4b0c52a.png",
      originalAssetUrl:
        "https://upload.wikimedia.org/wikipedia/commons/6/66/Bicep-hammer-curl-1.png",
      sourcePageUrl:
        "https://commons.wikimedia.org/wiki/File:Bicep-hammer-curl-1.png",
      creator: "Everkinetic",
      license: "CC BY-SA 3.0",
      attributionText:
        "Hammer Curl illustration by Everkinetic, CC BY-SA 3.0, via Wikimedia Commons; unchanged.",
      checksumSha256:
        "b4b0c52acf93f82842c1e4035086fd3836ad837fcab2fd7cb3107920b659d92b",
      width: 221,
      height: 275,
      altText: "Hammer Curl standing start position with neutral-grip dumbbells",
      title: "Hammer Curl start position",
      rightsEvidence: {
        licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
        sourceFileSha1: "9e788575151ba313be86956112eedcdccebc0fd1",
        sourcePageRevisionId: "823226105",
        attributionRequired: true,
        reviewNotes:
          "Exact bilateral standing dumbbell Hammer Curl start position; source file and licence reviewed independently.",
      },
    },
  },
  {
    exerciseName: "Hammer Curl",
    associationId: "9996e149-607d-4266-b042-bc1595af430b",
    sortOrder: 1,
    isThumbnail: false,
    asset: {
      id: "d02001ba-9116-4efe-88d2-d1ab31069bc1",
      mediaType: "image" as const,
      displayUrl: "/exercise-media/hammer-curl-top-63606712.png",
      originalAssetUrl:
        "https://upload.wikimedia.org/wikipedia/commons/8/86/Bicep-hammer-curl-2.png",
      sourcePageUrl:
        "https://commons.wikimedia.org/wiki/File:Bicep-hammer-curl-2.png",
      creator: "Everkinetic",
      license: "CC BY-SA 3.0",
      attributionText:
        "Hammer Curl illustration by Everkinetic, CC BY-SA 3.0, via Wikimedia Commons; unchanged.",
      checksumSha256:
        "63606712c389bfe86ce626fa33f8f64c51dbed02b97de542c65bf52a3e5fc07b",
      width: 221,
      height: 275,
      altText: "Hammer Curl top position with neutral-grip dumbbells",
      title: "Hammer Curl top position",
      rightsEvidence: {
        licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
        sourceFileSha1: "f5705ad0eddd8736c10b7968e8e30758b81b0c67",
        sourcePageRevisionId: "823226108",
        attributionRequired: true,
        reviewNotes:
          "Exact bilateral standing dumbbell Hammer Curl top position; source file and licence reviewed independently.",
      },
    },
  },
  {
    exerciseName: "Seated Cable Row",
    associationId: "908fc3d5-a2b8-4b18-9c25-c1d86b8d4353",
    sortOrder: 0,
    isThumbnail: true,
    asset: {
      id: "c92bca3d-3248-4442-a145-2d6022aed648",
      mediaType: "image" as const,
      displayUrl: "/exercise-media/seated-cable-row-eb4788dd.jpg",
      originalAssetUrl:
        "https://upload.wikimedia.org/wikipedia/commons/0/0a/Woman_using_a_seated_cable_row_machine_at_the_gym.jpg",
      sourcePageUrl:
        "https://commons.wikimedia.org/wiki/File:Woman_using_a_seated_cable_row_machine_at_the_gym.jpg",
      creator: "Miguel Angel Omaña Rojas",
      license: "CC0 1.0",
      attributionText: null,
      checksumSha256:
        "eb4788dd9ba6cd43c78034c01980540f22bfdb79a2d061d75b833c0308886c83",
      width: 1200,
      height: 834,
      altText: "Seated Cable Row using a cable rowing station",
      title: "Seated Cable Row reference",
      rightsEvidence: {
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        sourceFileSha1: "8f0ef82931b2185fd16161ea7e96052d8cb4e3bf",
        sourcePageRevisionId: "1189157118",
        attributionRequired: false,
        reviewNotes:
          "Exact seated cable rowing station and movement setup; uploader recorded own work, subject consent, and CC0 dedication.",
      },
    },
  },
  {
    exerciseName: "Barbell Bench Press",
    associationId: "2013d5db-267d-420d-99af-efc6507d64a6",
    sortOrder: 0,
    isThumbnail: false,
    asset: {
      id: "b1e6dea3-5723-4554-87b8-25099153cc3c",
      mediaType: "video" as const,
      displayUrl: "/exercise-media/barbell-bench-press-4b843d33.webm",
      originalAssetUrl:
        "https://upload.wikimedia.org/wikipedia/commons/d/df/Bench_press_-_exercise_demonstration_video.webm",
      sourcePageUrl:
        "https://commons.wikimedia.org/wiki/File:Bench_press_-_exercise_demonstration_video.webm",
      creator: "FitnessScape",
      license: "CC BY 3.0",
      attributionText:
        "Barbell Bench Press demonstration by FitnessScape, CC BY 3.0, via Wikimedia Commons; unchanged.",
      checksumSha256:
        "4b843d33d7b439884ed64d722edc6c7c46a3430060d4e2059f42b103e9187be7",
      width: 1280,
      height: 720,
      durationSeconds: 7.1,
      altText: "Short Barbell Bench Press demonstration in a rack",
      title: "Barbell Bench Press demonstration",
      rightsEvidence: {
        licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
        sourceFileSha1: "619a8ca8c5ad851bb6b7d1775f8babefd478e623",
        sourcePageRevisionId: "1145684665",
        attributionRequired: true,
        reviewNotes:
          "Exact short Barbell Bench Press demonstration with side safety racks; Commons retains the original YouTube source and reviewed licence evidence.",
      },
    },
  },
] as const;

export async function seedTrustedExerciseMedia(db: Db) {
  let assets = 0;
  let associations = 0;
  const missingExercises: string[] = [];

  for (const entry of trustedMedia) {
    const exercise = await db.query.exercises.findFirst({
      where: eq(exercises.name, entry.exerciseName),
      with: { equipmentRequirements: true },
    });
    if (!exercise || exercise.userId !== null) {
      missingExercises.push(entry.exerciseName);
      continue;
    }
    const { id: assetId, ...assetData } = entry.asset;
    const assetValues = {
      ...assetData,
      hosting: "app_managed" as const,
      redistributionAllowed: true,
      reviewedAt,
      status: "approved" as const,
      disabledAt: null,
      disabledReason: null,
      withdrawnAt: null,
      updatedAt: reviewedAt,
    };
    const [insertedAsset] = await db
      .insert(exerciseMediaAssets)
      .values({ id: assetId, ...assetValues })
      .onConflictDoUpdate({
        target: exerciseMediaAssets.checksumSha256,
        set: assetValues,
      })
      .returning({ id: exerciseMediaAssets.id });
    assets += 1;

    const equipmentSignature = [
      ...new Set(
        exercise.equipmentRequirements.map((requirement) => requirement.equipmentType)
      ),
    ].sort((a, b) => a.localeCompare(b));
    await db
      .insert(exerciseMediaAssociations)
      .values({
        id: entry.associationId,
        assetId: insertedAsset.id,
        exerciseId: exercise.id,
        familyId: null,
        matchScope: "exact_variant",
        equipmentSignature,
        variantAttributes: exercise.variantAttributes,
        matchNotes: entry.asset.rightsEvidence.reviewNotes,
        sortOrder: entry.sortOrder,
        isThumbnail: entry.isThumbnail,
        isPreferred: entry.asset.mediaType === "video",
      })
      .onConflictDoUpdate({
        target: exerciseMediaAssociations.assetId,
        set: {
          exerciseId: exercise.id,
          familyId: null,
          matchScope: "exact_variant",
          equipmentSignature,
          variantAttributes: exercise.variantAttributes,
          matchNotes: entry.asset.rightsEvidence.reviewNotes,
          sortOrder: entry.sortOrder,
          isThumbnail: entry.isThumbnail,
          isPreferred: entry.asset.mediaType === "video",
        },
      });
    associations += 1;
  }

  return { assets, associations, missingExercises: [...new Set(missingExercises)] };
}
