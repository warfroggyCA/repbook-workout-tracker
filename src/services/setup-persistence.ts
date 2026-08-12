import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import type { ConfirmedEquipmentItem } from "@/ai/tasks/equipment-parse/confirm";
import type { EquipmentAttrs } from "@/db/schema/equipment";
import {
  EDITABLE_ATTR_KEYS,
  associateBarConfigurations,
  synchronizeMatchedBarCopies,
  validateEquipmentInventoryDocument,
} from "@/lib/equipment-inventory-contract";
import {
  inventoryRevisionAfterOwnerLockExpression,
  loadEquipmentInventoryDocument,
  validateBarDraftAgainstCurrent,
} from "@/services/equipment-inventory";

type PersistenceResult =
  | { ok: true; changed: boolean; versionCount: number }
  | { ok: false; reason: string };

export type ManagementInventorySaveResult =
  | {
      ok: true;
      changed: boolean;
      versionCount: number;
      counts: {
        addedItems: number;
        updatedItems: number;
        retiredItems: number;
        plateWrites: number;
        barWrites: number;
      };
    }
  | {
      ok: false;
      code: "invalid" | "stale" | "unknown_ids" | "ambiguous_bars" | "failed";
      reason: string;
    };

export type ConstraintRegionSave = {
  bodyPart: string;
  avoidPatterns: string[];
  cautiousPatterns: string[];
  painStopThreshold: number;
  note: string | null;
};

function completedStepsExpression(step: string) {
  return sql`jsonb_set(
    setup_state,
    '{completedSteps}',
    (
      SELECT COALESCE(jsonb_agg(value ORDER BY first_seen), '[]'::jsonb)
      FROM (
        SELECT value, min(ordinality) AS first_seen
        FROM jsonb_array_elements_text(
          COALESCE(setup_state->'completedSteps', '[]'::jsonb) || to_jsonb(${step}::text)
        ) WITH ORDINALITY AS steps(value, ordinality)
        GROUP BY value
      ) unique_steps
    ),
    true
  )`;
}

function inventoryAttrs(item: ConfirmedEquipmentItem): EquipmentAttrs {
  const attrs: EquipmentAttrs = {};
  if (item.minWeight != null) attrs.minWeight = item.minWeight;
  if (item.maxWeight != null) attrs.maxWeight = item.maxWeight;
  if (item.unit != null) attrs.unit = item.unit;
  if (item.adjustable != null) attrs.adjustable = item.adjustable;
  if (item.pair != null) attrs.pair = item.pair;
  if (item.increments != null) attrs.increments = item.increments;
  if (item.brand != null) attrs.brand = item.brand;
  if (item.adjustableBench != null) attrs.adjustableBench = item.adjustableBench;
  return attrs;
}

/** Editable attribute keys as one non-null-only client payload. */
function pickEditableAttrs(
  attrs: Record<string, unknown>
): Record<string, unknown> {
  const editable: Record<string, unknown> = {};
  for (const key of EDITABLE_ATTR_KEYS) {
    const value = attrs[key];
    if (value != null) editable[key] = value;
  }
  return editable;
}

/**
 * The attribute keys the editors may write, as a SQL text[] literal. On an
 * update these keys are replaced from the validated client input while every
 * other stored attribute (levels, notes, and future keys) is preserved from
 * the re-read base row, so a client can never smuggle or drop a server-owned
 * value.
 */
const EDITABLE_ATTR_KEYS_SQL = sql.raw(
  `ARRAY[${EDITABLE_ATTR_KEYS.map((key) => `'${key}'`).join(", ")}]::text[]`
);

type EquipmentSqlInput = {
  input_id: string;
  candidate_id: string;
  requested_id: string | null;
  type: string;
  label: string;
  quantity: number;
  attrs: Record<string, unknown>;
};

type PlateSqlInput = {
  input_id: string;
  candidate_id: string;
  requested_id: string | null;
  denomination: number;
  quantity: number;
};

type BarSqlInput = {
  input_id: string;
  candidate_id: string;
  requested_id: string | null;
  bar_type: string;
  bar_weight: number;
  /** null preserves the stored collar weight (first-time onboarding path). */
  collar_weight: number | null;
  quantity: number;
  label: string;
  equipment_item_id: string | null;
  unit: "lb" | "kg" | null;
  loading_kind: string | null;
  shared_plate_pool_compatible: boolean | null;
  profile_supplied: boolean;
};

type LoadProfileSqlInput = {
  equipment_item_id: string;
  profile: Record<string, unknown>;
};

type InventorySaveCore = {
  mode: "onboarding" | "management";
  parsingEventId: string | null;
  /** Redacted confirmation payload written onto the claimed AI parse event. */
  confirmedPayload: unknown;
  expectedRevision: string | null;
  equipmentInput: EquipmentSqlInput[];
  plateInput: PlateSqlInput[];
  barInput: BarSqlInput[];
  loadProfileInput: LoadProfileSqlInput[];
};

/**
 * One atomic inventory diff shared by first-time onboarding and returning-user
 * management. Both modes update retained rows in place, reactivate a matching
 * retired item that is intentionally re-added, insert new rows, retire
 * intentionally omitted active equipment, refuse foreign or unknown stable
 * IDs, preserve server-owned attributes and definitions on retained rows, and
 * version every meaningful change in the same statement.
 *
 * Mode differences:
 * - onboarding marks the setup step, may confirm one AI parse event, and
 *   keeps its established audit on every save;
 * - management verifies the expected inventory revision, refuses an ambiguous
 *   multiple-bar-configuration shape, never touches setup state or AI events,
 *   and writes neither versions nor audit for a no-op submission.
 */
