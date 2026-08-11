import { sql, and, asc, eq, isNull, or, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  constraints as constraintsTable,
  exercises,
  programs,
  programVersions,
  workoutTemplates,
  workoutTemplateExercises,
} from "@/db/schema";
import type { EquipmentAttrs } from "@/db/schema/equipment";
import {
  associateBarConfigurations,
  synchronizeMatchedBarCopies,
  documentItemFromRow,
  type BarConfigurationItem,
  type EquipmentInventoryDocument,
  type EquipmentInventoryItem,
  type PlateInventoryItem,
} from "@/lib/equipment-inventory-contract";
import {
  buildEquipmentAvailability,
  exerciseIsAvailable,
  type EquipmentRequirement,
  type InventoryItem,
} from "@/engine/equipment-filter";
import { patternFlags } from "@/engine/constraint-filter";
import type { LoadUnit } from "@/lib/units";
import { equipmentLoadProfileSchema } from "@/lib/equipment-load-profile-contract";

/**
 * Deterministic revision over the complete current inventory representation.
 * The exact same SQL expression is evaluated by the loader (in the same
 * statement snapshot as the returned rows) and inside the atomic management
 * save gate, so a stale tab can never overwrite newer inventory.
 */
export function inventoryRevisionExpression(userId: string) {
  return sql`md5(
    coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)::text
              FROM equipment_items e WHERE e.user_id = ${userId}::uuid), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)::text
              FROM plate_inventory p WHERE p.user_id = ${userId}::uuid), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id)::text
              FROM barbell_configs b WHERE b.user_id = ${userId}::uuid), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id)::text
              FROM plate_loaded_machine_profiles m WHERE m.user_id = ${userId}::uuid), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(mp) ORDER BY mp.machine_profile_id, mp.plate_inventory_id)::text
              FROM plate_loaded_machine_compatible_plates mp WHERE mp.user_id = ${userId}::uuid), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)::text
              FROM cable_machine_profiles c WHERE c.user_id = ${userId}::uuid), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(cs) ORDER BY cs.cable_profile_id, cs.stack_index, cs.step_index)::text
              FROM cable_stack_steps cs WHERE cs.user_id = ${userId}::uuid), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)::text
              FROM cable_attachment_profiles a WHERE a.user_id = ${userId}::uuid), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(ca) ORDER BY ca.cable_profile_id, ca.attachment_profile_id)::text
              FROM cable_attachment_compatibilities ca WHERE ca.user_id = ${userId}::uuid), '[]')
    || coalesce((SELECT jsonb_agg(to_jsonb(fit) ORDER BY fit.exercise_id, fit.equipment_item_id)::text
              FROM exercise_equipment_fit_assertions fit WHERE fit.user_id = ${userId}::uuid), '[]')
  )`;
}

/** Call only from a query path that depends on an owner-profile FOR UPDATE row. */
export function inventoryRevisionAfterOwnerLockExpression(userId: string | SQL) {
  return sql`equipment_inventory_revision_after_owner_lock(${userId}::uuid)`;
}

export type LoadedInventoryDefinition = {
  itemId: string;
  label: string;
  description: string | null;
};

export type LoadedEquipmentInventory = {
  document: EquipmentInventoryDocument;
  profileUnit: LoadUnit;
  /** Definition text for definition-backed items, keyed by item ID. */
  definitions: LoadedInventoryDefinition[];
  /**
   * Read-only preflight: bar types with more than one active configuration.
   * This shape must stop the manager before save rather than merging or
   * silently choosing one configuration.
   */
  ambiguousBarTypes: string[];
};

type RawItemRow = {
  id: string;
  type: string;
  label: string;
  quantity: number;
  attrs: EquipmentAttrs;
  definition_label: string | null;
  definition_description: string | null;
};

type RawPlateRow = { id: string; denomination: string | number; quantity: number };

type RawBarRow = {
  id: string;
  bar_type: string;
  bar_weight: string | number;
  collar_weight: string | number;
  quantity: number;
  label: string;
};

