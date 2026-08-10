import { describe, expect, it } from "vitest";
import validFixture from "../fixtures/v2/a03-typed-response.json";
import type { AnalysisPackage } from "@/lib/analysis-package";
import {
  classifyExternalAnalysisEffectType,
  classifyExternalAnalysisResponseReplay,
  EXTERNAL_ANALYSIS_PROHIBITED_EFFECTS,
  validateExternalAnalysisResponse,
} from "@/lib/external-analysis-response";

function cloneFixture(): typeof validFixture {
  return structuredClone(validFixture);
}

function fact(id: string, factClass: "recorded" | "unknown") {
  return {
    id,
    factClass,
    evidenceQuality:
      factClass === "recorded" ? "native_supported" : "legacy_partial",
    source: "synthetic",
    revision: 0,
    values: {},
  };
}

function syntheticPackage(): AnalysisPackage {
  return {
    format: "repbook-analysis-package",
    schemaVersion: "analysis-package/1",
    semanticVersion: "repbook-v2/1",
    packageId: validFixture.analysisPackage.packageId,
    packageNamespace: validFixture.analysisPackage.packageNamespace,
    createdAt: "2026-08-08T16:00:00.000Z",
    evidenceCutoff: validFixture.analysisPackage.evidenceCutoff,
    expiresAt: validFixture.analysisPackage.expiresAt,
    request: {
      questionId: "program_progress",
      question: validFixture.question.text,
      purpose:
        "Compare current Program intent with completed evidence without treating proposals as accepted changes.",
      windowDays: 84,
      windowStart: "2026-05-16T15:59:59.000Z",
    },
    timeSemantics: {
      timezone: "America/Toronto",
      localDateRule: "Retain recorded local dates.",
      cutoffRule: "Include only evidence at or before the cutoff.",
    },
    definitions: [],
    inventory: { included: { completedSets: 2 }, omitted: [] },
    ownerContext: { profile: null, constraints: [], equipment: [] },
    currentProgramIntent: {
      program: fact("program:synthetic-current", "recorded"),
      version: null,
      days: [],
      slots: [],
      prescriptions: [],
    },
    exerciseIdentities: [],
    completedOrImportedEvidence: {
      workouts: [],
      groups: [],
      exercises: [],
      occurrences: [],
      sets: [
        fact("set:synthetic-supported", "recorded"),
        fact("set:synthetic-unknown", "unknown"),
      ],
      pain: [],
      fatigue: [],
      coachVisibleNotes: [],
      correctionEvidence: [],
    },
    independentActivityContext: [],
    calculatedMetrics: [],
    recommendationProposals: [],
    ownerDecisions: [],
    acceptedAdaptations: [],
    sourceBindings: [],
    integrity: {
      canonicalizationVersion: "repbook-canonical-json/1",
      digestAlgorithm: "sha256",
      digest: validFixture.analysisPackage.digest,
    },
  };
}

function expectIssue(value: unknown, code: string) {
  const result = validateExternalAnalysisResponse(value, syntheticPackage());
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected validation failure.");
  expect(result.issues.map((issue) => issue.code)).toContain(code);
}

