import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import {
  coachingInsights,
  completedSets,
  exercises,
  fatigueLogs,
  healthActivities,
  progressionJobs,
  recommendations,
  sessionExercises,
  sessionNotes,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplates,
} from "@/db/schema";
import {
  buildTrainingDigest,
  renderCoachingBrief,
} from "@/services/digest";
import { buildLlmTrainingSource } from "@/services/llm-training-source";
import { createContextualNote } from "@/services/contextual-notes";
import { getHistoryReport } from "@/services/history-report";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";
import { activateProgramAtomically } from "@/services/program-activation";

const NOW = new Date("2026-08-18T20:00:00.000Z");

async function seedReportingPeriod(db: Db) {
  const [{ id: userId }] = await db
    .insert(users)
    .values({ email: `report-digest-${crypto.randomUUID()}@example.com` })
    .returning({ id: users.id });
  await db.insert(userProfiles).values({
    userId,
    timezone: "UTC",
    unit: "kg",
    experience: "intermediate",
    weeklyFrequency: 3,
    sessionLengthMin: 45,
  });
  const [{ id: exerciseId, name: exerciseName }] = await db
    .insert(exercises)
    .values({
      name: `Barbell Bench Press ${crypto.randomUUID()}`,
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "barbell",
      metricType: "weight_reps",
      loadSemantics: "total",
      isUnilateral: false,
    })
    .returning({ id: exercises.id, name: exercises.name });
  const [{ id: deadBugExerciseId }] = await db
    .insert(exercises)
    .values({
      name: `Dead Bug ${crypto.randomUUID()}`,
      movementPattern: "core",
      primaryMuscles: ["core"],
      loadType: "bodyweight",
      metricType: "reps",
      loadSemantics: "bodyweight",
      isUnilateral: false,
    })
    .returning({ id: exercises.id });
  const activation = await activateProgramAtomically(db, {
    userId,
    loadUnit: "kg",
    programName: "Reporting Program",
    days: [{
      name: "Structured A",
      exercises: [{
        exerciseId,
        sets: 1,
        repMin: 8,
        repMax: 10,
        targetLoad: 90,
        restSec: 60,
        supersetKey: null,
        notes: null,
      }],
    }],
    changeSummary: "Reporting digest fixture",
    auditAction: "program.activate",
    auditSummary: "Reporting digest fixture",
    structuredIntentReviewed: true,
  });
  if (!activation.ok) throw new Error(activation.reason);
  const programDay = await db.query.workoutTemplates.findFirst({
    where: eq(workoutTemplates.programVersionId, activation.programVersionId),
  });
  if (!programDay) throw new Error("Reporting Program day missing.");

  const [{ id: baselineSessionId }] = await db
    .insert(workoutSessions)
    .values({
      userId,
      templateName: "Baseline A",
      status: "completed",
      startedAt: new Date("2026-07-01T18:00:00.000Z"),
      finishedAt: new Date("2026-07-01T18:45:00.000Z"),
      timezone: "UTC",
      localDate: "2026-07-01",
      sourceProgramId: activation.programId,
      sourceProgramVersionId: activation.programVersionId,
      sourceDayLineageId: programDay.lineageId,
      completionSemanticsVersion: 1,
      completionState: "completed_as_prescribed",
    })
    .returning({ id: workoutSessions.id });
  const [{ id: baselineExerciseId }] = await db
    .insert(sessionExercises)
    .values({
      sessionId: baselineSessionId,
      exerciseId,
      orderIdx: 0,
      targetSets: 1,
      targetRepsMin: 8,
      targetRepsMax: 10,
      targetLoad: 90,
      targetLoadUnit: "kg",
      prescribedSemanticsVersion: 1,
      prescribedExerciseName: exerciseName,
      prescribedMetricType: "weight_reps",
      prescribedLoadType: "barbell",
      prescribedLoadSemantics: "total",
      prescribedCountingSemanticsVersion: 1,
      prescribedCountingBasis: "not_applicable",
    })
    .returning({ id: sessionExercises.id });
  const baselineEquipmentSnapshotId = await createTotalSystemTestSnapshot(db, {
    userId,
    sessionId: baselineSessionId,
    sessionExerciseId: baselineExerciseId,
    unit: "kg",
    label: "Reporting baseline barbell",
    selectAsCurrent: true,
  });
  const [{ id: baselineSetId }] = await db
    .insert(completedSets)
    .values({
      sessionExerciseId: baselineExerciseId,
      setNo: 1,
      weight: 95,
      weightUnit: "kg",
      loadEntryMeaning: "total_system",
      equipmentSnapshotId: baselineEquipmentSnapshotId,
      reps: 10,
      metricType: "weight_reps",
      performedSemanticsVersion: 1,
      performedLoadType: "barbell",
      performedLoadSemantics: "total",
      observedCompletedAt: new Date("2026-07-01T18:05:00.000Z"),
      observedCompletionProvenance: "live_client",
      observedCompletionQuality: "trustworthy",
    })
    .returning({ id: completedSets.id });
  await db.insert(sessionOccurrences).values({
    sessionId: baselineSessionId,
    sessionExerciseId: baselineExerciseId,
    kind: "working_set",
    origin: "planned",
    sequenceIdx: 0,
    kindOrdinal: 0,
    plannedExerciseId: exerciseId,
    plannedRepsMin: 8,
    plannedRepsMax: 10,
    plannedLoad: 90,
    plannedLoadUnit: "kg",
    outcome: "completed",
    completedSetId: baselineSetId,
    equipmentSnapshotId: baselineEquipmentSnapshotId,
    resolvedAt: new Date("2026-07-01T18:05:00.000Z"),
  });

  const sessionInputs = [
    {
      templateName: "Structured A",
      localDate: "2026-08-17",
      startedAt: new Date("2026-08-17T18:00:00.000Z"),
      finishedAt: new Date("2026-08-17T19:03:00.000Z"),
      activeDurationSeconds: 63 * 60,
    },
    {
      templateName: "Structured B",
      localDate: "2026-08-18",
      startedAt: new Date("2026-08-18T18:00:00.000Z"),
      finishedAt: new Date("2026-08-18T18:57:00.000Z"),
      activeDurationSeconds: 57 * 60,
    },
  ];
  const sessionIds: string[] = [];
  const occurrenceIds: string[] = [];
  const setIds: string[] = [];

  for (const [sessionIndex, input] of sessionInputs.entries()) {
    const [{ id: sessionId }] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: input.templateName,
        status: "completed",
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        timezone: "UTC",
        localDate: input.localDate,
        activeDurationSemanticsVersion: 1,
        activeDurationSeconds: input.activeDurationSeconds,
        activeDurationBasis: "owner_reported",
        plannedDurationSemanticsVersion: 1,
        plannedDurationMinMinutes: 45,
        plannedDurationMaxMinutes: 45,
        plannedDurationSource: "program_day_target",
        timeBudgetMin: 45,
        completionSemanticsVersion: 1,
        completionState: "completed_with_remaining_work",
        completionReason: "time_limit_reached",
        sourceProgramId: activation.programId,
        sourceProgramVersionId: activation.programVersionId,
        sourceDayLineageId: programDay.lineageId,
      })
      .returning({ id: workoutSessions.id });
    sessionIds.push(sessionId);
    const [{ id: sessionExerciseId }] = await db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId,
        orderIdx: 0,
        targetSets: 32,
        targetRepsMin: 8,
        targetRepsMax: 10,
        notes: sessionIndex === 0
          ? "Keep shoulder blades steady on every set."
          : null,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: exerciseName,
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
        prescribedCountingSemanticsVersion: 1,
        prescribedCountingBasis: "not_applicable",
      })
      .returning({ id: sessionExercises.id });
    const equipmentSnapshotId = await createTotalSystemTestSnapshot(db, {
      userId,
      sessionId,
      sessionExerciseId,
      unit: "kg",
      label: `Reporting barbell ${sessionIndex + 1}`,
      selectAsCurrent: true,
    });

    const completedCount = sessionIndex === 0 ? 2 : 0;
    for (let index = 0; index < completedCount; index += 1) {
      const [{ id: setId }] = await db
        .insert(completedSets)
        .values({
          sessionExerciseId,
          setNo: index + 1,
          reps: 12,
          weight: 100,
          weightUnit: "kg",
          metricType: "weight_reps",
          performedSemanticsVersion: 1,
          performedLoadType: "barbell",
          performedLoadSemantics: "total",
          loadEntryMeaning: "total_system",
          equipmentSnapshotId,
          observedCompletedAt: new Date(
            input.startedAt.getTime() + (index + 1) * 60_000,
          ),
          observedCompletionProvenance: "live_client",
          observedCompletionQuality: "trustworthy",
        })
        .returning({ id: completedSets.id });
      setIds.push(setId);
      const [{ id: occurrenceId }] = await db
        .insert(sessionOccurrences)
        .values({
          sessionId,
          sessionExerciseId,
          kind: "working_set",
          origin: "planned",
          sequenceIdx: index,
          kindOrdinal: index,
          plannedExerciseId: exerciseId,
          plannedRepsMin: 8,
          plannedRepsMax: 10,
          plannedLoad: 90,
          plannedLoadUnit: "kg",
          plannedRestSec: 60,
          outcome: "completed",
          resolvedAt: input.finishedAt,
          completedSetId: setId,
          equipmentSnapshotId,
        })
        .returning({ id: sessionOccurrences.id });
      occurrenceIds.push(occurrenceId);
    }

    const remainingOccurrences = Array.from(
      { length: 32 - completedCount },
      (_, offset) => {
        const ordinal = completedCount + offset;
        return {
          sessionId,
          sessionExerciseId,
          kind: "working_set",
          origin: "planned",
          sequenceIdx: ordinal,
          kindOrdinal: ordinal,
          plannedExerciseId: exerciseId,
          plannedRepsMin: 8,
          plannedRepsMax: 10,
          plannedLoad: 90,
          plannedLoadUnit: "kg",
          plannedRestSec: 60,
          outcome: "abandoned",
          outcomeReason: "session_end:time_limit_reached",
          resolutionSemanticsVersion: 1,
          resolutionReasonCode: "time_limit_reached",
          resolvedAt: input.finishedAt,
        } as const;
      },
    );
    const insertedRemaining = await db
      .insert(sessionOccurrences)
      .values(remainingOccurrences)
      .returning({ id: sessionOccurrences.id });
    occurrenceIds.push(...insertedRemaining.map(({ id }) => id));

    if (sessionIndex === 0) {
      const [{ id: deadBugSessionExerciseId }] = await db
        .insert(sessionExercises)
        .values({
          sessionId,
          exerciseId: deadBugExerciseId,
          orderIdx: 1,
          targetSets: 1,
          targetRepsMin: 20,
          targetRepsMax: 20,
          modificationType: "added",
        })
        .returning({ id: sessionExercises.id });
      const [{ id: deadBugSetId }] = await db
        .insert(completedSets)
        .values({
          sessionExerciseId: deadBugSessionExerciseId,
          setNo: 1,
          reps: 20,
          metricType: "reps",
          performedSemanticsVersion: 1,
          performedLoadType: "bodyweight",
          performedLoadSemantics: "bodyweight",
          observedCompletedAt: new Date(input.startedAt.getTime() + 10 * 60_000),
          observedCompletionProvenance: "live_client",
          observedCompletionQuality: "trustworthy",
        })
        .returning({ id: completedSets.id });
      setIds.push(deadBugSetId);
      const [{ id: deadBugOccurrenceId }] = await db
        .insert(sessionOccurrences)
        .values({
          sessionId,
          sessionExerciseId: deadBugSessionExerciseId,
          kind: "working_set",
          origin: "ad_hoc",
          sequenceIdx: 90,
          kindOrdinal: 0,
          plannedExerciseId: deadBugExerciseId,
          outcome: "completed",
          completedSetId: deadBugSetId,
          resolvedAt: input.finishedAt,
        })
        .returning({ id: sessionOccurrences.id });
      occurrenceIds.push(deadBugOccurrenceId);
      const warmups = Array.from({ length: 7 }, (_, index) => ({
        sessionId,
        sessionExerciseId,
        kind: "exercise_warmup",
        origin: "planned",
        sequenceIdx: 100 + index,
        kindOrdinal: index,
        plannedExerciseId: exerciseId,
        plannedRepsMin: 5,
        plannedRepsMax: 5,
        outcome: index < 5 ? "completed" : "abandoned",
        outcomeReason:
          index < 5 ? null : "session_end:time_limit_reached",
        resolutionSemanticsVersion: index < 5 ? null : 1,
        resolutionReasonCode:
          index < 5 ? null : "time_limit_reached",
        resolvedAt: input.finishedAt,
      } as const));
      const insertedWarmups = await db
        .insert(sessionOccurrences)
        .values(warmups)
        .returning({ id: sessionOccurrences.id });
      occurrenceIds.push(...insertedWarmups.map(({ id }) => id));
    }
  }

  const [{ id: activityId }] = await db
    .insert(healthActivities)
    .values({
      userId,
      activityType: "walking",
      title: "Recovery walk",
      startedAt: new Date("2026-08-18T12:00:00.000Z"),
      timezone: "UTC",
      durationSeconds: 2_235,
      distanceKm: 3.6,
      source: "manual",
      fingerprint: `report-${crypto.randomUUID()}`,
    })
    .returning({ id: healthActivities.id });

  return {
    userId,
    sessionIds,
    occurrenceIds,
    setIds,
    activityId,
    progressionBaselineDate: "2026-07-01",
  };
}

