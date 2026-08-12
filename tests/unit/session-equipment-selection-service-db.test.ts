import { afterEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  runSimultaneously,
  type TestDatabase,
} from "../helpers/database";
import {
  mutateSessionEquipmentSelection,
  resolveSessionEquipmentAvailability,
} from "@/services/session-equipment-selection";
import { logWorkoutSet } from "../helpers/log-workout-set";
import {
  restoreRecordVersion,
  updateSessionExerciseWithVersion,
} from "@/services/record-versions";
import {
  loadEquipmentInventoryDocument,
} from "@/services/equipment-inventory";
import { saveInventoryDocumentForManagement } from "@/services/setup-persistence";
import { saveExerciseEquipmentFitAssertion } from "@/services/exercise-equipment-fit-management";

const ids = {
  user: "10000000-0000-4000-8000-000000000070",
  otherUser: "10000000-0000-4000-8000-000000000071",
  exercise: "20000000-0000-4000-8000-000000000070",
  session: "30000000-0000-4000-8000-000000000070",
  sessionExercise: "40000000-0000-4000-8000-000000000070",
  occurrence: "50000000-0000-4000-8000-000000000070",
  bar: "60000000-0000-4000-8000-000000000070",
  secondBar: "60000000-0000-4000-8000-000000000071",
  bench: "60000000-0000-4000-8000-000000000072",
  plate: "70000000-0000-4000-8000-000000000070",
  selectKey: "80000000-0000-4000-8000-000000000070",
  clearKey: "80000000-0000-4000-8000-000000000071",
  staleKey: "80000000-0000-4000-8000-000000000072",
  ambiguousKey: "80000000-0000-4000-8000-000000000073",
  invalidKey: "80000000-0000-4000-8000-000000000074",
  inactiveKey: "80000000-0000-4000-8000-000000000075",
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
  cableDefinition: "62000000-0000-4000-8000-000000000076",
  ropeDefinition: "62000000-0000-4000-8000-000000000077",
  fitMutation: "90000000-0000-4000-8000-000000000070",
  secondFitMutation: "90000000-0000-4000-8000-000000000071",
  thirdFitMutation: "90000000-0000-4000-8000-000000000072",
};

function retainedRequirementsSql(exerciseId: string) {
  return `jsonb_build_object(
    'sourceExerciseId', '${exerciseId}',
    'broad', coalesce((
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
      WHERE requirement.exercise_id = '${exerciseId}'
    ), '[]'::jsonb),
    'exact', (
      SELECT jsonb_build_object(
        'sourceRequirementId', requirement.id::text,
        'requiredProfileKind', requirement.required_profile_kind,
        'requiredEquipmentDefinition', CASE WHEN equipment_definition.id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'id', equipment_definition.id::text,
            'key', equipment_definition.key,
            'label', equipment_definition.label
          ) END,
        'requiredAttachmentKind', requirement.required_attachment_kind,
        'requiredAttachmentDefinition', CASE WHEN attachment_definition.id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'id', attachment_definition.id::text,
            'key', attachment_definition.key,
            'label', attachment_definition.label
          ) END,
        'requiresKnownGeometry', requirement.requires_known_geometry
      )
      FROM exercise_execution_requirements requirement
      LEFT JOIN equipment_definitions equipment_definition
        ON equipment_definition.id = requirement.required_equipment_definition_id
      LEFT JOIN equipment_definitions attachment_definition
        ON attachment_definition.id = requirement.required_attachment_definition_id
      WHERE requirement.exercise_id = '${exerciseId}'
      LIMIT 1
    )
  )`;
}

async function retainCompatibleFit(
  database: TestDatabase,
  exerciseId: string,
  equipmentItemId: string,
  mutationId = ids.fitMutation,
) {
  const result = await saveExerciseEquipmentFitAssertion(database.db, ids.user, {
    mutationId,
    assertionId: null,
    exerciseId,
    equipmentItemId,
    verdict: "compatible",
    reasonCode: "owner_verified",
    reasonNote: null,
    expectedRevision: null,
  });
  if (!result.ok) throw new Error(`Could not retain test fit: ${result.reason}`);
}

