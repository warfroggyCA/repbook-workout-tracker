"use client";

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { memo } from "react";
import { ExercisePicker } from "@/components/exercises/exercise-picker";
import { RestTimeControl } from "@/components/program/rest-time-control";
import { Field } from "@/components/program/editor/editor-ui";
import { LegacyWarmupEditor } from "@/components/program/editor/legacy-warmup-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import { resizeProgramSlotSets } from "@/lib/program-editor-client";
import type { ProgramDocumentDayV3, ProgramDocumentSlotV3 } from "@/lib/program-document";

function numberFromInput(value: string, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function nullableNumber(value: string) { if (!value.trim()) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function optionalText(value: string) { return value.trim() ? value : null; }

export const SlotEditor = memo(function SlotEditor({
  day,
  dayIndex,
  slot,
  slotIndex,
  days,
  library,
  exercise,
  onChange,
  onRemove,
  onMove,
  onMoveToDay,
  onReplace,
  labelledBy,
}: {
  day: ProgramDocumentDayV3;
  dayIndex: number;
  slot: ProgramDocumentSlotV3;
  slotIndex: number;
  days: ProgramDocumentDayV3[];
  library: ExerciseDiscoveryItem[];
  exercise: ExerciseDiscoveryItem | undefined;
  onChange: (slot: ProgramDocumentSlotV3) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onMoveToDay: (targetDay: number) => void;
  onReplace: (exerciseId: string) => void;
  labelledBy: string;
}) {
  const prefix = `day-${day.lineageId}-slot-${slot.lineageId}`;
  const canMoveDay = false;
  const showLegacyFields = false;
  return (
    <article
      className="rounded-xl border bg-background p-3 sm:p-4"
      aria-labelledby={labelledBy}
    >
      <div
        className="mb-3 flex flex-wrap justify-end gap-2"
        aria-label={`Reorder or remove ${exercise?.name ?? "exercise"}`}
      >
        <Button
          type="button"
          size="icon-lg"
          className="size-11"
          variant="outline"
          aria-label={`Move ${exercise?.name ?? "exercise"} up`}
          disabled={slotIndex === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          size="icon-lg"
          className="size-11"
          variant="outline"
          aria-label={`Move ${exercise?.name ?? "exercise"} down`}
          disabled={slotIndex === day.exercises.length - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown />
        </Button>
        <Button
          type="button"
          size="icon-lg"
          className="size-11"
          variant="destructive"
          aria-label={`Remove ${exercise?.name ?? "exercise"}`}
          disabled={day.exercises.length === 1}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id={`${prefix}-sets`} label="Work sets">
          <Input
            key={`${slot.lineageId}-${slot.sets}`}
            id={`${prefix}-sets`}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            defaultValue={slot.sets}
            onBlur={(event) => {
              if (!event.currentTarget.value.trim()) {
                event.currentTarget.value = String(slot.sets);
                return;
              }
              const sets = Math.min(
                20,
                Math.max(
                  1,
                  Math.trunc(numberFromInput(event.currentTarget.value, slot.sets)),
                ),
              );
              event.currentTarget.value = String(sets);
              if (sets !== slot.sets) {
                onChange(resizeProgramSlotSets(slot, sets));
              }
            }}
          />
        </Field>
        <Field id={`${prefix}-rep-min`} label="Minimum reps">
          <Input
            id={`${prefix}-rep-min`}
            type="number"
            min={1}
            max={100}
            inputMode="numeric"
            value={slot.repMin}
            onChange={(event) =>
              onChange({
                ...slot,
                repMin: Math.min(
                  100,
                  Math.max(
                    1,
                    Math.trunc(
                      numberFromInput(event.target.value, slot.repMin),
                    ),
                  ),
                ),
              })
            }
          />
        </Field>
        <Field id={`${prefix}-rep-max`} label="Maximum reps">
          <Input
            id={`${prefix}-rep-max`}
            type="number"
            min={1}
            max={100}
            inputMode="numeric"
            value={slot.repMax}
            aria-invalid={slot.repMax < slot.repMin}
            onChange={(event) =>
              onChange({
                ...slot,
                repMax: Math.min(
                  100,
                  Math.max(
                    1,
                    Math.trunc(
                      numberFromInput(event.target.value, slot.repMax),
                    ),
                  ),
                ),
              })
            }
          />
        </Field>
        <RestTimeControl
          id={`${prefix}-rest`}
          value={slot.restSec}
          onChange={(restSec) => onChange({ ...slot, restSec })}
        />
        <Field id={`${prefix}-load`} label="Target load">
          <Input
            id={`${prefix}-load`}
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={slot.targetLoad ?? ""}
            placeholder="Bodyweight / none"
            onChange={(event) => {
              const targetLoad = nullableNumber(event.target.value);
              onChange({
                ...slot,
                targetLoad,
                targetLoadUnit:
                  targetLoad == null ? null : (slot.targetLoadUnit ?? "lb"),
              });
            }}
          />
        </Field>
        <Field id={`${prefix}-unit`} label="Load unit">
          <select
            id={`${prefix}-unit`}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm disabled:opacity-50"
            disabled={slot.targetLoad == null}
            value={slot.targetLoadUnit ?? ""}
            onChange={(event) =>
              onChange({
                ...slot,
                targetLoadUnit: event.target.value === "kg" ? "kg" : "lb",
              })
            }
          >
            <option value="">No unit</option>
            <option value="lb">Pounds (lb)</option>
            <option value="kg">Kilograms (kg)</option>
          </select>
        </Field>
        <Field id={`${prefix}-rule`} label="How weight should increase">
          <select
            id={`${prefix}-rule`}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={slot.progressionRuleId}
            onChange={(event) =>
              onChange({ ...slot, progressionRuleId: event.target.value })
            }
          >
            <option value="double_progression">Build reps, then suggest more weight</option>
            <option value="hold">Keep these targets</option>
          </select>
          <p className="text-xs leading-5 text-muted-foreground">
            {slot.progressionRuleId === "double_progression"
              ? "Keep the weight while building reps. After every work set reaches the top of the range in the required clean workouts without grinding (normally two, or one with aggressive coaching), the app can suggest the next available weight."
              : "Keep the current sets, reps, and load. The app will not suggest an increase through double progression."}
          </p>
        </Field>
      </div>

      <details className="mt-4 rounded-lg border bg-muted/20 p-3">
        <summary className="min-h-11 cursor-pointer font-medium">
          Advanced session options
          <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
            Priority, minimum sets, and protected order matter only when you ask
            Repbook to build a shorter session. Your Program never changes on
            its own.
          </span>
        </summary>
        <p className="mb-3 mt-3 text-xs leading-5 text-muted-foreground">
          Repbook stores the remaining choices for planning context. It does
          not currently substitute or omit an exercise from these settings.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field id={`${prefix}-intent-role`} label="Training role (saved context)">
            <select
              id={`${prefix}-intent-role`}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={slot.intent.role}
              onChange={(event) =>
                onChange({
                  ...slot,
                  intent: {
                    ...slot.intent,
                    role: event.target
                      .value as ProgramDocumentSlotV3["intent"]["role"],
                  },
                })
              }
            >
              <option value="anchor">Anchor</option>
              <option value="support">Support</option>
              <option value="accessory">Accessory</option>
              <option value="skill">Skill</option>
              <option value="conditioning">Conditioning</option>
              <option value="recovery">Recovery</option>
            </select>
          </Field>
          <Field id={`${prefix}-intent-priority`} label="Keep in shorter sessions">
            <select
              id={`${prefix}-intent-priority`}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={slot.intent.priority}
              onChange={(event) =>
                onChange({
                  ...slot,
                  intent: {
                    ...slot.intent,
                    priority: event.target
                      .value as ProgramDocumentSlotV3["intent"]["priority"],
                  },
                })
              }
            >
              <option value="must">Must</option>
              <option value="should">Should</option>
              <option value="could">Could</option>
            </select>
          </Field>
          <Field id={`${prefix}-intent-min-dose`} label="Minimum useful sets">
            <Input
              id={`${prefix}-intent-min-dose`}
              type="number"
              min={1}
              max={slot.sets}
              inputMode="numeric"
              value={slot.intent.minimumDose.value}
              onChange={(event) => {
                const value = Math.min(
                  slot.sets,
                  Math.max(
                    1,
                    Math.trunc(
                      numberFromInput(
                        event.target.value,
                        slot.intent.minimumDose.value,
                      ),
                    ),
                  ),
                );
                onChange({
                  ...slot,
                  intent: {
                    ...slot.intent,
                    minimumDose: { unit: "sets", value },
                    idealDose: {
                      unit: "sets",
                      value: Math.max(value, slot.intent.idealDose.value),
                    },
                  },
                });
              }}
            />
          </Field>
          <Field id={`${prefix}-intent-ideal-dose`} label="Preferred sets (saved context)">
            <Input
              id={`${prefix}-intent-ideal-dose`}
              type="number"
              min={slot.sets}
              max={20}
              inputMode="numeric"
              value={slot.intent.idealDose.value}
              onChange={(event) => {
                const value = Math.max(
                  slot.sets,
                  slot.intent.minimumDose.value,
                  Math.min(
                    20,
                    Math.trunc(
                      numberFromInput(
                        event.target.value,
                        slot.intent.idealDose.value,
                      ),
                    ),
                  ),
                );
                onChange({
                  ...slot,
                  intent: {
                    ...slot.intent,
                    minimumDose: { ...slot.intent.minimumDose, unit: "sets" },
                    idealDose: { unit: "sets", value },
                  },
                });
              }}
            />
          </Field>
          <Field
            id={`${prefix}-intent-substitution`}
            label="Replacement preference (saved for later)"
          >
            <select
              id={`${prefix}-intent-substitution`}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={slot.intent.substitutionPolicy}
              onChange={(event) =>
                onChange({
                  ...slot,
                  intent: {
                    ...slot.intent,
                    substitutionPolicy: event.target
                      .value as ProgramDocumentSlotV3["intent"]["substitutionPolicy"],
                  },
                })
              }
            >
              <option value="exact_only">Exact only</option>
              <option value="approved_family">Approved family</option>
              <option value="approved_movement_pattern">
                Approved movement pattern
              </option>
              <option value="no_substitution">No substitution</option>
            </select>
          </Field>
          <Field id={`${prefix}-intent-omission`} label="Omission preference (saved for later)">
            <select
              id={`${prefix}-intent-omission`}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={slot.intent.omissionPolicy}
              onChange={(event) =>
                onChange({
                  ...slot,
                  intent: {
                    ...slot.intent,
                    omissionPolicy: event.target
                      .value as ProgramDocumentSlotV3["intent"]["omissionPolicy"],
                  },
                })
              }
            >
              <option value="never">Never omit</option>
              <option value="if_minimum_met">Only after minimum dose</option>
              <option value="allowed">May omit</option>
            </select>
          </Field>
          <label className="flex min-h-11 items-center gap-2 rounded-lg border bg-background px-3 text-sm">
            <input
              type="checkbox"
              checked={slot.intent.protectedOrder}
              onChange={(event) =>
                onChange({
                  ...slot,
                  intent: { ...slot.intent, protectedOrder: event.target.checked },
                })
              }
            />
            Keep this exercise in place
          </label>
          <label className="flex min-h-11 items-center gap-2 rounded-lg border bg-background px-3 text-sm">
            <input
              type="checkbox"
              checked={slot.intent.calibrationEligible}
              onChange={(event) =>
                onChange({
                  ...slot,
                  intent: {
                    ...slot.intent,
                    calibrationEligible: event.target.checked,
                  },
                })
              }
            />
            Saved for later fine-tuning
          </label>
        </div>
        <div className="mt-3">
          <Field id={`${prefix}-intent-note`} label="Planning note (optional)">
            <Textarea
              id={`${prefix}-intent-note`}
              value={slot.intent.note ?? ""}
              onChange={(event) =>
                onChange({
                  ...slot,
                  intent: {
                    ...slot.intent,
                    note: optionalText(event.target.value),
                  },
                })
              }
            />
          </Field>
        </div>
      </details>

      {canMoveDay && (
        <div className="mt-3 max-w-sm">
          <Field id={`${prefix}-move-day`} label="Move to another day">
            <select
              id={`${prefix}-move-day`}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value=""
              onChange={(event) =>
                event.target.value && onMoveToDay(Number(event.target.value))
              }
            >
              <option value="">Choose a day…</option>
              {days.map((candidate, index) =>
                index === dayIndex ? null : (
                  <option key={candidate.lineageId} value={index}>
                    {candidate.name}
                  </option>
                ),
              )}
            </select>
          </Field>
        </div>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Field id={`${prefix}-notes`} label="Exercise notes">
          <Textarea
            id={`${prefix}-notes`}
            value={slot.notes ?? ""}
            onChange={(event) =>
              onChange({ ...slot, notes: optionalText(event.target.value) })
            }
            placeholder="Technique, tempo, or setup cues"
          />
        </Field>
        {showLegacyFields && <Field id={`${prefix}-warmup-notes`} label="Warm-up notes">
          <Textarea
            id={`${prefix}-warmup-notes`}
            value={slot.warmupNotes ?? ""}
            onChange={(event) =>
              onChange({
                ...slot,
                warmupNotes: optionalText(event.target.value),
              })
            }
            placeholder="General preparation before ramp-up sets"
          />
        </Field>}
      </div>

      {showLegacyFields && <LegacyWarmupEditor slot={slot} onChange={onChange} />}

      <div className="mt-4 max-w-sm">
        <ExercisePicker
          items={library}
          largeTouchTargets
          selectedId={slot.exerciseId}
          triggerLabel="Replace exercise"
          title="Replace this exercise"
          description="The replacement starts fresh progress tracking. Earlier workouts remain unchanged."
          confirmLabel="Replace exercise"
          onSelect={(item) => onReplace(item.id)}
        />
      </div>
    </article>
  );
});
