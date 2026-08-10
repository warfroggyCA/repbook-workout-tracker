import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { completedSets, painLogs } from "@/db/schema";
import { logWorkoutSet } from "@/services/session-lifecycle";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";
import {
  recordU02Exception,
  U02_EXCEPTION_CONTEXT,
} from "../helpers/v2-u02-exception-context";

describe("V2 U02 exception context writer", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("keeps every exception value unknown on the ordinary completion path", async () => {
    const saved = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.loaded,
    );
    expect(saved.outcome).toBe("saved");
    if (saved.outcome !== "saved") return;

    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, saved.setId),
    })).toMatchObject({
      rpe: null,
      rir: null,
      techniqueIssue: null,
      limitationCause: null,
      note: null,
    });
    expect(await database.db.query.painLogs.findMany({
      where: eq(painLogs.completedSetId, saved.setId),
    })).toHaveLength(0);
  });

  it("atomically retains one explicit effort, issue, limitation, and pain flag", async () => {
    const saved = await recordU02Exception(database.db, fixture);
    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, saved.setId),
    })).toMatchObject({
      rpe: null,
      rir: 2,
      techniqueIssue: "bracing",
      limitationCause: "strength_fatigue",
      note: U02_EXCEPTION_CONTEXT.note,
    });
    expect(await database.db.query.painLogs.findMany({
      where: eq(painLogs.completedSetId, saved.setId),
    })).toEqual([
      expect.objectContaining({
        userId: fixture.userId,
        sessionId: fixture.sessionId,
        exerciseId: fixture.exerciseIds.loaded,
        completedSetId: saved.setId,
        bodyPart: "back",
        severity: 4,
        source: "set_exception",
        note: "Sharp only at the bottom",
      }),
    ]);
    expect(await evaluateApplicationIntegrity(
      database.db,
      fixture.userId,
    )).toEqual([]);
  });
});
