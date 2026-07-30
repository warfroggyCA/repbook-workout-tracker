import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { auditLogs, recordVersions, userProfiles, users } from "@/db/schema";
import {
  saveCoachingPrefsReviewWithVersions,
  saveConstraintsWithVersions,
  saveProfileReviewWithVersions,
} from "@/services/setup-persistence";
import { VERSIONED_ENTITY_TYPES } from "@/services/record-versions";

describe("returning-user setup review persistence", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let profileId: string;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `setup-review-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    [{ id: profileId }] = await db
      .insert(userProfiles)
      .values({
        userId,
        ageRange: "50-59",
        experience: "intermediate",
        goals: ["strength"],
        sessionLengthMin: 45,
        weeklyFrequency: 3,
        unit: "lb",
        setupCompletedAt: new Date(),
        setupState: { completedSteps: ["profile"], routineDraft: null },
      })
      .returning({ id: userProfiles.id });
  }, 60_000);

  afterEach(async () => {
    await client.close();
  });

  it("exposes Profile and Coaching history through Recovery filters", () => {
    expect(VERSIONED_ENTITY_TYPES).toContain("user_profile");
  });

  async function history() {
    const [versions, audits, profile] = await Promise.all([
      db.query.recordVersions.findMany({ where: eq(recordVersions.userId, userId) }),
      db.select().from(auditLogs).where(eq(auditLogs.userId, userId)),
      db.query.userProfiles.findFirst({ where: eq(userProfiles.id, profileId) }),
    ]);
    return { versions, audits, profile };
  }

  it("versions and audits a profile change, keeps the unit and setup state untouched, and writes nothing for a no-op", async () => {
    const changed = await saveProfileReviewWithVersions(db, userId, {
      ageRange: "50-59",
      experience: "advanced",
      goals: ["strength", "consistency"],
      sessionLengthMin: 60,
      weeklyFrequency: 4,
    });
    expect(changed).toMatchObject({ ok: true, changed: true, versionCount: 1 });

    const afterChange = await history();
    expect(afterChange.profile).toMatchObject({
      experience: "advanced",
      sessionLengthMin: 60,
      weeklyFrequency: 4,
      unit: "lb",
      setupState: { completedSteps: ["profile"] },
    });
    expect(afterChange.profile?.setupCompletedAt).not.toBeNull();
    expect(afterChange.versions).toEqual([
      expect.objectContaining({
        entityType: "user_profile",
        action: "profile.manage.update",
        changedFields: expect.arrayContaining([
          "experience",
          "goals",
          "session_length_min",
          "weekly_frequency",
        ]),
      }),
    ]);
    expect(afterChange.audits).toEqual([
      expect.objectContaining({ action: "profile.manage.save" }),
    ]);

    const noop = await saveProfileReviewWithVersions(db, userId, {
      ageRange: "50-59",
      experience: "advanced",
      goals: ["strength", "consistency"],
      sessionLengthMin: 60,
      weeklyFrequency: 4,
    });
    expect(noop).toMatchObject({ ok: true, changed: false, versionCount: 0 });
    const afterNoop = await history();
    expect(afterNoop.versions).toHaveLength(1);
    expect(afterNoop.audits).toHaveLength(1);
  });

  it("versions and audits a coaching change and writes nothing for a no-op", async () => {
    const prefs = {
      aggressiveness: "moderate" as const,
      deloadSuggestions: true,
      substitutionSuggestions: false,
      weeklyReview: true,
    };
    const changed = await saveCoachingPrefsReviewWithVersions(db, userId, prefs);
    expect(changed).toMatchObject({ ok: true, changed: true, versionCount: 1 });
    const afterChange = await history();
    expect(afterChange.profile?.coachingPrefs).toEqual(prefs);
    expect(afterChange.versions).toEqual([
      expect.objectContaining({ action: "coaching.manage.update" }),
    ]);
    expect(afterChange.audits).toEqual([
      expect.objectContaining({ action: "coaching.manage.save" }),
    ]);

    const noop = await saveCoachingPrefsReviewWithVersions(db, userId, prefs);
    expect(noop).toMatchObject({ ok: true, changed: false, versionCount: 0 });
    const afterNoop = await history();
    expect(afterNoop.versions).toHaveLength(1);
    expect(afterNoop.audits).toHaveLength(1);
    expect(afterNoop.profile?.setupState.completedSteps).toEqual(["profile"]);
  });

  it("constraint review saves change data with history but never marks setup steps or audits a no-op", async () => {
    const regions = [
      {
        bodyPart: "knee",
        avoidPatterns: ["squat"],
        cautiousPatterns: ["lunge"],
        painStopThreshold: 4,
        note: "Old knee issue",
      },
    ];
    const changed = await saveConstraintsWithVersions(db, userId, regions, {
      mode: "review",
    });
    expect(changed).toMatchObject({ ok: true, changed: true, versionCount: 2 });
    const afterChange = await history();
    expect(afterChange.profile?.setupState.completedSteps).toEqual(["profile"]);
    expect(afterChange.audits).toEqual([
      expect.objectContaining({ action: "constraints.manage.save" }),
    ]);

    const noop = await saveConstraintsWithVersions(db, userId, regions, {
      mode: "review",
    });
    expect(noop).toMatchObject({ ok: true, changed: false, versionCount: 0 });
    const afterNoop = await history();
    expect(afterNoop.audits).toHaveLength(1);
    expect(afterNoop.versions).toHaveLength(2);

    // Onboarding mode still marks the step and audits every save.
    const onboarding = await saveConstraintsWithVersions(db, userId, regions);
    expect(onboarding).toMatchObject({ ok: true, changed: false });
    const afterOnboarding = await history();
    expect(afterOnboarding.profile?.setupState.completedSteps).toEqual([
      "profile",
      "constraints",
    ]);
    expect(afterOnboarding.audits).toHaveLength(2);
  });
});