async function executeInventorySave(
  db: Db,
  userId: string,
  core: InventorySaveCore
): Promise<Record<string, unknown> | undefined> {
  const { equipmentInput, plateInput, barInput, loadProfileInput, parsingEventId } = core;
  const isManagement = core.mode === "management";
  const expectedRevision = core.expectedRevision;
  const auditAction = isManagement
    ? "equipment.manage.save"
    : parsingEventId
      ? "setup.equipment.confirm"
      : "setup.equipment.save";
  const auditSummary = isManagement
    ? "Updated the equipment inventory from Settings management"
    : "Saved the equipment inventory with stable record history";

  const query = sql`
    WITH target_profile AS MATERIALIZED (
      SELECT id, user_id, setup_state
      FROM user_profiles
      WHERE user_id = ${userId}::uuid
      FOR UPDATE
    ), target_event AS MATERIALIZED (
      SELECT id
      FROM ai_parsing_events
      WHERE id = ${parsingEventId}::uuid
        AND user_id = ${userId}::uuid
        AND scope = 'setup'
        AND confirmed = false
      FOR UPDATE
    ), current_revision AS MATERIALIZED (
      SELECT ${inventoryRevisionAfterOwnerLockExpression(sql`profile.user_id`)} AS revision
      FROM target_profile profile
    ), equipment_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(equipmentInput)}::jsonb) AS x(
        input_id uuid, candidate_id uuid, requested_id uuid,
        type equipment_type, label text, quantity integer, attrs jsonb
      )
    ), current_equipment AS MATERIALIZED (
      SELECT e.*, to_jsonb(e) AS before_data
      FROM equipment_items e
      WHERE e.user_id = ${userId}::uuid
    ), equipment_matches AS MATERIALIZED (
      SELECT input.input_id, matched.id AS current_id
      FROM equipment_input input
      LEFT JOIN LATERAL (
        SELECT current.id
        FROM current_equipment current
        WHERE (
          input.requested_id IS NOT NULL
          AND current.id = input.requested_id
        ) OR (
          input.requested_id IS NULL
          AND current.type = input.type
          AND lower(btrim(current.label)) = lower(btrim(input.label))
        )
        ORDER BY (current.id = input.requested_id) DESC, current.created_at, current.id
        LIMIT 1
      ) matched ON TRUE
    ), plate_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(plateInput)}::jsonb) AS x(
        input_id uuid, candidate_id uuid, requested_id uuid,
        denomination numeric(7,2), quantity integer
      )
    ), current_plates AS MATERIALIZED (
      SELECT plate.*, to_jsonb(plate) AS before_data
      FROM plate_inventory plate
      WHERE plate.user_id = ${userId}::uuid
    ), plate_matches AS MATERIALIZED (
      SELECT input.input_id, matched.id AS current_id
      FROM plate_input input
      LEFT JOIN LATERAL (
        SELECT current.id
        FROM current_plates current
        WHERE (
          input.requested_id IS NOT NULL
          AND current.id = input.requested_id
        ) OR (
          input.requested_id IS NULL
          AND current.denomination = input.denomination
        )
        ORDER BY (current.id = input.requested_id) DESC, current.id
        LIMIT 1
      ) matched ON TRUE
    ), bar_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(barInput)}::jsonb) AS x(
        input_id uuid, candidate_id uuid, requested_id uuid, bar_type text,
        bar_weight numeric(7,2), collar_weight numeric(7,2), quantity integer, label text,
        equipment_item_id uuid, unit unit, loading_kind text,
        shared_plate_pool_compatible boolean, profile_supplied boolean
      )
    ), current_bars AS MATERIALIZED (
      SELECT bar.*, to_jsonb(bar) AS before_data
      FROM barbell_configs bar
      WHERE bar.user_id = ${userId}::uuid
        AND (
          bar.equipment_item_id IS NULL
          OR bar.loading_kind IN ('olympic', 'ez')
        )
    ), bar_matches AS MATERIALIZED (
      SELECT input.input_id, matched.id AS current_id
      FROM bar_input input
      LEFT JOIN LATERAL (
        SELECT current.id
        FROM current_bars current
        WHERE (
          input.requested_id IS NOT NULL
          AND current.id = input.requested_id
        ) OR (
          input.requested_id IS NULL
          AND current.bar_type = input.bar_type
        )
        ORDER BY (current.id = input.requested_id) DESC, current.id
        LIMIT 1
      ) matched ON TRUE
    ), load_profile_raw AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(loadProfileInput)}::jsonb) AS x(
        equipment_item_id uuid, profile jsonb
      )
    ), load_profile_input AS MATERIALIZED (
      SELECT
        coalesce(matched.current_id, equipment.candidate_id, raw.equipment_item_id)
          AS equipment_item_id,
        raw.profile
      FROM load_profile_raw raw
      LEFT JOIN equipment_input equipment
        ON raw.equipment_item_id = equipment.requested_id
        OR raw.equipment_item_id = equipment.candidate_id
      LEFT JOIN equipment_matches matched ON matched.input_id = equipment.input_id
    ), current_load_profiles AS MATERIALIZED (
      SELECT 'plate_loaded_implement'::text AS kind, bar.id, bar.equipment_item_id,
             to_jsonb(bar) AS before_data
      FROM barbell_configs bar
      WHERE bar.user_id = ${userId}::uuid AND bar.equipment_item_id IS NOT NULL
      UNION ALL
      SELECT 'plate_loaded_machine', profile.id, profile.equipment_item_id, to_jsonb(profile)
      FROM plate_loaded_machine_profiles profile WHERE profile.user_id = ${userId}::uuid
      UNION ALL
      SELECT 'cable_machine', profile.id, profile.equipment_item_id, to_jsonb(profile)
      FROM cable_machine_profiles profile WHERE profile.user_id = ${userId}::uuid
      UNION ALL
      SELECT 'attachment', profile.id, profile.equipment_item_id, to_jsonb(profile)
      FROM cable_attachment_profiles profile WHERE profile.user_id = ${userId}::uuid
    ), unknown_requested AS MATERIALIZED (
      SELECT input.requested_id
      FROM equipment_input input
      WHERE input.requested_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM current_equipment current WHERE current.id = input.requested_id
        )
      UNION ALL
      SELECT input.candidate_id
      FROM equipment_input input
      WHERE input.requested_id IS NULL
        AND EXISTS (
          SELECT 1 FROM current_equipment current
          WHERE current.id = input.candidate_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM equipment_matches matched
          WHERE matched.input_id = input.input_id
            AND matched.current_id = input.candidate_id
        )
      UNION ALL
      SELECT input.requested_id
      FROM plate_input input
      WHERE input.requested_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM current_plates current WHERE current.id = input.requested_id
        )
      UNION ALL
      SELECT input.requested_id
      FROM bar_input input
      WHERE input.requested_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM current_bars current WHERE current.id = input.requested_id
        )
      UNION ALL
      SELECT input.equipment_item_id
      FROM load_profile_input input
      WHERE NOT EXISTS (
        SELECT 1 FROM current_equipment current
        WHERE current.id = input.equipment_item_id
      )
        AND NOT EXISTS (
          SELECT 1 FROM equipment_input equipment
          WHERE equipment.requested_id IS NULL
            AND equipment.candidate_id = input.equipment_item_id
        )
      UNION ALL
      SELECT (input.profile->>'id')::uuid
      FROM load_profile_input input
      WHERE input.profile->>'id' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM current_load_profiles current
          WHERE current.id = (input.profile->>'id')::uuid
            AND current.equipment_item_id = input.equipment_item_id
            AND current.kind = input.profile->>'kind'
        )
      UNION ALL
      SELECT wanted.id::uuid
      FROM load_profile_input input
      CROSS JOIN LATERAL jsonb_array_elements_text(
        coalesce(input.profile->'compatiblePlateIds', '[]'::jsonb)
      ) wanted(id)
      WHERE input.profile->>'kind' = 'plate_loaded_machine'
        AND NOT EXISTS (
          SELECT 1 FROM current_plates plate WHERE plate.id = wanted.id::uuid
        )
      UNION ALL
      SELECT wanted.id::uuid
      FROM load_profile_input input
      CROSS JOIN LATERAL jsonb_array_elements_text(
        coalesce(input.profile->'compatibleAttachmentItemIds', '[]'::jsonb)
      ) wanted(id)
      WHERE input.profile->>'kind' = 'cable_machine'
        AND NOT EXISTS (
          SELECT 1
          FROM cable_attachment_profiles attachment
          WHERE attachment.equipment_item_id = wanted.id::uuid
            AND attachment.user_id = ${userId}::uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM load_profile_input attachment_input
          WHERE attachment_input.equipment_item_id = wanted.id::uuid
            AND attachment_input.profile->>'kind' = 'attachment'
        )
    ), ambiguous_current_bars AS MATERIALIZED (
      SELECT bar_type
      FROM current_bars
      GROUP BY bar_type
      HAVING count(*) > 1
    ), save_gate AS MATERIALIZED (
      SELECT id FROM target_profile
      WHERE NOT EXISTS (SELECT 1 FROM unknown_requested)
        AND (
          (
            ${!isManagement}::boolean
            AND (${parsingEventId === null}::boolean OR EXISTS (SELECT 1 FROM target_event))
          ) OR (
            ${isManagement}::boolean
            AND ${expectedRevision}::text = (SELECT revision FROM current_revision)
          )
        )
    ), deleted_machine_profile_transitions AS (
      DELETE FROM plate_loaded_machine_profiles profile
      USING equipment_input input, equipment_matches matched
      WHERE matched.input_id = input.input_id
        AND profile.equipment_item_id = matched.current_id
        AND profile.user_id = ${userId}::uuid
        AND input.type = 'cable'
        AND EXISTS (SELECT 1 FROM save_gate)
      RETURNING profile.*
    ), deleted_cable_profile_transitions AS (
      DELETE FROM cable_machine_profiles profile
      USING equipment_input input, equipment_matches matched
      WHERE matched.input_id = input.input_id
        AND profile.equipment_item_id = matched.current_id
        AND profile.user_id = ${userId}::uuid
        AND input.type IN ('machine', 'smith_machine')
        AND EXISTS (SELECT 1 FROM save_gate)
      RETURNING profile.*
    ), profile_transitions_finished AS MATERIALIZED (
      SELECT
        (SELECT count(*) FROM deleted_machine_profile_transitions)
        + (SELECT count(*) FROM deleted_cable_profile_transitions) AS changed
    ), updated_equipment AS (
      -- Attribute merge: a row the client loaded by stable ID replaces the
      -- editable keys and preserves everything server-owned; a natural-key
      -- match (typically reactivating a retired row the client never saw)
      -- additionally preserves stored editable values the client did not
      -- supply, so re-adding an item cannot silently blank its details.
      UPDATE equipment_items target
      SET type = input.type,
          label = input.label,
          quantity = input.quantity,
          attrs = CASE
            WHEN input.requested_id IS NULL THEN current.attrs || input.attrs
            ELSE (current.attrs - ${EDITABLE_ATTR_KEYS_SQL}) || input.attrs
          END,
          available = true,
          updated_at = now()
      FROM equipment_input input
      JOIN equipment_matches matched ON matched.input_id = input.input_id
      JOIN current_equipment current ON current.id = matched.current_id
      CROSS JOIN profile_transitions_finished
      WHERE target.id = current.id
        AND EXISTS (SELECT 1 FROM save_gate)
        AND ROW(current.type, current.label, current.quantity, current.attrs, current.available)
          IS DISTINCT FROM ROW(
            input.type, input.label, input.quantity,
            CASE
              WHEN input.requested_id IS NULL THEN current.attrs || input.attrs
              ELSE (current.attrs - ${EDITABLE_ATTR_KEYS_SQL}) || input.attrs
            END,
            true
          )
      RETURNING target.*
    ), inserted_equipment AS (
      INSERT INTO equipment_items (
        id, user_id, type, label, quantity, attrs, available
      )
      SELECT
        input.candidate_id, ${userId}::uuid, input.type, input.label,
        input.quantity, input.attrs, true
      FROM equipment_input input
      JOIN equipment_matches matched ON matched.input_id = input.input_id
      WHERE matched.current_id IS NULL
        AND EXISTS (SELECT 1 FROM save_gate)
      RETURNING *
    ), equipment_type_writes_finished AS MATERIALIZED (
      SELECT
        (SELECT count(*) FROM updated_equipment)
        + (SELECT count(*) FROM inserted_equipment) AS changed
    ), retired_equipment AS (
      UPDATE equipment_items target
      SET available = false, updated_at = now()
      FROM current_equipment current
      WHERE target.id = current.id
        AND current.available = true
        AND EXISTS (SELECT 1 FROM save_gate)
        AND NOT EXISTS (
          SELECT 1 FROM equipment_matches matched
          WHERE matched.current_id = current.id
        )
      RETURNING target.*
    ), equipment_versions AS (
      INSERT INTO record_versions (
        user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${userId}::uuid, 'equipment_item', current.id, 'equipment.update',
        current.before_data, to_jsonb(updated),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(current.before_data) old_value
          JOIN jsonb_each(to_jsonb(updated)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
            AND old_value.key <> 'updated_at'
          ORDER BY old_value.key
        )
      FROM current_equipment current
      JOIN updated_equipment updated ON updated.id = current.id
      UNION ALL
      SELECT
        ${userId}::uuid, 'equipment_item', inserted.id, 'equipment.create',
        '{}'::jsonb, to_jsonb(inserted),
        ARRAY['type', 'label', 'quantity', 'attrs', 'available']::text[]
      FROM inserted_equipment inserted
      UNION ALL
      SELECT
        ${userId}::uuid, 'equipment_item', current.id, 'equipment.retire',
        current.before_data, to_jsonb(retired), ARRAY['available']::text[]
      FROM current_equipment current
      JOIN retired_equipment retired ON retired.id = current.id
      RETURNING id
    ), updated_plates AS (
      UPDATE plate_inventory target
      SET denomination = input.denomination,
          quantity = input.quantity
      FROM plate_input input
      JOIN plate_matches matched ON matched.input_id = input.input_id
      JOIN current_plates current ON current.id = matched.current_id
      WHERE target.id = current.id
        AND EXISTS (SELECT 1 FROM save_gate)
        AND ROW(current.denomination, current.quantity)
          IS DISTINCT FROM ROW(input.denomination, input.quantity)
      RETURNING target.*
    ), inserted_plates AS (
      INSERT INTO plate_inventory (id, user_id, denomination, quantity)
      SELECT input.candidate_id, ${userId}::uuid, input.denomination, input.quantity
      FROM plate_input input
      JOIN plate_matches matched ON matched.input_id = input.input_id
      WHERE matched.current_id IS NULL
        AND EXISTS (SELECT 1 FROM save_gate)
      RETURNING *
    ), deleted_plates AS (
      DELETE FROM plate_inventory target
      USING current_plates current
      WHERE target.id = current.id
        AND EXISTS (SELECT 1 FROM save_gate)
        AND NOT EXISTS (
          SELECT 1 FROM plate_matches matched WHERE matched.current_id = current.id
        )
      RETURNING target.*
    ), plate_versions AS (
      INSERT INTO record_versions (
        user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${userId}::uuid, 'plate_inventory', current.id, 'plate.update',
        current.before_data, to_jsonb(updated), ARRAY['denomination', 'quantity']::text[]
      FROM current_plates current
      JOIN updated_plates updated ON updated.id = current.id
      UNION ALL
      SELECT
        ${userId}::uuid, 'plate_inventory', inserted.id, 'plate.create',
        '{}'::jsonb, to_jsonb(inserted), ARRAY['denomination', 'quantity']::text[]
      FROM inserted_plates inserted
      UNION ALL
      SELECT
        ${userId}::uuid, 'plate_inventory', current.id, 'plate.remove',
        current.before_data, '{}'::jsonb, ARRAY['denomination', 'quantity']::text[]
      FROM current_plates current
      JOIN deleted_plates deleted ON deleted.id = current.id
      RETURNING id
    ), updated_bars AS (
      UPDATE barbell_configs target
      SET bar_type = input.bar_type,
          equipment_item_id = CASE
            WHEN input.profile_supplied THEN input.equipment_item_id
            WHEN input.equipment_item_id IS NOT NULL THEN NULL
            ELSE current.equipment_item_id
          END,
          unit = CASE WHEN input.profile_supplied THEN input.unit
            WHEN input.equipment_item_id IS NOT NULL THEN NULL ELSE current.unit END,
          loading_kind = CASE WHEN input.profile_supplied THEN input.loading_kind
            WHEN input.equipment_item_id IS NOT NULL THEN NULL ELSE current.loading_kind END,
          shared_plate_pool_compatible = CASE
            WHEN input.profile_supplied THEN input.shared_plate_pool_compatible
            WHEN input.equipment_item_id IS NOT NULL THEN NULL
            ELSE current.shared_plate_pool_compatible
          END,
          bar_weight = input.bar_weight,
          collar_weight = coalesce(input.collar_weight, current.collar_weight),
          quantity = input.quantity,
          label = input.label
      FROM bar_input input
      JOIN bar_matches matched ON matched.input_id = input.input_id
      JOIN current_bars current ON current.id = matched.current_id
      CROSS JOIN equipment_type_writes_finished
      WHERE target.id = current.id
        AND EXISTS (SELECT 1 FROM save_gate)
        AND ROW(
          current.bar_type, current.equipment_item_id, current.unit,
          current.loading_kind, current.shared_plate_pool_compatible,
          current.bar_weight, current.collar_weight, current.quantity, current.label
        )
          IS DISTINCT FROM ROW(
            input.bar_type,
            CASE WHEN input.profile_supplied THEN input.equipment_item_id WHEN input.equipment_item_id IS NOT NULL THEN NULL ELSE current.equipment_item_id END,
            CASE WHEN input.profile_supplied THEN input.unit WHEN input.equipment_item_id IS NOT NULL THEN NULL ELSE current.unit END,
            CASE WHEN input.profile_supplied THEN input.loading_kind WHEN input.equipment_item_id IS NOT NULL THEN NULL ELSE current.loading_kind END,
            CASE WHEN input.profile_supplied THEN input.shared_plate_pool_compatible WHEN input.equipment_item_id IS NOT NULL THEN NULL ELSE current.shared_plate_pool_compatible END,
            input.bar_weight,
            coalesce(input.collar_weight, current.collar_weight),
            input.quantity, input.label
          )
      RETURNING target.*
    ), inserted_bars AS (
      INSERT INTO barbell_configs (
        id, user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, collar_weight, quantity, label
      )
      SELECT
        input.candidate_id, ${userId}::uuid, input.bar_type,
        CASE WHEN input.profile_supplied THEN input.equipment_item_id ELSE NULL END,
        CASE WHEN input.profile_supplied THEN input.unit ELSE NULL END,
        CASE WHEN input.profile_supplied THEN input.loading_kind ELSE NULL END,
        CASE WHEN input.profile_supplied THEN input.shared_plate_pool_compatible ELSE NULL END,
        input.bar_weight,
        coalesce(input.collar_weight, 0), input.quantity, input.label
      FROM bar_input input
      JOIN bar_matches matched ON matched.input_id = input.input_id
      CROSS JOIN equipment_type_writes_finished
      WHERE matched.current_id IS NULL
        AND EXISTS (SELECT 1 FROM save_gate)
      RETURNING *
    ), deleted_bars AS (
      DELETE FROM barbell_configs target
      USING current_bars current
      WHERE target.id = current.id
        AND EXISTS (SELECT 1 FROM save_gate)
        AND NOT EXISTS (
          SELECT 1 FROM bar_matches matched WHERE matched.current_id = current.id
        )
      RETURNING target.*
    ), bar_versions AS (
      INSERT INTO record_versions (
        user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${userId}::uuid, 'barbell_config', current.id, 'bar.update',
        current.before_data, to_jsonb(updated),
        ARRAY['bar_type', 'equipment_item_id', 'unit', 'loading_kind', 'shared_plate_pool_compatible', 'bar_weight', 'collar_weight', 'quantity', 'label']::text[]
      FROM current_bars current
      JOIN updated_bars updated ON updated.id = current.id
      UNION ALL
      SELECT
        ${userId}::uuid, 'barbell_config', inserted.id, 'bar.create',
        '{}'::jsonb, to_jsonb(inserted),
        ARRAY['bar_type', 'equipment_item_id', 'unit', 'loading_kind', 'shared_plate_pool_compatible', 'bar_weight', 'collar_weight', 'quantity', 'label']::text[]
      FROM inserted_bars inserted
      UNION ALL
      SELECT
        ${userId}::uuid, 'barbell_config', current.id, 'bar.remove',
        current.before_data, '{}'::jsonb,
        ARRAY['bar_type', 'bar_weight', 'collar_weight', 'quantity', 'label']::text[]
      FROM current_bars current
      JOIN deleted_bars deleted ON deleted.id = current.id
      RETURNING id
    ), deleted_machine_profiles AS (
      DELETE FROM plate_loaded_machine_profiles profile
      WHERE profile.user_id = ${userId}::uuid
        AND ${isManagement}::boolean
        AND EXISTS (SELECT 1 FROM save_gate)
        AND NOT EXISTS (
          SELECT 1 FROM load_profile_input input
          WHERE input.equipment_item_id = profile.equipment_item_id
            AND input.profile->>'kind' = 'plate_loaded_machine'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM equipment_input input
          JOIN equipment_matches matched ON matched.input_id = input.input_id
          WHERE matched.current_id = profile.equipment_item_id
            AND input.type = 'cable'
        )
      RETURNING profile.*
    ), deleted_cable_profiles AS (
      DELETE FROM cable_machine_profiles profile
      WHERE profile.user_id = ${userId}::uuid
        AND ${isManagement}::boolean
        AND EXISTS (SELECT 1 FROM save_gate)
        AND NOT EXISTS (
          SELECT 1 FROM load_profile_input input
          WHERE input.equipment_item_id = profile.equipment_item_id
            AND input.profile->>'kind' = 'cable_machine'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM equipment_input input
          JOIN equipment_matches matched ON matched.input_id = input.input_id
          WHERE matched.current_id = profile.equipment_item_id
            AND input.type IN ('machine', 'smith_machine')
        )
      RETURNING profile.*
    ), deleted_attachment_profiles AS (
      DELETE FROM cable_attachment_profiles profile
      WHERE profile.user_id = ${userId}::uuid
        AND ${isManagement}::boolean
        AND EXISTS (SELECT 1 FROM save_gate)
        AND NOT EXISTS (
          SELECT 1 FROM load_profile_input input
          WHERE input.equipment_item_id = profile.equipment_item_id
            AND input.profile->>'kind' = 'attachment'
        )
      RETURNING profile.*
    ), deleted_profile_versions AS (
      INSERT INTO record_versions (
        user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT ${userId}::uuid, 'equipment_load_profile', deleted.id,
             'equipment_profile.remove', to_jsonb(deleted), '{}'::jsonb,
             ARRAY['exact_setup']::text[] FROM deleted_machine_profiles deleted
      UNION ALL
      SELECT ${userId}::uuid, 'equipment_load_profile', deleted.id,
             'equipment_profile.remove', to_jsonb(deleted), '{}'::jsonb,
             ARRAY['exact_setup']::text[] FROM deleted_cable_profiles deleted
      UNION ALL
      SELECT ${userId}::uuid, 'equipment_load_profile', deleted.id,
             'equipment_profile.remove', to_jsonb(deleted), '{}'::jsonb,
             ARRAY['exact_setup']::text[] FROM deleted_attachment_profiles deleted
      UNION ALL
      SELECT ${userId}::uuid, 'equipment_load_profile', deleted.id,
             'equipment_profile.remove', to_jsonb(deleted), '{}'::jsonb,
             ARRAY['exact_setup']::text[]
      FROM deleted_machine_profile_transitions deleted
      UNION ALL
      SELECT ${userId}::uuid, 'equipment_load_profile', deleted.id,
             'equipment_profile.remove', to_jsonb(deleted), '{}'::jsonb,
             ARRAY['exact_setup']::text[]
      FROM deleted_cable_profile_transitions deleted
      RETURNING id
    ), machine_profile_writes AS (
      INSERT INTO plate_loaded_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty,
        starting_resistance, starting_resistance_unit, loading_point_count,
        balancing_rule, target_entry_meaning
      )
      SELECT
        coalesce((input.profile->>'id')::uuid, gen_random_uuid()),
        ${userId}::uuid, input.equipment_item_id,
        input.profile->>'geometryCertainty',
        (input.profile->>'startingResistance')::numeric(7,2),
        (input.profile->>'startingResistanceUnit')::unit,
        (input.profile->>'loadingPointCount')::integer,
        input.profile->>'balancingRule', input.profile->>'targetEntryMeaning'
      FROM load_profile_input input
      CROSS JOIN equipment_type_writes_finished
      WHERE input.profile->>'kind' = 'plate_loaded_machine'
        AND EXISTS (SELECT 1 FROM save_gate)
      ON CONFLICT (equipment_item_id) DO UPDATE SET
        geometry_certainty = excluded.geometry_certainty,
        starting_resistance = excluded.starting_resistance,
        starting_resistance_unit = excluded.starting_resistance_unit,
        loading_point_count = excluded.loading_point_count,
        balancing_rule = excluded.balancing_rule,
        target_entry_meaning = excluded.target_entry_meaning,
        updated_at = now()
      WHERE ROW(
        plate_loaded_machine_profiles.geometry_certainty,
        plate_loaded_machine_profiles.starting_resistance,
        plate_loaded_machine_profiles.starting_resistance_unit,
        plate_loaded_machine_profiles.loading_point_count,
        plate_loaded_machine_profiles.balancing_rule,
        plate_loaded_machine_profiles.target_entry_meaning
      ) IS DISTINCT FROM ROW(
        excluded.geometry_certainty, excluded.starting_resistance,
        excluded.starting_resistance_unit, excluded.loading_point_count,
        excluded.balancing_rule, excluded.target_entry_meaning
      )
      RETURNING *
    ), machine_profile_targets AS MATERIALIZED (
      SELECT coalesce(written.id, current.id) AS id,
             input.equipment_item_id, input.profile
      FROM load_profile_input input
      LEFT JOIN plate_loaded_machine_profiles current
        ON current.equipment_item_id = input.equipment_item_id
       AND current.user_id = ${userId}::uuid
      LEFT JOIN machine_profile_writes written
        ON written.equipment_item_id = input.equipment_item_id
      WHERE input.profile->>'kind' = 'plate_loaded_machine'
        AND coalesce(written.id, current.id) IS NOT NULL
    ), deleted_machine_plate_links AS (
      DELETE FROM plate_loaded_machine_compatible_plates link
      USING machine_profile_targets target
      WHERE link.machine_profile_id = target.id
        AND link.user_id = ${userId}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(target.profile->'compatiblePlateIds') wanted(id)
          WHERE wanted.id::uuid = link.plate_inventory_id
        )
      RETURNING link.machine_profile_id
    ), inserted_machine_plate_links AS (
      INSERT INTO plate_loaded_machine_compatible_plates (
        machine_profile_id, plate_inventory_id, user_id
      )
      SELECT target.id, wanted.id::uuid, ${userId}::uuid
      FROM machine_profile_targets target
      CROSS JOIN LATERAL jsonb_array_elements_text(
        coalesce(target.profile->'compatiblePlateIds', '[]'::jsonb)
      ) wanted(id)
      WHERE EXISTS (
        SELECT 1 FROM plate_inventory plate
        WHERE plate.id = wanted.id::uuid AND plate.user_id = ${userId}::uuid
      )
      ON CONFLICT DO NOTHING
      RETURNING machine_profile_id
    ), attachment_profile_writes AS (
      INSERT INTO cable_attachment_profiles (
        id, user_id, equipment_item_id, attachment_kind,
        connection_standard, status
      )
      SELECT
        coalesce((input.profile->>'id')::uuid, gen_random_uuid()),
        ${userId}::uuid, input.equipment_item_id,
        input.profile->>'attachmentKind',
        nullif(input.profile->>'connectionStandard', ''),
        input.profile->>'status'
      FROM load_profile_input input
      WHERE input.profile->>'kind' = 'attachment'
        AND EXISTS (SELECT 1 FROM save_gate)
      ON CONFLICT (equipment_item_id) DO UPDATE SET
        attachment_kind = excluded.attachment_kind,
        connection_standard = excluded.connection_standard,
        status = excluded.status,
        updated_at = now()
      WHERE ROW(
        cable_attachment_profiles.attachment_kind,
        cable_attachment_profiles.connection_standard,
        cable_attachment_profiles.status
      ) IS DISTINCT FROM ROW(
        excluded.attachment_kind, excluded.connection_standard, excluded.status
      )
      RETURNING *
    ), attachment_profile_targets AS MATERIALIZED (
      SELECT coalesce(written.id, current.id) AS id,
             input.equipment_item_id, input.profile
      FROM load_profile_input input
      LEFT JOIN cable_attachment_profiles current
        ON current.equipment_item_id = input.equipment_item_id
       AND current.user_id = ${userId}::uuid
      LEFT JOIN attachment_profile_writes written
        ON written.equipment_item_id = input.equipment_item_id
      WHERE input.profile->>'kind' = 'attachment'
        AND coalesce(written.id, current.id) IS NOT NULL
    ), cable_profile_writes AS (
      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty, stack_count,
        topology, displayed_unit, ratio_status, ratio_numerator, ratio_denominator
      )
      SELECT
        coalesce((input.profile->>'id')::uuid, gen_random_uuid()),
        ${userId}::uuid, input.equipment_item_id,
        input.profile->>'geometryCertainty',
        (input.profile->>'stackCount')::integer,
        input.profile->>'topology',
        (input.profile->>'displayedUnit')::unit,
        input.profile->>'ratioStatus',
        (input.profile->>'ratioNumerator')::integer,
        (input.profile->>'ratioDenominator')::integer
      FROM load_profile_input input
      CROSS JOIN equipment_type_writes_finished
      WHERE input.profile->>'kind' = 'cable_machine'
        AND EXISTS (SELECT 1 FROM save_gate)
      ON CONFLICT (equipment_item_id) DO UPDATE SET
        geometry_certainty = excluded.geometry_certainty,
        stack_count = excluded.stack_count,
        topology = excluded.topology,
        displayed_unit = excluded.displayed_unit,
        ratio_status = excluded.ratio_status,
        ratio_numerator = excluded.ratio_numerator,
        ratio_denominator = excluded.ratio_denominator,
        updated_at = now()
      WHERE ROW(
        cable_machine_profiles.geometry_certainty,
        cable_machine_profiles.stack_count, cable_machine_profiles.topology,
        cable_machine_profiles.displayed_unit, cable_machine_profiles.ratio_status,
        cable_machine_profiles.ratio_numerator, cable_machine_profiles.ratio_denominator
      ) IS DISTINCT FROM ROW(
        excluded.geometry_certainty, excluded.stack_count, excluded.topology,
        excluded.displayed_unit, excluded.ratio_status,
        excluded.ratio_numerator, excluded.ratio_denominator
      )
      RETURNING *
    ), cable_profile_targets AS MATERIALIZED (
      SELECT coalesce(written.id, current.id) AS id,
             input.equipment_item_id, input.profile
      FROM load_profile_input input
      LEFT JOIN cable_machine_profiles current
        ON current.equipment_item_id = input.equipment_item_id
       AND current.user_id = ${userId}::uuid
      LEFT JOIN cable_profile_writes written
        ON written.equipment_item_id = input.equipment_item_id
      WHERE input.profile->>'kind' = 'cable_machine'
        AND coalesce(written.id, current.id) IS NOT NULL
    ), desired_cable_steps AS MATERIALIZED (
      SELECT target.id AS cable_profile_id,
             (step.value->>'stackIndex')::integer AS stack_index,
             (step.value->>'stepIndex')::integer AS step_index,
             nullif(step.value->>'positionLabel', '') AS position_label,
             (step.value->>'displayedLoad')::numeric(7,2) AS displayed_load
      FROM cable_profile_targets target
      CROSS JOIN LATERAL jsonb_array_elements(
        coalesce(target.profile->'stackSteps', '[]'::jsonb)
      ) step(value)
    ), deleted_cable_steps AS (
      DELETE FROM cable_stack_steps step
      USING cable_profile_targets target
      WHERE step.cable_profile_id = target.id
        AND step.user_id = ${userId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM desired_cable_steps wanted
          WHERE wanted.cable_profile_id = step.cable_profile_id
            AND wanted.stack_index = step.stack_index
            AND wanted.step_index = step.step_index
        )
      RETURNING step.cable_profile_id
    ), upserted_cable_steps AS (
      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index,
        position_label, displayed_load
      )
      SELECT ${userId}::uuid, wanted.cable_profile_id, wanted.stack_index,
             wanted.step_index, wanted.position_label, wanted.displayed_load
      FROM desired_cable_steps wanted
      ON CONFLICT (cable_profile_id, stack_index, step_index) DO UPDATE SET
        position_label = excluded.position_label,
        displayed_load = excluded.displayed_load
      WHERE ROW(cable_stack_steps.position_label, cable_stack_steps.displayed_load)
        IS DISTINCT FROM ROW(excluded.position_label, excluded.displayed_load)
      RETURNING cable_profile_id
    ), desired_cable_attachments AS MATERIALIZED (
      SELECT target.id AS cable_profile_id, attachment.id AS attachment_profile_id
      FROM cable_profile_targets target
      CROSS JOIN LATERAL jsonb_array_elements_text(
        coalesce(target.profile->'compatibleAttachmentItemIds', '[]'::jsonb)
      ) wanted(item_id)
      JOIN attachment_profile_targets attachment
        ON attachment.equipment_item_id = wanted.item_id::uuid
    ), deleted_cable_attachment_links AS (
      DELETE FROM cable_attachment_compatibilities link
      USING cable_profile_targets target
      WHERE link.cable_profile_id = target.id
        AND link.user_id = ${userId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM desired_cable_attachments wanted
          WHERE wanted.cable_profile_id = link.cable_profile_id
            AND wanted.attachment_profile_id = link.attachment_profile_id
        )
      RETURNING link.cable_profile_id
    ), inserted_cable_attachment_links AS (
      INSERT INTO cable_attachment_compatibilities (
        cable_profile_id, attachment_profile_id, user_id
      )
      SELECT wanted.cable_profile_id, wanted.attachment_profile_id, ${userId}::uuid
      FROM desired_cable_attachments wanted
      ON CONFLICT DO NOTHING
      RETURNING cable_profile_id
    ), profile_versions AS (
      INSERT INTO record_versions (
        user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${userId}::uuid, 'equipment_load_profile',
        coalesce(current.id, written.id),
        CASE WHEN current.id IS NULL THEN 'equipment_profile.create'
             ELSE 'equipment_profile.update' END,
        coalesce(current.before_data, '{}'::jsonb), input.profile,
        ARRAY['exact_setup']::text[]
      FROM load_profile_input input
      LEFT JOIN current_load_profiles current
        ON current.equipment_item_id = input.equipment_item_id
       AND current.kind = input.profile->>'kind'
      LEFT JOIN LATERAL (
        SELECT id FROM machine_profile_writes
        WHERE equipment_item_id = input.equipment_item_id
        UNION ALL SELECT id FROM attachment_profile_writes
        WHERE equipment_item_id = input.equipment_item_id
        UNION ALL SELECT id FROM cable_profile_writes
        WHERE equipment_item_id = input.equipment_item_id
        LIMIT 1
      ) written ON TRUE
      WHERE input.profile->>'kind' <> 'plate_loaded_implement'
        AND EXISTS (SELECT 1 FROM save_gate)
        AND (
          written.id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM deleted_machine_plate_links link
            WHERE link.machine_profile_id = current.id
            UNION ALL SELECT 1 FROM inserted_machine_plate_links link
            WHERE link.machine_profile_id = current.id
            UNION ALL SELECT 1 FROM deleted_cable_steps step
            WHERE step.cable_profile_id = current.id
            UNION ALL SELECT 1 FROM upserted_cable_steps step
            WHERE step.cable_profile_id = current.id
            UNION ALL SELECT 1 FROM deleted_cable_attachment_links link
            WHERE link.cable_profile_id = current.id
            UNION ALL SELECT 1 FROM inserted_cable_attachment_links link
            WHERE link.cable_profile_id = current.id
          )
        )
      RETURNING id
    ), updated_profile AS (
      UPDATE user_profiles
      SET setup_state = ${completedStepsExpression("equipment")},
          updated_at = now()
      WHERE id IN (SELECT id FROM save_gate)
        AND ${!isManagement}::boolean
      RETURNING id
    ), updated_event AS (
      UPDATE ai_parsing_events
      SET confirmed = true,
          confirmed_payload = ${JSON.stringify(core.confirmedPayload ?? null)}::jsonb,
          raw_input = '',
          raw_output = NULL,
          parsed_json = NULL,
          ambiguities = '[]'::jsonb,
          raw_redacted_at = now(),
          retention_expires_at = NULL
      WHERE id IN (SELECT id FROM target_event)
        AND EXISTS (SELECT 1 FROM save_gate)
      RETURNING id
    ), inserted_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, summary, cause_ref
      )
      SELECT
        ${userId}::uuid,
        'user',
        ${auditAction},
        'equipment_inventory',
        ${auditSummary},
        jsonb_build_object(
          'parsingEventId', ${parsingEventId}::text,
          'versionCount',
            (SELECT count(*) FROM equipment_versions) +
            (SELECT count(*) FROM plate_versions) +
            (SELECT count(*) FROM bar_versions) +
            (SELECT count(*) FROM profile_versions) +
            (SELECT count(*) FROM deleted_profile_versions)
        )
      FROM save_gate
      WHERE ${!isManagement}::boolean
         OR (
            (SELECT count(*) FROM equipment_versions) +
            (SELECT count(*) FROM plate_versions) +
            (SELECT count(*) FROM bar_versions) +
            (SELECT count(*) FROM profile_versions) +
            (SELECT count(*) FROM deleted_profile_versions)
         ) > 0
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM save_gate) AS gates,
      (SELECT count(*)::int FROM updated_profile) AS profiles,
      (SELECT count(*)::int FROM updated_event) AS events,
      (SELECT count(*)::int FROM inserted_audit) AS audits,
      (SELECT count(*)::int FROM unknown_requested) AS unknown_ids,
      (SELECT count(*)::int FROM ambiguous_current_bars) AS ambiguous_bars,
      (
        ${expectedRevision === null}::boolean
        OR ${expectedRevision}::text = (SELECT revision FROM current_revision)
      ) AS revision_ok,
      (SELECT count(*)::int FROM inserted_equipment) AS added_items,
      (SELECT count(*)::int FROM updated_equipment) AS updated_items,
      (SELECT count(*)::int FROM retired_equipment) AS retired_items,
      (
        (SELECT count(*) FROM updated_plates) +
        (SELECT count(*) FROM inserted_plates) +
        (SELECT count(*) FROM deleted_plates)
      )::int AS plate_writes,
      (
        (SELECT count(*) FROM updated_bars) +
        (SELECT count(*) FROM inserted_bars) +
        (SELECT count(*) FROM deleted_bars)
      )::int AS bar_writes,
      (
        (SELECT count(*) FROM equipment_versions) +
        (SELECT count(*) FROM plate_versions) +
        (SELECT count(*) FROM bar_versions) +
        (SELECT count(*) FROM profile_versions) +
        (SELECT count(*) FROM deleted_profile_versions)
      )::int AS versions
  `;
  return resultRows(await db.execute(query))[0];
}

