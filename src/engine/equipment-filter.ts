/**
 * Deterministic equipment availability filter (plan §5/§8). This is the hard
 * gate: exercise pickers, substitution candidates, and AI suggestion
 * post-validation all run through it. An exercise passes only when every
 * requirement row is satisfied by an available inventory item.
 */

export type EquipmentRequirement = {
  equipmentType: string;
  minWeight: number | null;
};

export type InventoryItem = {
  type: string;
  available: boolean;
  attrs: { maxWeight?: number } & Record<string, unknown>;
};

export type PlateAvailabilityRow = {
  denomination: number;
};

/**
 * Build the one canonical equipment-availability view used by every exercise
 * gate. Generic plate and bodyweight rows are compatibility/history records,
 * not ownership signals: plates exist only when the shared denomination pool
 * is non-empty, while bodyweight is handled implicitly by
 * `requirementSatisfied`.
 */
export function buildEquipmentAvailability(
  items: InventoryItem[],
  plates: PlateAvailabilityRow[]
): InventoryItem[] {
  const ordinary = items.filter(
    (item) => item.type !== "plates" && item.type !== "bodyweight"
  );
  if (plates.length === 0) return ordinary;
  return [
    ...ordinary,
    { type: "plates", available: true, attrs: {} },
  ];
}

const EQUIPMENT_REQUIREMENT_LABELS: Record<string, string> = {
  barbell: "barbell",
  ez_bar: "EZ bar",
  rack: "rack-like support (rack, squat stands, bench press station, or uprights)",
  bench: "bench",
  dumbbell: "dumbbells",
  kettlebell: "kettlebell",
  plates: "weight plates",
  bands: "resistance bands",
  jump_rope: "jump rope",
  elliptical: "elliptical",
  pullup_bar: "pull-up bar",
  cable: "cable station",
  machine: "machine",
  smith_machine: "Smith machine",
  bodyweight: "bodyweight",
};

function formatList(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function equipmentRequirementLabel(equipmentType: string): string {
  return (
    EQUIPMENT_REQUIREMENT_LABELS[equipmentType] ??
    equipmentType.replaceAll("_", " ")
  );
}

export function missingRequirementsSummary(
  requirements: EquipmentRequirement[]
): string | null {
  if (requirements.length === 0) return null;
  const labels = requirements.map((req) =>
    equipmentRequirementLabel(req.equipmentType)
  );
  return `Needs ${formatList(labels)}.`;
}

export function requirementSatisfied(
  req: EquipmentRequirement,
  inventory: InventoryItem[]
): boolean {
  if (req.equipmentType === "bodyweight") return true;
  return inventory.some(
    (item) =>
      item.available &&
      item.type === req.equipmentType &&
      (req.minWeight == null ||
        (item.attrs.maxWeight != null && item.attrs.maxWeight >= req.minWeight))
  );
}

export function exerciseIsAvailable(
  requirements: EquipmentRequirement[],
  inventory: InventoryItem[]
): boolean {
  return requirements.every((req) => requirementSatisfied(req, inventory));
}

/** Which requirements fail, for user-facing "needs X" messages. */
export function missingRequirements(
  requirements: EquipmentRequirement[],
  inventory: InventoryItem[]
): EquipmentRequirement[] {
  return requirements.filter((req) => !requirementSatisfied(req, inventory));
}
