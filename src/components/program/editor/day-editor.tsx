"use client";

import { ArrowDown, ArrowUp, Check, CircleAlert, LoaderCircle, Trash2 } from "lucide-react";
import { memo, useState } from "react";
import { ExercisePicker } from "@/components/exercises/exercise-picker";
import { ExerciseFamilyIcon } from "@/components/exercises/exercise-family-icon";
import { ProgramDayTabs } from "@/components/program/program-day-tabs";
import { RestTimeControl } from "@/components/program/rest-time-control";
import { DayWarmupEditor } from "@/components/program/editor/warmup-editor";
import { ExerciseReorderHandle } from "@/components/program/editor/exercise-reorder-handle";
import { SlotEditor } from "@/components/program/editor/slot-editor";
import { SupersetControls } from "@/components/program/editor/superset-controls";
import { Field } from "@/components/program/editor/editor-ui";
import type { ProgramEditorController } from "@/components/program/editor/use-program-editor-controller";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { moveItem, moveProgramGroupMember, moveProgramSlotUnit, removeProgramSlotFromDay, replaceProgramExercise, resizeProgramSlotSets, updateProgramDayWarmupOverview, updateProgramSlotInDay } from "@/lib/program-editor-client";
import { programDocumentV3Schema, type ProgramDocumentDayV3 } from "@/lib/program-document";
import { formatRestTime } from "@/lib/rest-time";
import { cn } from "@/lib/utils";

