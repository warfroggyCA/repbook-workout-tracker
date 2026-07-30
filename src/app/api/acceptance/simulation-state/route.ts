import { getDb } from "@/db";
import { isStage6DisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";
import { sensitiveJson } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { captureSimulationMutationState } from "@/services/simulation-mutation-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isStage6DisposableAcceptanceRuntime()) {
    return sensitiveJson({ reason: "Not found." }, { status: 404 });
  }
  const user = await getRouteUser();
  if (!user) return sensitiveJson({ reason: "Unauthorized." }, { status: 401 });
  const state = await captureSimulationMutationState(await getDb(), user.id);
  return sensitiveJson({ status: "ok", state });
}
