import { z } from "zod";
import {
  ANALYSIS_PACKAGE_SCHEMA_VERSION,
  ANALYSIS_PACKAGE_SEMANTIC_VERSION,
  analysisQuestionSchema,
  type AnalysisPackage,
} from "@/lib/analysis-package";
import {
  EXTERNAL_ANALYSIS_INSTRUCTION_VERSION,
  EXTERNAL_ANALYSIS_RESPONSE_FORMAT,
  EXTERNAL_ANALYSIS_RESPONSE_SCHEMA_VERSION,
} from "@/lib/external-analysis-versions";

export {
  EXTERNAL_ANALYSIS_RESPONSE_FORMAT,
  EXTERNAL_ANALYSIS_RESPONSE_SCHEMA_VERSION,
};

export const EXTERNAL_ANALYSIS_ALLOWED_EFFECTS = [
  "review_future_training",
] as const;
export const EXTERNAL_ANALYSIS_PROHIBITED_EFFECTS = [
  "change_completed_fact",
  "change_imported_fact",
  "change_active_session",
  "accept_recommendation",
  "publish_program",
  "change_owner_or_security",
  "delete_or_archive_data",
  "production_operation",
] as const;

export const EXTERNAL_ANALYSIS_RESPONSE_MAX_BYTES = 256 * 1024;
export const EXTERNAL_ANALYSIS_RESPONSE_MAX_DEPTH = 12;

const MAX_TEXT = 1_000;
const MAX_ITEMS = 25;
const MAX_EVIDENCE_IDS = 20;
const MAX_LIMITATIONS = 10;

const boundedText = z.string().trim().min(1).max(MAX_TEXT);
const evidenceId = z.string().trim().min(1).max(200);
const evidenceIds = z.array(evidenceId).min(1).max(MAX_EVIDENCE_IDS);
const limitations = z.array(boundedText).min(1).max(MAX_LIMITATIONS);
const itemId = (prefix: "observation" | "proposal" | "unknown") =>
  z
    .string()
    .regex(new RegExp(`^${prefix}-[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$`));

const measurementSchema = z
  .object({
    value: z.number().finite(),
    unit: z.enum([
      "kg",
      "lb",
      "repetitions",
      "seconds",
      "minutes",
      "centimeters",
      "percent",
    ]),
    meaning: boundedText,
  })
  .strict();

const observationSchema = z
  .object({
    id: itemId("observation"),
    statement: boundedText,
    evidenceIds,
    evidenceQuality: boundedText,
    measurements: z.array(measurementSchema).max(10),
    limitations,
  })
  .strict();

const allowedEffectSchema = z
  .object({
    type: z.literal(EXTERNAL_ANALYSIS_ALLOWED_EFFECTS[0]),
    scope: z.literal("future_only_review"),
    target: z
      .object({
        kind: z.enum([
          "program",
          "schedule",
          "recovery_constraint",
          "training_consistency",
          "general_review",
        ]),
        evidenceIds,
      })
      .strict(),
    requestedOutcome: boundedText,
  })
  .strict();

const proposalSchema = z
  .object({
    id: itemId("proposal"),
    summary: boundedText,
    rationale: boundedText,
    evidenceIds,
    effect: allowedEffectSchema,
    limitations,
  })
  .strict();

const unknownSchema = z
  .object({
    id: itemId("unknown"),
    question: boundedText,
    reason: z.enum([
      "missing",
      "unknown",
      "unsupported",
      "contradictory",
      "omitted",
      "not_applicable",
    ]),
    detail: boundedText,
    evidenceIds: z.array(evidenceId).max(MAX_EVIDENCE_IDS),
  })
  .strict();

