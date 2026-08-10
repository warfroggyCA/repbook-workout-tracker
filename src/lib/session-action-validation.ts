import { z } from "zod";
import {
  PERFORMED_LOAD_SEMANTICS,
  validateSetWriterShape,
} from "@/lib/set-metric-semantics";
import {
  LIMITATION_CAUSES,
  PAIN_BODY_PARTS,
  TECHNIQUE_ISSUES,
} from "@/lib/set-exception-context";

const loadUnitSchema = z.enum(["lb", "kg"]);
const loadSemanticsSchema = z.enum(PERFORMED_LOAD_SEMANTICS);

const logSetCommandFields = {
  sessionExerciseId: z.string().uuid(),
  performedExerciseId: z.string().uuid(),
  performedSemanticsVersion: z.literal(1),
  performedLoadType: z.string().trim().min(1).max(50),
  performedLoadSemantics: loadSemanticsSchema,
  setNo: z.number().int().min(1).max(50),
  rpe: z.number().min(1).max(10).nullable().optional(),
  rir: z.number().min(0).max(10).nullable().optional(),
  techniqueIssue: z.enum(TECHNIQUE_ISSUES).nullable().optional(),
  limitationCause: z.enum(LIMITATION_CAUSES).nullable().optional(),
  pain: z.object({
    bodyPart: z.enum(PAIN_BODY_PARTS),
    severity: z.number().int().min(1).max(10),
    note: z.string().max(500).nullable(),
  }).nullable().optional(),
  isWarmup: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
  clientKey: z.string().min(1).max(64),
  equipmentSnapshotId: z.string().uuid().nullable(),
  loadEntryMeaning: z.enum([
    "total_system",
    "per_loading_point",
    "displayed_stack",
    "per_stack",
    "combined_stacks",
    "legacy_unknown",
  ]),
  observedCompletedAtISO: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional(),
};

const performedMeasurementSchema = z.discriminatedUnion("metricType", [
  z.object({
    metricType: z.literal("weight_reps"),
    weight: z.number().finite().min(0).max(2000),
    weightUnit: loadUnitSchema,
    reps: z.number().int().min(0).max(100),
    distanceKm: z.null(),
    durationSeconds: z.null(),
  }),
  z.object({
    metricType: z.literal("reps"),
    weight: z.null(),
    weightUnit: z.null(),
    reps: z.number().int().min(0).max(100),
    distanceKm: z.null(),
    durationSeconds: z.null(),
  }),
  z.object({
    metricType: z.literal("assisted_reps"),
    weight: z.number().finite().min(0).max(2000),
    weightUnit: loadUnitSchema,
    reps: z.number().int().min(0).max(100),
    distanceKm: z.null(),
    durationSeconds: z.null(),
  }),
  z.object({
    metricType: z.literal("duration"),
    weight: z.null(),
    weightUnit: z.null(),
    reps: z.null(),
    distanceKm: z.null(),
    durationSeconds: z.number().int().min(0).max(604_800),
  }),
  z.object({
    metricType: z.literal("distance_duration"),
    weight: z.null(),
    weightUnit: z.null(),
    reps: z.null(),
    distanceKm: z.number().finite().min(0).max(10_000),
    durationSeconds: z.number().int().min(0).max(604_800).nullable(),
  }),
]);

export const logSetSchema = z
  .intersection(z.object(logSetCommandFields), performedMeasurementSchema)
  .superRefine((value, context) => {
    const shape = validateSetWriterShape({
      metricType: value.metricType,
      loadSemantics: value.performedLoadSemantics,
      weight: value.weight,
      weightUnit: value.weightUnit,
      reps: value.reps,
      distanceKm: value.distanceKm,
      durationSeconds: value.durationSeconds,
    });
    if (!shape.ok) {
      context.addIssue({
        code: "custom",
        message: shape.message,
        path: ["metricType"],
      });
    }
  })
  .refine((value) => value.isWarmup !== true, {
    message: "Warm-ups use the occurrence action path.",
    path: ["isWarmup"],
  })
  .refine((value) => value.rpe == null || value.rir == null, {
    message: "Record effort as either RIR or RPE, not both.",
    path: ["rir"],
  })
  .refine(
    (value) =>
      (value.equipmentSnapshotId == null) ===
      (value.loadEntryMeaning === "legacy_unknown"),
    {
      message: "Equipment evidence and its load meaning must be acknowledged together.",
      path: ["equipmentSnapshotId"],
    },
  );

export type LogSetInput = z.infer<typeof logSetSchema>;

const editableSetFields = {
  weight: z.number().min(0).max(2000).nullable(),
  weightUnit: loadUnitSchema.nullable(),
  reps: z.number().int().min(0).max(100),
  rpe: z.number().min(1).max(10).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
};

export const updateSetSchema = z
  .object(editableSetFields)
  .partial()
  .extend({ setId: z.string().uuid() })
  .refine(
    (value) =>
      value.weight !== null ||
      value.weightUnit === undefined ||
      value.weightUnit === null,
    { message: "A cleared load cannot retain a unit.", path: ["weightUnit"] },
  );

export const painSchema = z.object({
  sessionExerciseId: z.string().uuid(),
  bodyPart: z.string().min(1).max(50),
  severity: z.number().int().min(0).max(10),
  note: z.string().max(500).optional(),
});
