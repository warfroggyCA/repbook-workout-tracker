import Link from "next/link";
import { ArrowUpRight, Dumbbell, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  EXERCISE_EVIDENCE_TIER_LABELS,
  EXERCISE_HISTORY_ALGORITHM_VERSION,
  type ExerciseEvidenceTier,
} from "@/lib/history-exercise-evidence";
import {
  buildWorkoutHistoryHref,
  buildHistoryHref,
  type HistoryContext,
} from "@/lib/history-navigation";
import { formatRecordedLocalDate } from "@/lib/dates";
import {
  setMetricExclusionLabel,
  type SetMetricExclusionReason,
} from "@/lib/set-metric-semantics";
import { cn } from "@/lib/utils";
import type { HistoryRangeKey, HistoryReport } from "@/services/history-report";

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatPerformance(
  performance: {
    weight: number | null;
    reps: number;
  },
  unit: string,
  exclusionReason: SetMetricExclusionReason | null,
) {
  if (
    exclusionReason === "assistance_not_comparable" &&
    performance.weight != null
  ) {
    return `Assistance: ${performance.weight} ${unit} · ${performance.reps} reps`;
  }
  return performance.weight != null
    ? `${performance.weight} ${unit} × ${performance.reps}`
    : `${performance.reps} reps`;
}

