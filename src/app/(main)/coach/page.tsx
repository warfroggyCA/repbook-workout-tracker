import Link from "next/link";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  ChevronDown,
  Database,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import { getDb } from "@/db";
import { coachingInsights, workoutSessions, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/user";
import {
  RecommendationCard,
  type RecommendationCardData,
} from "@/components/coach/recommendation-card";
import { CoachTools } from "@/components/coach/coach-tools";
import {
  CoachAnswerCard,
  CoachReview,
} from "@/components/coach/coach-insights";
import {
  parseStoredCoachingAnswer,
  parseStoredCoachingReview,
  questionFromInsightDigest,
} from "@/services/coaching";
import {
  buildReviewEvidenceItems,
  getReviewDecisionData,
  reviewDecisionStatus,
  summarizeRecommendationChange,
} from "@/services/review-decisions";
import { AUTOMATIC_HOLD_NOTICE_DISMISSED_REASON } from "@/services/recommendation-decisions";
import { getHistoryReport } from "@/services/history-report";
import { getActivityReport } from "@/services/activity-report";
import { getWorkoutTestDataCount } from "@/services/workout-test-data";
import { isAIAvailable, isUsingExampleAIProvider } from "@/ai/provider";
import { formatRecordedLocalDate, formatRelativeDay } from "@/lib/dates";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  LIMITATION_CAUSE_LABELS,
  TECHNIQUE_ISSUE_LABELS,
  type LimitationCause,
  type TechniqueIssue,
} from "@/lib/set-exception-context";
import { formatPainEvidence } from "@/lib/pain-evidence";
import { externalAnalysisImportDigestSchema } from "@/lib/external-analysis-import";
import { getExternalAnalysisSourceBindingFreshness } from "@/services/external-analysis-validation";

import {
  buildHistoryHref,
  buildWorkoutHistoryHref,
  historyReturnContext,
} from "@/lib/history-navigation";
import { coachReviewStatus, hasReviewableTraining } from "@/lib/coach-review-status";
import { workoutLocalDate } from "@/lib/workout-calendar";
import { getHistoryPatterns } from "@/services/history-patterns";

