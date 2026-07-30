"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  parseRoutineText,
  confirmImport,
  discardImport,
  type RoutineParseResponse,
} from "@/app/actions/import";
import type { RepSpec } from "@/ai/tasks/routine-parse/schema";
import { Button } from "@/components/ui/button";
import { ExercisePicker } from "@/components/exercises/exercise-picker";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { exerciseDiscoveryItemFromLibrary } from "@/lib/exercise-discovery";
import { AlertTriangle, ClipboardPaste, X } from "lucide-react";
import {
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
} from "@/lib/program-document";

type ParseOk = Extract<RoutineParseResponse, { ok: true }>;

/** Editable state for one parsed exercise row of the review table. */
type Row = {
  rawName: string;
  exerciseId: string | null;
  sets: number | null;
  repMin: number | null;
  repMax: number | null;
  load: number | null;
  restSec: number | null;
  supersetKey: string | null;
  notes: string | null;
  discarded: boolean;
};

type DayState = { name: string; rows: Row[] };

function repSpecToMinMax(spec: RepSpec | null): {
  min: number | null;
  max: number | null;
} {
  if (!spec) return { min: null, max: null };
  if (spec.kind === "range") return { min: spec.min, max: spec.max };
  return { min: Math.min(...spec.perSet), max: Math.max(...spec.perSet) };
}

function initialDays(parsed: ParseOk): DayState[] {
  const mappingByRaw = new Map(parsed.mappings.map((m) => [m.rawName, m]));
  return parsed.envelope.data.days.map((day) => ({
    name: day.name,
    rows: day.exercises.map((ex) => {
      const reps = repSpecToMinMax(ex.reps);
      const setsFromPerSet =
        ex.sets == null && ex.reps?.kind === "perSet"
          ? ex.reps.perSet.length
          : ex.sets;
      return {
        rawName: ex.rawName,
        exerciseId: mappingByRaw.get(ex.rawName)?.exerciseId ?? null,
        sets: setsFromPerSet,
        repMin: reps.min,
        repMax: reps.max,
        load: ex.load,
        restSec: ex.restSec,
        supersetKey: ex.supersetKey,
        notes: ex.notes,
        discarded: false,
      };
    }),
  }));
}

const MATCH_BADGE: Record<string, { label: string; className: string }> = {
  exact: { label: "✓ exact", className: "text-green-700 dark:text-green-400 border-green-600/40" },
  alias: { label: "✓ alias", className: "text-green-700 dark:text-green-400 border-green-600/40" },
  fuzzy: { label: "~ fuzzy", className: "text-amber-700 dark:text-amber-400 border-amber-600/40" },
  none: { label: "? unmapped", className: "text-destructive border-destructive/40" },
};

