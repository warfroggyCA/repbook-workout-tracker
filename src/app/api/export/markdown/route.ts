import { getDb } from "@/db";
import { parseMarkdownExportRequest } from "@/lib/export-request";
import { sensitiveResponse } from "@/lib/http-security";
import { getRouteUser } from "@/lib/route-auth";
import { buildTrainingDigest, renderCoachingBrief } from "@/services/digest";
import { recordExport, sinceDate } from "@/services/export";
import { runExpensiveOperation } from "@/services/expensive-operations";

export async function GET(request: Request) {
  const user = await getRouteUser();
  if (!user) return sensitiveResponse("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const parsed = parseMarkdownExportRequest(url);
  if (!parsed.ok) {
    return sensitiveResponse("Invalid export request", { status: 400 });
  }
  const { weeks, download } = parsed;
  const since = sinceDate(weeks)!;

  const db = await getDb();
  const controlled = await runExpensiveOperation(
    db,
    user.id,
    "export",
    async () => {
      const digest = await buildTrainingDigest(db, user.id, since);
      const brief = renderCoachingBrief(digest);
      await recordExport(db, user.id, "markdown", { weeks });
      return { brief, reportDate: digest.range.untilLocalDate };
    }
  );
  if (!controlled.ok) {
    return sensitiveResponse(controlled.reason, {
      status: 429,
      headers: { "Retry-After": String(controlled.retryAfterSeconds) },
    });
  }

  return sensitiveResponse(controlled.value.brief, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      ...(download
        ? {
            "Content-Disposition": `attachment; filename="repbook-training-brief-${controlled.value.reportDate}.md"`,
          }
        : {}),
    },
  });
}
