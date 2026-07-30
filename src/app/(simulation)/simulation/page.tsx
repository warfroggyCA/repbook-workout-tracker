import Link from "next/link";
import { SimulationLauncher } from "@/components/simulation/simulation-launcher";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/user";
import { loadWorkoutSimulationSource } from "@/services/workout-simulation-source";

export default async function SimulationPage() {
  const user = await getCurrentUser();
  const source = await loadWorkoutSimulationSource(await getDb(), user.id);

  if (!source) {
    return (
      <main className="mx-auto max-w-3xl p-4 sm:p-6">
        <h1 className="text-2xl font-semibold">Simulation needs a Program</h1>
        <p className="mt-2 text-muted-foreground">
          Publish an active Program before creating a private local rehearsal.
        </p>
        <Button className="mt-4" render={<Link href="/program" />} nativeButton={false}>
          Return to Program
        </Button>
      </main>
    );
  }

  return <SimulationLauncher source={source} />;
}