export function RoutineImport({
  aiAvailable,
  initialParse = null,
}: {
  aiAvailable: boolean;
  /** A staged ImportEvent (status "parsed") to resume reviewing. */
  initialParse?: ParseOk | null;
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [parsed, setParsed] = useState<ParseOk | null>(initialParse);
  const [programName, setProgramName] = useState(() =>
    initialParse ? (initialParse.envelope.data.programName ?? "Imported routine") : ""
  );
  const [days, setDays] = useState<DayState[]>(() =>
    initialParse ? initialDays(initialParse) : []
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const libraryById = useMemo(
    () => new Map((parsed?.library ?? []).map((e) => [e.id, e])),
    [parsed]
  );
  const mappingByRaw = useMemo(
    () => new Map((parsed?.mappings ?? []).map((m) => [m.rawName, m])),
    [parsed]
  );
  const discoveryLibrary = useMemo(
    () =>
      (parsed?.library ?? []).map((exercise) =>
        exerciseDiscoveryItemFromLibrary(exercise, {
          media: exercise.media ?? null,
        })
      ),
    [parsed]
  );

  function handleParse() {
    setError(null);
    startTransition(async () => {
      const result = await parseRoutineText(input);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setParsed(result);
      setProgramName(result.envelope.data.programName ?? "Imported routine");
      setDays(initialDays(result));
    });
  }

  function handleDiscard() {
    const id = parsed?.importEventId;
    setParsed(null);
    setDays([]);
    setError(null);
    if (id) startTransition(async () => void (await discardImport(id)));
  }

  function updateRow(dayIdx: number, rowIdx: number, patch: Partial<Row>) {
    setDays((ds) =>
      ds.map((d, di) =>
        di === dayIdx
          ? {
              ...d,
              rows: d.rows.map((r, ri) => (ri === rowIdx ? { ...r, ...patch } : r)),
            }
          : d
      )
    );
  }

  // Per-row blockers (plan §5): unmapped and equipment-illegal rows block
  // confirmation; so do unresolved sets/reps. The server re-checks all of it.
  function rowBlockers(row: Row): string[] {
    if (row.discarded) return [];
    const blockers: string[] = [];
    if (!row.exerciseId) blockers.push("unmapped");
    else {
      const ex = libraryById.get(row.exerciseId);
      if (ex && !ex.available)
        blockers.push(ex.unavailableReason ?? "unavailable");
    }
    if (row.sets == null || row.sets < 1) blockers.push("sets?");
    if (row.repMin == null || row.repMax == null || row.repMax < row.repMin)
      blockers.push("reps?");
    if (row.restSec == null) blockers.push("rest?");
    return blockers;
  }

  const keptRows = days.flatMap((d) => d.rows.filter((r) => !r.discarded));
  const blockerCount = days
    .flatMap((d) => d.rows)
    .reduce((n, r) => n + (rowBlockers(r).length > 0 ? 1 : 0), 0);
  const canConfirm =
    !pending &&
    programName.trim().length > 0 &&
    keptRows.length > 0 &&
    blockerCount === 0;

  function handleConfirm() {
    if (!parsed) return;
    setError(null);
    startTransition(async () => {
      const result = await confirmImport({
        importEventId: parsed.importEventId,
        programName: programName.trim(),
        days: days
          .map((d) => ({
            name: d.name.trim() || "Day",
            exercises: d.rows
              .filter((r) => !r.discarded)
              .map((r) => ({
                exerciseId: r.exerciseId!,
                sets: r.sets!,
                repMin: r.repMin!,
                repMax: r.repMax!,
                load: r.load,
                restSec: r.restSec!,
                supersetKey: r.supersetKey?.trim() || null,
                notes: r.notes?.trim() || null,
              })),
          }))
          .filter((d) => d.exercises.length > 0),
      });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      router.push("/program");
      router.refresh();
    });
  }

  if (!parsed) {
    return (
      <div className="rounded-xl border p-3">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          <ClipboardPaste className="size-3.5" /> Paste your routine
        </p>
        <Textarea
          placeholder={"e.g.\nDay 1 — Push\nBench press 3x8 @ 135 lb, rest 2 min\nDB shoulder press 3x8-10\n…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={8}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Text from a notes app, spreadsheet, or a Hevy/Strong screen. You&apos;ll
          review every exercise before anything is saved.
        </p>
        {!aiAvailable && (
          <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            AI parsing isn&apos;t configured on this deployment, so paste import is
            unavailable.
          </p>
        )}
        {error && (
          <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {error}
          </p>
        )}
        <Button
          size="sm"
          className="mt-2"
          disabled={pending || !input.trim() || !aiAvailable}
          onClick={handleParse}
        >
          {pending ? "Parsing…" : "Parse routine"}
        </Button>
      </div>
    );
  }

  const { envelope } = parsed;
  const intentPreview = days.map((day) => {
    const kept = day.rows.filter((row) => !row.discarded);
    return {
      day,
      kept,
      intent: createSuggestedDayIntent(
        kept.map((row, index) => ({
          lineageId: `preview-${index}`,
          sets: row.sets ?? 1,
          restSec: row.restSec ?? 90,
        })),
      ),
    };
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-primary/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">Review before saving</p>
          <Badge variant="outline">
            confidence {Math.round(envelope.confidence * 100)}%
          </Badge>
        </div>

        {(envelope.ambiguities.length > 0 ||
          envelope.clarifyingQuestions.length > 0) && (
          <ul className="mb-2 flex flex-col gap-1 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {envelope.ambiguities.map((a, i) => (
              <li key={`a${i}`}>
                {a.issue}
                {a.options?.length ? ` (${a.options.join(" / ")})` : ""}
              </li>
            ))}
            {envelope.clarifyingQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        )}

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Program name
          <Input
            value={programName}
            onChange={(e) => setProgramName(e.target.value)}
            className="text-sm"
          />
        </label>
      </div>

      <section className="rounded-xl border p-3" aria-labelledby="import-intent-review">
        <h2 id="import-intent-review" className="text-sm font-medium">Structured training intent to publish</h2>
        <p className="mt-1 text-xs text-muted-foreground">These are small structured suggestions, not history-derived facts. Confirming publishes them with this Program; edit the routine first if they do not fit.</p>
        <div className="mt-2 space-y-2">
          {intentPreview.filter(({ kept }) => kept.length > 0).map(({ day, kept, intent }) => (
            <div key={day.name} className="rounded-lg bg-muted/40 p-2 text-xs">
              <p className="font-medium">{day.name || "Day"}: strength · anchor-led identity · target {intent.targetDuration.minMinutes}–{intent.targetDuration.maxMinutes} min · minimum useful {intent.minimumUsefulDurationMinutes} min</p>
              <ul className="mt-1 text-muted-foreground">
                {kept.map((row, index) => {
                  const slotIntent = createSuggestedSlotIntent(row.sets ?? 1, index);
                  return <li key={`${row.rawName}-${index}`}>{row.rawName}: {slotIntent.role} · {slotIntent.priority} · minimum {slotIntent.minimumDose.value} sets · ideal {slotIntent.idealDose.value} · {slotIntent.substitutionPolicy.replaceAll("_", " ")} · omission {slotIntent.omissionPolicy.replaceAll("_", " ")}</li>;
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {days.map((day, dayIdx) => (
        <section key={dayIdx} className="rounded-xl border p-3">
          <Input
            value={day.name}
            onChange={(e) =>
              setDays((ds) =>
                ds.map((d, i) => (i === dayIdx ? { ...d, name: e.target.value } : d))
              )
            }
            className="mb-2 font-medium"
            aria-label={`Day ${dayIdx + 1} name`}
          />
          <div className="flex flex-col gap-2">
            {day.rows.map((row, rowIdx) => {
              const mapping = mappingByRaw.get(row.rawName);
              const chosen = row.exerciseId ? libraryById.get(row.exerciseId) : null;
              const matchType =
                row.exerciseId == null
                  ? "none"
                  : row.exerciseId === mapping?.exerciseId
                    ? (mapping?.matchType ?? "fuzzy")
                    : "fuzzy";
              const badge = MATCH_BADGE[matchType];
              const blockers = rowBlockers(row);
              return (
                <div
                  key={rowIdx}
                  className={cn(
                    "rounded-md border p-2 text-sm",
                    row.discarded && "opacity-40",
                    !row.discarded && blockers.length > 0 && "border-destructive/50"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 font-medium">
                        {row.rawName}
                        <Badge
                          variant="outline"
                          className={cn("text-[0.6875rem]", badge.className)}
                        >
                          {badge.label}
                        </Badge>
                        {row.supersetKey && (
                          <Badge variant="outline">
                            SS {row.supersetKey}
                          </Badge>
                        )}
                      </p>

                      {!row.discarded && (
                        <>
                          {(mapping?.candidates.length ?? 0) > 0 && (
                            <select
                              className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-xs"
                              value={row.exerciseId ?? ""}
                              onChange={(e) =>
                                updateRow(dayIdx, rowIdx, {
                                  exerciseId: e.target.value || null,
                                })
                              }
                            >
                              <option value="">Choose a suggested match…</option>
                              {chosen &&
                                !mapping!.candidates.some(
                                  (candidate) => candidate.id === chosen.id
                                ) && (
                                  <option value={chosen.id}>{chosen.name}</option>
                                )}
                              {mapping!.candidates.map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                  {candidate.name}
                                  {candidate.why ? ` — ${candidate.why}` : ""}
                                </option>
                              ))}
                            </select>
                          )}
                          <div className="mt-1.5">
                            <ExercisePicker
                              items={discoveryLibrary}
                              selectedId={row.exerciseId}
                              triggerLabel={chosen ? `Change ${chosen.name}` : "Browse exercise library"}
                              title={`Match “${row.rawName}”`}
                              description="Choose the exact family variant. Unavailable choices remain visible so the equipment or constraint gap is clear."
                              confirmLabel="Use this match"
                              onSelect={(exercise) =>
                                updateRow(dayIdx, rowIdx, { exerciseId: exercise.id })
                              }
                            />
                          </div>

                          {chosen && !chosen.available && (
                            <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                              <AlertTriangle className="size-3" />
                              {chosen.name}: {chosen.unavailableReason ?? "not available"}.
                              Substitute or remove.
                            </p>
                          )}

                          <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                            <label className="flex flex-col text-[0.625rem] text-muted-foreground">
                              sets
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={1}
                                value={row.sets ?? ""}
                                onChange={(e) =>
                                  updateRow(dayIdx, rowIdx, {
                                    sets: e.target.value ? Number(e.target.value) : null,
                                  })
                                }
                                className="h-7 px-1.5 text-xs"
                              />
                            </label>
                            <label className="flex flex-col text-[0.625rem] text-muted-foreground">
                              reps
                              <span className="flex items-center gap-0.5">
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  min={1}
                                  value={row.repMin ?? ""}
                                  onChange={(e) =>
                                    updateRow(dayIdx, rowIdx, {
                                      repMin: e.target.value ? Number(e.target.value) : null,
                                    })
                                  }
                                  className="h-7 px-1.5 text-xs"
                                  aria-label="rep min"
                                />
                                –
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  min={1}
                                  value={row.repMax ?? ""}
                                  onChange={(e) =>
                                    updateRow(dayIdx, rowIdx, {
                                      repMax: e.target.value ? Number(e.target.value) : null,
                                    })
                                  }
                                  className="h-7 px-1.5 text-xs"
                                  aria-label="rep max"
                                />
                              </span>
                            </label>
                            <label className="flex flex-col text-[0.625rem] text-muted-foreground">
                              load
                              <Input
                                type="number"
                                inputMode="decimal"
                                min={0}
                                value={row.load ?? ""}
                                placeholder="—"
                                onChange={(e) =>
                                  updateRow(dayIdx, rowIdx, {
                                    load: e.target.value ? Number(e.target.value) : null,
                                  })
                                }
                                className="h-7 px-1.5 text-xs"
                              />
                            </label>
                            <label className="flex flex-col text-[0.625rem] text-muted-foreground">
                              rest (s)
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                value={row.restSec ?? ""}
                                onChange={(e) =>
                                  updateRow(dayIdx, rowIdx, {
                                    restSec: e.target.value ? Number(e.target.value) : null,
                                  })
                                }
                                className="h-7 px-1.5 text-xs"
                              />
                            </label>
                          </div>

                          {blockers.length > 0 && (
                            <p className="mt-1 text-[0.625rem] text-destructive">
                              blocking: {blockers.join(" · ")}
                            </p>
                          )}
                          {row.notes && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              “{row.notes}”
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={row.discarded ? "Keep exercise" : "Discard exercise"}
                      onClick={() =>
                        updateRow(dayIdx, rowIdx, { discarded: !row.discarded })
                      }
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {envelope.unparsed.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Couldn&apos;t place: {envelope.unparsed.join(" · ")}
        </p>
      )}
      {error && (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 pb-4 sm:flex-row">
        <Button
          className="h-auto min-h-8 flex-1 whitespace-normal py-2 text-center leading-tight"
          disabled={!canConfirm}
          onClick={handleConfirm}
        >
          {pending
            ? "Saving…"
            : blockerCount > 0
              ? `Resolve ${blockerCount} row${blockerCount > 1 ? "s" : ""} to continue`
              : "Confirm intent & activate program"}
        </Button>
        <Button variant="outline" disabled={pending} onClick={handleDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );
}
