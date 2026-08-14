import { randomUUID } from "node:crypto";
import Link from "next/link";
import { ArrowLeft, CalendarDays } from "lucide-react";
import { ProgramScheduleEditor, type SimpleScheduleDraft } from "@/components/program/program-schedule-editor";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db";
import type { ProgramScheduleDocument } from "@/lib/program-schedule";
import { getCurrentUser } from "@/lib/user";
import { workoutLocalDate } from "@/lib/workout-calendar";
import { getActiveProgramPresentation } from "@/services/program-presentation";
import { getProgramScheduleEditorState } from "@/services/program-schedules";

function simpleDraft(document: ProgramScheduleDocument): SimpleScheduleDraft | null {
  if (document.phases.length !== 1) return null;
  const phase = document.phases[0];
  if (
    phase.boundary.kind !== "program_week_range" ||
    phase.boundary.startWeek !== 1 ||
    (phase.schedule.kind === "rolling" && phase.schedule.lengthDays > 14)
  ) {
    return null;
  }
  const cardioEvents = phase.schedule.days
    .map((day) => day.event)
    .filter((event) => event.kind === "cardio");
  const firstCardio = cardioEvents[0] ?? null;
  if (firstCardio && cardioEvents.some((event) => JSON.stringify(event.durationMinutes) !== JSON.stringify(firstCardio.durationMinutes) || event.modality !== firstCardio.modality || event.intensity !== firstCardio.intensity || event.notes !== firstCardio.notes)) {
    return null;
  }
  return {
    phaseId: phase.id,
    phaseName: phase.name,
    startsOn: document.startsOn,
    durationWeeks: phase.boundary.endWeek,
    scheduleKind: phase.schedule.kind,
    slots: phase.schedule.days.map((day) => ({
      id: day.event.id,
      selection: day.event.kind === "resistance"
        ? `resistance:${day.event.routineLineageId}`
        : day.event.kind,
    })),
    cardio: firstCardio
      ? {
          modality: firstCardio.modality,
          minMinutes: firstCardio.durationMinutes.min,
          maxMinutes: firstCardio.durationMinutes.max,
          intensity: firstCardio.intensity ?? "",
          notes: firstCardio.notes ?? "",
        }
      : { modality: "Elliptical", minMinutes: 20, maxMinutes: 25, intensity: "RPE 3–4", notes: "" },
  };
}

export default async function ProgramSchedulePage() {
  const user = await getCurrentUser();
  const db = await getDb();
  const presentation = await getActiveProgramPresentation(db, user.id);
  if (!presentation) {
    return <main className="p-4"><p>No active Program is available.</p></main>;
  }
  const current = await getProgramScheduleEditorState(db, user.id, presentation.program.id);
  const existingDraft = current ? simpleDraft(current.version.document) : null;
  const draft = existingDraft ?? {
    phaseId: randomUUID(),
    phaseName: "Training",
    startsOn: workoutLocalDate(new Date(), user.profile.timezone),
    durationWeeks: 12,
    scheduleKind: "fixed_7_day" as const,
    slots: Array.from({ length: 7 }, (_, index) => ({
      id: randomUUID(),
      selection: index < presentation.days.length
        ? `resistance:${presentation.days[index].lineageId}`
        : "rest",
    })),
    cardio: { modality: "Elliptical", minMinutes: 20, maxMinutes: 25, intensity: "RPE 3–4", notes: "" },
  };

  return (
    <main className="p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl">
        <Button variant="ghost" render={<Link href="/program" />} nativeButton={false}><ArrowLeft /> Back to Program</Button>
        <header className="mt-3 mb-5">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{presentation.program.name}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Schedule</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Put routines, cardio, recovery, and rest in order. Repbook never automatically compresses missed lifting days.</p>
        </header>
        {current?.inUse ? (
          <section className="rounded-2xl border bg-card p-5">
            <CalendarDays className="size-5 text-primary" />
            <h2 className="mt-3 font-semibold">
              {current.nextEvent ? "This schedule is in progress" : "This schedule is complete"}
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {current.nextEvent
                ? "Its completed, skipped, moved, and started events are preserved. Use Today to complete, skip, reschedule, or shift the next event."
                : "Its workout and schedule outcomes remain preserved. No scheduled event remains."}
            </p>
            <p className="mt-3 text-sm">{current.version.document.phases.map((phase) => `${phase.name} · ${phase.schedule.kind === "rolling" ? "rolling" : "seven-day"}`).join(" · ")}</p>
            <Button className="mt-4" render={<Link href="/today" />} nativeButton={false}>Go to Today</Button>
          </section>
        ) : current && !existingDraft ? (
          <section className="rounded-2xl border bg-card p-5">
            <h2 className="font-semibold">Advanced schedule</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">This schedule has multiple phases or different cardio prescriptions. Repbook will run it exactly as saved, but the simple editor will not flatten or reinterpret it.</p>
            <ul className="mt-3 space-y-2 text-sm">{current.version.document.phases.map((phase) => <li key={phase.id}>{phase.order}. {phase.name} · {phase.schedule.kind === "rolling" ? "rolling rotation" : "seven-day schedule"}</li>)}</ul>
          </section>
        ) : (
          <ProgramScheduleEditor
            programId={presentation.program.id}
            sourceProgramVersionId={presentation.version.id}
            expectedCurrentScheduleVersionId={current?.version.id ?? null}
            routines={presentation.days.map((day) => ({ lineageId: day.lineageId, name: day.name }))}
            initial={draft}
          />
        )}
      </div>
    </main>
  );
}
