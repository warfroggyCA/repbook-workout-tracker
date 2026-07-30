import { getDb } from "@/db";
import { sensitiveResponse } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { buildJsonBackup, recordExport } from "@/services/export";
import { runExpensiveOperation } from "@/services/expensive-operations";

export async function GET() {
  const user = await getRouteUser();
  if (!user) return sensitiveResponse("Unauthorized", { status: 401 });

  const db = await getDb();
  const controlled = await runExpensiveOperation(
    db,
    user.id,
    "backup",
    async () => {
      const backup = await buildJsonBackup(db, user.id);
      await recordExport(db, user.id, "json", { full: true });
      return backup;
    }
  );
  if (!controlled.ok) {
    return sensitiveResponse(controlled.reason, {
      status: 429,
      headers: { "Retry-After": String(controlled.retryAfterSeconds) },
    });
  }

  return sensitiveResponse(JSON.stringify(controlled.value, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="workout-tracker-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
