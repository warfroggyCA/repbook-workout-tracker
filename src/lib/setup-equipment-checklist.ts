import type { barbellConfigs, equipmentItems, plateInventory } from "@/db/schema";
import type { ConfirmedEquipmentItem } from "@/ai/tasks/equipment-parse/confirm";
import { associateBarConfigurations } from "@/lib/equipment-inventory-contract";

export type SetupExistingInventory = {
  items: (typeof equipmentItems.$inferSelect)[];
  plates: (typeof plateInventory.$inferSelect)[];
  bars: (typeof barbellConfigs.$inferSelect)[];
};

export type DraftChecklistItem = ConfirmedEquipmentItem & { clientKey: string };

/**
 * Repeated checklist entries need distinct default names because the atomic
 * inventory save deliberately rejects duplicate type-and-label identities.
 */
export function nextChecklistItemLabel(
  items: ReadonlyArray<Pick<DraftChecklistItem, "type" | "label">>,
  type: ConfirmedEquipmentItem["type"],
  baseLabel: string
): string {
  const sameType = items.filter((item) => item.type === type);
  if (sameType.length === 0) return baseLabel;

  const used = new Set(
    sameType.map((item) => item.label.trim().toLocaleLowerCase())
  );
  let suffix = sameType.length + 1;
  let candidate = `${baseLabel} ${suffix}`;
  while (used.has(candidate.toLocaleLowerCase())) {
    suffix += 1;
    candidate = `${baseLabel} ${suffix}`;
  }
  return candidate;
}

const WEIGHTED_ENTRY_TYPES = new Set<ConfirmedEquipmentItem["type"]>([
  "barbell",
  "ez_bar",
  "plates",
  "dumbbell",
  "kettlebell",
]);

function emptyStoredItem(
  type: ConfirmedEquipmentItem["type"],
  label: string
): ConfirmedEquipmentItem {
  return {
    type,
    label,
    quantity: 1,
    minWeight: null,
    maxWeight: null,
    unit: null,
    adjustable: null,
    pair: null,
    increments: null,
    denominations: null,
    brand: null,
    barWeight: null,
    adjustableBench: null,
  };
}

/**
 * Stable-ID onboarding adapter. Unlike the historical type-keyed Map, this
 * retains repeated and specialty rows individually when an incomplete account
 * revisits the equipment step.
 */
export function checklistFromExisting(
  existing: SetupExistingInventory,
  unit: "lb" | "kg"
): DraftChecklistItem[] {
  const association = associateBarConfigurations(existing.items, existing.bars);
  const barIndexByItemIndex = new Map(
    association.matched.map(({ itemIndex, barIndex }) => [itemIndex, barIndex])
  );
  const draft = existing.items.map((row, itemIndex) => {
    const item = emptyStoredItem(row.type, row.label);
    item.id = row.id;
    item.quantity = row.quantity ?? 1;
    item.unit = row.attrs.unit ?? (WEIGHTED_ENTRY_TYPES.has(item.type) ? unit : null);
    item.minWeight = row.attrs.minWeight ?? null;
    item.maxWeight = row.attrs.maxWeight ?? null;
    item.adjustable = row.attrs.adjustable ?? null;
    item.pair = row.attrs.pair ?? null;
    item.increments = row.attrs.increments ?? null;
    item.brand = row.attrs.brand ?? null;
    item.adjustableBench = row.attrs.adjustableBench ?? null;
    if (
      (item.type === "dumbbell" || item.type === "kettlebell") &&
      item.adjustable === false &&
      (item.increments == null || item.increments.length === 0) &&
      item.minWeight != null &&
      item.minWeight === item.maxWeight
    ) {
      item.increments = [item.minWeight];
    }
    if (row.type === "barbell" || row.type === "ez_bar") {
      const barIndex = barIndexByItemIndex.get(itemIndex);
      if (barIndex != null) {
        const bar = existing.bars[barIndex];
        item.barConfigId = bar?.id;
        item.barWeight = bar?.barWeight ?? null;
        item.collarWeight = bar?.collarWeight ?? 0;
      }
    }
    return { ...item, clientKey: row.id };
  });
  const denominations = existing.plates.map((plate) => ({
    id: plate.id,
    weight: plate.denomination,
    quantity: plate.quantity,
  }));
  const firstPlateItem = draft.find((item) => item.type === "plates");
  if (firstPlateItem) {
    firstPlateItem.denominations = denominations.length ? denominations : null;
  } else if (denominations.length > 0) {
    draft.push({
      ...emptyStoredItem("plates", "Weight plates"),
      clientKey: "shared-plate-pool",
      unit,
      denominations,
    });
  }
  return draft;
}