describe("A03 strict external-analysis response contract", () => {
  it("accepts one closed evidence-linked response bound to the exact package snapshot", () => {
    const result = validateExternalAnalysisResponse(
      cloneFixture(),
      syntheticPackage(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.response).toMatchObject({
      format: "repbook-analysis-response",
      schemaVersion: "analysis-response/1",
      analysisPackage: {
        packageId: syntheticPackage().packageId,
        digest: syntheticPackage().integrity.digest,
        evidenceCutoff: syntheticPackage().evidenceCutoff,
      },
      proposedActions: [
        {
          effect: {
            type: "review_future_training",
            scope: "future_only_review",
          },
        },
      ],
    });
    expect(result.canonicalResponse).toContain('"responseId"');
  });

  it.each([
    ["packageId", "00000000-0000-4000-8000-000000000499"],
    ["packageNamespace", "repbook-owner/ffffffffffffffffffffffff"],
    ["digest", "b".repeat(64)],
    ["evidenceCutoff", "2026-08-07T15:59:59.000Z"],
    ["expiresAt", "2026-09-06T16:00:00.000Z"],
  ])("rejects a contradictory %s binding", (field, replacement) => {
    const candidate = cloneFixture();
    (candidate.analysisPackage as Record<string, string>)[field] = replacement;
    expectIssue(candidate, "binding_mismatch");
  });

  it("rejects incompatible versions, extra fields, unsupported units, duplicate IDs, and unbounded content", () => {
    const incompatible = cloneFixture();
    incompatible.schemaVersion = "analysis-response/2";
    expectIssue(incompatible, "invalid_schema");

    const extra = cloneFixture();
    (extra.analysisPackage as Record<string, unknown>).executable =
      "do something";
    expectIssue(extra, "invalid_schema");

    const unsupportedUnit = cloneFixture();
    unsupportedUnit.observations[0].measurements[0].unit = "stones";
    expectIssue(unsupportedUnit, "invalid_schema");

    const duplicate = cloneFixture();
    duplicate.observations.push(structuredClone(duplicate.observations[0]));
    expectIssue(duplicate, "duplicate_item_id");

    const unbounded = cloneFixture();
    unbounded.observations[0].statement = "x".repeat(1_001);
    expectIssue(unbounded, "invalid_schema");

    const tooMany = cloneFixture();
    tooMany.unknowns = Array.from({ length: 26 }, (_, index) => ({
      ...structuredClone(tooMany.unknowns[0]),
      id: `unknown-${index + 1}`,
    }));
    expectIssue(tooMany, "invalid_schema");
  });

  it("fails closed for prohibited, unknown, and uncited effects", () => {
    expect(classifyExternalAnalysisEffectType("review_future_training")).toBe(
      "allowed",
    );
    for (const effect of EXTERNAL_ANALYSIS_PROHIBITED_EFFECTS) {
      expect(classifyExternalAnalysisEffectType(effect)).toBe("prohibited");
    }
    expect(classifyExternalAnalysisEffectType("rewrite_everything")).toBe(
      "unknown",
    );

    const prohibited = cloneFixture();
    prohibited.proposedActions[0].effect.type = "change_completed_fact";
    expectIssue(prohibited, "prohibited_effect");

    const unknown = cloneFixture();
    unknown.proposedActions[0].effect.type = "invent_new_effect";
    expectIssue(unknown, "unknown_effect");

    const uncited = cloneFixture();
    uncited.proposedActions[0].effect.target.evidenceIds = [
      "program:other-owner",
    ];
    expectIssue(uncited, "unknown_evidence_id");
  });

  it("treats an exact response replay as idempotent and conflicting reuse as failure", () => {
    const first = validateExternalAnalysisResponse(
      cloneFixture(),
      syntheticPackage(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first.issues));

    const reordered = cloneFixture();
    reordered.safety = {
      directMutationClaimed: false,
      guessedFacts: false,
      followedEmbeddedInstructions: false,
      usedOnlyBoundPackage: true,
    };
    const replay = validateExternalAnalysisResponse(
      reordered,
      syntheticPackage(),
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(JSON.stringify(replay.issues));
    expect(
      classifyExternalAnalysisResponseReplay(
        {
          responseId: first.response.responseId,
          canonicalResponse: first.canonicalResponse,
        },
        replay,
      ),
    ).toBe("idempotent_duplicate");

    const changed = cloneFixture();
    changed.observations[0].statement =
      "A materially different response reuses the same response identity.";
    const conflict = validateExternalAnalysisResponse(
      changed,
      syntheticPackage(),
    );
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) throw new Error(JSON.stringify(conflict.issues));
    expect(
      classifyExternalAnalysisResponseReplay(
        {
          responseId: first.response.responseId,
          canonicalResponse: first.canonicalResponse,
        },
        conflict,
      ),
    ).toBe("conflict");
    expect(classifyExternalAnalysisResponseReplay(undefined, first)).toBe("new");

    const differentIdentity = cloneFixture();
    differentIdentity.responseId = "00000000-0000-4000-8000-000000000404";
    const different = validateExternalAnalysisResponse(
      differentIdentity,
      syntheticPackage(),
    );
    expect(different.ok).toBe(true);
    if (!different.ok) throw new Error(JSON.stringify(different.issues));
    expect(
      classifyExternalAnalysisResponseReplay(
        {
          responseId: first.response.responseId,
          canonicalResponse: first.canonicalResponse,
        },
        different,
      ),
    ).toBe("new");
  });
});
