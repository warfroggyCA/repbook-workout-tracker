import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  CheckCircle2,
  ClipboardCheck,
  Database,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { getDb } from "@/db";
import { coachingInsights, workoutSessions } from "@/db/schema";
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
import { isAIAvailable } from "@/ai/provider";
import {
  formatRecordedLocalDate,
  formatRelativeDay,
} from "@/lib/dates";
import { Badge } from "@/components/ui/badge";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { CoachActivityContext } from "@/components/coach/activity-context";
import {
  LIMITATION_CAUSE_LABELS,
  TECHNIQUE_ISSUE_LABELS,
  type LimitationCause,
  type TechniqueIssue,
} from "@/lib/set-exception-context";

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-3 shadow-[var(--shadow-soft)]">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export default async function CoachPage() {
  const user = await getCurrentUser();
  const db = await getDb();

  const [
    review,
    insightRows,
    report,
    activityReport,
    testSessionCount,
    activeSession,
  ] = await Promise.all([
    getReviewDecisionData(db, user.id),
    db.query.coachingInsights.findMany({
      where: and(
        eq(coachingInsights.userId, user.id),
        isNull(coachingInsights.archivedAt)
      ),
      orderBy: desc(coachingInsights.createdAt),
      limit: 12,
    }),
    getHistoryReport(
      db,
      user.id,
      "12w",
      user.profile.weeklyFrequency,
      new Date(),
      { timezone: user.profile.timezone, unit: user.profile.unit }
    ),
    getActivityReport(db, user.id, "12w"),
    getWorkoutTestDataCount(db, user.id),
    db.query.workoutSessions.findFirst({
      where: and(
        eq(workoutSessions.userId, user.id),
        eq(workoutSessions.status, "in_progress"),
        isNull(workoutSessions.archivedAt)
      ),
      columns: { id: true, templateName: true },
    }),
  ]);

  const latestReviewRow = insightRows.find((row) =>
    ["manual_review", "weekly", "post_workout"].includes(row.kind)
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
      (item): item is typeof item & {
        answer: NonNullable<typeof item.answer>;
        question: string;
      } => item.answer !== null && item.question !== null
    );

  const toCardData = (
    recommendation: (typeof review.pending)[number]
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
              typeof alternative === "string"
          )
        : [],
      evidence: buildReviewEvidenceItems(recommendation.evidence, loadUnit),
    };
  };

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Review and decisions
          </h1>
          <Badge variant="secondary">
            <ClipboardCheck className="size-3" /> You decide
          </Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          Review proposed Program changes, the evidence behind them, what you
          decided, and the training recorded afterward. Nothing changes your
          Program without your approval.
        </p>
      </header>

      <section
        className="flex flex-col gap-3"
        aria-labelledby="pending-decisions-heading"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="pending-decisions-heading" className="font-medium">
              Decisions needing review
            </h2>
            <p className="text-xs text-muted-foreground">
              These are proposed Program changes, not informational coaching.
            </p>
          </div>
          <Badge variant={review.pending.length > 0 ? "default" : "outline"}>
            {review.pending.length} pending
          </Badge>
        </div>
        {review.pending.length === 0 ? (
          <div className="rounded-xl border border-dashed p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="size-4 text-success" />
              Nothing needs your decision right now
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {review.recent.length === 0
                ? "No decisions have been proposed yet. Rule-based checks run from completed planned workouts and recorded pain evidence."
                : "Recent decisions remain below, together with any follow-up training that is ready to assess."}
            </p>
          </div>
        ) : (
          review.pending.map((recommendation) => (
            <RecommendationCard
              key={recommendation.id}
              rec={toCardData(recommendation)}
              loadStep={
                recommendation.payload.kind === "load_change" &&
                recommendation.payload.loadUnit === "kg"
                  ? 2.5
                  : 5
              }
            />
          ))
        )}
      </section>

      <section
        className="flex flex-col gap-3"
        aria-labelledby="recent-exception-context-heading"
      >
        <div>
          <h2 id="recent-exception-context-heading" className="font-medium">
            Recent effort and issue context
          </h2>
          <p className="text-xs text-muted-foreground">
            Recorded observations are evidence for Review. They do not change
            your Program, approve a proposal, or create an adaptation.
          </p>
        </div>
        {review.recentExceptions.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            No optional effort or issue context is recorded. Ordinary completed
            sets remain unknown for these fields.
          </p>
        ) : (
          <ol className="grid gap-3 md:grid-cols-2" aria-label="Recent effort and issue context">
            {review.recentExceptions.map((item) => {
              const details = [
                item.rir == null ? null : `RIR ${item.rir}`,
                item.rpe == null ? null : `RPE ${item.rpe}`,
                item.techniqueIssue != null && item.techniqueIssue in TECHNIQUE_ISSUE_LABELS
                  ? `Technique: ${TECHNIQUE_ISSUE_LABELS[item.techniqueIssue as TechniqueIssue]}`
                  : null,
                item.limitationCause != null && item.limitationCause in LIMITATION_CAUSE_LABELS
                  ? `Limited by: ${LIMITATION_CAUSE_LABELS[item.limitationCause as LimitationCause]}`
                  : null,
                item.painBodyPart == null || item.painSeverity == null
                  ? null
                  : `Pain: ${item.painBodyPart} ${item.painSeverity}/10`,
              ].filter((value): value is string => value != null);
              return (
                <li key={item.setId} className="rounded-xl border bg-card p-4">
                  <p className="font-medium">
                    {item.exerciseName} · set {item.setNo}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.workoutName} · {formatRecordedLocalDate(item.localDate)}
                  </p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {details.map((detail) => <li key={detail}>{detail}</li>)}
                  </ul>
                  <Link
                    href={`/history/${item.sessionId}`}
                    className="mt-3 inline-flex min-h-8 items-center text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    Open supporting workout
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section
        className="flex flex-col gap-3"
        aria-labelledby="recent-decisions-heading"
      >
        <div>
          <h2 id="recent-decisions-heading" className="font-medium">
            Recent decisions
          </h2>
          <p className="text-xs text-muted-foreground">
            Accepted, edited, rejected, dismissed, expired, and undone records
            stay distinct.
          </p>
        </div>
        {review.recent.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            No decision history yet. This list begins after you accept, edit, or
            reject a proposal, dismiss an automatic notice, or when a proposal
            expires.
          </p>
        ) : (
          <ol className="flex flex-col gap-2" aria-label="Recent decisions">
            {review.recent.map((recommendation) => {
              const status = reviewDecisionStatus(recommendation);
              const undoneAt = recommendation.adaptations.find(
                (adaptation) => adaptation.undoneAt != null
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
                  className="rounded-xl border bg-card p-3 text-sm"
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
                            : null
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
                          user.profile.timezone
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
        )}
      </section>

      <section
        className="flex flex-col gap-3"
        aria-labelledby="outcomes-heading"
      >
        <div>
          <h2 id="outcomes-heading" className="font-medium">
            Outcomes ready to assess
          </h2>
          <p className="text-xs text-muted-foreground">
            Follow-up appears only when a later completed planned workout carries
            the accepted load target and records working sets performed at that
            load.
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
          <ol className="grid gap-3 md:grid-cols-2" aria-label="Outcomes ready to assess">
            {review.outcomes.map((outcome) => (
              <li
                key={outcome.recommendationId}
                className="rounded-xl border bg-card p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{outcome.exerciseName}</p>
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
                      {outcome.followupSessions === 1 ? "" : "s"} · {outcome.workingSets} sets
                    </dd>
                  </div>
                  <div className="rounded-lg bg-muted/55 p-2">
                    <dt className="text-muted-foreground">Targets recorded</dt>
                    <dd className="mt-0.5 font-medium">
                      {outcome.measurableSets > 0
                        ? `${outcome.targetsMet}/${outcome.measurableSets} met · ${outcome.measurableSets}/${outcome.workingSets} recorded`
                        : "Not recorded"}
                    </dd>
                  </div>
                  <div className="rounded-lg bg-muted/55 p-2">
                    <dt className="text-muted-foreground">Effort recorded</dt>
                    <dd className="mt-0.5 font-medium">
                      {outcome.averageRpe == null
                        ? "Not recorded"
                        : `${outcome.averageRpe} avg. RPE · ${outcome.rpeCount}/${outcome.workingSets} recorded`}
                    </dd>
                  </div>
                  <div className="rounded-lg bg-muted/55 p-2">
                    <dt className="text-muted-foreground">Pain evidence</dt>
                    <dd className="mt-0.5 font-medium">
                      {outcome.painFlags === 0
                        ? "No pain flag recorded"
                        : `${outcome.painFlags} flag${
                            outcome.painFlags === 1 ? "" : "s"
                          } · max ${outcome.maxPainSeverity}/10`}
                    </dd>
                  </div>
                </dl>
                {outcome.evidenceLimited && (
                  <p className="mt-3 rounded-lg border border-amber-500/35 bg-amber-500/5 p-2 text-xs text-amber-800 dark:text-amber-300">
                    Evidence is limited: target results or effort are missing for
                    one or more recorded sets. Review the workout record without
                    treating this as proof the change helped.
                  </p>
                )}
                <Link
                  href={`/history/${outcome.latestSessionId}`}
                  className="mt-3 inline-flex min-h-8 items-center text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Open {outcome.latestSessionName} · {formatRecordedLocalDate(outcome.latestLocalDate)}
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section
        className="rounded-2xl border bg-muted/25 p-4"
        aria-labelledby="live-coach-context-heading"
      >
        <div className="flex items-start gap-3">
          <MessageSquareText className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 id="live-coach-context-heading" className="font-medium">
              Live Coach stays with the workout
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Use Live Coach during an active workout from Ask Coach, a
              pain or stalled-progression question, or the whole-workout control
              near Finish. Saved questions and observations remain in that
              workout&apos;s History record for post-workout review.
            </p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
              <Link
                href={activeSession ? `/session/${activeSession.id}` : "/today"}
                className="font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {activeSession
                  ? `Open ${activeSession.templateName ?? "active workout"}`
                  : "Go to Today"}
              </Link>
              <Link
                href="/history"
                className="font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Review completed workouts
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section
        className="flex flex-col gap-5 border-t pt-6"
        aria-labelledby="secondary-tools-heading"
      >
        <div>
          <h2 id="secondary-tools-heading" className="font-medium">
            Secondary coaching tools
          </h2>
          <p className="text-xs text-muted-foreground">
            Generated reviews and open-ended answers can help you interpret
            training, but they are informational and cannot change the Program.
          </p>
        </div>

        {testSessionCount > 0 && (
          <Alert className="border-chart-2/30 bg-chart-2/5">
            <Database className="size-4" />
            <AlertTitle>Sample history is included</AlertTitle>
            <AlertDescription>
              The snapshot and generated review can use {testSessionCount} clearly
              labelled sample workouts. Sample sessions never create changes to
              your real Program. You can remove them in{" "}
              <Link href="/settings">Settings</Link>.
            </AlertDescription>
          </Alert>
        )}

        <CoachTools
          aiAvailable={isAIAvailable()}
          hasTrainingData={
            report.overview.completedSessions > 0 ||
            activityReport.overview.totalActivities > 0
          }
        />

        {latestReview && latestReviewRow ? (
          <CoachReview
            review={latestReview}
            createdAt={latestReviewRow.createdAt}
            timezone={user.profile.timezone}
          />
        ) : (
          <div className="rounded-2xl border border-dashed p-5 text-center">
            <Sparkles className="mx-auto mb-2 size-5 text-muted-foreground" />
            <h3 className="font-medium">No generated review yet</h3>
            <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">
              Create one with the secondary tool above when you want a narrative
              summary with evidence and data gaps.
            </p>
          </div>
        )}

        {answers.length > 0 ? (
          <div className="flex flex-col gap-3" aria-labelledby="answers-heading">
            <div>
              <h3 id="answers-heading" className="font-medium">
                Recent open-ended answers
              </h3>
              <p className="text-xs text-muted-foreground">
                Answers stay attached to the evidence available when you asked.
              </p>
            </div>
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
        ) : (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            No open-ended answers yet. Ask Coach above when a question does not
            belong to a pending Program decision or an active workout.
          </p>
        )}

        <div aria-labelledby="snapshot-heading">
          <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 id="snapshot-heading" className="font-medium">
                12-week evidence snapshot
              </h3>
              <p className="text-xs text-muted-foreground">
                Calculated directly from logged workouts
              </p>
            </div>
            <Link
              href="/history?range=12w"
              className="text-xs text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Open full history
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric
              label="Workouts"
              value={String(report.overview.completedSessions)}
              hint={
                report.cadence.averageSessionsPerCompleteWeek == null
                  ? `${report.overview.workingSets} working sets`
                  : `${report.cadence.averageSessionsPerCompleteWeek} per complete week · current preference ${report.cadence.currentPreference.sessionsPerWeek}`
              }
            />
            <Metric
              label="Planned sets at or above"
              value={
                report.overview.targetOutcomes.atOrAboveRate == null
                  ? "—"
                  : `${report.overview.targetOutcomes.atOrAboveRate}%`
              }
              hint={`${report.overview.targetOutcomes.below} below · ${report.overview.targetOutcomes.at} at · ${report.overview.targetOutcomes.above} above · ${report.overview.targetOutcomes.unknown} unknown`}
            />
            <Metric
              label="Avg. effort"
              value={
                report.overview.averageRpe == null
                  ? "—"
                  : String(report.overview.averageRpe)
              }
              hint="Recorded RPE"
            />
            <Metric
              label="Avg. fatigue"
              value={
                report.recovery.averageFatigue == null
                  ? "—"
                  : `${report.recovery.averageFatigue}/5`
              }
              hint={`${report.recovery.fatigueCheckIns} check-ins`}
            />
          </div>
        </div>

        <CoachActivityContext report={activityReport} />
      </section>

      <footer className="flex items-start gap-2 rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
        <p>
          Review and decisions is for training guidance, not diagnosis. It shows
          recorded evidence, names missing information, and keeps every Program
          change behind your approval.
        </p>
      </footer>
    </main>
  );
}
