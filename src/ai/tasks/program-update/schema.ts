import { z } from "zod";

// Provider contract has no defaults, optional properties, or model-authored IDs.
const text = z.string().max(4000).nullable();
const target = { dayId: z.string().uuid(), slotId: z.string().uuid() };
export const updateWarmupSchema = z
  .object({
    label: z.string().min(1).max(120),
    reps: z.number().int().min(0).max(1000).nullable(),
    load: z.number().min(0).max(100000).nullable(),
    loadUnit: z.enum(["lb", "kg"]).nullable(),
    loadPercent: z.number().min(0).max(500).nullable(),
    loadText: z.string().max(160).nullable(),
    notes: z.string().max(500).nullable(),
  })
  .strict();
export const programUpdateOperationSchema = z.union([
  z
    .object({
      kind: z.literal("group"),
      dayId: target.dayId,
      slotIds: z.array(target.slotId).max(12),
      exerciseIds: z.array(z.string().uuid()).max(12),
      name: z.string().min(1).max(80),
      rounds: z.number().int().min(1).max(20),
      restBetweenMembersSec: z.number().int().min(0).max(1800),
      restBetweenRoundsSec: z.number().int().min(0).max(1800),
      restAfterRoundSec: z.number().int().min(0).max(1800),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ungroup"),
      dayId: target.dayId,
      groupId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("warmup"),
      dayId: target.dayId,
      slotId: target.slotId.nullable(),
      notes: text,
      items: z.array(updateWarmupSchema).max(24),
    })
    .strict(),
  z
    .object({
      kind: z.literal("slot_number"),
      ...target,
      field: z.enum(["sets", "restSec"]),
      value: z.number().int().min(0).max(1800),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reps"),
      ...target,
      min: z.number().int().min(1).max(100),
      max: z.number().int().min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("load"),
      ...target,
      value: z.number().min(0).max(100000).nullable(),
      unit: z.enum(["lb", "kg"]).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("slot_text"),
      ...target,
      field: z.enum(["notes", "progressionRuleId"]),
      value: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("day_text"),
      dayId: target.dayId,
      field: z.enum(["name", "notes"]),
      value: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reorder"),
      dayId: target.dayId,
      slotIds: z.array(target.slotId).min(1).max(60),
    })
    .strict(),
  z.object({ kind: z.literal("remove"), ...target }).strict(),
  z
    .object({
      kind: z.literal("replace"),
      ...target,
      exerciseId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("add"),
      dayId: target.dayId,
      exerciseId: z.string().uuid(),
      afterSlotId: target.slotId.nullable(),
      sets: z.number().int().min(1).max(20),
      repMin: z.number().int().min(1).max(100),
      repMax: z.number().int().min(1).max(100),
      restSec: z.number().int().min(0).max(1800),
      load: z.number().min(0).max(100000).nullable(),
      loadUnit: z.enum(["lb", "kg"]).nullable(),
    })
    .strict(),
]);
export const programUpdateSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            reason: z.string().min(1).max(500),
            sourceQuote: z.string().min(1).max(1000),
            operations: z.array(programUpdateOperationSchema).min(1).max(60),
          })
          .strict(),
      )
      .max(40),
    questions: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();
export type ProgramUpdateOperation = z.infer<
  typeof programUpdateOperationSchema
>;
export type ProgramTextUpdate = z.infer<typeof programUpdateSchema>;
