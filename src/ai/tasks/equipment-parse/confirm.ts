import { z } from "zod";
import { MAX_STORED_LOAD, normalizeStoredLoad } from "@/lib/units";
import { EQUIPMENT_TYPE_VALUES } from "@/lib/equipment-inventory-contract";

const storedNonnegativeLoad = z
  .number()
  .finite()
  .min(0)
  .max(MAX_STORED_LOAD)
  .transform(normalizeStoredLoad);
const storedPositiveLoad = storedNonnegativeLoad.pipe(z.number().positive());

/**
 * Confirmation gate for equipment parses (plan §4 step 2). The client renders
 * these fields amber; confirmSetupEquipment re-runs the same check server-side
 * and refuses to save while any remain unresolved. Shared so the two can
 * never disagree.
 */

// The AI parser deliberately emits a smaller vocabulary, but confirmation and
// first-time checklist revisits must accept every stored database type so an
// existing specialty item can pass through unchanged.
export const EQUIPMENT_TYPES = EQUIPMENT_TYPE_VALUES;

/** An equipment item as edited on the confirmation screen. */
export const confirmedEquipmentItemSchema = z.object({
  /** Present when editing an existing saved item; never supplied by AI. */
  id: z.string().uuid().optional(),
  type: z.enum(EQUIPMENT_TYPES),
  label: z.string().min(1).max(120),
  /** How many of this item the user owns (e.g. two Olympic bars). */
  quantity: z.number().int().min(1).max(99).default(1),
  minWeight: storedNonnegativeLoad.nullable(),
  maxWeight: storedNonnegativeLoad.nullable(),
  unit: z.enum(["lb", "kg"]).nullable(),
  adjustable: z.boolean().nullable(),
  pair: z.boolean().nullable(),
  increments: z.array(storedPositiveLoad).nullable(),
  denominations: z
    .array(
      z.object({
        /** Present when editing an existing saved plate row. */
        id: z.string().uuid().optional(),
        weight: storedPositiveLoad,
        quantity: z.number().int().min(1),
      })
    )
    .nullable(),
  brand: z.string().max(120).nullable(),
  /** barbell / ez_bar only — feeds barbellConfigs for plate math. */
  barWeight: storedPositiveLoad.nullable(),
  /** Present when editing an existing saved bar configuration. */
  barConfigId: z.string().uuid().optional(),
  /** Combined weight of both removable collars. */
  collarWeight: storedNonnegativeLoad.optional(),
  /** Original cross-unit statement retained for explicit conversion review. */
  statedBarWeight: storedPositiveLoad.optional(),
  statedBarUnit: z.enum(["lb", "kg"]).optional(),
  barWeightConfirmed: z.boolean().optional(),
  adjustableBench: z.boolean().nullable(),
});

export type ConfirmedEquipmentItem = z.infer<typeof confirmedEquipmentItemSchema>;

export type AmberField =
  | "unit"
  | "adjustable"
  | "pair"
  | "increments"
  | "denominations"
  | "barWeight";

/** Types whose weights are meaningless without a resolved unit. */
const WEIGHTED_TYPES = new Set([
  "barbell",
  "ez_bar",
  "dumbbell",
  "kettlebell",
  "plates",
]);

/**
 * Which fields on this item are still ambiguous and block saving.
 * Deliberately conservative: null is never treated as an implicit answer.
 */
export function amberFields(item: ConfirmedEquipmentItem): AmberField[] {
  const fields: AmberField[] = [];
  const hasWeights =
    item.minWeight != null ||
    item.maxWeight != null ||
    item.barWeight != null ||
    (item.increments?.length ?? 0) > 0 ||
    (item.denominations?.length ?? 0) > 0;
  if (item.unit == null && (WEIGHTED_TYPES.has(item.type) || hasWeights)) {
    fields.push("unit");
  }
  if (
    item.adjustable == null &&
    (item.type === "dumbbell" || item.type === "kettlebell")
  ) {
    fields.push("adjustable");
  }
  if (
    item.pair == null &&
    (item.type === "dumbbell" || item.type === "kettlebell")
  ) {
    fields.push("pair");
  }
  if (
    item.adjustable === false &&
    (item.type === "dumbbell" || item.type === "kettlebell") &&
    (item.increments == null || item.increments.length === 0)
  ) {
    fields.push("increments");
  }
  if (
    item.type === "plates" &&
    (item.denominations == null || item.denominations.length === 0)
  ) {
    fields.push("denominations");
  }
  if (
    (item.type === "barbell" || item.type === "ez_bar") &&
    ((item.id == null && item.barWeight == null) ||
      (item.statedBarUnit != null && item.barWeightConfirmed !== true))
  ) {
    fields.push("barWeight");
  }
  return fields;
}

export const AMBER_QUESTIONS: Record<AmberField, string> = {
  unit: "Pounds or kilograms?",
  adjustable: "Adjustable or fixed?",
  pair: "A pair or a single?",
  increments: "Which exact weights do you own?",
  denominations: "Which plate sizes, and how many of each do you own?",
  barWeight: "What is the empty bar weight?",
};
