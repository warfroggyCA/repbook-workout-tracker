import { getDb } from "@/db";
import {
  CSV_EXPORT_FILENAMES,
  parseCsvExportRequest,
} from "@/lib/export-request";
import { sensitiveResponse } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import {
  buildSetsCsv,
  buildPainFatigueCsv,
  buildContextualNotesCsv,
  buildActivitiesCsv,
  buildLiveCoachCsv,
  recordExport,
  sinceDate,
} from "@/services/export";
import { runExpensiveOperation } from "@/services/expensive-operations";

export async function GET(request: Request) {
  const user = await getRouteUser();
  if (!user) return sensitiveResponse("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const parsed = parseCsvExportRequest(url);
  if (!parsed.ok) {
    return sensitiveResponse("Invalid export request", { status: 400 });
  }
  const { entity, weeks } = parsed;
  const since = sinceDate(weeks);

  const db = await getDb();
  const controlled = await runExpensiveOperation(
    db,
    user.id,
    "export",
    async () => {
      const csv =
        entity === "coach"
          ? await buildLiveCoachCsv(db, user.id, since)
          : entity === "notes"
            ? await buildContextualNotesCsv(db, user.id, since)
          : entity === "activities"
            ? await buildActivitiesCsv(db, user.id, since)
            : entity === "pain"
              ? await buildPainFatigueCsv(db, user.id, since)
              : await buildSetsCsv(db, user.id, since);
      await recordExport(db, user.id, "csv", { entity, weeks });
      return csv;
    }
  );
  if (!controlled.ok) {
    return sensitiveResponse(controlled.reason, {
      status: 429,
      headers: { "Retry-After": String(controlled.retryAfterSeconds) },
    });
  }

  return sensitiveResponse(controlled.value, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${CSV_EXPORT_FILENAMES[entity]}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
