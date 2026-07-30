import { getDb } from "@/db";
import { sensitiveJson } from "@/lib/http-security";
import { maintenanceAuthorized } from "@/lib/maintenance-auth";
import { runPrivacyRetention } from "@/services/privacy-retention";

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
  const result = await runPrivacyRetention(db);
  return sensitiveJson({ ok: true, result });
}
