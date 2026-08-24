import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  completedSets,
  exercises,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import {
  appendWorkoutSetOccurrence,
  logWorkoutSet,
  mutateWorkoutOccurrence,
} from "@/services/session-lifecycle";
import { workingSetDisplayPosition } from "@/lib/session-occurrences";
import {
  updateSessionExerciseWithVersion,
  updateSetWithVersion,
} from "@/services/record-versions";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import {
  seedT01RecordingTruth,
  type T01RecordingTruthFixture,
} from "../helpers/v2-t01-recording-truth";

describe("V2 T03 planned order and extra-set truth", () => {
  let database: TestDatabase;
  let fixture: T01RecordingTruthFixture;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    fixture = await seedT01RecordingTruth(database.db);
  }, 30_000);

  afterEach(async () => database.close());

  it("keeps an earlier day warm-up ahead of working-set completion or skip", async () => {
    const [sessionExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: fixture.sessionId,
        exerciseId: fixture.exerciseIds.loaded,
        orderIdx: 7,
        targetSets: 1,
        targetRepsMin: 5,
        targetRepsMax: 5,
        targetLoad: 100,
        targetLoadUnit: "kg",
      })
      .returning({ id: sessionExercises.id });
    const [dayWarmup, working] = await database.db
      .insert(sessionOccurrences)
      .values([
        {
          sessionId: fixture.sessionId,
          sessionExerciseId: null,
          kind: "day_warmup" as const,
          origin: "planned" as const,
          sequenceIdx: 7,
          kindOrdinal: 0,
          label: "General warm-up",
        },
        {
          sessionId: fixture.sessionId,
          sessionExerciseId: sessionExercise.id,
          kind: "working_set" as const,
          origin: "planned" as const,
          sequenceIdx: 8,
          kindOrdinal: 0,
          plannedExerciseId: fixture.exerciseIds.loaded,
          plannedRepsMin: 5,
          plannedRepsMax: 5,
          plannedLoad: 100,
          plannedLoadUnit: "kg" as const,
          plannedRestSec: 90,
        },
      ])
      .returning({ id: sessionOccurrences.id });
    const command = {
      ...fixture.commands.loaded,
      sessionExerciseId: sessionExercise.id,
      clientKey: "t03-loaded-before-day-warmup",
    };

    await expect(
      logWorkoutSet(database.db, fixture.userId, command),
    ).resolves.toMatchObject({
      outcome: "set_order_conflict",
      blocker: {
        occurrenceId: dayWarmup.id,
        sessionExerciseId: null,
        kind: "day_warmup",
        setNo: 0,
        label: "Workout warm-up · warm-up",
      },
    });
    await expect(
      mutateWorkoutOccurrence(database.db, fixture.userId, {
        occurrenceId: working.id,
        operation: "skip",
        reason: "not attempted",
        expectedRevision: 0,
        clientKey: "t03-working-skip-before-day-warmup",
      }),
    ).resolves.toEqual({ outcome: "conflict" });

    await expect(
      mutateWorkoutOccurrence(database.db, fixture.userId, {
        occurrenceId: dayWarmup.id,
        operation: "skip",
        reason: "time",
        expectedRevision: 0,
        clientKey: "t03-day-warmup-skip",
      }),
    ).resolves.toMatchObject({ outcome: "saved" });
    const saved = await logWorkoutSet(database.db, fixture.userId, {
        ...command,
        clientKey: "t03-loaded-after-day-warmup",
      });
    expect(saved).toMatchObject({ outcome: "saved" });
    if (saved.outcome !== "saved") throw new Error(saved.outcome);

    await expect(updateSessionExerciseWithVersion(
      database.db,
      fixture.userId,
      sessionExercise.id,
      { modificationType: "skipped", skipReason: "user_choice" },
      "session_exercise.skip",
      { activeOnly: true },
    )).resolves.toMatchObject({ ok: true, changed: true });
    await expect(
      database.db.query.sessionExercises.findMany({
        where: eq(sessionExercises.exerciseId, fixture.exerciseIds.loaded),
        columns: { id: true, modificationType: true },
        orderBy: asc(sessionExercises.orderIdx),
      }),
    ).resolves.toEqual(expect.arrayContaining([
      {
        id: fixture.sessionExerciseIds.loaded,
        modificationType: "as_planned",
      },
      { id: sessionExercise.id, modificationType: "skipped" },
    ]));
    await expect(
      database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, saved.setId),
        columns: { sessionExerciseId: true },
      }),
    ).resolves.toEqual({ sessionExerciseId: sessionExercise.id });

    await expect(updateSessionExerciseWithVersion(
      database.db,
      fixture.userId,
      sessionExercise.id,
      { modificationType: "as_planned", skipReason: null },
      "session_exercise.unskip",
      { activeOnly: true },
    )).resolves.toMatchObject({ ok: true, changed: true });
    await expect(
      database.db.query.sessionExercises.findFirst({
        where: eq(sessionExercises.id, sessionExercise.id),
        columns: { modificationType: true },
      }),
    ).resolves.toEqual({ modificationType: "as_planned" });
  });

  it("never lets another owner's day warm-up block this workout", async () => {
    const [otherUser] = await database.db
      .insert(users)
      .values({ email: "t03-other-owner@example.com" })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId: otherUser.id,
      timezone: "America/Toronto",
      unit: "lb",
    });
    const [otherSession] = await database.db
      .insert(workoutSessions)
      .values({
        userId: otherUser.id,
        templateName: "Other workout",
        status: "in_progress",
        startedAt: new Date("2026-08-22T16:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-08-22",
      })
      .returning({ id: workoutSessions.id });
    await database.db.insert(sessionOccurrences).values({
      sessionId: otherSession.id,
      sessionExerciseId: null,
      kind: "day_warmup",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      label: "Other owner's warm-up",
    });
    const working = await database.db.query.sessionOccurrences.findFirst({
      where: eq(
        sessionOccurrences.sessionExerciseId,
        fixture.sessionExerciseIds.loaded,
      ),
      columns: { id: true },
    });
    if (!working) throw new Error("Expected the owned working occurrence.");

    await expect(mutateWorkoutOccurrence(database.db, fixture.userId, {
      occurrenceId: working.id,
      operation: "skip",
      reason: "owner chose to skip",
      expectedRevision: 0,
      clientKey: "t03-cross-session-warmup",
    })).resolves.toMatchObject({ outcome: "saved" });
  });

  it("keeps planned ordinals pending while an extra is performed before and after the plan", async () => {
    const loadedExerciseId = fixture.sessionExerciseIds.loaded;
    await database.db.insert(sessionOccurrences).values([
      {
        sessionId: fixture.sessionId,
        sessionExerciseId: loadedExerciseId,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 20,
        kindOrdinal: 1,
        plannedExerciseId: fixture.exerciseIds.loaded,
        plannedRepsMin: 5,
        plannedRepsMax: 5,
        plannedLoad: 100,
        plannedLoadUnit: "kg",
        plannedRestSec: 90,
      },
      {
        sessionId: fixture.sessionId,
        sessionExerciseId: loadedExerciseId,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 21,
        kindOrdinal: 2,
        plannedExerciseId: fixture.exerciseIds.loaded,
        plannedRepsMin: 5,
        plannedRepsMax: 5,
        plannedLoad: 100,
        plannedLoadUnit: "kg",
        plannedRestSec: 90,
      },
    ]);
    const authoritativeLoadedOccurrences = await database.db.query.sessionOccurrences.findMany({
      where: eq(sessionOccurrences.sessionExerciseId, loadedExerciseId),
      columns: { id: true, kindOrdinal: true, revision: true },
      orderBy: asc(sessionOccurrences.kindOrdinal),
    });
    const firstPlanned = authoritativeLoadedOccurrences[0];
    const secondPlanned = authoritativeLoadedOccurrences[1];

    const staleLaterAttempt = await logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      setNo: 2,
      clientKey: "t03-later-before-earlier",
    });
    expect(staleLaterAttempt).toMatchObject({
      outcome: "set_order_conflict",
      blocker: {
        occurrenceId: firstPlanned.id,
        occurrenceRevision: 0,
        sessionExerciseId: loadedExerciseId,
        setNo: 1,
        groupRound: null,
        origin: "planned",
        isAddedSet: false,
      },
    });
    if (staleLaterAttempt.outcome !== "set_order_conflict") {
      throw new Error(staleLaterAttempt.outcome);
    }
    expect(staleLaterAttempt.blocker.exerciseName).toMatch(/^T01 loaded press /);
    expect(staleLaterAttempt.blocker.label).toBe(
      `${staleLaterAttempt.blocker.exerciseName} · set 1`,
    );
    await expect(logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      occurrenceId: secondPlanned.id,
      expectedOccurrenceRevision: secondPlanned.revision,
      setNo: 2,
      clientKey: "t03-exact-later-before-earlier",
    })).resolves.toMatchObject({
      outcome: "set_order_conflict",
      blocker: { occurrenceId: firstPlanned.id },
    });
    await expect(logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      occurrenceId: secondPlanned.id,
      expectedOccurrenceRevision: secondPlanned.revision + 1,
      setNo: 2,
      clientKey: "t03-stale-occurrence-revision",
    })).resolves.toEqual({ outcome: "stale_occurrence" });

    const beforePlanExtraId = crypto.randomUUID();
    await expect(
      appendWorkoutSetOccurrence(database.db, fixture.userId, {
        sessionExerciseId: loadedExerciseId,
        occurrenceId: beforePlanExtraId,
        expectedSetNo: 4,
      }),
    ).resolves.toMatchObject({
      outcome: "appended",
      occurrence: { id: beforePlanExtraId, kindOrdinal: 3 },
    });

    const extraBeforePlan = await logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      setNo: 4,
      clientKey: "t03-extra-before-plan",
    });
    expect(extraBeforePlan).toMatchObject({
      outcome: "saved",
      occurrenceId: beforePlanExtraId,
    });
    expect(
      await logWorkoutSet(database.db, fixture.userId, {
        ...fixture.commands.loaded,
        setNo: 4,
        clientKey: "t03-extra-before-plan",
      }),
    ).toEqual(extraBeforePlan);

    const beforePlanRows = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, loadedExerciseId))
      .orderBy(asc(sessionOccurrences.kindOrdinal));
    expect(beforePlanRows.slice(0, 3).map((row) => ({
      origin: row.origin,
      ordinal: row.kindOrdinal,
      outcome: row.outcome,
    }))).toEqual([
      { origin: "planned", ordinal: 0, outcome: "pending" },
      { origin: "planned", ordinal: 1, outcome: "pending" },
      { origin: "planned", ordinal: 2, outcome: "pending" },
    ]);
    expect(workingSetDisplayPosition(beforePlanRows[3], beforePlanRows)).toEqual({
      kind: "extra",
      number: 1,
      label: "Extra set 1",
      lowercaseLabel: "extra set 1",
    });
    if (extraBeforePlan.outcome !== "saved") throw new Error(extraBeforePlan.outcome);
    await expect(
      database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, extraBeforePlan.setId),
        columns: { targetMet: true },
      }),
    ).resolves.toEqual({ targetMet: null });
    await expect(
      updateSetWithVersion(
        database.db,
        fixture.userId,
        extraBeforePlan.setId,
        {
          weight: 101,
          weightUnit: "kg",
          reps: 5,
          distanceKm: null,
          durationSeconds: null,
          rpe: null,
          note: "Corrected extra",
        },
        "set.active_correction",
        {
          expected: {
            weight: 100,
            weightUnit: "kg",
            reps: 5,
            distanceKm: null,
            durationSeconds: null,
            rpe: null,
            note: null,
          },
          expectedHistoryRevision: 0,
          clientMutationId: crypto.randomUUID(),
          correctionEvidence: {
            category: "measurement_entry",
            reasonNote: "T03 extra-set correction",
            source: "active_workout",
          },
        },
      ),
    ).resolves.toMatchObject({ ok: true, changed: true });
    await expect(
      database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, extraBeforePlan.setId),
        columns: { targetMet: true },
      }),
    ).resolves.toEqual({ targetMet: null });

    const lostResponseInput = {
      ...fixture.commands.loaded,
      occurrenceId: firstPlanned.id,
      expectedOccurrenceRevision: firstPlanned.revision,
      setNo: 1,
      clientKey: "t03-exact-set-lost-response",
    };
    await expect(logWorkoutSet(
      database.db,
      fixture.userId,
      lostResponseInput,
      {
        checkpoint: async (boundary) => {
          if (boundary === "after-set-statement") {
            throw new Error("simulated lost response");
          }
        },
      },
    )).rejects.toThrow("simulated lost response");
    const recoveredLostResponse = await logWorkoutSet(
      database.db,
      fixture.userId,
      lostResponseInput,
    );
    expect(recoveredLostResponse).toMatchObject({
      outcome: "saved",
      occurrenceId: firstPlanned.id,
      occurrenceRevision: firstPlanned.revision + 1,
    });

    for (const setNo of [2, 3]) {
      await expect(
        logWorkoutSet(database.db, fixture.userId, {
          ...fixture.commands.loaded,
          setNo,
          clientKey: `t03-planned-${setNo}`,
        }),
      ).resolves.toMatchObject({ outcome: "saved" });
    }

    const afterPlanExtraId = crypto.randomUUID();
    await expect(
      appendWorkoutSetOccurrence(database.db, fixture.userId, {
        sessionExerciseId: loadedExerciseId,
        occurrenceId: afterPlanExtraId,
        expectedSetNo: 5,
      }),
    ).resolves.toMatchObject({ outcome: "appended" });
    const extraAfterPlan = await logWorkoutSet(database.db, fixture.userId, {
      ...fixture.commands.loaded,
      setNo: 5,
      clientKey: "t03-extra-after-plan",
    });
    expect(extraAfterPlan).toMatchObject({
      outcome: "saved",
      occurrenceId: afterPlanExtraId,
    });
    if (extraAfterPlan.outcome !== "saved") throw new Error(extraAfterPlan.outcome);
    await expect(
      database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, extraAfterPlan.setId),
        columns: { targetMet: true },
      }),
    ).resolves.toEqual({ targetMet: null });
    const finalRows = await database.db
      .select()
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionExerciseId, loadedExerciseId))
      .orderBy(asc(sessionOccurrences.kindOrdinal));
    expect(finalRows.map((row) => row.origin)).toEqual([
      "planned",
      "planned",
      "planned",
      "ad_hoc",
      "ad_hoc",
    ]);
    expect(workingSetDisplayPosition(finalRows[4], finalRows).label).toBe(
      "Extra set 2",
    );
  });

  it("orders group members and rounds without serializing unrelated exercises", async () => {
    const definitions = await database.db
      .insert(exercises)
      .values([
        {
          name: `T03 group A ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
        },
        {
          name: `T03 group B ${crypto.randomUUID()}`,
          movementPattern: "horizontal_pull",
          primaryMuscles: ["back"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
        },
      ])
      .returning({ id: exercises.id });
    const [group] = await database.db
      .insert(sessionExerciseGroups)
      .values({
        sessionId: fixture.sessionId,
        provenance: "compiler",
        name: "T03 alternating pair",
        orderIdx: 10,
        plannedRounds: 2,
        memberCount: 2,
        restBetweenMembersSec: 20,
        restBetweenRoundsSec: 90,
      })
      .returning({ id: sessionExerciseGroups.id });
    const members = await database.db
      .insert(sessionExercises)
      .values(definitions.map((definition, index) => ({
        sessionId: fixture.sessionId,
        exerciseId: definition.id,
        orderIdx: 20 + index,
        groupSnapshotId: group.id,
        groupMemberOrderIdx: index,
        targetSets: 2,
        targetRepsMin: 8,
        targetRepsMax: 10,
      })))
      .returning({ id: sessionExercises.id, exerciseId: sessionExercises.exerciseId });
    const occurrenceValues = [
      { memberIndex: 0, round: 1, sequenceIdx: 30, kindOrdinal: 0 },
      { memberIndex: 1, round: 1, sequenceIdx: 31, kindOrdinal: 0 },
      { memberIndex: 0, round: 2, sequenceIdx: 32, kindOrdinal: 1 },
      { memberIndex: 1, round: 2, sequenceIdx: 33, kindOrdinal: 1 },
    ];
    const occurrences = await database.db
      .insert(sessionOccurrences)
      .values(
        occurrenceValues.map((value) => {
          const member = members[value.memberIndex];
          return {
            sessionId: fixture.sessionId,
            sessionExerciseId: member.id,
            kind: "working_set" as const,
            origin: "planned" as const,
            sequenceIdx: value.sequenceIdx,
            kindOrdinal: value.kindOrdinal,
            plannedExerciseId: member.exerciseId,
            plannedRepsMin: 8,
            plannedRepsMax: 10,
            plannedRestSec: value.memberIndex === 0 ? 20 : 90,
            groupSnapshotId: group.id,
            groupRound: value.round,
            groupMemberOrderIdx: value.memberIndex,
          };
        }),
      )
      .returning({ id: sessionOccurrences.id });
    const command = (index: number, setNo: number, clientKey: string) => ({
      sessionExerciseId: members[index].id,
      performedExerciseId: members[index].exerciseId,
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight" as const,
      performedSemanticsVersion: 1 as const,
      metricType: "reps" as const,
      setNo,
      weight: null,
      weightUnit: null,
      reps: 9,
      distanceKm: null,
      durationSeconds: null,
      rpe: null,
      note: null,
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown" as const,
      observedCompletedAtISO: new Date().toISOString(),
      clientKey,
    });

    await expect(
      logWorkoutSet(
        database.db,
        fixture.userId,
        command(1, 1, "t03-group-later-member"),
      ),
    ).resolves.toMatchObject({
      outcome: "set_order_conflict",
      blocker: {
        occurrenceId: occurrences[0].id,
        sessionExerciseId: members[0].id,
        setNo: 1,
        groupRound: 1,
        isAddedSet: false,
      },
    });
    await expect(
      mutateWorkoutOccurrence(database.db, fixture.userId, {
        occurrenceId: occurrences[1].id,
        operation: "skip",
        reason: "not attempted",
        expectedRevision: 0,
        clientKey: "t03-group-later-skip",
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      updateSessionExerciseWithVersion(
        database.db,
        fixture.userId,
        members[1].id,
        { modificationType: "skipped", skipReason: "time" },
        "session_exercise.skip",
        { activeOnly: true },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "Finish or skip the earlier group item before skipping this exercise.",
    });
    expect(
      await database.db.query.sessionOccurrences.findMany({
        where: eq(sessionOccurrences.sessionExerciseId, members[1].id),
        columns: { outcome: true },
        orderBy: asc(sessionOccurrences.kindOrdinal),
      }),
    ).toEqual([{ outcome: "pending" }, { outcome: "pending" }]);
    await expect(
      logWorkoutSet(
        database.db,
        fixture.userId,
        command(0, 2, "t03-group-later-round"),
      ),
    ).resolves.toMatchObject({ outcome: "set_order_conflict" });

    const independent = await logWorkoutSet(
      database.db,
      fixture.userId,
      fixture.commands.bodyweightSubstitution,
    );
    expect(independent).toMatchObject({ outcome: "saved" });
    if (independent.outcome !== "saved") throw new Error(independent.outcome);
    await expect(
      database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, independent.setId),
        columns: { sessionExerciseId: true },
      }),
    ).resolves.toEqual({
      sessionExerciseId: fixture.sessionExerciseIds.bodyweightSubstitution,
    });
    await expect(
      database.db.query.sessionOccurrences.findFirst({
        where: eq(sessionOccurrences.completedSetId, independent.setId),
        columns: { origin: true, plannedExerciseId: true },
      }),
    ).resolves.toEqual({
      origin: "planned",
      plannedExerciseId: fixture.exerciseIds.plannedSubstitution,
    });

    await expect(
      logWorkoutSet(
        database.db,
        fixture.userId,
        command(0, 1, "t03-group-first"),
      ),
    ).resolves.toMatchObject({ outcome: "saved" });
    await expect(
      logWorkoutSet(
        database.db,
        fixture.userId,
        command(0, 2, "t03-group-round-before-member"),
      ),
    ).resolves.toMatchObject({ outcome: "set_order_conflict" });
    await expect(
      mutateWorkoutOccurrence(database.db, fixture.userId, {
        occurrenceId: occurrences[1].id,
        operation: "skip",
        reason: "owner chose to skip",
        expectedRevision: 0,
        clientKey: "t03-group-skip-after-first",
      }),
    ).resolves.toMatchObject({ outcome: "saved" });
    await expect(
      logWorkoutSet(
        database.db,
        fixture.userId,
        command(0, 2, "t03-group-round-two-first"),
      ),
    ).resolves.toMatchObject({ outcome: "saved" });
    await expect(
      mutateWorkoutOccurrence(database.db, fixture.userId, {
        occurrenceId: occurrences[3].id,
        operation: "skip",
        reason: "owner chose to skip",
        expectedRevision: 0,
        clientKey: "t03-group-round-two-skip",
      }),
    ).resolves.toMatchObject({ outcome: "saved" });
  });
});
