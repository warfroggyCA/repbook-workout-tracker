import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  workoutSessions,
  sessionExercises,
  completedSets,
  painLogs,
  recommendations,
  sessionNotes,
  exercises,
  sessionOccurrences,
  recordVersions,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import { formatDuration, formatRecordedLocalDate } from "@/lib/dates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkoutArchiveButton } from "@/components/history/workout-archive-button";
import { LiveCoachHistory } from "@/components/history/live-coach-history";
import { ArrowLeft, Check, X } from "lucide-react";
import {
  buildHistoryHref,
  firstSearchParam,
  parseHistoryCalendarDate,
  parseHistoryCalendarView,
  parseHistoryInsightLens,
  parseHistoryView,
} from "@/lib/history-navigation";
import { parseHistoryRange } from "@/services/history-report";
import { getWorkoutArchivePreview } from "@/services/archive";
import { listLiveCoachMessages } from "@/services/live-coaching";
import { buildHistoryEquipmentSetProjection } from "@/lib/history-equipment-presentation";
import { ContextualNoteScope } from "@/components/contextual-notes/contextual-note-scope";
import { getCompletedHistoryContextualNotes } from "@/services/history-page";
import { CompletedSetCorrection } from "@/components/history/completed-set-correction";
import { shouldExcludeWorkoutDuration } from "@/lib/workout-duration-quality";
import { WorkoutTimingCorrection } from "@/components/history/workout-timing-correction";
import { filterRecommendationsEligibleForAction } from "@/services/recommendation-evidence-eligibility";
import {
  classifySetMetricContainment,
  setMetricExclusionLabel,
} from "@/lib/set-metric-semantics";
import { workingSetDisplayPosition } from "@/lib/session-occurrences";
import {
  LIMITATION_CAUSE_LABELS,
  TECHNIQUE_ISSUE_LABELS,
  type LimitationCause,
  type TechniqueIssue,
} from "@/lib/set-exception-context";

function techniqueIssueLabel(value: string | null) {
  return value != null && value in TECHNIQUE_ISSUE_LABELS
    ? TECHNIQUE_ISSUE_LABELS[value as TechniqueIssue]
    : null;
}

function limitationCauseLabel(value: string | null) {
  return value != null && value in LIMITATION_CAUSE_LABELS
    ? LIMITATION_CAUSE_LABELS[value as LimitationCause]
    : null;
}