async function seed(
  database: TestDatabase,
  options: {
    loadType?: "barbell" | "ez_bar" | "trap_bar";
    reviewedExact?: boolean;
    retainedRequirements?: boolean;
    retainedDefinitionSpecific?: boolean;
    prescribedLegacy?: boolean;
    unknownBenchRequirement?: boolean;
  } = {},
) {
  const loadType = options.loadType ?? "barbell";
  const reviewedExact = options.reviewedExact ?? true;
  const retainedDefinitionSpecific = options.retainedDefinitionSpecific ?? false;
  const retainedRequirements = options.retainedRequirements !== false;
  const retainedColumns = retainedRequirements
    ? ", equipment_requirements_semantics_version, equipment_requirements_snapshot"
    : "";
  const prescribedColumns = options.prescribedLegacy
    ? ", prescribed_semantics_version, prescribed_exercise_name, prescribed_load_type, prescribed_metric_type, prescribed_load_semantics"
    : "";
  const retainedValues = retainedRequirements
    ? `, 1, ${retainedRequirementsSql(ids.exercise)}`
    : "";
  const prescribedValues = options.prescribedLegacy
    ? `, 1, 'Legacy exact selection bench', '${loadType}', 'weight_reps', 'total'`
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
    ${options.unknownBenchRequirement ? `
      INSERT INTO exercise_equipment_requirements (exercise_id, equipment_type)
      VALUES ('${ids.exercise}', 'bench');
    ` : ""}
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
      id, session_id, exercise_id, order_idx${retainedColumns}${prescribedColumns}
    ) VALUES ('${ids.sessionExercise}', '${ids.session}', '${ids.exercise}', 0${retainedValues}${prescribedValues});
    INSERT INTO session_occurrences (
      id, session_id, session_exercise_id, kind, origin, sequence_idx,
      kind_ordinal, planned_exercise_id, outcome
    ) VALUES (
      '${ids.occurrence}', '${ids.session}', '${ids.sessionExercise}',
      'working_set', 'planned', 0, 0, '${ids.exercise}', 'pending'
    );
    INSERT INTO equipment_items (id, user_id, type, label) VALUES
      ('${ids.bar}', '${ids.user}', '${loadType}', 'Owner exact bar');
    ${options.unknownBenchRequirement ? `
      INSERT INTO equipment_items (id, user_id, type, label) VALUES
        ('${ids.bench}', '${ids.user}', 'bench', 'Owner unreviewed bench');
    ` : ""}
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
  await retainCompatibleFit(database, ids.exercise, ids.bar);
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
    INSERT INTO session_exercises (
      id, session_id, exercise_id, order_idx,
      equipment_requirements_semantics_version,
      equipment_requirements_snapshot
    ) VALUES (
      '${ids.sessionExercise}', '${ids.session}', '${ids.cableExercise}', 0,
      1, ${retainedRequirementsSql(ids.cableExercise)}
    );
    INSERT INTO session_occurrences (
      id, session_id, session_exercise_id, kind, origin, sequence_idx,
      kind_ordinal, planned_exercise_id, outcome
    ) VALUES (
      '${ids.occurrence}', '${ids.session}', '${ids.sessionExercise}',
      'working_set', 'planned', 0, 0, '${ids.cableExercise}', 'pending'
    );
    INSERT INTO equipment_definitions (id, key, label, category) VALUES
      ('${ids.cableDefinition}', 'reviewed-cable-station', 'Reviewed cable station', 'cable'),
      ('${ids.ropeDefinition}', 'reviewed-rope-attachment', 'Reviewed rope attachment', 'other');
    INSERT INTO equipment_items (id, user_id, type, label, definition_id) VALUES
      ('${ids.cable}', '${ids.user}', 'cable', 'Cable station', '${ids.cableDefinition}'),
      ('${ids.rope}', '${ids.user}', 'other', 'Rope attachment', '${ids.ropeDefinition}'),
      ('${ids.bar}', '${ids.user}', 'dumbbell', 'Dumbbells', NULL);
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
  await retainCompatibleFit(database, ids.cableExercise, ids.cable);
  await retainCompatibleFit(
    database,
    ids.alternateExercise,
    ids.bar,
    ids.secondFitMutation,
  );
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

  it("does not offer an explicitly incompatible or stale item for active setup", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    const assertion = await database.client.query<{ id: string; revision: number }>(`
      SELECT id::text, revision
      FROM exercise_equipment_fit_assertions
      WHERE user_id = '${ids.user}'
        AND exercise_id = '${ids.exercise}'
        AND equipment_item_id = '${ids.bar}'
    `);
    const current = assertion.rows[0];
    if (!current) throw new Error("Compatible setup fixture was not retained.");
    const incompatible = await saveExerciseEquipmentFitAssertion(
      database.db,
      ids.user,
      {
        mutationId: ids.secondFitMutation,
        assertionId: current.id,
        exerciseId: ids.exercise,
        equipmentItemId: ids.bar,
        verdict: "incompatible",
        reasonCode: "geometry_limit",
        reasonNote: "The setup cannot reach the required position.",
        expectedRevision: current.revision,
      },
    );
    expect(incompatible).toMatchObject({ ok: true, changed: true });
    await expect(mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.invalidKey,
      provenance: "user_selected",
    })).resolves.toEqual({ outcome: "invalid_setup" });

    database?.close();
    database = await createMigratedTestDatabase();
    await seed(database);
    await database.client.exec(`
      UPDATE equipment_items
      SET attrs = '{"reviewedCapabilityChanged":true}'::jsonb
      WHERE id = '${ids.bar}'
    `);
    await expect(mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.bar,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: ids.staleKey,
      provenance: "user_selected",
    })).resolves.toEqual({ outcome: "invalid_setup" });
  });

  it("does not offer a compatible primary item while another required item remains unknown", async () => {
    database = await createMigratedTestDatabase();
    await seed(database, { unknownBenchRequirement: true });

    await expect(resolveSessionEquipmentAvailability(
      database.db,
      ids.user,
      ids.sessionExercise,
    )).resolves.toMatchObject({
      availableOptionCount: 0,
      equipmentFitStatus: "unknown",
    });
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

  it("does not infer a setup from a legacy prescribed exercise without retained requirements", async () => {
    database = await createMigratedTestDatabase();
    await seed(database, {
      prescribedLegacy: true,
      retainedRequirements: false,
    });

    await expect(resolveSessionEquipmentAvailability(
      database.db,
      ids.user,
      ids.sessionExercise,
    )).resolves.toMatchObject({
      availableOptionCount: 0,
      equipmentFitStatus: "unknown",
      requirementsEvidence: "legacy_unknown",
    });
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

  it("does not infer current catalog setup for a true legacy null-evidence row", async () => {
    database = await createMigratedTestDatabase();
    await seed(database, { retainedRequirements: false });

    await expect(resolveSessionEquipmentAvailability(
      database.db,
      ids.user,
      ids.sessionExercise,
    )).resolves.toMatchObject({
      availableOptionCount: 0,
      equipmentFitStatus: "unknown",
      requirementsEvidence: "legacy_unknown",
    });
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

  it("keeps a retained selected snapshot immutable after the catalog changes", async () => {
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
    await database.client.exec(`
      DELETE FROM exercise_execution_requirements
      WHERE exercise_id = '${ids.exercise}';
      DELETE FROM exercise_equipment_requirements
      WHERE exercise_id = '${ids.exercise}';
      INSERT INTO exercise_equipment_requirements (exercise_id, equipment_type)
      VALUES ('${ids.exercise}', 'bodyweight');
    `);

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

  it("does not record a weighted set when every setup has unknown exercise fit", async () => {
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
    await expect(logWorkoutSet(database.db, ids.user, command)).resolves.toEqual({
      outcome: "equipment_selection_required",
    });
    await expect(logWorkoutSet(database.db, ids.user, command)).resolves.toEqual({
      outcome: "equipment_selection_required",
    });

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
    expect(evidence.rows).toEqual([]);
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
      INSERT INTO session_exercises (
        id, session_id, exercise_id, order_idx,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot
      ) VALUES (
        '${ids.sessionExercise}', '${ids.session}', '${ids.exercise}', 0,
        1, ${retainedRequirementsSql(ids.exercise)}
      );
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
    await retainCompatibleFit(database, ids.exercise, ids.machine);
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

  it("snapshots an exact owned setup, updates pending work atomically, and replays", async () => {
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

    expect(await mutateSessionEquipmentSelection(database.db, ids.user, input))
      .toEqual({
        outcome: "replayed",
        snapshotId: stored.rows[0].current_snapshot,
        occurrenceStates: [expect.objectContaining({
          id: ids.occurrence,
          outcome: "pending",
          revision: 1,
        })],
      });
    const counts = await database.client.query<{ snapshots: number; receipts: number }>(`
      SELECT
        (SELECT count(*)::int FROM session_equipment_snapshots) AS snapshots,
        (SELECT count(*)::int FROM session_equipment_selection_receipts) AS receipts
    `);
    expect(counts.rows).toEqual([{ snapshots: 1, receipts: 1 }]);

    expect(await mutateSessionEquipmentSelection(database.db, ids.user, {
      ...input,
      provenance: "auto_unique",
    })).toEqual({ outcome: "conflict" });
  });

  it("returns stale instead of storing a hybrid snapshot when live setup changes during selection", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    const result = await mutateSessionEquipmentSelection(
      database.db,
      ids.user,
      {
        operation: "select",
        sessionExerciseId: ids.sessionExercise,
        equipmentItemId: ids.bar,
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        clientKey: ids.staleKey,
        provenance: "user_selected",
      },
      {
        checkpoint: async () => {
          await database!.client.exec(`
            UPDATE plate_inventory SET quantity = 6 WHERE id = '${ids.plate}'
          `);
        },
      },
    );
    expect(result).toEqual({ outcome: "stale" });
    const snapshots = await database.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM session_equipment_snapshots",
    );
    expect(snapshots.rows).toEqual([{ count: 0 }]);
  });

  it("returns stale when catalog semantics and the fit review change after one coherent baseline", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    const assertion = await database.client.query<{
      id: string;
      revision: number;
    }>(`
      SELECT id::text, revision
      FROM exercise_equipment_fit_assertions
      WHERE user_id = '${ids.user}'
        AND exercise_id = '${ids.exercise}'
        AND equipment_item_id = '${ids.bar}'
    `);
    const result = await mutateSessionEquipmentSelection(
      database.db,
      ids.user,
      {
        operation: "select",
        sessionExerciseId: ids.sessionExercise,
        equipmentItemId: ids.bar,
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        clientKey: ids.staleKey,
        provenance: "user_selected",
      },
      {
        checkpoint: async () => {
          await database!.client.exec(`
            UPDATE exercise_execution_requirements
            SET required_profile_kind = 'cable_machine'
            WHERE exercise_id = '${ids.exercise}'
          `);
          const reviewed = await saveExerciseEquipmentFitAssertion(
            database!.db,
            ids.user,
            {
              mutationId: ids.secondFitMutation,
              assertionId: assertion.rows[0].id,
              exerciseId: ids.exercise,
              equipmentItemId: ids.bar,
              verdict: "compatible",
              reasonCode: "owner_verified",
              reasonNote: null,
              expectedRevision: assertion.rows[0].revision,
            },
          );
          expect(reviewed).toMatchObject({ ok: true, changed: true });
        },
      },
    );
    expect(result).toEqual({ outcome: "stale" });
    const snapshots = await database.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM session_equipment_snapshots",
    );
    expect(snapshots.rows).toEqual([{ count: 0 }]);
  });

  it("returns stale when linked definition semantics change during selection", async () => {
    database = await createMigratedTestDatabase();
    await seed(database, { retainedDefinitionSpecific: true });
    await expect(mutateSessionEquipmentSelection(
      database.db,
      ids.user,
      {
        operation: "select",
        sessionExerciseId: ids.sessionExercise,
        equipmentItemId: ids.bar,
        attachmentItemId: null,
        expectedCurrentSnapshotId: null,
        clientKey: ids.staleKey,
        provenance: "user_selected",
      },
      {
        checkpoint: async () => {
          await database!.client.exec(`
            UPDATE equipment_definitions
            SET key = 'retained-correct-bar-revised'
            WHERE id = '${ids.barDefinition}'
          `);
        },
      },
    )).resolves.toEqual({ outcome: "stale" });
    const snapshots = await database.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM session_equipment_snapshots",
    );
    expect(snapshots.rows).toEqual([{ count: 0 }]);
  });

  it("returns stale when attachment definition semantics change during selection", async () => {
    database = await createMigratedTestDatabase();
    const snapshotId = await seedCableSubstitution(database);
    await expect(mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "clear",
      sessionExerciseId: ids.sessionExercise,
      expectedCurrentSnapshotId: snapshotId,
      clientKey: ids.clearKey,
    })).resolves.toMatchObject({ outcome: "applied", snapshotId: null });

    await expect(mutateSessionEquipmentSelection(
      database.db,
      ids.user,
      {
        operation: "select",
        sessionExerciseId: ids.sessionExercise,
        equipmentItemId: ids.cable,
        attachmentItemId: ids.rope,
        expectedCurrentSnapshotId: null,
        clientKey: ids.staleKey,
        provenance: "user_selected",
      },
      {
        checkpoint: async () => {
          await database!.client.exec(`
            UPDATE equipment_definitions
            SET key = 'reviewed-rope-attachment-revised'
            WHERE id = '${ids.ropeDefinition}'
          `);
        },
      },
    )).resolves.toEqual({ outcome: "stale" });
    const state = await database.client.query<{
      current_snapshot: string | null;
      snapshots: number;
    }>(`
      SELECT exercise.current_equipment_snapshot_id::text AS current_snapshot,
             (SELECT count(*)::int FROM session_equipment_snapshots) AS snapshots
      FROM session_exercises exercise
      WHERE exercise.id = '${ids.sessionExercise}'
    `);
    expect(state.rows).toEqual([{ current_snapshot: null, snapshots: 1 }]);
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
          revision: 2,
        })],
      });
    expect(await mutateSessionEquipmentSelection(database.db, ids.user, clear))
      .toEqual({
        outcome: "replayed",
        snapshotId: null,
        occurrenceStates: [expect.objectContaining({
          id: ids.occurrence,
          outcome: "pending",
          revision: 2,
        })],
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
    await retainCompatibleFit(
      database,
      ids.exercise,
      ids.secondBar,
      ids.secondFitMutation,
    );

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

  it("atomically rejects substitution after the retained target fit becomes stale", async () => {
    database = await createMigratedTestDatabase();
    await seedCableSubstitution(database);
    await database.client.exec(`
      UPDATE equipment_items
      SET attrs = '{"capabilityChanged":true}'::jsonb
      WHERE id = '${ids.bar}'
    `);

    await expect(updateSessionExerciseWithVersion(
      database.db,
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
    )).resolves.toEqual({
      ok: false,
      reason: "The workout exercise is no longer compatible with this change.",
    });
    const evidence = await database.client.query<{
      exercise_id: string;
      versions: number;
    }>(`
      SELECT exercise.exercise_id::text,
             (SELECT count(*)::int FROM record_versions version
              WHERE version.entity_type = 'session_exercise'
                AND version.entity_id = exercise.id) AS versions
      FROM session_exercises exercise
      WHERE exercise.id = '${ids.sessionExercise}'
    `);
    expect(evidence.rows).toEqual([{
      exercise_id: ids.cableExercise,
      versions: 0,
    }]);
  });

  it("atomically rejects undo when the original exercise fit became stale", async () => {
    database = await createMigratedTestDatabase();
    await seedCableSubstitution(database);
    const substituted = await updateSessionExerciseWithVersion(
      database.db,
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
    );
    if (!substituted.ok || substituted.versionId == null) {
      throw new Error("Substitution fixture did not retain a version.");
    }
    await database.client.exec(`
      UPDATE cable_machine_profiles
      SET geometry_certainty = 'partial'
      WHERE id = '${ids.cableProfile}'
    `);

    await expect(restoreRecordVersion(
      database.db,
      ids.user,
      substituted.versionId,
      { activeOnly: true },
    )).resolves.toEqual({
      ok: false,
      reason: "The workout exercise structure or provenance has changed. Nothing was restored.",
    });
    const exercise = await database.client.query<{ exercise_id: string }>(`
      SELECT exercise_id::text
      FROM session_exercises
      WHERE id = '${ids.sessionExercise}'
    `);
    expect(exercise.rows).toEqual([{ exercise_id: ids.alternateExercise }]);
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

  it("keeps the retained attachment predicate immutable when the catalog changes", async () => {
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
    })).resolves.toMatchObject({ outcome: "saved" });
  });

  it("does not reuse a current re-review for different retained attachment semantics", async () => {
    database = await createMigratedTestDatabase();
    const snapshotId = await seedCableSubstitution(database);
    await expect(mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "clear",
      sessionExerciseId: ids.sessionExercise,
      expectedCurrentSnapshotId: snapshotId,
      clientKey: ids.clearKey,
    })).resolves.toMatchObject({ outcome: "applied", snapshotId: null });
    await database.client.exec(`
      UPDATE exercise_execution_requirements
      SET required_attachment_kind = 'straight_bar'
      WHERE exercise_id = '${ids.cableExercise}'
    `);
    const assertion = await database.client.query<{
      id: string;
      revision: number;
    }>(`
      SELECT id::text, revision
      FROM exercise_equipment_fit_assertions
      WHERE user_id = '${ids.user}'
        AND exercise_id = '${ids.cableExercise}'
        AND equipment_item_id = '${ids.cable}'
    `);
    await expect(saveExerciseEquipmentFitAssertion(database.db, ids.user, {
      mutationId: ids.thirdFitMutation,
      assertionId: assertion.rows[0].id,
      exerciseId: ids.cableExercise,
      equipmentItemId: ids.cable,
      verdict: "compatible",
      reasonCode: "owner_verified",
      reasonNote: null,
      expectedRevision: assertion.rows[0].revision,
    })).resolves.toMatchObject({ ok: true, changed: true });

    await expect(resolveSessionEquipmentAvailability(
      database.db,
      ids.user,
      ids.sessionExercise,
    )).resolves.toMatchObject({
      availableOptionCount: 0,
      equipmentFitStatus: "unknown",
    });
    await expect(mutateSessionEquipmentSelection(database.db, ids.user, {
      operation: "select",
      sessionExerciseId: ids.sessionExercise,
      equipmentItemId: ids.cable,
      attachmentItemId: ids.rope,
      expectedCurrentSnapshotId: null,
      clientKey: ids.staleKey,
      provenance: "user_selected",
    })).resolves.toEqual({ outcome: "invalid_setup" });
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