function numberFromInput(value: string, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function optionalText(value: string) { return value.trim() ? value : null; }
function displayLabel(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }

export const DayEditor = memo(function DayEditor({ editor, canReview = false }: { editor: ProgramEditorController; canReview?: boolean }) {
  const { document, revision, router, library, updateDocument, activeDayId, setActiveDayId, dayHeadingRefs, updateDay, addDay, addExercise, pairingDayId, setPairingDayId, pairingSlotIds, setPairingSlotIds, expandedSlotId, setExpandedSlotId, slotHeadingRefs, exerciseById, moveSlotToDay, requestReview, reviewing, pendingFutureReplacementRequest, futureReplacementTarget, clearFutureReplacementRequest } = editor;
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [reorderGesture, setReorderGesture] = useState<{
    dayLineageId: string;
    unitId: string;
  } | null>(null);
  if (!document) return null;
  const documentValidation = programDocumentV3Schema.safeParse(document);
  return (
    <>
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2 className="text-lg font-semibold">Program details</h2>
                </CardTitle>
                <CardDescription>
                  Name the plan shown on Today and Program.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Field id="program-name" label="Program name">
                  <Input
                    id="program-name"
                    className="h-11"
                    value={document.name}
                    onChange={(event) =>
                      updateDocument((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    aria-invalid={!document.name.trim()}
                  />
                </Field>
              </CardContent>
            </Card>

            <ProgramDayTabs days={document.days} activeId={activeDayId ?? document.days[0].lineageId} pathname="/program/edit" label="Edit Program days" onSelect={setActiveDayId} />

            {document.days.map((day, dayIndex) => activeDayId === day.lineageId ? (
              <Card key={day.lineageId}>
                <CardHeader className="border-b">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h2
                        ref={(node) => {
                          if (node)
                            dayHeadingRefs.current.set(day.lineageId, node);
                          else dayHeadingRefs.current.delete(day.lineageId);
                        }}
                        tabIndex={-1}
                        className="text-lg font-semibold outline-none"
                      >
                        {day.name || "Unnamed day"}
                      </h2>
                    </div>
                    <div
                      className="flex flex-wrap gap-2"
                      aria-label={`Reorder or remove ${day.name || `day ${dayIndex + 1}`}`}
                    >
                      <Button
                        type="button"
                        size="icon-lg"
                        variant="outline"
                        aria-label={`Move ${day.name || "day"} up`}
                        disabled={dayIndex === 0}
                        onClick={() =>
                          updateDocument((current) => ({
                            ...current,
                            days: moveItem(
                              current.days,
                              dayIndex,
                              dayIndex - 1,
                            ),
                          }))
                        }
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        type="button"
                        size="icon-lg"
                        variant="outline"
                        aria-label={`Move ${day.name || "day"} down`}
                        disabled={dayIndex === document.days.length - 1}
                        onClick={() =>
                          updateDocument((current) => ({
                            ...current,
                            days: moveItem(
                              current.days,
                              dayIndex,
                              dayIndex + 1,
                            ),
                          }))
                        }
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        type="button"
                        size="icon-lg"
                        variant="destructive"
                        aria-label={`Remove ${day.name || "day"}`}
                        disabled={document.days.length === 1}
                        onClick={() => {
                          const focusLineage =
                            document.days[Math.max(0, dayIndex - 1)]?.lineageId;
                          updateDocument((current) => ({
                            ...current,
                            days: current.days.filter(
                              (_, index) => index !== dayIndex,
                            ),
                          }));
                          if (focusLineage) {
                            setActiveDayId(focusLineage);
                            router.push(`/program/edit?day=${focusLineage}`, { scroll: false });
                          }
                          requestAnimationFrame(
                            () =>
                              focusLineage &&
                              dayHeadingRefs.current.get(focusLineage)?.focus(),
                          );
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="grid gap-3 lg:grid-cols-2">
                    <Field id={`day-${day.lineageId}-name`} label="Day name">
                      <Input
                        id={`day-${day.lineageId}-name`}
                        className="h-11"
                        value={day.name}
                        aria-invalid={!day.name.trim()}
                        onChange={(event) =>
                          updateDay(dayIndex, (current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field id={`day-${day.lineageId}-notes`} label="Day notes">
                      <Textarea
                        id={`day-${day.lineageId}-notes`}
                        value={day.notes ?? ""}
                        onChange={(event) =>
                          updateDay(dayIndex, (current) => ({
                            ...current,
                            notes: optionalText(event.target.value),
                          }))
                        }
                      />
                    </Field>
                  </div>

                  <details className="rounded-lg border bg-muted/20 p-3">
                    <summary className="min-h-11 cursor-pointer font-medium">
                      Advanced session options
                      <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                        Used only when you ask Repbook to build a shorter session.
                        These settings never change your Program automatically.
                      </span>
                    </summary>
                    <p className="mb-3 mt-3 text-xs leading-5 text-muted-foreground">
                      Session length affects shorter-session proposals today.
                      Repbook stores the other planning details, but it does not
                      currently rearrange, pair, omit, or replace exercises from
                      these choices.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <Field id={`day-${day.lineageId}-primary-outcome`} label="Main goal">
                        <select
                          id={`day-${day.lineageId}-primary-outcome`}
                          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                          value={day.intent.primaryOutcome}
                          onChange={(event) =>
                            updateDay(dayIndex, (current) => ({
                              ...current,
                              intent: {
                                ...current.intent,
                                primaryOutcome: event.target
                                    .value as ProgramDocumentDayV3["intent"]["primaryOutcome"],
                                secondaryOutcomes:
                                  current.intent.secondaryOutcomes.filter(
                                    (value) => value !== event.target.value,
                                  ),
                              },
                            }))
                          }
                        >
                          <option value="strength">Strength</option>
                          <option value="hypertrophy">Hypertrophy</option>
                          <option value="skill">Skill</option>
                          <option value="conditioning">Conditioning</option>
                          <option value="work_capacity">Work capacity</option>
                          <option value="recovery">Recovery</option>
                        </select>
                      </Field>
                      <Field id={`day-${day.lineageId}-identity`} label="What makes this day recognizable">
                        <select
                          id={`day-${day.lineageId}-identity`}
                          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                          value={day.intent.identity.kind}
                          onChange={(event) =>
                            updateDay(dayIndex, (current) => ({
                              ...current,
                              intent: {
                                ...current.intent,
                                identity: {
                                  ...current.intent.identity,
                                  kind: event.target
                                    .value as ProgramDocumentDayV3["intent"]["identity"]["kind"],
                                  anchorSlotLineageIds:
                                    event.target.value === "anchor_slots"
                                      ? current.intent.identity.anchorSlotLineageIds
                                          .length
                                        ? current.intent.identity.anchorSlotLineageIds
                                        : [current.exercises[0].lineageId]
                                      : current.intent.identity.anchorSlotLineageIds,
                                },
                              },
                            }))
                          }
                        >
                          <option value="anchor_slots">Anchor exercises</option>
                          <option value="movement_balance">Movement balance</option>
                          <option value="muscle_emphasis">Muscle emphasis</option>
                          <option value="skill_practice">Skill practice</option>
                          <option value="conditioning_focus">Conditioning focus</option>
                          <option value="recovery_session">Recovery session</option>
                        </select>
                      </Field>
                      <Field id={`day-${day.lineageId}-target-min`} label="Usual time — minimum">
                        <Input
                          id={`day-${day.lineageId}-target-min`}
                          type="number"
                          min={5}
                          max={600}
                          inputMode="numeric"
                          value={day.intent.targetDuration.minMinutes}
                          onChange={(event) => {
                            const value = Math.max(5, Math.min(600, Math.trunc(numberFromInput(event.target.value, day.intent.targetDuration.minMinutes))));
                            updateDay(dayIndex, (current) => ({
                              ...current,
                              intent: {
                                ...current.intent,
                                targetDuration: {
                                  minMinutes: value,
                                  maxMinutes: Math.max(value, current.intent.targetDuration.maxMinutes),
                                },
                              },
                            }));
                          }}
                        />
                      </Field>
                      <Field id={`day-${day.lineageId}-target-max`} label="Usual time — maximum">
                        <Input
                          id={`day-${day.lineageId}-target-max`}
                          type="number"
                          min={5}
                          max={600}
                          inputMode="numeric"
                          value={day.intent.targetDuration.maxMinutes}
                          onChange={(event) => {
                            const value = Math.max(day.intent.targetDuration.minMinutes, Math.min(600, Math.trunc(numberFromInput(event.target.value, day.intent.targetDuration.maxMinutes))));
                            updateDay(dayIndex, (current) => ({
                              ...current,
                              intent: {
                                ...current.intent,
                                targetDuration: { ...current.intent.targetDuration, maxMinutes: value },
                                minimumUsefulDurationMinutes: Math.min(value, current.intent.minimumUsefulDurationMinutes),
                              },
                            }));
                          }}
                        />
                      </Field>
                      <Field id={`day-${day.lineageId}-minimum-useful`} label="Shortest useful session">
                        <Input
                          id={`day-${day.lineageId}-minimum-useful`}
                          type="number"
                          min={5}
                          max={day.intent.targetDuration.maxMinutes}
                          inputMode="numeric"
                          value={day.intent.minimumUsefulDurationMinutes}
                          onChange={(event) =>
                            updateDay(dayIndex, (current) => ({
                              ...current,
                              intent: {
                                ...current.intent,
                                minimumUsefulDurationMinutes: Math.max(5, Math.min(current.intent.targetDuration.maxMinutes, Math.trunc(numberFromInput(event.target.value, current.intent.minimumUsefulDurationMinutes)))),
                              },
                            }))
                          }
                        />
                      </Field>
                      <Field id={`day-${day.lineageId}-fatigue`} label="Fatigue preference (saved context)">
                        <select
                          id={`day-${day.lineageId}-fatigue`}
                          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                          value={day.intent.fatigueTolerance}
                          onChange={(event) =>
                            updateDay(dayIndex, (current) => ({
                              ...current,
                              intent: {
                                ...current.intent,
                                fatigueTolerance: event.target
                                    .value as ProgramDocumentDayV3["intent"]["fatigueTolerance"],
                              },
                            }))
                          }
                        >
                          <option value="low">Low</option>
                          <option value="normal">Normal</option>
                          <option value="high">High</option>
                        </select>
                      </Field>
                      <Field id={`day-${day.lineageId}-ordering`} label="Order preference (order is preserved)">
                        <select
                          id={`day-${day.lineageId}-ordering`}
                          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                          value={day.intent.orderingPolicy}
                          onChange={(event) =>
                            updateDay(dayIndex, (current) => ({
                              ...current,
                              intent: {
                                ...current.intent,
                                orderingPolicy: event.target
                                    .value as ProgramDocumentDayV3["intent"]["orderingPolicy"],
                              },
                            }))
                          }
                        >
                          <option value="preserve">Preserve order</option>
                          <option value="anchors_first">Anchors first</option>
                          <option value="flexible">Flexible</option>
                        </select>
                      </Field>
                      <Field id={`day-${day.lineageId}-pairing`} label="Pairing preference (pairings are preserved)">
                        <select
                          id={`day-${day.lineageId}-pairing`}
                          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                          value={day.intent.pairingPolicy}
                          onChange={(event) =>
                            updateDay(dayIndex, (current) => ({
                              ...current,
                              intent: {
                                ...current.intent,
                                pairingPolicy: event.target
                                    .value as ProgramDocumentDayV3["intent"]["pairingPolicy"],
                              },
                            }))
                          }
                        >
                          <option value="preserve">Preserve current pairings</option>
                          <option value="allow_compatible">Allow compatible pairings</option>
                          <option value="avoid_new">Avoid new pairings</option>
                        </select>
                      </Field>
                    </div>
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <fieldset className="rounded-lg border bg-background p-3">
                        <legend className="px-1 text-sm font-medium">
                          Other goals (saved for later)
                        </legend>
                        <div className="mt-2 flex flex-wrap gap-3 text-sm">
                          {(["strength", "hypertrophy", "skill", "conditioning", "work_capacity", "recovery"] as const)
                            .filter((outcome) => outcome !== day.intent.primaryOutcome)
                            .map((outcome) => (
                              <label key={outcome} className="flex min-h-11 items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={day.intent.secondaryOutcomes.includes(outcome)}
                                  onChange={(event) =>
                                    updateDay(dayIndex, (current) => ({
                                      ...current,
                                      intent: {
                                        ...current.intent,
                                        secondaryOutcomes: event.target.checked
                                          ? [...current.intent.secondaryOutcomes, outcome].slice(0, 3)
                                          : current.intent.secondaryOutcomes.filter((value) => value !== outcome),
                                      },
                                    }))
                                  }
                                />
                                {displayLabel(outcome)}
                              </label>
                            ))}
                        </div>
                      </fieldset>
                      {day.intent.identity.kind === "anchor_slots" && (
                        <fieldset className="rounded-lg border bg-background p-3">
                          <legend className="px-1 text-sm font-medium">
                            Exercises that define this day (saved for later)
                          </legend>
                          <div className="mt-2 space-y-1 text-sm">
                            {day.exercises.map((slot) => (
                              <label key={slot.lineageId} className="flex min-h-11 items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={day.intent.identity.anchorSlotLineageIds.includes(slot.lineageId)}
                                  onChange={(event) =>
                                    updateDay(dayIndex, (current) => ({
                                      ...current,
                                      intent: {
                                        ...current.intent,
                                        identity: {
                                          ...current.intent.identity,
                                          anchorSlotLineageIds: event.target.checked
                                            ? [...current.intent.identity.anchorSlotLineageIds, slot.lineageId]
                                            : current.intent.identity.anchorSlotLineageIds.filter((value) => value !== slot.lineageId),
                                        },
                                      },
                                    }))
                                  }
                                />
                                {exerciseById.get(slot.exerciseId)?.name ?? "Exercise"}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      )}
                    </div>
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <Field id={`day-${day.lineageId}-intent-note`} label="Planning note (optional)">
                        <Textarea
                          id={`day-${day.lineageId}-intent-note`}
                          value={day.intent.note ?? ""}
                          onChange={(event) =>
                            updateDay(dayIndex, (current) => ({
                              ...current,
                              intent: { ...current.intent, note: optionalText(event.target.value) },
                            }))
                          }
                        />
                      </Field>
                      <Field id={`day-${day.lineageId}-duration-override-note`} label="Different time range (optional)">
                        <Textarea
                          id={`day-${day.lineageId}-duration-override-note`}
                          value={day.intent.durationOverride?.note ?? ""}
                          placeholder="Explain why this day consistently needs a different range"
                          onChange={(event) => {
                            const note = optionalText(event.target.value);
                            updateDay(dayIndex, (current) => ({
                              ...current,
                              intent: {
                                ...current.intent,
                                durationOverride: note
                                  ? {
                                      minMinutes: current.intent.durationOverride?.minMinutes ?? current.intent.targetDuration.minMinutes,
                                      maxMinutes: current.intent.durationOverride?.maxMinutes ?? current.intent.targetDuration.maxMinutes,
                                      note,
                                    }
                                  : null,
                              },
                            }));
                          }}
                        />
                        {day.intent.durationOverride && (
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <Input
                              aria-label="Duration override minimum minutes"
                              type="number"
                              min={5}
                              max={600}
                              inputMode="numeric"
                              value={day.intent.durationOverride.minMinutes}
                              onChange={(event) =>
                                updateDay(dayIndex, (current) => ({
                                  ...current,
                                  intent: {
                                    ...current.intent,
                                    durationOverride: current.intent.durationOverride
                                      ? {
                                          ...current.intent.durationOverride,
                                          minMinutes: Math.max(5, Math.min(current.intent.durationOverride.maxMinutes, Math.trunc(numberFromInput(event.target.value, current.intent.durationOverride.minMinutes)))),
                                        }
                                      : null,
                                  },
                                }))
                              }
                            />
                            <Input
                              aria-label="Duration override maximum minutes"
                              type="number"
                              min={5}
                              max={600}
                              inputMode="numeric"
                              value={day.intent.durationOverride.maxMinutes}
                              onChange={(event) =>
                                updateDay(dayIndex, (current) => ({
                                  ...current,
                                  intent: {
                                    ...current.intent,
                                    durationOverride: current.intent.durationOverride
                                      ? {
                                          ...current.intent.durationOverride,
                                          maxMinutes: Math.max(current.intent.durationOverride.minMinutes, Math.min(600, Math.trunc(numberFromInput(event.target.value, current.intent.durationOverride.maxMinutes)))),
                                        }
                                      : null,
                                  },
                                }))
                              }
                            />
                          </div>
                        )}
                      </Field>
                    </div>
                  </details>

                  <DayWarmupEditor
                    day={day}
                    days={document.days}
                    onChange={(value) =>
                      updateDay(dayIndex, (current) =>
                        updateProgramDayWarmupOverview(current, value)
                      )
                    }
                    onItemsChange={(warmupItems) =>
                      updateDay(dayIndex, (current) => ({
                        ...current,
                        warmupItems,
                      }))
                    }
                    onApply={(targetIds, value, warmupItems) =>
                      updateDocument((current) => ({
                        ...current,
                        days: current.days.map((candidate) =>
                          targetIds.includes(candidate.lineageId)
                            ? {
                                ...candidate,
                                warmupNotes: value,
                                warmupItems: candidate.lineageId === day.lineageId
                                  ? warmupItems
                                  : warmupItems.map((item) => ({
                                      ...item,
                                      key: crypto.randomUUID(),
                                    })),
                              }
                            : candidate,
                        ),
                      }))
                    }
                  />

                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">Exercises</h3>
                        <p className="text-xs text-muted-foreground">
                          Listed in the order you will perform them.
                        </p>
                      </div>
                      <SupersetControls
                        day={day}
                        dayIndex={dayIndex}
                        pairingDayId={pairingDayId}
                        pairingSlotIds={pairingSlotIds}
                        setPairingDayId={setPairingDayId}
                        setPairingSlotIds={setPairingSlotIds}
                        updateDay={updateDay}
                      />
                    </div>
                  </div>

                  <section
                    className="space-y-3"
                    aria-label={`${day.name} exercises`}
                  >
                    <p
                      id={`program-exercise-reorder-instructions-${day.lineageId}`}
                      className="sr-only"
                    >
                      Drag the handle to reorder exercises. With a keyboard,
                      focus the handle and use the up or down arrow key.
                    </p>
                    <p className="sr-only" aria-live="polite">
                      {reorderAnnouncement}
                    </p>
                    {day.exercises.map((slot, slotIndex) => {
                      const pairing = slot.supersetKey
                        ? day.supersets.find(
                            (group) => group.key === slot.supersetKey,
                          )
                        : null;
                      const pairingMembers = pairing
                        ? day.exercises.filter(
                            (candidate) =>
                              candidate.supersetKey === pairing.key,
                          )
                        : [];
                      const pairingPosition = pairingMembers.findIndex(
                        (candidate) => candidate.lineageId === slot.lineageId,
                      );
                      const pairingLabel =
                        pairingMembers.length === 2
                          ? "Superset"
                          : `${pairingMembers.length}-exercise group`;
                      const pairingNames = pairingMembers.map(
                        (candidate) =>
                          exerciseById.get(candidate.exerciseId)?.name ??
                          "Unavailable exercise",
                      );
                      const reorderUnitId = pairing?.key ?? slot.lineageId;
                      const isMovingUnit =
                        reorderGesture?.dayLineageId === day.lineageId &&
                        reorderGesture.unitId === reorderUnitId;
                      const isMovingLead =
                        isMovingUnit && (!pairing || pairingPosition === 0);
                      const canMoveUp = day.exercises
                        .slice(0, slotIndex)
                        .some(
                          (candidate) =>
                            (candidate.supersetKey ?? candidate.lineageId) !==
                            reorderUnitId,
                        );
                      const canMoveDown = day.exercises
                        .slice(slotIndex + 1)
                        .some(
                          (candidate) =>
                            (candidate.supersetKey ?? candidate.lineageId) !==
                            reorderUnitId,
                        );
                      return (
                        <div
                          key={slot.lineageId}
                          data-program-day-lineage={day.lineageId}
                          data-program-slot-index={slotIndex}
                          data-program-slot-unit={reorderUnitId}
                          data-program-reordering={isMovingUnit ? "true" : undefined}
                          className={cn(
                            "space-y-2 transition-[background-color,box-shadow] motion-reduce:transition-none",
                            pairing && "border-l-4 border-violet-500 bg-violet-50/60 px-3 py-2 dark:bg-violet-950/20",
                            pairing && pairingPosition === 0 && "rounded-t-xl pt-3",
                            pairing && pairingPosition === pairingMembers.length - 1 && "rounded-b-xl pb-3",
                            isMovingUnit &&
                              "relative z-10 rounded-xl bg-primary/10 shadow-lg ring-2 ring-primary/70 ring-offset-2 ring-offset-background",
                          )}
                        >
                        {isMovingLead && (
                          <div
                            data-program-drop-position="true"
                            className="pointer-events-none absolute inset-x-0 -top-4 z-20 flex items-center gap-2 text-xs font-semibold text-primary"
                          >
                            <span
                              aria-hidden="true"
                              className="h-1 min-w-4 flex-1 rounded-full bg-primary shadow-sm"
                            />
                            <span className="shrink-0 rounded-full bg-primary px-2 py-1 text-primary-foreground shadow-sm">
                              Drop here
                            </span>
                          </div>
                        )}
                        {pairing && pairingPosition === 0 && (
                          <details className="rounded-lg border border-violet-300/70 bg-background/70 p-3">
                            <summary className="min-h-11 cursor-pointer font-medium">
                              {pairingLabel}: {pairingNames.join(" + ")}
                              <span className="mt-1 block text-sm font-normal text-muted-foreground">
                                Perform these in order for {pairing.plannedRounds ?? "unequal"} rounds, with {formatRestTime(pairing.restBetweenMembersSec)} between members and {formatRestTime(pairing.restBetweenRoundsSec)} after each round.
                              </span>
                            </summary>
                            {pairing.structureStatus === "legacy_unequal" && (
                              <Alert className="mt-3">
                                <CircleAlert />
                                <AlertTitle>Older group with different set counts</AlertTitle>
                                <AlertDescription>
                                  Repbook will keep each exercise&apos;s saved sets and run them in order. If you want matching rounds instead, you can make every member use the same count.
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="mt-3 min-h-11"
                                    onClick={() => {
                                      const plannedRounds = pairingMembers[0]?.sets ?? 1;
                                      updateDay(dayIndex, (current) => ({
                                        ...current,
                                        supersets: current.supersets.map((group) =>
                                          group.key === pairing.key
                                            ? { ...group, structureStatus: "canonical", plannedRounds }
                                            : group,
                                        ),
                                        exercises: current.exercises.map((member) =>
                                          member.supersetKey === pairing.key
                                            ? {
                                                ...resizeProgramSlotSets(member, plannedRounds),
                                              }
                                            : member,
                                        ),
                                      }));
                                    }}
                                  >
                                    Use {pairingMembers[0]?.sets ?? 1} rounds for every member
                                  </Button>
                                </AlertDescription>
                              </Alert>
                            )}
                            <div className="mt-3 space-y-2">
                              <p className="text-sm font-medium">Member order</p>
                              {pairingMembers.map((member, memberIndex) => (
                                <div key={member.lineageId} className="flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2">
                                  <span className="min-w-0 flex-1 truncate text-sm">
                                    {memberIndex + 1}. {exerciseById.get(member.exerciseId)?.name ?? "Unavailable exercise"}
                                  </span>
                                  <Button type="button" size="icon" variant="outline" className="size-11" aria-label={`Move group member ${memberIndex + 1} up`} disabled={memberIndex === 0} onClick={() => updateDay(dayIndex, (current) => moveProgramGroupMember(current, pairing.key, member.lineageId, -1))}><ArrowUp /></Button>
                                  <Button type="button" size="icon" variant="outline" className="size-11" aria-label={`Move group member ${memberIndex + 1} down`} disabled={memberIndex === pairingMembers.length - 1} onClick={() => updateDay(dayIndex, (current) => moveProgramGroupMember(current, pairing.key, member.lineageId, 1))}><ArrowDown /></Button>
                                </div>
                              ))}
                            </div>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              <RestTimeControl
                                id={`superset-${pairing.key}-member-rest`}
                                label="Rest between members"
                                value={pairing.restBetweenMembersSec}
                                onChange={(restBetweenMembersSec) =>
                                  updateDay(dayIndex, (current) => ({
                                    ...current,
                                    supersets: current.supersets.map((item) =>
                                      item.key === pairing.key
                                        ? { ...item, restBetweenMembersSec }
                                        : item,
                                    ),
                                  }))
                                }
                              />
                              <div className="w-full max-w-sm">
                                <RestTimeControl
                                  id={`superset-${pairing.key}-rest`}
                                  label="Rest after each round"
                                  value={pairing.restAfterRoundSec}
                                  onChange={(restAfterRoundSec) =>
                                      updateDay(dayIndex, (current) => ({
                                        ...current,
                                        supersets: current.supersets.map(
                                          (item) =>
                                            item.key === pairing.key
                                              ? {
                                                  ...item,
                                                  restBetweenRoundsSec: restAfterRoundSec,
                                                  restAfterRoundSec,
                                                }
                                              : item,
                                        ),
                                      }))
                                  }
                                />
                              </div>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-3">
                              <Button
                                type="button"
                                variant="destructive"
                                className="min-h-11"
                                onClick={() =>
                                  updateDay(dayIndex, (current) => ({
                                    ...current,
                                    supersets: current.supersets.filter(
                                      (item) => item.key !== pairing.key,
                                    ),
                                    exercises: current.exercises.map(
                                      (candidate) =>
                                        candidate.supersetKey === pairing.key
                                          ? {
                                              ...candidate,
                                              supersetKey: null,
                                              groupMemberOrderIdx: null,
                                            }
                                          : candidate,
                                    ),
                                  }))
                                }
                              >
                                <Trash2 /> Remove pairing
                              </Button>
                            </div>
                          </details>
                        )}
                        {pairingDayId === day.lineageId &&
                          slot.supersetKey == null && (
                            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 font-medium">
                              <input
                                type="checkbox"
                                className="size-5 accent-primary"
                                checked={pairingSlotIds.includes(slot.lineageId)}
                                onChange={(event) =>
                                  setPairingSlotIds((current) =>
                                    event.target.checked
                                      ? [...current, slot.lineageId]
                                      : current.filter(
                                          (lineageId) =>
                                            lineageId !== slot.lineageId,
                                        ),
                                  )
                                }
                              />
                              Select {exerciseById.get(slot.exerciseId)?.name ?? "exercise"}
                            </label>
                          )}
                        <div className="flex items-stretch gap-2">
                          <ExerciseReorderHandle
                            dayLineageId={day.lineageId}
                            descriptionId={`program-exercise-reorder-instructions-${day.lineageId}`}
                            exerciseName={exerciseById.get(slot.exerciseId)?.name ?? "exercise"}
                            reorderUnitId={reorderUnitId}
                            slotIndex={slotIndex}
                            canMoveUp={canMoveUp}
                            canMoveDown={canMoveDown}
                            onMove={(direction) =>
                              updateDay(dayIndex, (current) => ({
                                ...current,
                                exercises: moveProgramSlotUnit(
                                  current.exercises,
                                  slot.lineageId,
                                  direction,
                                ),
                              }))
                            }
                            onAnnounce={setReorderAnnouncement}
                            onDragStart={() =>
                              setReorderGesture({
                                dayLineageId: day.lineageId,
                                unitId: reorderUnitId,
                              })
                            }
                            onDragEnd={() =>
                              setReorderGesture((current) =>
                                current?.dayLineageId === day.lineageId &&
                                current.unitId === reorderUnitId
                                  ? null
                                  : current,
                              )
                            }
                          />
                          <button
                          ref={(node) => {
                            if (node)
                              slotHeadingRefs.current.set(slot.lineageId, node);
                            else slotHeadingRefs.current.delete(slot.lineageId);
                          }}
                          type="button"
                          className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-xl border bg-background p-3 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-expanded={expandedSlotId === slot.lineageId}
                          aria-controls={`editor-${slot.lineageId}`}
                          onClick={() =>
                            setExpandedSlotId((current) =>
                              current === slot.lineageId ? null : slot.lineageId,
                            )
                          }
                        >
                          <ExerciseFamilyIcon
                            family={exerciseById.get(slot.exerciseId)?.family ?? null}
                            exerciseName={exerciseById.get(slot.exerciseId)?.name ?? "Exercise"}
                            movementPattern={exerciseById.get(slot.exerciseId)?.movementPattern ?? "conditioning"}
                          />
                          <span className="min-w-0 flex-1">
                            <span
                              id={`editor-${slot.lineageId}-label`}
                              className="block truncate font-semibold"
                            >
                              {exerciseById.get(slot.exerciseId)?.name ?? "Unavailable exercise"}
                            </span>
                            <span className="block text-xs text-muted-foreground">Exercise {slotIndex + 1}</span>
                            <span className="mt-1 block text-sm text-muted-foreground">
                              {slot.sets} sets · {slot.repMin}–{slot.repMax} reps · {formatRestTime(slot.restSec)} · {displayLabel(slot.progressionRuleId)}
                            </span>
                            {isMovingLead && (
                              <span className="mt-2 inline-flex rounded-full bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground">
                                Moving
                              </span>
                            )}
                          </span>
                          <span className="text-sm font-medium text-primary">
                            {expandedSlotId === slot.lineageId ? "Close" : "Edit"}
                          </span>
                          </button>
                        </div>
                        {expandedSlotId === slot.lineageId && <div id={`editor-${slot.lineageId}`}>
                        <SlotEditor
                        day={day}
                        dayIndex={dayIndex}
                        slot={slot}
                        slotIndex={slotIndex}
                        days={document.days}
                        library={library}
                        exercise={exerciseById.get(slot.exerciseId)}
                        futureReplacementRequested={
                          futureReplacementTarget?.status === "ready" &&
                          pendingFutureReplacementRequest?.dayLineageId === day.lineageId &&
                          pendingFutureReplacementRequest.slotLineageId === slot.lineageId
                        }
                        onFutureReplacementRequestConsumed={clearFutureReplacementRequest}
                        onChange={(next) =>
                          updateDay(dayIndex, (current) =>
                            updateProgramSlotInDay(current, slotIndex, next),
                          )
                        }
                        onRemove={() => {
                          updateDay(dayIndex, (current) =>
                            removeProgramSlotFromDay(current, slot.lineageId),
                          );
                          requestAnimationFrame(() =>
                            dayHeadingRefs.current.get(day.lineageId)?.focus(),
                          );
                        }}
                        onMove={(direction) =>
                          updateDay(dayIndex, (current) => ({
                            ...current,
                            exercises: moveProgramSlotUnit(
                              current.exercises,
                              slot.lineageId,
                              direction,
                            ),
                          }))
                        }
                        onMoveToDay={(target) =>
                          moveSlotToDay(dayIndex, slotIndex, target)
                        }
                        onReplace={(exerciseId) => {
                          updateDay(dayIndex, (current) => {
                            const replacement = replaceProgramExercise(
                              current.exercises[slotIndex],
                              exerciseId,
                              crypto.randomUUID(),
                            );
                            return {
                              ...current,
                              exercises: current.exercises.map((item, index) =>
                                index === slotIndex ? replacement : item,
                              ),
                              intent: {
                                ...current.intent,
                                identity: {
                                  ...current.intent.identity,
                                  anchorSlotLineageIds:
                                    current.intent.identity.anchorSlotLineageIds.map(
                                      (lineageId) =>
                                        lineageId === slot.lineageId
                                          ? replacement.lineageId
                                          : lineageId,
                                    ),
                                },
                              },
                            };
                          });
                          if (
                            pendingFutureReplacementRequest?.dayLineageId === day.lineageId &&
                            pendingFutureReplacementRequest.slotLineageId === slot.lineageId
                          ) {
                            clearFutureReplacementRequest();
                          }
                        }}
                        labelledBy={`editor-${slot.lineageId}-label`}
                        />
                        </div>}
                        </div>
                      );
                    })}
                  </section>
                  <div className="max-w-sm">
                    <ExercisePicker
                      items={library}
                      largeTouchTargets
                      onSelect={(item) => addExercise(dayIndex, item.id)}
                      triggerLabel="Add exercise"
                      title={`Add exercise to ${day.name}`}
                    />
                  </div>
                </CardContent>
              </Card>
            ) : null)}

            <Card className="border-dashed">
              <CardHeader>
                <CardTitle>
                  <h2 className="font-semibold">Add a training day</h2>
                </CardTitle>
                <CardDescription>
                  Choose its first exercise so the new day is valid and
                  autosaves immediately.
                </CardDescription>
              </CardHeader>
              <CardContent className="max-w-sm">
                <ExercisePicker
                  items={library}
                  largeTouchTargets
                  triggerLabel="Choose first exercise"
                  title="Choose the first exercise for a new day"
                  onSelect={(item) => addDay(item.id)}
                />
              </CardContent>
            </Card>

            {!documentValidation.success && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>Finish the required fields</AlertTitle>
                <AlertDescription>
                  {documentValidation.error.issues
                    .map((issue) => issue.message)
                    .slice(0, 5)
                    .join(" ")}
                </AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Review uses saved revision {revision} and is invalidated by any
                later edit.
              </p>
              <Button
                type="button"
                className="min-h-11"
                disabled={!canReview || reviewing}
                onClick={() => void requestReview()}
              >
                {reviewing ? (
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <Check />
                )}{" "}
                Review changes
              </Button>
            </div>
    </>
  );
});
