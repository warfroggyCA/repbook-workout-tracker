import {
  EQUIPMENT_TYPE_VALUES,
  type EquipmentInventoryItem,
} from "@/lib/equipment-inventory-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Navigation hints only. Availability and saves still use owned server data. */
export function equipmentManagementHref(input: {
  itemIds?: string[];
  equipmentType?: string | null;
  equipmentDefinitionId?: string | null;
  returnTo?: string;
}) {
  const query = new URLSearchParams();
  for (const id of [...new Set(input.itemIds ?? [])].filter((id) => UUID.test(id)).slice(0, 20)) {
    query.append("item", id);
  }
  if (input.equipmentDefinitionId && UUID.test(input.equipmentDefinitionId)) {
    query.set("definition", input.equipmentDefinitionId);
  }
  if (input.equipmentType && EQUIPMENT_TYPE_VALUES.some((type) => type === input.equipmentType)) {
    query.set("type", input.equipmentType);
  }
  const returnTo = equipmentReturnHref(input.returnTo);
  if (returnTo) query.set("returnTo", returnTo);
  return `/settings/equipment${query.size ? `?${query}` : ""}`;
}

export function equipmentReturnHref(value: unknown): string | undefined {
  if (value === "/today" || value === "/coach") return value;
  if (typeof value === "string" && value.startsWith("/session/") && UUID.test(value.slice(9))) {
    return value;
  }
  return undefined;
}

export function equipmentAttentionIds(
  items: Array<Pick<EquipmentInventoryItem, "id" | "type">>,
  query: {
    item?: string | string[];
    type?: string | string[];
    definition?: string | string[];
  },
  definitions: Array<{ itemId: string; definitionId?: string }> = [],
): string[] {
  const ids = new Set(Array.isArray(query.item) ? query.item.slice(0, 20) : [query.item]);
  return items.flatMap((item) => {
    if (item.id == null) return [];
    if (query.item != null) return ids.has(item.id) ? [item.id] : [];
    const matches = query.definition != null
      ? definitions.some((definition) =>
          definition.itemId === item.id && definition.definitionId === query.definition)
      : item.type === query.type;
    return matches ? [item.id] : [];
  });
}
