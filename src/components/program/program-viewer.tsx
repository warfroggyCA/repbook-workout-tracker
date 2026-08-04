"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Pencil, Play, Upload } from "lucide-react";
import { ExerciseFamilyIcon } from "@/components/exercises/exercise-family-icon";
import { ProgramDayTabs } from "@/components/program/program-day-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ProgramPresentation } from "@/lib/program-presentation";
import { formatRestTime } from "@/lib/rest-time";
import { ContextualNoteScope } from "@/components/contextual-notes/contextual-note-scope";
import type { ContextualNoteScopeValue } from "@/lib/contextual-note-ui";

function progressionLabel(rule: string) {
  return rule === "double_progression"
    ? "Double progression"
    : "Hold targets";
}

export function ProgramViewer({
  presentation,
  initialSelectedId,
  editorEnabled,
}: {
  presentation: ProgramPresentation;
  initialSelectedId: string;
  editorEnabled: boolean;
}) {
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const selectDay = useCallback((lineageId: string) => {
    setSelectedId(lineageId);
  }, []);
  const selectedIndex = Math.max(
    0,
    presentation.days.findIndex((day) => day.lineageId === selectedId),
  );
  const selected = presentation.days[selectedIndex] ?? presentation.days[0];
  const contextualNoteScope = useMemo<ContextualNoteScopeValue>(() => {
    const programAttachment = {
      key: `program:${presentation.program.id}`,
      kind: "program" as const,
      label: `Entire Program · ${presentation.program.name}`,
      programId: presentation.program.id,
      programVersionId: presentation.version.id,
    };
    const dayAttachment = {
      key: `program-day:${selected.id}`,
      kind: "program_day" as const,
      label: `Program day · ${selected.name}`,
      programId: presentation.program.id,
      programVersionId: presentation.version.id,
      workoutTemplateId: selected.id,
    };
    return {
      scopeId: `program:${presentation.version.id}:${selected.id}`,
      capturedContext: {
        schemaVersion: 1,
        destination: "program",
        workflow: `${presentation.program.name} · ${selected.name}`,
        workoutPhase: "planning",
        originatedFromSimulation: false,
        programDay: {
          programId: presentation.program.id,
          programVersionId: presentation.version.id,
          workoutTemplateId: selected.id,
          name: selected.name,
          lineageId: selected.lineageId,
        },
        plannedExercise: null,
        performedExercise: null,
        occurrence: null,
        loadRepetitions: null,
        restContext: null,
        reviewContext: {
          kind: "program_day",
          entityId: selected.id,
          label: selected.name,
        },
      },
      attachments: [
        dayAttachment,
        ...selected.slots.map((slot) => ({
          key: `program-item:${slot.id}`,
          kind: "program_item" as const,
          label: `Program item · ${slot.exercise.name}`,
          programId: presentation.program.id,
          programVersionId: presentation.version.id,
          workoutTemplateId: selected.id,
          workoutTemplateExerciseId: slot.id,
        })),
        programAttachment,
        { key: "general", kind: "general" as const, label: "General training note" },
      ],
      defaultAttachmentKey: dayAttachment.key,
    };
  }, [presentation, selected]);

  return (
    <div className="mx-auto max-w-5xl">
      <ContextualNoteScope value={contextualNoteScope} />
      <header className="mb-5 grid items-end gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,28rem),1fr))]">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Active program
          </p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 max-w-full text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-3xl">
              {presentation.program.name}
            </h1>
            <Badge className="shrink-0" variant="outline">
              v{presentation.version.versionNo}
            </Badge>
          </div>
        </div>
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))]">
          {editorEnabled && (
            <Button
              className="min-h-11 min-w-0 whitespace-normal"
              variant="outline"
              render={
                <Link href={`/program/edit?day=${selected.lineageId}`} />
              }
              nativeButton={false}
            >
              <Pencil /> Edit future Program
            </Button>
          )}
          <Button
            className="min-h-11 min-w-0 whitespace-normal"
            variant="outline"
            render={<Link href="/program/import" />}
            nativeButton={false}
          >
            <Upload /> Import routine
          </Button>
          <Button
            className="min-h-11 min-w-0 whitespace-normal"
            render={<Link href="/today" />}
            nativeButton={false}
          >
            <Play /> Train today
          </Button>
        </div>
      </header>

      <div className="mb-4">
        <ProgramDayTabs
          days={presentation.days}
          activeId={selected.lineageId}
          pathname="/program"
          label="Program days"
          onSelect={selectDay}
          compact
        />
      </div>

      <section className="overflow-hidden rounded-2xl border bg-card shadow-[var(--shadow-soft)]">
        <header className="border-b px-4 py-4 sm:px-5">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Day {selectedIndex + 1}
          </p>
          <h2 className="mt-1 text-xl font-semibold">{selected.name}</h2>
          {selected.notes && (
            <p className="mt-2 whitespace-pre-line text-sm leading-6 text-muted-foreground">
              {selected.notes}
            </p>
          )}
        </header>

        {selected.warmupLines.length > 0 && (
          <section
            aria-labelledby={`warmup-${selected.lineageId}`}
            className="border-b bg-violet-50/60 px-4 py-4 dark:bg-violet-950/20 sm:px-5"
          >
            <h3
              id={`warmup-${selected.lineageId}`}
              className="font-semibold"
            >
              Warm-up
            </h3>
            <ul className="mt-2 space-y-1 text-sm leading-6 text-muted-foreground">
              {selected.warmupLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}

        <div className="space-y-3 p-3 sm:p-4">
          {selected.slots.map((row, slotIndex) => {
            const previousGroupId =
              selected.slots[slotIndex - 1]?.supersetGroupId;
            const nextGroupId =
              selected.slots[slotIndex + 1]?.supersetGroupId;
            const startsGroup =
              row.superset && previousGroupId !== row.superset.id;
            const endsGroup =
              row.superset && nextGroupId !== row.superset.id;
            return (
              <div
                key={row.id}
                className={
                  row.superset
                    ? `border-l-4 border-violet-400 bg-violet-50/50 px-3 dark:bg-violet-950/20 ${startsGroup ? "rounded-t-lg pt-3" : ""} ${endsGroup ? "rounded-b-lg pb-3" : ""}`
                    : ""
                }
              >
                {startsGroup && row.superset && (
                  <div className="mb-2">
                    <p className="font-semibold text-violet-800 dark:text-violet-200">
                      {row.superset.name}: {row.superset.memberNames.join(" + ")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Perform grouped exercises together, then rest{" "}
                      {formatRestTime(row.superset.restAfterRoundSec)}.
                    </p>
                  </div>
                )}
                <article className="flex items-start gap-3 rounded-xl border bg-background p-3 sm:p-4">
                  <ExerciseFamilyIcon
                    family={row.exercise.family}
                    exerciseName={row.exercise.name}
                    movementPattern={row.exercise.movementPattern}
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold">{row.exercise.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      Exercise {slotIndex + 1}
                    </p>
                    <p className="mt-2 text-sm">
                      {row.prescription
                        ? `${row.prescription.sets} sets · ${row.prescription.repRangeMin}–${row.prescription.repRangeMax} reps`
                        : "No active target"}
                      {row.prescription?.targetLoad != null
                        ? ` · ${row.prescription.targetLoad} ${row.prescription.targetLoadUnit}`
                        : ""}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Rest {formatRestTime(row.restSec)} ·{" "}
                      {progressionLabel(
                        row.prescription?.progressionRuleId ?? "hold",
                      )}
                    </p>
                    {row.notes && (
                      <p className="mt-2 whitespace-pre-line text-sm leading-6 text-muted-foreground">
                        {row.notes}
                      </p>
                    )}
                  </div>
                </article>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
