import { z } from "zod";
import { equipmentTypeEnum } from "@/db/schema/enums";
import type { EquipmentAttrs } from "@/db/schema/equipment";
import { MAX_STORED_LOAD, normalizeStoredLoad, type LoadUnit } from "@/lib/units";
import {
  equipmentLoadProfileSchema,
} from "@/lib/equipment-load-profile-contract";

/**
 * Canonical, lossless equipment-inventory contract shared by the
 * returning-user manager, first-time onboarding persistence, and the server
 * loader/preview/save boundary described in `docs/ARCHITECTURE.md`.
 *
 * This is deliberately separate from the AI equipment-parse contract: the AI
 * vocabulary may stay smaller, but storage round-trips must cover every
 * database equipment type, repeated items of one type, stable IDs, and
 * attributes this editor does not yet expose.
 */

/** One canonical list: exactly the database `equipment_type` enum values. */
export const EQUIPMENT_TYPE_VALUES = equipmentTypeEnum.enumValues;
export type CanonicalEquipmentType = (typeof EQUIPMENT_TYPE_VALUES)[number];

const storedLoad = z
  .number()
  .finite()
  .min(0)
  .max(MAX_STORED_LOAD)
  .transform(normalizeStoredLoad);
const storedPositiveLoad = storedLoad.pipe(z.number().positive());

/**
 * Attribute keys this increment's editors may write. Everything else on a
 * retained row (for example `levels` and `notes`) is server-owned and is
 * preserved from the re-read base row, never taken from the client.
 */
export const EDITABLE_ATTR_KEYS = [
  "minWeight",
  "maxWeight",
  "unit",
  "adjustable",
  "pair",
  "increments",
  "adjustableBench",
  "brand",
] as const;

/**
 * Complete known attribute validation. Unknown-but-valid future keys are
 * preserved (loose object) so a round-trip through the editor cannot drop
 * data the editor does not understand.
 */
export const equipmentAttrsSchema = z.looseObject({
  minWeight: storedLoad.optional(),
  maxWeight: storedLoad.optional(),
  unit: z.enum(["lb", "kg"]).optional(),
  adjustable: z.boolean().optional(),
  pair: z.boolean().optional(),
  increments: z.array(storedPositiveLoad).max(200).optional(),
  adjustableBench: z.boolean().optional(),
  brand: z.string().max(120).optional(),
  levels: z.array(z.string().max(120)).max(50).optional(),
  notes: z.string().max(1000).optional(),
});

export const equipmentInventoryItemSchema = z.object({
  /** Stable database identity; null for an item added in this draft. */
  id: z.uuid().nullable(),
  /**
   * Stable identity for a not-yet-persisted physical item. This lets an exact
   * loading profile reference the item during the same atomic first save.
   */
  draftId: z.uuid().optional(),
  type: z.enum(EQUIPMENT_TYPE_VALUES),
  label: z
    .string()
    .trim()
    .min(1, "Every item needs a name.")
    .max(120),
  quantity: z.number().int().min(1).max(99),
  attrs: equipmentAttrsSchema,
});
export type EquipmentInventoryItem = z.infer<typeof equipmentInventoryItemSchema>;

export const plateInventoryItemSchema = z.object({
  /** Stable database identity; null for a denomination added in this draft. */
  id: z.uuid().nullable(),
  denomination: z
    .number()
    .finite()
    .positive("A plate size must be a positive weight.")
    .max(MAX_STORED_LOAD)
    .refine(
      (value) => Math.round(value * 100) === value * 100,
      "Plate sizes support at most two decimal places."
    ),
  /** Total individual plates of this size the user owns; odd counts allowed. */
  quantity: z.number().int().min(1).max(100),
});
export type PlateInventoryItem = z.infer<typeof plateInventoryItemSchema>;

export const BAR_TYPES = ["olympic", "ez"] as const;

export const barConfigurationItemSchema = z.object({
  /** Stable database identity; null for a bar added in this draft. */
  id: z.uuid().nullable(),
  barType: z.enum(BAR_TYPES),
  barWeight: storedPositiveLoad,
  collarWeight: storedLoad,
  quantity: z.number().int().min(1).max(99),
  label: z.string().trim().min(1).max(120),
});
export type BarConfigurationItem = z.infer<typeof barConfigurationItemSchema>;