/**
 * Owner-scoped inventory loader. One statement returns the active items,
 * plate pool, bar configurations, profile unit, and the deterministic
 * revision from a single snapshot, so the revision always matches the
 * returned document. Never cache this personalized result across users.
 */
export async function loadEquipmentInventoryDocument(
  db: Db,
  userId: string
): Promise<LoadedEquipmentInventory | null> {
  const query = sql`
    SELECT
      (SELECT unit FROM user_profiles WHERE user_id = ${userId}::uuid) AS profile_unit,
      coalesce((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', item.id, 'type', item.type, 'label', item.label,
            'quantity', item.quantity, 'attrs', item.attrs,
            'definition_label', definition.label,
            'definition_description', definition.description
          )
          ORDER BY item.created_at, item.id
        )
        FROM equipment_items item
        LEFT JOIN equipment_definitions definition ON definition.id = item.definition_id
        WHERE item.user_id = ${userId}::uuid AND item.available = true
      ), '[]'::jsonb) AS items,
      coalesce((
        SELECT jsonb_agg(to_jsonb(plate) ORDER BY plate.denomination DESC, plate.id)
        FROM plate_inventory plate
        WHERE plate.user_id = ${userId}::uuid
      ), '[]'::jsonb) AS plates,
      coalesce((
        SELECT jsonb_agg(to_jsonb(bar) ORDER BY bar.bar_type, bar.id)
        FROM barbell_configs bar
        WHERE bar.user_id = ${userId}::uuid
          AND (
            bar.equipment_item_id IS NULL
            OR bar.loading_kind IN ('olympic', 'ez')
          )
      ), '[]'::jsonb) AS bars,
      coalesce((
        SELECT jsonb_agg(profile_row ORDER BY profile_row->>'equipmentItemId')
        FROM (
          SELECT jsonb_build_object(
            'equipmentItemId', item.id,
            'profile', jsonb_build_object(
              'kind', 'plate_loaded_implement', 'id', profile.id,
              'loadingKind', profile.loading_kind,
              'emptyWeight', profile.bar_weight,
              'collarWeight', profile.collar_weight,
              'unit', profile.unit,
              'sharedPlatePoolCompatible', profile.shared_plate_pool_compatible
            )
          ) AS profile_row
          FROM barbell_configs profile
          JOIN equipment_items item ON item.id = profile.equipment_item_id
            AND item.user_id = profile.user_id
          WHERE profile.user_id = ${userId}::uuid

          UNION ALL

          SELECT jsonb_build_object(
            'equipmentItemId', item.id,
            'profile', jsonb_build_object(
              'kind', 'plate_loaded_machine', 'id', profile.id,
              'geometryCertainty', profile.geometry_certainty,
              'startingResistance', profile.starting_resistance,
              'startingResistanceUnit', profile.starting_resistance_unit,
              'loadingPointCount', profile.loading_point_count,
              'balancingRule', profile.balancing_rule,
              'targetEntryMeaning', profile.target_entry_meaning,
              'compatiblePlateIds', coalesce((
                SELECT jsonb_agg(link.plate_inventory_id ORDER BY link.plate_inventory_id)
                FROM plate_loaded_machine_compatible_plates link
                WHERE link.machine_profile_id = profile.id AND link.user_id = profile.user_id
              ), '[]'::jsonb)
            )
          )
          FROM plate_loaded_machine_profiles profile
          JOIN equipment_items item ON item.id = profile.equipment_item_id
            AND item.user_id = profile.user_id
          WHERE profile.user_id = ${userId}::uuid

          UNION ALL

          SELECT jsonb_build_object(
            'equipmentItemId', item.id,
            'profile', jsonb_build_object(
              'kind', 'cable_machine', 'id', profile.id,
              'geometryCertainty', profile.geometry_certainty,
              'stackCount', profile.stack_count, 'topology', profile.topology,
              'displayedUnit', profile.displayed_unit,
              'ratioStatus', profile.ratio_status,
              'ratioNumerator', profile.ratio_numerator,
              'ratioDenominator', profile.ratio_denominator,
              'stackSteps', coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', step.id, 'stackIndex', step.stack_index,
                  'stepIndex', step.step_index, 'displayedLoad', step.displayed_load,
                  'positionLabel', step.position_label
                ) ORDER BY step.stack_index, step.step_index)
                FROM cable_stack_steps step
                WHERE step.cable_profile_id = profile.id AND step.user_id = profile.user_id
              ), '[]'::jsonb),
              'compatibleAttachmentItemIds', coalesce((
                SELECT jsonb_agg(attachment.equipment_item_id ORDER BY attachment.equipment_item_id)
                FROM cable_attachment_compatibilities link
                JOIN cable_attachment_profiles attachment
                  ON attachment.id = link.attachment_profile_id AND attachment.user_id = link.user_id
                WHERE link.cable_profile_id = profile.id AND link.user_id = profile.user_id
              ), '[]'::jsonb)
            )
          )
          FROM cable_machine_profiles profile
          JOIN equipment_items item ON item.id = profile.equipment_item_id
            AND item.user_id = profile.user_id
          WHERE profile.user_id = ${userId}::uuid

          UNION ALL

          SELECT jsonb_build_object(
            'equipmentItemId', item.id,
            'profile', jsonb_build_object(
              'kind', 'attachment', 'id', profile.id,
              'attachmentKind', profile.attachment_kind,
              'connectionStandard', profile.connection_standard,
              'status', profile.status
            )
          )
          FROM cable_attachment_profiles profile
          JOIN equipment_items item ON item.id = profile.equipment_item_id
            AND item.user_id = profile.user_id
          WHERE profile.user_id = ${userId}::uuid
        ) exact_profiles
      ), '[]'::jsonb) AS load_profiles,
      ${inventoryRevisionExpression(userId)} AS revision
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row || row.profile_unit == null) return null;

  const itemRows = row.items as unknown as RawItemRow[];
  const plateRows = row.plates as unknown as RawPlateRow[];
  const barRows = row.bars as unknown as RawBarRow[];
  const loadProfileRows = row.load_profiles as unknown as Array<{
    equipmentItemId: string;
    profile: unknown;
  }>;

  const items: EquipmentInventoryItem[] = itemRows.map((item) =>
    documentItemFromRow({
      id: item.id,
      type: item.type,
      label: item.label,
      quantity: item.quantity,
      attrs: item.attrs ?? {},
    })
  );
  const plates: PlateInventoryItem[] = plateRows.map((plate) => ({
    id: plate.id,
    denomination: Number(plate.denomination),
    quantity: plate.quantity,
  }));
  const bars: BarConfigurationItem[] = barRows.map((bar) => ({
    id: bar.id,
    barType: bar.bar_type === "ez" ? "ez" : "olympic",
    barWeight: Number(bar.bar_weight),
    collarWeight: Number(bar.collar_weight),
    quantity: bar.quantity,
    label: bar.label,
  }));

  const barTypeCounts = new Map<string, number>();
  for (const bar of barRows) {
    barTypeCounts.set(bar.bar_type, (barTypeCounts.get(bar.bar_type) ?? 0) + 1);
  }

  return {
    document: {
      baseRevision: String(row.revision),
      items,
      plates,
      bars,
      loadProfiles: loadProfileRows.map((entry) => ({
        equipmentItemId: String(entry.equipmentItemId),
        profile: equipmentLoadProfileSchema.parse(entry.profile),
      })),
    },
    profileUnit: row.profile_unit === "kg" ? "kg" : "lb",
    definitions: itemRows
      .filter((item) => item.definition_label != null)
      .map((item) => ({
        itemId: item.id,
        label: item.definition_label as string,
        description: item.definition_description,
      })),
    ambiguousBarTypes: [...barTypeCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([barType]) => barType)
      .sort(),
  };
}

// ---------------------------------------------------------------------------
// Server-computed change and impact preview
// ---------------------------------------------------------------------------

export type InventoryItemChange = {
  id: string;
  label: string;
  type: string;
  changedFields: string[];
};

export type PlateChange = {
  denomination: number;
  fromQuantity: number | null;
  toQuantity: number | null;
};

export type BarChange = {
  barType: string;
  label: string;
  changedFields: string[];
  removed: boolean;
  added: boolean;
  before: Pick<BarConfigurationItem, "barWeight" | "collarWeight"> | null;
  after: Pick<BarConfigurationItem, "barWeight" | "collarWeight"> | null;
};

export type LoadProfileChange = {
  equipmentItemId: string;
  label: string;
  kind: string;
  change: "added" | "changed" | "removed";
  reducesGuidance: boolean;
};

export type InventoryImpact = {
  /** Exercises available now that would become unavailable after this save. */
  exercisesBecomingUnavailable: Array<{ id: string; name: string }>;
  /** Exercises unavailable now that would become available after this save. */
  exercisesBecomingAvailable: Array<{ id: string; name: string }>;
  /** Current-Program slots whose exercise would become unavailable. */
  affectedProgramSlots: Array<{ dayName: string; exerciseName: string }>;
  /** Retained exact-pair reviews whose current capability evidence will change. */
  fitReviewsRequiringReview: Array<{
    assertionId: string;
    exerciseName: string;
    equipmentLabel: string;
  }>;
};

export type InventoryChangePreview = {
  added: Array<{ label: string; type: string }>;
  changed: InventoryItemChange[];
  removed: Array<{ id: string; label: string; type: string }>;
  plateChanges: PlateChange[];
  barChanges: BarChange[];
  loadProfileChanges: LoadProfileChange[];
  impact: InventoryImpact;
  /** True when capability is reduced and an explicit confirmation is required. */
  requiresConfirmation: boolean;
  noChanges: boolean;
};

export type InventoryPreviewResult =
  | { ok: true; preview: InventoryChangePreview }
  | { ok: false; code: "stale" | "ambiguous_bars" | "unknown_ids" | "invalid"; reason: string };

function sameBar(before: BarConfigurationItem, after: BarConfigurationItem): boolean {
  return before.id === after.id &&
    before.barType === after.barType &&
    before.barWeight === after.barWeight &&
    before.collarWeight === after.collarWeight &&
    before.quantity === after.quantity &&
    before.label.trim() === after.label.trim();
}

export function validateBarDraftAgainstCurrent(
  current: EquipmentInventoryDocument,
  proposed: EquipmentInventoryDocument
): string | null {
  const proposedProfiles = new Map(
    (proposed.loadProfiles ?? []).map((entry) => [entry.equipmentItemId, entry.profile]),
  );
  for (const entry of current.loadProfiles ?? []) {
    if (
      entry.profile.kind !== "plate_loaded_implement" ||
      (entry.profile.loadingKind !== "trap_hex" &&
        entry.profile.loadingKind !== "specialty")
    ) continue;
    if (JSON.stringify(proposedProfiles.get(entry.equipmentItemId)) !== JSON.stringify(entry.profile)) {
      return "Reviewed trap/hex and specialty implement profiles must stay unchanged in this editor. Their exact values remain preserved.";
    }
  }
  const currentProfiles = new Map(
    (current.loadProfiles ?? []).map((entry) => [entry.equipmentItemId, entry.profile]),
  );
  for (const entry of proposed.loadProfiles ?? []) {
    if (
      entry.profile.kind !== "plate_loaded_implement" ||
      (entry.profile.loadingKind !== "trap_hex" &&
        entry.profile.loadingKind !== "specialty")
    ) continue;
    if (JSON.stringify(currentProfiles.get(entry.equipmentItemId)) !== JSON.stringify(entry.profile)) {
      return "Reviewed trap/hex and specialty implement profiles must stay unchanged in this editor. Their exact values remain preserved.";
    }
  }
  const currentAssociation = associateBarConfigurations(current.items, current.bars);
  const proposedAssociation = associateBarConfigurations(proposed.items, proposed.bars);
  const currentBarsById = new Map(
    current.bars.flatMap((bar) => (bar.id ? [[bar.id, bar] as const] : []))
  );

  for (const barIndex of currentAssociation.unmatchedBarIndexes) {
    const before = current.bars[barIndex];
    const after = before.id
      ? proposed.bars.find((bar) => bar.id === before.id)
      : undefined;
    if (!after || !sameBar(before, after)) {
      return "Unmatched saved bar configurations must stay unchanged. You can still edit unrelated inventory.";
    }
  }
  for (const bar of proposed.bars) {
    if (bar.id == null && proposedAssociation.unmatchedBarIndexes.includes(proposed.bars.indexOf(bar))) {
      return "A new Olympic or EZ bar needs one unambiguous empty bar weight before review.";
    }
    if (bar.id && !currentBarsById.has(bar.id)) {
      return "This draft refers to a saved bar configuration that is no longer available.";
    }
  }

  const currentMatchedByItemId = new Map(
    currentAssociation.matched.flatMap(({ itemIndex, barIndex }) => {
      const item = current.items[itemIndex];
      const bar = current.bars[barIndex];
      return item.id && bar.id ? [[item.id, bar.id] as const] : [];
    })
  );
  for (const [itemId, barId] of currentMatchedByItemId) {
    const hasItem = proposed.items.some((item) => item.id === itemId);
    const hasBar = proposed.bars.some((bar) => bar.id === barId);
    if (hasItem !== hasBar) {
      return "Remove a matched bar item and its saved configuration together, or keep both.";
    }
  }

  for (const itemIndex of proposedAssociation.missingItemIndexes) {
    const item = proposed.items[itemIndex];
    if (item.id == null) {
      return "A new Olympic or EZ bar needs an empty bar weight before review.";
    }
    const before = current.items.find((candidate) => candidate.id === item.id);
    if (before && (
      before.label !== item.label ||
      before.quantity !== item.quantity ||
      before.type !== item.type ||
      JSON.stringify(editableAttrsForCompare(before.attrs)) !==
        JSON.stringify(editableAttrsForCompare(item.attrs))
    )) {
      return "Record the empty bar weight before changing this legacy bar item.";
    }
  }
  return null;
}

function editableAttrsForCompare(attrs: EquipmentAttrs) {
  // Mirror the persistence merge: non-editable keys stay server-owned, so
  // change detection only considers the fields the editor can actually write.
  const { minWeight, maxWeight, unit, adjustable, pair, increments, adjustableBench, brand } =
    attrs;
  return { minWeight, maxWeight, unit, adjustable, pair, increments, adjustableBench, brand };
}

function changedItemFields(
  before: { label: string; type: string; quantity: number; attrs: EquipmentAttrs },
  after: EquipmentInventoryItem
): string[] {
  const changed: string[] = [];
  if (before.label.trim() !== after.label.trim()) changed.push("label");
  if (before.type !== after.type) changed.push("type");
  if (before.quantity !== after.quantity) changed.push("quantity");
  if (
    JSON.stringify(editableAttrsForCompare(before.attrs)) !==
    JSON.stringify(editableAttrsForCompare(after.attrs))
  ) {
    changed.push("details");
  }
  return changed;
}

function toFilterInventory(
  items: Array<{ type: string; attrs: EquipmentAttrs }>,
  plates: Array<{ denomination: number }>
): InventoryItem[] {
  return buildEquipmentAvailability(items.map((item) => ({
    type: item.type,
    available: true,
    attrs: item.attrs as InventoryItem["attrs"],
  })), plates);
}

/**
 * Compute the final change and impact preview on the server from the owned
 * current inventory and the submitted draft. The impact section is truthful
 * about current engine precision: availability uses broad equipment type,
 * active availability, constraints, and the optional maximum-weight
 * requirement — nothing else.
 */
export async function previewInventoryDocumentChanges(
  db: Db,
  userId: string,
  document: EquipmentInventoryDocument
): Promise<InventoryPreviewResult> {
  document = synchronizeMatchedBarCopies(document);
  const current = await loadEquipmentInventoryDocument(db, userId);
  if (!current) {
    return { ok: false, code: "stale", reason: "Your account could not be loaded." };
  }
  if (document.baseRevision !== current.document.baseRevision) {
    return {
      ok: false,
      code: "stale",
      reason:
        "Your inventory changed somewhere else after this page loaded. Reload the current inventory before reviewing changes.",
    };
  }

  const currentItemsById = new Map(
    current.document.items.map((item) => [item.id as string, item])
  );
  const submittedIds = new Set(
    document.items.flatMap((item) => (item.id ? [item.id] : []))
  );
  const unknownIds = [...submittedIds].filter((id) => !currentItemsById.has(id));
  const currentPlateIds = new Set(current.document.plates.map((plate) => plate.id));
  const currentBarIds = new Set(current.document.bars.map((bar) => bar.id));
  unknownIds.push(
    ...document.plates.flatMap((plate) =>
      plate.id && !currentPlateIds.has(plate.id) ? [plate.id] : []
    ),
    ...document.bars.flatMap((bar) =>
      bar.id && !currentBarIds.has(bar.id) ? [bar.id] : []
    )
  );
  if (unknownIds.length > 0) {
    return {
      ok: false,
      code: "unknown_ids",
      reason:
        "This draft refers to saved records that no longer exist in your inventory. Reload the current inventory and try again.",
    };
  }
  const barDraftIssue = validateBarDraftAgainstCurrent(current.document, document);
  if (barDraftIssue) {
    return { ok: false, code: "invalid", reason: barDraftIssue };
  }

  const added = document.items
    .filter((item) => item.id == null)
    .map((item) => ({ label: item.label, type: item.type }));
  const changed: InventoryItemChange[] = [];
  for (const item of document.items) {
    if (item.id == null) continue;
    const before = currentItemsById.get(item.id);
    if (!before) continue;
    const fields = changedItemFields(before, item);
    if (fields.length > 0) {
      changed.push({ id: item.id, label: item.label, type: item.type, changedFields: fields });
    }
  }
  const removed = current.document.items
    .filter((item) => !submittedIds.has(item.id as string))
    .map((item) => ({ id: item.id as string, label: item.label, type: item.type }));

  const plateChanges: PlateChange[] = [];
  const submittedPlatesById = new Map(
    document.plates.flatMap((plate) => (plate.id ? [[plate.id, plate] as const] : []))
  );
  for (const plate of current.document.plates) {
    const after = submittedPlatesById.get(plate.id as string);
    if (!after) {
      plateChanges.push({
        denomination: plate.denomination,
        fromQuantity: plate.quantity,
        toQuantity: null,
      });
    } else if (
      after.quantity !== plate.quantity ||
      after.denomination !== plate.denomination
    ) {
      plateChanges.push({
        denomination: after.denomination,
        fromQuantity: plate.quantity,
        toQuantity: after.quantity,
      });
    }
  }
  for (const plate of document.plates) {
    if (plate.id == null) {
      plateChanges.push({
        denomination: plate.denomination,
        fromQuantity: null,
        toQuantity: plate.quantity,
      });
    }
  }

  const barChanges: BarChange[] = [];
  const submittedBarsById = new Map(
    document.bars.flatMap((bar) => (bar.id ? [[bar.id, bar] as const] : []))
  );
  for (const bar of current.document.bars) {
    const after = submittedBarsById.get(bar.id as string);
    if (!after) {
      barChanges.push({
        barType: bar.barType,
        label: bar.label,
        changedFields: [],
        removed: true,
        added: false,
        before: { barWeight: bar.barWeight, collarWeight: bar.collarWeight },
        after: null,
      });
      continue;
    }
    const fields: string[] = [];
    if (after.barWeight !== bar.barWeight) fields.push("bar weight");
    if (after.collarWeight !== bar.collarWeight) fields.push("collar weight");
    if (after.quantity !== bar.quantity) fields.push("quantity");
    if (after.label.trim() !== bar.label.trim()) fields.push("label");
    if (fields.length > 0) {
      barChanges.push({
        barType: bar.barType,
        label: after.label,
        changedFields: fields,
        removed: false,
        added: false,
        before: { barWeight: bar.barWeight, collarWeight: bar.collarWeight },
        after: { barWeight: after.barWeight, collarWeight: after.collarWeight },
      });
    }
  }
  for (const bar of document.bars) {
    if (bar.id == null) {
      barChanges.push({
        barType: bar.barType,
        label: bar.label,
        changedFields: [],
        removed: false,
        added: true,
        before: null,
        after: { barWeight: bar.barWeight, collarWeight: bar.collarWeight },
      });
    }
  }

  const currentProfiles = new Map(
    (current.document.loadProfiles ?? []).map((entry) => [entry.equipmentItemId, entry.profile]),
  );
  const proposedProfiles = new Map(
    (document.loadProfiles ?? []).map((entry) => [entry.equipmentItemId, entry.profile]),
  );
  const itemLabels = new Map(
    [...current.document.items, ...document.items].flatMap((item) =>
      item.id ? [[item.id, item.label] as const] : []
    ),
  );
  const loadProfileChanges: LoadProfileChange[] = [];
  for (const equipmentItemId of new Set([
    ...currentProfiles.keys(),
    ...proposedProfiles.keys(),
  ])) {
    const before = currentProfiles.get(equipmentItemId);
    const after = proposedProfiles.get(equipmentItemId);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const beforeCertainty = before && "geometryCertainty" in before
      ? before.geometryCertainty
      : null;
    const afterCertainty = after && "geometryCertainty" in after
      ? after.geometryCertainty
      : null;
    loadProfileChanges.push({
      equipmentItemId,
      label: itemLabels.get(equipmentItemId) ?? "Saved equipment",
      kind: after?.kind ?? before?.kind ?? "exact_setup",
      change: before == null ? "added" : after == null ? "removed" : "changed",
      reducesGuidance:
        after == null ||
        (beforeCertainty === "known" && afterCertainty !== "known") ||
        (before?.kind === "plate_loaded_implement" &&
          after?.kind === "plate_loaded_implement" &&
          before.sharedPlatePoolCompatible && !after.sharedPlatePoolCompatible),
    });
  }

  const semanticItemIds = new Set([
    ...changed
      .filter((item) => item.changedFields.some((field) => field !== "label"))
      .map((item) => item.id),
    ...removed.map((item) => item.id),
  ]);
  const reviewAllFitAssertions =
    plateChanges.length > 0
    || loadProfileChanges.length > 0
    || barChanges.some(
      (change) =>
        change.added
        || change.removed
        || change.changedFields.some((field) => field !== "label"),
    );
  const affectedFitRows =
    reviewAllFitAssertions || semanticItemIds.size > 0
      ? resultRows(await db.execute(sql`
          SELECT
            assertion.id AS assertion_id,
            exercise.name AS exercise_name,
            item.label AS equipment_label
          FROM exercise_equipment_fit_assertions assertion
          JOIN exercises exercise ON exercise.id = assertion.exercise_id
          JOIN equipment_items item
            ON item.id = assertion.equipment_item_id
           AND item.user_id = assertion.user_id
          WHERE assertion.user_id = ${userId}::uuid
            AND (
              ${reviewAllFitAssertions}::boolean
              OR assertion.equipment_item_id IN (
                SELECT value::uuid
                FROM jsonb_array_elements_text(${JSON.stringify([...semanticItemIds])}::jsonb)
              )
            )
          ORDER BY exercise.name, item.label, assertion.id
        `))
      : [];
  const impact: InventoryImpact = {
    ...(await calculateAvailabilityImpact(
      db,
      userId,
      current.document.items,
      document.items,
      current.document.plates,
      document.plates,
    )),
    fitReviewsRequiringReview: affectedFitRows.map((row) => ({
      assertionId: String(row.assertion_id),
      exerciseName: String(row.exercise_name),
      equipmentLabel: String(row.equipment_label),
    })),
  };

  const loadRangeReduced = document.items.some((item) => {
    if (item.id == null) return false;
    const before = currentItemsById.get(item.id);
    const beforeMax = before?.attrs.maxWeight;
    const afterMax = item.attrs.maxWeight;
    return beforeMax != null && (afterMax == null ? false : afterMax < beforeMax);
  });
  const requiresConfirmation =
    removed.length > 0 ||
    plateChanges.some(
      (change) =>
        change.toQuantity == null ||
        (change.fromQuantity != null && change.toQuantity < change.fromQuantity)
    ) ||
    barChanges.some((change) => change.removed) ||
    loadRangeReduced ||
    loadProfileChanges.some((change) => change.reducesGuidance) ||
    impact.exercisesBecomingUnavailable.length > 0 ||
    impact.fitReviewsRequiringReview.length > 0;

  const noChanges =
    added.length === 0 &&
    changed.length === 0 &&
    removed.length === 0 &&
    plateChanges.length === 0 &&
    barChanges.length === 0 &&
    loadProfileChanges.length === 0;

  return {
    ok: true,
    preview: {
      added,
      changed,
      removed,
      plateChanges,
      barChanges,
      loadProfileChanges,
      impact,
      requiresConfirmation,
      noChanges,
    },
  };
}

/**
 * Truthful before/after availability using the exact deterministic engine
 * rules (equipment type, availability, constraints, optional max-weight).
 */
async function calculateAvailabilityImpact(
  db: Db,
  userId: string,
  currentItems: Array<{ type: string; attrs: EquipmentAttrs }>,
  proposedItems: Array<{ type: string; attrs: EquipmentAttrs }>,
  currentPlates: Array<{ denomination: number }>,
  proposedPlates: Array<{ denomination: number }>
): Promise<InventoryImpact> {
  const [exerciseRows, constraintRows, programSlots] = await Promise.all([
    db.query.exercises.findMany({
      where: or(isNull(exercises.userId), eq(exercises.userId, userId)),
      with: { equipmentRequirements: true },
      orderBy: asc(exercises.name),
    }),
    db.query.constraints.findMany({
      where: eq(constraintsTable.userId, userId),
    }),
    db
      .select({
        exerciseId: workoutTemplateExercises.exerciseId,
        dayName: workoutTemplates.name,
        exerciseName: exercises.name,
      })
      .from(programs)
      .innerJoin(programVersions, eq(programVersions.id, programs.currentVersionId))
      .innerJoin(
        workoutTemplates,
        eq(workoutTemplates.programVersionId, programVersions.id)
      )
      .innerJoin(
        workoutTemplateExercises,
        eq(workoutTemplateExercises.workoutTemplateId, workoutTemplates.id)
      )
      .innerJoin(exercises, eq(exercises.id, workoutTemplateExercises.exerciseId))
      .where(and(eq(programs.userId, userId), eq(programs.status, "active"))),
  ]);

  const flags = patternFlags(constraintRows);
  const before = toFilterInventory(currentItems, currentPlates);
  const after = toFilterInventory(proposedItems, proposedPlates);

  const becomingUnavailable: Array<{ id: string; name: string }> = [];
  const becomingAvailable: Array<{ id: string; name: string }> = [];
  const unavailableIds = new Set<string>();
  for (const exercise of exerciseRows) {
    if (flags.get(exercise.movementPattern)?.avoid) continue;
    const requirements = exercise.equipmentRequirements as EquipmentRequirement[];
    const availableBefore = exerciseIsAvailable(requirements, before);
    const availableAfter = exerciseIsAvailable(requirements, after);
    if (availableBefore && !availableAfter) {
      becomingUnavailable.push({ id: exercise.id, name: exercise.name });
      unavailableIds.add(exercise.id);
    } else if (!availableBefore && availableAfter) {
      becomingAvailable.push({ id: exercise.id, name: exercise.name });
    }
  }

  return {
    exercisesBecomingUnavailable: becomingUnavailable,
    exercisesBecomingAvailable: becomingAvailable,
    affectedProgramSlots: programSlots
      .filter((slot) => unavailableIds.has(slot.exerciseId))
      .map((slot) => ({ dayName: slot.dayName, exerciseName: slot.exerciseName })),
    fitReviewsRequiringReview: [],
  };
}
