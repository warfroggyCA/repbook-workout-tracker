import { getDb } from "@/db";
import { sensitiveJson } from "@/lib/http-security";
import { maintenanceAuthorized } from "@/lib/maintenance-auth";
import {
  runSnapshotLifecycle,
  snapshotLifecycleNeedsAttention,
} from "@/services/snapshot-lifecycle";

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
  const db = await getDb();
  const result = await runSnapshotLifecycle(db);
  const needsAttention = snapshotLifecycleNeedsAttention(result);
  return sensitiveJson(
    { ok: !needsAttention, needsAttention, result },
    { status: needsAttention ? 503 : 200 }
  );
}