export const equipmentInventoryDocumentSchema = z.object({
  /** Deterministic revision of the loaded inventory; guards stale tabs. */
  baseRevision: z.string().min(1).max(64),
  items: z.array(equipmentInventoryItemSchema).max(200),
  plates: z.array(plateInventoryItemSchema).max(100),
  bars: z.array(barConfigurationItemSchema).max(20),
  /**
   * Exact, item-scoped setup truth. Optional keeps older setup/onboarding
   * callers source-compatible; the returning-user loader always supplies the
   * complete current list so management round-trips cannot drop profiles.
   */
  loadProfiles: z.array(z.object({
    equipmentItemId: z.uuid(),
    profile: equipmentLoadProfileSchema,
  })).max(200).optional(),
});
export type EquipmentInventoryDocument = z.infer<
  typeof equipmentInventoryDocumentSchema
>;

export type InventoryValidationIssue = { path: string; message: string };

export type InventoryDocumentValidation =
  | { ok: true; document: EquipmentInventoryDocument }
  | { ok: false; issues: InventoryValidationIssue[] };

function naturalKey(item: { type: string; label: string }) {
  return `${item.type}\0${item.label.trim().toLocaleLowerCase()}`;
}

/**
 * Complete document validation: schema plus the cross-row rules the atomic
 * save also enforces. Duplicate IDs, duplicate natural keys, duplicate plate
 * denominations and unsafe new bar associations fail before any mutation.
 * Existing repeated configurations remain representable so they can be
 * preserved unchanged while unrelated inventory is maintained.
 */
