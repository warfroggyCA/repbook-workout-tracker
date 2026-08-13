import { afterEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  runSimultaneously,
  type TestDatabase,
} from "../helpers/database";
import { mutateSessionEquipmentSelection } from "@/services/session-equipment-selection";
import { mutateWorkoutOccurrence } from "@/services/session-lifecycle";
import { logWorkoutSet } from "../helpers/log-workout-set";
import {
  restoreRecordVersion,
  updateSessionExerciseWithVersion,
} from "@/services/record-versions";
import type { Db } from "@/db";
import {
  loadEquipmentInventoryDocument,
} from "@/services/equipment-inventory";
import { saveInventoryDocumentForManagement } from "@/services/setup-persistence";

const ids = {
  user: "10000000-0000-4000-8000-000000000070",
  otherUser: "10000000-0000-4000-8000-000000000071",
  exercise: "20000000-0000-4000-8000-000000000070",
  session: "30000000-0000-4000-8000-000000000070",
  sessionExercise: "40000000-0000-4000-8000-000000000070",
  occurrence: "50000000-0000-4000-8000-000000000070",
  bar: "60000000-0000-4000-8000-000000000070",
  secondBar: "60000000-0000-4000-8000-000000000071",
  plate: "70000000-0000-4000-8000-000000000070",
  selectKey: "80000000-0000-4000-8000-000000000070",
  clearKey: "80000000-0000-4000-8000-000000000071",
  staleKey: "80000000-0000-4000-8000-000000000072",
  ambiguousKey: "80000000-0000-4000-8000-000000000073",
  invalidKey: "80000000-0000-4000-8000-000000000074",
  inactiveKey: "80000000-0000-4000-8000-000000000075",
  occurrenceMutationKey: "80000000-0000-4000-8000-000000000080",
  noChangeKey: "80000000-0000-4000-8000-000000000081",
  skipKey: "80000000-0000-4000-8000-000000000082",
  restoreKey: "80000000-0000-4000-8000-000000000083",
  cableExercise: "20000000-0000-4000-8000-000000000076",
  alternateExercise: "20000000-0000-4000-8000-000000000077",
  cable: "60000000-0000-4000-8000-000000000076",
  rope: "60000000-0000-4000-8000-000000000077",
  cableProfile: "61000000-0000-4000-8000-000000000076",
  ropeProfile: "61000000-0000-4000-8000-000000000077",
  machine: "60000000-0000-4000-8000-000000000078",
  machineProfile: "61000000-0000-4000-8000-000000000078",
  secondaryPlate: "70000000-0000-4000-8000-000000000079",
  barDefinition: "62000000-0000-4000-8000-000000000070",
  wrongBarDefinition: "62000000-0000-4000-8000-000000000071",
};

async function seed(
  database: TestDatabase,
  options: {
    loadType?: "barbell" | "ez_bar" | "trap_bar";
    reviewedExact?: boolean;
    retainedRequirements?: boolean;
    retainedDefinitionSpecific?: boolean;
  } = {},
) {
  const loadType = options.loadType ?? "barbell";
  const reviewedExact = options.reviewedExact ?? true;
  const retainedDefinitionSpecific = options.retainedDefinitionSpecific ?? false;
  const retainedColumns = options.retainedRequirements
    ? ", equipment_requirements_semantics_version, equipment_requirements_snapshot"
    : "";
  const retainedValues = options.retainedRequirements
    ? `, 1, jsonb_build_object(
        'sourceExerciseId', '${ids.exercise}',
        'broad', (
          SELECT jsonb_agg(jsonb_build_object(
            'sourceRequirementId', requirement.id::text,
            'equipmentType', requirement.equipment_type::text,
            'equipmentDefinition', CASE WHEN definition.id IS NULL THEN NULL
              ELSE jsonb_build_object(
                'id', definition.id::text,
                'key', definition.key,
                'label', definition.label
              ) END,
            'minWeight', requirement.min_weight
          ) ORDER BY requirement.id)
          FROM exercise_equipment_requirements requirement
          LEFT JOIN equipment_definitions definition
            ON definition.id = requirement.equipment_definition_id
          WHERE requirement.exercise_id = '${ids.exercise}'
        ),
        'exact', (
          SELECT jsonb_build_object(
            'sourceRequirementId', requirement.id::text,
            'requiredProfileKind', requirement.required_profile_kind,
            'requiredEquipmentDefinition', NULL,
            'requiredAttachmentKind', requirement.required_attachment_kind,
            'requiredAttachmentDefinition', NULL,
            'requiresKnownGeometry', requirement.requires_known_geometry
          )
          FROM exercise_execution_requirements requirement
          WHERE requirement.exercise_id = '${ids.exercise}'
        )
      )`
    : "";
  await database.client.exec(`
    INSERT INTO users (id, email) VALUES
      ('${ids.user}', 'selection-owner@example.test'),
      ('${ids.otherUser}', 'selection-other@example.test');
    INSERT INTO user_profiles (user_id, unit) VALUES
      ('${ids.user}', 'lb'), ('${ids.otherUser}', 'lb');
    INSERT INTO exercises (
      id, name, movement_pattern, primary_muscles, load_type, catalog_reviewed
    ) VALUES (
      '${ids.exercise}', 'Exact Selection Bench', 'horizontal_push',
      '["chest"]'::jsonb, '${loadType}', true
    );
    ${retainedDefinitionSpecific ? `INSERT INTO equipment_definitions (
      id, key, label, category
    ) VALUES
      ('${ids.barDefinition}', 'retained-correct-bar', 'Correct retained bar', '${loadType}'),
      ('${ids.wrongBarDefinition}', 'retained-wrong-bar', 'Wrong same-type bar', '${loadType}');` : ""}
    INSERT INTO exercise_equipment_requirements (
      exercise_id, equipment_type
    ) VALUES
      ('${ids.exercise}', '${loadType}'),
      ('${ids.exercise}', 'plates');
    ${retainedDefinitionSpecific ? `UPDATE exercise_equipment_requirements
      SET equipment_definition_id = '${ids.barDefinition}'
      WHERE exercise_id = '${ids.exercise}' AND equipment_type = '${loadType}';` : ""}
    ${reviewedExact ? `INSERT INTO exercise_execution_requirements (
      exercise_id, required_profile_kind, requires_known_geometry, reviewed_at
    ) VALUES (
      '${ids.exercise}', 'plate_loaded_implement', true, now()
    );` : ""}
    INSERT INTO workout_sessions (
      id, user_id, timezone, local_date, started_at, status
    ) VALUES (
      '${ids.session}', '${ids.user}', 'America/Toronto', '2026-07-21',
      '2026-07-21T17:00:00Z', 'in_progress'
    );
    INSERT INTO session_exercises (
      id, session_id, exercise_id, order_idx${retainedColumns}
    ) VALUES ('${ids.sessionExercise}', '${ids.session}', '${ids.exercise}', 0${retainedValues});
    INSERT INTO session_occurrences (
      id, session_id, session_exercise_id, kind, origin, sequence_idx,
      kind_ordinal, planned_exercise_id, outcome
    ) VALUES (
      '${ids.occurrence}', '${ids.session}', '${ids.sessionExercise}',
      'working_set', 'planned', 0, 0, '${ids.exercise}', 'pending'
    );
    INSERT INTO equipment_items (id, user_id, type, label) VALUES
      ('${ids.bar}', '${ids.user}', '${loadType}', 'Owner exact bar');
    ${retainedDefinitionSpecific ? `UPDATE equipment_items
      SET definition_id = '${ids.barDefinition}' WHERE id = '${ids.bar}';` : ""}
    INSERT INTO plate_inventory (
      id, user_id, denomination, unit, quantity
    ) VALUES ('${ids.plate}', '${ids.user}', 2.5, 'lb', 4);
    INSERT INTO barbell_configs (
      user_id, bar_type, equipment_item_id, unit, loading_kind,
      shared_plate_pool_compatible, bar_weight, collar_weight, label
    ) VALUES (
      '${ids.user}', '${loadType === "ez_bar" ? "ez" : loadType === "trap_bar" ? "trap_hex" : "olympic"}',
      '${ids.bar}', 'lb', '${loadType === "ez_bar" ? "ez" : loadType === "trap_bar" ? "trap_hex" : "olympic"}', true,
      ${loadType === "ez_bar" ? 18 : loadType === "trap_bar" ? 55 : 45}, 1, 'Owner exact bar'
    );
  `);
}

