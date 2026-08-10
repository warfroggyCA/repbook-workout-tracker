import { z } from "zod";

export const ANALYSIS_PACKAGE_FORMAT = "repbook-analysis-package" as const;
export const ANALYSIS_PACKAGE_SCHEMA_VERSION = "analysis-package/1" as const;
export const ANALYSIS_PACKAGE_SEMANTIC_VERSION = "repbook-v2/1" as const;
export const ANALYSIS_PACKAGE_CANONICALIZATION_VERSION =
  "repbook-canonical-json/1" as const;
export const ANALYSIS_PACKAGE_RETENTION_DAYS = 30 as const;
export const ANALYSIS_PACKAGE_MAX_BYTES = 5 * 1024 * 1024;

export const ANALYSIS_PACKAGE_SOURCE_BINDING_ENTITIES = [
  "user_profiles",
  "constraints",
  "equipment_items",
  "plate_inventory",
  "barbell_configs",
  "plate_loaded_machine_profiles",
  "cable_machine_profiles",
  "cable_stack_steps",
  "cable_attachment_profiles",
  "programs",
  "program_versions",
  "workout_templates",
  "workout_template_exercises",
  "exercise_prescriptions",
  "exercises",
  "workout_sessions",
  "session_exercise_groups",
  "session_exercises",
  "session_occurrences",
  "completed_sets",
  "pain_logs",
  "fatigue_logs",
  "contextual_notes",
  "record_versions",
  "health_activities",
  "recommendations",
  "user_decisions",
  "adaptation_events",
] as const;

export type AnalysisPackageSourceBindingEntity =
  (typeof ANALYSIS_PACKAGE_SOURCE_BINDING_ENTITIES)[number];

export const ANALYSIS_PACKAGE_SOURCE_REVISION_FIELDS: Partial<
  Record<AnalysisPackageSourceBindingEntity, string>
> = {
  workout_sessions: "history_revision",
  session_occurrences: "revision",
  contextual_notes: "revision",
  recommendations: "review_revision",
};

export const analysisQuestionSchema = z.enum([
  "program_progress",
  "recovery_constraints",
  "training_consistency",
]);
export type AnalysisQuestionId = z.infer<typeof analysisQuestionSchema>;

export const analysisWindowDaysSchema = z.union([
  z.literal(28),
  z.literal(84),
  z.literal(182),
]);

export const analysisPackageRequestSchema = z
  .object({
    questionId: analysisQuestionSchema,
    windowDays: analysisWindowDaysSchema,
  })
  .strict();
export type AnalysisPackageRequest = z.infer<
  typeof analysisPackageRequestSchema
>;

export const ANALYSIS_QUESTIONS: Record<
  AnalysisQuestionId,
  { label: string; question: string; purpose: string }
> = {
  program_progress: {
    label: "Program progress",
    question:
      "What does the retained evidence say about progress and fit of my current Program?",
    purpose:
      "Compare current Program intent with completed or imported evidence without treating recommendations as accepted changes.",
  },
  recovery_constraints: {
    label: "Recovery and constraints",
    question:
      "What recovery, pain, fatigue, and constraint patterns should I consider before changing future training?",
    purpose:
      "Review recorded recovery context while preserving pain evidence, unknowns, and owner safety constraints.",
  },
  training_consistency: {
    label: "Training consistency",
    question:
      "What does my recorded training and independent activity context show about consistency?",
    purpose:
      "Review completed or abandoned workouts and separately labelled independent activities without mixing activity into strength calculations.",
  },
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const factRecordSchema = z
  .object({
    id: z.string().min(1),
    factClass: z.enum([
      "recorded",
      "imported",
      "corrected",
      "calculated",
      "unknown",
    ]),
    evidenceQuality: z.string().min(1),
    source: z.string().min(1),
    revision: z.number().int().nonnegative().nullable(),
    values: z.record(z.string(), jsonValueSchema),
  })
  .strict();

const proposalRecordSchema = z
  .object({
    id: z.string().min(1),
    state: z.string().min(1),
    source: z.string().min(1),
    values: z.record(z.string(), jsonValueSchema),
  })
  .strict();

export const analysisPackageSourceBindingSchema = z
  .object({
    entity: z.enum(ANALYSIS_PACKAGE_SOURCE_BINDING_ENTITIES),
    ids: z.array(z.string().uuid()).min(1),
    revisions: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            revision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.ids).size !== value.ids.length) {
      context.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Source-binding IDs must be unique.",
      });
    }
    const revisionIds = value.revisions?.map((revision) => revision.id) ?? [];
    if (new Set(revisionIds).size !== revisionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["revisions"],
        message: "Source-binding revision IDs must be unique.",
      });
    }
    const revisionField = ANALYSIS_PACKAGE_SOURCE_REVISION_FIELDS[value.entity];
    if (
      revisionIds.some((id) => !value.ids.includes(id)) ||
      (revisionField == null && revisionIds.length > 0) ||
      (revisionField != null && revisionIds.length !== value.ids.length)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revisions"],
        message: "Source-binding revisions must belong to a supported bound entity.",
      });
    }
  });

export const analysisPackageSourceBindingsSchema = z
  .array(analysisPackageSourceBindingSchema)
  .max(100)
  .superRefine((value, context) => {
    const entities = value.map((binding) => binding.entity);
    if (new Set(entities).size !== entities.length) {
      context.addIssue({
        code: "custom",
        message: "Source-binding entities must be unique.",
      });
    }
  });

