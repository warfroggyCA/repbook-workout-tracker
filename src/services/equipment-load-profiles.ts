import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  equipmentLoadProfileSchema,
  type EquipmentLoadProfile,
} from "@/lib/equipment-load-profile-contract";

export type LoadedEquipmentLoadProfile = {
  equipmentItemId: string;
  itemType: string;
  itemAttrs?: Record<string, unknown>;
  itemLabel: string;
  equipmentDefinitionId: string | null;
  equipmentDefinitionKey: string | null;
  available: boolean;
  profile: EquipmentLoadProfile;
};

type RawProfileRow = {
  equipment_item_id: string;
  item_type: string;
  item_attrs: Record<string, unknown>;
  item_label: string;
  definition_id: string | null;
  definition_key: string | null;
  available: boolean;
  profile: unknown;
};

/**
 * One owner-scoped projection of every executable equipment profile. This is
 * the only live-inventory shape workout candidate resolution consumes; History
 * reads immutable session snapshots instead.
 */
export async function loadEquipmentLoadProfiles(
  db: Db,
  userId: string,
): Promise<LoadedEquipmentLoadProfile[]> {
  const rows = resultRows(await db.execute(sql`
    SELECT item.id AS equipment_item_id, item.type::text AS item_type,
           item.label AS item_label, item.definition_id,
           definition.key AS definition_key, item.available, item.attrs AS item_attrs,
           jsonb_build_object(
             'kind', 'plate_loaded_implement',
             'id', profile.id,
             'loadingKind', profile.loading_kind,
             'emptyWeight', profile.bar_weight,
             'collarWeight', profile.collar_weight,
             'unit', profile.unit,
             'sharedPlatePoolCompatible', profile.shared_plate_pool_compatible
           ) AS profile
    FROM barbell_configs profile
    JOIN equipment_items item
      ON item.id = profile.equipment_item_id
     AND item.user_id = profile.user_id
    LEFT JOIN equipment_definitions definition ON definition.id = item.definition_id
    WHERE profile.user_id = ${userId}::uuid

    UNION ALL

    SELECT item.id, item.type::text, item.label, item.definition_id,
           definition.key, item.available, item.attrs,
           jsonb_build_object(
             'kind', 'plate_loaded_machine',
             'id', profile.id,
             'geometryCertainty', profile.geometry_certainty,
             'startingResistance', profile.starting_resistance,
             'startingResistanceUnit', profile.starting_resistance_unit,
             'loadingPointCount', profile.loading_point_count,
             'balancingRule', profile.balancing_rule,
             'targetEntryMeaning', profile.target_entry_meaning,
             'compatiblePlateIds', coalesce((
               SELECT jsonb_agg(link.plate_inventory_id ORDER BY link.plate_inventory_id)
               FROM plate_loaded_machine_compatible_plates link
               WHERE link.machine_profile_id = profile.id
                 AND link.user_id = profile.user_id
             ), '[]'::jsonb)
           )
    FROM plate_loaded_machine_profiles profile
    JOIN equipment_items item
      ON item.id = profile.equipment_item_id
     AND item.user_id = profile.user_id
    LEFT JOIN equipment_definitions definition ON definition.id = item.definition_id
    WHERE profile.user_id = ${userId}::uuid

    UNION ALL

    SELECT item.id, item.type::text, item.label, item.definition_id,
           definition.key, item.available, item.attrs,
           jsonb_build_object(
             'kind', 'cable_machine',
             'id', profile.id,
             'geometryCertainty', profile.geometry_certainty,
             'stackCount', profile.stack_count,
             'topology', profile.topology,
             'displayedUnit', profile.displayed_unit,
             'ratioStatus', profile.ratio_status,
             'ratioNumerator', profile.ratio_numerator,
             'ratioDenominator', profile.ratio_denominator,
             'stackSteps', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                 'id', step.id,
                 'stackIndex', step.stack_index,
                 'stepIndex', step.step_index,
                 'displayedLoad', step.displayed_load,
                 'positionLabel', step.position_label
               ) ORDER BY step.stack_index, step.step_index)
               FROM cable_stack_steps step
               WHERE step.cable_profile_id = profile.id
                 AND step.user_id = profile.user_id
             ), '[]'::jsonb),
             'compatibleAttachmentItemIds', coalesce((
               SELECT jsonb_agg(attachment.equipment_item_id ORDER BY attachment.equipment_item_id)
               FROM cable_attachment_compatibilities link
               JOIN cable_attachment_profiles attachment
                 ON attachment.id = link.attachment_profile_id
                AND attachment.user_id = link.user_id
               WHERE link.cable_profile_id = profile.id
                 AND link.user_id = profile.user_id
             ), '[]'::jsonb)
           )
    FROM cable_machine_profiles profile
    JOIN equipment_items item
      ON item.id = profile.equipment_item_id
     AND item.user_id = profile.user_id
    LEFT JOIN equipment_definitions definition ON definition.id = item.definition_id
    WHERE profile.user_id = ${userId}::uuid

    UNION ALL

    SELECT item.id, item.type::text, item.label, item.definition_id,
           definition.key, item.available, item.attrs,
           jsonb_build_object(
             'kind', 'attachment',
             'id', profile.id,
             'attachmentKind', profile.attachment_kind,
             'connectionStandard', profile.connection_standard,
             'status', profile.status
           )
    FROM cable_attachment_profiles profile
    JOIN equipment_items item
      ON item.id = profile.equipment_item_id
     AND item.user_id = profile.user_id
    LEFT JOIN equipment_definitions definition ON definition.id = item.definition_id
    WHERE profile.user_id = ${userId}::uuid

    ORDER BY item_label, equipment_item_id
  `)) as unknown as RawProfileRow[];

  return rows.map((row) => ({
    equipmentItemId: String(row.equipment_item_id),
    itemType: String(row.item_type),
    itemAttrs: row.item_attrs ?? {},
    itemLabel: String(row.item_label),
    equipmentDefinitionId:
      row.definition_id == null ? null : String(row.definition_id),
    equipmentDefinitionKey:
      row.definition_key == null ? null : String(row.definition_key),
    available: Boolean(row.available),
    profile: equipmentLoadProfileSchema.parse(row.profile),
  }));
}