async function seedCableSubstitution(database: TestDatabase) {
  await database.client.exec(`
    INSERT INTO users (id, email) VALUES
      ('${ids.user}', 'cable-substitution-owner@example.test');
    INSERT INTO user_profiles (user_id, unit) VALUES ('${ids.user}', 'lb');
    INSERT INTO exercises (
      id, name, movement_pattern, primary_muscles, load_type, catalog_reviewed
    ) VALUES
      ('${ids.cableExercise}', 'Reviewed rope pressdown', 'horizontal_push',
       '["triceps"]'::jsonb, 'external', true),
      ('${ids.alternateExercise}', 'Dumbbell extension', 'horizontal_push',
       '["triceps"]'::jsonb, 'dumbbell', true);
    INSERT INTO exercise_equipment_requirements (exercise_id, equipment_type)
    VALUES
      ('${ids.cableExercise}', 'cable'),
      ('${ids.alternateExercise}', 'dumbbell');
    INSERT INTO exercise_execution_requirements (
      exercise_id, required_profile_kind, required_attachment_kind,
      requires_known_geometry, reviewed_at
    ) VALUES (
      '${ids.cableExercise}', 'cable_machine', 'rope', true, now()
    );
    INSERT INTO workout_sessions (
      id, user_id, timezone, local_date, started_at, status
    ) VALUES (
      '${ids.session}', '${ids.user}', 'America/Toronto', '2026-07-21',
      '2026-07-21T17:00:00Z', 'in_progress'
    );
    INSERT INTO session_exercises (id, session_id, exercise_id, order_idx)
    VALUES ('${ids.sessionExercise}', '${ids.session}', '${ids.cableExercise}', 0);
    INSERT INTO session_occurrences (
      id, session_id, session_exercise_id, kind, origin, sequence_idx,
      kind_ordinal, planned_exercise_id, outcome
    ) VALUES (
      '${ids.occurrence}', '${ids.session}', '${ids.sessionExercise}',
      'working_set', 'planned', 0, 0, '${ids.cableExercise}', 'pending'
    );
    INSERT INTO equipment_items (id, user_id, type, label) VALUES
      ('${ids.cable}', '${ids.user}', 'cable', 'Cable station'),
      ('${ids.rope}', '${ids.user}', 'other', 'Rope attachment'),
      ('${ids.bar}', '${ids.user}', 'dumbbell', 'Dumbbells');
    INSERT INTO cable_machine_profiles (
      id, user_id, equipment_item_id, geometry_certainty, stack_count,
      topology, displayed_unit, ratio_status, ratio_numerator, ratio_denominator
    ) VALUES (
      '${ids.cableProfile}', '${ids.user}', '${ids.cable}', 'known', 1,
      'shared_selection', 'lb', 'known', 1, 1
    );
    INSERT INTO cable_stack_steps (
      user_id, cable_profile_id, stack_index, step_index, displayed_load
    ) VALUES
      ('${ids.user}', '${ids.cableProfile}', 0, 0, 10),
      ('${ids.user}', '${ids.cableProfile}', 0, 1, 20);
    INSERT INTO cable_attachment_profiles (
      id, user_id, equipment_item_id, attachment_kind, status
    ) VALUES (
      '${ids.ropeProfile}', '${ids.user}', '${ids.rope}', 'rope', 'known'
    );
    INSERT INTO cable_attachment_compatibilities (
      cable_profile_id, attachment_profile_id, user_id
    ) VALUES ('${ids.cableProfile}', '${ids.ropeProfile}', '${ids.user}');
  `);
  const selected = await mutateSessionEquipmentSelection(database.db, ids.user, {
    operation: "select",
    sessionExerciseId: ids.sessionExercise,
    equipmentItemId: ids.cable,
    attachmentItemId: ids.rope,
    expectedCurrentSnapshotId: null,
    clientKey: ids.selectKey,
    provenance: "user_selected",
  });
  if (!("snapshotId" in selected) || selected.snapshotId == null) {
    throw new Error("Cable selection did not produce a snapshot.");
  }
  return selected.snapshotId;
}

