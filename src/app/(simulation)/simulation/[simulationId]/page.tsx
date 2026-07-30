import { SimulationRunner } from "@/components/simulation/simulation-runner";
import { getCurrentUser } from "@/lib/user";

export default async function SimulationRunPage({
  params,
}: {
  params: Promise<{ simulationId: string }>;
}) {
  const user = await getCurrentUser();
  const { simulationId } = await params;
  return <SimulationRunner ownerId={user.id} simulationId={simulationId} />;
}