/**
 * Save the complete setup inventory as one diff. Existing IDs are retained,
 * omitted equipment is retired, and every meaningful change is versioned in
 * the same statement as the data, setup progress, parse confirmation, and audit.
 */
export async function saveInventoryWithVersions(
  db: Db,
  userId: string,
  items: ConfirmedEquipmentItem[],
  parsingEventId: string | null = null
): Promise<PersistenceResult> {
  const currentInventory = await loadEquipmentInventoryDocument(db, userId);
  const naturalKeys = new Set<string>();
  const requestedIds = new Set<string>();
  for (const item of items) {
    const key = `${item.type}\0${item.label.trim().toLocaleLowerCase()}`;
    if (naturalKeys.has(key)) {
      return { ok: false, reason: `Keep only one entry named “${item.label.trim()}” for that equipment type.` };
    }
    naturalKeys.add(key);
    if (item.id) {
      if (requestedIds.has(item.id)) {
        return { ok: false, reason: "The same saved equipment item was included twice." };
      }
      requestedIds.add(item.id);
    }
  }

  const equipmentInput: EquipmentSqlInput[] = items.map((item) => ({
    input_id: randomUUID(),
    candidate_id: randomUUID(),
    requested_id: item.id ?? null,
    type: item.type,
    label: item.label.trim(),
    quantity: item.quantity ?? 1,
    attrs: inventoryAttrs(item) as Record<string, unknown>,
  }));

  const plateByIdentity = new Map<string, PlateSqlInput>();
  for (const item of items) {
    if (item.type !== "plates") continue;
    for (const denomination of item.denominations ?? []) {
      const key = denomination.id ?? String(denomination.weight);
      plateByIdentity.set(key, {
        input_id: randomUUID(),
        candidate_id: randomUUID(),
        requested_id: denomination.id ?? null,
        denomination: denomination.weight,
        quantity: denomination.quantity,
      });
    }
  }
  const plateInput = [...plateByIdentity.values()];

  const barInput: BarSqlInput[] = items.flatMap((item) => {
    if (
      (item.type !== "barbell" && item.type !== "ez_bar") ||
      item.barWeight == null
    ) {
      return [];
    }
    return [{
      input_id: randomUUID(),
      candidate_id: randomUUID(),
      requested_id: item.barConfigId ?? null,
      bar_type: item.type === "barbell" ? "olympic" : "ez",
      bar_weight: item.barWeight,
      // The first-time review carries the exact combined collar value. Older
      // payloads omit it and retain the historical preservation behavior.
      collar_weight: item.collarWeight ?? null,
      quantity: item.quantity ?? 1,
      label: item.label.trim(),
      equipment_item_id: null,
      unit: null,
      loading_kind: null,
      shared_plate_pool_compatible: null,
      profile_supplied: false,
    }];
  });
  if (currentInventory) {
    const association = associateBarConfigurations(
      currentInventory.document.items,
      currentInventory.document.bars
    );
    const requestedBarIds = new Set(
      barInput.flatMap((bar) => (bar.requested_id ? [bar.requested_id] : []))
    );
    for (const barIndex of association.unmatchedBarIndexes) {
      const bar = currentInventory.document.bars[barIndex];
      if (!bar.id || requestedBarIds.has(bar.id)) continue;
      barInput.push({
        input_id: randomUUID(),
        candidate_id: randomUUID(),
        requested_id: bar.id,
        bar_type: bar.barType,
        bar_weight: bar.barWeight,
        collar_weight: bar.collarWeight,
        quantity: bar.quantity,
        label: bar.label,
        equipment_item_id: null,
        unit: null,
        loading_kind: null,
        shared_plate_pool_compatible: null,
        profile_supplied: false,
      });
    }
  }

  const row = await executeInventorySave(db, userId, {
    mode: "onboarding",
    parsingEventId,
    confirmedPayload: { items },
    expectedRevision: null,
    equipmentInput,
    plateInput,
    barInput,
    loadProfileInput: [],
  });
  if (
    !row ||
    Number(row.gates) !== 1 ||
    Number(row.profiles) !== 1 ||
    Number(row.audits) !== 1 ||
    (parsingEventId !== null && Number(row.events) !== 1)
  ) {
    if (row && Number(row.unknown_ids) > 0) {
      return {
        ok: false,
        reason:
          "This form no longer matches your saved equipment. Reload the page and try again.",
      };
    }
    return {
      ok: false,
      reason: parsingEventId
        ? "This equipment review was already saved or is no longer current."
        : "The equipment inventory could not be saved.",
    };
  }
  const versionCount = Number(row.versions);
  return { ok: true, changed: versionCount > 0, versionCount };
}

