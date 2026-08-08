import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { programs } from "@/db/schema";
import { externalAnalysisRecommendationEvidenceSchema } from "@/lib/external-analysis-import";
import { getOwnedExternalAnalysisImport } from "@/services/external-analysis-import";

type ExternalRecommendation = {
  id: string;
  insightId?: string | null;
  source: "rule" | "ai";
  ruleId: string | null;
  payload: { kind: string };
  evidence: { externalAnalysis?: unknown };
};

export async function externalAnalysisRecommendationIsCurrent(
  db: Db,
  userId: string,
  recommendation: ExternalRecommendation,
) {
  const external = externalAnalysisRecommendationEvidenceSchema.safeParse(
    recommendation.evidence.externalAnalysis,
  );
  if (
    !external.success ||
    recommendation.source !== "ai" ||
    recommendation.ruleId !== "external_analysis" ||
    recommendation.payload.kind !== "external_review"
  ) {
    return false;
  }
  const imported = await getOwnedExternalAnalysisImport(
    db,
    userId,
    external.data.importId,
  );
  if (!imported || recommendation.insightId !== imported.row.id) return false;
  const mapped = imported.digest.recommendationMap.some(
    (item) =>
      item.proposalId === external.data.proposalId &&
      item.recommendationId === recommendation.id,
  );
  if (
    !mapped ||
    imported.digest.package.id !== external.data.packageId ||
    imported.digest.response.id !== external.data.responseId ||
    imported.digest.response.digest !== external.data.responseDigest ||
    external.data.citedEvidenceIds.some(
      (id) =>
        !imported.digest.sourceBindings.some(
          (binding) =>
            binding.ids.includes(id) ||
            (binding.revisions ?? []).some((revision) => revision.id === id),
        ),
    )
  ) {
    return false;
  }

  const programIds = imported.digest.sourceBindings.find(
    (binding) => binding.entity === "programs",
  )?.ids ?? [];
  const versionIds = imported.digest.sourceBindings.find(
    (binding) => binding.entity === "program_versions",
  )?.ids ?? [];
  const activePrograms = await db
    .select({ id: programs.id, currentVersionId: programs.currentVersionId })
    .from(programs)
    .where(
      and(
        eq(programs.userId, userId),
        eq(programs.status, "active"),
        isNull(programs.archivedAt),
      ),
    );
  if (
    activePrograms.length > 1 ||
    (activePrograms.length === 0
      ? programIds.length !== 0 || versionIds.length !== 0
      : programIds.length !== 1 ||
        versionIds.length !== 1 ||
        activePrograms[0]!.id !== programIds[0] ||
        activePrograms[0]!.currentVersionId !== versionIds[0])
  ) {
    return false;
  }

  const expected = imported.digest.sourceBindings.flatMap((binding) =>
    (binding.revisions ?? []).map((revision) => ({
      entity: binding.entity,
      id: revision.id,
      revision: revision.revision,
    })),
  );
  if (expected.length === 0) return true;
  const live = resultRows(await db.execute(sql`
    SELECT 'workout_sessions'::text AS entity, session.id::text AS id,
           session.history_revision::int AS revision
    FROM workout_sessions session
    WHERE session.user_id = ${userId}::uuid
      AND session.status IN ('completed', 'abandoned')
      AND session.archived_at IS NULL
    UNION ALL
    SELECT 'session_occurrences', occurrence.id::text, occurrence.revision::int
    FROM session_occurrences occurrence
    JOIN workout_sessions session ON session.id = occurrence.session_id
    WHERE session.user_id = ${userId}::uuid
      AND session.archived_at IS NULL
    UNION ALL
    SELECT 'contextual_notes', note.id::text, note.revision::int
    FROM contextual_notes note
    WHERE note.user_id = ${userId}::uuid
      AND note.archived_at IS NULL
    UNION ALL
    SELECT 'recommendations', recommendation.id::text,
           recommendation.review_revision::int
    FROM recommendations recommendation
    WHERE recommendation.user_id = ${userId}::uuid
      AND recommendation.archived_at IS NULL
  `)) as Array<Record<string, unknown>>;
  const current = new Map(
    live.map((row) => [
      `${String(row.entity)}:${String(row.id)}`,
      Number(row.revision),
    ]),
  );
  return expected.every(
    (item) => current.get(`${item.entity}:${item.id}`) === item.revision,
  );
}