async function seedUnresolvableReviewedCable(database: TestDatabase) {
  await database.client.exec(`
    INSERT INTO users (id, email) VALUES
      ('${ids.user}', 'unresolvable-cable-owner@example.test');
    INSERT INTO user_profiles (user_id, unit) VALUES ('${ids.user}', 'lb');
    INSERT INTO exercises (
      id, name, movement_pattern, primary_muscles, load_type, catalog_reviewed
    ) VALUES (
      '${ids.cableExercise}', 'Lat Pulldown', 'vertical_pull',
      '["lats"]'::jsonb, 'external', true
    );
    INSERT INTO exercise_equipment_requirements (exercise_id, equipment_type)
    VALUES ('${ids.cableExercise}', 'cable');
    INSERT INTO exercise_execution_requirements (
      exercise_id, required_profile_kind, required_attachment_kind,
      requires_known_geometry, reviewed_at
    ) VALUES (
      '${ids.cableExercise}', 'cable_machine', 'lat_pulldown_bar', true, now()
    );
    INSERT INTO workout_sessions (
      id, user_id, timezone, local_date, started_at, status
    ) VALUES (
      '${ids.session}', '${ids.user}', 'America/Toronto', '2026-07-22',
      '2026-07-23T01:00:00Z', 'in_progress'
    );
    INSERT INTO session_exercises (id, session_id, exercise_id, order_idx)
    VALUES ('${ids.sessionExercise}', '${ids.session}', '${ids.cableExercise}', 0);
    INSERT INTO session_occurrences (
      id, session_id, session_exercise_id, kind, origin, sequence_idx,
      kind_ordinal, planned_exercise_id, outcome
    ) VALUES (
      '${ids.occurrence}', '${ids.session}', '${ids.sessionExercise}',
      'working_set', 'planned', 0, 0, '${ids.cableExercise}', 'pending'
    );
    INSERT INTO equipment_items (id, user_id, type, label)
    VALUES ('${ids.cable}', '${ids.user}', 'cable', 'Cable station');
    INSERT INTO cable_machine_profiles (
      id, user_id, equipment_item_id, geometry_certainty, stack_count,
      topology, displayed_unit, ratio_status, ratio_numerator, ratio_denominator
    ) VALUES (
      '${ids.cableProfile}', '${ids.user}', '${ids.cable}', 'known', 1,
      'shared_selection', 'lb', 'known', 1, 1
    );
    INSERT INTO cable_stack_steps (
      user_id, cable_profile_id, stack_index, step_index, displayed_load
    ) VALUES
      ('${ids.user}', '${ids.cableProfile}', 0, 0, 80);
  `);
}

