import { equipmentTypeEnum } from "@/db/schema/enums";
import type { EquipmentAttrs } from "@/db/schema/equipment";

export type KnownEquipmentType =
  (typeof equipmentTypeEnum.enumValues)[number];

export type EquipmentFamilyKey =
  | "bars_and_plates"
  | "handheld_weights"
  | "stations_and_supports"
  | "cables_and_machines"
  | "bands_and_suspension"
  | "conditioning_machines"
  | "conditioning_tools"
  | "mobility_and_recovery"
  | "specialty_and_attachments"
  | "no_equipment"
  | "uncategorized";

export type EquipmentFamilyDefinition = {
  key: EquipmentFamilyKey;
  name: string;
  description: string;
};

export type EquipmentInventorySourceItem = {
  id: string;
  type: string;
  label: string;
  quantity: number;
  attrs: EquipmentAttrs;
  definitionLabel?: string | null;
  definitionDescription?: string | null;
};

export type EquipmentInventoryPlate = {
  id: string;
  denomination: number;
  quantity: number;
};

export type EquipmentInventoryBar = {
  id: string;
  barType: string;
  barWeight: number;
  collarWeight: number;
  quantity: number;
  label: string;
};

export type EquipmentInventoryDisplayItem = EquipmentInventorySourceItem & {
  familyKey: EquipmentFamilyKey;
  typeLabel: string;
  details: string[];
  definitionDescription: string | null;
  plateDenominations: string[];
};

export type EquipmentInventorySupplement = {
  id: string;
  label: string;
  details: string[];
};

export type EquipmentInventoryGroup = EquipmentFamilyDefinition & {
  items: EquipmentInventoryDisplayItem[];
  supplements: EquipmentInventorySupplement[];
};

export const EQUIPMENT_FAMILIES: readonly EquipmentFamilyDefinition[] = [
  {
    key: "bars_and_plates",
    name: "Bars & weight plates",
    description: "Straight, curl, and specialty bars with their loading plates.",
  },
  {
    key: "handheld_weights",
    name: "Dumbbells & handheld weights",
    description: "Weights held or carried independently.",
  },
  {
    key: "stations_and_supports",
    name: "Racks, benches & stations",
    description: "Training supports and fixed bodyweight or bar stations.",
  },
  {
    key: "cables_and_machines",
    name: "Cable & strength machines",
    description: "Cable stacks, their saved attachments, and strength machines.",
  },
  {
    key: "bands_and_suspension",
    name: "Bands & suspension",
    description: "Elastic resistance and anchored suspension systems.",
  },
  {
    key: "conditioning_machines",
    name: "Conditioning machines",
    description: "Cardio machines with their own movement path.",
  },
  {
    key: "conditioning_tools",
    name: "Conditioning tools",
    description: "Portable or floor-based tools used for conditioning work.",
  },
  {
    key: "mobility_and_recovery",
    name: "Mobility & recovery",
    description: "Balance, mobility, and soft-tissue tools.",
  },
  {
    key: "specialty_and_attachments",
    name: "Specialty equipment & attachments",
    description: "Specialized implements kept under their exact saved names.",
  },
  {
    key: "no_equipment",
    name: "No-equipment training",
    description: "Exercises that need no owned equipment.",
  },
  {
    key: "uncategorized",
    name: "Other / uncategorized equipment",
    description: "A clearly labelled fallback for equipment types added later.",
  },
] as const;

export const EQUIPMENT_TYPE_FAMILY = {
  barbell: "bars_and_plates",
  ez_bar: "bars_and_plates",
  trap_bar: "bars_and_plates",
  plates: "bars_and_plates",
  dumbbell: "handheld_weights",
  kettlebell: "handheld_weights",
  medicine_ball: "handheld_weights",
  rack: "stations_and_supports",
  bench: "stations_and_supports",
  smith_machine: "stations_and_supports",
  pullup_bar: "stations_and_supports",
  dip_station: "stations_and_supports",
  box: "stations_and_supports",
  cable: "cables_and_machines",
  machine: "cables_and_machines",
  bands: "bands_and_suspension",
  suspension: "bands_and_suspension",
  elliptical: "conditioning_machines",
  rowing_machine: "conditioning_machines",
  stationary_bike: "conditioning_machines",
  treadmill: "conditioning_machines",
  stair_machine: "conditioning_machines",
  jump_rope: "conditioning_tools",
  sled: "conditioning_tools",
  battle_rope: "conditioning_tools",
  stability_ball: "mobility_and_recovery",
  foam_roller: "mobility_and_recovery",
  landmine: "specialty_and_attachments",
  other: "specialty_and_attachments",
  bodyweight: "no_equipment",
} as const satisfies Record<KnownEquipmentType, EquipmentFamilyKey>;