describe("training reporting digest integration", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => database.close());

  it("renders coverage-first, time-aware, compact, and auditable coach evidence", async () => {
    const fixture = await seedReportingPeriod(database.db);
    const digest = await buildTrainingDigest(
      database.db,
      fixture.userId,
      new Date("2026-08-04T00:00:00.000Z"),
      NOW,
    );
    const brief = renderCoachingBrief(digest);
    const history = await getHistoryReport(
      database.db,
      fixture.userId,
      "4w",
      3,
      NOW,
    );

    expect(digest.reporting.targetAttainment.coverage).toMatchObject({
      numerator: 2,
      denominator: 64,
      percentage: 3.1,
    });
    expect(digest.reporting.targetAttainment.rawStatistic).toMatchObject({
      atOrAbove: 2,
      evaluable: 2,
      atOrAbovePercentage: 100,
    });
    expect(digest.reporting.targetAttainment.conclusion).toMatchObject({
      eligible: false,
      status: "insufficient_coverage",
    });
    expect(history.overview.targetOutcomes).toMatchObject({
      supported: 2,
      unknown: 62,
      atOrAboveRate: 100,
    });
    expect(history.overview.targetDenominatorComplete).toBe(true);
    expect(digest.reporting.nonCompletionPattern).toMatchObject({
      status: "dominant",
      dominantReason: "time_limit_reached",
    });
    expect(digest.reporting.currentProgressionBaselineDate).toBe(
      fixture.progressionBaselineDate,
    );

    expect(brief).toContain("## Coach Summary");
    expect(brief.slice(0, brief.indexOf("## Compact workout summaries")).length)
      .toBeLessThan(5_000);
    expect(brief).toContain("exact IDs in the audit appendix");
    expect(brief.indexOf("## Compact workout summaries")).toBeLessThan(
      brief.indexOf("## Target attainment and confidence"),
    );
    expect(brief).toContain(
      "Completed sessions with comparable duration evidence averaged 60 minutes against a 45-minute planned midpoint.",
    );
    expect(brief).toContain(
      "Target-attainment coverage: 2 of 64 planned outcomes evaluable (3.1%).",
    );
    expect(brief).toContain(
      "Of the 2 evaluable outcomes, 2/2 were at or above target (100%).",
    );
    expect(brief).toContain(
      "Coverage is insufficient for an overall attainment conclusion",
    );
    expect(brief).toContain(
      "Duration comparisons are neutral context. Longer or shorter sessions do not by themselves prove adherence, quality, fatigue, motivation, recovery, or why a workout ended.",
    );
    expect(brief).toContain(
      "Recorded active time: 63 min. Difference: +18 min / +40%. Comparison to planned range: over target. Within tolerance: no.",
    );
    expect(brief).toContain(
      "Warm-up: 5 of 7 planned elements completed.",
    );
    expect(brief).toContain("30 ended with the session");
    expect(brief).not.toMatch(/no sets/iu);
    expect(brief).toContain(
      "bodyweight × 20 reps (counting basis unknown)",
    );
    expect(brief).toContain(
      "0 of 1 performed set is eligible for progression analysis",
    );
    expect(brief).toContain("planned in 2 sessions; performed in 1 session");
    expect(brief).toContain("Eligible loaded-volume evidence: 2 of 2 retained set rows (100%)");
    expect(brief).toContain("source manual");
    expect(brief).toContain(
      "Recovery walk, 37 min 15 sec, 3.6 km",
    );
    expect(brief).toContain(`[health_activity:${fixture.activityId}]`);
    expect(brief).toContain("## Detailed audit appendix");
    expect(brief).toContain(
      `Current progression baseline begins on ${fixture.progressionBaselineDate}.`,
    );
    expect(brief).toContain(
      "coverage_metric:coverage-major-dimensions",
    );
    expect(brief).toContain(
      "coverage_metric:coverage-target-attainment",
    );
    expect(brief).toContain("Numerator evidence:");
    expect(brief).toContain("Denominator evidence:");
    for (const id of [
      ...fixture.sessionIds,
      ...fixture.setIds,
      fixture.activityId,
    ]) {
      expect(brief).toContain(id);
    }
    expect(brief.indexOf("Performed set 1:")).toBeGreaterThan(
      brief.indexOf("## Detailed audit appendix"),
    );
  });

  it("reads all retained evidence when the report range is unbounded", async () => {
    const fixture = await seedReportingPeriod(database.db);
    await database.db.insert(healthActivities).values([
      ...Array.from({ length: 7 }, (_, index) => ({
        userId: fixture.userId,
        activityType: "walking" as const,
        title: `Earlier retained walk ${index + 1}`,
        startedAt: new Date(`2026-01-${String(index + 3).padStart(2, "0")}T12:00:00.000Z`),
        timezone: "UTC",
        durationSeconds: 1_200 + index,
        source: "manual" as const,
        fingerprint: `all-time-${crypto.randomUUID()}`,
      })),
      {
        userId: fixture.userId,
        activityType: "cycling" as const,
        title: "Excluded retained ride",
        startedAt: new Date("2026-01-02T12:00:00.000Z"),
        timezone: "UTC",
        durationSeconds: 2_400,
        distanceKm: 12.5,
        elevationGainM: 259.08,
        notes: "Easy conversational pace despite the hills.",
        originalMetrics: {
          distanceValue: 7.77,
          distanceUnit: "mi" as const,
          elevationValue: 850,
          elevationUnit: "ft" as const,
        },
        source: "manual" as const,
        excludeFromAnalytics: true,
        fingerprint: `all-time-excluded-${crypto.randomUUID()}`,
      },
    ]);

    const allTime = await buildTrainingDigest(
      database.db,
      fixture.userId,
      null,
      NOW,
    );
    const bounded = await buildTrainingDigest(
      database.db,
      fixture.userId,
      new Date("2026-08-01T00:00:00.000Z"),
      NOW,
    );

    expect(allTime.range.since.toISOString()).toBe(
      "2026-01-02T12:00:00.000Z",
    );
    expect(allTime.independentActivities.overview.totalActivities).toBe(
      bounded.independentActivities.overview.totalActivities + 7,
    );
    expect(allTime.independentActivities.recent).toHaveLength(5);
    expect(allTime.independentActivities.recent).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Earlier retained walk 1" }),
      ]),
    );
    expect(allTime.independentActivities.retained).toHaveLength(9);
    expect(allTime.independentActivities.retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Earlier retained walk 1",
          durationSeconds: 1_200,
          excludeFromAnalytics: false,
        }),
        expect.objectContaining({
          title: "Excluded retained ride",
          distanceKm: 12.5,
          excludeFromAnalytics: true,
        }),
      ]),
    );
    const brief = renderCoachingBrief(allTime);
    expect(brief).toContain("Earlier retained walk 1, 20 min");
    expect(brief).toContain("Excluded retained ride, 40 min, 12.5 km");
    expect(brief).toContain("original recorded distance 7.77 mi");
    expect(brief).toContain("original recorded elevation 850 ft");
    expect(brief).toContain("Easy conversational pace despite the hills.");
    expect(brief).toContain("analytics excluded by retained record");
    expect(brief).toContain(
      'Exercise note: "Keep shoulder blades steady on every set."',
    );
  });

  it("preserves detailed retained training fields in the private report source", async () => {
    const fixture = await seedReportingPeriod(database.db);
    await database.db
      .update(completedSets)
      .set({
        rir: 2,
        note: "Left one clean rep in reserve.",
        techniqueIssue: "control",
        limitationCause: "mobility",
        targetMet: true,
        restTakenSec: 75,
      })
      .where(eq(completedSets.id, fixture.setIds[0]!));
    await database.db.insert(sessionNotes).values({
      sessionId: fixture.sessionIds[0]!,
      text: "Whole-session note retained verbatim.",
      createdAt: new Date("2026-08-17T19:04:00.000Z"),
    });
    await database.db.insert(fatigueLogs).values({
      userId: fixture.userId,
      sessionId: fixture.sessionIds[0]!,
      severity: 4,
      note: "Sleep was interrupted the night before.",
      createdAt: new Date("2026-08-17T19:05:00.000Z"),
    });
    await database.db.insert(healthActivities).values({
      userId: fixture.userId,
      activityType: "cycling",
      title: "Retained source ride",
      startedAt: new Date("2026-08-16T12:00:00.000Z"),
      timezone: "UTC",
      durationSeconds: 2_400,
      distanceKm: 12.5,
      notes: "Easy ride with one long hill.",
      source: "manual",
      sourceRecordId: "provider-private-record-id",
      sourceMetadata: { rawProviderPayload: "must-not-leave-repbook" },
      originalMetrics: { distanceValue: 7.77, distanceUnit: "mi" },
      fingerprint: `source-${crypto.randomUUID()}`,
    });
    const capturedContext = {
      schemaVersion: 1 as const,
      destination: "history" as const,
      workflow: null,
      workoutPhase: "review" as const,
      originatedFromSimulation: false,
      programDay: null,
      plannedExercise: null,
      performedExercise: null,
      occurrence: null,
      loadRepetitions: null,
      restContext: null,
      reviewContext: null,
    };
    await createContextualNote(database.db, fixture.userId, {
      clientKey: crypto.randomUUID(),
      body: "Coach-visible context retained.",
      coachVisible: true,
      inputMode: "typed",
      attachmentKind: "general",
      capturedContext,
      recordedAt: "2026-08-17T20:00:00.000Z",
    });
    await createContextualNote(database.db, fixture.userId, {
      clientKey: crypto.randomUUID(),
      body: "Private context must stay out.",
      coachVisible: false,
      inputMode: "typed",
      attachmentKind: "general",
      capturedContext,
      recordedAt: "2026-08-17T20:01:00.000Z",
    });
    const [{ id: abandonedSessionId }] = await database.db
      .insert(workoutSessions)
      .values({
        userId: fixture.userId,
        templateName: "Retained abandoned workout",
        status: "abandoned",
        startedAt: new Date("2026-08-15T18:00:00.000Z"),
        finishedAt: new Date("2026-08-15T18:10:00.000Z"),
        timezone: "UTC",
        localDate: "2026-08-15",
        sourceWorkoutKey: "private-retrospective-request-key",
      })
      .returning({ id: workoutSessions.id });
    await database.db.insert(coachingInsights).values([
      {
        userId: fixture.userId,
        kind: "live_user",
        contentMd: "Was this set strong enough to progress?",
        dataDigest: {},
        sessionId: fixture.sessionIds[0]!,
        author: "user",
        messageKind: "question",
        inputMode: "text",
        responseStatus: "saved",
        createdAt: new Date("2026-08-17T20:02:00.000Z"),
      },
      {
        userId: fixture.userId,
        kind: "live_user",
        contentMd: "I stopped this workout early.",
        dataDigest: {},
        sessionId: abandonedSessionId,
        author: "user",
        messageKind: "observation",
        inputMode: "text",
        responseStatus: "saved",
        createdAt: new Date("2026-08-15T18:09:00.000Z"),
      },
    ]);
    const [{ id: progressionJobId }] = await database.db
      .insert(progressionJobs)
      .values({
        userId: fixture.userId,
        sessionId: fixture.sessionIds[0]!,
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
        status: "pending",
        createdAt: new Date("2026-08-17T20:03:00.000Z"),
        updatedAt: new Date("2026-08-17T20:03:00.000Z"),
      })
      .returning({ id: progressionJobs.id });
    await database.db.insert(recommendations).values({
      userId: fixture.userId,
      source: "rule",
      status: "rejected",
      decidedAt: new Date("2026-08-17T20:05:00.000Z"),
      ruleId: "report-source-privacy-fixture",
      progressionJobId,
      payload: {
        kind: "hold",
        templateExerciseId: crypto.randomUUID(),
        reason: "Retain current load for review.",
      },
      reason: "Retain current load for review.",
      evidence: { signals: {} },
      createdAt: new Date("2026-08-17T20:04:00.000Z"),
    });

    const source = await buildLlmTrainingSource(
      database.db,
      fixture.userId,
      NOW,
    );
    const serialized = JSON.stringify(source);

    expect(source.schemaVersion).toBe("llm-training-source/1");
    expect(source.workoutSessions).toHaveLength(4);
    expect(source.sessionEquipmentSnapshots.length).toBeGreaterThan(0);
    expect(serialized).toContain('"rir":2');
    expect(serialized).toContain("Left one clean rep in reserve.");
    expect(serialized).toContain('\"techniqueIssue\":\"control\"');
    expect(serialized).toContain('\"limitationCause\":\"mobility\"');
    expect(serialized).toContain("Whole-session note retained verbatim.");
    expect(serialized).toContain("Sleep was interrupted the night before.");
    expect(serialized).toContain("Easy ride with one long hill.");
    expect(serialized).toContain('"distanceValue":7.77');
    expect(serialized).toContain("Coach-visible context retained.");
    expect(serialized).toContain("Was this set strong enough to progress?");
    expect(serialized).toContain("I stopped this workout early.");
    expect(serialized).toContain("report-source-privacy-fixture");
    expect(serialized).not.toContain("Private context must stay out.");
    expect(serialized).not.toContain("provider-private-record-id");
    expect(serialized).not.toContain("must-not-leave-repbook");
    expect(serialized).not.toContain(fixture.userId);
    expect(serialized).not.toContain('"clientKey"');
    expect(serialized).not.toContain("private-retrospective-request-key");
    expect(serialized).not.toContain('"sourceWorkoutKey"');
    expect(serialized).not.toContain('"fingerprint"');
    expect(serialized).not.toContain('"sourceMetadata"');
    expect(serialized).not.toContain(progressionJobId);
    expect(serialized).not.toContain('"progressionJobId"');
  });

  it("retries the source projection when tracked evidence changes mid-read", async () => {
    const fixture = await seedReportingPeriod(database.db);
    let checkpointCalls = 0;

    const source = await buildLlmTrainingSource(
      database.db,
      fixture.userId,
      NOW,
      {
        afterStartingEvidenceRead: async (attempt) => {
          checkpointCalls += 1;
          if (attempt !== 0) return;
          await database.db
            .insert(healthActivities)
            .values({
              userId: fixture.userId,
              activityType: "walking",
              title: "Inserted during first source read",
              startedAt: new Date("2026-08-14T12:00:00.000Z"),
              timezone: "UTC",
              durationSeconds: 1_200,
              source: "manual",
              fingerprint: `mid-read-${crypto.randomUUID()}`,
            });
        },
      },
    );

    expect(checkpointCalls).toBe(2);
    const [owner] = await database.db
      .select({ revision: users.analysisEvidenceRevision })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(source.evidenceRevision).toBe(String(owner!.revision));
    expect(source.independentActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Inserted during first source read" }),
      ]),
    );
  });

  it("retries once when the analytical evidence revision changes mid-read", async () => {
    const fixture = await seedReportingPeriod(database.db);
    let checkpointCalls = 0;
    const digest = await buildTrainingDigest(
      database.db,
      fixture.userId,
      new Date("2026-08-04T00:00:00.000Z"),
      NOW,
      {
        afterStartingEvidenceRead: async (attempt) => {
          checkpointCalls += 1;
          if (attempt !== 0) return;
          const [owner] = await database.db
            .select({ revision: users.analysisEvidenceRevision })
            .from(users)
            .where(eq(users.id, fixture.userId));
          await database.db
            .update(users)
            .set({ analysisEvidenceRevision: owner!.revision + 1 })
            .where(eq(users.id, fixture.userId));
        },
      },
    );

    expect(checkpointCalls).toBe(2);
    const [owner] = await database.db
      .select({ revision: users.analysisEvidenceRevision })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(digest.reporting.evidenceRevision).toBe(String(owner!.revision));
  });

  it("refuses the report when evidence changes during both coherent-read attempts", async () => {
    const fixture = await seedReportingPeriod(database.db);
    await expect(
      buildTrainingDigest(
        database.db,
        fixture.userId,
        new Date("2026-08-04T00:00:00.000Z"),
        NOW,
        {
          afterStartingEvidenceRead: async () => {
            const [owner] = await database.db
              .select({ revision: users.analysisEvidenceRevision })
              .from(users)
              .where(eq(users.id, fixture.userId));
            await database.db
              .update(users)
              .set({ analysisEvidenceRevision: owner!.revision + 1 })
              .where(eq(users.id, fixture.userId));
          },
        },
      ),
    ).rejects.toThrow(
      "Training evidence changed while the report was being assembled.",
    );
  });

  it("keeps date-only terminal history visible when no finish instant exists", async () => {
    const [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `date-only-report-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId,
      timezone: "America/Toronto",
      weeklyFrequency: 3,
      sessionLengthMin: 45,
    });
    const [{ id: sessionId }] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Retained date-only workout",
        status: "completed",
        startedAt: new Date("2026-08-10T16:00:00.000Z"),
        finishedAt: null,
        performedTimePrecision: "date_only",
        timezone: "America/Toronto",
        localDate: "2026-08-10",
      })
      .returning({ id: workoutSessions.id });
    const [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: `Legacy row ${crypto.randomUUID()}`,
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
      })
      .returning({ id: exercises.id });
    const [{ id: sessionExerciseId }] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId,
        orderIdx: 0,
        targetSets: 1,
      })
      .returning({ id: sessionExercises.id });
    await database.db.insert(completedSets).values({
      sessionExerciseId,
      setNo: 1,
      weight: 40,
      weightUnit: "kg",
      reps: 10,
    });

    const digest = await buildTrainingDigest(
      database.db,
      userId,
      new Date("2026-08-04T00:00:00.000Z"),
      NOW,
    );
    const brief = renderCoachingBrief(digest);

    expect(digest.sessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        status: "completed",
        durationAdherence: expect.objectContaining({
          actualMinutes: null,
          status: "unknown",
        }),
      }),
    ]);
    expect(brief).toContain("Retained date-only workout");
    expect(brief).toContain("Recorded active time: unknown");
    expect(digest.families).toEqual([
      expect.objectContaining({
        family: "Unclassified",
        plannedSessions: 0,
        performedSessions: 1,
        sets: 1,
      }),
    ]);
    expect(brief).toContain("plan linkage unknown");
    expect(brief).toContain(
      "legacy denominator rule: 1 retained target set slot minus 0 retained planned working-ledger occurrences; synthetic missing slot 1",
    );
  });
});
