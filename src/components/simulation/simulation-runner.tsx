"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FilePenLine, RotateCcw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExerciseReferenceMedia } from "@/components/exercises/exercise-reference-media";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  addSimulationFeedback,
  advanceSimulationRest,
  completeSimulationOccurrence,
  completeSimulationSet,
  continueSimulationRest,
  correctSimulationSet,
  finishSimulationWorkout,
  flagSimulationPain,
  noteSimulationExercise,
  noteSimulationOccurrence,
  restoreSimulationOccurrence,
  selectSimulationEquipment,
  skipSimulationOccurrence,
  skipSimulationRest,
  startSimulationWorkout,
  substituteSimulationExercise,
  undoSimulationSubstitution,
  type SimulationWorkspace,
} from "@/lib/workout-simulation";
import {
  readSimulationWorkspace,
  resetSimulationWorkspace,
  updateStoredSimulationWorkspace,
} from "@/lib/workout-simulation-storage";
import {
  buildSimulationExportDownload,
  downloadSimulationExport,
  SIMULATION_EXPORT_LABEL,
} from "@/components/simulation/simulation-export";
import {
  createContextualNoteSimulationTransfer,
  writeContextualNoteSimulationTransfer,
} from "@/lib/contextual-note-simulation-transfer";

export function SimulationRunner({
  ownerId,
  simulationId,
}: {
  ownerId: string;
  simulationId: string;
}) {
  const [workspace, setWorkspace] = useState<SimulationWorkspace | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "missing" | "ready">("loading");
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [reps, setReps] = useState("8");
  const [load, setLoad] = useState("");
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState("");
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const result = readSimulationWorkspace(localStorage, ownerId, simulationId);
      setWorkspace(result.workspace);
      setLoadState(result.workspace ? "ready" : "missing");
      setOnline(navigator.onLine);
    }, 0);
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, [ownerId, simulationId]);

  const workout = workspace?.activeWorkout ?? null;
  const current = workout?.occurrences.find((item) => item.outcome === "pending") ?? null;
  const currentExercise = current?.simulationExerciseId
    ? workout?.exercises.find((item) => item.id === current.simulationExerciseId) ?? null
    : null;
  const resolved = workout?.occurrences.filter((item) => item.outcome !== "pending").length ?? 0;
  const performed = workout?.occurrences.filter(
    (item) => item.kind === "working_set" && item.outcome === "completed" && item.completedSetId,
  ).length ?? 0;
  const skipped = workout?.occurrences.filter((item) => item.outcome === "skipped") ?? [];
  const upcoming = workout?.occurrences.find(
    (item) => item.outcome === "pending" && item.id !== current?.id,
  ) ?? null;
  const upcomingExercise = upcoming?.simulationExerciseId
    ? workout?.exercises.find((item) => item.id === upcoming.simulationExerciseId) ?? null
    : null;
  const equipment = useMemo(
    () =>
      currentExercise?.equipmentOptions.find(
        (item) => item.key === currentExercise.selectedEquipmentKey,
      ) ?? currentExercise?.equipmentOptions[0] ?? null,
    [currentExercise],
  );

  const commit = useCallback((transform: (value: SimulationWorkspace) => SimulationWorkspace) => {
    if (!workspace) return false;
    setError(null);
    const result = updateStoredSimulationWorkspace(
      localStorage,
      ownerId,
      simulationId,
      workspace.revision,
      transform,
    );
    if (!result.ok) {
      setError(
        result.reason === "stale"
          ? "This simulation changed in another tab. Reload before continuing."
          : "That simulation step was not retained, so the rehearsal did not advance.",
      );
      return false;
    }
    setWorkspace(result.workspace);
    return true;
  }, [ownerId, simulationId, workspace]);

  function leaveWithRealNote(content: string, sourceLabel: string) {
    const reviewed = content.trim();
    if (!reviewed) return;
    const confirmed = window.confirm(
      "Leave Simulation and review this text in the real training-note composer? Nothing becomes a real record until you confirm it there.",
    );
    if (!confirmed) return;
    try {
      writeContextualNoteSimulationTransfer(
        window.sessionStorage,
        createContextualNoteSimulationTransfer({
          content: reviewed,
          simulationId,
          sourceLabel,
          capturedAtISO: new Date().toISOString(),
        }),
      );
      window.location.assign("/today?contextualNote=simulation");
    } catch {
      setError(
        "This text could not be handed to the real note composer. It remains in Simulation and was not saved as a real record.",
      );
    }
  }

  useEffect(() => {
    const rest = workspace?.activeWorkout?.rest;
    if (!rest || rest.phase !== "running") return;
    const update = () => {
      const elapsedSeconds = Math.max(
        0,
        Math.floor((Date.now() - Date.parse(rest.updatedAtISO)) / 1_000),
      );
      setClockMs(Date.now());
      if (elapsedSeconds >= rest.remainingSeconds) {
        commit((value) =>
          advanceSimulationRest(
            value,
            rest.remainingSeconds,
            new Date().toISOString(),
          ),
        );
      }
    };
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [commit, workspace?.activeWorkout?.rest]);

  function start(dayIndex: number) {
    commit((value) => startSimulationWorkout(value, dayIndex));
  }

  function completeCurrent() {
    if (!current || !workspace) return;
    const now = new Date().toISOString();
    if (current.kind !== "working_set") {
      commit((value) => completeSimulationOccurrence(value, current.id, now));
      return;
    }
    const parsedReps = Number.parseInt(reps, 10);
    const parsedLoad = load.trim() ? Number(load) : current.plannedLoad;
    if (!Number.isFinite(parsedReps) || parsedReps < 0) {
      setError("Enter a valid simulated rep count.");
      return;
    }
    const retained = commit((value) =>
      completeSimulationSet(
        value,
        current.id,
        {
          reps: parsedReps,
          load: parsedLoad != null && Number.isFinite(parsedLoad) ? parsedLoad : null,
          loadUnit:
            parsedLoad != null && Number.isFinite(parsedLoad)
              ? current.plannedLoadUnit ?? workspace.source.unit
              : null,
          rpe: null,
          note: note.trim() || null,
        },
        { nowISO: now },
      ),
    );
    if (retained) setNote("");
  }

  function reset() {
    if (!workspace || !window.confirm("Reset this local simulation? No real workout data is affected.")) return;
    const result = resetSimulationWorkspace(localStorage, ownerId, simulationId);
    if (!result.ok) {
      setError("The local simulation could not be reset.");
      return;
    }
    setWorkspace(null);
    setLoadState("missing");
  }

  if (loadState === "loading") {
    return <main className="mx-auto max-w-3xl p-6"><p>Loading local simulation…</p></main>;
  }
  if (!workspace || loadState === "missing") {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-2xl font-semibold">Simulation unavailable</h1>
        <p className="mt-2 text-muted-foreground">
          This device-local rehearsal is missing, expired, malformed, or belongs to another account.
        </p>
        <Button className="mt-4" render={<Link href="/simulation" />} nativeButton={false}>
          Return to simulation lab
        </Button>
      </main>
    );
  }

  if (!workout) {
    const nextDay = workspace.source.days[workspace.selectedDayIndex];
    const exportDownload = buildSimulationExportDownload(workspace);
    return (
      <main className="mx-auto flex min-w-0 max-w-3xl flex-col gap-5 overflow-x-clip p-4 sm:p-6">
        <header>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300">
            {SIMULATION_EXPORT_LABEL}
          </p>
          <h1 className="mt-1 text-2xl font-semibold">
            {workspace.completedWorkouts.length > 0 ? "Simulated workout complete" : "Simulation ready"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {workspace.completedWorkouts.length} local rehearsal
            {workspace.completedWorkouts.length === 1 ? "" : "s"} finished. Today and History are unchanged.
          </p>
        </header>
        {error && <p role="alert" className="rounded-xl border border-destructive/50 p-3">{error}</p>}
        {nextDay && (
          <section className="rounded-2xl border bg-card p-5">
            <h2 className="font-semibold">Next simulated Program day</h2>
            <p className="mt-1 text-sm text-muted-foreground">{nextDay.name}</p>
            <Button className="mt-4" onClick={() => start(workspace.selectedDayIndex)}>
              Start {nextDay.name} simulation
            </Button>
          </section>
        )}
        <section className="rounded-2xl border bg-card p-5">
          <h2 className="font-semibold">Simulation artefact</h2>
          <p className="mt-1 text-sm text-muted-foreground">{SIMULATION_EXPORT_LABEL}</p>
          <dl className="mt-3 grid gap-1 text-sm">
            <div><dt className="inline font-medium">Filename: </dt><dd className="inline break-all">{exportDownload.preview.filename}</dd></div>
            <div><dt className="inline font-medium">Completed rehearsals: </dt><dd className="inline">{exportDownload.preview.completedWorkoutCount}</dd></div>
            <div><dt className="inline font-medium">Local feedback entries: </dt><dd className="inline">{exportDownload.preview.feedbackCount}</dd></div>
          </dl>
          <Button className="mt-3 h-auto max-w-full whitespace-normal" variant="outline" onClick={() => downloadSimulationExport(workspace)}>
            <Download aria-hidden="true" /> Download labelled simulation JSON
          </Button>
        </section>
        <div className="flex flex-wrap gap-2">
          <Button className="h-auto max-w-full whitespace-normal" variant="outline" render={<Link href="/simulation" />} nativeButton={false}>Exit or choose another simulation</Button>
          <Button className="h-auto max-w-full whitespace-normal" variant="destructive" onClick={reset}><RotateCcw aria-hidden="true" /> Reset this simulation</Button>
        </div>
      </main>
    );
  }

  const displayedRestSeconds = workout.rest?.phase === "running"
    ? Math.max(
        0,
        workout.rest.remainingSeconds -
          Math.max(
            0,
            Math.floor((clockMs - Date.parse(workout.rest.updatedAtISO)) / 1_000),
          ),
      )
    : workout.rest?.remainingSeconds ?? 0;

  return (
    <main className="mx-auto flex min-w-0 max-w-3xl flex-col gap-4 overflow-x-clip p-4 pb-28 sm:p-6 sm:pb-28">
      {!online && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-amber-600 bg-amber-100 p-3 text-sm dark:bg-amber-950">
          <WifiOff aria-hidden="true" /> Offline — this loaded simulation remains local to this device.
        </div>
      )}
      {error && <p role="alert" className="rounded-xl border border-destructive/50 bg-destructive/10 p-3 text-sm">{error}</p>}
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300">Simulation — not a workout record</p>
        <h1 className="mt-1 text-2xl font-semibold">{workout.dayName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {resolved}/{workout.occurrences.length} steps resolved · {performed} working sets performed locally
        </p>
      </header>

      {workout.rest && (
        <section aria-label="Simulated rest" className="rounded-2xl border border-sky-500/50 bg-sky-50 p-4 dark:bg-sky-950/20">
          <h2 className="font-semibold">Simulated rest · {displayedRestSeconds === 0 && workout.rest.phase === "running" ? "ready" : workout.rest.phase}</h2>
          <p className="mt-1 text-sm">{displayedRestSeconds}s remaining of {workout.rest.plannedSeconds}s planned</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {workout.rest.phase === "running" && <Button variant="outline" onClick={() => commit((value) => advanceSimulationRest(value, workout.rest!.remainingSeconds, new Date().toISOString()))}>Advance rest</Button>}
            {workout.rest.phase === "running" && <Button variant="outline" onClick={() => commit((value) => skipSimulationRest(value, new Date().toISOString()))}>Skip rest</Button>}
            {workout.rest.phase !== "running" && <Button onClick={() => commit((value) => continueSimulationRest(value, new Date().toISOString()))}>Continue</Button>}
          </div>
        </section>
      )}

      {current ? (
        <section aria-labelledby="current-simulation-step" className="rounded-2xl border bg-card p-4 shadow-sm sm:p-5">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Current simulated step</p>
          <h2 id="current-simulation-step" className="mt-1 text-xl font-semibold">
            {current.kind === "day_warmup" ? current.label ?? "Day warm-up" : current.kind === "exercise_warmup" ? current.label ?? `${currentExercise?.actualName ?? "Exercise"} warm-up` : `${currentExercise?.actualName ?? "Exercise"} · set ${current.kindOrdinal + 1}`}
          </h2>
          {current.groupRound && <p className="mt-1 text-sm text-muted-foreground">Group round {current.groupRound} · member {(current.groupMemberOrderIdx ?? 0) + 1}</p>}
          {currentExercise?.painGuidance.map((line) => <p key={line} className="mt-2 rounded-lg bg-amber-50 p-2 text-sm dark:bg-amber-950/30">Simulation guidance: {line}</p>)}
          {equipment && <p className="mt-2 rounded-lg bg-muted p-3 text-sm"><span className="font-medium">Prepare:</span> {equipment.label}{equipment.guidance ? ` · ${equipment.guidance}` : ""}</p>}
          {currentExercise?.media && (
            <details className="mt-3 rounded-xl border p-3">
              <summary className="cursor-pointer font-medium">Reviewed reference media</summary>
              <div className="mt-3">
                <ExerciseReferenceMedia media={currentExercise.media} exerciseName={currentExercise.actualName} />
              </div>
            </details>
          )}

          <div className="mt-3 rounded-xl border border-dashed p-3 text-sm">
            <p className="font-medium">Planned target</p>
            <p className="text-muted-foreground">
              {current.plannedRepsMin == null
                ? "No rep target"
                : current.plannedRepsMax != null && current.plannedRepsMax !== current.plannedRepsMin
                  ? `${current.plannedRepsMin}–${current.plannedRepsMax} reps`
                  : `${current.plannedRepsMin} reps`}
              {current.plannedLoad == null ? " · load is flexible" : ` · ${current.plannedLoad} ${current.plannedLoadUnit}`}
            </p>
            {current.plannedNote && <p className="mt-1 text-muted-foreground">Planned note: {current.plannedNote}</p>}
          </div>

          {current.kind === "working_set" && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium">Simulated reps<Input className="mt-1" inputMode="numeric" value={reps} onChange={(event) => setReps(event.target.value)} /></label>
              <label className="text-sm font-medium">Simulated load ({current.plannedLoadUnit ?? workspace.source.unit})<Input className="mt-1" inputMode="decimal" placeholder={current.plannedLoad?.toString() ?? "Optional"} value={load} onChange={(event) => setLoad(event.target.value)} /></label>
              <label className="text-sm font-medium sm:col-span-2">Set note — simulation only<Textarea className="mt-1" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /></label>
            </div>
          )}

          {currentExercise && (
            <details className="mt-4 rounded-xl border p-3">
              <summary className="cursor-pointer font-medium">Simulation choices</summary>
              <div className="mt-3 grid gap-3">
                {currentExercise.equipmentOptions.length > 1 && <label className="text-sm font-medium">Equipment<select className="mt-1 min-h-11 w-full rounded-lg border bg-background px-3" value={currentExercise.selectedEquipmentKey ?? ""} onChange={(event) => commit((value) => selectSimulationEquipment(value, currentExercise.id, event.target.value, new Date().toISOString()))}>{currentExercise.equipmentOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>}
                {currentExercise.substitutionReason ? <Button variant="outline" onClick={() => commit((value) => undoSimulationSubstitution(value, currentExercise.id, new Date().toISOString()))}>Undo simulated substitution</Button> : currentExercise.alternatives.length > 0 && <label className="text-sm font-medium">Substitute locally<select defaultValue="" className="mt-1 min-h-11 w-full rounded-lg border bg-background px-3" onChange={(event) => event.target.value && commit((value) => substituteSimulationExercise(value, currentExercise.id, event.target.value, "variety", new Date().toISOString()))}><option value="">Choose an alternative</option>{currentExercise.alternatives.map((option) => <option key={option.exerciseId} value={option.exerciseId}>{option.name}</option>)}</select></label>}
              </div>
            </details>
          )}

          <form
            key={`notes:${current.id}`}
            className="mt-4 grid gap-3 rounded-xl border p-3"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <p className="font-medium">Local rehearsal notes</p>
            <label className="text-sm font-medium">
              This step only
              <Textarea name="occurrenceNote" className="mt-1" maxLength={500} defaultValue={current.outcomeNote ?? ""} />
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={(event) => {
                const form = event.currentTarget.closest("form");
                if (!form) return;
                const value = String(new FormData(form).get("occurrenceNote") ?? "").trim();
                if (value) {
                  commit((state) =>
                    noteSimulationOccurrence(state, current.id, value, new Date().toISOString()),
                  );
                }
              }}
            >
              Save simulated step note
            </Button>
            {current.outcomeNote && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  leaveWithRealNote(
                    current.outcomeNote ?? "",
                    `${workout.dayName} · ${current.label ?? `simulated set ${current.kindOrdinal + 1}`}`,
                  )
                }
              >
                <FilePenLine aria-hidden="true" /> Review as real training note
              </Button>
            )}
            {currentExercise && (
              <>
                <label className="text-sm font-medium">
                  This simulated exercise
                  <Textarea name="exerciseNote" className="mt-1" maxLength={500} defaultValue={currentExercise.note ?? ""} />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  onClick={(event) => {
                    const form = event.currentTarget.closest("form");
                    if (!form) return;
                    const value = String(new FormData(form).get("exerciseNote") ?? "");
                    commit((state) =>
                      noteSimulationExercise(
                        state,
                        currentExercise.id,
                        value,
                        new Date().toISOString(),
                      ),
                    );
                  }}
                >
                  Save simulated exercise note
                </Button>
                {currentExercise.note && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      leaveWithRealNote(
                        currentExercise.note ?? "",
                        `${workout.dayName} · simulated ${currentExercise.actualName}`,
                      )
                    }
                  >
                    <FilePenLine aria-hidden="true" /> Review as real training note
                  </Button>
                )}
              </>
            )}
          </form>

          {currentExercise && (
            <form
              key={`pain:${currentExercise.id}:${current.id}`}
              className="mt-4 grid gap-3 rounded-xl border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                commit((state) =>
                  flagSimulationPain(
                    state,
                    currentExercise.id,
                    String(data.get("bodyPart") ?? ""),
                    Number(data.get("severity")),
                    new Date().toISOString(),
                  ),
                );
              }}
            >
              <p className="font-medium">Simulated pain scenario — not a health record</p>
              <label className="text-sm font-medium">Body area<Input name="bodyPart" className="mt-1" defaultValue="elbow" maxLength={100} required /></label>
              <label className="text-sm font-medium">Severity (1–5)<Input name="severity" className="mt-1" type="number" min={1} max={5} defaultValue={3} required /></label>
              <Button type="submit" variant="outline">Add simulated pain flag</Button>
            </form>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={Boolean(workout.rest)} onClick={completeCurrent}>{current.kind === "working_set" ? "Log simulated set" : "Complete simulated warm-up"}</Button>
            <Button disabled={Boolean(workout.rest)} variant="outline" onClick={() => commit((value) => skipSimulationOccurrence(value, current.id, "simulation_scenario", "Skipped in rehearsal only", new Date().toISOString()))}>Skip this simulated step</Button>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border bg-card p-5">
          <h2 className="font-semibold">All simulated steps resolved</h2>
          <p className="mt-1 text-sm text-muted-foreground">Finishing creates only a local rehearsal summary.</p>
          <Button className="mt-4" onClick={() => commit((value) => finishSimulationWorkout(value, new Date().toISOString()))}>Finish simulated workout</Button>
        </section>
      )}

      {upcoming && (
        <section aria-label="Upcoming simulated preparation" className="rounded-2xl border bg-card p-4">
          <h2 className="font-semibold">Up next</h2>
          <p className="mt-1 text-sm">
            {upcoming.kind === "working_set"
              ? `${upcomingExercise?.actualName ?? "Exercise"} · set ${upcoming.kindOrdinal + 1}`
              : upcoming.label ?? "Warm-up"}
          </p>
          {upcomingExercise && (() => {
            const option = upcomingExercise.equipmentOptions.find(
              (item) => item.key === upcomingExercise.selectedEquipmentKey,
            ) ?? upcomingExercise.equipmentOptions[0];
            return option ? <p className="mt-2 text-sm text-muted-foreground">Prepare: {option.label}{option.guidance ? ` · ${option.guidance}` : ""}</p> : null;
          })()}
        </section>
      )}

      {skipped.length > 0 && <section className="rounded-2xl border bg-card p-4"><h2 className="font-semibold">Skipped simulation steps</h2><div className="mt-2 space-y-2">{skipped.map((item) => <Button key={item.id} variant="outline" size="sm" onClick={() => commit((value) => restoreSimulationOccurrence(value, item.id, new Date().toISOString()))}>Restore {item.label ?? `set ${item.kindOrdinal + 1}`}</Button>)}</div></section>}

      <section className="rounded-2xl border bg-card p-4">
        <h2 className="font-semibold">Simulation feedback</h2>
        <p className="mt-1 text-sm text-muted-foreground">Stored only inside this local rehearsal. It is not sent to Coach.</p>
        <Textarea className="mt-3" maxLength={500} value={feedback} onChange={(event) => setFeedback(event.target.value)} aria-label="Simulation feedback note" />
        <Button className="mt-2" variant="outline" disabled={!feedback.trim()} onClick={() => { const text = feedback.trim(); const retained = commit((value) => addSimulationFeedback(value, { contextKind: current ? "occurrence" : "screen", contextKey: current?.id ?? workout.id, screenLabel: workout.dayName, note: text })); if (retained) setFeedback(""); }}>Save local feedback</Button>
      </section>

      {workout.sets.length > 0 && <details className="rounded-2xl border bg-card p-4"><summary className="cursor-pointer font-semibold">Correct latest simulated set</summary><p className="mt-2 text-sm text-muted-foreground">Correction remains local and increments only this simulated result.</p><Button className="mt-3" variant="outline" onClick={() => { const latest = workout.sets.at(-1)!; commit((value) => correctSimulationSet(value, latest.id, { reps: latest.reps + 1 }, new Date().toISOString())); }}>Add one rep to latest simulated set</Button></details>}

      <div className="flex flex-wrap gap-2"><Button variant="outline" render={<Link href="/simulation" />} nativeButton={false}>Exit and resume later</Button><Button variant="destructive" onClick={reset}><RotateCcw aria-hidden="true" /> Reset simulation</Button></div>
    </main>
  );
}
