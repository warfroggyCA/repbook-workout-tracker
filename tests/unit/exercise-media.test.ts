import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  exerciseFamilies,
  exerciseMediaAssets,
  exerciseMediaAssociations,
  exercises,
  userProfiles,
  users,
} from "@/db/schema";
import {
  getApprovedExerciseMedia,
  mediaAssociationMatchesExercise,
  type MediaMatchExercise,
} from "@/services/exercise-media";
import { exerciseMediaDisplayState } from "@/lib/exercise-media-display";
import { captureUserSnapshot } from "@/services/snapshot-capture";

describe("trusted exercise media", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  it("accepts exact variants and only truly equivalent family variants", () => {
    const exercise: MediaMatchExercise = {
      id: "exercise-1",
      familyId: "family-1",
      equipment: ["bench", "dumbbell"],
      variantAttributes: { angle: "flat", laterality: "bilateral" },
    };
    expect(
      mediaAssociationMatchesExercise(exercise, {
        exerciseId: "exercise-1",
        familyId: null,
        matchScope: "exact_variant",
        equipmentSignature: [],
        variantAttributes: {},
      })
    ).toBe(true);
    expect(
      mediaAssociationMatchesExercise(exercise, {
        exerciseId: null,
        familyId: "family-1",
        matchScope: "equivalent_family",
        equipmentSignature: ["dumbbell", "bench"],
        variantAttributes: { laterality: "bilateral", angle: "flat" },
      })
    ).toBe(true);
    expect(
      mediaAssociationMatchesExercise(exercise, {
        exerciseId: null,
        familyId: "family-1",
        matchScope: "equivalent_family",
        equipmentSignature: ["barbell", "bench"],
        variantAttributes: { laterality: "bilateral", angle: "flat" },
      })
    ).toBe(false);
    expect(
      mediaAssociationMatchesExercise(exercise, {
        exerciseId: null,
        familyId: "family-1",
        matchScope: "equivalent_family",
        equipmentSignature: ["bench", "dumbbell"],
        variantAttributes: { angle: "incline", laterality: "bilateral" },
      })
    ).toBe(false);
  });

  it("projects only active approved media and keeps rights evidence internal", async () => {
    const [family] = await db
      .insert(exerciseFamilies)
      .values({
        key: `media-family-${crypto.randomUUID()}`,
        name: `Media family ${crypto.randomUUID()}`,
        movementPattern: "hinge",
        primaryMuscles: ["hamstrings"],
      })
      .returning({ id: exerciseFamilies.id });
    const [exercise] = await db
      .insert(exercises)
      .values({
        familyId: family.id,
        name: `Media exercise ${crypto.randomUUID()}`,
        movementPattern: "hinge",
        primaryMuscles: ["hamstrings"],
        loadType: "barbell",
      })
      .returning();
    const [asset] = await db
      .insert(exerciseMediaAssets)
      .values({
        mediaType: "image",
        displayUrl: "/exercise-media/exact.png",
        originalAssetUrl: "https://example.test/original.png",
        sourcePageUrl: "https://example.test/source",
        creator: "Internal creator",
        license: "Internal licence",
        attributionText: "Internal attribution",
        hosting: "app_managed",
        redistributionAllowed: true,
        checksumSha256: "a".repeat(64),
        width: 620,
        height: 900,
        altText: "Exact exercise setup",
        rightsEvidence: { sourcePageRevisionId: "123" },
        reviewedAt: new Date("2026-07-12T00:00:00.000Z"),
        status: "approved",
      })
      .returning();
    await db.insert(exerciseMediaAssociations).values({
      assetId: asset.id,
      exerciseId: exercise.id,
      matchScope: "exact_variant",
      equipmentSignature: ["barbell"],
      variantAttributes: {},
      matchNotes: "Exact reviewed match",
      sortOrder: 0,
      isThumbnail: true,
    });

    const matchInput = {
      id: exercise.id,
      familyId: exercise.familyId,
      equipment: ["barbell"],
      variantAttributes: exercise.variantAttributes,
    };
    const projected = (await getApprovedExerciseMedia(db, [matchInput])).get(
      exercise.id
    );
    expect(projected).toEqual({
      thumbnailUrl: "/exercise-media/exact.png",
      kind: "image",
      images: [
        {
          url: "/exercise-media/exact.png",
          alt: "Exact exercise setup",
          width: 620,
          height: 900,
        },
      ],
      video: null,
    });
    expect(JSON.stringify(projected)).not.toContain("Internal creator");
    expect(JSON.stringify(projected)).not.toContain("Internal licence");
    expect(JSON.stringify(projected)).not.toContain("Internal attribution");
    expect(JSON.stringify(projected)).not.toContain("sourcePageRevisionId");

    await db
      .update(exerciseMediaAssets)
      .set({ redistributionAllowed: false })
      .where(eq(exerciseMediaAssets.id, asset.id));
    expect(await getApprovedExerciseMedia(db, [matchInput])).toEqual(new Map());

    await db
      .update(exerciseMediaAssets)
      .set({
        redistributionAllowed: true,
        disabledAt: new Date(),
        disabledReason: "Link under review",
      })
      .where(eq(exerciseMediaAssets.id, asset.id));
    expect(await getApprovedExerciseMedia(db, [matchInput])).toEqual(new Map());

    const [user] = await db
      .insert(users)
      .values({ email: `media-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(userProfiles).values({ userId: user.id });
    const snapshot = await captureUserSnapshot(
      db,
      user.id,
      new Date("2026-07-12T12:00:00.000Z"),
      "media-test"
    );
    expect(snapshot.tables.exercise_media_assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: asset.id,
          license: "Internal licence",
          source_page_url: "https://example.test/source",
        }),
      ])
    );
    expect(snapshot.tables.exercise_media_associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ asset_id: asset.id, exercise_id: exercise.id }),
      ])
    );
  }, 30_000);

  it("distinguishes honest missing media from a fully failed asset set", () => {
    expect(exerciseMediaDisplayState(null)).toBe("missing");
    const media = {
      kind: "image" as const,
      images: [
        { url: "/broken.png", alt: "Broken", width: 100, height: 100 },
      ],
      video: null,
    };
    expect(exerciseMediaDisplayState(media)).toBe("available");
    expect(
      exerciseMediaDisplayState(media, new Set(["/broken.png"]))
    ).toBe("unavailable");
  });
});
