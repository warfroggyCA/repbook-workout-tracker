import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  completedSets,
  progressionJobs,
  recordVersions,
  sessionOccurrences,
  workoutSessions,
} from "@/db/schema";
import { readSetCorrectionEvidence } from "@/lib/set-correction";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import { updateSetWithVersion } from "@/services/record-versions";
import { logWorkoutSet } from "@/services/session-lifecycle";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

const activeEvidence = {
  category: "measurement_entry",
  reasonNote: "Reviewed during the workout",
  source: "active_workout",
} as const;

describe("V2 T02 acknowledgement and correction ledger", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  it("acknowledges one exact result across duplicate and timeout-after-commit retries", async () => {
    const first = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.loaded,
    );
    expect(first).toMatchObject({ outcome: "saved" });

    const lostAcknowledgementRetry = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.loaded,
    );
    expect(lostAcknowledgementRetry).toEqual(first);
    await expect(
      logWorkoutSet(database.db, fixture.userId, {
        ...fixture.commands.loaded,
        reps: 4,
      }),
    ).resolves.toEqual({ outcome: "retry_identity_conflict" });

    expect(
      await database.db.query.completedSets.findMany({
        where: eq(
          completedSets.sessionExerciseId,
          fixture.sessionExerciseIds.loaded,
        ),
      }),
    ).toHaveLength(1);
    expect(
      await database.db.query.sessionOccurrences.findFirst({
        where: eq(
          sessionOccurrences.id,
          first.outcome === "saved" ? first.occurrenceId : "",
        ),
      }),
    ).toMatchObject({
      outcome: "completed",
      completedSetId: first.outcome === "saved" ? first.setId : null,
    });
  });

  it("corrects a timed assertion with stable identity, a revision fence, and complete evidence", async () => {
    const saved = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.duration,
    );
    if (saved.outcome !== "saved") throw new Error(saved.outcome);
    const clientMutationId = crypto.randomUUID();
    const expected = {
      weight: null,
      weightUnit: null,
      reps: null,
      distanceKm: null,
      durationSeconds: 45,
      rpe: null,
      note: null,
    };
    const values = { ...expected, durationSeconds: 60 };

    const corrected = await updateSetWithVersion(
      database.db,
      fixture.userId,
      saved.setId,
      values,
      "set.active_correction",
      {
        expected,
        expectedHistoryRevision: 0,
        clientMutationId,
        correctionEvidence: activeEvidence,
      },
    );
    expect(corrected).toMatchObject({
      ok: true,
      changed: true,
      versionId: clientMutationId,
      historyRevision: 1,
    });

    await expect(
      updateSetWithVersion(
        database.db,
        fixture.userId,
        saved.setId,
        values,
        "set.active_correction",
        {
          expected,
          expectedHistoryRevision: 0,
          clientMutationId,
          correctionEvidence: activeEvidence,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      versionId: clientMutationId,
      historyRevision: 1,
    });

    await expect(
      updateSetWithVersion(
        database.db,
        fixture.userId,
        saved.setId,
        values,
        "set.active_correction",
        {
          expected: { ...expected, durationSeconds: 44 },
          expectedHistoryRevision: 0,
          clientMutationId,
          correctionEvidence: activeEvidence,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "That correction identity already belongs to different values.",
    });

    await database.db
      .update(completedSets)
      .set({ targetMet: false })
      .where(eq(completedSets.id, saved.setId));

    await expect(
      updateSetWithVersion(
        database.db,
        fixture.userId,
        saved.setId,
        { ...values, durationSeconds: 61 },
        "set.active_correction",
        {
          expected,
          expectedHistoryRevision: 0,
          clientMutationId,
          correctionEvidence: activeEvidence,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "That correction identity already belongs to different values.",
    });

    await expect(
      updateSetWithVersion(
        database.db,
        fixture.userId,
        saved.setId,
        values,
        "set.active_correction",
        {
          expected: values,
          expectedHistoryRevision: 1,
          clientMutationId: crypto.randomUUID(),
          correctionEvidence: activeEvidence,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "A correction must change at least one saved value.",
    });

    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, saved.setId),
      }),
    ).toMatchObject({
      metricType: "duration",
      durationSeconds: 60,
      weight: null,
      reps: null,
      targetMet: false,
    });
    const [version] = await database.db.query.recordVersions.findMany({
      where: eq(recordVersions.entityId, saved.setId),
    });
    expect(version.changedFields).toContain("duration_seconds");
    expect(version.beforeData).toMatchObject({ duration_seconds: 45 });
    expect(version.afterData).toMatchObject({ duration_seconds: 60 });
    expect(readSetCorrectionEvidence(version.afterData)).toMatchObject({
      schemaVersion: 1,
      writerVersion: "repbook-v2-t02/1",
      category: "measurement_entry",
      actorType: "owner",
      source: "active_workout",
      decisionTimezone: "America/Toronto",
      sourceHistoryRevision: 0,
      resultHistoryRevision: 1,
      dependentConclusions: "not_created_while_active",
      expiredRecommendationCount: 0,
      progressionJobId: null,
    });
    expect(
      await evaluateApplicationIntegrity(database.db, fixture.userId),
    ).toEqual([]);
  });

  it("retains and corrects acknowledged evidence after abandonment without creating progression", async () => {
    const saved = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.distance,
    );
    if (saved.outcome !== "saved") throw new Error(saved.outcome);
    await database.db
      .update(workoutSessions)
      .set({ status: "abandoned", finishedAt: new Date() })
      .where(eq(workoutSessions.id, fixture.sessionId));

    const corrected = await updateSetWithVersion(
      database.db,
      fixture.userId,
      saved.setId,
      {
        weight: null,
        weightUnit: null,
        reps: null,
        distanceKm: 1.5,
        durationSeconds: 660,
        rpe: null,
        note: "Corrected after abandoning",
      },
      "set.completed_correction",
      {
        expected: {
          weight: null,
          weightUnit: null,
          reps: null,
          distanceKm: 1.2,
          durationSeconds: 600,
          rpe: null,
          note: null,
        },
        expectedHistoryRevision: 0,
        clientMutationId: crypto.randomUUID(),
        correctionEvidence: {
          category: "measurement_entry",
          reasonNote: null,
          source: "workout_history",
        },
      },
    );
    expect(corrected).toMatchObject({ ok: true, historyRevision: 1 });
    expect(await database.db.select().from(progressionJobs)).toHaveLength(0);
    const [version] = await database.db.query.recordVersions.findMany({
      where: eq(recordVersions.entityId, saved.setId),
    });
    expect(readSetCorrectionEvidence(version.afterData)).toMatchObject({
      dependentConclusions: "abandoned_session_excluded",
      progressionJobId: null,
    });
  });
});
