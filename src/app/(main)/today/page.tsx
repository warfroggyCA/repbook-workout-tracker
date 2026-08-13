import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Footprints,
  Play,
} from "lucide-react";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { getTodayPageData, type TodayData } from "@/services/today";
import { TodayStats } from "@/components/dashboard/today-stats";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { formatRelativeLocalDate } from "@/lib/dates";
import { QuickLogCard } from "@/components/quick-log/quick-log-card";
import { ExerciseFamilyIcon } from "@/components/exercises/exercise-family-icon";
import { WorkoutStartForm } from "@/components/session/workout-start-form";
import { ActiveWorkoutDiscard } from "@/components/session/active-workout-actions";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { acceptanceWorkoutNow } from "@/lib/acceptance-workout-clock";

function whyThisProgramDay(today: TodayData) {
  if (today.nextTemplateReason.kind === "after_completed_program_day") {
    return `Next after ${today.nextTemplateReason.previousTemplateName}, completed ${formatRelativeLocalDate(
      today.nextTemplateReason.previousLocalDate,
      today.currentLocalDate
    )}.`;
  }
  if (today.nextTemplateReason.kind === "program_changed") {
    return "First in the current rotation because your Program changed.";
  }
  return "First in the Program because no Program day is complete yet.";
}

function ProgramDecisionStatus({ count }: { count: number }) {
  const hasPendingDecision = count > 0;
  const Icon = hasPendingDecision ? AlertCircle : CheckCircle2;
  const content = (
    <>
      <Icon
        className={
          hasPendingDecision
            ? "size-4 shrink-0 text-amber-700 dark:text-amber-400"
            : "size-4 shrink-0 text-success"
        }
      />
      <span className="min-w-0 flex-1 text-xs font-medium leading-snug">
        {hasPendingDecision
          ? `${count} Program change${count === 1 ? "" : "s"} pending`
          : "No Program changes pending"}
      </span>
    </>
  );

  return hasPendingDecision ? (
    <Link
      href="/coach"
      aria-label={`Program decision status: ${count} change${
        count === 1 ? "" : "s"
      } need${count === 1 ? "s" : ""} review. Open Review and decisions.`}
      className="flex min-h-11 items-center gap-2 rounded-xl border bg-muted/35 px-3 py-2 outline-none hover:bg-muted/65 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {content}
    </Link>
  ) : (
    <div
      aria-label="Program decision status"
      className="flex min-h-11 items-center gap-2 rounded-xl border bg-muted/35 px-3 py-2"
    >
      {content}
    </div>
  );
}

function occurrenceTitle(occurrence: TodayData["inProgressOccurrences"][number]) {
  if (occurrence.kind === "day_warmup") {
    return occurrence.label ?? "Day warm-up";
  }
  if (occurrence.kind === "exercise_warmup") {
    return `${occurrence.plannedExerciseName ?? "Exercise"} warm-up${
      occurrence.label ? ` — ${occurrence.label}` : ""
    }`;
  }
  return `${occurrence.plannedExerciseName ?? "Exercise"} · set ${
    occurrence.kindOrdinal + 1
  }`;
}