/**
 * Returning-user management save: the complete document is validated, its
 * revision is verified under the profile lock, and the diff/version/audit
 * work happens in the same single statement as onboarding — without touching
 * setup completion, setup steps, or AI parse events.
 */
export async function saveInventoryDocumentForManagement(
  db: Db,
  userId: string,
  input: unknown
): Promise<ManagementInventorySaveResult> {
  const validated = validateEquipmentInventoryDocument(input);
  if (!validated.ok) {
    return {
      ok: false,
      code: "invalid",
      reason: validated.issues[0]?.message ?? "Check the equipment values.",
    };
  }
  const document = synchronizeMatchedBarCopies(validated.document);
  const current = await loadEquipmentInventoryDocument(db, userId);
  if (!current) {
    return { ok: false, code: "stale", reason: "Your account could not be loaded." };
  }
  const barDraftIssue = validateBarDraftAgainstCurrent(current.document, document);
  if (barDraftIssue) {
    return { ok: false, code: "invalid", reason: barDraftIssue };
  }

  const equipmentInput: EquipmentSqlInput[] = document.items.map((item) => ({
    input_id: randomUUID(),
    candidate_id: item.draftId ?? randomUUID(),
    requested_id: item.id,
    type: item.type,
    label: item.label.trim(),
    quantity: item.quantity,
    attrs: pickEditableAttrs(item.attrs as Record<string, unknown>),
  }));
  const plateInput: PlateSqlInput[] = document.plates.map((plate) => ({
    input_id: randomUUID(),
    candidate_id: randomUUID(),
    requested_id: plate.id,
    denomination: plate.denomination,
    quantity: plate.quantity,
  }));
  const association = associateBarConfigurations(document.items, document.bars);
  const barItemByIndex = new Map(
    association.matched.flatMap(({ itemIndex, barIndex }) => {
      const item = document.items[itemIndex];
      const itemId = item?.id ?? item?.draftId;
      return itemId ? [[barIndex, itemId] as const] : [];
    }),
  );
  const loadProfileByItem = new Map(
    (document.loadProfiles ?? []).map((entry) => [entry.equipmentItemId, entry.profile]),
  );
  const barInput: BarSqlInput[] = document.bars.map((bar, barIndex) => {
    const equipmentItemId = barItemByIndex.get(barIndex) ?? null;
    const exact = equipmentItemId ? loadProfileByItem.get(equipmentItemId) : null;
    return {
      input_id: randomUUID(),
      candidate_id: randomUUID(),
      requested_id: bar.id,
      bar_type: bar.barType,
      bar_weight: bar.barWeight,
      collar_weight: bar.collarWeight,
      quantity: bar.quantity,
      label: bar.label.trim(),
      equipment_item_id: equipmentItemId,
      unit: exact?.kind === "plate_loaded_implement" ? exact.unit : null,
      loading_kind: exact?.kind === "plate_loaded_implement" ? exact.loadingKind : null,
      shared_plate_pool_compatible:
        exact?.kind === "plate_loaded_implement"
          ? exact.sharedPlatePoolCompatible
          : null,
      profile_supplied: exact?.kind === "plate_loaded_implement",
    };
  });
  const loadProfileInput: LoadProfileSqlInput[] = (document.loadProfiles ?? []).map(
    (entry) => ({
      equipment_item_id: entry.equipmentItemId,
      profile: entry.profile as Record<string, unknown>,
    }),
  );

  const row = await executeInventorySave(db, userId, {
    mode: "management",
    parsingEventId: null,
    confirmedPayload: null,
    expectedRevision: document.baseRevision,
    equipmentInput,
    plateInput,
    barInput,
    loadProfileInput,
  });
  if (!row) {
    return {
      ok: false,
      code: "failed",
      reason: "The equipment inventory could not be saved.",
    };
  }
  if (Number(row.gates) !== 1) {
    if (Number(row.unknown_ids) > 0) {
      return {
        ok: false,
        code: "unknown_ids",
        reason:
          "This draft refers to saved records that no longer exist in your inventory. Reload the current inventory and try again.",
      };
    }
    if (Number(row.ambiguous_bars) > 0) {
      return {
        ok: false,
        code: "ambiguous_bars",
        reason:
          "Your saved inventory has more than one configuration for the same bar type. Saving is disabled until that shape is reviewed, so nothing gets merged or lost.",
      };
    }
    if (row.revision_ok !== true && row.revision_ok !== "t") {
      return {
        ok: false,
        code: "stale",
        reason:
          "Your inventory changed somewhere else after this page loaded. Reload the current inventory or keep reviewing your draft — nothing was saved.",
      };
    }
    return {
      ok: false,
      code: "failed",
      reason: "The equipment inventory could not be saved.",
    };
  }

  const versionCount = Number(row.versions);
  const expectedAudits = versionCount > 0 ? 1 : 0;
  if (
    Number(row.audits) !== expectedAudits ||
    Number(row.profiles) !== 0 ||
    Number(row.events) !== 0
  ) {
    return {
      ok: false,
      code: "failed",
      reason: "The equipment inventory could not be saved.",
    };
  }
  return {
    ok: true,
    changed: versionCount > 0,
    versionCount,
    counts: {
      addedItems: Number(row.added_items),
      updatedItems: Number(row.updated_items),
      retiredItems: Number(row.retired_items),
      plateWrites: Number(row.plate_writes),
      barWrites: Number(row.bar_writes),
    },
  };
}

