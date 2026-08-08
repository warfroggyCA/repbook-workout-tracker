import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  coachingInsights,
  type AnalysisPackageSourceBinding,
  type RecommendationEvidence,
  type RecommendationPayload,
} from "@/db/schema";
import {
  externalAnalysisImportDigestSchema,
  sameExternalAnalysisSelections,
  type ExternalAnalysisImportDigest,
  type ExternalAnalysisImportRequest,
} from "@/lib/external-analysis-import";
import {
  validateExternalAnalysisResponse,
  type ExternalAnalysisResponseBinding,
} from "@/lib/external-analysis-response";
import { buildRecommendationReviewEvidence } from "@/lib/review-evidence";
import { getExternalAnalysisResponseBinding } from "@/services/external-analysis-validation";

export type ExternalAnalysisImportResult =
  | {
      ok: true;
      replay: "new" | "idempotent_duplicate";
      importId: string;
      observationCount: number;
      proposalCount: number;
    }
  | {
      ok: false;
      reason:
        | "invalid_response"
        | "invalid_selection"
        | "missing_manifest"
        | "expired_manifest"
        | "stale_program"
        | "invalid_manifest"
        | "conflict";
      message: string;
    };

export type ExternalAnalysisImportDependencies = {
  now?: Date;
  failureAt?: string;
};

function responseDigest(canonicalResponse: string) {
  return createHash("sha256").update(canonicalResponse).digest("hex");
}

function idsFor(bindings: AnalysisPackageSourceBinding[], entity: string) {
  return new Set(
    bindings.find((binding) => binding.entity === entity)?.ids ?? [],
  );
}

function bindingFromDigest(
  digest: ExternalAnalysisImportDigest,
): ExternalAnalysisResponseBinding {
  return {
    packageId: digest.package.id,
    packageNamespace: digest.package.namespace,
    schemaVersion: digest.package.schemaVersion,
    semanticVersion: digest.package.semanticVersion,
    digest: digest.package.digest,
    evidenceCutoff: digest.package.evidenceCutoff,
    expiresAt: digest.package.expiresAt,
    questionId: digest.question.id,
    questionText: digest.question.text,
    evidenceIds: digest.sourceBindings.flatMap((binding) => [
      ...binding.ids,
      ...(binding.revisions ?? []).map((revision) => revision.id),
    ]),
  };
}

export async function getOwnedExternalAnalysisImport(
  db: Db,
  userId: string,
  importId: string,
) {
  const row = await db.query.coachingInsights.findFirst({
    where: and(
      eq(coachingInsights.id, importId),
      eq(coachingInsights.userId, userId),
      eq(coachingInsights.kind, "external_analysis_import"),
      isNull(coachingInsights.archivedAt),
    ),
  });
  if (!row) return null;
  const parsed = externalAnalysisImportDigestSchema.safeParse(row.dataDigest);
  return parsed.success ? { row, digest: parsed.data } : null;
}

async function findImportByResponse(
  db: Db,
  userId: string,
  responseId: string,
) {
  const row = await db.query.coachingInsights.findFirst({
    where: and(
      eq(coachingInsights.userId, userId),
      eq(coachingInsights.kind, "external_analysis_import"),
      eq(coachingInsights.clientKey, responseId),
      isNull(coachingInsights.archivedAt),
    ),
  });
  if (!row) return null;
  const parsed = externalAnalysisImportDigestSchema.safeParse(row.dataDigest);
  return parsed.success ? { row, digest: parsed.data } : null;
}

function validateSelections(
  request: ExternalAnalysisImportRequest,
) {
  const observations = new Map(
    request.response.observations.map((item) => [item.id, item]),
  );
  const proposals = new Map(
    request.response.proposedActions.map((item) => [item.id, item]),
  );
  const selectedObservations = request.selections.observationIds.map((id) =>
    observations.get(id),
  );
  const selectedProposals = request.selections.proposalIds.map((id) =>
    proposals.get(id),
  );
  if (
    selectedObservations.some((item) => item == null) ||
    selectedProposals.some((item) => item == null)
  ) {
    return null;
  }
  return {
    observations: selectedObservations.filter(
      (item): item is NonNullable<typeof item> => item != null,
    ),
    proposals: selectedProposals.filter(
      (item): item is NonNullable<typeof item> => item != null,
    ),
  };
}