export function validateEquipmentInventoryDocument(
  input: unknown
): InventoryDocumentValidation {
  const parsed = equipmentInventoryDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }
  const document = parsed.data;
  const issues: InventoryValidationIssue[] = [];

  const itemById = new Map(
    document.items.flatMap((item) => {
      const identity = item.id ?? item.draftId;
      return identity ? [[identity, item] as const] : [];
    }),
  );
  const profileItemIds = new Set<string>();
  const profileIds = new Set<string>();
  const documentPlateIds = new Set(
    document.plates.flatMap((plate) => plate.id ? [plate.id] : []),
  );
  const attachmentItemIds = new Set(
    (document.loadProfiles ?? []).flatMap((entry) =>
      entry.profile.kind === "attachment" ? [entry.equipmentItemId] : []
    ),
  );
  for (const [index, entry] of (document.loadProfiles ?? []).entries()) {
    if (profileItemIds.has(entry.equipmentItemId)) {
      issues.push({
        path: `loadProfiles.${index}.equipmentItemId`,
        message: "Each physical equipment item can have only one exact setup profile.",
      });
    }
    profileItemIds.add(entry.equipmentItemId);
    if (entry.profile.id) {
      if (profileIds.has(entry.profile.id)) {
        issues.push({
          path: `loadProfiles.${index}.profile.id`,
          message: "The same saved setup profile was included twice.",
        });
      }
      profileIds.add(entry.profile.id);
    }
    const item = itemById.get(entry.equipmentItemId);
    if (!item) {
      // Retired/unavailable inventory is intentionally absent from the active
      // item editor, while its typed profile remains part of the complete
      // lossless document. A client may carry that saved profile through but
      // cannot create an unattached one.
      if (entry.profile.id == null) {
        issues.push({
          path: `loadProfiles.${index}.equipmentItemId`,
          message: "A new exact setup must belong to active equipment.",
        });
      }
      continue;
    }
    const allowed =
      (entry.profile.kind === "plate_loaded_implement" &&
        ((item.type === "barbell" && entry.profile.loadingKind === "olympic") ||
          (item.type === "ez_bar" && entry.profile.loadingKind === "ez") ||
          (item.type === "trap_bar" && entry.profile.loadingKind === "trap_hex") ||
          (item.type === "other" && entry.profile.loadingKind === "specialty"))) ||
      (entry.profile.kind === "plate_loaded_machine" &&
        (item.type === "machine" || item.type === "smith_machine")) ||
      (entry.profile.kind === "cable_machine" && item.type === "cable") ||
      (entry.profile.kind === "attachment" && item.type === "other");
    if (!allowed) {
      issues.push({
        path: `loadProfiles.${index}.profile.kind`,
        message: `The exact setup type does not match ${item.label}.`,
      });
    }
    if (
      entry.profile.kind === "plate_loaded_machine" &&
      entry.profile.compatiblePlateIds.some((id) => !documentPlateIds.has(id))
    ) {
      issues.push({
        path: `loadProfiles.${index}.profile.compatiblePlateIds`,
        message: "Compatible machine plates must come from this account's saved plate pool.",
      });
    }
    if (
      entry.profile.kind === "cable_machine" &&
      entry.profile.compatibleAttachmentItemIds.some((id) => !attachmentItemIds.has(id))
    ) {
      issues.push({
        path: `loadProfiles.${index}.profile.compatibleAttachmentItemIds`,
        message: "Compatible cable attachments must have a saved attachment profile in this inventory.",
      });
    }
  }

  const itemIds = new Set<string>();
  const itemDraftIds = new Set<string>();
  const itemKeys = new Set<string>();
  for (const [index, item] of document.items.entries()) {
    if (item.id) {
      if (itemIds.has(item.id) || itemDraftIds.has(item.id)) {
        issues.push({
          path: `items.${index}`,
          message: "The same saved equipment item was included twice.",
        });
      }
      itemIds.add(item.id);
    }
    if (item.draftId) {
      if (item.id != null || itemDraftIds.has(item.draftId) || itemIds.has(item.draftId)) {
        issues.push({
          path: `items.${index}.draftId`,
          message: "Each new physical equipment item needs one unique draft identity.",
        });
      }
      itemDraftIds.add(item.draftId);
    }
    const key = naturalKey(item);
    if (itemKeys.has(key)) {
      issues.push({
        path: `items.${index}.label`,
        message: `Keep only one entry named “${item.label.trim()}” for that equipment type.`,
      });
    }
    itemKeys.add(key);

    const minWeight = item.attrs.minWeight;
    const maxWeight = item.attrs.maxWeight;
    if (minWeight != null && maxWeight != null && minWeight > maxWeight) {
      issues.push({
        path: `items.${index}.attrs.minWeight`,
        message: `${item.label} has a minimum weight above its maximum weight.`,
      });
    }
    const increments = item.attrs.increments ?? [];
    if (new Set(increments).size !== increments.length) {
      issues.push({
        path: `items.${index}.attrs.increments`,
        message: `${item.label} includes the same available weight more than once.`,
      });
    }
    if (
      increments.some(
        (weight) =>
          (minWeight != null && weight < minWeight) ||
          (maxWeight != null && weight > maxWeight)
      )
    ) {
      issues.push({
        path: `items.${index}.attrs.increments`,
        message: `${item.label} has an available weight outside its minimum-to-maximum range.`,
      });
    }
  }

  const plateIds = new Set<string>();
  const denominations = new Set<number>();
  for (const [index, plate] of document.plates.entries()) {
    if (plate.id) {
      if (plateIds.has(plate.id)) {
        issues.push({
          path: `plates.${index}`,
          message: "The same saved plate size was included twice.",
        });
      }
      plateIds.add(plate.id);
    }
    if (denominations.has(plate.denomination)) {
      issues.push({
        path: `plates.${index}.denomination`,
        message: `Keep one row per plate size and raise its quantity instead (${plate.denomination} appears twice).`,
      });
    }
    denominations.add(plate.denomination);
  }

  const barIds = new Set<string>();
  for (const [index, bar] of document.bars.entries()) {
    if (bar.id) {
      if (barIds.has(bar.id)) {
        issues.push({
          path: `bars.${index}`,
          message: "The same saved bar configuration was included twice.",
        });
      }
      barIds.add(bar.id);
    }
  }

  const association = associateBarConfigurations(document.items, document.bars);
  for (const itemIndex of association.missingItemIndexes) {
    if (document.items[itemIndex].id == null) {
      issues.push({
        path: `items.${itemIndex}`,
        message: "A new Olympic or EZ bar needs an empty bar weight before review.",
      });
    }
  }
  for (const barIndex of association.unmatchedBarIndexes) {
    if (document.bars[barIndex].id == null) {
      issues.push({
        path: `bars.${barIndex}`,
        message: "A new bar configuration must match one unambiguous Olympic or EZ item.",
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, document };
}

export function normalizedBarLabel(label: string): string {
  return label.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function barTypeForEquipmentItem(
  type: CanonicalEquipmentType | string
): BarConfigurationItem["barType"] | null {
  if (type === "barbell") return "olympic";
  if (type === "ez_bar") return "ez";
  return null;
}

export type BarConfigurationAssociation = {
  matched: Array<{ itemIndex: number; barIndex: number; match: "label" | "sole" }>;
  unmatchedBarIndexes: number[];
  missingItemIndexes: number[];
  ambiguousTypes: Array<BarConfigurationItem["barType"]>;
};

/**
 * Release A's deliberately conservative compatibility match. A configuration
 * is editable on an item only when that type has exactly one active item and
 * one saved configuration. The normalized label is preferred; a sole
 * compatible-item fallback is allowed only because both sides are unique.
 * Repeated items/configurations remain unmatched instead of being paired by
 * array order.
 */
export function associateBarConfigurations(
  items: Array<Pick<EquipmentInventoryItem, "type" | "label">>,
  bars: Array<{ barType: string; label: string }>
): BarConfigurationAssociation {
  const matched: BarConfigurationAssociation["matched"] = [];
  const unmatchedBarIndexes: number[] = [];
  const missingItemIndexes: number[] = [];
  const ambiguousTypes: BarConfigurationAssociation["ambiguousTypes"] = [];

  for (const barType of BAR_TYPES) {
    const itemIndexes = items.flatMap((item, index) =>
      barTypeForEquipmentItem(item.type) === barType ? [index] : []
    );
    const barIndexes = bars.flatMap((bar, index) =>
      bar.barType === barType ? [index] : []
    );
    if (itemIndexes.length === 0) {
      unmatchedBarIndexes.push(...barIndexes);
      continue;
    }
    if (barIndexes.length === 0) {
      missingItemIndexes.push(...itemIndexes);
      continue;
    }
    if (itemIndexes.length !== 1 || barIndexes.length !== 1) {
      ambiguousTypes.push(barType);
      unmatchedBarIndexes.push(...barIndexes);
      missingItemIndexes.push(...itemIndexes);
      continue;
    }
    const itemIndex = itemIndexes[0];
    const barIndex = barIndexes[0];
    matched.push({
      itemIndex,
      barIndex,
      match:
        normalizedBarLabel(items[itemIndex].label) ===
        normalizedBarLabel(bars[barIndex].label)
          ? "label"
          : "sole",
    });
  }

  return {
    matched,
    unmatchedBarIndexes,
    missingItemIndexes,
    ambiguousTypes,
  };
}

export function synchronizeMatchedBarCopies(
  document: EquipmentInventoryDocument
): EquipmentInventoryDocument {
  const association = associateBarConfigurations(document.items, document.bars);
  const bars = document.bars.map((bar) => ({ ...bar }));
  for (const { itemIndex, barIndex } of association.matched) {
    bars[barIndex].label = document.items[itemIndex].label.trim();
    bars[barIndex].quantity = document.items[itemIndex].quantity;
  }
  return { ...document, bars };
}

// ---------------------------------------------------------------------------
// Field applicability (UI-002): show weight controls only where weight has
// meaning for the equipment type.
// ---------------------------------------------------------------------------

export type EquipmentFieldApplicability = {
  /** Ask lb/kg only when some weight field is meaningful for this type. */
  unit: boolean;
  /** Minimum/maximum owned weight (dumbbells, kettlebells, similar). */
  weightRange: boolean;
  adjustable: boolean;
  pair: boolean;
  benchType: boolean;
  /** Configured through the dedicated bar section, not generic weight fields. */
  barConfiguration: boolean;
  /** Configured through the dedicated plate section. */
  plateDenominations: boolean;
  /** Exact owned increments for adjustable/fixed handheld collections. */
  increments: boolean;
};

const WEIGHT_RANGE_TYPES = new Set<CanonicalEquipmentType>([
  "dumbbell",
  "kettlebell",
  "medicine_ball",
]);
const PAIRED_TYPES = new Set<CanonicalEquipmentType>(["dumbbell", "kettlebell"]);
const BAR_ITEM_TYPES = new Set<CanonicalEquipmentType>(["barbell", "ez_bar"]);

export type EquipmentQuantityCopy = {
  label: string;
  helper: string | null;
};

/**
 * Quantity belongs to the physical configuration represented by one row. For
 * fixed handheld collections it applies at every selected exact weight; a
 * second row is needed when the count or configuration differs.
 */
export function equipmentQuantityCopy(
  type: CanonicalEquipmentType,
  pair: boolean | null | undefined,
  adjustable: boolean | null | undefined
): EquipmentQuantityCopy {
  if (!PAIRED_TYPES.has(type)) {
    return { label: "How many", helper: null };
  }
  if (pair == null) {
    return {
      label: "Choose Pair or Single first",
      helper: "Choose Pair or Single before deciding the quantity.",
    };
  }

  const noun = pair ? "pairs" : "singles";
  if (adjustable === false) {
    return {
      label: `How many ${noun} at each weight`,
      helper: pair
        ? "Quantity 1 means one matched pair at every selected weight. Add another entry if a weight has a different quantity or configuration."
        : "Quantity 1 means one individual weight at every selected weight. Add another entry if a weight has a different quantity or configuration.",
    };
  }
  if (adjustable === true) {
    return {
      label: `How many adjustable ${noun}`,
      helper: pair
        ? "Quantity 1 means one matched adjustable pair: two physical weights."
        : "Quantity counts individual adjustable weights when Single is selected.",
    };
  }
  return {
    label: `How many ${noun}`,
    helper: "Choose Adjustable or Fixed weights to define what this quantity counts.",
  };
}

export function equipmentFieldApplicability(
  type: CanonicalEquipmentType
): EquipmentFieldApplicability {
  const weightRange = WEIGHT_RANGE_TYPES.has(type);
  const barConfiguration = BAR_ITEM_TYPES.has(type);
  const plateDenominations = type === "plates";
  return {
    unit: weightRange || barConfiguration || plateDenominations,
    weightRange,
    adjustable: PAIRED_TYPES.has(type),
    pair: PAIRED_TYPES.has(type),
    benchType: type === "bench",
    barConfiguration,
    plateDenominations,
    increments: PAIRED_TYPES.has(type),
  };
}

// ---------------------------------------------------------------------------
// Common selection-driven choices (UI-006). These are offers, never assumed
// ownership: a fresh collection begins with nothing selected.
// ---------------------------------------------------------------------------

export const COMMON_PLATE_DENOMINATIONS: Record<LoadUnit, readonly number[]> = {
  lb: [45, 35, 25, 10, 5, 2.5],
  kg: [20, 15, 10, 5, 2.5, 1.25],
};

export const COMMON_BAR_WEIGHTS: Record<
  (typeof BAR_TYPES)[number],
  Record<LoadUnit, readonly number[]>
> = {
  olympic: { lb: [45, 35], kg: [20, 15] },
  ez: { lb: [25, 20, 15], kg: [10, 7.5] },
};

export const COMMON_FIXED_WEIGHTS: Record<
  "dumbbell" | "kettlebell",
  Record<LoadUnit, readonly number[]>
> = {
  dumbbell: {
    lb: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50],
    kg: [2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25],
  },
  kettlebell: {
    lb: [10, 15, 20, 25, 35, 45, 53],
    kg: [4, 8, 12, 16, 20, 24, 28],
  },
};

/** Loadable pairs from a total plate count: two plates make one usable pair. */
export function platePairsPerSide(quantity: number): number {
  return Math.floor(quantity / 2);
}

/** True when an odd plate is left over that cannot be loaded symmetrically. */
export function hasSparePlate(quantity: number): boolean {
  return quantity % 2 === 1;
}

/** e.g. `45 lb × 5 (1 spare)` — the unambiguous ownership summary. */
export function describePlateRow(
  denomination: number,
  quantity: number,
  unit: LoadUnit
): string {
  const spare = hasSparePlate(quantity) ? " (1 spare)" : "";
  return `${denomination} ${unit} × ${quantity}${spare}`;
}

/**
 * Normalize a database row into the lossless document item. Attribute keys are
 * kept exactly as stored, including keys this editor does not expose.
 */
export function documentItemFromRow(row: {
  id: string;
  type: string;
  label: string;
  quantity: number;
  attrs: EquipmentAttrs;
}): EquipmentInventoryItem {
  return {
    id: row.id,
    type: row.type as CanonicalEquipmentType,
    label: row.label,
    quantity: row.quantity,
    attrs: { ...row.attrs },
  };
}
