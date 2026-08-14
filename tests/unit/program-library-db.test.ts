import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  exercises,
  programs,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplates,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  listProgramLibrary,
  switchActiveProgram,
} from "@/services/program-library";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import { validateSnapshotPayload } from "@/services/snapshot-restore";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("named Program library", () => {
  let database: TestDatabase;
  let userId: string;
  let exerciseId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    userId = crypto.randomUUID();
    exerciseId = crypto.randomUUID();
    await database.db.insert(users).values({
      id: userId,
      email: `program-library-${userId}@example.com`,
    });
    await database.db.insert(userProfiles).values({
      userId,
      timezone: "America/Toronto",
      unit: "lb",
    });
    await database.db.insert(exercises).values({
      id: exerciseId,
      name: `Library press ${exerciseId}`,
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "barbell",
      metricType: "weight_reps",
      loadSemantics: "total",
    });
  }, 30_000);

  afterEach(async () => database.close());

  async function activate(
    name: string,
    expectedCurrentProgramVersionId: string | null,
    destination?: "replace_active" | "create_new_active",
  ) {
    return activateProgramAtomically(database.db, {
      userId,
      loadUnit: "lb",
      programName: name,
      days: [{
        name: `${name} Routine A`,
        exercises: [{
          exerciseId,
          sets: 3,
          repMin: 6,
          repMax: 8,
          targetLoad: 100,
          targetLoadUnit: "lb",
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: `Create ${name}`,
      auditAction: "program.activate",
      auditSummary: `Create ${name}`,
      expectedCurrentProgramVersionId,
      destination,
    });
  }

  it("keeps named routine sets separate and switches without rewriting History", async () => {
    const first = await activate("Hevy", null);
    if (!first.ok) throw new Error(first.reason);
    const [firstTemplate] = await database.db.query.workoutTemplates.findMany({
      where: eq(workoutTemplates.programVersionId, first.programVersionId),
      orderBy: asc(workoutTemplates.orderIdx),
    });
    const [completed] = await database.db.insert(workoutSessions).values({
      userId,
      templateId: firstTemplate.id,
      templateName: firstTemplate.name,
      status: "completed",
      startedAt: new Date("2026-08-10T12:00:00.000Z"),
      finishedAt: new Date("2026-08-10T13:00:00.000Z"),
      timezone: "America/Toronto",
      localDate: "2026-08-10",
      sourceProgramId: first.programId,
      sourceProgramVersionId: first.programVersionId,
      sourceDayLineageId: firstTemplate.lineageId,
    }).returning();

    const second = await activate(
      "Philippines Transformation",
      first.programVersionId,
      "create_new_active",
    );
    if (!second.ok) throw new Error(second.reason);

    expect(await listProgramLibrary(database.db, userId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: second.programId,
        name: "Philippines Transformation",
        status: "active",
        routineNames: ["Philippines Transformation Routine A"],
      }),
      expect.objectContaining({
        id: first.programId,
        name: "Hevy",
        status: "inactive",
        routineNames: ["Hevy Routine A"],
      }),
    ]));
    const snapshot = await captureUserSnapshot(
      database.db,
      userId,
      new Date("2026-08-14T16:00:00.000Z"),
      "named-program-test",
    );
    expect(snapshot.schemaVersion).toBe("34");
    expect(snapshot.tables.programs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.programId, status: "inactive" }),
      expect.objectContaining({ id: second.programId, status: "active" }),
    ]));
    expect(() => validateSnapshotPayload(snapshot, userId)).not.toThrow();

    const requestId = crypto.randomUUID();
    await expect(switchActiveProgram(database.db, userId, {
      targetProgramId: first.programId,
      expectedActiveProgramId: second.programId,
      requestId,
    })).resolves.toEqual({ outcome: "switched" });
    await expect(switchActiveProgram(database.db, userId, {
      targetProgramId: first.programId,
      expectedActiveProgramId: second.programId,
      requestId,
    })).resolves.toEqual({ outcome: "replayed" });

    expect(await database.db.query.programs.findMany({
      where: eq(programs.userId, userId),
      orderBy: asc(programs.name),
    })).toEqual([
      expect.objectContaining({ id: first.programId, status: "active" }),
      expect.objectContaining({ id: second.programId, status: "inactive" }),
    ]);
    expect(await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, completed.id),
    })).toMatchObject({
      id: completed.id,
      templateId: firstTemplate.id,
      templateName: firstTemplate.name,
      sourceProgramId: first.programId,
      sourceProgramVersionId: first.programVersionId,
      sourceDayLineageId: firstTemplate.lineageId,
      status: "completed",
    });
  }, 30_000);

  it("does not switch while a workout is active", async () => {
    const first = await activate("First", null);
    if (!first.ok) throw new Error(first.reason);
    const second = await activate("Second", first.programVersionId, "create_new_active");
    if (!second.ok) throw new Error(second.reason);
    await database.db.insert(workoutSessions).values({
      userId,
      templateName: "Active workout",
      status: "in_progress",
      startedAt: new Date("2026-08-14T12:00:00.000Z"),
      timezone: "America/Toronto",
      localDate: "2026-08-14",
    });

    await expect(switchActiveProgram(database.db, userId, {
      targetProgramId: first.programId,
      expectedActiveProgramId: second.programId,
      requestId: crypto.randomUUID(),
    })).resolves.toEqual({ outcome: "active_workout" });
    expect(await database.db.query.programs.findFirst({
      where: eq(programs.id, second.programId),
    })).toMatchObject({ status: "active" });
    expect(await database.db.query.programs.findFirst({
      where: eq(programs.id, first.programId),
    })).toMatchObject({ status: "inactive" });
  }, 30_000);
});