export async function importExternalAnalysisSelection(
  db: Db,
  userId: string,
  request: ExternalAnalysisImportRequest,
  dependencies: ExternalAnalysisImportDependencies = {},
): Promise<ExternalAnalysisImportResult> {
  const now = dependencies.now ?? new Date();
  const existing = await findImportByResponse(
    db,
    userId,
    request.response.responseId,
  );
  if (existing) {
    const validation = validateExternalAnalysisResponse(
      request.response,
      bindingFromDigest(existing.digest),
    );
    if (!validation.ok) {
      return {
        ok: false,
        reason: "conflict",
        message: "This response identity was already imported with different content.",
      };
    }
    const digest = responseDigest(validation.canonicalResponse);
    if (
      digest !== existing.digest.response.digest ||
      !sameExternalAnalysisSelections(existing.digest, request.selections)
    ) {
      return {
        ok: false,
        reason: "conflict",
        message: "This response identity was already imported with different content or selections.",
      };
    }
    return {
      ok: true,
      replay: "idempotent_duplicate",
      importId: existing.row.id,
      observationCount: existing.digest.observations.length,
      proposalCount: existing.digest.recommendationMap.length,
    };
  }

  const manifest = await getExternalAnalysisResponseBinding(
    db,
    userId,
    request.response.analysisPackage.packageId,
    now,
  );
  if (!manifest.ok) {
    const messages = {
      not_found: ["missing_manifest", "The matching owner-scoped package manifest was not found."],
      expired: ["expired_manifest", "The matching package manifest has expired. Prepare a new package."],
      stale_program: ["stale_program", "The current Program changed after this package was prepared."],
      invalid_manifest: ["invalid_manifest", "The retained package manifest cannot safely support import."],
    } as const;
    const [reason, message] = messages[manifest.reason];
    return { ok: false, reason, message };
  }
  const validation = validateExternalAnalysisResponse(
    request.response,
    manifest.binding,
  );
  if (!validation.ok) {
    return {
      ok: false,
      reason: "invalid_response",
      message: "The response no longer passes the closed validation contract.",
    };
  }
  const selected = validateSelections(request);
  if (!selected) {
    return {
      ok: false,
      reason: "invalid_selection",
      message: "One or more selected items are absent from the validated response.",
    };
  }

  const importId = randomUUID();
  const digest = responseDigest(validation.canonicalResponse);
  const recommendationMap = selected.proposals.map((proposal) => ({
    proposalId: proposal.id,
    recommendationId: randomUUID(),
  }));
  const importedAt = now.toISOString();
  const importDigest: ExternalAnalysisImportDigest =
    externalAnalysisImportDigestSchema.parse({
      schemaVersion: "external-analysis-import/1",
      package: {
        id: manifest.binding.packageId,
        namespace: manifest.binding.packageNamespace,
        schemaVersion: manifest.binding.schemaVersion,
        semanticVersion: manifest.binding.semanticVersion,
        digest: manifest.binding.digest,
        evidenceCutoff: manifest.binding.evidenceCutoff,
        expiresAt: manifest.binding.expiresAt,
      },
      response: {
        id: validation.response.responseId,
        schemaVersion: validation.response.schemaVersion,
        instructionVersion: validation.response.instructionVersion,
        digestAlgorithm: "sha256",
        digest,
      },
      question: validation.response.question,
      sourceBindings: manifest.sourceBindings,
      selectedObservationIds: request.selections.observationIds,
      selectedProposalIds: request.selections.proposalIds,
      observations: selected.observations,
      recommendationMap,
      importedAt,
      rawResponseRetained: false,
    });

  const sessions = idsFor(manifest.sourceBindings, "workout_sessions");
  const sets = idsFor(manifest.sourceBindings, "completed_sets");
  const pains = idsFor(manifest.sourceBindings, "pain_logs");
  const recommendationRows = selected.proposals.map((proposal, index) => {
    const payload: RecommendationPayload = {
      kind: "external_review",
      targetKind: proposal.effect.target.kind,
      requestedOutcome: proposal.effect.requestedOutcome,
    };
    const citedEvidenceIds = [...new Set([
      ...proposal.evidenceIds,
      ...proposal.effect.target.evidenceIds,
    ])];
    const evidence: RecommendationEvidence = {
      signals: {
        externalAnalysisQuestion: validation.response.question.text,
        externalTarget: proposal.effect.target.kind,
      },
      sessionIds: citedEvidenceIds.filter((id) => sessions.has(id)),
      setIds: citedEvidenceIds.filter((id) => sets.has(id)),
      painLogIds: citedEvidenceIds.filter((id) => pains.has(id)),
      review: buildRecommendationReviewEvidence({
        payload,
        producer: "external_analysis",
        sourceVersion: validation.response.schemaVersion,
        generatedAt: now,
        quality: "unverified_external",
        limitations: proposal.limitations,
      }),
      externalAnalysis: {
        schemaVersion: "external-analysis-evidence-v1",
        importId,
        packageId: manifest.binding.packageId,
        responseId: validation.response.responseId,
        responseDigest: digest,
        proposalId: proposal.id,
        citedEvidenceIds,
      },
    };
    return {
      id: recommendationMap[index]!.recommendationId,
      payload,
      reason: proposal.rationale,
      evidence,
    };
  });

  let applied = false;
  try {
    applied = resultRows(await db.execute(sql`
    WITH claimed_manifest AS (
      DELETE FROM analysis_package_manifests manifest
      WHERE manifest.id = ${manifest.binding.packageId}::uuid
        AND manifest.user_id = ${userId}::uuid
        AND manifest.digest = ${manifest.binding.digest}
        AND manifest.expires_at > ${now}
      RETURNING manifest.id
    ), imported AS (
      INSERT INTO coaching_insights (
        id, user_id, kind, content_md, data_digest, client_key,
        response_status, completed_at, created_at
      )
      SELECT
        ${importId}::uuid,
        ${userId}::uuid,
        'external_analysis_import',
        'Selected external-analysis observations and proposal provenance.',
        ${JSON.stringify(importDigest)}::jsonb,
        ${validation.response.responseId},
        'completed',
        ${now},
        ${now}
      FROM claimed_manifest
      RETURNING id
    ), imported_recommendations AS (
      INSERT INTO recommendations (
        id, user_id, status, source, rule_id, insight_id,
        payload, reason, evidence, review_revision, defer_revision, created_at
      )
      SELECT
        item.id,
        ${userId}::uuid,
        'pending',
        'ai',
        'external_analysis',
        imported.id,
        item.payload,
        item.reason,
        item.evidence,
        1,
        0,
        ${now}
      FROM imported
      CROSS JOIN jsonb_to_recordset(${JSON.stringify(recommendationRows)}::jsonb)
        AS item(id uuid, payload jsonb, reason text, evidence jsonb)
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT
        CASE
          WHEN (SELECT count(*) FROM imported) = 1
            AND (SELECT count(*) FROM imported_recommendations) = ${recommendationRows.length}::int
            AND ${dependencies.failureAt ?? null}::text IS NULL
          THEN ${userId}::uuid
          ELSE NULL::uuid
        END,
        'user',
        'external_analysis.import',
        'coaching_insight',
        imported.id::text,
        'Imported selected validated external-analysis items into Review',
        jsonb_build_object(
          'importId', imported.id,
          'packageId', ${manifest.binding.packageId}::uuid,
          'responseId', ${validation.response.responseId}::uuid,
          'observationCount', ${selected.observations.length}::int,
          'proposalCount', ${selected.proposals.length}::int
        ),
        'external-analysis-response:' || ${validation.response.responseId}::text
      FROM imported
      RETURNING id
    )
    SELECT imported.id
    FROM imported
    WHERE EXISTS (SELECT 1 FROM recorded_audit)
    `)).length === 1;
  } catch (error) {
    const concurrent = await findImportByResponse(
      db,
      userId,
      validation.response.responseId,
    );
    if (
      concurrent &&
      concurrent.digest.response.digest === digest &&
      sameExternalAnalysisSelections(concurrent.digest, request.selections)
    ) {
      return {
        ok: true,
        replay: "idempotent_duplicate",
        importId: concurrent.row.id,
        observationCount: concurrent.digest.observations.length,
        proposalCount: concurrent.digest.recommendationMap.length,
      };
    }
    throw error;
  }

  if (!applied) {
    const concurrent = await findImportByResponse(
      db,
      userId,
      validation.response.responseId,
    );
    if (
      concurrent &&
      concurrent.digest.response.digest === digest &&
      sameExternalAnalysisSelections(concurrent.digest, request.selections)
    ) {
      return {
        ok: true,
        replay: "idempotent_duplicate",
        importId: concurrent.row.id,
        observationCount: concurrent.digest.observations.length,
        proposalCount: concurrent.digest.recommendationMap.length,
      };
    }
    return {
      ok: false,
      reason: "conflict",
      message: "The response changed while it was being imported. Refresh and review it again.",
    };
  }

  return {
    ok: true,
    replay: "new",
    importId,
    observationCount: selected.observations.length,
    proposalCount: selected.proposals.length,
  };
}
