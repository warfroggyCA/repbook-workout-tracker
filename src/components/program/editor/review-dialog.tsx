"use client";

import { Check, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProgramEditorController } from "@/components/program/editor/use-program-editor-controller";
import { describeProgramReviewChange, formatProgramReviewValue, type ProgramReview, type ProgramReviewChange } from "@/lib/program-editor-client";
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
                              {describeProgramReviewChange(change)}
                            </p>
                            <details className="mt-2">
                              <summary className="min-h-10 cursor-pointer text-sm text-muted-foreground">
                                See exact before and after
                              </summary>
                              <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                                <div>
                                  <dt className="font-medium text-muted-foreground">
                                    Before
                                  </dt>
                                  <dd className="mt-1 break-words">
                                    {formatProgramReviewValue(change.before)}
                                  </dd>
                                </div>
                                <div>
                                  <dt className="font-medium text-muted-foreground">
                                    After
                                  </dt>
                                  <dd className="mt-1 break-words">
                                    {formatProgramReviewValue(change.after)}
                                  </dd>
                                </div>
                              </dl>
                            </details>
                          </li>
                        ))}
                      </ol>
                    )}
                    {currentReview.programUpdates.length > 0 && (
                      <details className="rounded-lg border bg-muted/20 p-3">
                        <summary className="min-h-11 cursor-pointer font-medium">
                          Older Program update
                          <span className="mt-1 block text-sm font-normal leading-5 text-muted-foreground">
                            Repbook prepared older saved details for the current
                            editor. This is separate from what you changed and
                            does not alter the active Program unless you activate
                            this draft.
                          </span>
                        </summary>
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
                        Checks before activating
                      </h2>
                    </CardTitle>
                    <CardDescription>
                      Repbook checks whether this Program can be started as
                      written with the saved equipment and constraints. Warnings
                      never change the Program on their own.
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
                                    ? "Needs fixing before activation"
                                    : "Worth checking"}{` · ${dayName}${slotName ? ` · ${slotName}` : ""}`}
                                </p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {finding.reason}
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Matching past workouts: {finding.evidenceCount}.
                                  This number does not make the warning more or
                                  less certain.
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
