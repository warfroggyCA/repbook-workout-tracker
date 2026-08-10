import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  completedSets,
  sessionExercises,
  sessionOccurrences,
  workoutSessions,
} from "@/db/schema";
import {
  classifyPrescriptionOutcome,
  classifySetMetricContainment,
} from "@/lib/set-metric-semantics";
import { getHistoryReport } from "@/services/history-report";
import {
  restoreRecordVersion,
  updateSetWithVersion,
} from "@/services/record-versions";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedV2H02CadenceTargetsTime,
  V2_H02_NOW,
  type V2H02CadenceFixture,
} from "../helpers/v2-h02-cadence-targets-time";

describe("V2 H02 adversarial boundaries", () => {
  let database: TestDatabase;
  let fixture: V2H02CadenceFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedV2H02CadenceTargetsTime(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("recomputes after a correction without changing the retained target", async () => {
    const before = await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, fixture.setIds.at),
    });
    if (!before) throw new Error("H02 correction fixture set missing.");
    const corrected = await updateSetWithVersion(
      database.db,
      fixture.userId,
      fixture.setIds.at,
      {
        weight: 90,
        weightUnit: "lb",
        reps: 8,
        distanceKm: null,
        durationSeconds: null,
        rpe: null,
        note: null,
      },
      "set.completed_correction",
      {
        expected: {
          weight: before.weight,
          weightUnit: before.weightUnit,
          reps: before.reps,
          distanceKm: before.distanceKm,
          durationSeconds: before.durationSeconds,
          rpe: before.rpe,
          note: before.note,
        },
        expectedHistoryRevision: 0,
        clientMutationId: crypto.randomUUID(),
        correctionEvidence: {
          category: "measurement_entry",
          reasonNote: "Corrected a mistyped load",
          source: "workout_history",
        },
      },
    );
    expect(corrected).toMatchObject({ ok: true, changed: true });
    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, fixture.setIds.at),
      columns: { weight: true, targetMet: true },
    })).toEqual({ weight: 90, targetMet: false });
    expect(await database.db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.completedSetId, fixture.setIds.at),
      columns: {
        plannedLoad: true,
        plannedLoadUnit: true,
        plannedRepsMin: true,
        plannedRepsMax: true,
      },
    })).toEqual({
      plannedLoad: 100,
      plannedLoadUnit: "lb",
      plannedRepsMin: 8,
      plannedRepsMax: 10,
    });
    const sessionExercise = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, fixture.sessionIds.first),
      columns: { targetLoad: true },
    });
    expect(sessionExercise?.targetLoad).toBe(999);

    const report = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    expect(report.overview.targetOutcomes).toMatchObject({
      below: 2,
      at: 1,
      above: 1,
      unknown: 1,
    });
  });

  it("recomputes the legacy target projection during record-version restore", async () => {
    const before = await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, fixture.setIds.below),
    });
    if (!before) throw new Error("H02 restore fixture set missing.");
    expect(before.targetMet).toBe(true);

    const corrected = await updateSetWithVersion(
      database.db,
      fixture.userId,
      fixture.setIds.below,
      {
        weight: 105,
        weightUnit: "lb",
        reps: 8,
        distanceKm: null,
        durationSeconds: null,
        rpe: before.rpe,
        note: before.note,
      },
      "set.completed_correction",
      {
        expected: {
          weight: before.weight,
          weightUnit: before.weightUnit,
          reps: before.reps,
          distanceKm: before.distanceKm,
          durationSeconds: before.durationSeconds,
          rpe: before.rpe,
          note: before.note,
        },
        expectedHistoryRevision: 0,
        clientMutationId: crypto.randomUUID(),
        correctionEvidence: {
          category: "measurement_entry",
          reasonNote: "Temporarily corrected for H02 restore proof",
          source: "workout_history",
        },
      },
    );
    expect(corrected).toMatchObject({ ok: true, changed: true });
    if (!corrected.ok || !corrected.versionId) {
      throw new Error("H02 correction version missing.");
    }
    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, fixture.setIds.below),
      columns: { weight: true, reps: true, targetMet: true },
    })).toEqual({ weight: 105, reps: 8, targetMet: true });

    const restored = await restoreRecordVersion(
      database.db,
      fixture.userId,
      corrected.versionId,
      {
        expectedHistoryRevision: 1,
        clientMutationId: crypto.randomUUID(),
      },
    );
    expect(restored).toMatchObject({ ok: true, changed: true });
    expect(await database.db.query.completedSets.findFirst({
      where: eq(completedSets.id, fixture.setIds.below),
      columns: { weight: true, reps: true, targetMet: true },
    })).toEqual({ weight: 95, reps: 7, targetMet: false });
    expect(await database.db.query.sessionOccurrences.findFirst({
      where: eq(sessionOccurrences.completedSetId, fixture.setIds.below),
      columns: {
        plannedLoad: true,
        plannedLoadUnit: true,
        plannedRepsMin: true,
        plannedRepsMax: true,
      },
    })).toEqual({
      plannedLoad: 100,
      plannedLoadUnit: "lb",
      plannedRepsMin: 8,
      plannedRepsMax: 10,
    });

    const report = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      V2_H02_NOW,
    );
    expect(report.overview.targetOutcomes).toMatchObject({
      below: 1,
      at: 2,
      above: 1,
      unknown: 1,
    });
  });

  it("excludes abandoned, archived, and cross-owner sessions from completed cadence", async () => {
    const owner = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      7,
      V2_H02_NOW,
    );
    expect(owner.cadence).toMatchObject({
      completedSessions: 5,
      averageSessionsPerCompleteWeek: 1.33,
      currentPreference: { sessionsPerWeek: 7, comparison: "below" },
    });
    expect(owner.overview.abandonedSessions).toBe(1);
    expect(owner.cadence.currentPreference.limitation).toContain(
      "scheduled opportunities are not reconstructed",
    );
    expect(owner.cadence).not.toHaveProperty("adherenceRate");

    const otherOwner = await getHistoryReport(
      database.db,
      fixture.otherUserId,
      "4w",
      5,
      V2_H02_NOW,
    );
    expect(otherOwner.cadence.completedSessions).toBe(1);
    expect(otherOwner.overview.targetOutcomes.supported).toBe(0);
    expect(await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, fixture.sessionIds.archived),
      columns: { archivedAt: true },
    })).toEqual({ archivedAt: expect.any(Date) });
  });

  it("keeps unsupported target shapes and missing units explicitly unknown", () => {
    const semantics = classifySetMetricContainment({
      recordedMetricType: "weight_reps",
      prescribedSemanticsVersion: 1,
      performedSemanticsVersion: 1,
      performedLoadType: "barbell",
      performedLoadSemantics: "total",
      currentExerciseMetricType: "weight_reps",
      loadType: "barbell",
      loadSemantics: "total",
      loadEntryMeaning: "total_system",
      weight: 100,
      reps: 8,
    });
    const supported = {
      semantics,
      reps: 8,
      weight: 100,
      weightUnit: "lb" as const,
      targetRepsMin: 8,
      targetRepsMax: 10,
      targetLoad: 100,
      targetLoadUnit: "lb" as const,
    };
    expect(classifyPrescriptionOutcome(supported)).toBe("at");
    expect(classifyPrescriptionOutcome({
      ...supported,
      targetLoad: null,
      targetLoadUnit: null,
      targetLoadPercent: 80,
    })).toBe("unknown");
    expect(classifyPrescriptionOutcome({
      ...supported,
      targetLoad: null,
      targetLoadUnit: null,
      targetLoadText: "moderate band",
    })).toBe("unknown");
    expect(classifyPrescriptionOutcome({
      ...supported,
      targetLoadUnit: null,
    })).toBe("unknown");
  });
});