export function HistoryExercisesWorkspace({
  report,
  context,
  unit,
}: {
  report: HistoryReport;
  context: HistoryContext & { range: HistoryRangeKey };
  unit: string;
}) {
  const detailContext: HistoryContext = {
    ...context,
    view: "exercises",
    lens: "overview",
  };
  const maxMuscleSets = Math.max(
    1,
    ...report.muscles.map((muscle) => muscle.sets),
  );
  const selectedExercise = context.exerciseId
    ? (report.exerciseEvidence.find(
        (exercise) => exercise.exerciseId === context.exerciseId,
      ) ?? null)
    : null;
  const visibleExercises = context.exerciseId
    ? selectedExercise
      ? [selectedExercise]
      : []
    : report.exerciseEvidence;
  const visibleEvidence = visibleExercises.flatMap((exercise) =>
    exercise.evidence
      .filter(
        (entry) =>
          context.evidenceTier == null ||
          context.evidenceTier === "all" ||
          entry.tier === context.evidenceTier,
      )
      .map((entry) => ({ ...entry, exercise })),
  );
  const tiers: Array<"all" | ExerciseEvidenceTier> = [
    "all",
    "native",
    "manual",
    "imported",
    "corrected",
    "legacy",
    "unsupported",
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Exercise evidence</h3>
          </CardTitle>
          <CardDescription>
            Exact performed exercise identities stay separate. Legacy or
            unsupported facts remain visible, but only one-to-one linked
            completed working sets enter calculations.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <nav
            aria-label="Exercise evidence tiers"
            className="flex flex-wrap gap-2"
          >
            {tiers.map((tier) => (
              <Link
                key={tier}
                href={buildHistoryHref({
                  ...detailContext,
                  exerciseId: context.exerciseId,
                  evidenceTier: tier,
                })}
                scroll={false}
                prefetch={false}
                aria-current={
                  (context.evidenceTier ?? "all") === tier ? "page" : undefined
                }
                className={cn(
                  "inline-flex min-h-11 items-center rounded-full border px-3 text-xs font-medium",
                  (context.evidenceTier ?? "all") === tier
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background hover:border-primary/40",
                )}
              >
                {tier === "all"
                  ? "All evidence"
                  : EXERCISE_EVIDENCE_TIER_LABELS[tier]}
              </Link>
            ))}
          </nav>

          {context.exerciseId && !selectedExercise ? (
            <p
              role="status"
              className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground"
            >
              That exercise is unavailable in this owner-scoped history range.
            </p>
          ) : report.exerciseEvidence.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No retained exercise evidence in this period.
            </p>
          ) : (
            <div
              className="flex gap-2 overflow-x-auto pb-1"
              aria-label="Exact exercises"
            >
              <Link
                href={buildHistoryHref({ ...detailContext, exerciseId: null })}
                scroll={false}
                prefetch={false}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center rounded-xl border px-3 text-sm font-medium",
                  !context.exerciseId && "border-primary bg-primary/10",
                )}
              >
                All exercises
              </Link>
              {report.exerciseEvidence.map((exercise) => (
                <Link
                  key={exercise.exerciseId}
                  href={buildHistoryHref({
                    ...detailContext,
                    exerciseId: exercise.exerciseId,
                    evidenceTier: context.evidenceTier,
                  })}
                  scroll={false}
                  prefetch={false}
                  className={cn(
                    "inline-flex min-h-11 shrink-0 items-center rounded-xl border px-3 text-sm font-medium",
                    context.exerciseId === exercise.exerciseId &&
                      "border-primary bg-primary/10",
                  )}
                >
                  {exercise.exercise}
                </Link>
              ))}
            </div>
          )}

          {selectedExercise && (
            <div className="rounded-xl border bg-muted/15 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">
                  {selectedExercise.exercise}
                </span>
                <Badge variant="outline">
                  {titleCase(selectedExercise.scope)}
                </Badge>
                {selectedExercise.familyName && (
                  <Badge variant="outline">
                    Family: {selectedExercise.familyName}
                  </Badge>
                )}
              </div>
              <p className="mt-2 break-all text-xs text-muted-foreground">
                Exact ID: {selectedExercise.exerciseId}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedExercise.exactLinkedSets} of{" "}
                {selectedExercise.retainedSets} retained sets have one exact
                occurrence link; {selectedExercise.calculationEligibleSets} are
                eligible for exercise calculations.
                {selectedExercise.sourceExerciseKeys.length > 0 &&
                  ` Frozen source occurrence IDs: ${selectedExercise.sourceExerciseKeys.join(", ")}.`}
              </p>
              {selectedExercise.reviewedMappings.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {selectedExercise.reviewedMappings.map((mapping) => (
                    <li key={mapping.id} className="break-all">
                      Reviewed {mapping.source} mapping {mapping.normalizedKey},
                      confirmed {mapping.confirmedAtISO}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="divide-y">
            {visibleEvidence.slice(0, 24).map(({ exercise, ...entry }) => (
              <article
                key={entry.setId}
                className="grid gap-2 py-3 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {exercise.exercise} · set {entry.setNo}
                    </span>
                    <Badge variant="outline">
                      {EXERCISE_EVIDENCE_TIER_LABELS[entry.tier]}
                    </Badge>
                    <Badge variant="outline">
                      {entry.exactLinked
                        ? "Exact occurrence linked"
                        : "No exact occurrence link"}
                    </Badge>
                    <Badge variant="outline">
                      {entry.calculationEligible
                        ? "Calculation eligible"
                        : "Retained only"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatRecordedLocalDate(entry.localDate)} ·{" "}
                    {entry.weight == null
                      ? `${entry.reps ?? "—"} reps`
                      : `${entry.weight} ${entry.weightUnit ?? unit} × ${entry.reps ?? "—"}`}
                    {entry.sourceExerciseName &&
                      ` · source: ${entry.sourceExerciseName}`}
                  </p>
                  {entry.mappingStatus !== "not_applicable" && (
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      Reviewed source mapping: {titleCase(entry.mappingStatus)}
                      {entry.reviewedMapping &&
                        ` · ${entry.reviewedMapping.source}:${entry.reviewedMapping.normalizedKey} · confirmed ${entry.reviewedMapping.confirmedAtISO}`}
                    </p>
                  )}
                  {entry.plannedExerciseId &&
                    entry.plannedExerciseId !== entry.performedExerciseId && (
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        Substitution kept separate: prescribed{" "}
                        {entry.plannedExerciseId} → performed{" "}
                        {entry.performedExerciseId}
                      </p>
                    )}
                </div>
                <Link
                  href={buildWorkoutHistoryHref(entry.sessionId, detailContext)}
                  prefetch={false}
                  className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline"
                >
                  Source workout{" "}
                  <ArrowUpRight className="ml-1 size-3" aria-hidden="true" />
                </Link>
              </article>
            ))}
            {visibleEvidence.length === 0 && (
              <p className="py-3 text-sm text-muted-foreground">
                No evidence matches this filter.
              </p>
            )}
          </div>
          {visibleEvidence.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Showing up to 24 most recent matching retained sets in this
              range.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Derived progression and best observations use{" "}
            {EXERCISE_HISTORY_ALGORITHM_VERSION}; they are calculations, not
            stored workout facts.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Exact-exercise progression</h3>
          </CardTitle>
          <CardDescription>
            First versus latest top-set performance inside this period. Exercise
            variants stay separate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {report.exerciseProgress.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Complete workouts in this range to see exercise trends.
            </p>
          ) : (
            <div className="divide-y">
              {report.exerciseProgress.map((exercise) => {
                const change = exercise.changePercent;
                return (
                  <article
                    key={exercise.exerciseId}
                    className="grid min-w-0 gap-3 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(12rem,1fr)_minmax(15rem,auto)_auto] lg:items-center"
                  >
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold">
                        {exercise.exercise}
                      </h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {exercise.sessions} sessions · {exercise.sets} sets
                      </p>
                    </div>
                    <div className="min-w-0 text-xs tabular-nums text-muted-foreground">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>
                          {formatPerformance(
                            exercise.first,
                            unit,
                            exercise.exclusionReason,
                          )}
                        </span>
                        <span aria-hidden="true">→</span>
                        <span className="font-medium text-foreground">
                          {formatPerformance(
                            exercise.latest,
                            unit,
                            exercise.exclusionReason,
                          )}
                        </span>
                      </div>
                      {exercise.exclusionReason != null && (
                        <p className="mt-1 max-w-xl text-xs text-muted-foreground">
                          {setMetricExclusionLabel(exercise.exclusionReason)}
                        </p>
                      )}
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                        <Link
                          href={buildWorkoutHistoryHref(
                            exercise.first.sourceSessionId,
                            detailContext,
                          )}
                          prefetch={false}
                          className="inline-flex items-center font-medium text-primary underline-offset-4 hover:underline"
                        >
                          First workout
                          {exercise.first.localDate &&
                            ` · ${formatRecordedLocalDate(exercise.first.localDate)}`}
                          <ArrowUpRight
                            className="ml-1 size-3"
                            aria-hidden="true"
                          />
                        </Link>
                        {exercise.latest.sourceSessionId !==
                          exercise.first.sourceSessionId && (
                          <Link
                            href={buildWorkoutHistoryHref(
                              exercise.latest.sourceSessionId,
                              detailContext,
                            )}
                            prefetch={false}
                            className="inline-flex items-center font-medium text-primary underline-offset-4 hover:underline"
                          >
                            Latest workout
                            {exercise.latest.localDate &&
                              ` · ${formatRecordedLocalDate(exercise.latest.localDate)}`}
                            <ArrowUpRight
                              className="ml-1 size-3"
                              aria-hidden="true"
                            />
                          </Link>
                        )}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "w-fit tabular-nums",
                        change != null &&
                          change > 0 &&
                          "border-success/30 bg-success/10 text-success",
                        change != null &&
                          change < 0 &&
                          "border-destructive/30 bg-destructive/10 text-destructive",
                      )}
                    >
                      {exercise.exclusionReason != null
                        ? "Not comparable"
                        : change == null
                          ? "needs 2+"
                          : exercise.metric === "reps"
                            ? `${(exercise.repChange ?? 0) >= 0 ? "+" : ""}${exercise.repChange ?? 0} reps`
                            : `${change >= 0 ? "+" : ""}${change}% est.`}
                    </Badge>
                  </article>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Trophy className="size-4 text-primary" aria-hidden="true" />
            <CardTitle>
              <h3>Best observed performances</h3>
            </CardTitle>
          </div>
          <CardDescription>
            Best eligible observations inside this period—not durable all-time
            personal records. Warm-ups, excluded sets, assistance, timed work,
            distance work, and independent activities remain excluded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {report.records.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No eligible performance observations in this period.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {report.records.map((record) => (
                <Link
                  key={record.exerciseId}
                  href={buildWorkoutHistoryHref(
                    record.sourceSessionId,
                    detailContext,
                  )}
                  prefetch={false}
                  className="group rounded-xl border bg-muted/15 p-3 transition-colors hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold group-hover:text-primary">
                        {record.exercise}
                      </h3>
                      <p className="mt-1 text-sm font-medium tabular-nums">
                        {record.weight == null
                          ? `${record.reps} reps`
                          : `${record.weight} ${unit} × ${record.reps}`}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatRecordedLocalDate(record.localDate)}
                        {record.estimatedStrength != null &&
                          ` · ${record.estimatedStrength} ${unit} estimated strength`}
                        {` · ${record.sessions} session${record.sessions === 1 ? "" : "s"}`}
                      </p>
                    </div>
                    <ArrowUpRight
                      className="size-4 shrink-0 text-muted-foreground group-hover:text-primary"
                      aria-hidden="true"
                    />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="movement-context-heading">
        <div className="mb-3">
          <h3
            id="movement-context-heading"
            className="font-semibold tracking-tight"
          >
            Movement context
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Families group related variants only for context; they never merge
            exact-exercise progression or records.
          </p>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.8fr)]">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Dumbbell className="size-4 text-primary" aria-hidden="true" />
                <CardTitle>
                  <h3>Exercise families</h3>
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {report.families.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No family data yet.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {report.families.map((family) => (
                    <div
                      key={family.familyKey}
                      className="rounded-xl border bg-muted/20 p-3"
                    >
                      <p className="text-sm font-medium">{family.family}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {family.sessions} sessions · {family.sets} sets ·{" "}
                        {family.exercises} variant
                        {family.exercises === 1 ? "" : "s"}
                      </p>
                      {family.volume > 0 && (
                        <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                          {number.format(family.volume)} {unit} loaded volume
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <h3>Muscle distribution</h3>
              </CardTitle>
              <CardDescription>
                Sets involving each muscle. A compound set can count toward more
                than one muscle.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {report.muscles.map((muscle) => (
                <div key={muscle.muscle}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                    <span className="font-medium">
                      {titleCase(muscle.muscle)}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {muscle.sets} sets · {muscle.share}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{
                        width: `${(muscle.sets / maxMuscleSets) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
              {report.muscles.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No muscle data yet.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