export const analysisPackageRetainedSourceBindingSchema = z
  .object({
    entity: z.enum(ANALYSIS_PACKAGE_SOURCE_BINDING_ENTITIES),
    ids: z.array(z.string().uuid()).min(1),
    revisions: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            revision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    contentHashes: z.array(
      z.object({
        id: z.string().uuid(),
        hash: z.string().regex(/^[0-9a-f]{64}$/),
      }).strict(),
    ),
    versionTokens: z.array(
      z.object({
        id: z.string().uuid(),
        token: z.string().regex(/^\d+$/),
      }).strict(),
    ).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const revisionIds = value.revisions?.map((revision) => revision.id) ?? [];
    const contentHashIds = value.contentHashes.map((item) => item.id);
    const versionTokenIds = value.versionTokens?.map((item) => item.id) ?? [];
    if (
      new Set(value.ids).size !== value.ids.length ||
      new Set(revisionIds).size !== revisionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Retained source-binding IDs and revisions must be unique.",
      });
    }
    const revisionField = ANALYSIS_PACKAGE_SOURCE_REVISION_FIELDS[value.entity];
    if (
      revisionIds.some((id) => !value.ids.includes(id)) ||
      (revisionField == null && revisionIds.length > 0) ||
      (revisionField != null && revisionIds.length !== value.ids.length)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revisions"],
        message: "Retained source-binding revisions are incoherent.",
      });
    }
    if (
      new Set(contentHashIds).size !== contentHashIds.length ||
      contentHashIds.length !== value.ids.length ||
      contentHashIds.some((id) => !value.ids.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentHashes"],
        message: "Retained source-binding content hashes must exactly cover the bound IDs.",
      });
    }
    if (
      value.versionTokens != null &&
      (new Set(versionTokenIds).size !== versionTokenIds.length ||
        versionTokenIds.length !== value.ids.length ||
        versionTokenIds.some((id) => !value.ids.includes(id)))
    ) {
      context.addIssue({
        code: "custom",
        path: ["versionTokens"],
        message: "Retained source-binding version tokens must exactly cover the bound IDs.",
      });
    }
  });

export const analysisPackageRetainedSourceBindingsSchema = z
  .array(analysisPackageRetainedSourceBindingSchema)
  .max(100)
  .superRefine((value, context) => {
    const entities = value.map((binding) => binding.entity);
    if (new Set(entities).size !== entities.length) {
      context.addIssue({
        code: "custom",
        message: "Retained source-binding entities must be unique.",
      });
    }
  });

export const analysisPackageCoreSchema = z
  .object({
    format: z.literal(ANALYSIS_PACKAGE_FORMAT),
    schemaVersion: z.literal(ANALYSIS_PACKAGE_SCHEMA_VERSION),
    semanticVersion: z.literal(ANALYSIS_PACKAGE_SEMANTIC_VERSION),
    packageId: z.string().uuid(),
    packageNamespace: z.string().min(1),
    createdAt: z.string().datetime(),
    evidenceCutoff: z.string().datetime(),
    expiresAt: z.string().datetime(),
    request: z
      .object({
        questionId: analysisQuestionSchema,
        question: z.string().min(1),
        purpose: z.string().min(1),
        windowDays: analysisWindowDaysSchema,
        windowStart: z.string().datetime(),
      })
      .strict(),
    timeSemantics: z
      .object({
        timezone: z.string().min(1),
        localDateRule: z.string().min(1),
        cutoffRule: z.string().min(1),
      })
      .strict(),
    definitions: z.array(
      z
        .object({
          key: z.string().min(1),
          meaning: z.string().min(1),
        })
        .strict(),
    ),
    inventory: z
      .object({
        included: z.record(z.string(), z.number().int().nonnegative()),
        omitted: z.array(
          z
            .object({
              category: z.string().min(1),
              reason: z.string().min(1),
              count: z.number().int().nonnegative().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    ownerContext: z
      .object({
        profile: factRecordSchema.nullable(),
        constraints: z.array(factRecordSchema),
        equipment: z.array(factRecordSchema),
      })
      .strict(),
    currentProgramIntent: z
      .object({
        program: factRecordSchema.nullable(),
        version: factRecordSchema.nullable(),
        days: z.array(factRecordSchema),
        slots: z.array(factRecordSchema),
        prescriptions: z.array(factRecordSchema),
      })
      .strict(),
    exerciseIdentities: z.array(factRecordSchema),
    completedOrImportedEvidence: z
      .object({
        workouts: z.array(factRecordSchema),
        groups: z.array(factRecordSchema),
        exercises: z.array(factRecordSchema),
        occurrences: z.array(factRecordSchema),
        sets: z.array(factRecordSchema),
        pain: z.array(factRecordSchema),
        fatigue: z.array(factRecordSchema),
        coachVisibleNotes: z.array(factRecordSchema),
        correctionEvidence: z.array(factRecordSchema),
      })
      .strict(),
    independentActivityContext: z.array(factRecordSchema),
    calculatedMetrics: z.array(factRecordSchema),
    recommendationProposals: z.array(proposalRecordSchema),
    ownerDecisions: z.array(proposalRecordSchema),
    acceptedAdaptations: z.array(proposalRecordSchema),
    sourceBindings: analysisPackageSourceBindingsSchema,
  })
  .strict();

export const analysisPackageSchema = analysisPackageCoreSchema
  .extend({
    integrity: z
      .object({
        canonicalizationVersion: z.literal(
          ANALYSIS_PACKAGE_CANONICALIZATION_VERSION,
        ),
        digestAlgorithm: z.literal("sha256"),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();

export type AnalysisPackageCore = z.infer<typeof analysisPackageCoreSchema>;
export type AnalysisPackage = z.infer<typeof analysisPackageSchema>;

export type AnalysisPackageManifestSummary = {
  id: string;
  schemaVersion: string;
  semanticVersion: string;
  questionId: string;
  windowDays: number;
  digest: string;
  createdAt: string;
  evidenceCutoff: string;
  expiresAt: string;
  status: "active" | "expired";
};