describe("session equipment selection service", () => {
  let database: TestDatabase | undefined;
  afterEach(async () => database?.close());

  it("requires acknowledged exact equipment and stores identical set and occurrence evidence", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);

    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 50,
      weightUnit: "lb",
      reps: 8,
      clientKey: "set-before-exact-selection",
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown",
    })).resolves.toEqual({ outcome: "equipment_selection_required" });

    const selected = await mutateSessionEquipmentSelection(
      database.db,
      ids.user,
      {
        operation: "select",
        sessionExerciseId: ids.sessionExercise,
        equipmentItemId: ids.bar,
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        clientKey: ids.selectKey,
        provenance: "user_selected",
      },
    );
    if (!("snapshotId" in selected) || selected.snapshotId == null) {
      throw new Error("Selection did not produce a snapshot.");
    }

    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 50,
      weightUnit: "lb",
      reps: 8,
      clientKey: "wrong-exact-entry-meaning",
      equipmentSnapshotId: selected.snapshotId,
      loadEntryMeaning: "per_loading_point",
    })).resolves.toEqual({ outcome: "equipment_selection_conflict" });

    const command = {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 50,
      weightUnit: "lb" as const,
      reps: 8,
      clientKey: "acknowledged-exact-set",
      equipmentSnapshotId: selected.snapshotId,
      loadEntryMeaning: "total_system" as const,
    };
    const saved = await logWorkoutSet(database.db, ids.user, command);
    expect(saved).toMatchObject({ outcome: "saved" });

    const evidence = await database.client.query<{
      completed_snapshot: string;
      occurrence_snapshot: string;
      load_entry_meaning: string;
    }>(`
      SELECT completed.equipment_snapshot_id::text AS completed_snapshot,
             occurrence.equipment_snapshot_id::text AS occurrence_snapshot,
             completed.load_entry_meaning
      FROM completed_sets completed
      JOIN session_occurrences occurrence
        ON occurrence.completed_set_id = completed.id
      WHERE completed.client_key = 'acknowledged-exact-set'
    `);
    expect(evidence.rows).toEqual([{
      completed_snapshot: selected.snapshotId,
      occurrence_snapshot: selected.snapshotId,
      load_entry_meaning: "total_system",
    }]);

    await expect(mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "clear",
      sessionExerciseId: ids.sessionExercise,
      expectedCurrentSnapshotId: selected.snapshotId,
      clientKey: ids.clearKey,
    })).resolves.toMatchObject({ outcome: "applied", snapshotId: null });

    await expect(logWorkoutSet(database.db, ids.user, command)).resolves
      .toEqual(saved);
    const counts = await database.client.query<{ completed: number }>(`
      SELECT count(*)::int AS completed FROM completed_sets
    `);
    expect(counts.rows).toEqual([{ completed: 1 }]);
  });

  it("selects and logs from retained requirements after the mutable catalog changes", async () => {
    database = await createMigratedTestDatabase();
    await seed(database, {
      retainedRequirements: true,
      retainedDefinitionSpecific: true,
    });
    await database.client.exec(`
      INSERT INTO equipment_items (
        id, user_id, type, definition_id, label
      ) VALUES (
        '${ids.secondBar}', '${ids.user}', 'barbell',
        '${ids.wrongBarDefinition}', 'Wrong same-type bar'
      );
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, collar_weight, label
      ) VALUES (
        '${ids.user}', 'olympic', '${ids.secondBar}', 'lb', 'olympic',
        true, 45, 1, 'Wrong same-type bar'
      );
    `);
    await expect(mutateSessionEquipmentSelection(
      database.db,
      ids.user,
      {
        operation: "select",
        sessionExerciseId: ids.sessionExercise,
        equipmentItemId: ids.secondBar,
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        clientKey: ids.invalidKey,
        provenance: "user_selected",
      },
    )).resolves.toEqual({ outcome: "invalid_setup" });
    await database.client.exec(`
      DELETE FROM exercise_execution_requirements
      WHERE exercise_id = '${ids.exercise}';
      DELETE FROM exercise_equipment_requirements
      WHERE exercise_id = '${ids.exercise}';
      INSERT INTO exercise_equipment_requirements (exercise_id, equipment_type)
      VALUES ('${ids.exercise}', 'bodyweight');
    `);

    const selected = await mutateSessionEquipmentSelection(
      database.db,
      ids.user,
      {
        operation: "select",
        sessionExerciseId: ids.sessionExercise,
        equipmentItemId: ids.bar,
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        clientKey: ids.selectKey,
        provenance: "user_selected",
      },
    );
    expect(selected).toMatchObject({ outcome: "applied" });
    if (!("snapshotId" in selected) || selected.snapshotId == null) {
      throw new Error("Retained selection did not produce a snapshot.");
    }
    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 50,
      weightUnit: "lb",
      reps: 8,
      clientKey: "retained-requirement-set",
      equipmentSnapshotId: selected.snapshotId,
      loadEntryMeaning: "total_system",
    })).resolves.toMatchObject({ outcome: "saved" });
  });

  it("rejects a retained primary that does not satisfy every same-type definition", async () => {
    database = await createMigratedTestDatabase();
    await seed(database, {
      retainedRequirements: true,
      retainedDefinitionSpecific: true,
    });
    const selected = await mutateSessionEquipmentSelection(
      database.db,
      ids.user,
      {
        operation: "select",
        sessionExerciseId: ids.sessionExercise,
        equipmentItemId: ids.bar,
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        clientKey: ids.selectKey,
        provenance: "user_selected",
      },
    );
    if (!("snapshotId" in selected) || selected.snapshotId == null) {
      throw new Error("Retained selection did not produce a snapshot.");
    }
    await database.client.exec(`
      INSERT INTO equipment_items (
        id, user_id, type, definition_id, label
      ) VALUES (
        '${ids.secondBar}', '${ids.user}', 'barbell',
        '${ids.wrongBarDefinition}', 'Wrong same-type bar'
      );
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, collar_weight, label
      ) VALUES (
        '${ids.user}', 'olympic', '${ids.secondBar}', 'lb', 'olympic',
        true, 45, 1, 'Wrong same-type bar'
      );
      BEGIN;
      SELECT set_config(
        'workout_tracker.authorized_delete', 'snapshot_restore', true
      );
      UPDATE session_exercises
      SET equipment_requirements_snapshot = jsonb_set(
        equipment_requirements_snapshot,
        '{broad}',
        equipment_requirements_snapshot->'broad' || jsonb_build_array(
          jsonb_build_object(
            'sourceRequirementId', '90000000-0000-4000-8000-000000000070',
            'equipmentType', 'barbell',
            'equipmentDefinition', jsonb_build_object(
              'id', '${ids.wrongBarDefinition}',
              'key', 'retained-wrong-bar',
              'label', 'Wrong same-type bar'
            ),
            'minWeight', NULL
          )
        )
      )
      WHERE id = '${ids.sessionExercise}';
      COMMIT;
    `);

    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 50,
      weightUnit: "lb",
      reps: 8,
      clientKey: "retained-conflicting-definition-set",
      equipmentSnapshotId: selected.snapshotId,
      loadEntryMeaning: "total_system",
    })).resolves.toEqual({ outcome: "equipment_selection_conflict" });
  });

  it("rejects definition-specific retained plates in selection and the set writer", async () => {
    database = await createMigratedTestDatabase();
    await seed(database, {
      retainedRequirements: true,
      retainedDefinitionSpecific: true,
    });
    const selected = await mutateSessionEquipmentSelection(
      database.db,
      ids.user,
      {
        operation: "select",
        sessionExerciseId: ids.sessionExercise,
        equipmentItemId: ids.bar,
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        clientKey: ids.selectKey,
        provenance: "user_selected",
      },
    );
    if (!("snapshotId" in selected) || selected.snapshotId == null) {
      throw new Error("Retained selection did not produce a snapshot.");
    }
    await database.client.exec(`
      BEGIN;
      SELECT set_config(
        'workout_tracker.authorized_delete', 'snapshot_restore', true
      );
      UPDATE session_exercises
      SET equipment_requirements_snapshot = jsonb_set(
        equipment_requirements_snapshot,
        '{broad}',
        (
          SELECT jsonb_agg(
            CASE WHEN requirement.value->>'equipmentType' = 'plates'
              THEN jsonb_set(
                requirement.value,
                '{equipmentDefinition}',
                jsonb_build_object(
                  'id', '${ids.barDefinition}',
                  'key', 'retained-correct-bar',
                  'label', 'Definition-specific plates'
                )
              )
              ELSE requirement.value
            END
            ORDER BY requirement.ordinality
          )
          FROM jsonb_array_elements(
            equipment_requirements_snapshot->'broad'
          ) WITH ORDINALITY requirement(value, ordinality)
        )
      )
      WHERE id = '${ids.sessionExercise}';
      COMMIT;
    `);

    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 50,
      weightUnit: "lb",
      reps: 8,
      clientKey: "retained-definition-plates-set",
      equipmentSnapshotId: selected.snapshotId,
      loadEntryMeaning: "total_system",
    })).resolves.toEqual({ outcome: "equipment_selection_conflict" });
    await expect(mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "clear",
      sessionExerciseId: ids.sessionExercise,
      expectedCurrentSnapshotId: selected.snapshotId,
      clientKey: ids.clearKey,
    })).resolves.toMatchObject({ outcome: "applied", snapshotId: null });
    await expect(mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.invalidKey,
      provenance: "user_selected",
    })).resolves.toEqual({ outcome: "invalid_setup" });
  });

  it("records displayed load with unknown setup when no reviewed matching setup exists", async () => {
    database = await createMigratedTestDatabase();
    await seedUnresolvableReviewedCable(database);

    const command = {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 80,
      weightUnit: "lb" as const,
      reps: 10,
      rpe: 8,
      clientKey: "unresolvable-reviewed-cable-set",
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown" as const,
    };
    const saved = await logWorkoutSet(database.db, ids.user, command);
    expect(saved).toMatchObject({ outcome: "saved" });
    await expect(logWorkoutSet(database.db, ids.user, command)).resolves.toEqual(saved);

    const evidence = await database.client.query<{
      completed_snapshot: string | null;
      occurrence_snapshot: string | null;
      load_entry_meaning: string;
      weight: number;
      reps: number;
      rpe: number;
    }>(`
      SELECT completed.equipment_snapshot_id::text AS completed_snapshot,
             occurrence.equipment_snapshot_id::text AS occurrence_snapshot,
             completed.load_entry_meaning,
             completed.weight::float8 AS weight,
             completed.reps,
             completed.rpe::float8 AS rpe
      FROM completed_sets completed
      JOIN session_occurrences occurrence
        ON occurrence.completed_set_id = completed.id
      WHERE completed.client_key = 'unresolvable-reviewed-cable-set'
    `);
    expect(evidence.rows).toEqual([{
      completed_snapshot: null,
      occurrence_snapshot: null,
      load_entry_meaning: "legacy_unknown",
      weight: 80,
      reps: 10,
      rpe: 8,
    }]);
  });

  it("keeps completed machine evidence immutable when Settings changes future guidance", async () => {
    database = await createMigratedTestDatabase();
    await database.client.exec(`
      INSERT INTO users (id, email)
      VALUES ('${ids.user}', 'machine-history-owner@example.test');
      INSERT INTO user_profiles (user_id, unit)
      VALUES ('${ids.user}', 'lb');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type, catalog_reviewed
      ) VALUES (
        '${ids.exercise}', 'Plate-Loaded Lat Pulldown', 'vertical_pull',
        '["back"]'::jsonb, 'external', true
      );
      INSERT INTO exercise_equipment_requirements (exercise_id, equipment_type)
      VALUES ('${ids.exercise}', 'machine');
      INSERT INTO exercise_execution_requirements (
        exercise_id, required_profile_kind, requires_known_geometry, reviewed_at
      ) VALUES ('${ids.exercise}', 'plate_loaded_machine', true, now());
      INSERT INTO workout_sessions (
        id, user_id, timezone, local_date, started_at, status
      ) VALUES (
        '${ids.session}', '${ids.user}', 'America/Toronto', '2026-07-22',
        '2026-07-22T17:00:00Z', 'in_progress'
      );
      INSERT INTO session_exercises (id, session_id, exercise_id, order_idx)
      VALUES ('${ids.sessionExercise}', '${ids.session}', '${ids.exercise}', 0);
      INSERT INTO session_occurrences (
        id, session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome
      ) VALUES (
        '${ids.occurrence}', '${ids.session}', '${ids.sessionExercise}',
        'working_set', 'planned', 0, 0, '${ids.exercise}', 'pending'
      );
      INSERT INTO equipment_items (id, user_id, type, label)
      VALUES ('${ids.machine}', '${ids.user}', 'machine', 'Two-sided Lat Pulldown');
      INSERT INTO plate_inventory (id, user_id, denomination, unit, quantity)
      VALUES
        ('${ids.plate}', '${ids.user}', 25, 'lb', 4),
        ('${ids.secondaryPlate}', '${ids.user}', 20, 'lb', 4);
      INSERT INTO plate_loaded_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty,
        starting_resistance, starting_resistance_unit, loading_point_count,
        balancing_rule, target_entry_meaning
      ) VALUES (
        '${ids.machineProfile}', '${ids.user}', '${ids.machine}', 'known',
        0, 'lb', 2, 'identical_each_point', 'total_system'
      );
    `);
    const selected = await mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.machine,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.selectKey,
      provenance: "user_selected",
    });
    if (!("snapshotId" in selected) || selected.snapshotId == null) {
      throw new Error("Machine selection did not produce a snapshot.");
    }
    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 10,
      clientKey: "immutable-machine-set",
      equipmentSnapshotId: selected.snapshotId,
      loadEntryMeaning: "total_system",
    })).resolves.toMatchObject({ outcome: "saved" });

    const loaded = await loadEquipmentInventoryDocument(database.db, ids.user);
    const changed = {
      ...loaded!.document,
      loadProfiles: loaded!.document.loadProfiles!.map((entry) =>
        entry.equipmentItemId === ids.machine &&
        entry.profile.kind === "plate_loaded_machine"
          ? {
              ...entry,
              profile: { ...entry.profile, startingResistance: 10 },
            }
          : entry
      ),
    };
    await expect(
      saveInventoryDocumentForManagement(database.db, ids.user, changed),
    ).resolves.toMatchObject({ ok: true });

    const evidence = await database.client.query<{
      recorded_start: number;
      current_start: number;
      completed_snapshot: string;
      compatible_plates: Array<{
        denomination: number;
        quantity: number;
        unit: string;
      }>;
    }>(`
      SELECT
        (snapshot.geometry_snapshot->>'startingResistance')::float8 AS recorded_start,
        profile.starting_resistance::float8 AS current_start,
        completed.equipment_snapshot_id::text AS completed_snapshot,
        snapshot.geometry_snapshot->'compatiblePlates' AS compatible_plates
      FROM completed_sets completed
      JOIN session_equipment_snapshots snapshot
        ON snapshot.id = completed.equipment_snapshot_id
      JOIN plate_loaded_machine_profiles profile
        ON profile.equipment_item_id = snapshot.equipment_item_id
      WHERE completed.client_key = 'immutable-machine-set'
    `);
    expect(evidence.rows).toEqual([{
      recorded_start: 0,
      current_start: 10,
      completed_snapshot: selected.snapshotId,
      compatible_plates: [{
        denomination: 25,
        quantity: 4,
        unit: "lb",
      }, {
        denomination: 20,
        quantity: 4,
        unit: "lb",
      }],
    }]);
  });

  it("requires and retains the 18 lb EZ setup without a reviewed exact-requirement row", async () => {
    database = await createMigratedTestDatabase();
    await seed(database, { loadType: "ez_bar", reviewedExact: false });

    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 23,
      weightUnit: "lb",
      reps: 10,
      clientKey: "ez-set-before-selection",
      equipmentSnapshotId: null,
      loadEntryMeaning: "legacy_unknown",
    })).resolves.toEqual({ outcome: "equipment_selection_required" });

    const selected = await mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.selectKey,
      provenance: "user_selected",
    });
    if (!("snapshotId" in selected) || selected.snapshotId == null) {
      throw new Error("EZ selection did not produce a snapshot.");
    }

    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 23,
      weightUnit: "lb",
      reps: 10,
      clientKey: "acknowledged-ez-set",
      equipmentSnapshotId: selected.snapshotId,
      loadEntryMeaning: "total_system",
    })).resolves.toMatchObject({ outcome: "saved" });

    const evidence = await database.client.query<{
      empty_weight: number;
      completed_snapshot: string;
      occurrence_snapshot: string;
    }>(`
      SELECT (snapshot.geometry_snapshot->>'emptyWeight')::float8 AS empty_weight,
             completed.equipment_snapshot_id::text AS completed_snapshot,
             occurrence.equipment_snapshot_id::text AS occurrence_snapshot
      FROM completed_sets completed
      JOIN session_occurrences occurrence ON occurrence.completed_set_id = completed.id
      JOIN session_equipment_snapshots snapshot
        ON snapshot.id = completed.equipment_snapshot_id
      WHERE completed.client_key = 'acknowledged-ez-set'
    `);
    expect(evidence.rows).toEqual([{
      empty_weight: 18,
      completed_snapshot: selected.snapshotId,
      occurrence_snapshot: selected.snapshotId,
    }]);
  });

  it("requires and retains an exact trap-bar setup without a reviewed exact-requirement row", async () => {
    database = await createMigratedTestDatabase();
    await seed(database, { loadType: "trap_bar", reviewedExact: false });

    const selected = await mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.selectKey,
      provenance: "user_selected",
    });
    if (!("snapshotId" in selected) || selected.snapshotId == null) {
      throw new Error("Trap-bar selection did not produce a snapshot.");
    }

    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 60,
      weightUnit: "lb",
      reps: 8,
      clientKey: "acknowledged-trap-bar-set",
      equipmentSnapshotId: selected.snapshotId,
      loadEntryMeaning: "total_system",
    })).resolves.toMatchObject({ outcome: "saved" });
  });

  it("snapshots and updates pending work atomically without relabelling live rows on replay", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    const input = {
      operation: "select" as const,
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.selectKey,
      provenance: "user_selected" as const,
    };

    const selected = await mutateSessionEquipmentSelection(
      database.db,
      ids.user,
      input,
    );
    expect(selected.outcome).toBe("applied");
    expect("snapshotId" in selected && selected.snapshotId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(
      "occurrenceStates" in selected && selected.occurrenceStates,
    ).toEqual([expect.objectContaining({
      id: ids.occurrence,
      outcome: "pending",
      previousRevision: 0,
      revision: 1,
    })]);

    const stored = await database.client.query<{
      configuration_hash: string;
      geometry_snapshot: {
        kind: string;
        compatiblePlates: Array<{ denomination: number; quantity: number; unit: string }>;
      };
      current_snapshot: string;
      occurrence_snapshot: string;
      revision: number;
    }>(`
      SELECT snapshot.configuration_hash, snapshot.geometry_snapshot,
             exercise.current_equipment_snapshot_id::text AS current_snapshot,
             occurrence.equipment_snapshot_id::text AS occurrence_snapshot,
             occurrence.revision
      FROM session_equipment_snapshots snapshot
      JOIN session_exercises exercise
        ON exercise.current_equipment_snapshot_id = snapshot.id
      JOIN session_occurrences occurrence
        ON occurrence.session_exercise_id = exercise.id
      WHERE exercise.id = '${ids.sessionExercise}'
    `);
    expect(stored.rows[0]).toMatchObject({
      configuration_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      geometry_snapshot: {
        kind: "plate_loaded_implement",
        compatiblePlates: [{ denomination: 2.5, quantity: 4, unit: "lb" }],
      },
      current_snapshot: stored.rows[0].occurrence_snapshot,
      revision: 1,
    });

    expect(await mutateSessionEquipmentSelection(database.db, ids.user, {
      ...input,
      expectedCurrentSnapshotId: stored.rows[0].current_snapshot,
      clientKey: ids.noChangeKey,
    })).toEqual({
      outcome: "no_change",
      snapshotId: stored.rows[0].current_snapshot,
      occurrenceStates: [expect.objectContaining({
        id: ids.occurrence,
        outcome: "pending",
        previousRevision: 1,
        revision: 1,
      })],
    });

    await expect(mutateWorkoutOccurrence(database.db, ids.user, {
      occurrenceId: ids.occurrence,
      clientKey: ids.occurrenceMutationKey,
      expectedRevision: 1,
      operation: "note",
      note: "Changed in another tab after the equipment save",
    })).resolves.toMatchObject({
      outcome: "saved",
      occurrence: { revision: 2 },
    });

    expect(await mutateSessionEquipmentSelection(database.db, ids.user, input))
      .toEqual({
        outcome: "replayed",
        snapshotId: stored.rows[0].current_snapshot,
        occurrenceStates: [],
      });
    const counts = await database.client.query<{ snapshots: number; receipts: number }>(`
      SELECT
        (SELECT count(*)::int FROM session_equipment_snapshots) AS snapshots,
        (SELECT count(*)::int FROM session_equipment_selection_receipts) AS receipts
    `);
    expect(counts.rows).toEqual([{ snapshots: 1, receipts: 2 }]);

    expect(await mutateSessionEquipmentSelection(database.db, ids.user, {
      ...input,
      provenance: "auto_unique",
    })).toEqual({ outcome: "conflict" });
  });

  it("reports the locked pre-selection revision after a skip and restore", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    await expect(mutateWorkoutOccurrence(database.db, ids.user, {
      occurrenceId: ids.occurrence,
      clientKey: ids.skipKey,
      expectedRevision: 0,
      operation: "skip",
      reason: "Interrupted",
    })).resolves.toMatchObject({
      outcome: "saved",
      occurrence: { revision: 1, state: "skipped" },
    });
    await expect(mutateWorkoutOccurrence(database.db, ids.user, {
      occurrenceId: ids.occurrence,
      clientKey: ids.restoreKey,
      expectedRevision: 1,
      operation: "restore",
    })).resolves.toMatchObject({
      outcome: "saved",
      occurrence: { revision: 2, state: "pending" },
    });

    await expect(mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.selectKey,
      provenance: "user_selected",
    })).resolves.toEqual({
      outcome: "applied",
      snapshotId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      occurrenceStates: [expect.objectContaining({
        id: ids.occurrence,
        outcome: "pending",
        previousRevision: 2,
        revision: 3,
      })],
    });
  });

  it("returns stale instead of storing a hybrid snapshot when live setup changes during selection", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    let executeCount = 0;
    const racingDb = {
      execute: async (...args: Parameters<Db["execute"]>) => {
        executeCount += 1;
        const result = await database!.db.execute(...args);
        if (executeCount === 8) {
          await database!.client.exec(`
            UPDATE plate_inventory SET quantity = 6 WHERE id = '${ids.plate}'
          `);
        }
        return result;
      },
    } as unknown as Db;

    const result = await mutateSessionEquipmentSelection(racingDb, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.staleKey,
      provenance: "user_selected",
    });
    expect(result).toEqual({ outcome: "stale" });
    const snapshots = await database.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM session_equipment_snapshots",
    );
    expect(snapshots.rows).toEqual([{ count: 0 }]);
  });

  it("clears only pending references with a revision and detects stale or foreign input", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    const selected = await mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.selectKey,
      provenance: "user_selected",
    });
    if (!("snapshotId" in selected) || selected.snapshotId == null) {
      throw new Error("Selection did not produce a snapshot.");
    }

    expect(await mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.staleKey,
      provenance: "user_selected",
    })).toEqual({ outcome: "stale" });
    expect(await mutateSessionEquipmentSelection(database.db, ids.otherUser, {
      operation: "clear",
      sessionExerciseId: ids.sessionExercise,
      expectedCurrentSnapshotId: selected.snapshotId,
      clientKey: ids.clearKey,
    })).toEqual({ outcome: "not_found" });

    const clear = {
      operation: "clear" as const,
      sessionExerciseId: ids.sessionExercise,
      expectedCurrentSnapshotId: selected.snapshotId,
      clientKey: ids.clearKey,
    };
    expect(await mutateSessionEquipmentSelection(database.db, ids.user, clear))
      .toEqual({
        outcome: "applied",
        snapshotId: null,
        occurrenceStates: [expect.objectContaining({
          id: ids.occurrence,
          outcome: "pending",
          previousRevision: 1,
          revision: 2,
        })],
      });
    expect(await mutateSessionEquipmentSelection(database.db, ids.user, clear))
      .toEqual({
        outcome: "replayed",
        snapshotId: null,
        occurrenceStates: [],
      });

    const rows = await database.client.query<{
      current_snapshot: string | null;
      occurrence_snapshot: string | null;
      revision: number;
    }>(`
      SELECT exercise.current_equipment_snapshot_id::text AS current_snapshot,
             occurrence.equipment_snapshot_id::text AS occurrence_snapshot,
             occurrence.revision
      FROM session_exercises exercise
      JOIN session_occurrences occurrence
        ON occurrence.session_exercise_id = exercise.id
      WHERE exercise.id = '${ids.sessionExercise}'
    `);
    expect(rows.rows).toEqual([{
      current_snapshot: null,
      occurrence_snapshot: null,
      revision: 2,
    }]);

    await database.client.exec(`
      UPDATE workout_sessions
      SET status = 'completed', finished_at = now()
      WHERE id = '${ids.session}'
    `);
    expect(await mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "clear",
      sessionExerciseId: ids.sessionExercise,
      expectedCurrentSnapshotId: null,
      clientKey: ids.inactiveKey,
    })).toEqual({ outcome: "not_active" });
  });

  it("refuses automatic selection when two exact same-type setups are plausible", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    await database.client.exec(`
      INSERT INTO equipment_items (id, user_id, type, label) VALUES
        ('${ids.secondBar}', '${ids.user}', 'barbell', 'Owner 35 lb bar');
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, collar_weight, label
      ) VALUES (
        '${ids.user}', 'olympic', '${ids.secondBar}', 'lb', 'olympic', true,
        35, 0, 'Owner 35 lb bar'
      );
    `);

    expect(await mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.ambiguousKey,
      provenance: "auto_unique",
    })).toEqual({ outcome: "ambiguous" });
  });

  it("does not use another owned item to satisfy the selected item's minimum", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    await database.client.exec(`
      UPDATE exercise_equipment_requirements
      SET min_weight = 40
      WHERE exercise_id = '${ids.exercise}' AND equipment_type = 'barbell';
      UPDATE equipment_items
      SET attrs = '{"maxWeight":35}'::jsonb
      WHERE id = '${ids.bar}';
      INSERT INTO equipment_items (id, user_id, type, label, attrs) VALUES
        ('${ids.secondBar}', '${ids.user}', 'barbell', 'Unprofiled 100 lb item',
         '{"maxWeight":100}'::jsonb);
    `);

    expect(await mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.ambiguousKey,
      provenance: "user_selected",
    })).toEqual({ outcome: "invalid_setup" });
  });

  it("rejects an attachment for a profile that cannot use attachments", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    expect(await mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: ids.secondBar,
      expectedCurrentSnapshotId: null,
      clientKey: ids.invalidKey,
      provenance: "user_selected",
    })).toEqual({ outcome: "invalid_setup" });
  });

  it("clears an old cable and attachment on substitution and does not resurrect it on undo", async () => {
    database = await createMigratedTestDatabase();
    const snapshotId = await seedCableSubstitution(database);

    const substituted = await updateSessionExerciseWithVersion(
      database.db,
      ids.user,
      ids.sessionExercise,
      {
        exerciseId: ids.alternateExercise,
        modificationType: "substituted",
        substitutedForExerciseId: ids.cableExercise,
        substitutionReason: "equipment_busy",
        substitutedAt: new Date("2026-07-21T17:05:00Z"),
      },
      "session_exercise.substitute",
      { activeOnly: true },
    );
    if (!substituted.ok || !substituted.versionId) {
      throw new Error("Substitution did not create a restorable version.");
    }

    const afterSubstitution = await database.client.query<{
      current_snapshot: string | null;
      occurrence_snapshot: string | null;
      revision: number;
      retained_snapshot: number;
    }>(`
      SELECT exercise.current_equipment_snapshot_id::text AS current_snapshot,
             occurrence.equipment_snapshot_id::text AS occurrence_snapshot,
             occurrence.revision,
             (SELECT count(*)::int FROM session_equipment_snapshots
              WHERE id = '${snapshotId}') AS retained_snapshot
      FROM session_exercises exercise
      JOIN session_occurrences occurrence
        ON occurrence.session_exercise_id = exercise.id
      WHERE exercise.id = '${ids.sessionExercise}'
    `);
    expect(afterSubstitution.rows).toEqual([{
      current_snapshot: null,
      occurrence_snapshot: null,
      revision: 2,
      retained_snapshot: 1,
    }]);
    await expect(mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.cable,
      attachmentItemId: ids.rope,
      expectedCurrentSnapshotId: null,
      clientKey: ids.staleKey,
      provenance: "user_selected",
    })).resolves.toEqual({ outcome: "invalid_setup" });
    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 20,
      weightUnit: "lb",
      reps: 10,
      clientKey: "stale-cable-after-substitution",
      equipmentSnapshotId: snapshotId,
      loadEntryMeaning: "displayed_stack",
    })).resolves.toEqual({ outcome: "equipment_selection_conflict" });

    await expect(
      restoreRecordVersion(database.db, ids.user, substituted.versionId, {
        activeOnly: true,
      }),
    ).resolves.toMatchObject({ ok: true, changed: true });
    const afterUndo = await database.client.query<{
      exercise_id: string;
      current_snapshot: string | null;
      occurrence_snapshot: string | null;
      revision: number;
    }>(`
      SELECT exercise.exercise_id::text,
             exercise.current_equipment_snapshot_id::text AS current_snapshot,
             occurrence.equipment_snapshot_id::text AS occurrence_snapshot,
             occurrence.revision
      FROM session_exercises exercise
      JOIN session_occurrences occurrence
        ON occurrence.session_exercise_id = exercise.id
      WHERE exercise.id = '${ids.sessionExercise}'
    `);
    expect(afterUndo.rows).toEqual([{
      exercise_id: ids.cableExercise,
      current_snapshot: null,
      occurrence_snapshot: null,
      revision: 2,
    }]);
    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 20,
      weightUnit: "lb",
      reps: 10,
      clientKey: "old-cable-after-undo",
      equipmentSnapshotId: snapshotId,
      loadEntryMeaning: "displayed_stack",
    })).resolves.toEqual({ outcome: "equipment_selection_required" });
  });

  it("revalidates reviewed attachment predicates when saving a set", async () => {
    database = await createMigratedTestDatabase();
    const snapshotId = await seedCableSubstitution(database);
    await database.client.exec(`
      UPDATE exercise_execution_requirements
      SET required_attachment_kind = 'straight_bar'
      WHERE exercise_id = '${ids.cableExercise}'
    `);

    await expect(logWorkoutSet(database.db, ids.user, {
      sessionExerciseId: ids.sessionExercise,
      setNo: 1,
      weight: 20,
      weightUnit: "lb",
      reps: 10,
      clientKey: "reviewed-predicate-changed",
      equipmentSnapshotId: snapshotId,
      loadEntryMeaning: "displayed_stack",
    })).resolves.toEqual({ outcome: "equipment_selection_conflict" });
  });

  it("serializes set logging against substitution so evidence cannot be relabelled", async () => {
    database = await createMigratedTestDatabase();
    const snapshotId = await seedCableSubstitution(database);

    const concurrent = await runSimultaneously(2, async (index) => {
      if (index === 0) {
        return {
          kind: "logged" as const,
          result: await logWorkoutSet(database!.db, ids.user, {
            sessionExerciseId: ids.sessionExercise,
            setNo: 1,
            weight: 20,
            weightUnit: "lb",
            reps: 10,
            clientKey: "concurrent-cable-set",
            equipmentSnapshotId: snapshotId,
            loadEntryMeaning: "displayed_stack",
          }),
        };
      }
      return {
        kind: "substituted" as const,
        result: await updateSessionExerciseWithVersion(
          database!.db,
          ids.user,
          ids.sessionExercise,
          {
            exerciseId: ids.alternateExercise,
            modificationType: "substituted",
            substitutedForExerciseId: ids.cableExercise,
            substitutionReason: "equipment_busy",
            substitutedAt: new Date("2026-07-21T17:06:00Z"),
          },
          "session_exercise.substitute",
          { activeOnly: true },
        ),
      };
    });
    const logged = concurrent.find((entry) => entry.kind === "logged")!.result;
    const substituted = concurrent.find(
      (entry) => entry.kind === "substituted",
    )!.result;

    const state = await database.client.query<{
      exercise_id: string;
      completed_sets: number;
      current_snapshot: string | null;
    }>(`
      SELECT exercise.exercise_id::text,
             exercise.current_equipment_snapshot_id::text AS current_snapshot,
             (SELECT count(*)::int FROM completed_sets
              WHERE session_exercise_id = exercise.id) AS completed_sets
      FROM session_exercises exercise
      WHERE exercise.id = '${ids.sessionExercise}'
    `);
    if (logged.outcome === "saved") {
      expect(substituted).toEqual({
        ok: false,
        reason: "This exercise already has logged sets and cannot be substituted.",
      });
      expect(state.rows).toEqual([{
        exercise_id: ids.cableExercise,
        completed_sets: 1,
        current_snapshot: snapshotId,
      }]);
    } else {
      expect([
        "equipment_selection_conflict",
        "performed_evidence_conflict",
      ]).toContain(logged.outcome);
      if (logged.outcome === "performed_evidence_conflict") {
        expect(logged.reason).toBe("exercise_changed");
      }
      expect(substituted).toMatchObject({ ok: true, changed: true });
      expect(state.rows).toEqual([{
        exercise_id: ids.alternateExercise,
        completed_sets: 0,
        current_snapshot: null,
      }]);
    }
  });
});
