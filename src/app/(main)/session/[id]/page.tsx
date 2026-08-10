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
  painLogs,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import {
  getPreviousComparableSets,
  PREVIOUS_COMPARABLE_SET_UNAVAILABLE,
} from "@/services/previous-comparable-sets";
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
import {
  categorizeDiagnosticError,
  logDiagnosticEvent,
} from "@/lib/server-log";
import { Button } from "@/components/ui/button";
import { actionableActiveSessionOccurrences } from "@/lib/warmup-occurrence-compatibility";
import {
  LIMITATION_CAUSES,
  PAIN_BODY_PARTS,
  TECHNIQUE_ISSUES,
  type LimitationCause,
  type PainBodyPart,
  type TechniqueIssue,
} from "@/lib/set-exception-context";
import { classifyActiveSessionTiming } from "@/lib/active-session-timing";
import { acceptanceWorkoutNow } from "@/lib/acceptance-workout-clock";

function techniqueIssue(value: string | null): TechniqueIssue | null {
  return TECHNIQUE_ISSUES.includes(value as TechniqueIssue)
    ? value as TechniqueIssue
    : null;
}

function limitationCause(value: string | null): LimitationCause | null {
  return LIMITATION_CAUSES.includes(value as LimitationCause)
    ? value as LimitationCause
    : null;
}