export default async function CoachPage({
  searchParams,
}: {
  searchParams?: Promise<{
    pattern?: string | string[];
    from?: string | string[];
  }>;
} = {}) {
  const query = await searchParams;
  const historyContext = historyReturnContext(query?.from);
  const patternKey =
    typeof query?.pattern === "string" &&
    /^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(query.pattern)
      ? query.pattern
      : undefined;
  const user = await getCurrentUser();
  const db = await getDb();

  const [
    review,
    insightRows,
    externalImportRows,
    report,
    activityReport,
    testSessionCount,
    activeSession,
    latestReviewRow,
    evidenceOwner,
    patterns,
  ] = await Promise.all([
    getReviewDecisionData(db, user.id),
    db.query.coachingInsights.findMany({
      where: and(
        eq(coachingInsights.userId, user.id),
        isNull(coachingInsights.archivedAt),
      ),
      orderBy: desc(coachingInsights.createdAt),
      limit: 12,
    }),
    db.query.coachingInsights.findMany({
      where: and(
        eq(coachingInsights.userId, user.id),
        eq(coachingInsights.kind, "external_analysis_import"),
        isNull(coachingInsights.archivedAt),
      ),
      orderBy: desc(coachingInsights.createdAt),
      limit: 20,
    }),
    getHistoryReport(
      db,
      user.id,
      "12w",
      user.profile.weeklyFrequency,
      new Date(),
      { timezone: user.profile.timezone, unit: user.profile.unit },
    ),
    getActivityReport(db, user.id, "12w"),
    getWorkoutTestDataCount(db, user.id),
    db.query.workoutSessions.findFirst({
      where: and(
        eq(workoutSessions.userId, user.id),
        eq(workoutSessions.status, "in_progress"),
        isNull(workoutSessions.archivedAt),
      ),
      columns: { id: true, templateName: true },
    }),
    db.query.coachingInsights.findFirst({
      where: and(
        eq(coachingInsights.userId, user.id),
        isNull(coachingInsights.archivedAt),
        inArray(coachingInsights.kind, [
          "manual_review",
          "weekly",
          "post_workout",
        ]),
      ),
      orderBy: [desc(coachingInsights.createdAt), desc(coachingInsights.id)],
    }),
    db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { analysisEvidenceRevision: true },
    }),
    patternKey
      ? getHistoryPatterns(db, user.id, user.profile.timezone)
      : Promise.resolve([]),
  ]);
  const pattern = patterns.find((item) => item.key === patternKey);
  const freshness = coachReviewStatus(
    latestReviewRow?.dataDigest,
    String(evidenceOwner?.analysisEvidenceRevision ?? "unknown"),
    workoutLocalDate(new Date(), user.profile.timezone),
  );
  const latestReview = latestReviewRow
    ? parseStoredCoachingReview(latestReviewRow.contentMd)
    : null;
  const answers = insightRows
    .filter((row) => row.kind === "qa")
    .map((row) => ({
      row,
      answer: parseStoredCoachingAnswer(row.contentMd),
      question: questionFromInsightDigest(row.dataDigest),
    }))
    .filter(
      (
        item,
      ): item is typeof item & {
        answer: NonNullable<typeof item.answer>;
        question: string;
      } => item.answer !== null && item.question !== null,
    );
  const parsedExternalImports = externalImportRows.flatMap((row) => {
    const parsed = externalAnalysisImportDigestSchema.safeParse(row.dataDigest);
    if (!parsed.success) return [];
    return [{ row, digest: parsed.data }];
  });
  const externalObservations = (
    await Promise.all(
      parsedExternalImports.map(async ({ row, digest }) => {
        const freshness = await getExternalAnalysisSourceBindingFreshness(
          db,
          user.id,
          digest.sourceBindings,
          digest.package.sourceEvidenceRevision,
        );
        return digest.observations.map((observation) => ({
          importId: row.id,
          importedAt: row.createdAt,
          packageId: digest.package.id,
          responseId: digest.response.id,
          observation,
          current: freshness.ok,
        }));
      }),
    )
  ).flat();
  const externalObservationDateFormatter = new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: user.profile.timezone,
  });
  const supportingItemCount =
    externalObservations.length +
    review.recentExceptions.length +
    review.recent.length +
    review.outcomes.length;
  const hasDecisionHistoryOrEvidence =
    supportingItemCount > 0 || review.acceptedDecisionCount > 0;

  const toCardData = (
    recommendation: (typeof review.pending)[number],
  ): RecommendationCardData => {
    const payload = recommendation.payload;
    const signals = recommendation.evidence.signals as {
      suggestedExercise?: unknown;
      alternatives?: unknown;
    };
    const loadUnit = payload.kind === "load_change" ? payload.loadUnit : null;
    return {
      id: recommendation.id,
      ruleId: recommendation.ruleId,
      source: recommendation.source,
      exerciseName: recommendation.exercise?.name ?? null,
      reason: recommendation.reason,
      kind: payload.kind,
      fromLoad: payload.kind === "load_change" ? payload.fromLoad : null,
      toLoad: payload.kind === "load_change" ? payload.toLoad : null,
      loadUnit,
      suggestedExercise:
        typeof signals.suggestedExercise === "string"
          ? signals.suggestedExercise
          : null,
      alternatives: Array.isArray(signals.alternatives)
        ? signals.alternatives.filter(
            (alternative): alternative is string =>
              typeof alternative === "string",
          )
        : [],
      evidence: buildReviewEvidenceItems(
        recommendation.evidence,
        loadUnit,
        user.profile.timezone,
      ),
      reviewRevision: recommendation.reviewRevision,
      deferRevision: recommendation.deferRevision,
      deferredAt: recommendation.deferredAt?.toISOString() ?? null,
      revisitOn: recommendation.revisitOn,
      deferReason: recommendation.deferReason,
      createdAt: recommendation.createdAt.toISOString(),
      createdAtLabel: new Intl.DateTimeFormat("en-CA", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: user.profile.timezone,
      }).format(recommendation.createdAt),
      evidenceState: recommendation.reviewEvidence.state,
      evidenceExplanation: recommendation.reviewEvidence.explanation,
      evidenceLinks: recommendation.reviewEvidence.links,
      actionable: recommendation.reviewEvidence.actionable,
      producer: recommendation.reviewEvidence.metadata?.producer ?? null,
      sourceVersion:
        recommendation.reviewEvidence.metadata?.sourceVersion ?? null,
      limitations: recommendation.reviewEvidence.metadata?.limitations ?? [
        "This suggestion is missing the details needed to check it.",
      ],
      proposedEffect:
        recommendation.reviewEvidence.metadata?.proposedEffect.summary ??
        "This suggestion cannot be applied. Ask for a new one.",
      externalRequestedOutcome:
        payload.kind === "external_review" ? payload.requestedOutcome : null,
    };
  };

  return (
    <main
      data-ui-core-surface="review"
      className="athlete-workflow mx-auto flex max-w-5xl flex-col gap-6 p-4 sm:p-6 lg:p-8"
    >
      {isUsingExampleAIProvider() && (
        <p className="text-sm text-muted-foreground" role="note">
          This preview uses example Coach responses, not a live AI service.
        </p>
      )}
      <header className="space-y-2">
        <h1 className="ui-page-title">Coach</h1>
        <p className="text-sm text-muted-foreground">
          Your training, explained simply.
        </p>
      </header>
      {pattern && (
        <section
          className="space-y-2 border-l-2 border-primary pl-4"
          aria-label="Pattern from History"
        >
          <Link
            href={buildHistoryHref(historyContext)}
            className="inline-flex min-h-11 items-center text-sm text-primary"
          >
            ← History
          </Link>
          <h2 className="font-semibold">{pattern.exerciseName}</h2>
          <p className="text-sm">
            Skipped in {pattern.skipped} of the last {pattern.workouts.length}{" "}
            workouts where it was planned.
          </p>
          <details>
            <summary className="min-h-11 cursor-pointer py-2 text-sm text-primary">
              See those workouts
            </summary>
            <ul>
              {pattern.workouts.map((item) => (
                <li key={item.sessionId}>
                  <Link
                    className="inline-flex min-h-11 items-center text-sm text-primary"
                    href={buildWorkoutHistoryHref(
                      item.sessionId,
                      historyContext,
                    )}
                  >
                    {formatRecordedLocalDate(item.localDate)} ·{" "}
                    {item.workoutName}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      {patternKey && !pattern && (
        <p role="status" className="text-sm text-muted-foreground">
          This pattern has changed.{" "}
          <Link href="/history" className="text-primary">
            View current History
          </Link>
        </p>
      )}
      <section
        className="flex flex-col gap-3"
        aria-label="Proposed changes"
        data-coach-proposals
      >
        {review.pending.length === 0 ? (
          <p
            id="pending-decisions-heading"
            className="text-sm text-muted-foreground"
          >
            No proposed changes waiting.
          </p>
        ) : (
          <>
            <h2 id="pending-decisions-heading" className="ui-section-title">
              Proposed changes
            </h2>
            <p className="text-sm text-muted-foreground">
              Your plan changes only when you choose to apply a proposal.
            </p>
            {review.pending.map((recommendation) => (
              <RecommendationCard
                key={`${recommendation.id}:${recommendation.reviewRevision}:${recommendation.deferRevision}`}
                rec={toCardData(recommendation)}
                loadStep={
                  recommendation.payload.kind === "load_change" &&
                  recommendation.payload.loadUnit === "kg"
                    ? 2.5
                    : 5
                }
              />
            ))}
          </>
        )}
      </section>

      <section
        className="flex flex-col gap-5 border-t pt-6"
        aria-label="Training summary and questions"
      >
        {testSessionCount > 0 && (
          <Alert className="border-chart-2/30 bg-chart-2/5">
            <Database className="size-4" />
            <AlertTitle>Sample history is included</AlertTitle>
            <AlertDescription>
              The snapshot and generated review can use {testSessionCount}{" "}
              clearly labelled sample workouts. Sample sessions never create
              changes to your real Program. You can remove them in{" "}
              <Link href="/settings">Settings</Link>.
            </AlertDescription>
          </Alert>
        )}

        <CoachTools
          key={pattern?.key ?? "general"}
          aiAvailable={isAIAvailable()}
          hasTrainingData={
            hasReviewableTraining(report.overview, activityReport.overview.totalActivities)
          }
          initialQuestion={
            pattern
              ? `Help me decide whether to keep ${pattern.exerciseName} in my workouts.`
              : ""
          }
          patternKey={pattern?.key}
          previousAnswers={
            answers.length ? (
              <div className="space-y-3">
                {answers.slice(0, 5).map(({ row, answer, question }) => (
                  <CoachAnswerCard
                    key={row.id}
                    answer={answer}
                    question={question}
                    createdAt={row.createdAt}
                    timezone={user.profile.timezone}
                  />
                ))}
              </div>
            ) : undefined
          }
          savedReview={
            latestReview && latestReviewRow ? (
              freshness.current ? (
                <CoachReview
                  review={latestReview}
                  createdAt={latestReviewRow.createdAt}
                  timezone={user.profile.timezone}
                />
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {freshness.message}
                  </p>
                  <details>
                    <summary className="min-h-11 cursor-pointer py-2 text-sm text-primary">
                      Read the saved review ·{" "}
                      {formatRelativeDay(
                        latestReviewRow.createdAt,
                        user.profile.timezone,
                      )}
                    </summary>
                    <CoachReview
                      review={latestReview}
                      createdAt={latestReviewRow.createdAt}
                      timezone={user.profile.timezone}
                    />
                  </details>
                </div>
              )
            ) : undefined
          }
        />
      </section>

      {hasDecisionHistoryOrEvidence ? (
        <details className="group ui-surface p-4" data-ui-surface="inset">
          <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-3 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <span>
              <span className="ui-section-title block">
                Past decisions and details
              </span>
              <span className="ui-supporting mt-1 block">
                Past decisions, recorded context, and follow-up.
              </span>
            </span>
            <span className="flex items-center gap-2">
              <Badge variant="outline">
                {supportingItemCount} item{supportingItemCount === 1 ? "" : "s"}
              </Badge>
              <ChevronDown
                className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </span>
          </summary>
          <div className="mt-5 flex flex-col gap-5 border-t pt-5">
            {externalObservations.length > 0 ? (
              <section
                className="flex flex-col gap-3"
                aria-labelledby="external-observations-heading"
              >
                <div>
                  <h2
                    id="external-observations-heading"
                    className="ui-section-title"
                  >
                    Imported external observations
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    These are selected external-AI observations, not performed
                    facts, Repbook calculations, or accepted decisions.
                  </p>
                </div>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {externalObservations.map(
                    ({ importId, importedAt, observation, current }) => (
                      <li
                        key={`${importId}-${observation.id}`}
                        className="ui-surface p-4"
                        data-ui-surface="inset"
                      >
                        <Badge variant={current ? "outline" : "destructive"}>
                          {current
                            ? "External AI observation"
                            : "Stale external observation"}
                        </Badge>
                        <p className="mt-2 text-sm font-medium leading-6">
                          {observation.statement}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Evidence: {observation.evidenceIds.join(", ")}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Limits: {observation.limitations.join(" · ")}
                        </p>
                        {!current ? (
                          <p className="mt-2 text-xs font-medium text-destructive">
                            Your records have changed since this was imported. Export a fresh copy before using this advice.
                          </p>
                        ) : null}
                        <p className="mt-2 text-xs text-muted-foreground">
                          Imported{" "}
                          {externalObservationDateFormatter.format(importedAt)}
                        </p>
                      </li>
                    ),
                  )}
                </ul>
              </section>
            ) : null}

            {review.recentExceptions.length > 0 ? (
              <section
                className="flex flex-col gap-3"
                aria-labelledby="recent-exception-context-heading"
              >
                <div>
                  <h2
                    id="recent-exception-context-heading"
                    className="ui-section-title"
                  >
                    Recent effort and issue context
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    These observations are here for reference. They do not change your plan.
                  </p>
                </div>
                <ol
                  className="grid gap-3 md:grid-cols-2"
                  aria-label="Recent effort and issue context"
                >
                  {review.recentExceptions.map((item) => {
                    const details = [
                      item.rir == null ? null : `RIR ${item.rir}`,
                      item.rpe == null ? null : `RPE ${item.rpe}`,
                      item.techniqueIssue != null &&
                      item.techniqueIssue in TECHNIQUE_ISSUE_LABELS
                        ? `Technique: ${TECHNIQUE_ISSUE_LABELS[item.techniqueIssue as TechniqueIssue]}`
                        : null,
                      item.limitationCause != null &&
                      item.limitationCause in LIMITATION_CAUSE_LABELS
                        ? `Limited by: ${LIMITATION_CAUSE_LABELS[item.limitationCause as LimitationCause]}`
                        : null,
                      item.painBodyPart == null || item.painSeverity == null
                        ? null
                        : formatPainEvidence({
                            bodyPart: item.painBodyPart,
                            severity: item.painSeverity,
                            source: item.painSource,
                          }),
                      item.modificationType === "substituted"
                        ? `Performed ${item.performedExerciseName} instead of ${
                            item.plannedExerciseName ??
                            "the exercise in the original plan"
                          }${item.substitutionReason ? ` · ${item.substitutionReason}` : ""}`
                        : null,
                    ].filter((value): value is string => value != null);
                    return (
                      <li
                        key={item.setId}
                        className="ui-surface p-4"
                        data-ui-surface="inset"
                      >
                        <p className="font-medium">
                          {item.performedExerciseName} · set {item.setNo}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {item.workoutName} ·{" "}
                          {formatRecordedLocalDate(item.localDate)}
                        </p>
                        <ul className="mt-2 space-y-1 text-sm">
                          {details.map((detail) => (
                            <li key={detail}>{detail}</li>
                          ))}
                        </ul>
                        <Link
                          href={`/history/${item.sessionId}`}
                          data-ui-touch
                          className="mt-3 inline-flex items-center text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          Open supporting workout
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : null}

            {review.recent.length > 0 ? (
              <section
                className="flex flex-col gap-3"
                aria-labelledby="recent-decisions-heading"
              >
                <div>
                  <h2
                    id="recent-decisions-heading"
                    className="ui-section-title"
                  >
                    Recent decisions
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Accepted, edited, rejected, dismissed, expired, and undone
                    records stay distinct.
                  </p>
                </div>
                <ol
                  className="flex flex-col gap-2"
                  aria-label="Recent decisions"
                >
                  {review.recent.map((recommendation) => {
                    const status = reviewDecisionStatus(recommendation);
                    const undoneAt = recommendation.adaptations.find(
                      (adaptation) => adaptation.undoneAt != null,
                    )?.undoneAt;
                    const occurredAt =
                      undoneAt ??
                      recommendation.reconciledAt ??
                      recommendation.decidedAt ??
                      recommendation.createdAt;
                    const decisionPayload =
                      recommendation.decisions[0]?.editedPayload ??
                      recommendation.payload;
                    const suggestedExercise = (
                      recommendation.evidence.signals as {
                        suggestedExercise?: unknown;
                      }
                    ).suggestedExercise;
                    const explanation =
                      recommendation.decisions[0]?.reason ??
                      recommendation.reconciliationReason ??
                      recommendation.reason;
                    const dismissedAutomaticHold =
                      recommendation.payload.kind === "hold" &&
                      recommendation.status === "expired" &&
                      recommendation.reconciliationReason ===
                        AUTOMATIC_HOLD_NOTICE_DISMISSED_REASON;
                    const displayStatus = dismissedAutomaticHold
                      ? "Dismissed"
                      : status;
                    return (
                      <li
                        key={recommendation.id}
                        className="ui-surface p-3 text-sm"
                        data-ui-surface="inset"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="font-medium break-words">
                              {recommendation.exercise?.name ?? "Program"}
                            </p>
                            <p className="mt-0.5 break-words text-muted-foreground">
                              {summarizeRecommendationChange(
                                decisionPayload,
                                typeof suggestedExercise === "string"
                                  ? suggestedExercise
                                  : null,
                              )}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <Badge
                              variant={
                                displayStatus === "Rejected" ||
                                displayStatus === "Expired" ||
                                displayStatus === "Dismissed"
                                  ? "outline"
                                  : "secondary"
                              }
                            >
                              {displayStatus}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatRelativeDay(
                                occurredAt,
                                user.profile.timezone,
                              )}
                            </span>
                          </div>
                        </div>
                        <p className="mt-2 break-words text-xs text-muted-foreground">
                          {explanation}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : null}

            {review.acceptedDecisionCount > 0 || review.outcomes.length > 0 ? (
              <section
                className="flex flex-col gap-3"
                aria-labelledby="outcomes-heading"
              >
                <div>
                  <h2 id="outcomes-heading" className="ui-section-title">
                    Outcomes ready to assess
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Follow-up appears only when a later completed planned
                    workout carries the accepted load target and records working
                    sets performed at that load.
                  </p>
                </div>
                {review.outcomes.length === 0 ? (
                  <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                    {review.acceptedDecisionCount === 0
                      ? "No accepted decision has follow-up training to assess yet."
                      : review.outcomeSupportedDecisionCount === 0
                        ? "Accepted decisions remain in history, but current data cannot support automatic outcome assessment for those decision types."
                        : "No outcomes are ready yet. A load change appears only after a later completed planned workout records working sets at the accepted load."}
                  </p>
                ) : (
                  <ol
                    className="grid gap-3 md:grid-cols-2"
                    aria-label="Outcomes ready to assess"
                  >
                    {review.outcomes.map((outcome) => (
                      <li
                        key={outcome.recommendationId}
                        className="ui-surface p-4"
                        data-ui-surface="inset"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="font-medium">
                              {outcome.exerciseName}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {outcome.changeSummary}
                            </p>
                          </div>
                          <Badge variant="secondary">Ready to assess</Badge>
                        </div>
                        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                          <div className="rounded-lg bg-muted/55 p-2">
                            <dt className="text-muted-foreground">Follow-up</dt>
                            <dd className="mt-0.5 font-medium">
                              {outcome.followupSessions} workout
                              {outcome.followupSessions === 1 ? "" : "s"} ·{" "}
                              {outcome.workingSets} sets
                            </dd>
                          </div>
                          <div className="rounded-lg bg-muted/55 p-2">
                            <dt className="text-muted-foreground">
                              Targets recorded
                            </dt>
                            <dd className="mt-0.5 font-medium">
                              {outcome.measurableSets > 0
                                ? `${outcome.targetsMet}/${outcome.measurableSets} met · ${outcome.measurableSets}/${outcome.workingSets} recorded`
                                : "Not recorded"}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-muted/55 p-2">
                            <dt className="text-muted-foreground">
                              Effort recorded
                            </dt>
                            <dd className="mt-0.5 font-medium">
                              {outcome.averageRpe == null
                                ? "Not recorded"
                                : `${outcome.averageRpe} avg. RPE · ${outcome.rpeCount}/${outcome.workingSets} recorded`}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-muted/55 p-2">
                            <dt className="text-muted-foreground">
                              Pain details
                            </dt>
                            <dd className="mt-0.5 font-medium">
                              {outcome.positivePainReports === 0
                                ? "No pain details recorded"
                                : `${outcome.positivePainReports} positive report${
                                    outcome.positivePainReports === 1 ? "" : "s"
                                  } · max ${outcome.maxPainSeverity}/10`}
                            </dd>
                          </div>
                        </dl>
                        {outcome.evidenceLimited && (
                          <p className="mt-3 rounded-lg border border-amber-500/35 bg-amber-500/5 p-2 text-xs text-amber-800 dark:text-amber-300">
                            Some results or effort ratings are missing. There is not enough information to tell whether the change helped.
                          </p>
                        )}
                        <Link
                          href={`/history/${outcome.latestSessionId}`}
                          data-ui-touch
                          className="mt-3 inline-flex items-center text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          Open {outcome.latestSessionName} ·{" "}
                          {formatRecordedLocalDate(outcome.latestLocalDate)}
                        </Link>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            ) : null}
          </div>
        </details>
      ) : null}

      <details className="group ui-surface p-4" data-ui-surface="inset">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-3 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <span>
            <span className="ui-section-title block">Coaching tools</span>
            <span className="ui-supporting mt-1 block">
              Ask Live Coach while you train.
            </span>
          </span>
          <span className="flex items-center gap-2">
            <Badge variant="outline">Optional</Badge>
            <ChevronDown
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </span>
        </summary>
        <div className="mt-5 flex flex-col gap-5 border-t pt-5">
          <section
            className="ui-surface p-4"
            data-ui-surface="inset"
            aria-labelledby="live-coach-context-heading"
          >
            <div className="flex items-start gap-3">
              <MessageSquareText className="mt-0.5 size-5 shrink-0 text-primary" />
              <div className="min-w-0">
                <h2
                  id="live-coach-context-heading"
                  className="ui-section-title"
                >
                  Live Coach stays with the workout
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Open Ask Coach during a workout. Your saved questions and notes stay with that workout in History.
                </p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
                  <Link
                    href={
                      activeSession ? `/session/${activeSession.id}` : "/today"
                    }
                    data-ui-touch
                    className="inline-flex items-center font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {activeSession
                      ? `Open ${activeSession.templateName ?? "active workout"}`
                      : "Go to Today"}
                  </Link>
                  <Link
                    href="/history"
                    data-ui-touch
                    className="inline-flex items-center font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    Review completed workouts
                  </Link>
                </div>
              </div>
            </div>
          </section>
        </div>
      </details>

      <footer className="flex items-start gap-2 rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
        <p>Coach offers training guidance, not a diagnosis.</p>
      </footer>
    </main>
  );
}
