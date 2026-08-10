import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { analysisPackageManifests, programs } from "@/db/schema";
import {
  ANALYSIS_PACKAGE_SCHEMA_VERSION,
  ANALYSIS_PACKAGE_SEMANTIC_VERSION,
  ANALYSIS_QUESTIONS,
  analysisPackageRetainedSourceBindingsSchema,
  analysisQuestionSchema,
  analysisWindowDaysSchema,
} from "@/lib/analysis-package";
import type { AnalysisPackageSourceBinding } from "@/db/schema";
import type { ExternalAnalysisResponseBinding } from "@/lib/external-analysis-response";
import {
  analysisPackageOwnerNamespace,
  loadAnalysisEvidenceRevision,
  loadAnalysisSourceBindingState,
} from "@/services/analysis-package";

const manifestScopeSchema = z
  .object({
    questionId: analysisQuestionSchema,
    windowDays: analysisWindowDaysSchema,
    windowStart: z.string().datetime(),
    evidenceCutoff: z.string().datetime(),
    timezone: z.string().min(1),
    sourceEvidenceRevision: z.string().regex(/^\d+$/),
  })
  .strict();

export type ExternalAnalysisManifestLookup =
  | {
      ok: true;
      binding: ExternalAnalysisResponseBinding;
      sourceBindings: AnalysisPackageSourceBinding[];
      sourceVersionTokens: Array<{
        entity: string;
        id: string;
        token: string;
      }>;
      sourceEvidenceRevision: string;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "expired"
        | "stale_program"
        | "stale_evidence"
        | "invalid_manifest";
    };

function idsFor(
  bindings: z.infer<typeof analysisPackageRetainedSourceBindingsSchema>,
  entity: string,
): string[] {
  return bindings.find((binding) => binding.entity === entity)?.ids ?? [];
}

export type ExternalAnalysisSourceBindingFreshness =
  | { ok: true }
  | {
      ok: false;
      reason: "stale_program" | "stale_evidence" | "invalid_manifest";
    };

export async function getExternalAnalysisSourceBindingFreshness(
  db: Db,
  userId: string,
  bindings: unknown,
  expectedSourceEvidenceRevision: string,
): Promise<ExternalAnalysisSourceBindingFreshness> {
  const parsed = analysisPackageRetainedSourceBindingsSchema.safeParse(bindings);
  if (!parsed.success) return { ok: false, reason: "invalid_manifest" };

  const boundProgramIds = idsFor(parsed.data, "programs");
  const boundVersionIds = idsFor(parsed.data, "program_versions");
  if (boundProgramIds.length > 1 || boundVersionIds.length > 1) {
    return { ok: false, reason: "invalid_manifest" };
  }
  const currentPrograms = await db
    .select({ id: programs.id, currentVersionId: programs.currentVersionId })
    .from(programs)
    .where(
      and(
        eq(programs.userId, userId),
        eq(programs.status, "active"),
        isNull(programs.archivedAt),
      ),
    );
  const current = currentPrograms[0];
  const programIsCurrent = current
    ? boundProgramIds[0] === current.id &&
      boundVersionIds[0] === current.currentVersionId
    : boundProgramIds.length === 0 && boundVersionIds.length === 0;
  if (currentPrograms.length > 1 || !programIsCurrent) {
    return { ok: false, reason: "stale_program" };
  }
  const currentSourceEvidenceRevision =
    await loadAnalysisEvidenceRevision(db, userId);
  if (currentSourceEvidenceRevision !== expectedSourceEvidenceRevision) {
    return { ok: false, reason: "stale_evidence" };
  }

  const live = await loadAnalysisSourceBindingState(db, parsed.data);
  const liveById = new Map(
    live.map((item) => [`${item.entity}:${item.id}`, item]),
  );
  return parsed.data.every((binding) => {
    const retainedVersions = new Map(
      (binding.versionTokens ?? []).map((item) => [item.id, item.token]),
    );
    return binding.contentHashes.every((retained) => {
      const currentSource = liveById.get(`${binding.entity}:${retained.id}`);
      return (
        currentSource?.contentHash === retained.hash &&
        (binding.versionTokens == null ||
          currentSource.versionToken === retainedVersions.get(retained.id))
      );
    });
  })
    ? { ok: true }
    : { ok: false, reason: "stale_evidence" };
}

export async function getExternalAnalysisResponseBinding(
  db: Db,
  userId: string,
  packageId: string,
  now = new Date(),
): Promise<ExternalAnalysisManifestLookup> {
  const manifest = await db.query.analysisPackageManifests.findFirst({
    where: and(
      eq(analysisPackageManifests.id, packageId),
      eq(analysisPackageManifests.userId, userId),
    ),
  });
  if (!manifest) return { ok: false, reason: "not_found" };
  if (manifest.expiresAt <= now) return { ok: false, reason: "expired" };

  const scope = manifestScopeSchema.safeParse(manifest.scope);
  const sourceBindings = analysisPackageRetainedSourceBindingsSchema.safeParse(
    manifest.sourceBindings,
  );
  if (
    !scope.success ||
    !sourceBindings.success ||
    sourceBindings.data.some((binding) => binding.versionTokens == null) ||
    manifest.schemaVersion !== ANALYSIS_PACKAGE_SCHEMA_VERSION ||
    manifest.semanticVersion !== ANALYSIS_PACKAGE_SEMANTIC_VERSION ||
    manifest.packageNamespace !== analysisPackageOwnerNamespace(userId) ||
    manifest.digestAlgorithm !== "sha256" ||
    manifest.evidenceCutoff.toISOString() !== scope.data.evidenceCutoff
  ) {
    return { ok: false, reason: "invalid_manifest" };
  }

  const freshness = await getExternalAnalysisSourceBindingFreshness(
    db,
    userId,
    sourceBindings.data,
    scope.data.sourceEvidenceRevision,
  );
  if (!freshness.ok) return freshness;

  const evidenceIds = new Set<string>();
  for (const sourceBinding of sourceBindings.data) {
    for (const id of sourceBinding.ids) evidenceIds.add(id);
    for (const revision of sourceBinding.revisions ?? []) {
      evidenceIds.add(revision.id);
    }
  }

  return {
    ok: true,
    sourceBindings: sourceBindings.data.map((sourceBinding) =>
      sourceBinding.entity === "programs"
        ? Object.fromEntries(
            Object.entries(sourceBinding).filter(
              ([key]) => key !== "versionTokens",
            ),
          ) as AnalysisPackageSourceBinding
        : sourceBinding,
    ),
    sourceVersionTokens: sourceBindings.data.flatMap((sourceBinding) =>
      (sourceBinding.versionTokens ?? []).map((item) => ({
        entity: sourceBinding.entity,
        id: item.id,
        token: item.token,
      })),
    ),
    sourceEvidenceRevision: scope.data.sourceEvidenceRevision,
    binding: {
      packageId: manifest.id,
      packageNamespace: manifest.packageNamespace,
      schemaVersion: ANALYSIS_PACKAGE_SCHEMA_VERSION,
      semanticVersion: ANALYSIS_PACKAGE_SEMANTIC_VERSION,
      digest: manifest.digest,
      evidenceCutoff: manifest.evidenceCutoff.toISOString(),
      expiresAt: manifest.expiresAt.toISOString(),
      questionId: scope.data.questionId,
      questionText: ANALYSIS_QUESTIONS[scope.data.questionId].question,
      evidenceIds: [...evidenceIds],
    },
  };
}
