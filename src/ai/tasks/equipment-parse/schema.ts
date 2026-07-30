import { z } from "zod";
import { aiEnvelope } from "@/ai/envelope";

/** Plan §13 contract 1 — guided-setup equipment parsing. */

export const equipmentItemSchema = z.object({
  type: z.enum([
    "barbell",
    "ez_bar",
    "rack",
    "bench",
    "dumbbell",
    "kettlebell",
    "plates",
    "bands",
    "jump_rope",
    "elliptical",
    "pullup_bar",
    "cable",
    "machine",
    "other",
  ]),
  label: z.string(),
  /** Number of identical items represented by this row. Default to 1 when unstated. */
  quantity: z.number().int().min(1).max(99),
  attrs: z.object({
    minWeight: z.number().nullable(),
    maxWeight: z.number().nullable(),
    /** null = the user did not state a unit — must be confirmed. */
    unit: z.enum(["lb", "kg"]).nullable(),
    adjustable: z.boolean().nullable(),
    pair: z.boolean().nullable(),
    increments: z.array(z.number()).nullable(),
    denominations: z
      .array(
        z.object({
          weight: z.number(),
          quantity: z.number().nullable(),
        })
      )
      .nullable(),
    brand: z.string().nullable(),
    /** Stated bar weight for barbell-like items, when known. */
    barWeight: z.number().nullable(),
    /** Bench style when explicitly stated. */
    adjustableBench: z.boolean().nullable(),
  }),
});

export const equipmentParseData = z.object({
  items: z.array(equipmentItemSchema),
});

export const equipmentParseSchema = aiEnvelope(equipmentParseData);

export type EquipmentParseResult = z.infer<typeof equipmentParseSchema>;
