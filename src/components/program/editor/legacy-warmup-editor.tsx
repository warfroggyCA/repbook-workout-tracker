"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Field } from "@/components/program/editor/editor-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { moveItem, setWarmupLoadPercent, setWarmupLoadText, setWarmupNumericLoad } from "@/lib/program-editor-client";
import type { ProgramDocumentSlotV3 } from "@/lib/program-document";

function nullableNumber(value: string) { if (!value.trim()) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function optionalText(value: string) { return value.trim() ? value : null; }

export function LegacyWarmupEditor({ slot, onChange }: { slot: ProgramDocumentSlotV3; onChange: (slot: ProgramDocumentSlotV3) => void }) {
  const [warmupKeys, setWarmupKeys] = useState(() => slot.warmupSets.map(() => crypto.randomUUID()));
  const warmupLabelRefs = useRef(new Map<string, HTMLInputElement>());
  const warmupAddRef = useRef<HTMLButtonElement>(null);
  const renderedWarmupKeys = slot.warmupSets.map((_, index) => warmupKeys[index] ?? slot.lineageId + "-warmup-" + index);
  const prefix = "slot-" + slot.lineageId;
  return <>
<details className="mt-4 rounded-lg border bg-muted/20 p-3">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium">
          Work-set cues ({slot.setNotes.length})
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {slot.setNotes.map((note, index) => (
            <Field
              key={index}
              id={`${prefix}-set-note-${index}`}
              label={`Set ${index + 1} cue`}
            >
              <Input
                id={`${prefix}-set-note-${index}`}
                value={note ?? ""}
                onChange={(event) => {
                  const next = [...slot.setNotes];
                  next[index] = optionalText(event.target.value);
                  onChange({ ...slot, setNotes: next });
                }}
              />
            </Field>
          ))}
        </div>
      </details>

      <details className="mt-3 rounded-lg border bg-muted/20 p-3">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium">
          Warm-up sets ({slot.warmupSets.length})
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Use one load style per warm-up: a numeric load, a percentage, or a
            written description. Entering one clears the other load styles.
          </p>
          {slot.warmupSets.map((warmup, index) => {
            const warmupPrefix = `${prefix}-warmup-${index}`;
            const warmupKey = renderedWarmupKeys[index];
            return (
              <div
                key={warmupKey}
                className="rounded-lg border bg-background p-3"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h4 className="font-medium">Warm-up {index + 1}</h4>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="icon-lg"
                      className="size-11"
                      variant="outline"
                      aria-label={`Move warm-up ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => {
                        setWarmupKeys(
                          moveItem(renderedWarmupKeys, index, index - 1),
                        );
                        onChange({
                          ...slot,
                          warmupSets: moveItem(
                            slot.warmupSets,
                            index,
                            index - 1,
                          ),
                        });
                      }}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      size="icon-lg"
                      className="size-11"
                      variant="outline"
                      aria-label={`Move warm-up ${index + 1} down`}
                      disabled={index === slot.warmupSets.length - 1}
                      onClick={() => {
                        setWarmupKeys(
                          moveItem(renderedWarmupKeys, index, index + 1),
                        );
                        onChange({
                          ...slot,
                          warmupSets: moveItem(
                            slot.warmupSets,
                            index,
                            index + 1,
                          ),
                        });
                      }}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      size="icon-lg"
                      className="size-11"
                      variant="destructive"
                      aria-label={`Remove warm-up ${index + 1}`}
                      onClick={() => {
                        const nextFocusKey =
                          renderedWarmupKeys[index + 1] ??
                          renderedWarmupKeys[index - 1] ??
                          null;
                        setWarmupKeys(
                          renderedWarmupKeys.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        );
                        onChange({
                          ...slot,
                          warmupSets: slot.warmupSets.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        });
                        requestAnimationFrame(() => {
                          if (nextFocusKey) {
                            warmupLabelRefs.current.get(nextFocusKey)?.focus();
                          } else {
                            warmupAddRef.current?.focus();
                          }
                        });
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field id={`${warmupPrefix}-label`} label="Label">
                    <Input
                      ref={(node) => {
                        if (node) warmupLabelRefs.current.set(warmupKey, node);
                        else warmupLabelRefs.current.delete(warmupKey);
                      }}
                      id={`${warmupPrefix}-label`}
                      value={warmup.label}
                      onChange={(event) =>
                        onChange({
                          ...slot,
                          warmupSets: slot.warmupSets.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, label: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field id={`${warmupPrefix}-reps`} label="Reps">
                    <Input
                      id={`${warmupPrefix}-reps`}
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={warmup.reps ?? ""}
                      onChange={(event) =>
                        onChange({
                          ...slot,
                          warmupSets: slot.warmupSets.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  reps: nullableNumber(event.target.value),
                                }
                              : item,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field id={`${warmupPrefix}-load`} label="Load">
                    <Input
                      id={`${warmupPrefix}-load`}
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      value={warmup.load ?? ""}
                      onChange={(event) => {
                        const load = nullableNumber(event.target.value);
                        onChange({
                          ...slot,
                          warmupSets: slot.warmupSets.map((item, itemIndex) =>
                            itemIndex === index
                              ? setWarmupNumericLoad(item, load)
                              : item,
                          ),
                        });
                      }}
                    />
                  </Field>
                  <Field id={`${warmupPrefix}-unit`} label="Unit">
                    <select
                      id={`${warmupPrefix}-unit`}
                      className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm disabled:opacity-50"
                      disabled={warmup.load == null}
                      value={warmup.loadUnit ?? ""}
                      onChange={(event) =>
                        onChange({
                          ...slot,
                          warmupSets: slot.warmupSets.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...setWarmupNumericLoad(item, item.load),
                                  loadUnit:
                                    event.target.value === "kg" ? "kg" : "lb",
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      <option value="">No unit</option>
                      <option value="lb">lb</option>
                      <option value="kg">kg</option>
                    </select>
                  </Field>
                  <Field id={`${warmupPrefix}-percent`} label="Percent">
                    <Input
                      id={`${warmupPrefix}-percent`}
                      type="number"
                      min={0}
                      max={500}
                      step="any"
                      inputMode="decimal"
                      value={warmup.loadPercent ?? ""}
                      onChange={(event) =>
                        onChange({
                          ...slot,
                          warmupSets: slot.warmupSets.map((item, itemIndex) =>
                            itemIndex === index
                              ? setWarmupLoadPercent(
                                  item,
                                  nullableNumber(event.target.value),
                                )
                              : item,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field id={`${warmupPrefix}-text`} label="Load description">
                    <Input
                      id={`${warmupPrefix}-text`}
                      value={warmup.loadText ?? ""}
                      placeholder="Empty bar, light band…"
                      onChange={(event) =>
                        onChange({
                          ...slot,
                          warmupSets: slot.warmupSets.map((item, itemIndex) =>
                            itemIndex === index
                              ? setWarmupLoadText(
                                  item,
                                  optionalText(event.target.value),
                                )
                              : item,
                          ),
                        })
                      }
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field id={`${warmupPrefix}-notes`} label="Notes">
                      <Input
                        id={`${warmupPrefix}-notes`}
                        value={warmup.notes ?? ""}
                        onChange={(event) =>
                          onChange({
                            ...slot,
                            warmupSets: slot.warmupSets.map(
                              (item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      notes: optionalText(event.target.value),
                                    }
                                  : item,
                            ),
                          })
                        }
                      />
                    </Field>
                  </div>
                </div>
              </div>
            );
          })}
          <Button
            ref={warmupAddRef}
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setWarmupKeys([...renderedWarmupKeys, crypto.randomUUID()]);
              onChange({
                ...slot,
                warmupSets: [
                  ...slot.warmupSets,
                  {
                    label: `Warm-up ${slot.warmupSets.length + 1}`,
                    reps: null,
                    load: null,
                    loadUnit: null,
                    loadPercent: null,
                    loadText: null,
                    notes: null,
                  },
                ],
              });
            }}
          >
            <Plus /> Add warm-up set
          </Button>
        </div>
      </details>
  </>;
}
