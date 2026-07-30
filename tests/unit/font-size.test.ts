import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import { userProfiles, users } from "@/db/schema";
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_OPTIONS,
  isFontSizeKey,
  normalizeFontSize,
} from "@/lib/font-size";

describe("font-size preferences", () => {
  it("accepts only supported profile values", () => {
    expect(isFontSizeKey("compact")).toBe(true);
    expect(isFontSizeKey("extra-large")).toBe(true);
    expect(isFontSizeKey("giant")).toBe(false);
    expect(normalizeFontSize("giant")).toBe(DEFAULT_FONT_SIZE);
  });

  it("offers a larger, evenly stepped app-size range", () => {
    expect(FONT_SIZE_OPTIONS.map((option) => option.detail)).toEqual([
      "100%",
      "115%",
      "130%",
      "145%",
    ]);
  });
});

describe("font-size profile persistence", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let profileId: string;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    const [user] = await db
      .insert(users)
      .values({ email: "font-size-test@example.com" })
      .returning({ id: users.id });
    [{ id: profileId }] = await db
      .insert(userProfiles)
      .values({ userId: user.id })
      .returning({ id: userProfiles.id });
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("defaults new profiles to the standard app size", async () => {
    const profile = await db.query.userProfiles.findFirst({
      where: eq(userProfiles.id, profileId),
    });
    expect(profile?.fontSize).toBe("default");
  });

  it("retains a changed app size on the profile", async () => {
    await db
      .update(userProfiles)
      .set({ fontSize: "extra-large" })
      .where(eq(userProfiles.id, profileId));
    const profile = await db.query.userProfiles.findFirst({
      where: eq(userProfiles.id, profileId),
    });
    expect(profile?.fontSize).toBe("extra-large");
  });
});