export default async function SessionDetailPage(
  props: PageProps<"/history/[id]">
) {
  const { id } = await props.params;
  const searchParams = await props.searchParams;
  const justFinished = searchParams.finished === "1";
  const historyRange = parseHistoryRange(firstSearchParam(searchParams.range));
  const historyView = parseHistoryView(searchParams.view);
  const historyLens = parseHistoryInsightLens(searchParams.lens);
  const calendarView = parseHistoryCalendarView(searchParams.calendarView);
  const calendarDate = parseHistoryCalendarDate(searchParams.calendarDate);
  const historyHref = buildHistoryHref(
    {
      range: historyRange,
      view: historyView,
      lens: historyLens,
      calendarView,
      calendarDate,
    },
    { focusCalendar: historyView === "calendar" }
  );

  const user = await getCurrentUser();
  const db = await getDb();

  const session = await db.query.workoutSessions.findFirst({
    where: and(
      eq(workoutSessions.id, id),
      eq(workoutSessions.userId, user.id),
      isNull(workoutSessions.archivedAt)
    ),
    with: {
      exercises: {
        orderBy: sessionExercises.orderIdx,
        with: {
          exercise: true,
          sets: {
            where: isNull(completedSets.archivedAt),
            orderBy: completedSets.setNo,
            with: { equipmentSnapshot: true },
          },
        },
      },
      painLogs: { where: isNull(painLogs.archivedAt) },
      notes: { where: isNull(sessionNotes.archivedAt) },
      occurrences: { orderBy: sessionOccurrences.sequenceIdx },
    },
  });
  if (!session) notFound();
  const durationExcluded =
    session.finishedAt != null &&
    shouldExcludeWorkoutDuration(
      session.startedAt,
      session.finishedAt,
      session.excludeDurationFromAnalytics,
    );
  const visibleSetIds = session.exercises.flatMap((exercise) =>
    exercise.sets.map((set) => set.id),
  );
  const referencedExerciseIds = [
    ...new Set(
      [
        ...session.exercises.map((exercise) => exercise.substitutedForExerciseId),
        ...session.painLogs.map((pain) => pain.exerciseId),
        ...session.occurrences.map((occurrence) => occurrence.plannedExerciseId),
      ]
        .filter((value): value is string => value != null)
    ),
  ];
  const [archivePreview, coachMessages, referencedExercises, contextualNotes, setVersions, timingVersions] = await Promise.all([
    getWorkoutArchivePreview(db, user.id, session.id),
    listLiveCoachMessages(db, user.id, session.id),
    referencedExerciseIds.length > 0
      ? db.query.exercises.findMany({
          where: inArray(exercises.id, referencedExerciseIds),
        })
      : Promise.resolve([]),
    getCompletedHistoryContextualNotes(db, user.id, session.id),
    visibleSetIds.length > 0
      ? db.query.recordVersions.findMany({
          where: and(
            eq(recordVersions.userId, user.id),
            eq(recordVersions.entityType, "completed_set"),
            inArray(recordVersions.entityId, visibleSetIds),
          ),
          orderBy: desc(recordVersions.createdAt),
        })
      : Promise.resolve([]),
    db.query.recordVersions.findMany({
      where: and(
        eq(recordVersions.userId, user.id),
        eq(recordVersions.entityType, "workout_session"),
        eq(recordVersions.entityId, session.id),
      ),
      orderBy: desc(recordVersions.createdAt),
    }),
  ]);
  const correctionsBySetId = new Map<string, typeof setVersions>();
  for (const version of setVersions) {
    if (
      version.action !== "set.active_correction" &&
      version.action !== "set.completed_correction"
    ) continue;
    const current = correctionsBySetId.get(version.entityId) ?? [];
    current.push(version);
    correctionsBySetId.set(version.entityId, current);
  }
  const exerciseNames = new Map(
    [
      ...session.exercises.map((exercise) => exercise.exercise),
      ...referencedExercises,
    ].map((exercise) => [exercise.id, exercise.name])
  );
  const painByCompletedSetId = new Map(
    session.painLogs.flatMap((pain) => pain.completedSetId == null
      ? []
      : [[pain.completedSetId, pain] as const]),
  );
  const completedSetLabels = new Map(
    session.exercises.flatMap((exercise) => exercise.sets.map((set) => [
      set.id,
      `${exercise.exercise.name} · set ${set.setNo}`,
    ] as const)),
  );
  if (!archivePreview) notFound();

  const pendingRecs = justFinished
    ? await filterRecommendationsEligibleForAction(
        db,
        user.id,
        await db.query.recommendations.findMany({
          where: and(
            eq(recommendations.userId, user.id),
            eq(recommendations.status, "pending"),
            isNull(recommendations.archivedAt)
          ),
        }),
      )
    : [];

  const activeSetIds = new Set(visibleSetIds);
  const performedWorkingSetIds = new Set(
    session.occurrences
      .filter(
        (occurrence) =>
          occurrence.kind === "working_set" &&
          occurrence.outcome === "completed" &&
          occurrence.completedSetId != null &&
          activeSetIds.has(occurrence.completedSetId),
      )
      .map((occurrence) => occurrence.completedSetId as string),
  );
  const performedPlannedWorkingSetIds = new Set(
    session.occurrences
      .filter(
        (occurrence) =>
          occurrence.kind === "working_set" &&
          occurrence.origin === "planned" &&
          occurrence.outcome === "completed" &&
          occurrence.completedSetId != null &&
          activeSetIds.has(occurrence.completedSetId),
      )
      .map((occurrence) => occurrence.completedSetId as string),
  );
  const performedSetsBySessionExerciseId = new Map(
    session.exercises.map((exercise) => [
      exercise.id,
      exercise.sets.filter((set) => performedWorkingSetIds.has(set.id)),
    ]),
  );
  const performedSetEvidence = session.exercises.flatMap((sessionExercise) =>
    (performedSetsBySessionExerciseId.get(sessionExercise.id) ?? []).map(
      (set) => ({
        set,
        sessionExercise,
        semantics: classifySetMetricContainment({
          recordedMetricType: set.metricType,
          prescribedSemanticsVersion:
            sessionExercise.prescribedSemanticsVersion,
          performedSemanticsVersion: set.performedSemanticsVersion,
          performedLoadType: set.performedLoadType,
          performedLoadSemantics: set.performedLoadSemantics,
          currentExerciseMetricType:
            sessionExercise.prescribedSemanticsVersion === 1 &&
            sessionExercise.modificationType !== "substituted" &&
            sessionExercise.modificationType !== "added"
              ? sessionExercise.prescribedMetricType
              : sessionExercise.exercise.metricType,
          loadType:
            sessionExercise.prescribedSemanticsVersion === 1 &&
            sessionExercise.modificationType !== "substituted" &&
            sessionExercise.modificationType !== "added"
              ? sessionExercise.prescribedLoadType
              : sessionExercise.exercise.loadType,
          loadSemantics:
            sessionExercise.prescribedSemanticsVersion === 1 &&
            sessionExercise.modificationType !== "substituted" &&
            sessionExercise.modificationType !== "added"
              ? sessionExercise.prescribedLoadSemantics
              : sessionExercise.exercise.loadSemantics,
          loadEntryMeaning: set.loadEntryMeaning,
          weight: set.weight,
          reps: set.reps,
          excludeFromAnalytics: set.excludeFromAnalytics,
        }),
      }),
    ),
  );
  const totalSets = performedSetEvidence.length;
  const targetableSets = performedSetEvidence.filter(
    ({ set, sessionExercise, semantics }) =>
      sessionExercise.modificationType === "as_planned" &&
      performedPlannedWorkingSetIds.has(set.id) &&
      semantics.prescriptionOutcomeEligible &&
      set.targetMet != null,
  );
  const targetsMet = targetableSets.filter(({ set }) => set.targetMet).length;
  const timingCorrectionCount = timingVersions.filter(
    (version) =>
      version.action === "workout_session.timing_correction" ||
      version.action === "workout_session.version_restore",
  ).length;

  return (
    <main className="flex flex-col gap-4 p-4">
      <ContextualNoteScope
        value={{
          scopeId: `history-workout:${session.id}`,
          capturedContext: {
            schemaVersion: 1,
            destination: "history",
            workflow: session.templateName ?? "Completed workout",
            workoutPhase: "review",
            originatedFromSimulation: false,
            programDay: null,
            plannedExercise: null,
            performedExercise: null,
            occurrence: null,
            loadRepetitions: null,
            restContext: null,
            reviewContext: {
              kind: "history_workout",
              entityId: session.id,
              label: session.templateName ?? "Completed workout",
            },
          },
          attachments: [
            {
              key: `workout:${session.id}`,
              kind: "workout",
              label: `Entire workout · ${session.templateName ?? "Workout"}`,
              sessionId: session.id,
            },
            ...session.exercises.map((exercise) => ({
              key: `exercise:${exercise.id}`,
              kind: "exercise" as const,
              label: `Exercise · ${exercise.exercise.name}`,
              sessionId: session.id,
              sessionExerciseId: exercise.id,
            })),
            ...session.occurrences.map((occurrence) => ({
              key: `occurrence:${occurrence.id}`,
              kind: "occurrence" as const,
              label: occurrence.label ?? `Workout item ${occurrence.sequenceIdx + 1}`,
              sessionId: session.id,
              occurrenceId: occurrence.id,
            })),
            { key: "general", kind: "general", label: "General training note" },
          ],
          defaultAttachmentKey: `workout:${session.id}`,
        }}
      />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          {justFinished && (
            <p className="mb-2 rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
              Workout saved. Nice work.
            </p>
          )}
          <h1 className="text-2xl font-semibold">
            {session.templateName ?? "Workout"}
          </h1>
          {session.source === "history_manual" ? (
            <Badge className="mt-2" variant="outline">
              Entered after the workout
            </Badge>
          ) : session.source !== "tracker" ? (
            <Badge className="mt-2" variant="outline">
              Imported from {session.source === "hevy" ? "Hevy" : session.source}
            </Badge>
          ) : null}
          {session.source === "history_manual" && (
            <Badge className="ml-2 mt-2" variant="outline">
              {session.sourceProgramId
                ? "Linked to Program day"
                : "Not linked to Program"}
            </Badge>
          )}
          <p className="text-sm text-muted-foreground">
            {formatRecordedLocalDate(session.localDate)}
            {session.performedTimePrecision === "date_only"
              ? " · Time and duration unknown"
              : ` · ${new Intl.DateTimeFormat("en-CA", {
                  timeZone: session.timezone,
                  hour: "numeric",
                  minute: "2-digit",
                }).format(session.startedAt)}${
                  session.finishedAt
                    ? ` · ${formatDuration(session.startedAt, session.finishedAt)}${durationExcluded ? " recorded" : ""}`
                    : " · Duration unknown"
                }`}
            {` · ${totalSets} sets`}
            {targetableSets.length > 0
              ? ` · ${targetsMet} of ${targetableSets.length} comparable targets met`
              : ""}
          </p>
          {timingCorrectionCount > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Timing corrected {timingCorrectionCount}{" "}
              {timingCorrectionCount === 1 ? "time" : "times"} · earlier
              values retained in Edit history
            </p>
          )}
          {durationExcluded && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              This duration is preserved as recorded but excluded from insights because it is marked as questionable.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {session.status === "completed" && (
            <WorkoutTimingCorrection
              key={`${session.id}:${session.historyRevision}`}
              sessionId={session.id}
              historyRevision={session.historyRevision}
              startedAtISO={session.startedAt.toISOString()}
              finishedAtISO={session.finishedAt?.toISOString() ?? null}
              timezone={session.timezone}
              localDate={session.localDate}
              precision={
                session.performedTimePrecision === "date_only"
                  ? "date_only"
                  : "instant"
              }
              excludeDurationFromAnalytics={
                session.excludeDurationFromAnalytics
              }
              sourceLabel={
                session.source === "history_manual"
                  ? "Entered after the workout"
                  : session.source === "tracker"
                    ? "Recorded in Repbook"
                    : `Imported from ${session.source === "hevy" ? "Hevy" : session.source}`
              }
              programLinkLabel={
                session.sourceProgramId
                  ? "Program-day linkage retained"
                  : "No Program-day linkage"
              }
            />
          )}
          {totalSets > 0 && (
            <Button
              render={<Link href="#performed-exercises" />}
              nativeButton={false}
              variant="outline"
            >
              Correct logged sets
            </Button>
          )}
          <Button
            render={<Link href={historyHref} />}
            nativeButton={false}
            variant="outline"
          >
            <ArrowLeft className="size-4" /> Back to history
          </Button>
          <WorkoutArchiveButton
            sessionId={session.id}
            returnHref={historyHref}
            counts={archivePreview}
          />
        </div>
      </header>

      {pendingRecs.length > 0 && (
        <div className="rounded-xl border border-primary/40 p-3">
          <p className="text-sm font-medium">
            {pendingRecs.length} Program decision
            {pendingRecs.length > 1 ? "s" : ""} need review
          </p>
          <p className="mb-2 text-xs text-muted-foreground">
            Nothing changes until you approve it.
          </p>
          <Button render={<Link href="/coach" />} nativeButton={false} size="sm">
            Review decisions
          </Button>
        </div>
      )}

      {session.dayWarmupNotes && (
        <section className="rounded-xl border border-violet-300/60 bg-violet-50/60 p-4 dark:bg-violet-950/20">
          <h2 className="font-medium">Warm-up</h2>
          <p className="mt-1 whitespace-pre-line text-sm leading-6 text-muted-foreground">
            {session.dayWarmupNotes}
          </p>
        </section>
      )}

      {contextualNotes.length > 0 && (
        <section className="rounded-xl border p-4" aria-labelledby="contextual-notes-heading">
          <h2 id="contextual-notes-heading" className="font-medium">Training notes</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Your observations are shown with the workout item they describe. Private notes stay out of Coach and Review context.
          </p>
          <ol className="mt-3 space-y-2">
            {contextualNotes.map((note) => {
              const exerciseName = note.sessionExerciseId
                ? session.exercises.find((exercise) => exercise.id === note.sessionExerciseId)?.exercise.name
                : null;
              const occurrence = note.occurrenceId
                ? session.occurrences.find((item) => item.id === note.occurrenceId)
                : null;
              const placement = note.attachmentKind === "workout"
                ? "Entire workout"
                : note.attachmentKind === "rest"
                  ? `Rest · ${exerciseName ?? "workout item"}`
                  : note.attachmentKind === "set" || note.attachmentKind === "occurrence"
                    ? `${exerciseName ?? "Workout item"}${occurrence ? ` · item ${occurrence.sequenceIdx + 1}` : ""}`
                    : exerciseName ?? "Workout note";
              return (
                <li key={note.id} className="rounded-lg bg-muted/40 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{placement}</span>
                    <span className="text-xs text-muted-foreground">
                      {note.coachVisible ? "Coach-visible" : "Private"} · revision {note.revision}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap leading-6">{note.body}</p>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {session.occurrences.length > 0 && (
        <section className="rounded-xl border p-4">
          <h2 className="font-medium">Plan and results</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Your original plan stays separate from what you actually did.
          </p>
          <ol className="mt-3 flex flex-col gap-2">
            {session.occurrences.map((occurrence) => {
              const exerciseName = occurrence.plannedExerciseId
                ? exerciseNames.get(occurrence.plannedExerciseId) ?? "Exercise"
                : null;
              const setPosition =
                occurrence.kind === "working_set"
                  ? workingSetDisplayPosition(
                      occurrence,
                      session.occurrences,
                    )
                  : null;
              const identity = occurrence.kind === "day_warmup"
                ? occurrence.label ?? "Day warm-up"
                : occurrence.kind === "exercise_warmup"
                  ? `${exerciseName ?? "Exercise"} warm-up${occurrence.label ? ` — ${occurrence.label}` : ""}`
                  : `${exerciseName ?? "Exercise"} · ${setPosition?.lowercaseLabel ?? `set ${occurrence.kindOrdinal + 1}`}`;
              const archivedResult = occurrence.outcome === "completed"
                && occurrence.completedSetId != null
                && !activeSetIds.has(occurrence.completedSetId);
              const prescription: string[] = [];
              if (occurrence.plannedRepsMin != null) {
                prescription.push(
                  occurrence.plannedRepsMax != null &&
                    occurrence.plannedRepsMax !== occurrence.plannedRepsMin
                    ? `${occurrence.plannedRepsMin}–${occurrence.plannedRepsMax} reps`
                    : `${occurrence.plannedRepsMin} reps`,
                );
              }
              if (occurrence.plannedLoad != null && occurrence.plannedLoadUnit) {
                prescription.push(`${occurrence.plannedLoad} ${occurrence.plannedLoadUnit}`);
              } else if (occurrence.plannedLoadPercent != null) {
                prescription.push(`${occurrence.plannedLoadPercent}% of work weight`);
              } else if (occurrence.plannedLoadText) {
                prescription.push(occurrence.plannedLoadText);
              }
              if (occurrence.plannedNote) prescription.push(occurrence.plannedNote);
              if (occurrence.plannedRestSec != null && !occurrence.groupSnapshotId) {
                prescription.push(`${occurrence.plannedRestSec}s rest after`);
              }
              return (
                <li key={occurrence.id} className="rounded-md bg-muted/40 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>{occurrence.sequenceIdx + 1}. {identity}</span>
                    <span className="flex flex-wrap gap-1">
                      {occurrence.origin === "ad_hoc" && (
                        <Badge variant="outline">added during workout</Badge>
                      )}
                      <Badge variant="outline">
                        {archivedResult
                          ? "saved result removed"
                          : occurrenceOutcomeLabel(occurrence.outcome)}
                      </Badge>
                    </span>
                  </div>
                  {prescription.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {occurrence.origin === "ad_hoc"
                        ? "Workout-only guidance"
                        : "Planned"}
                      : {prescription.join(" · ")}
                    </p>
                  )}
                  {(occurrence.outcomeReason || occurrence.outcomeNote) && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {occurrence.outcomeReason
                        ? `Reason: ${occurrence.outcomeReason.replaceAll("_", " ")}`
                        : ""}
                      {occurrence.outcomeReason && occurrence.outcomeNote ? " · " : ""}
                      {occurrence.outcomeNote ? `Note: ${occurrence.outcomeNote}` : ""}
                    </p>
                  )}
                  {occurrence.groupSnapshotId && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Group round {occurrence.groupRound ?? "?"} · member {(occurrence.groupMemberOrderIdx ?? 0) + 1}
                      {occurrence.plannedRestSec != null ? ` · ${occurrence.plannedRestSec}s rest after` : ""}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <div
        id="performed-exercises"
        className="flex scroll-mt-4 flex-col gap-3"
      >
        {session.exercises.map((se) => {
          const workingSets = performedSetsBySessionExerciseId.get(se.id) ?? [];
          const workingSetEquipment = buildHistoryEquipmentSetProjection(workingSets);
          return (
          <section key={se.id} className="rounded-xl border p-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-medium">{se.exercise.name}</h2>
                {se.sourceExerciseName && se.sourceExerciseName !== se.exercise.name && (
                  <p className="text-xs text-muted-foreground">
                    Hevy name: {se.sourceExerciseName}
                  </p>
                )}
              </div>
              <div className="flex gap-1">
                {se.modificationType === "skipped" && (
                  <Badge variant="outline">skipped · {se.skipReason}</Badge>
                )}
                {se.modificationType === "substituted" && (
                  <Badge variant="outline">
                    alternative · {substitutionReasonLabel(se.substitutionReason)}
                  </Badge>
                )}
                {se.modificationType === "added" && (
                  <Badge variant="outline">added during workout</Badge>
                )}
              </div>
            </div>
            {se.modificationType === "substituted" &&
              se.substitutedForExerciseId && (
                <p className="mt-1 text-sm text-muted-foreground">
                  Performed {se.exercise.name} instead of{" "}
                  {exerciseNames.get(se.substitutedForExerciseId) ??
                    "the planned exercise"}
                  . The saved routine was not changed.
                </p>
              )}
            {se.modificationType === "added" && (
              <p className="mt-1 text-sm text-muted-foreground">
                Added during this workout. It has no Program slot or progression
                target, and the saved Program was not changed.
              </p>
            )}
            {se.targetSets != null && (
              <p className="text-xs text-muted-foreground">
                Target: {se.targetSets}×{se.targetRepsMin}–{se.targetRepsMax}
                {se.targetLoad != null && se.targetLoadUnit != null
                  ? ` @ ${se.targetLoad} ${se.targetLoadUnit}`
                  : ""}
              </p>
            )}
            {se.modificationType !== "substituted" && se.warmupNotes && (
              <div className="mt-2 rounded-md border bg-muted/30 px-2 py-1.5 text-xs">
                <p className="font-medium">Warm-up guidance · reference</p>
                <p className="mt-1 whitespace-pre-line text-muted-foreground">
                  {se.warmupNotes}
                </p>
              </div>
            )}
            {workingSets.length > 0 && (
              <ul className="mt-2 flex flex-col gap-0.5 text-sm tabular-nums">
                {workingSetEquipment.map(
                  ({ set: s, setup, loadMeaning, performedSetup }) => {
                    const semantics = classifySetMetricContainment({
                      recordedMetricType: s.metricType,
                      prescribedSemanticsVersion:
                        se.prescribedSemanticsVersion,
                      performedSemanticsVersion: s.performedSemanticsVersion,
                      performedLoadType: s.performedLoadType,
                      performedLoadSemantics: s.performedLoadSemantics,
                      currentExerciseMetricType:
                        se.prescribedSemanticsVersion === 1 &&
                        se.modificationType !== "substituted" &&
                        se.modificationType !== "added"
                          ? se.prescribedMetricType
                          : se.exercise.metricType,
                      loadType:
                        se.prescribedSemanticsVersion === 1 &&
                        se.modificationType !== "substituted" &&
                        se.modificationType !== "added"
                          ? se.prescribedLoadType
                          : se.exercise.loadType,
                      loadSemantics:
                        se.prescribedSemanticsVersion === 1 &&
                        se.modificationType !== "substituted" &&
                        se.modificationType !== "added"
                          ? se.prescribedLoadSemantics
                          : se.exercise.loadSemantics,
                      loadEntryMeaning: s.loadEntryMeaning,
                      weight: s.weight,
                      reps: s.reps,
                      excludeFromAnalytics: s.excludeFromAnalytics,
                    });
                    const occurrence = session.occurrences.find(
                      (candidate) => candidate.completedSetId === s.id,
                    );
                    const targetOutcomeVisible =
                      occurrence?.origin === "planned" &&
                      se.modificationType === "as_planned" &&
                      semantics.prescriptionOutcomeEligible;
                    const setPosition =
                      occurrence?.kind === "working_set"
                        ? workingSetDisplayPosition(
                            occurrence,
                            session.occurrences,
                          )
                        : null;
                    return (
                      <li
                        key={s.id}
                        className="rounded-md bg-primary/5 px-2 py-1.5"
                      >
                        {setup && (
                          <div className="mb-2 rounded-md border bg-background/70 px-2 py-1.5">
                            <p className="text-xs font-medium">
                              Performed setup · {setup.title}
                            </p>
                            {setup.details.map((detail) => (
                              <p
                                key={detail}
                                className="mt-0.5 text-xs text-muted-foreground"
                              >
                                {detail}
                              </p>
                            ))}
                          </div>
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-muted-foreground">
                            {setPosition?.label ?? `Set ${s.setNo}`}
                          </span>
                          <span className="flex items-center gap-1.5">
                            {formatSetMetric(s)}
                            {s.rpe != null && (
                              <span className="text-xs text-muted-foreground">
                                RPE {s.rpe}
                              </span>
                            )}
                            {s.rir != null && (
                              <span className="text-xs text-muted-foreground">
                                RIR {s.rir}
                              </span>
                            )}
                            {targetOutcomeVisible && s.targetMet === true && (
                              <Check className="size-3.5 text-green-600" />
                            )}
                            {targetOutcomeVisible && s.targetMet === false && (
                              <X className="size-3.5 text-muted-foreground" />
                            )}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                          <span className="text-xs text-muted-foreground">
                            {(correctionsBySetId.get(s.id)?.length ?? 0) > 0
                              ? `${correctionsBySetId.get(s.id)?.length} saved correction${correctionsBySetId.get(s.id)?.length === 1 ? "" : "s"} · original retained in revision history`
                              : "No saved corrections"}
                          </span>
                          {s.metricType === "activity" ? (
                            <span className="text-xs text-muted-foreground">
                              This legacy measurement shape cannot be corrected here.
                            </span>
                          ) : (
                            <CompletedSetCorrection
                              setId={s.id}
                              setNo={s.setNo}
                              weight={s.weight}
                              weightUnit={s.weightUnit}
                              reps={s.reps}
                              distanceKm={s.distanceKm}
                              durationSeconds={s.durationSeconds}
                              metricType={s.metricType}
                              rpe={s.rpe}
                              note={s.note}
                              historyRevision={session.historyRevision}
                              source="workout_history"
                            />
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Load meaning: {loadMeaning}
                        </p>
                        {semantics.exclusionReason != null && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {setMetricExclusionLabel(
                              semantics.exclusionReason,
                            )}
                          </p>
                        )}
                        {performedSetup && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Performed setup: {performedSetup}
                          </p>
                        )}
                        {s.note && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {s.note}
                          </p>
                        )}
                        {techniqueIssueLabel(s.techniqueIssue) && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Technique issue: {techniqueIssueLabel(s.techniqueIssue)}
                          </p>
                        )}
                        {limitationCauseLabel(s.limitationCause) && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Limited by: {limitationCauseLabel(s.limitationCause)}
                          </p>
                        )}
                        {painByCompletedSetId.get(s.id) && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Pain: {painByCompletedSetId.get(s.id)!.bodyPart}{" "}
                            {painByCompletedSetId.get(s.id)!.severity}/10
                            {painByCompletedSetId.get(s.id)!.note
                              ? ` — ${painByCompletedSetId.get(s.id)!.note}`
                              : ""}
                          </p>
                        )}
                      </li>
                    );
                  },
                )}
              </ul>
            )}
            {se.notes && (
              <p className="mt-2 rounded-md bg-muted px-2 py-1 text-xs">
                {se.notes}
              </p>
            )}
          </section>
          );
        })}
      </div>

      {session.painLogs.length > 0 && (
        <section className="rounded-xl border border-destructive/40 p-3">
          <h2 className="mb-1 text-sm font-medium">Pain flags</h2>
          {session.painLogs.map((p) => (
            <p key={p.id} className="text-sm text-muted-foreground">
              {!p.completedSetId && p.exerciseId && exerciseNames.has(p.exerciseId)
                ? `${exerciseNames.get(p.exerciseId)} · `
                : ""}
              {p.completedSetId && completedSetLabels.has(p.completedSetId)
                ? `${completedSetLabels.get(p.completedSetId)} · `
                : ""}
              {p.bodyPart} {p.severity}/10{p.note ? ` — ${p.note}` : ""}
            </p>
          ))}
        </section>
      )}

      {session.notes.length > 0 && (
        <section className="rounded-xl border p-3">
          <h2 className="mb-1 text-sm font-medium">Session notes</h2>
          {session.notes.map((n) => (
            <p key={n.id} className="text-sm text-muted-foreground">
              {n.text}
            </p>
          ))}
        </section>
      )}

      <LiveCoachHistory
        messages={coachMessages}
        exerciseNames={Object.fromEntries(
          session.exercises.map((exercise) => [exercise.id, exercise.exercise.name])
        )}
      />
    </main>
  );
}

function formatSetMetric(set: {
    weight: number | null;
    weightUnit: "lb" | "kg" | null;
    reps: number | null;
    distanceKm: number | null;
    durationSeconds: number | null;
    metricType: string;
}) {
  const parts: string[] = [];
  if (set.distanceKm != null) parts.push(`${set.distanceKm} km`);
  if (set.durationSeconds != null) {
    const minutes = Math.floor(set.durationSeconds / 60);
    const seconds = set.durationSeconds % 60;
    parts.push(`${minutes}:${String(seconds).padStart(2, "0")}`);
  }
  if (set.reps != null) {
    const reps = `${set.reps} rep${set.reps === 1 ? "" : "s"}`;
    parts.push(
      set.metricType === "assisted_reps" && set.weight != null
        ? `Assistance: ${set.weight} ${requiredWeightUnit(set.weightUnit)} · ${reps}`
        : set.weight != null
        ? `${set.weight} ${requiredWeightUnit(set.weightUnit)} × ${reps}`
        : reps
    );
  }
  if (!parts.length) return set.metricType === "activity" ? "Completed" : "No numeric metric";
  return parts.join(" · ");
}

function requiredWeightUnit(unit: "lb" | "kg" | null): "lb" | "kg" {
  if (!unit) throw new Error("A weighted set is missing its recorded unit.");
  return unit;
}

function substitutionReasonLabel(
  reason: "variety" | "equipment_busy" | "discomfort" | "other" | null
) {
  if (reason === "equipment_busy") return "equipment busy";
  if (reason === "discomfort") return "discomfort";
  if (reason === "variety") return "variety";
  return "another reason";
}

function occurrenceOutcomeLabel(outcome: string) {
  if (outcome === "legacy_unrecorded") return "historical outcome unknown";
  if (outcome === "abandoned") return "not completed before finish";
  return outcome.replaceAll("_", " ");
}