export const EQUIPMENT_TYPE_LABELS = {
  barbell: "Barbell",
  ez_bar: "EZ bar",
  rack: "Rack or stands",
  bench: "Bench",
  dumbbell: "Dumbbell",
  kettlebell: "Kettlebell",
  plates: "Weight plates",
  bands: "Resistance bands",
  jump_rope: "Jump rope",
  elliptical: "Elliptical",
  pullup_bar: "Pull-up bar",
  cable: "Cable equipment",
  machine: "Strength machine",
  bodyweight: "Bodyweight",
  other: "Specialty equipment",
  trap_bar: "Trap / hex bar",
  smith_machine: "Smith machine",
  suspension: "Suspension trainer",
  medicine_ball: "Medicine ball",
  stability_ball: "Stability ball",
  foam_roller: "Foam roller",
  sled: "Sled",
  rowing_machine: "Rowing machine",
  stationary_bike: "Stationary bike",
  treadmill: "Treadmill",
  stair_machine: "Stair machine",
  dip_station: "Dip station",
  box: "Training box",
  landmine: "Landmine attachment",
  battle_rope: "Battle rope",
} as const satisfies Record<KnownEquipmentType, string>;

const EQUIPMENT_TYPE_ORDER: readonly string[] = [
  "barbell",
  "ez_bar",
  "trap_bar",
  "plates",
  "dumbbell",
  "kettlebell",
  "medicine_ball",
  "rack",
  "bench",
  "smith_machine",
  "pullup_bar",
  "dip_station",
  "box",
  "cable",
  "machine",
  "bands",
  "suspension",
  "elliptical",
  "rowing_machine",
  "stationary_bike",
  "treadmill",
  "stair_machine",
  "jump_rope",
  "sled",
  "battle_rope",
  "stability_ball",
  "foam_roller",
  "landmine",
  "other",
  "bodyweight",
];

const TYPE_SORT_INDEX = new Map(
  EQUIPMENT_TYPE_ORDER.map((type, index) => [type, index])
);
const FAMILY_SORT_INDEX = new Map(
  EQUIPMENT_FAMILIES.map((family, index) => [family.key, index])
);
const LABEL_COLLATOR = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

function words(value: string) {
  const spaced = value.replaceAll("_", " ").trim();
  return spaced ? spaced[0].toLocaleUpperCase("en") + spaced.slice(1) : spaced;
}

function normalizeLabel(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase("en");
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 3 }).format(value);
}

export function familyForEquipmentType(type: string): EquipmentFamilyKey {
  const known = EQUIPMENT_TYPE_FAMILY as Readonly<Record<string, EquipmentFamilyKey>>;
  return known[type] ?? "uncategorized";
}

export function labelForEquipmentType(type: string) {
  const known = EQUIPMENT_TYPE_LABELS as Readonly<Record<string, string>>;
  return known[type] ?? words(type);
}

function compareSourceItems(
  left: EquipmentInventorySourceItem,
  right: EquipmentInventorySourceItem
) {
  return (
    (TYPE_SORT_INDEX.get(left.type) ?? Number.MAX_SAFE_INTEGER) -
      (TYPE_SORT_INDEX.get(right.type) ?? Number.MAX_SAFE_INTEGER) ||
    LABEL_COLLATOR.compare(left.label, right.label) ||
    left.id.localeCompare(right.id)
  );
}

function detailsForItem(
  item: EquipmentInventorySourceItem,
  profileUnit: "lb" | "kg",
  bar: EquipmentInventoryBar | undefined
) {
  const details: string[] = [];
  const attrs = item.attrs ?? {};
  const unit = attrs.unit ?? profileUnit;
  const definitionLabel = item.definitionLabel?.trim();

  if (
    definitionLabel &&
    normalizeLabel(definitionLabel) !== normalizeLabel(item.label)
  ) {
    details.push(`Specific type: ${definitionLabel}`);
  }

  if (bar) {
    details.push(`Empty bar weight: ${formatNumber(bar.barWeight)} ${profileUnit}`);
    details.push(
      `Both collars, total: ${formatNumber(bar.collarWeight)} ${profileUnit}`
    );
  }

  if (attrs.minWeight != null && attrs.maxWeight != null) {
    details.push(
      `Range: ${formatNumber(attrs.minWeight)}–${formatNumber(attrs.maxWeight)} ${unit}`
    );
  } else if (attrs.maxWeight != null) {
    details.push(`Up to ${formatNumber(attrs.maxWeight)} ${unit}`);
  } else if (attrs.minWeight != null) {
    details.push(`From ${formatNumber(attrs.minWeight)} ${unit}`);
  }

  if (attrs.adjustableBench != null) {
    details.push(attrs.adjustableBench ? "Adjustable bench" : "Flat bench");
  }
  if (attrs.adjustable != null) {
    details.push(attrs.adjustable ? "Adjustable" : "Fixed weight");
  }
  if (attrs.pair != null) {
    details.push(attrs.pair ? "Pair" : "Single implement");
  }
  if (attrs.increments?.length) {
    details.push(
      `Increments: ${attrs.increments.map(formatNumber).join(", ")} ${unit}`
    );
  }
  if (attrs.brand?.trim()) details.push(`Brand: ${attrs.brand.trim()}`);
  if (attrs.levels?.length) details.push(`Levels: ${attrs.levels.join(", ")}`);
  if (attrs.notes?.trim()) details.push(attrs.notes.trim());
  if (item.type === "bodyweight") details.push("No equipment required");

  return details;
}

