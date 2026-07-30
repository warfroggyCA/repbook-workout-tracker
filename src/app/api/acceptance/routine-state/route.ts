import { getDb } from "@/db";
import { isDisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";
import { sensitiveJson } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { captureAcceptanceRoutineState } from "@/services/acceptance-routine-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isDisposableAcceptanceRuntime()) {
    return sensitiveJson({ reason: "Not found." }, { status: 404 });
  }
  const user = await getRouteUser();
  if (!user) return sensitiveJson({ reason: "Unauthorized." }, { status: 401 });
  const state = await captureAcceptanceRoutineState(await getDb(), user.id);
  return sensitiveJson({ status: "ok", state });
}