export type ProfileReviewSave = {
  ageRange: string;
  experience: "novice" | "intermediate" | "advanced";
  goals: string[];
  sessionLengthMin: number;
  weeklyFrequency: number;
};

/**
 * Returning-user Profile review save. The account unit is deliberately not
 * accepted: plate and bar rows are interpreted in the account unit, so a
 * casual toggle would relabel their numbers. A meaningful change writes one
 * immutable before/after version and one management audit in the same
 * statement; an identical submission writes nothing at all.
 */
export async function saveProfileReviewWithVersions(
  db: Db,
  userId: string,
  input: ProfileReviewSave
): Promise<PersistenceResult> {
  const query = sql`
    WITH target AS MATERIALIZED (
      SELECT profile.*, to_jsonb(profile) AS before_data
      FROM user_profiles profile
      WHERE profile.user_id = ${userId}::uuid
      FOR UPDATE
    ), updated AS (
      UPDATE user_profiles profile
      SET age_range = ${input.ageRange},
          experience = ${input.experience}::experience,
          goals = ${JSON.stringify(input.goals)}::jsonb,
          session_length_min = ${input.sessionLengthMin},
          weekly_frequency = ${input.weeklyFrequency},
          updated_at = now()
      FROM target
      WHERE profile.id = target.id
        AND ROW(
          target.age_range, target.experience::text, target.goals,
          target.session_length_min, target.weekly_frequency
        ) IS DISTINCT FROM ROW(
          ${input.ageRange}::text, ${input.experience}::text,
          ${JSON.stringify(input.goals)}::jsonb,
          ${input.sessionLengthMin}::integer, ${input.weeklyFrequency}::integer
        )
      RETURNING profile.*
    ), inserted_version AS (
      INSERT INTO record_versions (
        user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${userId}::uuid, 'user_profile', target.id, 'profile.manage.update',
        target.before_data, to_jsonb(updated),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(target.before_data) old_value
          JOIN jsonb_each(to_jsonb(updated)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
            AND old_value.key <> 'updated_at'
          ORDER BY old_value.key
        )
      FROM target
      JOIN updated ON updated.id = target.id
      RETURNING id
    ), inserted_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'profile.manage.save', 'user_profile',
        'Updated the training profile from setup review',
        jsonb_build_object('versionCount', (SELECT count(*) FROM inserted_version))
      FROM target
      WHERE EXISTS (SELECT 1 FROM updated)
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM target) AS gates,
      (SELECT count(*)::int FROM updated) AS updates,
      (SELECT count(*)::int FROM inserted_version) AS versions,
      (SELECT count(*)::int FROM inserted_audit) AS audits
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row || Number(row.gates) !== 1) {
    return { ok: false, reason: "The profile could not be saved." };
  }
  const changed = Number(row.updates) === 1;
  if (
    Number(row.versions) !== (changed ? 1 : 0) ||
    Number(row.audits) !== (changed ? 1 : 0)
  ) {
    return { ok: false, reason: "The profile could not be saved." };
  }
  return { ok: true, changed, versionCount: Number(row.versions) };
}

export type CoachingPrefsReviewSave = {
  aggressiveness: "conservative" | "moderate" | "aggressive";
  deloadSuggestions: boolean;
  substitutionSuggestions: boolean;
  weeklyReview: boolean;
};

/**
 * Returning-user Coaching review save: versions and audits a meaningful
 * change in one statement; an identical submission writes nothing.
 */
export async function saveCoachingPrefsReviewWithVersions(
  db: Db,
  userId: string,
  prefs: CoachingPrefsReviewSave
): Promise<PersistenceResult> {
  const query = sql`
    WITH target AS MATERIALIZED (
      SELECT profile.*, to_jsonb(profile) AS before_data
      FROM user_profiles profile
      WHERE profile.user_id = ${userId}::uuid
      FOR UPDATE
    ), updated AS (
      UPDATE user_profiles profile
      SET coaching_prefs = ${JSON.stringify(prefs)}::jsonb,
          updated_at = now()
      FROM target
      WHERE profile.id = target.id
        AND target.coaching_prefs IS DISTINCT FROM ${JSON.stringify(prefs)}::jsonb
      RETURNING profile.*
    ), inserted_version AS (
      INSERT INTO record_versions (
        user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${userId}::uuid, 'user_profile', target.id, 'coaching.manage.update',
        target.before_data, to_jsonb(updated), ARRAY['coaching_prefs']::text[]
      FROM target
      JOIN updated ON updated.id = target.id
      RETURNING id
    ), inserted_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', 'coaching.manage.save', 'user_profile',
        'Updated coaching preferences from setup review',
        jsonb_build_object('versionCount', (SELECT count(*) FROM inserted_version))
      FROM target
      WHERE EXISTS (SELECT 1 FROM updated)
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM target) AS gates,
      (SELECT count(*)::int FROM updated) AS updates,
      (SELECT count(*)::int FROM inserted_version) AS versions,
      (SELECT count(*)::int FROM inserted_audit) AS audits
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row || Number(row.gates) !== 1) {
    return { ok: false, reason: "The coaching preferences could not be saved." };
  }
  const changed = Number(row.updates) === 1;
  if (
    Number(row.versions) !== (changed ? 1 : 0) ||
    Number(row.audits) !== (changed ? 1 : 0)
  ) {
    return { ok: false, reason: "The coaching preferences could not be saved." };
  }
  return { ok: true, changed, versionCount: Number(row.versions) };
}

