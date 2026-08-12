"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createSimulationWorkspace,
  simulationDayEquipmentFitBlockers,
  type SimulationSourceSnapshot,
  type SimulationWorkspace,
} from "@/lib/workout-simulation";
import {
  canCreateSimulationWorkspace,
  listSimulationWorkspaces,
  resetSimulationWorkspace,
  writeSimulationWorkspace,
} from "@/lib/workout-simulation-storage";

export function SimulationLauncher({
  source,
}: {
  source: SimulationSourceSnapshot;
}) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<SimulationWorkspace[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setWorkspaces(listSimulationWorkspaces(localStorage, source.ownerId));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [source.ownerId]);

  function start(dayIndex: number) {
    setError(null);
    if (!canCreateSimulationWorkspace(localStorage, source.ownerId)) {
      setError("Reset an older simulation before starting another one.");
      return;
    }
    const workspace = createSimulationWorkspace(source);
    const prepared = { ...workspace, selectedDayIndex: dayIndex };
    const result = writeSimulationWorkspace(localStorage, prepared);
    if (!result.ok) {
      setError("The simulation could not be retained on this device.");
      return;
    }
    router.push(`/simulation/${prepared.simulationId}`);
  }

  function reset(workspace: SimulationWorkspace) {
    if (!window.confirm(`Reset the local simulation for ${workspace.source.program.name}?`)) {
      return;
    }
    const result = resetSimulationWorkspace(
      localStorage,
      source.ownerId,
      workspace.simulationId,
    );
    if (!result.ok) {
      setError("That local simulation could not be reset.");
      return;
    }
    setWorkspaces((current) =>
      current.filter((item) => item.simulationId !== workspace.simulationId),
    );
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300">
          Simulation lab
        </p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">
          Rehearse {source.program.name}
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Version {source.program.versionNo} was copied into a private,
          device-local practice workspace. Simulated sets are not workout
          records and cannot advance Today.
        </p>
      </header>

      {error && (
        <p role="alert" className="rounded-xl border border-destructive/50 bg-destructive/10 p-3 text-sm">
          {error}
        </p>
      )}

      {workspaces.length > 0 && (
        <section aria-labelledby="resume-simulations" className="space-y-3">
          <h2 id="resume-simulations" className="text-lg font-semibold">
            Resume local simulation
          </h2>
          {workspaces.map((workspace) => (
            <article key={workspace.simulationId} className="rounded-2xl border bg-card p-4">
              <p className="font-medium">
                {workspace.activeWorkout?.dayName ??
                  workspace.source.days[workspace.selectedDayIndex]?.name ??
                  "Simulation"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {workspace.completedWorkouts.length} simulated workout
                {workspace.completedWorkouts.length === 1 ? "" : "s"} finished · updated{" "}
                {new Date(workspace.updatedAtISO).toLocaleString()}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="touch"
                  render={<Link href={`/simulation/${workspace.simulationId}`} />}
                  nativeButton={false}
                >
                  <Play aria-hidden="true" /> Resume simulation
                </Button>
                <Button size="touch" variant="outline" onClick={() => reset(workspace)}>
                  <RotateCcw aria-hidden="true" /> Reset local copy
                </Button>
              </div>
            </article>
          ))}
        </section>
      )}

      <section aria-labelledby="choose-simulation-day" className="space-y-3">
        <h2 id="choose-simulation-day" className="text-lg font-semibold">
          Start a new simulation
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {source.days.map((day, index) => {
            const fitBlockers = simulationDayEquipmentFitBlockers(day);
            return (
            <article key={day.id} className="rounded-2xl border bg-card p-4 shadow-sm">
              <FlaskConical aria-hidden="true" className="size-5 text-amber-700 dark:text-amber-300" />
              <h3 className="mt-2 font-semibold">{day.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {day.exercises.length} exercises · {day.warmups.length} day warm-up step
                {day.warmups.length === 1 ? "" : "s"}
              </p>
              {fitBlockers.length > 0 && (
                <p role="status" className="mt-3 rounded-lg border border-amber-600/50 bg-amber-50 p-2 text-sm dark:bg-amber-950/30">
                  Equipment review required for {fitBlockers[0].name}: {fitBlockers[0].equipmentFit.reason}
                </p>
              )}
              <Button
                className="mt-4 w-full"
                size="touch"
                variant="outline"
                disabled={fitBlockers.length > 0}
                onClick={() => start(index)}
              >
                Start {day.name} simulation
              </Button>
            </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
