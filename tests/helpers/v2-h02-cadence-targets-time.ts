import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import {
  completedSets,
  exercises,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplates,
} from "@/db/schema";
import { convertWeight } from "@/lib/units";
import { addLocalDays, workoutLocalDate } from "@/lib/workout-calendar";
import { activateProgramAtomically } from "@/services/program-activation";
import { createTotalSystemTestSnapshot } from "./set-semantics";
import {
  V2_H02_EMAIL,
  V2_H02_IDS,
  V2_H02_NOW,
} from "./v2-h02-cadence-targets-time-constants";

export {
  V2_H02_EMAIL,
  V2_H02_IDS,
  V2_H02_NOW,
} from "./v2-h02-cadence-targets-time-constants";

export type V2H02CadenceFixture = {
  userId: string;
  otherUserId: string;
  exerciseId: string;
  sessionIds: {
    first: string;
    second: string;
    renamed: string;
    dateOnly: string;
    currentPartialWeek: string;
    abandoned: string;
    archived: string;
    otherOwner: string;
  };
  setIds: {
    below: string;
    at: string;
    above: string;
    compatibleUnit: string;
    unsupportedTarget: string;
  };
  dayLineages: { first: string; second: string };
};

export async function seedV2H02CadenceTargetsTime(
  db: Db,
  now = V2_H02_NOW,
): Promise<V2H02CadenceFixture> {
  const anchorDate = workoutLocalDate(now, "America/Toronto");
  const fixtureDate = (daysFromAnchor: number) =>
    addLocalDays(anchorDate, daysFromAnchor);
  const [{ id: userId }, { id: otherUserId }] = await db
    .insert(users)
    .values([
      { id: V2_H02_IDS.user, email: V2_H02_EMAIL },
      {
        id: V2_H02_IDS.otherUser,
        email: "v2.h02.other@example.com",
      },
    ])
    .returning({ id: users.id });
  await db.insert(userProfiles).values([
    {
      userId,
      unit: "lb" as const,
      timezone: "America/Toronto",
      weeklyFrequency: 3,
      setupCompletedAt: new Date("2026-01-01T12:00:00.000Z"),
    },
    {
      userId: otherUserId,
      unit: "lb" as const,
      timezone: "America/Toronto",
      weeklyFrequency: 5,
      setupCompletedAt: new Date("2026-01-01T12:00:00.000Z"),
    },
  ]);
  const [{ id: exerciseId, name: exerciseName }] = await db
    .insert(exercises)
    .values({
      id: V2_H02_IDS.exercise,
      name: "H02 cadence press",
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "barbell",
      metricType: "weight_reps",
      loadSemantics: "total",
    })
    .returning({ id: exercises.id, name: exercises.name });

  const activated = await activateProgramAtomically(db, {
    userId,
    loadUnit: "lb",
    programName: "H02 cadence fixture",
    days: ["Strength A", "Strength B"].map((name) => ({
      name,
      exercises: [{
        exerciseId,
        sets: 1,
        repMin: 8,
        repMax: 10,
        targetLoad: 100,
        restSec: 90,
        supersetKey: null,
        notes: null,
      }],
    })),
    changeSummary: "Create H02 cadence fixture",
    auditAction: "program.activate",
    auditSummary: "Activated H02 cadence fixture",
  });
  if (!activated.ok) throw new Error(activated.reason);
  const programId = activated.programId;
  const programVersionId = activated.programVersionId;
  const templates = await db.query.workoutTemplates.findMany({
    where: eq(workoutTemplates.programVersionId, programVersionId),
    orderBy: workoutTemplates.orderIdx,
  });
  if (templates.length !== 2) throw new Error("H02 Program-day fixture missing.");
  const dayLineages = {
    first: templates[0].lineageId,
    second: templates[1].lineageId,
  };
  async function addSession(input: {
    ownerId?: string;
    id: string;
    localDate: string;
    name: string;
    programDay?: "first" | "second" | null;
    status?: "completed" | "abandoned";
    archived?: boolean;
    dateOnly?: boolean;
  }) {
    const startedAt = new Date(`${input.localDate}T14:00:00.000Z`);
    const [session] = await db
      .insert(workoutSessions)
      .values({
        id: input.id,
        userId: input.ownerId ?? userId,
        templateName: input.name,
        status: input.status ?? "completed",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 45 * 60_000),
        timezone: "America/Toronto",
        localDate: input.localDate,
        templateId:
          input.programDay === "first"
            ? templates[0].id
            : input.programDay === "second"
              ? templates[1].id
              : null,
        sourceProgramId: input.programDay ? programId : null,
        sourceProgramVersionId:
          input.programDay ? programVersionId : null,
        sourceDayLineageId:
          input.programDay === "first"
            ? dayLineages.first
            : input.programDay === "second"
              ? dayLineages.second
              : null,
        performedTimePrecision: input.dateOnly ? "date_only" : "instant",
        archivedAt: input.archived
          ? new Date(`${fixtureDate(-4)}T12:00:00.000Z`)
          : null,
      })
      .returning({ id: workoutSessions.id });
    return session.id;
  }

  const sessionIds = {
    first: await addSession({
      id: V2_H02_IDS.firstSession,
      localDate: fixtureDate(-23),
      name: "Strength A",
      programDay: "first",
    }),
    second: await addSession({
      id: V2_H02_IDS.secondSession,
      localDate: fixtureDate(-20),
      name: "Strength B",
      programDay: "second",
    }),
    renamed: await addSession({
      id: V2_H02_IDS.renamedSession,
      localDate: fixtureDate(-16),
      name: "Push renamed",
      programDay: "first",
    }),
    dateOnly: await addSession({
      id: V2_H02_IDS.dateOnlySession,
      localDate: fixtureDate(-9),
      name: "Imported date-only workout",
      dateOnly: true,
    }),
    currentPartialWeek: await addSession({
      id: V2_H02_IDS.currentSession,
      localDate: fixtureDate(-1),
      name: "Current partial week",
    }),
    abandoned: await addSession({
      id: V2_H02_IDS.abandonedSession,
      localDate: fixtureDate(-14),
      name: "Abandoned evidence",
      status: "abandoned",
    }),
    archived: await addSession({
      id: V2_H02_IDS.archivedSession,
      localDate: fixtureDate(-13),
      name: "Archived evidence",
      archived: true,
    }),
    otherOwner: await addSession({
      id: V2_H02_IDS.otherSession,
      ownerId: otherUserId,
      localDate: fixtureDate(-12),
      name: "Other owner evidence",
    }),
  };

  async function addTargetSet(input: {
    sessionId: string;
    key: keyof V2H02CadenceFixture["setIds"];
    weight: number;
    weightUnit?: "lb" | "kg";
    reps: number;
    plannedRepsMin: number;
    plannedRepsMax: number;
    plannedLoad?: number | null;
    plannedLoadUnit?: "lb" | "kg" | null;
    plannedLoadPercent?: number | null;
    legacyTargetMet: boolean;
    setNo?: number;
  }) {
    const [sessionExercise] = await db
      .insert(sessionExercises)
      .values({
        sessionId: input.sessionId,
        exerciseId,
        modificationType: "as_planned",
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: exerciseName,
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
        targetSets: 1,
        targetRepsMin: 1,
        targetRepsMax: 1,
        targetLoad: 999,
        targetLoadUnit: "lb",
        orderIdx: (input.setNo ?? 1) - 1,
      })
      .returning({ id: sessionExercises.id });
    const equipmentSnapshotId = await createTotalSystemTestSnapshot(db, {
      userId,
      sessionId: input.sessionId,
      sessionExerciseId: sessionExercise.id,
      unit: "lb",
      label: "H02 test barbell",
    });
    const [{ id: setId }] = await db
      .insert(completedSets)
      .values({
        id:
          input.key === "below"
            ? V2_H02_IDS.belowSet
            : input.key === "at"
              ? V2_H02_IDS.atSet
              : input.key === "above"
                ? V2_H02_IDS.aboveSet
                : input.key === "compatibleUnit"
                  ? V2_H02_IDS.compatibleUnitSet
                  : V2_H02_IDS.unsupportedTargetSet,
        sessionExerciseId: sessionExercise.id,
        setNo: input.setNo ?? 1,
        weight: input.weight,
        weightUnit: input.weightUnit ?? "lb",
        reps: input.reps,
        metricType: "weight_reps",
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
        loadEntryMeaning: "total_system",
        equipmentSnapshotId,
        targetMet: input.legacyTargetMet,
      })
      .returning({ id: completedSets.id });
    await db.insert(sessionOccurrences).values({
      sessionId: input.sessionId,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: input.setNo ?? 1,
      kindOrdinal: (input.setNo ?? 1) - 1,
      plannedExerciseId: exerciseId,
      plannedRepsMin: input.plannedRepsMin,
      plannedRepsMax: input.plannedRepsMax,
      plannedLoad: input.plannedLoad ?? null,
      plannedLoadUnit: input.plannedLoadUnit ?? null,
      plannedLoadPercent: input.plannedLoadPercent ?? null,
      outcome: "completed",
      completedSetId: setId,
      equipmentSnapshotId,
      resolvedAt: new Date("2026-08-05T15:00:00.000Z"),
    });
    return [input.key, setId] as const;
  }

  const setIds = Object.fromEntries([
    await addTargetSet({
      sessionId: sessionIds.first,
      key: "below",
      weight: 95,
      reps: 7,
      plannedRepsMin: 8,
      plannedRepsMax: 10,
      plannedLoad: 100,
      plannedLoadUnit: "lb",
      legacyTargetMet: true,
      setNo: 1,
    }),
    await addTargetSet({
      sessionId: sessionIds.first,
      key: "at",
      weight: 100,
      reps: 8,
      plannedRepsMin: 8,
      plannedRepsMax: 10,
      plannedLoad: 100,
      plannedLoadUnit: "lb",
      legacyTargetMet: false,
      setNo: 2,
    }),
    await addTargetSet({
      sessionId: sessionIds.second,
      key: "above",
      weight: 105,
      reps: 11,
      plannedRepsMin: 8,
      plannedRepsMax: 10,
      plannedLoad: 100,
      plannedLoadUnit: "lb",
      legacyTargetMet: false,
    }),
    await addTargetSet({
      sessionId: sessionIds.renamed,
      key: "compatibleUnit",
      weight: convertWeight(100, "lb", "kg"),
      weightUnit: "kg",
      reps: 8,
      plannedRepsMin: 8,
      plannedRepsMax: 10,
      plannedLoad: 100,
      plannedLoadUnit: "lb",
      legacyTargetMet: false,
    }),
    await addTargetSet({
      sessionId: sessionIds.dateOnly,
      key: "unsupportedTarget",
      weight: 100,
      reps: 8,
      plannedRepsMin: 8,
      plannedRepsMax: 10,
      plannedLoadPercent: 80,
      legacyTargetMet: true,
    }),
  ]) as V2H02CadenceFixture["setIds"];

  const [extraExercise] = await db
    .insert(sessionExercises)
    .values({
      sessionId: sessionIds.dateOnly,
      exerciseId,
      modificationType: "added",
      prescribedSemanticsVersion: 1,
      prescribedExerciseName: exerciseName,
      prescribedMetricType: "weight_reps",
      prescribedLoadType: "barbell",
      prescribedLoadSemantics: "total",
      orderIdx: 1,
    })
    .returning({ id: sessionExercises.id });
  const extraEquipmentSnapshotId = await createTotalSystemTestSnapshot(db, {
    userId,
    sessionId: sessionIds.dateOnly,
    sessionExerciseId: extraExercise.id,
    unit: "lb",
    label: "H02 extra-set barbell",
  });
  await db.insert(completedSets).values({
    id: V2_H02_IDS.unplannedExtraSet,
    sessionExerciseId: extraExercise.id,
    setNo: 1,
    weight: 80,
    weightUnit: "lb",
    reps: 12,
    metricType: "weight_reps",
    performedSemanticsVersion: 1,
    performedLoadType: "barbell",
    performedLoadSemantics: "total",
    loadEntryMeaning: "total_system",
    equipmentSnapshotId: extraEquipmentSnapshotId,
    targetMet: true,
  });
  await db.insert(sessionOccurrences).values({
    sessionId: sessionIds.dateOnly,
    sessionExerciseId: extraExercise.id,
    kind: "working_set",
    origin: "ad_hoc",
    sequenceIdx: 2,
    kindOrdinal: 0,
    plannedExerciseId: exerciseId,
    outcome: "completed",
    completedSetId: V2_H02_IDS.unplannedExtraSet,
    equipmentSnapshotId: extraEquipmentSnapshotId,
    resolvedAt: new Date("2026-08-05T15:01:00.000Z"),
  });

  return { userId, otherUserId, exerciseId, sessionIds, setIds, dayLineages };
}
