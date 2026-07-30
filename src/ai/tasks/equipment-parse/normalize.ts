import type { z } from "zod";
import type { ConfirmedEquipmentItem } from "./confirm";
import type { equipmentItemSchema } from "./schema";
import { convertWeight, normalizeStoredLoad } from "@/lib/units";

type ParsedEquipmentItem = z.infer<typeof equipmentItemSchema>;
type Unit = "lb" | "kg";

const NON_LOAD_TYPES = new Set<ConfirmedEquipmentItem["type"]>([
  "rack",
  "bench",
  "bands",
  "jump_rope",
  "elliptical",
  "pullup_bar",
  "cable",
  "machine",
]);

function matches(label: string, pattern: RegExp): boolean {
  return pattern.test(label.toLowerCase());
}

function benchIncludesRackLikeSupport(label: string): boolean {
  return matches(
    label,
    /\bbench\s*(press\s*)?(station|unit)\b|\bbench\b.*\b(stands?|uprights?)\b/
  );
}

function describesRackLikeSupport(label: string): boolean {
  return matches(
    label,
    /\b(power|half|squat)\s*rack\b|\b(squat|barbell|bench\s*press)\s*stands?\b|\buprights?\b/
  );
}

function rackLikeSupportItem(label: string, quantity = 1): ConfirmedEquipmentItem {
  return {
    type: "rack",
    label,
    quantity,
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

function unitFromLabel(label: string): Unit | null {
  if (matches(label, /\b(lb|lbs|pound|pounds)\b/)) return "lb";
  if (matches(label, /\b(kg|kgs|kilogram|kilograms)\b/)) return "kg";
  return null;
}

function clearLoadFields(item: ConfirmedEquipmentItem): ConfirmedEquipmentItem {
  return {
    ...item,
    minWeight: null,
    maxWeight: null,
    unit: null,
    barWeight: null,
    increments: null,
  };
}

export function normalizeParsedEquipmentItem(
  parsed: ParsedEquipmentItem,
  fallbackUnit?: Unit
): ConfirmedEquipmentItem {
  const label = parsed.label.trim();
  let type = parsed.type as ConfirmedEquipmentItem["type"];

  if (matches(label, /\b(lat\s*pull[- ]?down|pulldown)\b/)) {
    type = "cable";
  }
  if (matches(label, /\bdip\s+(bar|bars|station)\b/)) {
    type = "machine";
  }
  if ((type === "barbell" || type === "other") && matches(label, /\b(trap|hex)\s+bar\b/)) {
    type = "trap_bar";
  }
  if (
    (type === "other" || type === "machine") &&
    describesRackLikeSupport(label)
  ) {
    type = "rack";
  }

  const weightedType =
    type === "barbell" ||
    type === "ez_bar" ||
    type === "dumbbell" ||
    type === "kettlebell" ||
    type === "plates";

  let item: ConfirmedEquipmentItem = {
    type,
    label,
    quantity: parsed.quantity,
    minWeight: parsed.attrs.minWeight,
    maxWeight: parsed.attrs.maxWeight,
    unit: parsed.attrs.unit ?? unitFromLabel(label) ?? (weightedType ? fallbackUnit ?? null : null),
    adjustable: parsed.attrs.adjustable,
    pair: parsed.attrs.pair,
    increments: parsed.attrs.increments,
    denominations: parsed.attrs.denominations?.length
      ? parsed.attrs.denominations.map((d) => ({
          weight: d.weight,
          quantity: d.quantity ?? 1,
        }))
      : null,
    brand: parsed.attrs.brand,
    barWeight: parsed.attrs.barWeight,
    adjustableBench: parsed.attrs.adjustableBench,
  };

  if ((item.type === "barbell" || item.type === "ez_bar") && item.barWeight == null) {
    const unit = item.unit ?? fallbackUnit ?? null;
    item = {
      ...item,
      unit,
      barWeight: item.maxWeight ?? item.minWeight,
      minWeight: null,
      maxWeight: null,
    };
  }

  if (
    (item.type === "barbell" || item.type === "ez_bar") &&
    item.barWeight != null &&
    item.unit != null &&
    fallbackUnit != null &&
    item.unit !== fallbackUnit
  ) {
    item = {
      ...item,
      statedBarWeight: item.barWeight,
      statedBarUnit: item.unit,
      barWeight: normalizeStoredLoad(convertWeight(item.barWeight, item.unit, fallbackUnit)),
      unit: fallbackUnit,
      barWeightConfirmed: false,
    };
  }

  if (NON_LOAD_TYPES.has(item.type)) {
    item = clearLoadFields(item);
  }
  if (
    item.type === "other" &&
    item.minWeight == null &&
    item.maxWeight == null &&
    item.barWeight == null &&
    item.denominations == null
  ) {
    item = { ...item, unit: null, increments: null };
  }

  if (item.type !== "dumbbell") {
    item = { ...item, pair: null };
  }
  if (item.type !== "dumbbell" && item.type !== "kettlebell") {
    item = { ...item, adjustable: null };
  }
  if (item.type !== "bench") {
    item = { ...item, adjustableBench: null };
  }
  if (item.type !== "plates") {
    item = { ...item, denominations: null };
  }

  return item;
}

export function expandRackLikeSupportItems(
  items: ConfirmedEquipmentItem[]
): ConfirmedEquipmentItem[] {
  if (items.some((item) => item.type === "rack")) return items;
  const benchWithSupport = items.find(
    (item) => item.type === "bench" && benchIncludesRackLikeSupport(item.label)
  );
  if (!benchWithSupport) return items;
  return [
    ...items,
    rackLikeSupportItem(
      `${benchWithSupport.label} rack-like support`,
      benchWithSupport.quantity
    ),
  ];
}
