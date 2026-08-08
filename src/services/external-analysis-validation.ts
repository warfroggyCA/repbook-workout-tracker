import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { analysisPackageManifests, programs } from "@/db/schema";
import {
  ANALYSIS_PACKAGE_SCHEMA_VERSION,
  ANALYSIS_PACKAGE_SEMANTIC_VERSION,
  ANALYSIS_QUESTIONS,
  analysisPackageSourceBindingSchema,
  analysisQuestionSchema,
  analysisWindowDaysSchema,
} from "@/lib/analysis-package";
import type { ExternalAnalysisResponseBinding } from "@/lib/external-analysis-response";

const manifestScopeSchema = z
  .object({
    questionId: analysisQuestionSchema,
    windowDays: analysisWindowDaysSchema,
    windowStart: z.string().datetime(),
    evidenceCutoff: z.string().datetime(),
    timezone: z.string().min(1),
  })
  .strict();

const manifestBindingsSchema = z
  .array(analysisPackageSourceBindingSchema)
  .max(100);

export type ExternalAnalysisManifestLookup =
  | { ok: true; binding: ExternalAnalysisResponseBinding }
  | {
      ok: false;
      reason: "not_found" | "expired" | "stale_program" | "invalid_manifest";
    };

function idsFor(
  bindings: z.infer<typeof manifestBindingsSchema>,
  entity: string,
): string[] {
  return bindings.find((binding) => binding.entity === entity)?.ids ?? [];
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
  const sourceBindings = manifestBindingsSchema.safeParse(
    manifest.sourceBindings,
  );
  if (
    !scope.success ||
    !sourceBindings.success ||
    manifest.schemaVersion !== ANALYSIS_PACKAGE_SCHEMA_VERSION ||
    manifest.semanticVersion !== ANALYSIS_PACKAGE_SEMANTIC_VERSION ||
    manifest.digestAlgorithm !== "sha256" ||
    manifest.evidenceCutoff.toISOString() !== scope.data.evidenceCutoff
  ) {
    return { ok: false, reason: "invalid_manifest" };
  }

  const boundProgramIds = idsFor(sourceBindings.data, "programs");
  const boundVersionIds = idsFor(sourceBindings.data, "program_versions");
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

  const evidenceIds = new Set<string>();
  for (const sourceBinding of sourceBindings.data) {
    for (const id of sourceBinding.ids) evidenceIds.add(id);
    for (const revision of sourceBinding.revisions ?? []) {
      evidenceIds.add(revision.id);
    }
  }

  return {
    ok: true,
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
