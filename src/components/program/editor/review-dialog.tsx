"use client";

import { Check, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProgramEditorController } from "@/components/program/editor/use-program-editor-controller";
import { describeProgramReviewChange, formatProgramReviewValue, type ProgramReview, type ProgramReviewChange } from "@/lib/program-editor-client";
import type { ProgramPreflightFinding } from "@/lib/program-preflight";
import { cn } from "@/lib/utils";

function displayLabel(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function lineageConsequences(changes: ProgramReviewChange[]) {
  const consequences = new Map<string, string>();
  for (const change of changes) {
    if (!change.path.startsWith("slots.")) continue;
    const slotPath = change.path.split(".").slice(0, 2).join(".");
    if (change.kind === "replace") consequences.set(slotPath, change.label + ". Earlier progression remains with the retired exercise slot; the replacement starts fresh.");
    else if (change.kind === "remove") consequences.set(slotPath, change.label + ". Its earlier progression remains in workout history and is not reused.");
    else if (change.kind === "add") consequences.set(slotPath, change.label + ". This new exercise slot starts its own progression history.");
  }
  return [...consequences.values()];
}

function hasTrainingTotalChange(review: ProgramReview) {
  return (
    review.summary.weeklySetsBefore !== review.summary.weeklySetsAfter ||
    JSON.stringify(review.summary.muscleSetsBefore) !==
      JSON.stringify(review.summary.muscleSetsAfter)
  );
}

function reviewRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function warmupOverview(value: unknown) {
  const record = reviewRecord(value);
  return typeof record?.overview === "string" && record.overview.trim()
    ? record.overview.trim()
    : null;
}

function warmupSteps(value: unknown) {
  const record = reviewRecord(value);
  const valueSteps = Array.isArray(record?.steps)
    ? record.steps
    : Array.isArray(record?.items)
      ? record.items
      : [];
  return valueSteps
    .map((item) => reviewRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function warmupStepLabels(value: unknown) {
  return warmupSteps(value)
    .map((item) => (typeof item.label === "string" ? item.label.trim() : ""))
    .filter(Boolean);
}

function overviewLines(value: unknown) {
  return (warmupOverview(value)?.split(/\r?\n/) ?? [])
    .map((line) => line.trim())
    .filter(Boolean);
}

function warmupStepCount(value: unknown) {
  const steps = warmupStepLabels(value);
  return steps.length || overviewLines(value).length;
}

function describeVisibleChange(change: ProgramReviewChange) {
  if (change.kind !== "warmup") return describeProgramReviewChange(change);
  const beforeLines = overviewLines(change.before).length;
  const afterLines = overviewLines(change.after).length;
  if (beforeLines === 0 && afterLines > 0) {
    return `${change.label} added (${countLabel(afterLines, "line")}).`;
  }
  if (beforeLines > 0 && afterLines === 0) {
    return `${change.label} cleared.`;
  }
  if (beforeLines > 0 && afterLines > 0 && beforeLines !== afterLines) {
    const direction = afterLines < beforeLines ? "shortened" : "expanded";
    return `${change.label} ${direction} from ${countLabel(beforeLines, "line")} to ${countLabel(afterLines, "line")}.`;
  }
  const beforeSteps = warmupStepCount(change.before);
  const afterSteps = warmupStepCount(change.after);
  if (beforeSteps !== afterSteps) {
    return `${change.label}: ${beforeSteps} → ${afterSteps} check-off steps.`;
  }
  return `${change.label} changed.`;
}

function isMirroredWarmup(value: unknown) {
  const steps = warmupStepLabels(value);
  const lines = overviewLines(value);
  return (
    steps.length > 0 &&
    steps.length === lines.length &&
    steps.every((step, index) => step === lines[index])
  );
}

function formatWarmupStep(item: Record<string, unknown>) {
  const parts = [
    typeof item.label === "string" ? item.label.trim() : "",
    typeof item.reps === "number" ? `${item.reps} reps` : "",
    typeof item.load === "number"
      ? `${item.load} ${typeof item.loadUnit === "string" ? item.loadUnit : ""}`.trim()
      : "",
    typeof item.loadPercent === "number"
      ? `${item.loadPercent}% of work weight`
      : "",
    typeof item.loadText === "string" ? item.loadText.trim() : "",
    typeof item.notes === "string" ? item.notes.trim() : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function ReviewChangeValue({
  change,
  value,
}: {
  change: ProgramReviewChange;
  value: unknown;
}) {
  if (change.kind !== "warmup") {
    return <>{formatProgramReviewValue(value)}</>;
  }
  const overview = warmupOverview(value);
  const steps = warmupSteps(value);
  const showSeparateSteps = steps.length > 0 && !isMirroredWarmup(value);
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-line">
        {overview ?? "No warm-up instructions"}
      </p>
      {showSeparateSteps && (
        <div>
          <p className="font-medium text-muted-foreground">Check-off steps</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            {steps.map((item, index) => (
              <li key={typeof item.key === "string" ? item.key : index}>
                {formatWarmupStep(item)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

type FindingGroup = {
  code: string;
  reason: string;
  severity: ProgramPreflightFinding["severity"];
  findings: ProgramPreflightFinding[];
};

function groupFindings(findings: ProgramPreflightFinding[]) {
  const groupedCodes = new Set([
    "equipment_unavailable",
    "active_avoid_constraint",
    "active_caution_constraint",
    "duration_target_overrun",
    "protected_minimum_tension",
    "recent_pain_association",
  ]);
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const key = `${finding.severity}:${finding.code}:${groupedCodes.has(finding.code) ? "" : finding.reason}`;
    const group = groups.get(key);
    if (group) group.findings.push(finding);
    else {
      groups.set(key, {
        code: finding.code,
        reason: finding.reason,
        severity: finding.severity,
        findings: [finding],
      });
    }
  }
  return [...groups.values()];
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function findingGroupCopy(group: FindingGroup) {
  const count = group.findings.length;
  switch (group.code) {
    case "equipment_unavailable":
      return {
        title: `${countLabel(count, "exercise")} ${count === 1 ? "doesn't" : "don't"} match your saved equipment`,
        description:
          "Change these exercises or update your saved equipment before activating.",
        affectedLabel: countLabel(count, "affected exercise"),
      };
    case "active_avoid_constraint":
      return {
        title: `${countLabel(count, "exercise")} ${count === 1 ? "conflicts" : "conflict"} with something you're avoiding`,
        description:
          "Change these exercises or review the saved limit before activating.",
        affectedLabel: countLabel(count, "affected exercise"),
      };
    case "active_caution_constraint":
      return {
        title: `${countLabel(count, "exercise")} ${count === 1 ? "matches" : "match"} one of your saved cautions`,
        description: "Have a look before you activate this Program.",
        affectedLabel: countLabel(count, "affected exercise"),
      };
    case "duration_target_overrun":
      return {
        title: `${countLabel(count, "workout day")} may run longer than planned`,
        description:
          "The current estimate is longer than the time target saved for these days.",
        affectedLabel: countLabel(count, "affected day"),
      };
    case "protected_minimum_tension":
      return {
        title: `${countLabel(count, "workout day")} may be hard to shorten`,
        description:
          "Every exercise on these days is marked as must-do or protected.",
        affectedLabel: countLabel(count, "affected day"),
      };
    case "recent_pain_association":
      return {
        title: `${countLabel(count, "exercise")} ${count === 1 ? "has" : "have"} recent pain notes`,
        description:
          "Recent notes are associated with these movements. Repbook is not saying the exercises caused the pain.",
        affectedLabel: countLabel(count, "affected exercise"),
      };
    default:
      return {
        title:
          group.severity === "blocking"
            ? `${countLabel(count, "check")} ${count === 1 ? "needs" : "need"} fixing`
            : `${countLabel(count, "check")} ${count === 1 ? "is" : "are"} worth a look`,
        description: group.reason,
        affectedLabel: countLabel(count, "affected item"),
      };
  }
}

function unique(values: string[]) {
  return [...new Set(values)];
}

export function ReviewDialog({ editor, currentReview, canReview }: { editor: ProgramEditorController; currentReview: ProgramReview | null; canReview: boolean }) {
  const {
    document: programDocument,
    exerciseById,
    reviewing,
    requestReview,
    publishing,
    publish,
    router,
    setActiveTab,
    setActiveDayId,
    setExpandedSlotId,
    dayHeadingRefs,
    slotHeadingRefs,
  } = editor;
  const preflightFindings = currentReview?.preflight?.findings ?? [];
  const groupedFindings = groupFindings(preflightFindings);
  const preflightReasons = new Set(
    preflightFindings.map((finding) => finding.reason),
  );
  const otherBlockingErrors = unique(
    (currentReview?.blockingErrors ?? []).filter(
      (error) => !preflightReasons.has(error),
    ),
  );
  const otherCautions = unique(
    (currentReview?.cautions ?? []).filter(
      (caution) => !preflightReasons.has(caution),
    ),
  );
  const blockingFindingCount = preflightFindings.filter(
    (finding) => finding.severity === "blocking",
  ).length;
  return (
    <>
            {!currentReview ? (
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h2 className="text-lg font-semibold">
                      Review before activation
                    </h2>
                  </CardTitle>
                  <CardDescription>
                    Save every change, then ask the server to compare this exact
                    revision with the current Program.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={!canReview || reviewing}
                    onClick={() => void requestReview()}
                  >
                    {reviewing ? (
                      <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <RefreshCw />
                    )}{" "}
                    Compare with current Program
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <h2 className="text-lg font-semibold">
                        Changes you made
                      </h2>
                    </CardTitle>
                    <CardDescription>
                      {currentReview.changes.length === 0
                        ? "This draft does not contain a deliberate Program change yet."
                        : `${currentReview.changes.length} change${currentReview.changes.length === 1 ? "" : "s"} compared with the current Program.`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {currentReview.changes.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Return to editing or discard the draft. Repbook will not
                        activate an older-Program update by itself.
                      </p>
                    ) : (
                      <ol className="space-y-2">
                        {currentReview.changes.map((change, index) => (
                          <li
                            key={`${change.path}-${index}`}
                            className="rounded-lg border p-3"
                          >
                            <p className="font-medium">
                              {describeVisibleChange(change)}
                            </p>
                            {!["add", "remove", "replace"].includes(
                              change.kind,
                            ) && (
                              <details className="mt-2">
                                <summary className="min-h-10 cursor-pointer text-sm text-muted-foreground">
                                  {change.kind === "warmup"
                                    ? "See the warm-up text"
                                    : "See before and after"}
                                </summary>
                                <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
                                  <div>
                                    <dt className="font-medium text-muted-foreground">
                                      Before
                                    </dt>
                                    <dd className="mt-1 break-words">
                                      <ReviewChangeValue
                                        change={change}
                                        value={change.before}
                                      />
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="font-medium text-muted-foreground">
                                      After
                                    </dt>
                                    <dd className="mt-1 break-words">
                                      <ReviewChangeValue
                                        change={change}
                                        value={change.after}
                                      />
                                    </dd>
                                  </div>
                                </dl>
                              </details>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                    {currentReview.programUpdates.length > 0 && (
                      <details className="rounded-lg border bg-muted/20 p-3">
                        <summary className="min-h-11 cursor-pointer font-medium">
                          Repbook prepared older saved details
                        </summary>
                        <p className="mt-2 text-sm text-muted-foreground">
                          These are separate from your changes. Nothing becomes
                          active until you activate this draft.
                        </p>
                        <ul className="mt-3 space-y-2 text-sm">
                          {currentReview.programUpdates.map((change, index) => (
                            <li key={`${change.path}-${index}`}>
                              {describeProgramReviewChange(change)}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </CardContent>
                </Card>
                {currentReview.blockingErrors.length > 0 && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertTitle>Activation is paused</AlertTitle>
                    <AlertDescription>
                      <p>
                        {blockingFindingCount > 0
                          ? `Fix the red ${blockingFindingCount === 1 ? "item" : "items"} below before you activate. Your draft is safe and nothing has been activated.`
                          : "Fix the issue below before activating. Your draft is safe and nothing has been activated."}
                      </p>
                      {otherBlockingErrors.length > 0 && (
                        <ul className="mt-2 list-disc space-y-1 pl-5">
                          {otherBlockingErrors.map((item) => (
                          <li key={item}>{item}</li>
                          ))}
                        </ul>
                      )}
                    </AlertDescription>
                  </Alert>
                )}
                {otherCautions.length > 0 && (
                  <Alert className="border-amber-500/50">
                    <CircleAlert />
                    <AlertTitle>Also worth checking</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc space-y-1 pl-5">
                        {otherCautions.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <h2 className="text-lg font-semibold">
                        Before you activate
                      </h2>
                    </CardTitle>
                    <CardDescription>
                      {blockingFindingCount > 0
                        ? "Fix the red items. Yellow items are a heads-up and do not change your Program."
                        : "These checks never change your Program on their own."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {!currentReview.preflight ? (
                      <p className="text-sm text-muted-foreground">
                        These checks are unavailable for this older Program
                        version.
                      </p>
                    ) : currentReview.preflight.findings.length === 0 ? (
                      <p className="text-sm">
                        No problem or warning was found. If Repbook has little or
                        no matching workout history, its time estimate may be
                        less specific.
                      </p>
                    ) : (
                      groupedFindings.map((group) => {
                        const copy = findingGroupCopy(group);
                        return (
                          <article
                            key={`${group.severity}:${group.code}:${group.reason}`}
                            className={cn(
                              "rounded-lg border p-3",
                              group.severity === "blocking"
                                ? "border-destructive/50 bg-destructive/5"
                                : "border-amber-500/50 bg-amber-500/5",
                            )}
                          >
                            <p className="font-medium">{copy.title}</p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {copy.description}
                            </p>
                            <details className="mt-2">
                              <summary className="min-h-10 cursor-pointer text-sm font-medium">
                                Show {copy.affectedLabel}
                              </summary>
                              <ul className="mt-2 space-y-2">
                                {group.findings.map((finding) => {
                                  const day = programDocument?.days.find(
                                    (candidate) =>
                                      candidate.lineageId ===
                                      finding.dayLineageId,
                                  );
                                  const dayName = day?.name ?? "Program day";
                                  const slot = finding.slotLineageId
                                    ? programDocument?.days
                                        .flatMap(
                                          (candidate) => candidate.exercises,
                                        )
                                        .find(
                                          (candidate) =>
                                            candidate.lineageId ===
                                            finding.slotLineageId,
                                        )
                                    : null;
                                  const slotName = slot
                                    ? (exerciseById.get(slot.exerciseId)?.name ??
                                      "Affected exercise")
                                    : null;
                                  const duration =
                                    group.code === "duration_target_overrun"
                                      ? currentReview.preflight?.durations.find(
                                          (candidate) =>
                                            candidate.dayLineageId ===
                                            finding.dayLineageId,
                                        )
                                      : null;
                                  return (
                                    <li
                                      key={finding.id}
                                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background p-2"
                                    >
                                      <div>
                                        <p className="text-sm font-medium">
                                          {dayName}
                                          {slotName ? ` · ${slotName}` : ""}
                                        </p>
                                        {duration && day?.intent && (
                                          <p className="text-xs text-muted-foreground">
                                            {duration.minMinutes}–
                                            {duration.maxMinutes} min estimate ·{" "}
                                            {
                                              day.intent.targetDuration
                                                .minMinutes
                                            }
                                            –
                                            {
                                              day.intent.targetDuration
                                                .maxMinutes
                                            }{" "}
                                            min target
                                          </p>
                                        )}
                                        {group.code ===
                                          "recent_pain_association" && (
                                          <p className="text-xs text-muted-foreground">
                                            {countLabel(
                                              finding.evidenceCount,
                                              "recent pain note",
                                            )}
                                          </p>
                                        )}
                                      </div>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => {
                                          setActiveTab("edit");
                                          setActiveDayId(
                                            finding.dayLineageId,
                                          );
                                          if (finding.slotLineageId) {
                                            setExpandedSlotId(
                                              finding.slotLineageId,
                                            );
                                          }
                                          router.push(
                                            `/program/edit?day=${finding.dayLineageId}`,
                                            { scroll: false },
                                          );
                                          requestAnimationFrame(() => {
                                            if (finding.slotLineageId) {
                                              slotHeadingRefs.current
                                                .get(finding.slotLineageId)
                                                ?.focus();
                                            } else {
                                              dayHeadingRefs.current
                                                .get(finding.dayLineageId)
                                                ?.focus();
                                            }
                                          });
                                        }}
                                      >
                                        Edit{" "}
                                        {finding.slotLineageId
                                          ? "exercise"
                                          : "day"}
                                      </Button>
                                    </li>
                                  );
                                })}
                              </ul>
                            </details>
                          </article>
                        );
                      })
                    )}
                  </CardContent>
                </Card>
                {hasTrainingTotalChange(currentReview) && <Card>
                  <CardHeader>
                    <CardTitle>
                      <h2 className="text-lg font-semibold">
                        Training summary
                      </h2>
                    </CardTitle>
                    <CardDescription>
                      How the weekly plan changes.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground">
                          Weekly work sets
                        </dt>
                        <dd className="font-medium">
                          {currentReview.summary.weeklySetsBefore} →{" "}
                          {currentReview.summary.weeklySetsAfter}
                        </dd>
                      </div>
                    </dl>
                    <div className="mt-4">
                      <h3 className="font-medium">Muscle emphasis</h3>
                      {Object.keys({
                        ...currentReview.summary.muscleSetsBefore,
                        ...currentReview.summary.muscleSetsAfter,
                      }).length === 0 ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          No muscle-emphasis data is available for these
                          exercises.
                        </p>
                      ) : (
                        <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                          {Object.keys({
                            ...currentReview.summary.muscleSetsBefore,
                            ...currentReview.summary.muscleSetsAfter,
                          })
                            .sort()
                            .map((muscle) => (
                              <div
                                key={muscle}
                                className="rounded-lg border p-2"
                              >
                                <dt>{displayLabel(muscle)}</dt>
                                <dd className="font-medium">
                                  {currentReview.summary.muscleSetsBefore[
                                    muscle
                                  ] ?? 0}{" "}
                                  →{" "}
                                  {currentReview.summary.muscleSetsAfter[
                                    muscle
                                  ] ?? 0}{" "}
                                  sets
                                </dd>
                              </div>
                            ))}
                        </dl>
                      )}
                    </div>
                  </CardContent>
                </Card>}
                {currentReview.recommendationConsequences.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle>
                        <h2 className="text-lg font-semibold">
                          Coach suggestions
                        </h2>
                      </CardTitle>
                      <CardDescription>
                        These outcomes are included in this exact review.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2">
                        {currentReview.recommendationConsequences.map(
                          (item) => (
                            <li
                              key={item.recommendationId}
                              className="rounded-lg border p-3 text-sm"
                            >
                              <Badge variant="outline">{item.outcome}</Badge>
                              <p className="mt-2">{item.explanation}</p>
                            </li>
                          ),
                        )}
                      </ul>
                    </CardContent>
                  </Card>
                )}
                {lineageConsequences(currentReview.changes).length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle>
                        <h2 className="text-lg font-semibold">
                          What happens to exercise history
                        </h2>
                      </CardTitle>
                      <CardDescription>
                        What happens to earlier workout evidence for each edited
                        exercise.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ul className="list-disc space-y-2 pl-5 text-sm">
                        {lineageConsequences(currentReview.changes).map(
                          (consequence) => (
                            <li key={consequence}>{consequence}</li>
                          ),
                        )}
                      </ul>
                    </CardContent>
                  </Card>
                )}
                <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    Activation creates a new immutable version. It never
                    rewrites a past or active workout.
                  </p>
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={
                      publishing ||
                      currentReview.status !== "publishable" ||
                      currentReview.changes.length === 0
                    }
                    onClick={() => void publish()}
                  >
                    {publishing ? (
                      <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Check />
                    )}{" "}
                    Activate new version
                  </Button>
                </div>
              </>
            )}
    </>
  );
}
