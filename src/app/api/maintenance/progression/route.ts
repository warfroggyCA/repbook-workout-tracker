import { getDb } from "@/db";
import { sensitiveJson } from "@/lib/http-security";
import { maintenanceAuthorized } from "@/lib/maintenance-auth";
import { drainProgressionJobs } from "@/services/progression-jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const authorization = maintenanceAuthorized(request);
  if (!authorization.ok) {
    return sensitiveJson(
      { ok: false, reason: authorization.reason },
      { status: authorization.status }
    );
  }
  const result = await drainProgressionJobs(await getDb());
  return sensitiveJson(result, { status: result.ok ? 200 : 503 });
}
