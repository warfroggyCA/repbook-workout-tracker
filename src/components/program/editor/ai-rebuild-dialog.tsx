"use client";

import { Check, CircleAlert, LoaderCircle, Sparkles } from "lucide-react";
import { memo } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/program/editor/editor-ui";
import type { ProgramEditorController } from "@/components/program/editor/use-program-editor-controller";
import { applyProgramUpdateChanges } from "@/lib/program-update-reconciliation";
import {
  mergeProgramDocumentV2ChangesIntoV3,
} from "@/lib/program-editor-client";
import { projectIntentProgramDocumentV2 } from "@/lib/program-document";
import { cn } from "@/lib/utils";

export const AiRebuildDialog = memo(function AiRebuildDialog({ editor }: { editor: ProgramEditorController }) {
  const { document, coachMode, setCoachMode, coachPrompt, setCoachPrompt, coachBuilding, buildCoachProposal, coachMessage, coachProposal, acceptedCoachChanges, setAcceptedCoachChanges, setCoachProposal, updateDocument, setCoachMessage } = editor;
  if (!document) return null;
  return (
    <>
            <Card className="border-primary/30">
              <CardHeader>
                <CardTitle>
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Sparkles className="size-5 text-primary" /> Update Program from text
                  </h2>
                </CardTitle>
                <CardDescription>
                  Paste or describe changes. The default keeps everything you do
                  not explicitly mention. Nothing changes until you select and
                  apply proposal items, review them, and publish a new version.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Update mode</legend>
                  <label className="flex min-h-11 items-start gap-3 rounded-lg border p-3">
                    <input type="radio" name="program-update-mode" value="update" checked={coachMode === "update"} onChange={() => setCoachMode("update")} className="mt-1 size-4" />
                    <span><span className="block font-medium">Update current Program</span><span className="block text-xs text-muted-foreground">Unmentioned days, exercises, and fields stay unchanged.</span></span>
                  </label>
                  <label className="flex min-h-11 items-start gap-3 rounded-lg border border-destructive/30 p-3">
                    <input type="radio" name="program-update-mode" value="replace" checked={coachMode === "replace"} onChange={() => setCoachMode("replace")} className="mt-1 size-4" />
                    <span><span className="block font-medium">Create full replacement</span><span className="block text-xs text-destructive">Unmentioned days and exercises may be removed from the proposed version.</span></span>
                  </label>
                </fieldset>
                <Field id="coach-program-prompt" label="What should change?">
                  <Textarea
                    id="coach-program-prompt"
                    value={coachPrompt}
                    onChange={(event) => setCoachPrompt(event.target.value)}
                    rows={6}
                    maxLength={20000}
                    placeholder="On Upper day, change bench press to 4 sets of 6–8 with 2 min rest, then add cable fly after it. Leave everything else unchanged."
                  />
                </Field>
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={coachBuilding || !coachPrompt.trim()}
                  onClick={() => void buildCoachProposal()}
                >
                  {coachBuilding ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
                  {coachBuilding ? "Comparing changes…" : "Compare and propose changes"}
                </Button>

                {coachMessage && !coachMessage.startsWith("Coach's proposal") && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertTitle>Coach could not build the proposal</AlertTitle>
                    <AlertDescription>{coachMessage}</AlertDescription>
                  </Alert>
                )}

                {coachProposal && (
                  <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
                    <div>
                      <p className="font-semibold">Proposal ready to review</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {coachProposal.proposal.changes.filter((change) => change.category === "added").length} added · {coachProposal.proposal.changes.filter((change) => change.category === "changed").length} changed · {coachProposal.proposal.changes.filter((change) => change.category === "removed").length} removed · {coachProposal.proposal.changes.filter((change) => change.category === "unchanged").length} unchanged · {coachProposal.proposal.changes.filter((change) => change.category === "decision").length} need a decision
                      </p>
                    </div>
                    {coachProposal.warnings.length > 0 && (
                      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                        {coachProposal.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    )}
                    <div aria-label="Proposed Program changes" className="space-y-2 rounded-lg border bg-background p-3">
                      {(["added", "changed", "removed", "unchanged", "decision"] as const).map((category) => {
                        const groupedChanges = coachProposal.proposal.changes.filter((change) => change.category === category);
                        if (groupedChanges.length === 0) return null;
                        const heading = category === "decision" ? "Needs a decision" : `${category[0].toUpperCase()}${category.slice(1)}`;
                        return <section key={category} className="space-y-2" aria-label={heading}>
                          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h4>
                          {groupedChanges.map((change) => (
                        <div key={change.id} className={cn("flex min-h-11 items-start gap-3 rounded-lg border p-3", change.category === "decision" && "border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/20")}>
                          <input
                            type="checkbox"
                            aria-label={`Select change: ${change.summary}`}
                            className="mt-1 size-4"
                            disabled={change.operation.kind === "none"}
                            checked={acceptedCoachChanges.has(change.id)}
                            onChange={(event) => setAcceptedCoachChanges((current) => { const next = new Set(current); if (event.target.checked) next.add(change.id); else next.delete(change.id); return next; })}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">{change.category}</span>
                            <span className="block text-sm">{change.summary}</span>
                            {change.operation.kind === "add_slot" && (
                              <span className="mt-2 grid gap-2 sm:grid-cols-2">
                                <select
                                  aria-label="Destination day"
                                  className="min-h-10 rounded-lg border bg-background px-2 text-sm"
                                  value={change.operation.dayId}
                                  onChange={(event) => setCoachProposal((current) => current ? { ...current, proposal: { ...current.proposal, changes: current.proposal.changes.map((item) => item.id === change.id && item.operation.kind === "add_slot" ? { ...item, operation: { ...item.operation, dayId: event.target.value, position: document.days.find((day) => day.lineageId === event.target.value)?.exercises.length ?? 0 } } : item) } } : current)}
                                >
                                  {document.days.map((day) => <option key={day.lineageId} value={day.lineageId}>{day.name}</option>)}
                                </select>
                                <select
                                  aria-label="Position in day"
                                  className="min-h-10 rounded-lg border bg-background px-2 text-sm"
                                  value={change.operation.position}
                                  onChange={(event) => setCoachProposal((current) => current ? { ...current, proposal: { ...current.proposal, changes: current.proposal.changes.map((item) => item.id === change.id && item.operation.kind === "add_slot" ? { ...item, operation: { ...item.operation, position: Number(event.target.value) } } : item) } } : current)}
                                >
                                  {Array.from({ length: (document.days.find((day) => "dayId" in change.operation && day.lineageId === change.operation.dayId)?.exercises.length ?? 0) + 1 }, (_, index) => <option key={index} value={index}>Position {index + 1}</option>)}
                                </select>
                              </span>
                            )}
                          </span>
                        </div>
                          ))}
                        </section>;
                      })}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        disabled={acceptedCoachChanges.size === 0}
                        onClick={() => {
                          updateDocument((current) =>
                            mergeProgramDocumentV2ChangesIntoV3(
                              current,
                              applyProgramUpdateChanges(
                                projectIntentProgramDocumentV2(current),
                                coachProposal.proposal.changes,
                                acceptedCoachChanges,
                              ),
                            ),
                          );
                          setCoachProposal(null);
                          setCoachMessage(
                            "Coach's proposal is now your editable draft. Only the selected changes were applied. Check the days below, then use Review when it has saved.",
                          );
                        }}
                      >
                        <Check /> Apply selected changes
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setCoachProposal(null)}
                      >
                        Keep current draft
                      </Button>
                    </div>
                  </div>
                )}

                {coachMessage && !coachProposal &&
                  coachMessage.startsWith("Coach's proposal") && (
                    <Alert>
                      <Check />
                      <AlertTitle>Proposal applied to the draft</AlertTitle>
                      <AlertDescription>{coachMessage}</AlertDescription>
                    </Alert>
                  )}
              </CardContent>
            </Card>

    </>
  );
});
