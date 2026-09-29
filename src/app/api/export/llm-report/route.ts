import { renderAiTrainingBrief } from "@/lib/ai-training-brief";
import { getActiveProgramPresentation } from "@/services/program-presentation";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { sensitiveResponse } from "@/lib/http-security";
import { buildLlmReadyTrainingReport } from "@/lib/llm-training-report";
import { getRouteUser } from "@/lib/route-auth";
import { buildTrainingDigest, renderCoachingBrief } from "@/services/digest";
import { recordExport } from "@/services/export";
import { runExpensiveOperation } from "@/services/expensive-operations";
import { buildLlmTrainingSource } from "@/services/llm-training-source";

export async function GET(request: Request) {
  const user = await getRouteUser();
  if (!user) return sensitiveResponse("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const view = url.searchParams.get("view");
  if (view != null && view !== "brief") return sensitiveResponse("Invalid report view", { status: 400 });
  const brief = view === "brief";

  try {
    const db = await getDb();
    const controlled = await runExpensiveOperation(
      db,
      user.id,
      "export",
      async () => {
        const now = new Date();
        let report: string | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const digest = await buildTrainingDigest(db, user.id, null, now);
          if (brief) {
            const program = await getActiveProgramPresentation(db, user.id);
            const finalOwner = await db.query.users.findFirst({
              where: eq(users.id, user.id),
              columns: { analysisEvidenceRevision: true },
            });
            if (!finalOwner || String(finalOwner.analysisEvidenceRevision) !== digest.reporting.evidenceRevision) {
              continue;
            }
            report = renderAiTrainingBrief(digest, program);
            break;
          }
          const retainedSource = await buildLlmTrainingSource(db, user.id, now);
          if (
            digest.reporting.evidenceRevision !==
            retainedSource.evidenceRevision
          ) {
            continue;
          }
          report = buildLlmReadyTrainingReport(
            renderCoachingBrief(digest),
            retainedSource,
          );
          break;
        }
        if (report == null) {
          throw new Error(
            "Your training records changed while the report was being prepared. Try again.",
          );
        }
        await recordExport(db, user.id, "markdown", {
          range: "all",
          purpose: brief ? "summarized_ai_training_brief" : "llm_ready_training_report",
        });
        return report;
      },
    );
    if (!controlled.ok) {
      return sensitiveResponse(controlled.reason, {
        status: 429,
        headers: { "Retry-After": String(controlled.retryAfterSeconds) },
      });
    }

    const download = new URL(request.url).searchParams.get("download") === "1";
    return sensitiveResponse(controlled.value, {
      headers: {
        "Content-Type": download ? "application/octet-stream" : "text/markdown; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(controlled.value, "utf8")),
        ...(download ? {
          "Content-Disposition": `attachment; filename="repbook-${brief ? "ai-brief" : "complete-report"}-${new Date().toISOString().slice(0, 10)}.md"`,
        } : {}),
      },
    });
  } catch {
    return sensitiveResponse("The complete report could not be prepared. Try again.", { status: 503 });
  }
}
