"use client";

import { Check, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProgramEditorController } from "@/components/program/editor/use-program-editor-controller";
import { formatProgramReviewValue, type ProgramReview, type ProgramReviewChange } from "@/lib/program-editor-client";
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
    else if (!consequences.has(slotPath)) consequences.set(slotPath, change.label + ". This exercise keeps its progression history because its identity is unchanged.");
  }
  return [...consequences.values()];
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
                    Create semantic review
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <>
                {currentReview.blockingErrors.length > 0 && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertTitle>Activation is blocked</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc space-y-1 pl-5">
                        {currentReview.blockingErrors.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}
                {currentReview.cautions.length > 0 && (
                  <Alert className="border-amber-500/50">
                    <CircleAlert />
                    <AlertTitle>Review these cautions</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc space-y-1 pl-5">
                        {currentReview.cautions.map((item) => (
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
                        Program Preflight
                      </h2>
                    </CardTitle>
                    <CardDescription>
                      Blocking execution problems prevent publication. Training
                      warnings remain reviewable evidence, not automatic
                      rejection.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {!currentReview.preflight ? (
                      <p className="text-sm text-muted-foreground">
                        Preflight is unavailable for this historical document
                        version.
                      </p>
                    ) : currentReview.preflight.findings.length === 0 ? (
                      <p className="text-sm">
                        No blocking execution problem or cautious training
                        warning was found. Sparse or missing evidence can still
                        limit the duration basis shown below.
                      </p>
                    ) : (
                      currentReview.preflight.findings.map((finding) => {
                        const dayName =
                          programDocument?.days.find(
                            (day) => day.lineageId === finding.dayLineageId,
                          )?.name ?? "Program day";
                        const slot = finding.slotLineageId
                          ? programDocument?.days
                              .flatMap((day) => day.exercises)
                              .find(
                                (candidate) =>
                                  candidate.lineageId === finding.slotLineageId,
                              )
                          : null;
                        const slotName = slot
                          ? (exerciseById.get(slot.exerciseId)?.name ??
                            "Affected exercise")
                          : null;
                        return (
                          <article
                            key={finding.id}
                            className={cn(
                              "rounded-lg border p-3",
                              finding.severity === "blocking"
                                ? "border-destructive/50 bg-destructive/5"
                                : "border-amber-500/50 bg-amber-500/5",
                            )}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <p className="font-medium">
                                  {finding.severity === "blocking"
                                    ? "Blocking execution problem"
                                    : "Training warning"}{` · ${dayName}${slotName ? ` · ${slotName}` : ""}`}
                                </p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {finding.reason}
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Evidence records: {finding.evidenceCount}.
                                  This count is not a confidence score.
                                </p>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => {
                                  setActiveTab("edit");
                                  setActiveDayId(finding.dayLineageId);
                                  if (finding.slotLineageId) {
                                    setExpandedSlotId(finding.slotLineageId);
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
                                Edit affected{
                                  finding.slotLineageId ? " exercise" : " day"
                                }
                              </Button>
                            </div>
                          </article>
                        );
                      })
                    )}
                  </CardContent>
                </Card>
                <Card>
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
                      <div>
                        <dt className="text-muted-foreground">
                          Explainable day duration ranges
                        </dt>
                        <dd className="mt-1 space-y-1 font-medium">
                          {currentReview.summary.durationAfter.map(
                            (duration) => {
                              const dayName =
                                programDocument?.days.find(
                                  (day) =>
                                    day.lineageId === duration.dayLineageId,
                                )?.name ?? "Program day";
                              return (
                                <span
                                  className="block"
                                  key={duration.dayLineageId}
                                >
                                  {dayName}: {duration.minMinutes}–
                                  {duration.maxMinutes} minutes ·{" "}
                                  {duration.evidenceCount === 0
                                    ? "planned fallback"
                                    : `${duration.evidenceCount} comparable session${duration.evidenceCount === 1 ? "" : "s"}`}
                                </span>
                              );
                            },
                          )}
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
                </Card>
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
                          Progression continuity
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
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <h2 className="text-lg font-semibold">
                        What will change
                      </h2>
                    </CardTitle>
                    <CardDescription>
                      {currentReview.changes.length} meaningful change
                      {currentReview.changes.length === 1 ? "" : "s"} in
                      revision {currentReview.reviewedRevision}.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {currentReview.changes.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No meaningful changes were found.
                      </p>
                    ) : (
                      <ol className="space-y-3">
                        {currentReview.changes.map((change, index) => (
                          <li
                            key={`${change.path}-${index}`}
                            className="rounded-lg border p-3"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">
                                {change.kind.replaceAll("_", " ")}
                              </Badge>
                              <h3 className="font-medium">{change.label}</h3>
                            </div>
                            <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                              <div>
                                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                  Before
                                </dt>
                                <dd className="mt-1 break-words">
                                  {formatProgramReviewValue(change.before)}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                  After
                                </dt>
                                <dd className="mt-1 break-words">
                                  {formatProgramReviewValue(change.after)}
                                </dd>
                              </div>
                            </dl>
                          </li>
                        ))}
                      </ol>
                    )}
                  </CardContent>
                </Card>
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
