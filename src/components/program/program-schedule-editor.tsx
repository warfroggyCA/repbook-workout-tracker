"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { publishProgramScheduleAction } from "@/app/actions/program-schedules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type RoutineOption = { lineageId: string; name: string };
type SlotDraft = {
  id: string;
  selection: string;
};

export type SimpleScheduleDraft = {
  phaseId: string;
  phaseName: string;
  startsOn: string;
  durationWeeks: number;
  scheduleKind: "fixed_7_day" | "rolling";
  slots: SlotDraft[];
  cardio: {
    modality: string;
    minMinutes: number;
    maxMinutes: number;
    intensity: string;
    notes: string;
  };
};

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function ProgramScheduleEditor({
  programId,
  sourceProgramVersionId,
  expectedCurrentScheduleVersionId,
  routines,
  initial,
}: {
  programId: string;
  sourceProgramVersionId: string;
  expectedCurrentScheduleVersionId: string | null;
  routines: RoutineOption[];
  initial: SimpleScheduleDraft;
}) {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const [draft, setDraft] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const hasCardio = draft.slots.some((slot) => slot.selection === "cardio");

  function update(next: SimpleScheduleDraft) {
    setDraft(next);
    setError(null);
    requestId.current = crypto.randomUUID();
  }

  function setScheduleKind(kind: "fixed_7_day" | "rolling") {
    const length = kind === "fixed_7_day" ? 7 : Math.max(1, draft.slots.length);
    const slots = Array.from({ length }, (_, index) =>
      draft.slots[index] ?? { id: crypto.randomUUID(), selection: "rest" },
    );
    update({ ...draft, scheduleKind: kind, slots });
  }

  function setRollingLength(length: number) {
    const safe = Math.max(1, Math.min(14, Math.trunc(length) || 1));
    update({
      ...draft,
      slots: Array.from({ length: safe }, (_, index) =>
        draft.slots[index] ?? { id: crypto.randomUUID(), selection: "rest" },
      ),
    });
  }

  function publish() {
    setError(null);
    const scheduleDays = draft.slots.map((slot, index) => {
      const event = slot.selection.startsWith("resistance:")
        ? {
            id: slot.id,
            kind: "resistance" as const,
            routineLineageId: slot.selection.slice("resistance:".length),
          }
        : slot.selection === "cardio"
          ? {
              id: slot.id,
              kind: "cardio" as const,
              modality: draft.cardio.modality.trim(),
              durationMinutes: {
                min: draft.cardio.minMinutes,
                max: draft.cardio.maxMinutes,
              },
              ...(draft.cardio.intensity.trim()
                ? { intensity: draft.cardio.intensity.trim() }
                : {}),
              ...(draft.cardio.notes.trim()
                ? { notes: draft.cardio.notes.trim() }
                : {}),
            }
          : { id: slot.id, kind: slot.selection as "recovery" | "rest" };
      return draft.scheduleKind === "fixed_7_day"
        ? { isoWeekday: index + 1, event }
        : { position: index + 1, event };
    });
    const schedule = draft.scheduleKind === "fixed_7_day"
      ? { kind: "fixed_7_day" as const, days: scheduleDays }
      : {
          kind: "rolling" as const,
          lengthDays: draft.slots.length,
          days: scheduleDays,
        };
    const document = {
      schemaVersion: "program-schedule/1" as const,
      startsOn: draft.startsOn,
      phases: [{
        id: draft.phaseId,
        name: draft.phaseName.trim(),
        order: 1,
        boundary: {
          kind: "program_week_range" as const,
          startWeek: 1,
          endWeek: draft.durationWeeks,
        },
        schedule,
      }],
    };

    startTransition(async () => {
      const result = await publishProgramScheduleAction({
        programId,
        sourceProgramVersionId,
        expectedCurrentScheduleVersionId,
        requestId: requestId.current,
        document,
      });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      requestId.current = crypto.randomUUID();
      router.refresh();
    });
  }

  const valid =
    draft.phaseName.trim().length > 0 &&
    draft.startsOn.length === 10 &&
    draft.durationWeeks >= 1 &&
    draft.durationWeeks <= 104 &&
    draft.slots.every((slot) =>
      slot.selection === "rest" ||
      slot.selection === "recovery" ||
      slot.selection === "cardio" ||
      (slot.selection.startsWith("resistance:") && routines.some(
        (routine) => routine.lineageId === slot.selection.slice("resistance:".length),
      )),
    ) &&
    (!hasCardio || (
      draft.cardio.modality.trim().length > 0 &&
      draft.cardio.minMinutes >= 1 &&
      draft.cardio.maxMinutes >= draft.cardio.minMinutes
    ));

  return (
    <div className="space-y-5">
      <section className="grid gap-3 rounded-2xl border bg-card p-4 sm:grid-cols-3">
        <label className="text-sm font-medium">Phase name<Input className="mt-1 min-h-11" maxLength={120} value={draft.phaseName} onChange={(event) => update({ ...draft, phaseName: event.target.value })} /></label>
        <label className="text-sm font-medium">Starts on<Input className="mt-1 min-h-11" type="date" value={draft.startsOn} onChange={(event) => update({ ...draft, startsOn: event.target.value })} /></label>
        <label className="text-sm font-medium">Length in weeks<Input className="mt-1 min-h-11" type="number" inputMode="numeric" min={1} max={104} value={draft.durationWeeks} onChange={(event) => update({ ...draft, durationWeeks: Math.trunc(Number(event.target.value)) })} /></label>
      </section>

      <fieldset className="rounded-2xl border bg-card p-4">
        <legend className="px-1 font-semibold">Schedule type</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex min-h-11 items-start gap-3 rounded-xl border p-3 text-sm"><input type="radio" className="mt-0.5 size-5" checked={draft.scheduleKind === "fixed_7_day"} onChange={() => setScheduleKind("fixed_7_day")} /><span><span className="font-medium">Seven-day week</span><span className="mt-1 block text-xs text-muted-foreground">Monday through Sunday.</span></span></label>
          <label className="flex min-h-11 items-start gap-3 rounded-xl border p-3 text-sm"><input type="radio" className="mt-0.5 size-5" checked={draft.scheduleKind === "rolling"} onChange={() => setScheduleKind("rolling")} /><span><span className="font-medium">Rolling rotation</span><span className="mt-1 block text-xs text-muted-foreground">Continues across week boundaries.</span></span></label>
        </div>
        {draft.scheduleKind === "rolling" && (
          <label className="mt-3 block max-w-xs text-sm font-medium">Days in the rotation<Input className="mt-1 min-h-11" type="number" inputMode="numeric" min={1} max={14} value={draft.slots.length} onChange={(event) => setRollingLength(Number(event.target.value))} /></label>
        )}
      </fieldset>

      <section className="rounded-2xl border bg-card p-4">
        <h2 className="font-semibold">What happens each day</h2>
        <p className="mt-1 text-sm text-muted-foreground">Choose a routine, cardio, recovery, or rest. Missed days only move when you explicitly change them.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {draft.slots.map((slot, index) => (
            <label key={slot.id} className="text-sm font-medium">
              {draft.scheduleKind === "fixed_7_day" ? WEEKDAYS[index] : `Day ${index + 1}`}
              <select className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" value={slot.selection} onChange={(event) => update({ ...draft, slots: draft.slots.map((candidate) => candidate.id === slot.id ? { ...candidate, selection: event.target.value } : candidate) })}>
                {routines.map((routine) => <option key={routine.lineageId} value={`resistance:${routine.lineageId}`}>{routine.name}</option>)}
                <option value="cardio">Cardio</option>
                <option value="recovery">Recovery</option>
                <option value="rest">Rest</option>
              </select>
            </label>
          ))}
        </div>
      </section>

      {hasCardio && (
        <section className="grid gap-3 rounded-2xl border bg-card p-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><h2 className="font-semibold">Cardio prescription</h2><p className="mt-1 text-sm text-muted-foreground">Used for every cardio day in this simple schedule.</p></div>
          <label className="text-sm font-medium">Modality<Input className="mt-1 min-h-11" maxLength={120} value={draft.cardio.modality} onChange={(event) => update({ ...draft, cardio: { ...draft.cardio, modality: event.target.value } })} /></label>
          <label className="text-sm font-medium">Intensity (optional)<Input className="mt-1 min-h-11" maxLength={160} placeholder="RPE 3–4" value={draft.cardio.intensity} onChange={(event) => update({ ...draft, cardio: { ...draft.cardio, intensity: event.target.value } })} /></label>
          <label className="text-sm font-medium">Minimum minutes<Input className="mt-1 min-h-11" type="number" min={1} max={1440} value={draft.cardio.minMinutes} onChange={(event) => update({ ...draft, cardio: { ...draft.cardio, minMinutes: Math.trunc(Number(event.target.value)) } })} /></label>
          <label className="text-sm font-medium">Maximum minutes<Input className="mt-1 min-h-11" type="number" min={1} max={1440} value={draft.cardio.maxMinutes} onChange={(event) => update({ ...draft, cardio: { ...draft.cardio, maxMinutes: Math.trunc(Number(event.target.value)) } })} /></label>
          <label className="text-sm font-medium sm:col-span-2">Notes (optional)<Input className="mt-1 min-h-11" maxLength={1000} value={draft.cardio.notes} onChange={(event) => update({ ...draft, cardio: { ...draft.cardio, notes: event.target.value } })} /></label>
        </section>
      )}

      {error && <p role="alert" className="rounded-xl border border-destructive/35 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
      <Button className="min-h-12 w-full sm:w-auto" disabled={pending || !valid} onClick={publish}>
        <CalendarDays /> {pending ? "Saving schedule…" : expectedCurrentScheduleVersionId ? "Replace unused schedule" : "Save schedule"}
      </Button>
    </div>
  );
}