function targetTypeForBar(bar: EquipmentInventoryBar) {
  return bar.barType === "ez" ? "ez_bar" : "barbell";
}

function assignBarDetails(
  items: EquipmentInventorySourceItem[],
  bars: EquipmentInventoryBar[]
) {
  const assignments = new Map<string, EquipmentInventoryBar>();
  const unassignedItems = new Set(items.map((item) => item.id));
  const unmatchedBars: EquipmentInventoryBar[] = [];

  for (const bar of [...bars].sort((left, right) => {
    const leftType = targetTypeForBar(left);
    const rightType = targetTypeForBar(right);
    return (
      (TYPE_SORT_INDEX.get(leftType) ?? Number.MAX_SAFE_INTEGER) -
        (TYPE_SORT_INDEX.get(rightType) ?? Number.MAX_SAFE_INTEGER) ||
      LABEL_COLLATOR.compare(left.label, right.label) ||
      left.id.localeCompare(right.id)
    );
  })) {
    const candidates = items.filter(
      (item) =>
        item.type === targetTypeForBar(bar) && unassignedItems.has(item.id)
    );
    const exact = candidates.find(
      (item) => normalizeLabel(item.label) === normalizeLabel(bar.label)
    );
    const target = exact ?? candidates[0];
    if (!target) {
      unmatchedBars.push(bar);
      continue;
    }
    assignments.set(target.id, bar);
    unassignedItems.delete(target.id);
  }

  return { assignments, unmatchedBars };
}

export function groupEquipmentInventory(input: {
  items: EquipmentInventorySourceItem[];
  plates: EquipmentInventoryPlate[];
  bars: EquipmentInventoryBar[];
  profileUnit: "lb" | "kg";
}): EquipmentInventoryGroup[] {
  // Generic plates/bodyweight rows are retained compatibility records. The
  // shared denomination pool and implicit bodyweight capability own current
  // presentation instead.
  const sortedItems = input.items
    .filter((item) => item.type !== "plates" && item.type !== "bodyweight")
    .sort(compareSourceItems);
  const { assignments: barsByItem, unmatchedBars } = assignBarDetails(
    sortedItems,
    input.bars
  );
  const plateDenominations = [...input.plates]
    .sort(
      (left, right) =>
        right.denomination - left.denomination || left.id.localeCompare(right.id)
    )
    .map(
      (plate) =>
        `${formatNumber(plate.denomination)} ${input.profileUnit} × ${
          plate.quantity
        }${plate.quantity % 2 === 1 ? " (1 spare)" : ""}`
    );
  const groups = new Map<EquipmentFamilyKey, EquipmentInventoryGroup>();

  function ensureGroup(key: EquipmentFamilyKey) {
    const existing = groups.get(key);
    if (existing) return existing;
    const definition = EQUIPMENT_FAMILIES.find((family) => family.key === key);
    if (!definition) throw new Error(`Equipment family is not defined: ${key}`);
    const group = { ...definition, items: [], supplements: [] };
    groups.set(key, group);
    return group;
  }

  for (const item of sortedItems) {
    const familyKey = familyForEquipmentType(item.type);
    ensureGroup(familyKey).items.push({
      ...item,
      familyKey,
      typeLabel: labelForEquipmentType(item.type),
      details: detailsForItem(item, input.profileUnit, barsByItem.get(item.id)),
      definitionDescription: item.definitionDescription?.trim() || null,
      plateDenominations: [],
    });
  }

  const barsGroup = unmatchedBars.length
    ? ensureGroup("bars_and_plates")
    : groups.get("bars_and_plates");
  for (const bar of unmatchedBars) {
    barsGroup?.supplements.push({
      id: `bar-${bar.id}`,
      label: bar.label,
      details: [
        `${labelForEquipmentType(targetTypeForBar(bar))} configuration`,
        `Quantity ${bar.quantity}`,
        `Bar weight: ${formatNumber(bar.barWeight)} ${input.profileUnit}`,
        ...(bar.collarWeight > 0
          ? [`Collars: ${formatNumber(bar.collarWeight)} ${input.profileUnit}`]
          : []),
      ],
    });
  }

  if (plateDenominations.length > 0) {
    ensureGroup("bars_and_plates").supplements.push({
      id: "shared-plate-pool",
      label: "Weight plates",
      details: plateDenominations,
    });
  }

  return [...groups.values()].sort(
    (left, right) =>
      (FAMILY_SORT_INDEX.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
      (FAMILY_SORT_INDEX.get(right.key) ?? Number.MAX_SAFE_INTEGER)
  );
}
