import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { completedSets, recordVersions } from "@/db/schema";
import { readSetCorrectionEvidence } from "@/lib/set-correction";
import {
  WORKOUT_SET_OUTBOX_STORAGE_KEY,
  readWorkoutSetOutbox,
  type WorkoutSetOutboxStorage,
} from "@/lib/workout-set-outbox";
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

const expectedLoaded = {
  weight: 100,
  weightUnit: "kg" as const,
  reps: 5,
  distanceKm: null,
  durationSeconds: null,
  rpe: null,
  note: null,
};

const activeEvidence = {
  category: "measurement_entry" as const,
  reasonNote: null,
  source: "active_workout" as const,
};

class MemoryStorage implements WorkoutSetOutboxStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("V2 T02 adversarial correction and recovery boundaries", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  it("rejects stale revisions, cross-owner attempts, and mutation-identity drift without another write", async () => {
    const saved = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.loaded,
    );
    if (saved.outcome !== "saved") throw new Error(saved.outcome);
    const mutationId = crypto.randomUUID();
    const correctedValues = { ...expectedLoaded, weight: 102.5 };

    expect(
      await updateSetWithVersion(
        database.db,
        fixture.userId,
        saved.setId,
        correctedValues,
        "set.active_correction",
        {
          expected: expectedLoaded,
          expectedHistoryRevision: 0,
          clientMutationId: mutationId,
          correctionEvidence: activeEvidence,
        },
      ),
    ).toMatchObject({ ok: true, historyRevision: 1 });

    expect(
      await updateSetWithVersion(
        database.db,
        fixture.userId,
        saved.setId,
        { ...correctedValues, weight: 105 },
        "set.active_correction",
        {
          expected: expectedLoaded,
          expectedHistoryRevision: 0,
          clientMutationId: crypto.randomUUID(),
          correctionEvidence: activeEvidence,
        },
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });

    expect(
      await updateSetWithVersion(
        database.db,
        crypto.randomUUID(),
        saved.setId,
        { ...correctedValues, weight: 105 },
        "set.active_correction",
        {
          expected: correctedValues,
          expectedHistoryRevision: 1,
          clientMutationId: crypto.randomUUID(),
          correctionEvidence: activeEvidence,
        },
      ),
    ).toMatchObject({ ok: false });

    expect(
      await updateSetWithVersion(
        database.db,
        fixture.userId,
        saved.setId,
        correctedValues,
        "set.active_correction",
        {
          expected: expectedLoaded,
          expectedHistoryRevision: 0,
          clientMutationId: mutationId,
          correctionEvidence: {
            ...activeEvidence,
            category: "wrong_unit",
          },
        },
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("different values"),
    });

    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, saved.setId),
      }),
    ).toMatchObject({ weight: 102.5, weightUnit: "kg", reps: 5 });
    expect(
      await database.db.query.recordVersions.findMany({
        where: eq(recordVersions.entityId, saved.setId),
      }),
    ).toHaveLength(1);
  });

  it("refuses an unacknowledged row and corrects legacy raw facts without inventing meaning", async () => {
    const [unlinked] = await database.db
      .insert(completedSets)
      .values({
        sessionExerciseId: fixture.sessionExerciseIds.loaded,
        setNo: 1,
        weight: 100,
        weightUnit: "kg",
        reps: 5,
        metricType: "weight_reps",
        performedSemanticsVersion: 1,
        performedLoadType: "dumbbell",
        performedLoadSemantics: "total",
        loadEntryMeaning: "legacy_unknown",
        clientKey: crypto.randomUUID(),
        observedCompletedAt: new Date(),
        observedCompletionProvenance: "manual_explicit",
        observedCompletionQuality: "owner_reported",
      })
      .returning({ id: completedSets.id });

    expect(
      await updateSetWithVersion(
        database.db,
        fixture.userId,
        unlinked.id,
        { ...expectedLoaded, reps: 6 },
        "set.active_correction",
        {
          expected: expectedLoaded,
          expectedHistoryRevision: 0,
          clientMutationId: crypto.randomUUID(),
          correctionEvidence: activeEvidence,
        },
      ),
    ).toMatchObject({ ok: false });

    const legacyCorrection = await updateSetWithVersion(
      database.db,
      fixture.userId,
      fixture.legacySetId,
      {
        weight: 55,
        weightUnit: "lb",
        reps: 10,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      "set.completed_correction",
      {
        expected: {
          weight: 50,
          weightUnit: "lb",
          reps: 10,
          distanceKm: null,
          durationSeconds: null,
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
    expect(legacyCorrection).toMatchObject({ ok: true });

    expect(await database.db.select().from(recordVersions)).toHaveLength(1);
    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, fixture.legacySetId),
      }),
    ).toMatchObject({
      weight: 55,
      performedSemanticsVersion: null,
      performedLoadType: null,
      performedLoadSemantics: null,
      targetMet: null,
    });
    expect(readSetCorrectionEvidence({
      repbook_correction: {
        schemaVersion: 1,
        writerVersion: "repbook-v2-t02/1",
        category: "measurement_entry",
      },
    })).toBeNull();
  });

  it("quarantines a retained pre-contract device command for explicit owner review", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      WORKOUT_SET_OUTBOX_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        entries: [
          {
            clientKey: crypto.randomUUID(),
            ownerId: fixture.userId,
            weight: 100,
            reps: 5,
          },
        ],
      }),
    );

    const recovered = readWorkoutSetOutbox(storage);
    expect(recovered.entries).toEqual([]);
    expect(recovered.quarantined).toHaveLength(1);
    expect(recovered.quarantined[0].reason).toContain("older recording format");
  });
});
