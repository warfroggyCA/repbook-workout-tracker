import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import {
  dataSnapshots,
  equipmentDefinitions,
  exerciseEquipmentRequirements,
  exerciseExecutionRequirements,
  exercises,
  recordVersions,
  sessionExercises,
  users,
} from "@/db/schema";
import {
  addWorkoutExercise,
  startWorkoutSession,
} from "@/services/session-lifecycle";
import {
  restoreRecordVersion,
  updateSessionExerciseWithVersion,
} from "@/services/record-versions";
import { resolveSessionPreparationEquipmentProjection } from "@/services/session-equipment-requirements";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
  upgradeSnapshotPayload,
  validateSnapshotPayload,
} from "@/services/snapshot-restore";
import { snapshotRecordCounts } from "@/services/snapshot-capture";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import {
  canonicalJson,
  encryptSnapshotBytes,
  sha256Hex,
  SNAPSHOT_ENCRYPTION_ALGORITHM,
} from "@/services/snapshot-crypto";
import { seedT06PreviewStart } from "../helpers/v2-t06-preview-start";
import {
  createMigratedTestDatabase,
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

describe("retained session equipment requirements persistence", () => {
  const databases: TestDatabase[] = [];
  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it("freezes Start, add, substitution, and version-restore requirement meaning", async () => {
    const database = await createMigratedTestDatabase();
    databases.push(database);
    const fixture = await seedT06PreviewStart(database.db);
    const [definition] = await database.db.insert(equipmentDefinitions).values({
      key: `retained-dumbbell-${crypto.randomUUID()}`,
      label: "Original adjustable dumbbell",
      category: "dumbbell",
    }).returning({ id: equipmentDefinitions.id });
    const [sourceRequirement] = await database.db
      .insert(exerciseEquipmentRequirements)
      .values({
        exerciseId: fixture.exerciseId,
        equipmentType: "dumbbell",
        equipmentDefinitionId: definition.id,
        minWeight: 50,
      })
      .returning({ id: exerciseEquipmentRequirements.id });
    const [sourceExact] = await database.db
      .insert(exerciseExecutionRequirements)
      .values({
        exerciseId: fixture.exerciseId,
        requiredProfileKind: "plate_loaded_implement",
        requiredEquipmentDefinitionId: definition.id,
        requiresKnownGeometry: true,
        reviewedAt: new Date("2026-08-10T12:00:00.000Z"),
      })
      .returning({ id: exerciseExecutionRequirements.id });

    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
      45,
      { timezone: "America/Toronto", startRequestKey: crypto.randomUUID() },
    );
    const planned = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, started.sessionId),
    });
    if (!planned) throw new Error("Missing retained Start exercise.");
    expect(planned).toMatchObject({
      equipmentRequirementsSemanticsVersion: 1,
      equipmentRequirementsSnapshot: {
        sourceExerciseId: fixture.exerciseId,
        broad: [{
          sourceRequirementId: sourceRequirement.id,
          equipmentType: "dumbbell",
          equipmentDefinition: {
            id: definition.id,
            label: "Original adjustable dumbbell",
          },
          minWeight: 50,
        }],
        exact: {
          sourceRequirementId: sourceExact.id,
          requiredProfileKind: "plate_loaded_implement",
          requiresKnownGeometry: true,
        },
      },
    });

    await database.db.update(equipmentDefinitions)
      .set({ label: "Renamed current definition" })
      .where(eq(equipmentDefinitions.id, definition.id));
    await database.db.update(exerciseEquipmentRequirements)
      .set({ minWeight: 70 })
      .where(eq(exerciseEquipmentRequirements.id, sourceRequirement.id));
    expect(await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, planned.id),
    })).toMatchObject({
      equipmentRequirementsSnapshot: {
        broad: [{
          equipmentDefinition: { label: "Original adjustable dumbbell" },
          minWeight: 50,
        }],
      },
    });

    const [addedExercise] = await database.db.insert(exercises).values({
      name: `Retained mobility ${crypto.randomUUID()}`,
      movementPattern: "mobility",
      primaryMuscles: ["core"],
      loadType: "bodyweight",
      metricType: "reps",
      loadSemantics: "bodyweight",
    }).returning({ id: exercises.id });
    const added = await addWorkoutExercise(database.db, fixture.userId, {
      sessionId: started.sessionId,
      exerciseId: addedExercise.id,
      mutationId: crypto.randomUUID(),
      expectedSessionRevision: 0,
      initialSetCount: 1,
      insertion: "end",
    });
    expect(added.outcome).toBe("added");
    if (added.outcome !== "added") throw new Error("Add failed.");
    expect(await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, added.sessionExerciseId),
    })).toMatchObject({
      equipmentRequirementsSemanticsVersion: 1,
      equipmentRequirementsSnapshot: {
        sourceExerciseId: addedExercise.id,
        broad: [],
        exact: null,
      },
    });

    const [alternate] = await database.db.insert(exercises).values({
      name: `Retained band press ${crypto.randomUUID()}`,
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "bands",
      metricType: "reps",
      loadSemantics: "resistance_band",
    }).returning({ id: exercises.id });
    const [alternateRequirement] = await database.db
      .insert(exerciseEquipmentRequirements)
      .values({ exerciseId: alternate.id, equipmentType: "bands" })
      .returning({ id: exerciseEquipmentRequirements.id });
    const substituted = await updateSessionExerciseWithVersion(
      database.db,
      fixture.userId,
      planned.id,
      {
        exerciseId: alternate.id,
        modificationType: "substituted",
        substitutedForExerciseId: fixture.exerciseId,
        substitutionReason: "equipment_busy",
        substitutedAt: new Date("2026-08-10T12:30:00.000Z"),
        targetLoad: null,
      },
      "session_exercise.substitute",
      { activeOnly: true, expectedExerciseId: fixture.exerciseId },
    );
    expect(substituted).toMatchObject({
      ok: true,
      changed: true,
      historyRevision: 2,
    });
    if (!substituted.ok || !substituted.versionId) {
      throw new Error("Substitution failed.");
    }
    const substitutedRow = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, planned.id),
    });
    expect(substitutedRow).toMatchObject({
      exerciseId: alternate.id,
      equipmentRequirementsSnapshot: {
        sourceExerciseId: alternate.id,
        broad: [{ sourceRequirementId: alternateRequirement.id }],
      },
    });
    const version = await database.db.query.recordVersions.findFirst({
      where: eq(recordVersions.id, substituted.versionId),
    });
    expect(version?.beforeData).toMatchObject({
      equipment_requirements_snapshot: {
        sourceExerciseId: fixture.exerciseId,
      },
    });
    expect(version?.afterData).toMatchObject({
      equipment_requirements_snapshot: { sourceExerciseId: alternate.id },
    });

    const restored = await restoreRecordVersion(
      database.db,
      fixture.userId,
      substituted.versionId,
      { activeOnly: true },
    );
    expect(restored).toMatchObject({ ok: true, changed: true, historyRevision: 3 });
    expect(await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, planned.id),
    })).toMatchObject({
      exerciseId: fixture.exerciseId,
      equipmentRequirementsSnapshot: planned.equipmentRequirementsSnapshot,
    });

    const noteVersion = await updateSessionExerciseWithVersion(
      database.db,
      fixture.userId,
      planned.id,
      { notes: "Retained requirement restore probe" },
      "session_exercise.note_update",
      { activeOnly: true },
    );
    if (!noteVersion.ok || !noteVersion.versionId) {
      throw new Error("Missing requirement restore probe version.");
    }
    await database.client.exec(`
      BEGIN;
      SELECT set_config(
        'workout_tracker.authorized_delete', 'snapshot_restore', true
      );
      UPDATE session_exercises
      SET equipment_requirements_snapshot = jsonb_set(
        equipment_requirements_snapshot,
        '{broad,0,minWeight}',
        '999'::jsonb
      )
      WHERE id = '${planned.id}';
      COMMIT;
    `);
    expect(await restoreRecordVersion(
      database.db,
      fixture.userId,
      noteVersion.versionId,
      { activeOnly: true },
    )).toMatchObject({ ok: true, changed: true });
    expect(await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, planned.id),
    })).toMatchObject({
      notes: null,
      exerciseId: fixture.exerciseId,
      equipmentRequirementsSnapshot: planned.equipmentRequirementsSnapshot,
    });

    const captured = await captureUserSnapshot(
      database.db,
      fixture.userId,
      new Date("2026-08-10T13:00:00.000Z"),
      "retained-requirement-test",
    );
    expect(captured.schemaVersion).toBe("33");
    expect(captured.tables.session_exercises).toContainEqual(
      expect.objectContaining({
        id: planned.id,
        equipment_requirements_semantics_version: 1,
        equipment_requirements_snapshot: planned.equipmentRequirementsSnapshot,
      }),
    );
    const schema31 = structuredClone(captured);
    schema31.schemaVersion = "31";
    for (const row of schema31.tables.session_exercises as Array<Record<string, unknown>>) {
      delete row.equipment_requirements_semantics_version;
      delete row.equipment_requirements_snapshot;
    }
    const upgraded = upgradeSnapshotPayload(schema31);
    expect(upgraded.schemaVersion).toBe("33");
    expect(upgraded.tables.session_exercises).toContainEqual(
      expect.objectContaining({
        id: planned.id,
        equipment_requirements_semantics_version: null,
        equipment_requirements_snapshot: null,
      }),
    );
    const omitted = structuredClone(captured);
    delete (omitted.tables.session_exercises[0] as Record<string, unknown>)
      .equipment_requirements_snapshot;
    expect(() => validateSnapshotPayload(omitted, fixture.userId)).toThrow(
      /retained equipment requirement state/i,
    );

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 24);
    const keyring = {
      currentVersion: "v1",
      resolve(version: string) {
        if (version !== "v1") throw new Error("Unknown test key.");
        return key;
      },
    };
    const plaintext = Buffer.from(canonicalJson(schema31), "utf8");
    const encrypted = encryptSnapshotBytes(
      plaintext,
      key,
      "v1",
      Buffer.alloc(12, 24),
    );
    const legacySnapshotId = crypto.randomUUID();
    const objectPath =
      `snapshots/${fixture.userId}/${legacySnapshotId}.wtbk`;
    const stored = await store.put(objectPath, encrypted);
    await database.db.insert(dataSnapshots).values({
      id: legacySnapshotId,
      userId: fixture.userId,
      name: "Schema 31 retained-requirement compatibility",
      reason: "compatibility-test",
      status: "verified",
      objectPath,
      objectEtag: stored.etag,
      appVersion: "schema-31-retained-requirements",
      schemaVersion: "31",
      sizeBytes: encrypted.length,
      recordCounts: snapshotRecordCounts(schema31),
      plaintextChecksum: sha256Hex(plaintext),
      ciphertextChecksum: sha256Hex(encrypted),
      encryptionAlgorithm: SNAPSHOT_ENCRYPTION_ALGORITHM,
      encryptionKeyVersion: "v1",
      snapshotKind: "user",
      verifiedAt: new Date("2026-08-10T13:01:00.000Z"),
    });
    const changedAfterSnapshot = await updateSessionExerciseWithVersion(
      database.db,
      fixture.userId,
      planned.id,
      {
        exerciseId: alternate.id,
        modificationType: "substituted",
        substitutedForExerciseId: fixture.exerciseId,
        substitutionReason: "equipment_busy",
        substitutedAt: new Date("2026-08-10T13:02:00.000Z"),
        targetLoad: null,
      },
      "session_exercise.substitute",
      { activeOnly: true, expectedExerciseId: fixture.exerciseId },
    );
    expect(changedAfterSnapshot).toMatchObject({ ok: true, changed: true });
    const preview = await getSnapshotRestorePreview(
      database.db,
      fixture.userId,
      legacySnapshotId,
      "full",
      { store, keyring },
    );
    const legacyRestored = await restoreDataSnapshot(
      database.db,
      fixture.userId,
      {
        snapshotId: legacySnapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "schema-31-retained-restore-test" },
    );
    expect(legacyRestored).toMatchObject({ ok: true, scope: "full" });
    expect(await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, planned.id),
    })).toMatchObject({
      exerciseId: fixture.exerciseId,
      equipmentRequirementsSemanticsVersion: null,
      equipmentRequirementsSnapshot: null,
    });
  }, 30_000);

  it("restores pre-0080 exercise versions without erasing or inventing retained meaning", async () => {
    const database = await createMigratedTestDatabase();
    databases.push(database);
    const fixture = await seedT06PreviewStart(database.db);
    const [requirement] = await database.db
      .insert(exerciseEquipmentRequirements)
      .values({
        exerciseId: fixture.exerciseId,
        equipmentType: "dumbbell",
        minWeight: 40,
      })
      .returning({ id: exerciseEquipmentRequirements.id });
    const started = await startWorkoutSession(
      database.db,
      fixture.userId,
      fixture.templateId,
      45,
      { timezone: "America/Toronto", startRequestKey: crypto.randomUUID() },
    );
    const planned = await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.sessionId, started.sessionId),
    });
    if (!planned) throw new Error("Missing retained Start exercise.");
    expect(planned.equipmentRequirementsSnapshot).toMatchObject({
      sourceExerciseId: fixture.exerciseId,
      broad: [{ sourceRequirementId: requirement.id }],
    });

    const noteEdit = await updateSessionExerciseWithVersion(
      database.db,
      fixture.userId,
      planned.id,
      { notes: "Later note" },
      "session_exercise.note_update",
      { activeOnly: true },
    );
    if (!noteEdit.ok || !noteEdit.versionId) {
      throw new Error("Missing note version.");
    }
    await database.db.execute(sql`
      UPDATE record_versions
      SET before_data = before_data - ARRAY[
            'equipment_requirements_semantics_version',
            'equipment_requirements_snapshot'
          ]::text[],
          after_data = after_data - ARRAY[
            'equipment_requirements_semantics_version',
            'equipment_requirements_snapshot'
          ]::text[]
      WHERE id = ${noteEdit.versionId}::uuid
    `);
    expect(await restoreRecordVersion(
      database.db,
      fixture.userId,
      noteEdit.versionId,
      { activeOnly: true },
    )).toMatchObject({ ok: true, changed: true });
    expect(await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, planned.id),
    })).toMatchObject({
      exerciseId: fixture.exerciseId,
      notes: null,
      equipmentRequirementsSemanticsVersion: 1,
      equipmentRequirementsSnapshot: planned.equipmentRequirementsSnapshot,
    });

    const [alternate] = await database.db.insert(exercises).values({
      name: `Legacy restore alternate ${crypto.randomUUID()}`,
      movementPattern: "mobility",
      primaryMuscles: ["core"],
      loadType: "bodyweight",
      metricType: "reps",
      loadSemantics: "bodyweight",
    }).returning({ id: exercises.id });
    const substitution = await updateSessionExerciseWithVersion(
      database.db,
      fixture.userId,
      planned.id,
      {
        exerciseId: alternate.id,
        modificationType: "substituted",
        substitutedForExerciseId: fixture.exerciseId,
        substitutionReason: "other",
        substitutedAt: new Date("2026-08-10T14:00:00.000Z"),
        targetLoad: null,
      },
      "session_exercise.substitute",
      { activeOnly: true, expectedExerciseId: fixture.exerciseId },
    );
    if (!substitution.ok || !substitution.versionId) {
      throw new Error("Missing substitution version.");
    }
    await database.db.execute(sql`
      UPDATE record_versions
      SET before_data = before_data - ARRAY[
            'equipment_requirements_semantics_version',
            'equipment_requirements_snapshot'
          ]::text[],
          after_data = after_data - ARRAY[
            'equipment_requirements_semantics_version',
            'equipment_requirements_snapshot'
          ]::text[]
      WHERE id = ${substitution.versionId}::uuid
    `);
    expect(await restoreRecordVersion(
      database.db,
      fixture.userId,
      substitution.versionId,
      { activeOnly: true },
    )).toMatchObject({ ok: true, changed: true });
    expect(await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, planned.id),
    })).toMatchObject({
      exerciseId: fixture.exerciseId,
      equipmentRequirementsSemanticsVersion: null,
      equipmentRequirementsSnapshot: null,
    });
  });

  it("resolves owner-scoped exact saved equipment and exposes revision races", async () => {
    const database = await createMigratedTestDatabase();
    databases.push(database);
    const ownerId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionExerciseId = crypto.randomUUID();
    const cableDefinitionId = crypto.randomUUID();
    const ropeDefinitionId = crypto.randomUUID();
    const broadRequirementId = crypto.randomUUID();
    const exactRequirementId = crypto.randomUUID();
    const cableItemId = crypto.randomUUID();
    const ropeItemId = crypto.randomUUID();
    const cableProfileId = crypto.randomUUID();
    const ropeProfileId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email) VALUES
        ('${ownerId}', 'prep-owner@example.test'),
        ('${otherId}', 'prep-other@example.test');
      INSERT INTO user_profiles (user_id, unit, timezone) VALUES
        ('${ownerId}', 'lb', 'America/Toronto'),
        ('${otherId}', 'lb', 'America/Toronto');
      INSERT INTO equipment_definitions (id, key, label, category) VALUES
        ('${cableDefinitionId}', 'prep-cable', 'Saved cable station', 'cable'),
        ('${ropeDefinitionId}', 'prep-rope', 'Saved rope', 'other');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics
      ) VALUES (
        '${exerciseId}', 'Retained cable pressdown', 'horizontal_push',
        '["triceps"]'::jsonb, 'external', 'weight_reps', 'machine_stack'
      );
      INSERT INTO workout_sessions (
        id, user_id, timezone, local_date, started_at, status, history_revision
      ) VALUES (
        '${sessionId}', '${ownerId}', 'America/Toronto', '2026-08-10',
        '2026-08-10T12:00:00Z', 'in_progress', 0
      );
      INSERT INTO session_exercises (
        id, session_id, exercise_id, order_idx,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot
      ) VALUES (
        '${sessionExerciseId}', '${sessionId}', '${exerciseId}', 0, 1,
        jsonb_build_object(
          'sourceExerciseId', '${exerciseId}',
          'broad', jsonb_build_array(jsonb_build_object(
            'sourceRequirementId', '${broadRequirementId}',
            'equipmentType', 'cable',
            'equipmentDefinition', jsonb_build_object(
              'id', '${cableDefinitionId}', 'key', 'prep-cable',
              'label', 'Saved cable station'
            ),
            'minWeight', NULL
          )),
          'exact', jsonb_build_object(
            'sourceRequirementId', '${exactRequirementId}',
            'requiredProfileKind', 'cable_machine',
            'requiredEquipmentDefinition', jsonb_build_object(
              'id', '${cableDefinitionId}', 'key', 'prep-cable',
              'label', 'Saved cable station'
            ),
            'requiredAttachmentKind', 'rope',
            'requiredAttachmentDefinition', jsonb_build_object(
              'id', '${ropeDefinitionId}', 'key', 'prep-rope',
              'label', 'Saved rope'
            ),
            'requiresKnownGeometry', true
          )
        )
      );
      INSERT INTO equipment_items (
        id, user_id, type, definition_id, label, available
      ) VALUES
        ('${cableItemId}', '${ownerId}', 'cable', '${cableDefinitionId}', 'Cable', true),
        ('${ropeItemId}', '${ownerId}', 'other', '${ropeDefinitionId}', 'Rope', true);
      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty, stack_count,
        topology, displayed_unit, ratio_status, ratio_numerator,
        ratio_denominator
      ) VALUES (
        '${cableProfileId}', '${ownerId}', '${cableItemId}', 'known', 1,
        'shared_selection', 'lb', 'known', 1, 1
      );
      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index, displayed_load
      ) VALUES ('${ownerId}', '${cableProfileId}', 0, 0, 10);
      INSERT INTO cable_attachment_profiles (
        id, user_id, equipment_item_id, attachment_kind, status
      ) VALUES (
        '${ropeProfileId}', '${ownerId}', '${ropeItemId}', 'rope', 'known'
      );
      INSERT INTO cable_attachment_compatibilities (
        cable_profile_id, attachment_profile_id, user_id
      ) VALUES ('${cableProfileId}', '${ropeProfileId}', '${ownerId}');
    `);

    await expect(resolveSessionPreparationEquipmentProjection(
      database.db,
      otherId,
      sessionId,
      0,
    )).resolves.toBeNull();
    const available = await resolveSessionPreparationEquipmentProjection(
      database.db,
      ownerId,
      sessionId,
      0,
    );
    expect(available).toMatchObject({
      state: "available",
      evidenceState: "retained",
      sourceHistoryRevision: 0,
      statusText: "Saved equipment covers this workout.",
    });
    expect(available?.rows.map((row) => [row.label, row.status])).toEqual([
      ["Saved cable station", "available"],
      ["Saved rope", "available"],
    ]);

    let restoreRaceReadCount = 0;
    const restoreRacingDb = {
      execute: async (...args: Parameters<Db["execute"]>) => {
        restoreRaceReadCount += 1;
        const result = await database.db.execute(...args);
        if (restoreRaceReadCount === 2) {
          await database.client.exec(`
            BEGIN;
            SELECT set_config(
              'workout_tracker.authorized_delete', 'snapshot_restore', true
            );
            UPDATE session_exercises
            SET equipment_requirements_snapshot = jsonb_set(
              equipment_requirements_snapshot,
              '{exact,requiresKnownGeometry}',
              'false'::jsonb
            )
            WHERE id = '${sessionExerciseId}';
            COMMIT;
          `);
        }
        return result;
      },
    } as unknown as Db;
    await expect(resolveSessionPreparationEquipmentProjection(
      restoreRacingDb,
      ownerId,
      sessionId,
      0,
    )).resolves.toEqual({
      state: "unknown",
      statusText: "Updating equipment after workout change.",
      evidenceState: "updating",
      sourceHistoryRevision: 0,
      rows: [],
    });
    await database.client.exec(`
      BEGIN;
      SELECT set_config(
        'workout_tracker.authorized_delete', 'snapshot_restore', true
      );
      UPDATE session_exercises
      SET equipment_requirements_snapshot = jsonb_set(
        equipment_requirements_snapshot,
        '{exact,requiresKnownGeometry}',
        'true'::jsonb
      )
      WHERE id = '${sessionExerciseId}';
      COMMIT;
    `);

    let inventoryRaceReadCount = 0;
    const inventoryRacingDb = {
      execute: async (...args: Parameters<Db["execute"]>) => {
        inventoryRaceReadCount += 1;
        const result = await database.db.execute(...args);
        if (inventoryRaceReadCount === 3) {
          await database.client.exec(`
            UPDATE equipment_items SET available = false
            WHERE id = '${cableItemId}'
          `);
        }
        return result;
      },
    } as unknown as Db;
    await expect(resolveSessionPreparationEquipmentProjection(
      inventoryRacingDb,
      ownerId,
      sessionId,
      0,
    )).resolves.toMatchObject({
      state: "unknown",
      evidenceState: "updating",
      sourceHistoryRevision: 0,
      rows: [],
    });
    await database.client.exec(`
      UPDATE equipment_items SET available = true WHERE id = '${cableItemId}'
    `);
    await expect(resolveSessionPreparationEquipmentProjection(
      database.db,
      ownerId,
      sessionId,
      1,
    )).resolves.toEqual({
      state: "unknown",
      statusText: "Updating equipment after workout change.",
      evidenceState: "updating",
      sourceHistoryRevision: 0,
      rows: [],
    });

    await database.client.exec(`
      UPDATE cable_machine_profiles
      SET geometry_certainty = 'unknown', stack_count = NULL,
          topology = NULL, displayed_unit = NULL, ratio_status = 'unknown',
          ratio_numerator = NULL, ratio_denominator = NULL
      WHERE id = '${cableProfileId}';
      DELETE FROM cable_stack_steps WHERE cable_profile_id = '${cableProfileId}'
    `);
    expect(await resolveSessionPreparationEquipmentProjection(
      database.db,
      ownerId,
      sessionId,
      0,
    )).toMatchObject({ state: "unavailable" });
    await database.client.exec(`
      UPDATE cable_machine_profiles
      SET geometry_certainty = 'known', stack_count = 1,
          topology = 'shared_selection', displayed_unit = 'lb',
          ratio_status = 'known', ratio_numerator = 1, ratio_denominator = 1
      WHERE id = '${cableProfileId}';
      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index, displayed_load
      ) VALUES ('${ownerId}', '${cableProfileId}', 0, 0, 10);
      UPDATE equipment_items SET available = false WHERE id = '${ropeItemId}';
    `);
    const attachmentUnavailable = await resolveSessionPreparationEquipmentProjection(
      database.db,
      ownerId,
      sessionId,
      0,
    );
    expect(attachmentUnavailable).toMatchObject({ state: "unavailable" });
    expect(attachmentUnavailable?.rows.find((row) => row.label === "Saved rope"))
      .toMatchObject({ status: "unavailable" });
  }, 30_000);

  it("isolates frozen exact tuples that repeat one source requirement ID", async () => {
    const database = await createMigratedTestDatabase();
    databases.push(database);
    const ownerId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionExerciseA = crypto.randomUUID();
    const sessionExerciseB = crypto.randomUUID();
    const cableDefinitionA = crypto.randomUUID();
    const cableDefinitionB = crypto.randomUUID();
    const ropeDefinitionA = crypto.randomUUID();
    const ropeDefinitionB = crypto.randomUUID();
    const broadRequirementId = crypto.randomUUID();
    const exactRequirementId = crypto.randomUUID();
    const cableItemA = crypto.randomUUID();
    const cableItemB = crypto.randomUUID();
    const ropeItemA = crypto.randomUUID();
    const ropeItemB = crypto.randomUUID();
    const cableProfileA = crypto.randomUUID();
    const cableProfileB = crypto.randomUUID();
    const ropeProfileA = crypto.randomUUID();
    const ropeProfileB = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email)
      VALUES ('${ownerId}', 'prep-frozen-revisions@example.test');
      INSERT INTO user_profiles (user_id, unit, timezone)
      VALUES ('${ownerId}', 'lb', 'America/Toronto');
      INSERT INTO equipment_definitions (id, key, label, category) VALUES
        ('${cableDefinitionA}', 'frozen-cable-a', 'Cable A', 'cable'),
        ('${cableDefinitionB}', 'frozen-cable-b', 'Cable B', 'cable'),
        ('${ropeDefinitionA}', 'frozen-rope-a', 'Rope A', 'other'),
        ('${ropeDefinitionB}', 'frozen-rope-b', 'Rope B', 'other');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics
      ) VALUES (
        '${exerciseId}', 'Frozen cable revisions', 'horizontal_push',
        '["triceps"]'::jsonb, 'external', 'weight_reps', 'machine_stack'
      );
      INSERT INTO workout_sessions (
        id, user_id, timezone, local_date, started_at, status, history_revision
      ) VALUES (
        '${sessionId}', '${ownerId}', 'America/Toronto', '2026-08-10',
        '2026-08-10T12:00:00Z', 'in_progress', 0
      );
      INSERT INTO session_exercises (
        id, session_id, exercise_id, order_idx,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot
      ) VALUES
        (
          '${sessionExerciseA}', '${sessionId}', '${exerciseId}', 0, 1,
          jsonb_build_object(
            'sourceExerciseId', '${exerciseId}',
            'broad', jsonb_build_array(jsonb_build_object(
              'sourceRequirementId', '${broadRequirementId}',
              'equipmentType', 'cable',
              'equipmentDefinition', jsonb_build_object(
                'id', '${cableDefinitionA}', 'key', 'frozen-cable-a',
                'label', 'Cable A'
              ),
              'minWeight', NULL
            )),
            'exact', jsonb_build_object(
              'sourceRequirementId', '${exactRequirementId}',
              'requiredProfileKind', 'cable_machine',
              'requiredEquipmentDefinition', jsonb_build_object(
                'id', '${cableDefinitionA}', 'key', 'frozen-cable-a',
                'label', 'Cable A'
              ),
              'requiredAttachmentKind', 'rope',
              'requiredAttachmentDefinition', jsonb_build_object(
                'id', '${ropeDefinitionA}', 'key', 'frozen-rope-a',
                'label', 'Rope A'
              ),
              'requiresKnownGeometry', true
            )
          )
        ),
        (
          '${sessionExerciseB}', '${sessionId}', '${exerciseId}', 1, 1,
          jsonb_build_object(
            'sourceExerciseId', '${exerciseId}',
            'broad', jsonb_build_array(jsonb_build_object(
              'sourceRequirementId', '${broadRequirementId}',
              'equipmentType', 'cable',
              'equipmentDefinition', jsonb_build_object(
                'id', '${cableDefinitionB}', 'key', 'frozen-cable-b',
                'label', 'Cable B'
              ),
              'minWeight', NULL
            )),
            'exact', jsonb_build_object(
              'sourceRequirementId', '${exactRequirementId}',
              'requiredProfileKind', 'cable_machine',
              'requiredEquipmentDefinition', jsonb_build_object(
                'id', '${cableDefinitionB}', 'key', 'frozen-cable-b',
                'label', 'Cable B'
              ),
              'requiredAttachmentKind', 'rope',
              'requiredAttachmentDefinition', jsonb_build_object(
                'id', '${ropeDefinitionB}', 'key', 'frozen-rope-b',
                'label', 'Rope B'
              ),
              'requiresKnownGeometry', true
            )
          )
        );
      INSERT INTO equipment_items (
        id, user_id, type, definition_id, label, available
      ) VALUES
        ('${cableItemA}', '${ownerId}', 'cable', '${cableDefinitionA}', 'Cable A', true),
        ('${cableItemB}', '${ownerId}', 'cable', '${cableDefinitionB}', 'Cable B', true),
        ('${ropeItemA}', '${ownerId}', 'other', '${ropeDefinitionA}', 'Rope A', true),
        ('${ropeItemB}', '${ownerId}', 'other', '${ropeDefinitionB}', 'Rope B', true);
      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty, stack_count,
        topology, displayed_unit, ratio_status, ratio_numerator,
        ratio_denominator
      ) VALUES
        ('${cableProfileA}', '${ownerId}', '${cableItemA}', 'known', 1,
         'shared_selection', 'lb', 'known', 1, 1),
        ('${cableProfileB}', '${ownerId}', '${cableItemB}', 'known', 1,
         'shared_selection', 'lb', 'known', 1, 1);
      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index, displayed_load
      ) VALUES
        ('${ownerId}', '${cableProfileA}', 0, 0, 10),
        ('${ownerId}', '${cableProfileB}', 0, 0, 10);
      INSERT INTO cable_attachment_profiles (
        id, user_id, equipment_item_id, attachment_kind, status
      ) VALUES
        ('${ropeProfileA}', '${ownerId}', '${ropeItemA}', 'rope', 'known'),
        ('${ropeProfileB}', '${ownerId}', '${ropeItemB}', 'rope', 'known');
      INSERT INTO cable_attachment_compatibilities (
        cable_profile_id, attachment_profile_id, user_id
      ) VALUES
        ('${cableProfileA}', '${ropeProfileA}', '${ownerId}'),
        ('${cableProfileB}', '${ropeProfileB}', '${ownerId}');
    `);

    const projection = await resolveSessionPreparationEquipmentProjection(
      database.db,
      ownerId,
      sessionId,
      0,
    );
    expect(projection).toMatchObject({
      state: "available",
      evidenceState: "retained",
      sourceHistoryRevision: 0,
      statusText: "Saved equipment covers this workout.",
    });
    expect(projection?.rows.map((row) => [row.label, row.status])).toEqual([
      ["Cable A", "available"],
      ["Rope A", "available"],
      ["Cable B", "available"],
      ["Rope B", "available"],
    ]);
  }, 30_000);

  it("resolves an exact-only retained profile from saved equipment", async () => {
    const database = await createMigratedTestDatabase();
    databases.push(database);
    const ownerId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const exactRequirementId = crypto.randomUUID();
    const cableItemId = crypto.randomUUID();
    const cableProfileId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email)
      VALUES ('${ownerId}', 'prep-exact-only@example.test');
      INSERT INTO user_profiles (user_id, unit, timezone)
      VALUES ('${ownerId}', 'lb', 'America/Toronto');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics
      ) VALUES (
        '${exerciseId}', 'Exact-only cable exercise', 'horizontal_push',
        '["triceps"]'::jsonb, 'external', 'weight_reps', 'machine_stack'
      );
      INSERT INTO workout_sessions (
        id, user_id, timezone, local_date, started_at, status, history_revision
      ) VALUES (
        '${sessionId}', '${ownerId}', 'America/Toronto', '2026-08-10',
        '2026-08-10T12:00:00Z', 'in_progress', 0
      );
      INSERT INTO session_exercises (
        session_id, exercise_id, order_idx,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot
      ) VALUES (
        '${sessionId}', '${exerciseId}', 0, 1,
        jsonb_build_object(
          'sourceExerciseId', '${exerciseId}',
          'broad', '[]'::jsonb,
          'exact', jsonb_build_object(
            'sourceRequirementId', '${exactRequirementId}',
            'requiredProfileKind', 'cable_machine',
            'requiredEquipmentDefinition', NULL,
            'requiredAttachmentKind', NULL,
            'requiredAttachmentDefinition', NULL,
            'requiresKnownGeometry', false
          )
        )
      );
      INSERT INTO equipment_items (
        id, user_id, type, label, available
      ) VALUES ('${cableItemId}', '${ownerId}', 'cable', 'Saved cable', true);
      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty, stack_count,
        topology, displayed_unit, ratio_status, ratio_numerator,
        ratio_denominator
      ) VALUES (
        '${cableProfileId}', '${ownerId}', '${cableItemId}', 'known', 1,
        'shared_selection', 'lb', 'known', 1, 1
      );
      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index, displayed_load
      ) VALUES ('${ownerId}', '${cableProfileId}', 0, 0, 10);
    `);

    const projection = await resolveSessionPreparationEquipmentProjection(
      database.db,
      ownerId,
      sessionId,
      0,
    );
    expect(projection).toMatchObject({
      state: "available",
      evidenceState: "retained",
      sourceHistoryRevision: 0,
      statusText: "Saved equipment covers this workout.",
    });
    expect(projection?.rows).toEqual([expect.objectContaining({
      key: `exact-requirement:${exactRequirementId}`,
      label: "cable machine",
      status: "available",
      statusText: "In saved equipment",
    })]);
  }, 30_000);

  it("separates saved primary and attachment rows from full compatibility", async () => {
    const database = await createMigratedTestDatabase();
    databases.push(database);
    const splitOwnerId = crypto.randomUUID();
    const missingOwnerId = crypto.randomUUID();
    const splitExerciseId = crypto.randomUUID();
    const missingExerciseId = crypto.randomUUID();
    const splitSessionId = crypto.randomUUID();
    const missingSessionId = crypto.randomUUID();
    const splitExactId = crypto.randomUUID();
    const missingExactId = crypto.randomUUID();
    const ropeDefinitionId = crypto.randomUUID();
    const knownCableItemId = crypto.randomUUID();
    const ropeCableItemId = crypto.randomUUID();
    const ropeItemId = crypto.randomUUID();
    const missingCableItemId = crypto.randomUUID();
    const knownCableProfileId = crypto.randomUUID();
    const ropeCableProfileId = crypto.randomUUID();
    const missingCableProfileId = crypto.randomUUID();
    const ropeProfileId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email) VALUES
        ('${splitOwnerId}', 'prep-split-candidates@example.test'),
        ('${missingOwnerId}', 'prep-missing-attachment@example.test');
      INSERT INTO user_profiles (user_id, unit, timezone) VALUES
        ('${splitOwnerId}', 'lb', 'America/Toronto'),
        ('${missingOwnerId}', 'lb', 'America/Toronto');
      INSERT INTO equipment_definitions (id, key, label, category)
      VALUES ('${ropeDefinitionId}', 'row-local-rope', 'Saved rope', 'other');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics
      ) VALUES
        ('${splitExerciseId}', 'Split candidate cable', 'horizontal_push',
         '["triceps"]'::jsonb, 'external', 'weight_reps', 'machine_stack'),
        ('${missingExerciseId}', 'Missing attachment cable', 'horizontal_push',
         '["triceps"]'::jsonb, 'external', 'weight_reps', 'machine_stack');
      INSERT INTO workout_sessions (
        id, user_id, timezone, local_date, started_at, status, history_revision
      ) VALUES
        ('${splitSessionId}', '${splitOwnerId}', 'America/Toronto',
         '2026-08-10', '2026-08-10T12:00:00Z', 'in_progress', 0),
        ('${missingSessionId}', '${missingOwnerId}', 'America/Toronto',
         '2026-08-10', '2026-08-10T12:00:00Z', 'in_progress', 0);
      INSERT INTO session_exercises (
        session_id, exercise_id, order_idx,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot
      ) VALUES
        (
          '${splitSessionId}', '${splitExerciseId}', 0, 1,
          jsonb_build_object(
            'sourceExerciseId', '${splitExerciseId}',
            'broad', '[]'::jsonb,
            'exact', jsonb_build_object(
              'sourceRequirementId', '${splitExactId}',
              'requiredProfileKind', 'cable_machine',
              'requiredEquipmentDefinition', NULL,
              'requiredAttachmentKind', 'rope',
              'requiredAttachmentDefinition', jsonb_build_object(
                'id', '${ropeDefinitionId}', 'key', 'row-local-rope',
                'label', 'Saved rope'
              ),
              'requiresKnownGeometry', true
            )
          )
        ),
        (
          '${missingSessionId}', '${missingExerciseId}', 0, 1,
          jsonb_build_object(
            'sourceExerciseId', '${missingExerciseId}',
            'broad', '[]'::jsonb,
            'exact', jsonb_build_object(
              'sourceRequirementId', '${missingExactId}',
              'requiredProfileKind', 'cable_machine',
              'requiredEquipmentDefinition', NULL,
              'requiredAttachmentKind', 'rope',
              'requiredAttachmentDefinition', jsonb_build_object(
                'id', '${ropeDefinitionId}', 'key', 'row-local-rope',
                'label', 'Saved rope'
              ),
              'requiresKnownGeometry', true
            )
          )
        );
      INSERT INTO equipment_items (
        id, user_id, type, definition_id, label, available
      ) VALUES
        ('${knownCableItemId}', '${splitOwnerId}', 'cable', NULL, 'Known cable', true),
        ('${ropeCableItemId}', '${splitOwnerId}', 'cable', NULL, 'Rope cable', true),
        ('${ropeItemId}', '${splitOwnerId}', 'other', '${ropeDefinitionId}', 'Saved rope', true),
        ('${missingCableItemId}', '${missingOwnerId}', 'cable', NULL, 'Known cable', true);
      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty, stack_count,
        topology, displayed_unit, ratio_status, ratio_numerator,
        ratio_denominator
      ) VALUES
        ('${knownCableProfileId}', '${splitOwnerId}', '${knownCableItemId}',
         'known', 1, 'shared_selection', 'lb', 'known', 1, 1),
        ('${ropeCableProfileId}', '${splitOwnerId}', '${ropeCableItemId}',
         'unknown', NULL, NULL, NULL, 'unknown', NULL, NULL),
        ('${missingCableProfileId}', '${missingOwnerId}', '${missingCableItemId}',
         'known', 1, 'shared_selection', 'lb', 'known', 1, 1);
      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index, displayed_load
      ) VALUES
        ('${splitOwnerId}', '${knownCableProfileId}', 0, 0, 10),
        ('${missingOwnerId}', '${missingCableProfileId}', 0, 0, 10);
      INSERT INTO cable_attachment_profiles (
        id, user_id, equipment_item_id, attachment_kind, status
      ) VALUES (
        '${ropeProfileId}', '${splitOwnerId}', '${ropeItemId}', 'rope', 'known'
      );
      INSERT INTO cable_attachment_compatibilities (
        cable_profile_id, attachment_profile_id, user_id
      ) VALUES (
        '${ropeCableProfileId}', '${ropeProfileId}', '${splitOwnerId}'
      );
    `);

    const splitProjection = await resolveSessionPreparationEquipmentProjection(
      database.db,
      splitOwnerId,
      splitSessionId,
      0,
    );
    expect(splitProjection).toMatchObject({
      state: "unavailable",
      evidenceState: "retained",
      statusText:
        "Saved equipment is present, but no compatible setup covers this workout.",
    });
    expect(splitProjection?.rows.map((row) => [row.label, row.status])).toEqual([
      ["cable machine", "incompatible"],
      ["Saved rope", "incompatible"],
    ]);

    const missingProjection = await resolveSessionPreparationEquipmentProjection(
      database.db,
      missingOwnerId,
      missingSessionId,
      0,
    );
    expect(missingProjection).toMatchObject({
      state: "unavailable",
      evidenceState: "retained",
      statusText:
        "Some requirements are unavailable or have no compatible saved setup.",
    });
    expect(missingProjection?.rows.map((row) => [row.label, row.status])).toEqual([
      ["cable machine", "incompatible"],
      ["Saved rope", "unavailable"],
    ]);
  }, 30_000);

  it("keeps an available unlinked attachment present but incompatible", async () => {
    const database = await createMigratedTestDatabase();
    databases.push(database);
    const ownerId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const exactRequirementId = crypto.randomUUID();
    const ropeDefinitionId = crypto.randomUUID();
    const cableItemId = crypto.randomUUID();
    const ropeItemId = crypto.randomUUID();
    const cableProfileId = crypto.randomUUID();
    const ropeProfileId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email)
      VALUES ('${ownerId}', 'prep-unlinked-attachment@example.test');
      INSERT INTO user_profiles (user_id, unit, timezone)
      VALUES ('${ownerId}', 'lb', 'America/Toronto');
      INSERT INTO equipment_definitions (id, key, label, category)
      VALUES ('${ropeDefinitionId}', 'unlinked-rope', 'Saved rope', 'other');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics
      ) VALUES (
        '${exerciseId}', 'Unlinked rope cable', 'horizontal_push',
        '["triceps"]'::jsonb, 'external', 'weight_reps', 'machine_stack'
      );
      INSERT INTO workout_sessions (
        id, user_id, timezone, local_date, started_at, status, history_revision
      ) VALUES (
        '${sessionId}', '${ownerId}', 'America/Toronto', '2026-08-10',
        '2026-08-10T12:00:00Z', 'in_progress', 0
      );
      INSERT INTO session_exercises (
        session_id, exercise_id, order_idx,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot
      ) VALUES (
        '${sessionId}', '${exerciseId}', 0, 1,
        jsonb_build_object(
          'sourceExerciseId', '${exerciseId}',
          'broad', '[]'::jsonb,
          'exact', jsonb_build_object(
            'sourceRequirementId', '${exactRequirementId}',
            'requiredProfileKind', 'cable_machine',
            'requiredEquipmentDefinition', NULL,
            'requiredAttachmentKind', 'rope',
            'requiredAttachmentDefinition', jsonb_build_object(
              'id', '${ropeDefinitionId}', 'key', 'unlinked-rope',
              'label', 'Saved rope'
            ),
            'requiresKnownGeometry', true
          )
        )
      );
      INSERT INTO equipment_items (
        id, user_id, type, definition_id, label, available
      ) VALUES
        ('${cableItemId}', '${ownerId}', 'cable', NULL, 'Known cable', true),
        ('${ropeItemId}', '${ownerId}', 'other', '${ropeDefinitionId}', 'Saved rope', true);
      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty, stack_count,
        topology, displayed_unit, ratio_status, ratio_numerator,
        ratio_denominator
      ) VALUES (
        '${cableProfileId}', '${ownerId}', '${cableItemId}', 'known', 1,
        'shared_selection', 'lb', 'known', 1, 1
      );
      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index, displayed_load
      ) VALUES ('${ownerId}', '${cableProfileId}', 0, 0, 10);
      INSERT INTO cable_attachment_profiles (
        id, user_id, equipment_item_id, attachment_kind, status
      ) VALUES (
        '${ropeProfileId}', '${ownerId}', '${ropeItemId}', 'rope', 'known'
      );
    `);

    const projection = await resolveSessionPreparationEquipmentProjection(
      database.db,
      ownerId,
      sessionId,
      0,
    );
    expect(projection).toMatchObject({
      state: "unavailable",
      evidenceState: "retained",
      statusText:
        "Saved equipment is present, but no compatible setup covers this workout.",
    });
    expect(projection?.rows.map((row) => [row.label, row.status])).toEqual([
      ["cable machine", "incompatible"],
      ["Saved rope", "incompatible"],
    ]);
  }, 30_000);

  it("checks shared primary rows against every frozen revision", async () => {
    const database = await createMigratedTestDatabase();
    databases.push(database);
    const ownerId = crypto.randomUUID();
    const cableExerciseId = crypto.randomUUID();
    const machineExerciseId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sharedDefinitionId = crypto.randomUUID();
    const sharedExactRequirementId = crypto.randomUUID();
    const cableItemId = crypto.randomUUID();
    const cableProfileId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email)
      VALUES ('${ownerId}', 'prep-shared-primary-revisions@example.test');
      INSERT INTO user_profiles (user_id, unit, timezone)
      VALUES ('${ownerId}', 'lb', 'America/Toronto');
      INSERT INTO equipment_definitions (id, key, label, category)
      VALUES (
        '${sharedDefinitionId}', 'shared-primary-station',
        'Shared station', 'cable'
      );
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type,
        metric_type, load_semantics
      ) VALUES
        ('${cableExerciseId}', 'Shared cable revision', 'horizontal_push',
         '["triceps"]'::jsonb, 'external', 'weight_reps', 'machine_stack'),
        ('${machineExerciseId}', 'Shared machine revision', 'horizontal_push',
         '["triceps"]'::jsonb, 'external', 'weight_reps', 'machine_stack');
      INSERT INTO workout_sessions (
        id, user_id, timezone, local_date, started_at, status, history_revision
      ) VALUES (
        '${sessionId}', '${ownerId}', 'America/Toronto', '2026-08-10',
        '2026-08-10T12:00:00Z', 'in_progress', 0
      );
      INSERT INTO session_exercises (
        session_id, exercise_id, order_idx,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot
      ) VALUES
        (
          '${sessionId}', '${cableExerciseId}', 0, 1,
          jsonb_build_object(
            'sourceExerciseId', '${cableExerciseId}',
            'broad', '[]'::jsonb,
            'exact', jsonb_build_object(
              'sourceRequirementId', '${sharedExactRequirementId}',
              'requiredProfileKind', 'cable_machine',
              'requiredEquipmentDefinition', jsonb_build_object(
                'id', '${sharedDefinitionId}', 'key', 'shared-primary-station',
                'label', 'Shared station'
              ),
              'requiredAttachmentKind', NULL,
              'requiredAttachmentDefinition', NULL,
              'requiresKnownGeometry', true
            )
          )
        ),
        (
          '${sessionId}', '${machineExerciseId}', 1, 1,
          jsonb_build_object(
            'sourceExerciseId', '${machineExerciseId}',
            'broad', '[]'::jsonb,
            'exact', jsonb_build_object(
              'sourceRequirementId', '${sharedExactRequirementId}',
              'requiredProfileKind', 'plate_loaded_machine',
              'requiredEquipmentDefinition', jsonb_build_object(
                'id', '${sharedDefinitionId}', 'key', 'shared-primary-station',
                'label', 'Shared station'
              ),
              'requiredAttachmentKind', NULL,
              'requiredAttachmentDefinition', NULL,
              'requiresKnownGeometry', true
            )
          )
        );
      INSERT INTO equipment_items (
        id, user_id, type, definition_id, label, available
      ) VALUES (
        '${cableItemId}', '${ownerId}', 'cable', '${sharedDefinitionId}',
        'Saved shared cable', true
      );
      INSERT INTO cable_machine_profiles (
        id, user_id, equipment_item_id, geometry_certainty, stack_count,
        topology, displayed_unit, ratio_status, ratio_numerator,
        ratio_denominator
      ) VALUES (
        '${cableProfileId}', '${ownerId}', '${cableItemId}', 'known', 1,
        'shared_selection', 'lb', 'known', 1, 1
      );
      INSERT INTO cable_stack_steps (
        user_id, cable_profile_id, stack_index, step_index, displayed_load
      ) VALUES ('${ownerId}', '${cableProfileId}', 0, 0, 10);
    `);

    const projection = await resolveSessionPreparationEquipmentProjection(
      database.db,
      ownerId,
      sessionId,
      0,
    );
    expect(projection).toMatchObject({
      state: "unavailable",
      evidenceState: "retained",
      statusText: "Some requirements are unavailable in saved equipment.",
    });
    expect(projection?.rows).toEqual([expect.objectContaining({
      key: `definition:${sharedDefinitionId}`,
      label: "Shared station",
      status: "unavailable",
      statusText: "Unavailable in saved equipment",
    })]);
  }, 30_000);

  it("requires one executable setup across conflicting retained definitions", async () => {
    const database = await createMigratedTestDatabase();
    databases.push(database);
    const broadOwnerId = crypto.randomUUID();
    const exactOwnerId = crypto.randomUUID();
    const broadExerciseId = crypto.randomUUID();
    const exactExerciseId = crypto.randomUUID();
    const broadSessionId = crypto.randomUUID();
    const exactSessionId = crypto.randomUUID();
    const definitionA = crypto.randomUUID();
    const definitionB = crypto.randomUUID();
    const broadAItem = crypto.randomUUID();
    const broadBItem = crypto.randomUUID();
    const exactAItem = crypto.randomUUID();
    const exactBItem = crypto.randomUUID();
    const broadRequirementA = crypto.randomUUID();
    const broadRequirementB = crypto.randomUUID();
    const broadExactRequirement = crypto.randomUUID();
    const exactBroadRequirement = crypto.randomUUID();
    const exactRequirement = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email) VALUES
        ('${broadOwnerId}', 'prep-conflicting-broad@example.test'),
        ('${exactOwnerId}', 'prep-conflicting-exact@example.test');
      INSERT INTO user_profiles (user_id, unit, timezone) VALUES
        ('${broadOwnerId}', 'lb', 'America/Toronto'),
        ('${exactOwnerId}', 'lb', 'America/Toronto');
      INSERT INTO equipment_definitions (id, key, label, category) VALUES
        ('${definitionA}', 'prep-bar-a', 'Saved bar A', 'barbell'),
        ('${definitionB}', 'prep-bar-b', 'Saved bar B', 'barbell');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type
      ) VALUES
        ('${broadExerciseId}', 'Conflicting broad bars', 'horizontal_push',
         '["chest"]'::jsonb, 'barbell'),
        ('${exactExerciseId}', 'Conflicting exact bar', 'horizontal_push',
         '["chest"]'::jsonb, 'barbell');
      INSERT INTO workout_sessions (
        id, user_id, timezone, local_date, started_at, status
      ) VALUES
        ('${broadSessionId}', '${broadOwnerId}', 'America/Toronto',
         '2026-08-10', '2026-08-10T13:00:00Z', 'in_progress'),
        ('${exactSessionId}', '${exactOwnerId}', 'America/Toronto',
         '2026-08-10', '2026-08-10T13:00:00Z', 'in_progress');
      INSERT INTO session_exercises (
        session_id, exercise_id, order_idx,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot
      ) VALUES
        ('${broadSessionId}', '${broadExerciseId}', 0, 1,
         jsonb_build_object(
           'sourceExerciseId', '${broadExerciseId}',
           'broad', jsonb_build_array(
             jsonb_build_object(
               'sourceRequirementId', '${broadRequirementA}',
               'equipmentType', 'barbell',
               'equipmentDefinition', jsonb_build_object(
                 'id', '${definitionA}', 'key', 'prep-bar-a',
                 'label', 'Saved bar A'
               ),
               'minWeight', NULL
             ),
             jsonb_build_object(
               'sourceRequirementId', '${broadRequirementB}',
               'equipmentType', 'barbell',
               'equipmentDefinition', jsonb_build_object(
                 'id', '${definitionB}', 'key', 'prep-bar-b',
                 'label', 'Saved bar B'
               ),
               'minWeight', NULL
             )
           ),
           'exact', jsonb_build_object(
             'sourceRequirementId', '${broadExactRequirement}',
             'requiredProfileKind', 'plate_loaded_implement',
             'requiredEquipmentDefinition', NULL,
             'requiredAttachmentKind', NULL,
             'requiredAttachmentDefinition', NULL,
             'requiresKnownGeometry', true
           )
         )),
        ('${exactSessionId}', '${exactExerciseId}', 0, 1,
         jsonb_build_object(
           'sourceExerciseId', '${exactExerciseId}',
           'broad', jsonb_build_array(jsonb_build_object(
             'sourceRequirementId', '${exactBroadRequirement}',
             'equipmentType', 'barbell',
             'equipmentDefinition', jsonb_build_object(
               'id', '${definitionA}', 'key', 'prep-bar-a',
               'label', 'Saved bar A'
             ),
             'minWeight', NULL
           )),
           'exact', jsonb_build_object(
             'sourceRequirementId', '${exactRequirement}',
             'requiredProfileKind', 'plate_loaded_implement',
             'requiredEquipmentDefinition', jsonb_build_object(
               'id', '${definitionB}', 'key', 'prep-bar-b',
               'label', 'Saved bar B'
             ),
             'requiredAttachmentKind', NULL,
             'requiredAttachmentDefinition', NULL,
             'requiresKnownGeometry', true
           )
         ));
      INSERT INTO equipment_items (
        id, user_id, type, definition_id, label, available
      ) VALUES
        ('${broadAItem}', '${broadOwnerId}', 'barbell', '${definitionA}', 'Broad A', true),
        ('${broadBItem}', '${broadOwnerId}', 'barbell', '${definitionB}', 'Broad B', true),
        ('${exactAItem}', '${exactOwnerId}', 'barbell', '${definitionA}', 'Exact A', true),
        ('${exactBItem}', '${exactOwnerId}', 'barbell', '${definitionB}', 'Exact B', true);
      INSERT INTO barbell_configs (
        user_id, bar_type, equipment_item_id, unit, loading_kind,
        shared_plate_pool_compatible, bar_weight, collar_weight, label
      ) VALUES
        ('${broadOwnerId}', 'olympic', '${broadAItem}', 'lb', 'olympic', true, 45, 0, 'Broad A'),
        ('${broadOwnerId}', 'olympic', '${broadBItem}', 'lb', 'olympic', true, 45, 0, 'Broad B'),
        ('${exactOwnerId}', 'olympic', '${exactAItem}', 'lb', 'olympic', true, 45, 0, 'Exact A'),
        ('${exactOwnerId}', 'olympic', '${exactBItem}', 'lb', 'olympic', true, 45, 0, 'Exact B');
    `);

    const broadConflict = await resolveSessionPreparationEquipmentProjection(
      database.db,
      broadOwnerId,
      broadSessionId,
      0,
    );
    expect(broadConflict).toMatchObject({
      state: "unavailable",
      evidenceState: "retained",
      statusText:
        "Saved equipment is present, but no compatible setup covers this workout.",
    });
    expect(broadConflict?.rows).toHaveLength(3);
    expect(broadConflict?.rows.every((row) =>
      row.status === "incompatible" &&
      row.statusText === "No compatible saved setup"
    ))
      .toBe(true);
    expect(broadConflict?.rows.find((row) =>
      row.key === `exact-requirement:${broadExactRequirement}`
    )).toMatchObject({
      label: "plate loaded implement",
      status: "incompatible",
    });

    const exactConflict = await resolveSessionPreparationEquipmentProjection(
      database.db,
      exactOwnerId,
      exactSessionId,
      0,
    );
    expect(exactConflict).toMatchObject({
      state: "unavailable",
      evidenceState: "retained",
      statusText:
        "Saved equipment is present, but no compatible setup covers this workout.",
    });
    expect(exactConflict?.rows.map((row) => [
      row.label,
      row.status,
      row.statusText,
    ])).toEqual([
      ["Saved bar A", "incompatible", "No compatible saved setup"],
      ["Saved bar B", "incompatible", "No compatible saved setup"],
    ]);
  }, 30_000);

  it("separates saved incompatible equipment from a missing requirement", async () => {
    const database = await createMigratedTestDatabase();
    databases.push(database);
    const ownerId = crypto.randomUUID();
    const exerciseId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const benchItemId = crypto.randomUUID();
    const benchRequirementId = crypto.randomUUID();
    const cableRequirementId = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email)
      VALUES ('${ownerId}', 'prep-mixed-availability@example.test');
      INSERT INTO user_profiles (user_id, unit, timezone)
      VALUES ('${ownerId}', 'lb', 'America/Toronto');
      INSERT INTO exercises (
        id, name, movement_pattern, primary_muscles, load_type
      ) VALUES (
        '${exerciseId}', 'Bench and cable exercise', 'horizontal_push',
        '["chest"]'::jsonb, 'bodyweight'
      );
      INSERT INTO workout_sessions (
        id, user_id, timezone, local_date, started_at, status
      ) VALUES (
        '${sessionId}', '${ownerId}', 'America/Toronto',
        '2026-08-10', '2026-08-10T13:00:00Z', 'in_progress'
      );
      INSERT INTO session_exercises (
        session_id, exercise_id, order_idx,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot
      ) VALUES (
        '${sessionId}', '${exerciseId}', 0, 1,
        jsonb_build_object(
          'sourceExerciseId', '${exerciseId}',
          'broad', jsonb_build_array(
            jsonb_build_object(
              'sourceRequirementId', '${benchRequirementId}',
              'equipmentType', 'bench',
              'equipmentDefinition', NULL,
              'minWeight', NULL
            ),
            jsonb_build_object(
              'sourceRequirementId', '${cableRequirementId}',
              'equipmentType', 'cable',
              'equipmentDefinition', NULL,
              'minWeight', NULL
            )
          ),
          'exact', NULL
        )
      );
      INSERT INTO equipment_items (
        id, user_id, type, label, available
      ) VALUES (
        '${benchItemId}', '${ownerId}', 'bench', 'Saved bench', true
      );
    `);

    const projection = await resolveSessionPreparationEquipmentProjection(
      database.db,
      ownerId,
      sessionId,
      0,
    );
    expect(projection).toMatchObject({
      state: "unavailable",
      evidenceState: "retained",
      statusText:
        "Some requirements are unavailable or have no compatible saved setup.",
    });
    expect(projection?.rows.map((row) => ({
      label: row.label,
      status: row.status,
      statusText: row.statusText,
    }))).toEqual([
      {
        label: "bench",
        status: "incompatible",
        statusText: "No compatible saved setup",
      },
      {
        label: "cable station",
        status: "unavailable",
        statusText: "Unavailable in saved equipment",
      },
    ]);
  }, 30_000);

  it("upgrades 0079 without a backfill and installs the immutable tuple guard", async () => {
    const database = await createTestDatabaseAtMigration(
      "0079_active_workout_duration_evidence",
    );
    databases.push(database);
    const [{ id: userId }] = await database.db.insert(users).values({
      email: `retained-migration-${crypto.randomUUID()}@example.com`,
    }).returning({ id: users.id });
    const [{ id: exerciseId }] = await database.db.insert(exercises).values({
      name: `Legacy requirement ${crypto.randomUUID()}`,
      movementPattern: "mobility",
      primaryMuscles: ["core"],
      loadType: "bodyweight",
    }).returning({ id: exercises.id });
    const legacySession = await database.client.query<{ id: string }>(`
      INSERT INTO workout_sessions (
        user_id, template_name, status, started_at, timezone, local_date
      ) VALUES ($1::uuid, $2, 'in_progress', $3::timestamptz, $4, $5::date)
      RETURNING id
    `, [userId, "Legacy active workout", "2026-08-10T12:00:00.000Z", "America/Toronto", "2026-08-10"]);
    const sessionId = legacySession.rows[0]!.id;
    const inserted = await database.client.query<{ id: string }>(`
      INSERT INTO session_exercises (session_id, exercise_id)
      VALUES ($1::uuid, $2::uuid)
      RETURNING id
    `, [sessionId, exerciseId]);
    const sessionExerciseId = inserted.rows[0]!.id;

    await migrateTestDatabaseThrough(
      database,
      "0080_session_equipment_requirements_snapshot",
    );
    expect(await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, sessionExerciseId),
    })).toMatchObject({
      equipmentRequirementsSemanticsVersion: null,
      equipmentRequirementsSnapshot: null,
    });
    const trigger = await database.client.query<{ name: string }>(`
      SELECT tgname AS name
      FROM pg_trigger
      WHERE tgname = 'session_exercises_equipment_requirements_snapshot_guard'
        AND NOT tgisinternal
    `);
    expect(trigger.rows).toEqual([{
      name: "session_exercises_equipment_requirements_snapshot_guard",
    }]);
    await expect(database.db.execute(sql`
      UPDATE session_exercises
      SET equipment_requirements_semantics_version = 1,
          equipment_requirements_snapshot = jsonb_build_object(
            'sourceExerciseId', exercise_id::text,
            'broad', '[]'::jsonb,
            'exact', NULL
          )
      WHERE id = ${sessionExerciseId}::uuid
    `)).rejects.toBeDefined();
    expect(await database.db.query.sessionExercises.findFirst({
      where: eq(sessionExercises.id, sessionExerciseId),
    })).toMatchObject({
      equipmentRequirementsSemanticsVersion: null,
      equipmentRequirementsSnapshot: null,
    });
  }, 30_000);
});