function occurrencePrescription(
  occurrence: TodayData["inProgressOccurrences"][number],
) {
  const details: string[] = [];
  if (occurrence.plannedRepsMin != null) {
    details.push(
      occurrence.plannedRepsMax != null &&
        occurrence.plannedRepsMax !== occurrence.plannedRepsMin
        ? `${occurrence.plannedRepsMin}–${occurrence.plannedRepsMax} reps`
        : `${occurrence.plannedRepsMin} reps`,
    );
  }
  if (occurrence.plannedLoad != null && occurrence.plannedLoadUnit) {
    details.push(`${occurrence.plannedLoad} ${occurrence.plannedLoadUnit}`);
  } else if (occurrence.plannedLoadPercent != null) {
    details.push(`${occurrence.plannedLoadPercent}% of work weight`);
  } else if (occurrence.plannedLoadText) {
    details.push(occurrence.plannedLoadText);
  }
  if (occurrence.groupRound != null) {
    details.push(
      `group round ${occurrence.groupRound}, member ${(occurrence.groupMemberOrderIdx ?? 0) + 1}`,
    );
  }
  if (occurrence.plannedRestSec != null) {
    details.push(`${occurrence.plannedRestSec}s rest after`);
  }
  return details.join(" · ");
}

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{
    program?: string;
    start?: string;
    compiler?: string;
    preview?: string;
  }>;
}) {
  const query = await searchParams;
  const user = await getCurrentUser();
  const db = await getDb();
  const now = acceptanceWorkoutNow("finish")?.() ?? new Date();
  const { today, pendingRecs, recentSessions, stats } =
    await getTodayPageData(db, user.id, user.profile.timezone, now);

  if (!today) redirect("/setup");

  const next = today.nextTemplate!;
  // Server-issued identity keeps the HTML form, pre-hydration submission, and
  // hydrated retries on one exact Start intent.
  const startRequestKey = randomUUID();
  const previewTemplate = query.preview
    ? (today.allTemplates.find(
        ({ template }) => template.id === query.preview,
      ) ?? null)
    : null;
  const isAlternatePreview =
    previewTemplate != null && previewTemplate.template.id !== next.template.id;
  const selectedTemplate = isAlternatePreview ? previewTemplate : next;
  const lastDone = today.lastDoneByTemplateId[selectedTemplate.template.id];
  const gap = today.daysSinceLastSession;
  const alternateTemplates = today.allTemplates.filter(
    (template) => template.template.id !== next.template.id
  );
  const activeTimingNeedsReview =
    today.inProgressTiming?.reviewRequired ?? false;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-0 sm:gap-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Today
        </h1>
      </header>

      {query.program === "updated" && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>Your Program was updated</AlertTitle>
          <AlertDescription>
            Today has refreshed to the current version. Review the workout below
            before starting.
          </AlertDescription>
        </Alert>
      )}
      {query.compiler === "active" && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>A workout is already active</AlertTitle>
          <AlertDescription>
            The reviewed proposal was not started. Resume or finish the active workout first.
          </AlertDescription>
        </Alert>
      )}

      {query.preview && !previewTemplate && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>That Program day is no longer available</AlertTitle>
          <AlertDescription>
            Your current Program is shown below. Choose another day again if
            you still want a different workout.
          </AlertDescription>
        </Alert>
      )}

      {query.start === "retry" && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>Workout not started</AlertTitle>
          <AlertDescription>
            The workout could not be created completely. Nothing was saved — try
            again.
          </AlertDescription>
        </Alert>
      )}

      {query.start === "active" && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>A workout is already active</AlertTitle>
          <AlertDescription>
            The workout you requested was not started. Resume or finish the
            active workout first.
          </AlertDescription>
        </Alert>
      )}

      <section aria-label="Today’s current decision">
        {today.inProgressSessionId ? (
          <Card
            data-testid="today-decision"
            size="sm"
            className={
              activeTimingNeedsReview
                ? "border-amber-500/60 bg-amber-500/5"
                : "border-primary/50"
            }
          >
            <CardHeader className="gap-1">
              <p className={
                activeTimingNeedsReview
                  ? "text-xs font-medium uppercase tracking-[0.12em] text-amber-800 dark:text-amber-300"
                  : "text-xs font-medium uppercase tracking-[0.12em] text-primary"
              }>
                {activeTimingNeedsReview
                  ? "Workout needs attention"
                  : "Active workout"}
              </p>
              <h2 className="text-xl font-semibold leading-tight sm:text-2xl">
                {today.inProgressSessionName ?? "Workout in progress"}
              </h2>
              <CardDescription className="leading-relaxed">
                {today.inProgressSessionStartedAtISO
                  ? `Started ${new Intl.DateTimeFormat("en-CA", {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: user.profile.timezone,
                    })
                      .format(new Date(today.inProgressSessionStartedAtISO))
                      .replace(/\.$/, "")}. `
                  : ""}
                <span className="sm:hidden">
                  Saved sets and notes are retained.
                </span>
                <span className="hidden sm:inline">
                  Unfinished workouts are retained so saved sets and notes
                  survive leaving or closing the web app.
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 sm:gap-3">
              {activeTimingNeedsReview && today.inProgressTiming && (
                <div
                  role="status"
                  data-testid="stale-workout-timing"
                  className="rounded-xl border border-amber-500/50 bg-background/80 px-3 py-2.5 text-sm"
                >
                  <p className="font-medium">
                    Timing needs review · wall clock {today.inProgressTiming.wallClockLabel}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Active time is unavailable until you review the interruption.
                    The recorded start is retained.
                  </p>
                </div>
              )}
              <Button
                render={<Link href={`/session/${today.inProgressSessionId}`} />}
                nativeButton={false}
                size="lg"
                className="h-auto min-h-12 w-full whitespace-normal py-3 text-center text-base leading-tight"
              >
                <Play className="size-4" /> Resume workout
              </Button>
              {activeTimingNeedsReview && (
                <Button
                  render={
                    <Link
                      href={`/session/${today.inProgressSessionId}?reviewTiming=1`}
                    />
                  }
                  nativeButton={false}
                  variant="outline"
                  size="lg"
                  className="h-auto min-h-12 w-full whitespace-normal py-3 text-center text-base leading-tight"
                >
                  Review timing &amp; finish
                </Button>
              )}
              <ProgramDecisionStatus count={pendingRecs.length} />
              <ActiveWorkoutDiscard
                ownerId={user.id}
                sessionId={today.inProgressSessionId}
                sessionName={today.inProgressSessionName ?? "this workout"}
              />
              {today.inProgressOccurrences.length > 0 && (
                <details className="rounded-xl border bg-muted/25">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    <span>
                      Workout steps · {today.inProgressOccurrences.filter(
                        (occurrence) => occurrence.outcome !== "pending",
                      ).length}
                      /{today.inProgressOccurrences.length} resolved
                    </span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  </summary>
                  <ol className="max-h-72 space-y-2 overflow-y-auto border-t p-3">
                    {today.inProgressOccurrences.map((occurrence) => {
                      const prescription = occurrencePrescription(occurrence);
                      return (
                        <li
                          key={occurrence.id}
                          className="rounded-lg border bg-background px-3 py-2 text-sm"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <span className="font-medium">
                              {occurrenceTitle(occurrence)}
                            </span>
                            <span className="shrink-0 capitalize text-muted-foreground">
                              {occurrence.outcome.replaceAll("_", " ")}
                            </span>
                          </div>
                          {prescription && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {prescription}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </details>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            <Card
              data-testid="today-decision"
              size="sm"
              className="border-primary/40"
            >
              <CardHeader className="gap-1">
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-primary">
                  {isAlternatePreview
                    ? "Workout preview"
                    : "Next in your Program"}
                </p>
                <h2 className="text-xl font-semibold leading-tight sm:text-2xl">
                  {selectedTemplate.template.name}
                </h2>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {isAlternatePreview && (
                  <p className="text-sm text-muted-foreground">
                    Nothing starts until you choose Start workout.
                  </p>
                )}
                {gap != null && gap >= 7 && (
                  <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
                    {gap} days since your last workout. Start around 10% lighter
                    than usual and settle back into the movements.
                  </p>
                )}
                <WorkoutStartForm
                  templateId={selectedTemplate.template.id}
                  startRequestKey={startRequestKey}
                  fallbackTimezone={user.profile.timezone}
                  retryLabel={selectedTemplate.template.name}
                  buttonClassName="h-auto min-h-12 w-full whitespace-normal py-3 text-center text-base leading-tight"
                >
                  <Play className="size-4" />
                  {isAlternatePreview ? "Start workout" : "Train as planned"}
                </WorkoutStartForm>
                {isAlternatePreview && (
                  <Button
                    render={<Link href="/today" />}
                    nativeButton={false}
                    variant="outline"
                    className="min-h-11 w-full"
                  >
                    <ArrowLeft className="size-4" /> Back to today&apos;s plan
                  </Button>
                )}
                <ProgramDecisionStatus count={pendingRecs.length} />
                <div
                  data-testid="today-supporting-context"
                  className="space-y-1"
                >
                  <CardDescription>
                    {today.programName} · {selectedTemplate.slots.length}{" "}
                    exercises
                  </CardDescription>
                  {!isAlternatePreview && (
                    <p className="text-xs leading-relaxed">
                      <span className="font-medium">Why this day:</span>{" "}
                      {whyThisProgramDay(today)}
                    </p>
                  )}
                </div>
                <details
                  open={isAlternatePreview}
                  data-testid="planned-exercise-preview"
                  className="border-t pt-2"
                >
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    {isAlternatePreview
                      ? "Planned exercises"
                      : "Preview planned exercises"}{" "}
                    ({selectedTemplate.slots.length})
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  </summary>
                  {lastDone && (
                    <p className="px-1 pb-1 text-xs text-muted-foreground">
                      This day was last completed{" "}
                      {formatRelativeLocalDate(lastDone, today.currentLocalDate)}.
                    </p>
                  )}
                  <ul className="mt-1 flex flex-col divide-y">
                    {selectedTemplate.slots.map(
                      ({ slot, exercise, prescription }) => (
                        <li
                          key={slot.id}
                          className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 py-3 sm:flex"
                        >
                          <ExerciseFamilyIcon
                            family={exercise.family}
                            exerciseName={exercise.name}
                            movementPattern={exercise.movementPattern}
                            className="size-11 rounded-full bg-muted/65 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {exercise.name}
                          </span>
                          {prescription && (
                            <span className="col-start-2 text-sm tabular-nums text-muted-foreground sm:ml-auto sm:shrink-0">
                              {prescription.sets} × {prescription.repRangeMin}–
                              {prescription.repRangeMax}
                              {prescription.targetLoad != null
                                ? ` · ${prescription.targetLoad} ${prescription.targetLoadUnit}`
                                : ""}
                            </span>
                          )}
                        </li>
                      ),
                    )}
                  </ul>
                </details>
              </CardContent>
            </Card>

            {!isAlternatePreview && alternateTemplates.length > 0 && (
              <details
                data-testid="alternate-program-days"
                className="rounded-2xl border bg-card shadow-[var(--shadow-soft)]"
              >
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  <span>
                    Choose another Program day
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      Secondary option
                    </span>
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </summary>
                <div className="grid gap-2 border-t p-3 sm:grid-cols-2">
                  {alternateTemplates.map((template) => (
                    <Button
                      key={template.template.id}
                      render={
                        <Link
                          href={{
                            pathname: "/today",
                            query: { preview: template.template.id },
                          }}
                        />
                      }
                      nativeButton={false}
                      variant="outline"
                      className="h-auto min-h-12 w-full justify-between bg-card px-3 py-2 text-left"
                    >
                      <span className="min-w-0">
                        <span className="block truncate">
                          {template.template.name}
                        </span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {today.lastDoneByTemplateId[template.template.id]
                            ? `Last completed ${formatRelativeLocalDate(
                                today.lastDoneByTemplateId[template.template.id],
                                today.currentLocalDate
                              )}`
                            : "Not completed yet"}
                        </span>
                      </span>
                      <ChevronRight className="size-4" />
                    </Button>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="supporting-actions-heading" className="pt-1">
        <div className="mb-3">
          <h2 id="supporting-actions-heading" className="text-lg font-semibold">
            Supporting actions
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Record something else without changing the planned workout above.
          </p>
        </div>
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <Card size="sm">
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:flex-col lg:items-stretch">
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Footprints className="size-4" />
                </span>
                <div>
                  <h3 className="font-medium">Record activity</h3>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    Save a walk, run, ride, or other activity separately.
                  </p>
                </div>
              </div>
              <Button
                render={<Link href="/activity/new" prefetch={false} />}
                nativeButton={false}
                variant="outline"
                className="min-h-11 w-full sm:w-auto lg:w-full"
              >
                <Footprints className="size-4" /> Record activity
              </Button>
            </CardContent>
          </Card>
          <QuickLogCard />
        </div>
      </section>

      <section aria-labelledby="recent-training-heading" className="pt-1">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 id="recent-training-heading" className="text-lg font-semibold">
              Recent training
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Supporting context after today’s choice.
            </p>
          </div>
          <Link href="/history" className="shrink-0 text-sm font-medium text-primary">
            View full history
          </Link>
        </div>
        <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          {stats.hasHistory ? (
            <TodayStats stats={stats} unit={user.profile.unit} />
          ) : (
            <Card className="border-dashed">
              <CardContent className="py-6">
                <h3 className="font-medium">No completed workouts yet</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Statistics and streaks will appear after your first completed
                  workout.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
              <h3 className="font-semibold">Recent workouts</h3>
              <Link href="/history" className="text-xs font-medium text-primary">
                View all
              </Link>
            </CardHeader>
            <CardContent>
              {recentSessions.length > 0 ? (
                <div className="flex flex-col divide-y">
                  {recentSessions.map((session) => (
                    <Link
                      key={session.id}
                      href={`/history/${session.id}`}
                      className="flex min-h-11 items-center justify-between gap-2 py-3 text-sm"
                    >
                      <span className="min-w-0 truncate font-medium">
                        {session.templateName ?? "Workout"}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatRelativeLocalDate(
                          session.localDate,
                          today.currentLocalDate
                        )}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="py-3 text-sm text-muted-foreground">
                  Completed workouts will appear here after your first one.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
