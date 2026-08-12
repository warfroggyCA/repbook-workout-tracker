import "server-only";

import { sql, type SQL } from "drizzle-orm";

/**
 * Deterministic semantic revision for one stable exercise/item pair. Labels,
 * display descriptions, and timestamps are intentionally excluded: they are
 * presentation/provenance, not proof that a movement can be performed. The
 * item capability, exact/broad exercise requirements, and item-bound topology
 * are included, so changed physical evidence makes a prior review stale.
 */
export function exerciseEquipmentFitEvidenceRevisionExpression(
  userId: string,
  exerciseId: string | SQL,
  equipmentItemId: string | SQL,
) {
  return sql`md5(concat_ws('|',
    coalesce((
      SELECT jsonb_build_object(
        'id', evidence_item.id,
        'type', evidence_item.type,
        'definitionId', evidence_item.definition_id,
        'definitionKey', evidence_definition.key,
        'definitionCategory', evidence_definition.category,
        'quantity', evidence_item.quantity,
        'attrs', evidence_item.attrs,
        'available', evidence_item.available
      )::text
      FROM equipment_items evidence_item
      LEFT JOIN equipment_definitions evidence_definition
        ON evidence_definition.id = evidence_item.definition_id
      WHERE evidence_item.id = ${equipmentItemId}::uuid
        AND evidence_item.user_id = ${userId}::uuid
    ), 'missing-item'),
    coalesce((
      SELECT jsonb_agg(jsonb_build_array(
        evidence_requirement.id,
        evidence_requirement.equipment_type,
        evidence_requirement.equipment_definition_id,
        evidence_requirement_definition.key,
        evidence_requirement_definition.category,
        evidence_requirement.min_weight
      ) ORDER BY evidence_requirement.id)::text
      FROM exercise_equipment_requirements evidence_requirement
      LEFT JOIN equipment_definitions evidence_requirement_definition
        ON evidence_requirement_definition.id = evidence_requirement.equipment_definition_id
      WHERE evidence_requirement.exercise_id = ${exerciseId}::uuid
    ), '[]'),
    coalesce((
      SELECT jsonb_build_object(
        'id', evidence_execution_requirement.id,
        'profileKind', evidence_execution_requirement.required_profile_kind,
        'equipmentDefinitionId', evidence_execution_requirement.required_equipment_definition_id,
        'equipmentDefinitionKey', evidence_equipment_definition.key,
        'attachmentKind', evidence_execution_requirement.required_attachment_kind,
        'attachmentDefinitionId', evidence_execution_requirement.required_attachment_definition_id,
        'attachmentDefinitionKey', evidence_attachment_definition.key,
        'knownGeometry', evidence_execution_requirement.requires_known_geometry
      )::text
      FROM exercise_execution_requirements evidence_execution_requirement
      LEFT JOIN equipment_definitions evidence_equipment_definition
        ON evidence_equipment_definition.id = evidence_execution_requirement.required_equipment_definition_id
      LEFT JOIN equipment_definitions evidence_attachment_definition
        ON evidence_attachment_definition.id = evidence_execution_requirement.required_attachment_definition_id
      WHERE evidence_execution_requirement.exercise_id = ${exerciseId}::uuid
    ), 'no-exact-requirement'),
    coalesce((
      SELECT jsonb_agg(jsonb_build_array(
        config.id,
        config.bar_type,
        config.unit,
        config.loading_kind,
        config.shared_plate_pool_compatible,
        config.bar_weight,
        config.collar_weight,
        config.quantity
      ) ORDER BY config.id)::text
      FROM barbell_configs config
      WHERE config.user_id = ${userId}::uuid
        AND config.equipment_item_id = ${equipmentItemId}::uuid
    ), '[]'),
    coalesce((
      SELECT jsonb_agg(jsonb_build_array(
        profile.id,
        profile.geometry_certainty,
        profile.starting_resistance,
        profile.starting_resistance_unit,
        profile.loading_point_count,
        profile.balancing_rule,
        profile.target_entry_meaning
      ) ORDER BY profile.id)::text
      FROM plate_loaded_machine_profiles profile
      WHERE profile.user_id = ${userId}::uuid
        AND profile.equipment_item_id = ${equipmentItemId}::uuid
    ), '[]'),
    coalesce((
      SELECT jsonb_agg(jsonb_build_array(
        link.machine_profile_id,
        plate.id,
        plate.denomination,
        plate.unit,
        plate.quantity
      ) ORDER BY link.machine_profile_id, plate.id)::text
      FROM plate_loaded_machine_profiles profile
      JOIN plate_loaded_machine_compatible_plates link
        ON link.machine_profile_id = profile.id
       AND link.user_id = profile.user_id
      JOIN plate_inventory plate
        ON plate.id = link.plate_inventory_id
       AND plate.user_id = link.user_id
      WHERE profile.user_id = ${userId}::uuid
        AND profile.equipment_item_id = ${equipmentItemId}::uuid
    ), '[]'),
    coalesce((
      SELECT jsonb_agg(jsonb_build_array(
        profile.id,
        profile.geometry_certainty,
        profile.stack_count,
        profile.topology,
        profile.displayed_unit,
        profile.ratio_status,
        profile.ratio_numerator,
        profile.ratio_denominator
      ) ORDER BY profile.id)::text
      FROM cable_machine_profiles profile
      WHERE profile.user_id = ${userId}::uuid
        AND profile.equipment_item_id = ${equipmentItemId}::uuid
    ), '[]'),
    coalesce((
      SELECT jsonb_agg(jsonb_build_array(
        step.id,
        step.cable_profile_id,
        step.stack_index,
        step.step_index,
        step.position_label,
        step.displayed_load
      ) ORDER BY step.cable_profile_id, step.stack_index, step.step_index)::text
      FROM cable_machine_profiles profile
      JOIN cable_stack_steps step
        ON step.cable_profile_id = profile.id
       AND step.user_id = profile.user_id
      WHERE profile.user_id = ${userId}::uuid
        AND profile.equipment_item_id = ${equipmentItemId}::uuid
    ), '[]'),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'cableProfileId', cable_profile.id,
        'cableItemId', cable_item.id,
        'cableDefinitionId', cable_item.definition_id,
        'cableDefinitionKey', cable_definition.key,
        'cableDefinitionCategory', cable_definition.category,
        'cableAttrs', cable_item.attrs,
        'cableAvailable', cable_item.available,
        'attachmentProfileId', attachment_profile.id,
        'attachmentItemId', attachment_item.id,
        'attachmentDefinitionId', attachment_item.definition_id,
        'attachmentDefinitionKey', attachment_definition.key,
        'attachmentDefinitionCategory', attachment_definition.category,
        'attachmentAttrs', attachment_item.attrs,
        'attachmentAvailable', attachment_item.available,
        'attachmentKind', attachment_profile.attachment_kind,
        'connectionStandard', attachment_profile.connection_standard,
        'attachmentStatus', attachment_profile.status
      ) ORDER BY cable_profile.id, attachment_profile.id)::text
      FROM cable_attachment_compatibilities compatibility
      JOIN cable_machine_profiles cable_profile
        ON cable_profile.id = compatibility.cable_profile_id
       AND cable_profile.user_id = compatibility.user_id
      JOIN equipment_items cable_item
        ON cable_item.id = cable_profile.equipment_item_id
       AND cable_item.user_id = compatibility.user_id
      LEFT JOIN equipment_definitions cable_definition
        ON cable_definition.id = cable_item.definition_id
      JOIN cable_attachment_profiles attachment_profile
        ON attachment_profile.id = compatibility.attachment_profile_id
       AND attachment_profile.user_id = compatibility.user_id
      JOIN equipment_items attachment_item
        ON attachment_item.id = attachment_profile.equipment_item_id
       AND attachment_item.user_id = compatibility.user_id
      LEFT JOIN equipment_definitions attachment_definition
        ON attachment_definition.id = attachment_item.definition_id
      WHERE compatibility.user_id = ${userId}::uuid
        AND (
          cable_profile.equipment_item_id = ${equipmentItemId}::uuid
          OR attachment_profile.equipment_item_id = ${equipmentItemId}::uuid
        )
    ), '[]')
  ))`;
}