function painBodyPart(value: string): PainBodyPart | null {
  return PAIN_BODY_PARTS.includes(value as PainBodyPart)
    ? value as PainBodyPart
    : null;
}

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
  try {
    const { id } = await props.params;
    const searchParams = await props.searchParams;
    return await renderSessionPage(id, searchParams);
  } catch (error) {
    unstable_rethrow(error);
    logDiagnosticEvent("session.render_failed", {
      routeState: "route_input",
      errorCategory: categorizeDiagnosticError(error, "persistence"),
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

  const plannedExerciseIds = [
    ...new Set(
      session.exercises
        .map((exercise) => exercise.substitutedForExerciseId)
        .filter((value): value is string => value != null)
    ),
  ];
  const exerciseIds = session.exercises.map((exercise) => exercise.exerciseId);

  const [
    plates,
    equipment,
    equipmentProfiles,
    exactRequirements,
    userConstraints,
    coachMessages,
    plannedExercises,
  ] =
    await Promise.all([
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
  const [setCorrectionVersions, setPainLogs] = visibleSetIds.length > 0
    ? await Promise.all([db.query.recordVersions.findMany({
        where: and(
          eq(recordVersions.userId, user.id),
          eq(recordVersions.entityType, "completed_set"),
          inArray(recordVersions.entityId, visibleSetIds),
        ),
        columns: { entityId: true, action: true },
      }), db.query.painLogs.findMany({
        where: and(
          eq(painLogs.userId, user.id),
          eq(painLogs.sessionId, session.id),
          inArray(painLogs.completedSetId, visibleSetIds),
          isNull(painLogs.archivedAt),
        ),
      })])
    : [[], []];
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
  const painBySetId = new Map(
    setPainLogs.flatMap((pain) => {
      const bodyPart = painBodyPart(pain.bodyPart);
      return pain.completedSetId != null && bodyPart != null
        ? [[pain.completedSetId, {
            bodyPart,
            severity: pain.severity,
            note: pain.note,
          }] as const]
        : [];
    }),
  );
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
    const usesPrescribedMeaning =
      sessionExercise.prescribedSemanticsVersion === 1 &&
      sessionExercise.modificationType !== "substituted" &&
      sessionExercise.modificationType !== "added";
    const exact = usesPrescribedMeaning
      ? null
      : exactByExercise.get(sessionExercise.exerciseId) ?? null;
    const presentation = buildSessionEquipmentPresentation({
      exercise: {
        id: sessionExercise.id,
        exerciseId: sessionExercise.exerciseId,
        loadType: usesPrescribedMeaning
          ? sessionExercise.prescribedLoadType!
          : sessionExercise.exercise.loadType,
        targetLoad: sessionExercise.targetLoad,
        targetLoadUnit: sessionExercise.targetLoadUnit,
        requirements: usesPrescribedMeaning
          ? []
          : sessionExercise.exercise.equipmentRequirements.map((requirement) => ({
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

  const previousComparableByExercise = await getPreviousComparableSets(
    db,
    user.id,
    session.exercises.map((exercise) => ({
      sessionExerciseId: exercise.id,
      loadEntryMeaning: equipmentSetups[exercise.id]?.loadEntryMeaning ?? null,
      targetLoadUnit: user.profile.unit,
    })),
  );

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
    const usesPrescribedMeaning =
      se.prescribedSemanticsVersion === 1 &&
      se.modificationType !== "substituted" &&
      se.modificationType !== "added";
    return {
      id: se.id,
      exerciseId: se.exerciseId,
      name: usesPrescribedMeaning
        ? se.prescribedExerciseName!
        : se.exercise.name,
      family: usesPrescribedMeaning ? null : se.exercise.family?.name ?? null,
      loadType: usesPrescribedMeaning
        ? se.prescribedLoadType!
        : se.exercise.loadType,
      loadSemantics: usesPrescribedMeaning
        ? se.prescribedLoadSemantics!
        : se.exercise.loadSemantics,
      metricType: usesPrescribedMeaning
        ? se.prescribedMetricType!
        : se.exercise.metricType,
      movementPattern: usesPrescribedMeaning
        ? "unknown"
        : se.exercise.movementPattern,
      orderIdx: se.orderIdx,
      supersetKey: se.supersetKey,
      restSec: se.restSec,
      modificationType: se.modificationType,
      skipReason: se.skipReason,
      substitutedForExerciseId: se.substitutedForExerciseId,
      substitutionReason: se.substitutionReason,
      substitutedAt: se.substitutedAt?.toISOString() ?? null,
      plannedExerciseName: se.substitutedForExerciseId
        ? (se.prescribedExerciseName ??
          plannedExerciseNames.get(se.substitutedForExerciseId) ??
          null)
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
      cautionBodyParts: usesPrescribedMeaning
        ? []
        : flags.get(se.exercise.movementPattern)?.bodyParts ?? [],
      media: usesPrescribedMeaning
        ? null
        : mediaByExercise.get(se.exercise.id) ?? null,
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
          rir: s.rir,
          techniqueIssue: techniqueIssue(s.techniqueIssue),
          limitationCause: limitationCause(s.limitationCause),
          pain: painBySetId.get(s.id) ?? null,
          note: s.note,
          correctionCount: correctionCountBySetId.get(s.id) ?? 0,
        })),
      previousComparable: previousComparableByExercise[se.id] ?? {
        status: "unavailable",
        currentSessionExerciseId: se.id,
        message: PREVIOUS_COMPARABLE_SET_UNAVAILABLE,
        reason: "current_exercise_unavailable",
      },
      last: null,
    };
  });

  const activeTiming = classifyActiveSessionTiming(
    session.startedAt,
    acceptanceWorkoutNow("finish")?.() ?? new Date(),
  );
  const runnerProps: SessionRunnerProps = {
    ownerId: user.id,
    sessionId: session.id,
    historyRevision: session.historyRevision,
    templateName: session.templateName ?? "Workout",
    dayWarmupNotes: session.dayWarmupNotes,
    occurrences: actionableOccurrences.map((occurrence) => {
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
    initialWallClockSeconds: activeTiming.wallClockSeconds,
    initialTimingReviewRequired: activeTiming.reviewRequired,
    initialTimingReviewOpen: searchParams.reviewTiming === "1",
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
    logDiagnosticEvent("session.render_failed", {
      routeState: "confirmed_active",
      errorCategory: categorizeDiagnosticError(error, "runtime"),
    });
    return <ConfirmedSessionLoadRecovery sessionId={session.id} />;
  }
}
