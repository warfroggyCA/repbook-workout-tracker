import { z } from "zod";

const logSetFields = {
  sessionExerciseId: z.string().uuid(),
  setNo: z.number().int().min(1).max(50),
  weight: z.number().min(0).max(2000).nullable(),
  weightUnit: z.enum(["lb", "kg"]).nullable(),
  reps: z.number().int().min(0).max(100),
  rpe: z.number().min(1).max(10).nullable().optional(),
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

export const logSetSchema = z
  .object(logSetFields)
  .refine((value) => (value.weight == null) === (value.weightUnit == null), {
    message: "Weighted sets require one explicit load unit.",
    path: ["weightUnit"],
  })
  .refine((value) => value.isWarmup !== true, {
    message: "Warm-ups use the occurrence action path.",
    path: ["isWarmup"],
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

export const updateSetSchema = z
  .object(logSetFields)
  .pick({ weight: true, weightUnit: true, reps: true, rpe: true, note: true })
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
