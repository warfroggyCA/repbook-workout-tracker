import { notFound, redirect, unstable_rethrow } from "next/navigation";
import Link from "next/link";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  workoutSessions,
  sessionExercises,
  completedSets,
  sessionExerciseGroups,
  sessionOccurrences,
  equipmentItems,
  plateInventory,
  exerciseExecutionRequirements,
  constraints as constraintsTable,
  exercises as exercisesTable,
  recordVersions,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import { getLastPerformances } from "@/services/today";
import { patternFlags } from "@/engine/constraint-filter";
import { SessionRunner } from "@/components/session/session-runner";
import { listLiveCoachMessages } from "@/services/live-coaching";
import { getApprovedExerciseMedia } from "@/services/exercise-media";
import type {
  SessionExerciseData,
  SessionRunnerProps,
} from "@/components/session/types";
import type { PlateMathConfig, IncrementalLoadConfig } from "@/engine/plate-math";
import { loadEquipmentLoadProfiles } from "@/services/equipment-load-profiles";
import { buildSessionEquipmentPresentation } from "@/lib/session-equipment-presentation";
import { sessionEquipmentGeometrySnapshotSchema } from "@/lib/session-equipment-snapshot-contract";
import { isPhase0StartDisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";
import { logServerEvent } from "@/lib/server-log";
import { safeErrorName } from "@/lib/safe-error-name";
import { Button } from "@/components/ui/button";
import { actionableActiveSessionOccurrences } from "@/lib/warmup-occurrence-compatibility";

function ConfirmedSessionLoadRecovery({ sessionId }: { sessionId: string }) {
  return (
    <main className="mx-auto flex min-h-[70dvh] w-full max-w-xl items-center px-4 py-8">
      <section className="w-full rounded-2xl border bg-card p-5 shadow-[var(--shadow-soft)]">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-primary">
          Workout recovery
        </p>
        <h1 className="mt-2 text-xl font-semibold">This workout was created</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          The workout could not be displayed just now, but it remains safe to
          resume. Try loading it again, or return to Today and use Resume workout.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Button render={<Link href={`/session/${sessionId}`} />} nativeButton={false} className="min-h-12">
            Try loading again
          </Button>
          <Button
            variant="outline"
            render={<Link href="/today" />}
            nativeButton={false}
            className="min-h-12"
          >
            Return to Today
          </Button>
        </div>
      </section>
    </main>
  );
}

export default async function SessionPage(props: PageProps<"/session/[id]">) {
  let requestedId: string | null = null;
  try {
    const { id } = await props.params;
    requestedId = id;
    const searchParams = await props.searchParams;
    return await renderSessionPage(id, searchParams);
  } catch (error) {
    unstable_rethrow(error);
    logServerEvent("error", "session.render_failed", {
      sessionId:
        requestedId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId)
          ? requestedId
          : null,
      category: "workout_status_unconfirmed",
      errorName: safeErrorName(error),
    });
    throw new Error("The workout status could not be confirmed.");
  }
}