export type ConstraintSaveMode = "onboarding" | "review";

/** Save all injury constraints as one versioned, atomic diff. */
export async function saveConstraintsWithVersions(
  db: Db,
  userId: string,
  regions: ConstraintRegionSave[],
  options: { mode?: ConstraintSaveMode } = {}
): Promise<PersistenceResult> {
  const mode: ConstraintSaveMode = options.mode ?? "onboarding";
  const isReview = mode === "review";
  const auditAction = isReview ? "constraints.manage.save" : "setup.constraints.save";
  const auditSummary = isReview
    ? "Updated workout constraints from setup review"
    : "Saved workout constraints with stable record history";
  const constraintInput = regions.flatMap((region) => {
    const common = {
      input_id: randomUUID(),
      candidate_id: randomUUID(),
      body_part: region.bodyPart,
      pain_stop_threshold: region.painStopThreshold,
      note: region.note,
    };
    return [
      ...(region.avoidPatterns.length
        ? [{ ...common, affected_patterns: [...region.avoidPatterns].sort(), avoid: true, cautious: false }]
        : []),
      ...(region.cautiousPatterns.length
        ? [{
            ...common,
            input_id: randomUUID(),
            candidate_id: randomUUID(),
            affected_patterns: [...region.cautiousPatterns].sort(),
            avoid: false,
            cautious: true,
          }]
        : []),
    ];
  });

  const query = sql`
    WITH target_profile AS MATERIALIZED (
      SELECT id FROM user_profiles
      WHERE user_id = ${userId}::uuid
      FOR UPDATE
    ), constraint_input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(constraintInput)}::jsonb) AS x(
        input_id uuid, candidate_id uuid, body_part text,
        affected_patterns jsonb, avoid boolean, cautious boolean,
        pain_stop_threshold integer, note text
      )
    ), current_constraints AS MATERIALIZED (
      SELECT current.*, to_jsonb(current) AS before_data
      FROM constraints current
      WHERE current.user_id = ${userId}::uuid
    ), constraint_matches AS MATERIALIZED (
      SELECT input.input_id, matched.id AS current_id
      FROM constraint_input input
      LEFT JOIN LATERAL (
        SELECT current.id
        FROM current_constraints current
        WHERE current.body_part = input.body_part
          AND current.avoid = input.avoid
          AND current.cautious = input.cautious
        ORDER BY current.created_at, current.id
        LIMIT 1
      ) matched ON TRUE
    ), updated_constraints AS (
      UPDATE constraints target
      SET body_part = input.body_part,
          affected_patterns = input.affected_patterns,
          avoid = input.avoid,
          cautious = input.cautious,
          pain_stop_threshold = input.pain_stop_threshold,
          note = input.note
      FROM constraint_input input
      JOIN constraint_matches matched ON matched.input_id = input.input_id
      JOIN current_constraints current ON current.id = matched.current_id
      WHERE target.id = current.id
        AND EXISTS (SELECT 1 FROM target_profile)
        AND ROW(
          current.body_part, current.affected_patterns, current.avoid,
          current.cautious, current.pain_stop_threshold, current.note
        ) IS DISTINCT FROM ROW(
          input.body_part, input.affected_patterns, input.avoid,
          input.cautious, input.pain_stop_threshold, input.note
        )
      RETURNING target.*
    ), inserted_constraints AS (
      INSERT INTO constraints (
        id, user_id, body_part, affected_patterns, avoid, cautious,
        pain_stop_threshold, note
      )
      SELECT
        input.candidate_id, ${userId}::uuid, input.body_part,
        input.affected_patterns, input.avoid, input.cautious,
        input.pain_stop_threshold, input.note
      FROM constraint_input input
      JOIN constraint_matches matched ON matched.input_id = input.input_id
      WHERE matched.current_id IS NULL
        AND EXISTS (SELECT 1 FROM target_profile)
      RETURNING *
    ), deleted_constraints AS (
      DELETE FROM constraints target
      USING current_constraints current
      WHERE target.id = current.id
        AND EXISTS (SELECT 1 FROM target_profile)
        AND NOT EXISTS (
          SELECT 1 FROM constraint_matches matched WHERE matched.current_id = current.id
        )
      RETURNING target.*
    ), constraint_versions AS (
      INSERT INTO record_versions (
        user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        ${userId}::uuid, 'constraint', current.id, 'constraint.update',
        current.before_data, to_jsonb(updated),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(current.before_data) old_value
          JOIN jsonb_each(to_jsonb(updated)) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
          ORDER BY old_value.key
        )
      FROM current_constraints current
      JOIN updated_constraints updated ON updated.id = current.id
      UNION ALL
      SELECT
        ${userId}::uuid, 'constraint', inserted.id, 'constraint.create',
        '{}'::jsonb, to_jsonb(inserted),
        ARRAY['body_part', 'affected_patterns', 'avoid', 'cautious', 'pain_stop_threshold', 'note']::text[]
      FROM inserted_constraints inserted
      UNION ALL
      SELECT
        ${userId}::uuid, 'constraint', current.id, 'constraint.remove',
        current.before_data, '{}'::jsonb,
        ARRAY['body_part', 'affected_patterns', 'avoid', 'cautious', 'pain_stop_threshold', 'note']::text[]
      FROM current_constraints current
      JOIN deleted_constraints deleted ON deleted.id = current.id
      RETURNING id
    ), updated_profile AS (
      UPDATE user_profiles
      SET setup_state = ${completedStepsExpression("constraints")},
          updated_at = now()
      WHERE id IN (SELECT id FROM target_profile)
        AND ${!isReview}::boolean
      RETURNING id
    ), inserted_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, summary, cause_ref
      )
      SELECT
        ${userId}::uuid, 'user', ${auditAction}, 'constraint_set',
        ${auditSummary},
        jsonb_build_object('versionCount', (SELECT count(*) FROM constraint_versions))
      FROM target_profile
      WHERE ${!isReview}::boolean
         OR (SELECT count(*) FROM constraint_versions) > 0
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM target_profile) AS gates,
      (SELECT count(*)::int FROM updated_profile) AS profiles,
      (SELECT count(*)::int FROM inserted_audit) AS audits,
      (SELECT count(*)::int FROM constraint_versions) AS versions
  `;
  const row = resultRows(await db.execute(query))[0];
  if (!row || Number(row.gates) !== 1) {
    return { ok: false, reason: "The constraints could not be saved." };
  }
  const versionCount = Number(row.versions);
  const expectedProfiles = isReview ? 0 : 1;
  const expectedAudits = isReview ? (versionCount > 0 ? 1 : 0) : 1;
  if (
    Number(row.profiles) !== expectedProfiles ||
    Number(row.audits) !== expectedAudits
  ) {
    return { ok: false, reason: "The constraints could not be saved." };
  }
  return { ok: true, changed: versionCount > 0, versionCount };
}
