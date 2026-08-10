import "server-only";

import type { Db } from "@/db";
import { externalAnalysisRecommendationEvidenceSchema } from "@/lib/external-analysis-import";
import { getOwnedExternalAnalysisImport } from "@/services/external-analysis-import";
import { getExternalAnalysisSourceBindingFreshness } from "@/services/external-analysis-validation";

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

  return (
    await getExternalAnalysisSourceBindingFreshness(
      db,
      userId,
      imported.digest.sourceBindings,
      imported.digest.package.sourceEvidenceRevision,
    )
  ).ok;
}