async function renderSessionPage(
  id: string,
  searchParams: Record<string, string | string[] | undefined>,
) {
  if (
    isPhase0StartDisposableAcceptanceRuntime() &&
    searchParams.phase0LoadFailure === "unconfirmed"
  ) {
    throw new Error("Injected Phase 0 unconfirmed session load failure");
  }
  const user = await getCurrentUser();
  const db = await getDb();

  const session = await db.query.workoutSessions.findFirst({
    where: and(
      eq(workoutSessions.id, id),
      eq(workoutSessions.userId, user.id),
      isNull(workoutSessions.archivedAt)
    ),
    with: {
      exerciseGroups: {
        orderBy: sessionExerciseGroups.orderIdx,
      },
      occurrences: {
        orderBy: sessionOccurrences.sequenceIdx,
      },
      exercises: {
        orderBy: sessionExercises.orderIdx,
        with: {
          exercise: { with: { equipmentRequirements: true, family: true } },
          currentEquipmentSnapshot: true,
          sets: {
            where: isNull(completedSets.archivedAt),
            orderBy: completedSets.setNo,
          },
        },
      },
    },
  });
  if (!session) notFound();
  if (session.status !== "in_progress") redirect(`/history/${session.id}`);
  try {
  if (
    isPhase0StartDisposableAcceptanceRuntime() &&
    searchParams.phase0RenderFailure === "1"
  ) {
    throw new Error("Injected Phase 0 session render failure");
  }

  const slotIds = session.exercises
    .map((e) => e.plannedFromTemplateExerciseId)
    .filter((v): v is string => v != null);
  const plannedExerciseIds = [
    ...new Set(
      session.exercises
        .map((exercise) => exercise.substitutedForExerciseId)
        .filter((value): value is string => value != null)
    ),
  ];
  const exerciseIds = session.exercises.map((exercise) => exercise.exerciseId);

  const [
    lastPerformances,
    plates,
    equipment,
    equipmentProfiles,
    exactRequirements,
    userConstraints,
    coachMessages,
    plannedExercises,
  ] =
    await Promise.all([
      getLastPerformances(db, user.id, slotIds),
      db.query.plateInventory.findMany({
        where: eq(plateInventory.userId, user.id),
      }),
      db.query.equipmentItems.findMany({
        where: eq(equipmentItems.userId, user.id),
      }),
      loadEquipmentLoadProfiles(db, user.id),
      exerciseIds.length > 0
        ? db.query.exerciseExecutionRequirements.findMany({
            where: inArray(
              exerciseExecutionRequirements.exerciseId,
              exerciseIds,
            ),
          })
        : Promise.resolve([]),
      db.query.constraints.findMany({
        where: eq(constraintsTable.userId, user.id),
      }),
      listLiveCoachMessages(db, user.id, session.id),
      plannedExerciseIds.length > 0
        ? db.query.exercises.findMany({
            where: inArray(exercisesTable.id, plannedExerciseIds),
          })
        : Promise.resolve([]),
    ]);
  const visibleSetIds = session.exercises.flatMap((exercise) =>
    exercise.sets.filter((set) => !set.isWarmup).map((set) => set.id),
  );
  const setCorrectionVersions = visibleSetIds.length > 0
    ? await db.query.recordVersions.findMany({
        where: and(
          eq(recordVersions.userId, user.id),
          eq(recordVersions.entityType, "completed_set"),
          inArray(recordVersions.entityId, visibleSetIds),
        ),
        columns: { entityId: true, action: true },
      })
    : [];
  const correctionCountBySetId = new Map<string, number>();
  for (const version of setCorrectionVersions) {
    if (
      version.action !== "set.active_correction" &&
      version.action !== "set.completed_correction"
    ) continue;
    correctionCountBySetId.set(
      version.entityId,
      (correctionCountBySetId.get(version.entityId) ?? 0) + 1,
    );
  }
  const plannedExerciseNames = new Map(
    plannedExercises.map((exercise) => [exercise.id, exercise.name])
  );
  const actionableOccurrences = actionableActiveSessionOccurrences({
    sessionId: session.id,
    templateId: session.templateId,
    sourceDayLineageId: session.sourceDayLineageId,
    dayWarmupNotes: session.dayWarmupNotes,
    dayWarmupItems: session.dayWarmupItems,
    exercises: session.exercises,
    occurrences: session.occurrences,
  });

  const exactByExercise = new Map(
    exactRequirements.map((requirement) => [requirement.exerciseId, requirement]),
  );
  const plateConfigs: Record<string, PlateMathConfig> = {};
  const equipmentSetups: SessionRunnerProps["equipmentSetups"] = {};
  for (const sessionExercise of session.exercises) {
    const exact = exactByExercise.get(sessionExercise.exerciseId) ?? null;
    const presentation = buildSessionEquipmentPresentation({
      exercise: {
        id: sessionExercise.id,
        exerciseId: sessionExercise.exerciseId,
        loadType: sessionExercise.exercise.loadType,
        targetLoad: sessionExercise.targetLoad,
        targetLoadUnit: sessionExercise.targetLoadUnit,
        requirements: sessionExercise.exercise.equipmentRequirements.map((requirement) => ({
          equipmentType: requirement.equipmentType,
          minWeight: requirement.minWeight,
        })),
        exactRequirement: exact ? {
          requiredProfileKind: exact.requiredProfileKind,
          requiredEquipmentDefinitionId: exact.requiredEquipmentDefinitionId,
          requiredAttachmentKind: exact.requiredAttachmentKind,
          requiredAttachmentDefinitionId: exact.requiredAttachmentDefinitionId,
          requiresKnownGeometry: exact.requiresKnownGeometry,
        } : null,
        currentSelection: sessionExercise.currentEquipmentSnapshot ? {
          id: sessionExercise.currentEquipmentSnapshot.id,
          equipmentItemId: sessionExercise.currentEquipmentSnapshot.equipmentItemId,
          attachmentItemId: sessionExercise.currentEquipmentSnapshot.attachmentItemId,
          equipmentLabel: sessionExercise.currentEquipmentSnapshot.equipmentLabel,
          attachmentLabel: sessionExercise.currentEquipmentSnapshot.attachmentLabel,
          geometrySnapshot: sessionEquipmentGeometrySnapshotSchema.parse(
            sessionExercise.currentEquipmentSnapshot.geometrySnapshot,
          ),
        } : null,
      },
      profiles: equipmentProfiles,
      inventory: equipment.map((item) => ({
        type: item.type,
        available: item.available,
        attrs: item.attrs,
      })),
      plates: plates.map((plate) => ({
        id: plate.id,
        denomination: plate.denomination,
        quantity: plate.quantity,
        unit: plate.unit,
      })),
    });
    if (presentation.setup) equipmentSetups[sessionExercise.id] = presentation.setup;
    if (presentation.plateConfig) plateConfigs[sessionExercise.id] = presentation.plateConfig;
  }

  const incrementals: Record<string, IncrementalLoadConfig> = {};
  for (const item of equipment) {
    if (
      (item.type === "dumbbell" || item.type === "kettlebell") &&
      item.available
    ) {
      incrementals[item.type] = {
        minWeight: item.attrs.minWeight,
        maxWeight: item.attrs.maxWeight,
        increments: item.attrs.increments,
      };
    }
  }

  const flags = patternFlags(userConstraints);
  const mediaByExercise = await getApprovedExerciseMedia(
    db,
    session.exercises.map((se) => ({
      id: se.exercise.id,
      familyId: se.exercise.familyId,
      equipment: se.exercise.equipmentRequirements.map(
        (requirement) => requirement.equipmentType
      ),
      variantAttributes: se.exercise.variantAttributes,
    }))
  );

  const exercises: SessionExerciseData[] = session.exercises.map((se) => {
    const last = se.plannedFromTemplateExerciseId
      ? lastPerformances[se.plannedFromTemplateExerciseId]
      : undefined;
    return {
      id: se.id,
      exerciseId: se.exerciseId,
      name: se.exercise.name,
      family: se.exercise.family?.name ?? null,
      loadType: se.exercise.loadType,
      loadSemantics: se.exercise.loadSemantics,
      metricType: se.exercise.metricType,
      movementPattern: se.exercise.movementPattern,
      orderIdx: se.orderIdx,
      supersetKey: se.supersetKey,
      restSec: se.restSec,
      modificationType: se.modificationType,
      skipReason: se.skipReason,
      substitutedForExerciseId: se.substitutedForExerciseId,
      substitutionReason: se.substitutionReason,
      substitutedAt: se.substitutedAt?.toISOString() ?? null,
      plannedExerciseName: se.substitutedForExerciseId
        ? (plannedExerciseNames.get(se.substitutedForExerciseId) ?? null)
        : null,
      targetSets: se.targetSets,
      targetRepsMin: se.targetRepsMin,
      targetRepsMax: se.targetRepsMax,
      targetLoad: se.targetLoad,
      targetLoadUnit: se.targetLoadUnit,
      notes: se.notes,
      warmupNotes: se.warmupNotes,
      warmupSets: se.warmupSets,
      setNotes: se.setNotes,
      cautionBodyParts:
        flags.get(se.exercise.movementPattern)?.bodyParts ?? [],
      media: mediaByExercise.get(se.exercise.id) ?? null,
      sets: se.sets
        .filter((s) => !s.isWarmup)
        .map((s) => ({
          id: s.id,
          clientKey: s.clientKey,
          setNo: s.setNo,
          weight: s.weight,
          weightUnit: s.weightUnit,
          reps: s.reps,
          metricType: s.metricType,
          distanceKm: s.distanceKm,
          durationSeconds: s.durationSeconds,
          rpe: s.rpe,
          note: s.note,
          correctionCount: correctionCountBySetId.get(s.id) ?? 0,
        })),
      last: se.modificationType !== "substituted" && last
        ? { dateISO: last.date.toISOString(), sets: last.sets }
        : null,
    };
  });

  const runnerProps: SessionRunnerProps = {
    ownerId: user.id,
    sessionId: session.id,
    historyRevision: session.historyRevision,
    templateName: session.templateName ?? "Workout",
    dayWarmupNotes: session.dayWarmupNotes,
    occurrences: actionableOccurrences.map((occurrence, index, all) => {
      const group = occurrence.groupSnapshotId
        ? session.exerciseGroups.find(
            (candidate) => candidate.id === occurrence.groupSnapshotId,
          )
        : null;
      const next = all[index + 1];
      const restAfterSec = group
        ? next?.groupSnapshotId !== group.id
          ? 0
          : next.groupRound === occurrence.groupRound
            ? group.restBetweenMembersSec ?? 0
            : group.restBetweenRoundsSec ?? 0
        : occurrence.plannedRestSec ?? 0;
      return {
        id: occurrence.id,
        sessionExerciseId: occurrence.sessionExerciseId,
        kind: occurrence.kind as SessionRunnerProps["occurrences"][number]["kind"],
        origin: occurrence.origin as SessionRunnerProps["occurrences"][number]["origin"],
        sequenceIdx: occurrence.sequenceIdx,
        kindOrdinal: occurrence.kindOrdinal,
        label: occurrence.label,
        plannedExerciseId: occurrence.plannedExerciseId,
        plannedNote: occurrence.plannedNote,
        plannedRepsMin: occurrence.plannedRepsMin,
        plannedRepsMax: occurrence.plannedRepsMax,
        plannedLoad: occurrence.plannedLoad,
        plannedLoadUnit: occurrence.plannedLoadUnit,
        plannedLoadPercent: occurrence.plannedLoadPercent,
        plannedLoadText: occurrence.plannedLoadText,
        plannedRestSec: occurrence.plannedRestSec,
        groupSnapshotId: occurrence.groupSnapshotId,
        groupRound: occurrence.groupRound,
        groupMemberOrderIdx: occurrence.groupMemberOrderIdx,
        outcome: occurrence.outcome as SessionRunnerProps["occurrences"][number]["outcome"],
        outcomeReason: occurrence.outcomeReason,
        outcomeNote: occurrence.outcomeNote,
        revision: occurrence.revision,
        resolvedAt: occurrence.resolvedAt?.toISOString() ?? null,
        completedSetId: occurrence.completedSetId,
        restAfterSec,
      };
    }),
    exerciseGroups: session.exerciseGroups.map((group) => ({
      id: group.id,
      name: group.name,
      plannedRounds: group.plannedRounds,
      memberCount: group.memberCount,
      orderIdx: group.orderIdx,
    })),
    startedAtISO: session.startedAt.toISOString(),
    exercises,
    plateConfigs,
    equipmentSetups,
    incrementals,
    unit: user.profile.unit,
    coachMessages,
  };

    return (
      <SessionRunner
        key={`${session.id}:${session.historyRevision}`}
        {...runnerProps}
      />
    );
  } catch (error) {
    unstable_rethrow(error);
    logServerEvent("error", "session.render_failed", {
      sessionId: session.id,
      category: "confirmed_active_render_failure",
      errorName: safeErrorName(error),
    });
    return <ConfirmedSessionLoadRecovery sessionId={session.id} />;
  }
}