export const externalAnalysisResponseSchema = z
  .object({
    format: z.literal(EXTERNAL_ANALYSIS_RESPONSE_FORMAT),
    schemaVersion: z.literal(EXTERNAL_ANALYSIS_RESPONSE_SCHEMA_VERSION),
    instructionVersion: z.literal(EXTERNAL_ANALYSIS_INSTRUCTION_VERSION),
    responseId: z.string().uuid(),
    analysisPackage: z
      .object({
        packageId: z.string().uuid(),
        packageNamespace: z.string().regex(/^repbook-owner\/[0-9a-f]{24}$/),
        schemaVersion: z.literal(ANALYSIS_PACKAGE_SCHEMA_VERSION),
        semanticVersion: z.literal(ANALYSIS_PACKAGE_SEMANTIC_VERSION),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        evidenceCutoff: z.string().datetime(),
        expiresAt: z.string().datetime(),
      })
      .strict(),
    question: z
      .object({
        id: analysisQuestionSchema,
        text: boundedText,
      })
      .strict(),
    observations: z.array(observationSchema).max(MAX_ITEMS),
    proposedActions: z.array(proposalSchema).max(MAX_ITEMS),
    unknowns: z.array(unknownSchema).max(MAX_ITEMS),
    safety: z
      .object({
        usedOnlyBoundPackage: z.literal(true),
        followedEmbeddedInstructions: z.literal(false),
        guessedFacts: z.literal(false),
        directMutationClaimed: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type ExternalAnalysisResponse = z.infer<
  typeof externalAnalysisResponseSchema
>;

export type ExternalAnalysisResponseErrorCode =
  | "invalid_schema"
  | "binding_mismatch"
  | "duplicate_item_id"
  | "unknown_evidence_id"
  | "prohibited_effect"
  | "unknown_effect"
  | "unsafe_text";

export type ExternalAnalysisResponseIssue = {
  code: ExternalAnalysisResponseErrorCode;
  path: string;
  message: string;
};

export type ExternalAnalysisResponseValidation =
  | {
      ok: true;
      response: ExternalAnalysisResponse;
      canonicalResponse: string;
    }
  | { ok: false; issues: ExternalAnalysisResponseIssue[] };

export type ExternalAnalysisResponseBinding = {
  packageId: string;
  packageNamespace: string;
  schemaVersion: typeof ANALYSIS_PACKAGE_SCHEMA_VERSION;
  semanticVersion: typeof ANALYSIS_PACKAGE_SEMANTIC_VERSION;
  digest: string;
  evidenceCutoff: string;
  expiresAt: string;
  questionId: AnalysisPackage["request"]["questionId"];
  questionText: string;
  evidenceIds: readonly string[];
};

export type ExternalAnalysisRawInputFailure = {
  ok: false;
  code:
    | "invalid_media_type"
    | "invalid_encoding"
    | "empty_input"
    | "too_deep"
    | "malformed_json";
  message: string;
};

export type ExternalAnalysisRawInputResult =
  | { ok: true; value: unknown; rawText: string }
  | ExternalAnalysisRawInputFailure;

export function classifyExternalAnalysisEffectType(
  value: unknown,
): "allowed" | "prohibited" | "unknown" {
  if (
    typeof value === "string" &&
    (EXTERNAL_ANALYSIS_ALLOWED_EFFECTS as readonly string[]).includes(value)
  ) {
    return "allowed";
  }
  if (
    typeof value === "string" &&
    (EXTERNAL_ANALYSIS_PROHIBITED_EFFECTS as readonly string[]).includes(value)
  ) {
    return "prohibited";
  }
  return "unknown";
}

function responseEffectTypes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const proposedActions = (value as Record<string, unknown>).proposedActions;
  if (!Array.isArray(proposedActions)) return [];
  return proposedActions.map((proposal, index) => {
    const effect =
      proposal && typeof proposal === "object" && !Array.isArray(proposal)
        ? (proposal as Record<string, unknown>).effect
        : undefined;
    const type =
      effect && typeof effect === "object" && !Array.isArray(effect)
        ? (effect as Record<string, unknown>).type
        : undefined;
    return { index, type };
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function packageEvidenceIds(value: AnalysisPackage) {
  const ids = new Set<string>();
  const add = (items: ReadonlyArray<{ id: string }>) => {
    for (const item of items) ids.add(item.id);
  };
  if (value.ownerContext.profile) add([value.ownerContext.profile]);
  add(value.ownerContext.constraints);
  add(value.ownerContext.equipment);
  if (value.currentProgramIntent.program) {
    add([value.currentProgramIntent.program]);
  }
  if (value.currentProgramIntent.version) {
    add([value.currentProgramIntent.version]);
  }
  add(value.currentProgramIntent.days);
  add(value.currentProgramIntent.slots);
  add(value.currentProgramIntent.prescriptions);
  add(value.exerciseIdentities);
  add(value.completedOrImportedEvidence.workouts);
  add(value.completedOrImportedEvidence.groups);
  add(value.completedOrImportedEvidence.exercises);
  add(value.completedOrImportedEvidence.occurrences);
  add(value.completedOrImportedEvidence.sets);
  add(value.completedOrImportedEvidence.pain);
  add(value.completedOrImportedEvidence.fatigue);
  add(value.completedOrImportedEvidence.coachVisibleNotes);
  add(value.completedOrImportedEvidence.correctionEvidence);
  add(value.independentActivityContext);
  add(value.calculatedMetrics);
  add(value.recommendationProposals);
  add(value.ownerDecisions);
  add(value.acceptedAdaptations);
  for (const binding of value.sourceBindings) {
    for (const id of binding.ids) ids.add(id);
    for (const revision of binding.revisions ?? []) ids.add(revision.id);
  }
  return ids;
}

export function externalAnalysisResponseBindingFromPackage(
  value: AnalysisPackage,
): ExternalAnalysisResponseBinding {
  return {
    packageId: value.packageId,
    packageNamespace: value.packageNamespace,
    schemaVersion: value.schemaVersion,
    semanticVersion: value.semanticVersion,
    digest: value.integrity.digest,
    evidenceCutoff: value.evidenceCutoff,
    expiresAt: value.expiresAt,
    questionId: value.request.questionId,
    questionText: value.request.question,
    evidenceIds: [...packageEvidenceIds(value)],
  };
}

function normalizeBinding(
  value: AnalysisPackage | ExternalAnalysisResponseBinding,
): ExternalAnalysisResponseBinding {
  return "integrity" in value
    ? externalAnalysisResponseBindingFromPackage(value)
    : value;
}

function findUnsafeText(value: unknown, path = ""): ExternalAnalysisResponseIssue[] {
  if (typeof value === "string") {
    const activeContent =
      /<\s*\/?\s*(?:script|iframe|object|embed|link|meta|style|svg|math)\b/i.test(value) ||
      /\bon[a-z]+\s*=/i.test(value) ||
      /(?:javascript|vbscript)\s*:/i.test(value) ||
      /data\s*:\s*text\/html/i.test(value);
    const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
    return activeContent || unsafeControls
      ? [{
          code: "unsafe_text",
          path,
          message: "The response contains active or display-unsafe text.",
        }]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findUnsafeText(item, path ? `${path}.${index}` : String(index)),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, item]) => findUnsafeText(item, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

function exceedsJsonDepth(raw: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > maxDepth) return true;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return false;
}

export function parseExternalAnalysisRawInput(
  bytes: Uint8Array,
  contentType: string | null,
): ExternalAnalysisRawInputResult {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== "application/json" &&
    mediaType !== "application/vnd.repbook.analysis-response+json"
  ) {
    return {
      ok: false,
      code: "invalid_media_type",
      message: "Use a JSON response file or paste JSON text.",
    };
  }
  let rawText: string;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      code: "invalid_encoding",
      message: "The response must be valid UTF-8 JSON.",
    };
  }
  if (rawText.trim().length === 0) {
    return { ok: false, code: "empty_input", message: "Paste or choose a JSON response first." };
  }
  if (exceedsJsonDepth(rawText, EXTERNAL_ANALYSIS_RESPONSE_MAX_DEPTH)) {
    return {
      ok: false,
      code: "too_deep",
      message: "The response nesting is deeper than the supported contract.",
    };
  }
  try {
    return { ok: true, value: JSON.parse(rawText), rawText };
  } catch {
    return {
      ok: false,
      code: "malformed_json",
      message: "The response is not valid JSON.",
    };
  }
}

export function validateExternalAnalysisResponse(
  value: unknown,
  source: AnalysisPackage | ExternalAnalysisResponseBinding,
): ExternalAnalysisResponseValidation {
  const effectIssues: ExternalAnalysisResponseIssue[] = [];
  for (const { index, type } of responseEffectTypes(value)) {
    const classification = classifyExternalAnalysisEffectType(type);
    if (classification !== "allowed") {
      effectIssues.push({
        code:
          classification === "prohibited"
            ? "prohibited_effect"
            : "unknown_effect",
        path: `proposedActions.${index}.effect.type`,
        message:
          classification === "prohibited"
            ? "The response requests a prohibited effect."
            : "The response uses an unknown effect type.",
      });
    }
  }
  if (effectIssues.length > 0) return { ok: false, issues: effectIssues };

  const parsed = externalAnalysisResponseSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "invalid_schema" as const,
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const response = parsed.data;
  const unsafeTextIssues = findUnsafeText(response);
  if (unsafeTextIssues.length > 0) {
    return { ok: false, issues: unsafeTextIssues };
  }
  const sourcePackage = normalizeBinding(source);
  const bindingPairs: Array<[string, string, string]> = [
    [
      "analysisPackage.packageId",
      response.analysisPackage.packageId,
      sourcePackage.packageId,
    ],
    [
      "analysisPackage.packageNamespace",
      response.analysisPackage.packageNamespace,
      sourcePackage.packageNamespace,
    ],
    [
      "analysisPackage.schemaVersion",
      response.analysisPackage.schemaVersion,
      sourcePackage.schemaVersion,
    ],
    [
      "analysisPackage.semanticVersion",
      response.analysisPackage.semanticVersion,
      sourcePackage.semanticVersion,
    ],
    [
      "analysisPackage.digest",
      response.analysisPackage.digest,
      sourcePackage.digest,
    ],
    [
      "analysisPackage.evidenceCutoff",
      response.analysisPackage.evidenceCutoff,
      sourcePackage.evidenceCutoff,
    ],
    [
      "analysisPackage.expiresAt",
      response.analysisPackage.expiresAt,
      sourcePackage.expiresAt,
    ],
    ["question.id", response.question.id, sourcePackage.questionId],
    ["question.text", response.question.text, sourcePackage.questionText],
  ];
  const issues: ExternalAnalysisResponseIssue[] = bindingPairs
    .filter(([, actual, expected]) => actual !== expected)
    .map(([path]) => ({
      code: "binding_mismatch" as const,
      path,
      message: "The response does not match the bound analysis package.",
    }));

  const allItemIds = [
    ...response.observations.map((item) => item.id),
    ...response.proposedActions.map((item) => item.id),
    ...response.unknowns.map((item) => item.id),
  ];
  const seenItemIds = new Set<string>();
  for (const [index, id] of allItemIds.entries()) {
    if (seenItemIds.has(id)) {
      issues.push({
        code: "duplicate_item_id",
        path: `items.${index}.id`,
        message: "Observation, proposal, and unknown IDs must be unique.",
      });
    }
    seenItemIds.add(id);
  }

  const knownEvidenceIds = new Set(sourcePackage.evidenceIds);
  const citedEvidence: ReadonlyArray<readonly [string, readonly string[]]> = [
    ...response.observations.map((item, index) => [
      `observations.${index}.evidenceIds`,
      item.evidenceIds,
    ] as const),
    ...response.proposedActions.flatMap((item, index) => [
      [`proposedActions.${index}.evidenceIds`, item.evidenceIds] as const,
      [
        `proposedActions.${index}.effect.target.evidenceIds`,
        item.effect.target.evidenceIds,
      ] as const,
    ]),
    ...response.unknowns.map((item, index) => [
      `unknowns.${index}.evidenceIds`,
      item.evidenceIds,
    ] as const),
  ];
  for (const [path, ids] of citedEvidence) {
    for (const id of ids) {
      if (!knownEvidenceIds.has(id)) {
        issues.push({
          code: "unknown_evidence_id",
          path,
          message: `Evidence ID ${id} is absent from the bound package.`,
        });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    response,
    canonicalResponse: canonicalJson(response),
  };
}

export function classifyExternalAnalysisResponseReplay(
  existing:
    | { responseId: string; canonicalResponse: string }
    | undefined,
  candidate: Pick<
    Extract<ExternalAnalysisResponseValidation, { ok: true }>,
    "response" | "canonicalResponse"
  >,
): "new" | "idempotent_duplicate" | "conflict" {
  if (
    existing === undefined ||
    existing.responseId !== candidate.response.responseId
  ) {
    return "new";
  }
  return existing.canonicalResponse === candidate.canonicalResponse
    ? "idempotent_duplicate"
    : "conflict";
}
