import { afterEach, describe, expect, it } from "vitest";
import {
  resolveExactEquipmentAvailability,
  type ExactExecutionRequirement,
} from "@/engine/exact-equipment-availability";
import {
  createMigratedTestDatabase,
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";
import { exerciseLibrary } from "@/db/seed/exercise-library";
import { seedExerciseLibrary } from "@/db/seed/library";

type ActivatedRow = {
  name: string;
  equipment_type: string;
  required_profile_kind: string | null;
  required_attachment_kind: string | null;
  requires_known_geometry: boolean;
};

describe("reviewed exact-equipment requirement activation", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => database?.close());

  it("makes distinct cable/attachment and plate-loaded Lat Pulldown setups reachable", async () => {
    database = await createTestDatabaseAtMigration(
      "0064_equipment_recovery_contract",
    );
    await database.client.exec(`
      INSERT INTO exercise_families (
        id, key, name, movement_pattern, primary_muscles
      ) VALUES (
        '10000000-0000-4000-8000-000000000065', 'lat_pulldown',
        'Lat Pulldown', 'vertical_pull', '["back", "biceps"]'::jsonb
      );
      INSERT INTO exercises (
        id, family_id, name, movement_pattern, primary_muscles,
        load_type, variant_key, catalog_reviewed
      ) VALUES
        (
          '20000000-0000-4000-8000-000000000065',
          '10000000-0000-4000-8000-000000000065',
          'Lat Pulldown', 'vertical_pull', '["back", "biceps"]'::jsonb,
          'external', 'lat_pulldown', true
        ),
        (
          '20000000-0000-4000-8000-000000000066', NULL,
          'Generic Selectorized Leg Extension', 'isolation_legs',
          '["quads"]'::jsonb, 'external', 'generic_selectorized', true
        ),
        (
          '20000000-0000-4000-8000-000000000067', NULL,
          'Existing EZ Lifecycle', 'isolation_arms', '["biceps"]'::jsonb,
          'ez_bar', 'existing_ez', true
        );
      INSERT INTO exercise_equipment_requirements (exercise_id, equipment_type)
      VALUES
        ('20000000-0000-4000-8000-000000000065', 'cable'),
        ('20000000-0000-4000-8000-000000000066', 'machine'),
        ('20000000-0000-4000-8000-000000000067', 'ez_bar'),
        ('20000000-0000-4000-8000-000000000067', 'plates');
    `);

    await migrateTestDatabaseThrough(
      database,
      "0065_reviewed_equipment_requirement_activation",
    );

    const activated = await database.client.query<ActivatedRow>(`
      SELECT exercise.name, broad.equipment_type::text,
             exact.required_profile_kind, exact.required_attachment_kind,
             exact.requires_known_geometry
      FROM exercises exercise
      JOIN exercise_equipment_requirements broad
        ON broad.exercise_id = exercise.id
      JOIN exercise_execution_requirements exact
        ON exact.exercise_id = exercise.id
      WHERE exercise.name IN ('Lat Pulldown', 'Plate-Loaded Lat Pulldown')
      ORDER BY exercise.name
    `);
    expect(activated.rows).toEqual([
      {
        name: "Lat Pulldown",
        equipment_type: "cable",
        required_profile_kind: "cable_machine",
        required_attachment_kind: "lat_bar",
        requires_known_geometry: true,
      },
      {
        name: "Plate-Loaded Lat Pulldown",
        equipment_type: "machine",
        required_profile_kind: "plate_loaded_machine",
        required_attachment_kind: null,
        requires_known_geometry: true,
      },
    ]);

    const cableRequirement: ExactExecutionRequirement = {
      requiredProfileKind: activated.rows[0]!.required_profile_kind,
      requiredEquipmentDefinitionId: null,
      requiredAttachmentKind: activated.rows[0]!.required_attachment_kind,
      requiredAttachmentDefinitionId: null,
      requiresKnownGeometry: activated.rows[0]!.requires_known_geometry,
    };
    expect(resolveExactEquipmentAvailability({
      broadRequirements: [{ equipmentType: "cable", minWeight: null }],
      broadInventory: [{ type: "cable", available: true, attrs: {} }],
      exactRequirement: cableRequirement,
      exactCandidates: [{
        equipmentItemId: "cable-station",
        available: true,
        profileKind: "cable_machine",
        equipmentDefinitionId: null,
        geometryCertainty: "known",
        compatibleAttachments: [{
          equipmentItemId: "lat-bar",
          available: true,
          attachmentKind: "lat_bar",
          equipmentDefinitionId: null,
        }],
      }],
    })).toMatchObject({
      available: true,
      status: "exact_available",
      candidateEquipmentItemIds: ["cable-station"],
    });

    const machineRequirement: ExactExecutionRequirement = {
      requiredProfileKind: activated.rows[1]!.required_profile_kind,
      requiredEquipmentDefinitionId: null,
      requiredAttachmentKind: null,
      requiredAttachmentDefinitionId: null,
      requiresKnownGeometry: activated.rows[1]!.requires_known_geometry,
    };
    expect(resolveExactEquipmentAvailability({
      broadRequirements: [{ equipmentType: "machine", minWeight: null }],
      broadInventory: [{ type: "machine", available: true, attrs: {} }],
      exactRequirement: machineRequirement,
      exactCandidates: [{
        equipmentItemId: "plate-loaded-station",
        available: true,
        profileKind: "plate_loaded_machine",
        equipmentDefinitionId: null,
        geometryCertainty: "known",
        compatibleAttachments: [],
      }],
    })).toMatchObject({
      available: true,
      status: "exact_available",
      candidateEquipmentItemIds: ["plate-loaded-station"],
    });
  }, 60_000);

  it("does not activate generic selectorized machines or established EZ rows", async () => {
    database = await createTestDatabaseAtMigration(
      "0064_equipment_recovery_contract",
    );
    await database.client.exec(`
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        variant_key, catalog_reviewed
      ) VALUES
        (
          '20000000-0000-4000-8000-000000000068',
          'Generic Selectorized Machine', 'isolation_legs', '["quads"]'::jsonb,
          'external', 'selectorized_machine', true
        ),
        (
          '20000000-0000-4000-8000-000000000069',
          'Established EZ Exercise', 'isolation_arms', '["biceps"]'::jsonb,
          'ez_bar', 'ez_lifecycle', true
        ),
        (
          '20000000-0000-4000-8000-00000000006a',
          'Reviewed Trap Exercise', 'hinge', '["back"]'::jsonb,
          'external', 'trap_lifecycle', true
        );
      INSERT INTO exercise_equipment_requirements (exercise_id, equipment_type)
      VALUES
        ('20000000-0000-4000-8000-000000000068', 'machine'),
        ('20000000-0000-4000-8000-000000000069', 'ez_bar'),
        ('20000000-0000-4000-8000-000000000069', 'plates'),
        ('20000000-0000-4000-8000-00000000006a', 'trap_bar'),
        ('20000000-0000-4000-8000-00000000006a', 'plates');
    `);
    await migrateTestDatabaseThrough(
      database,
      "0065_reviewed_equipment_requirement_activation",
    );

    const exactRows = await database.client.query<{ name: string }>(`
      SELECT exercise.name
      FROM exercise_execution_requirements exact
      JOIN exercises exercise ON exercise.id = exact.exercise_id
      WHERE exercise.id IN (
        '20000000-0000-4000-8000-000000000068',
        '20000000-0000-4000-8000-000000000069',
        '20000000-0000-4000-8000-00000000006a'
      )
    `);
    expect(exactRows.rows).toEqual([]);
    await expect(database.client.query<{ load_type: string; load_semantics: string }>(`
      SELECT load_type, load_semantics::text
      FROM exercises
      WHERE id = '20000000-0000-4000-8000-00000000006a'
    `)).resolves.toMatchObject({
      rows: [{ load_type: "trap_bar", load_semantics: "total" }],
    });

    expect(resolveExactEquipmentAvailability({
      broadRequirements: [{ equipmentType: "machine", minWeight: null }],
      broadInventory: [{ type: "machine", available: true, attrs: {} }],
      exactRequirement: null,
      exactCandidates: [],
    })).toMatchObject({
      available: true,
      status: "broad_only",
      selection: "not_applicable",
    });
  }, 60_000);

  it("reconciles the reviewed policy through the normal chunked catalog seeder", async () => {
    database = await createMigratedTestDatabase();
    const offset = exerciseLibrary.findIndex(
      (exercise) => exercise.name === "Lat Pulldown",
    );
    expect(offset).toBeGreaterThanOrEqual(0);

    await seedExerciseLibrary(database.db, { offset, limit: 2 });

    const rows = await database.client.query<ActivatedRow>(`
      SELECT exercise.name, broad.equipment_type::text,
             exact.required_profile_kind, exact.required_attachment_kind,
             exact.requires_known_geometry
      FROM exercises exercise
      JOIN exercise_equipment_requirements broad
        ON broad.exercise_id = exercise.id
      JOIN exercise_execution_requirements exact
        ON exact.exercise_id = exercise.id
      WHERE exercise.name IN ('Lat Pulldown', 'Plate-Loaded Lat Pulldown')
      ORDER BY exercise.name
    `);
    expect(rows.rows).toEqual([
      {
        name: "Lat Pulldown",
        equipment_type: "cable",
        required_profile_kind: "cable_machine",
        required_attachment_kind: "lat_bar",
        requires_known_geometry: true,
      },
      {
        name: "Plate-Loaded Lat Pulldown",
        equipment_type: "machine",
        required_profile_kind: "plate_loaded_machine",
        required_attachment_kind: null,
        requires_known_geometry: true,
      },
    ]);
  }, 60_000);
});
