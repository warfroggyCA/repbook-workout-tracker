import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createMigratedTestDatabase, type TestDatabase } from "../helpers/database";
import { logWorkoutSet } from "../helpers/log-workout-set";
import { loadEquipmentInventoryDocument } from "@/services/equipment-inventory";
import { saveInventoryDocumentForManagement } from "@/services/setup-persistence";
import { mutateSessionEquipmentSelection, resolveSessionEquipmentAvailability } from "@/services/session-equipment-selection";
import { getPreviousComparableSets } from "@/services/previous-comparable-sets";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import { getSnapshotRestorePreview, restoreDataSnapshot, upgradeSnapshotPayload, validateSnapshotPayload } from "@/services/snapshot-restore";

import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import { createDataSnapshot } from "@/services/snapshots";
import { equipmentItemProvidesType } from "@/engine/equipment-filter";
import { equipmentItemProvidesTypeSql } from "@/lib/equipment-capability-sql";
import { resultRows } from "@/db/result";

describe("shared plate-loaded pulley", () => {
  let database: TestDatabase;
  afterEach(async () => database?.close());

  it("saves one physical setup for distinct cable exercises and carries forward only their matching added-plate records", async () => {
    database = await createMigratedTestDatabase();
    const owner = crypto.randomUUID();
    const machine = crypto.randomUUID();
    const plate = crypto.randomUUID();
    await database.client.exec(`
      INSERT INTO users (id, email) VALUES ('${owner}', 'pulley-fixture@example.test');
      INSERT INTO user_profiles (user_id, unit) VALUES ('${owner}', 'lb');
      INSERT INTO equipment_items (id, user_id, type, label, attrs)
        VALUES ('${machine}', '${owner}', 'machine', 'Synthetic shared pulley', '{"cablePulley":true}');
      INSERT INTO plate_inventory (id, user_id, denomination, quantity, unit)
        VALUES ('${plate}', '${owner}', 10, 8, 'lb');
    `);
    const before = await captureUserSnapshot(database.db, owner, new Date("2026-01-09T12:00:00Z"), "test");
    const previousEnvelope = { ...before, schemaVersion: "36" };
    expect(upgradeSnapshotPayload(previousEnvelope)).toEqual(before);
    expect(() => validateSnapshotPayload(previousEnvelope, owner)).not.toThrow();
    const initial = (await loadEquipmentInventoryDocument(database.db, owner))!.document;
    const draft = { ...initial, loadProfiles: [{ equipmentItemId: machine, profile: {
      kind: "plate_loaded_machine" as const, id: null, geometryCertainty: "known" as const,
      startingResistance: null, startingResistanceUnit: "lb" as const,
      loadingPointCount: 2, balancingRule: "identical_each_point" as const,
      targetEntryMeaning: "added_plates" as const, compatiblePlateIds: [plate],
    } }] };
    expect(await saveInventoryDocumentForManagement(database.db, owner, draft)).toMatchObject({ ok: true });
    const saved = (await loadEquipmentInventoryDocument(database.db, owner))!.document;
    expect(saved.loadProfiles?.[0].profile).toMatchObject({
      startingResistance: null, targetEntryMeaning: "added_plates", loadingPointCount: 2,
    });
    expect(saved.items.find((item) => item.id === machine)?.attrs.cablePulley).toBe(true);

    await expect(database.client.exec(`UPDATE plate_loaded_machine_profiles
      SET geometry_certainty = 'partial', target_entry_meaning = NULL
      WHERE equipment_item_id = '${machine}';`)).rejects.toThrow(/resistance_unit_pair/);
    await expect(database.client.exec(`UPDATE plate_loaded_machine_profiles
      SET geometry_certainty = 'partial', starting_resistance = 5, starting_resistance_unit = NULL
      WHERE equipment_item_id = '${machine}';`)).rejects.toThrow(/resistance_unit_pair/);

    const movements = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, movement] of movements.entries()) {
      await database.client.exec(`
        INSERT INTO exercises (id, name, movement_pattern, primary_muscles, metric_type, load_type, load_semantics)
        VALUES ('${movement}', 'Synthetic cable movement ${index}', 'isolation_arms', '["biceps"]', 'weight_reps', 'external', 'machine_stack');
        INSERT INTO exercise_equipment_requirements (exercise_id, equipment_type) VALUES ('${movement}', 'cable');
      `);
    }
    async function workout(date: string) {
      const session = crypto.randomUUID();
      await database.client.exec(`
        INSERT INTO workout_sessions (id, user_id, status, started_at, timezone, local_date)
        VALUES ('${session}', '${owner}', 'in_progress', '${date}T12:00:00Z', 'UTC', '${date}');
      `);
      const entries: string[] = [];
      for (const [index, movement] of movements.entries()) {
        const entry = crypto.randomUUID();
        entries.push(entry);
        await database.client.exec(`
          INSERT INTO session_exercises (id, session_id, exercise_id, order_idx,
            prescribed_semantics_version, prescribed_exercise_name, prescribed_metric_type,
            prescribed_load_type, prescribed_load_semantics,
            equipment_requirements_semantics_version, equipment_requirements_snapshot)
          VALUES ('${entry}', '${session}', '${movement}', ${index}, 1, 'Synthetic cable movement ${index}',
            'weight_reps', 'external', 'machine_stack', 1,
            jsonb_build_object('sourceExerciseId', '${movement}', 'exact', null, 'broad',
              (SELECT jsonb_agg(jsonb_build_object('sourceRequirementId', id::text,
                'equipmentType', 'cable', 'equipmentDefinition', null, 'minWeight', null))
               FROM exercise_equipment_requirements WHERE exercise_id = '${movement}')));
          INSERT INTO session_occurrences (session_id, session_exercise_id, kind, origin,
            sequence_idx, kind_ordinal, planned_exercise_id, outcome)
          VALUES ('${session}', '${entry}', 'working_set', 'planned', ${index}, 0, '${movement}', 'pending');
        `);
      }
      return { session, entries };
    }
    async function select(entry: string) {
      const availability = await resolveSessionEquipmentAvailability(database.db, owner, entry);
      expect(availability).toMatchObject({ decisionState: "ready" });
      const selected = await mutateSessionEquipmentSelection(database.db, owner, {
        operation: "select", sessionExerciseId: entry, equipmentItemId: machine,
        attachmentItemId: null, expectedCurrentSnapshotId: null,
        clientKey: crypto.randomUUID(), provenance: "auto_unique",
      });
      if (!("snapshotId" in selected) || !selected.snapshotId) throw new Error(JSON.stringify(selected));
      return selected.snapshotId;
    }
    const past = await workout("2026-01-10");
    for (const [index, entry] of past.entries.entries()) {
      const snapshot = await select(entry);
      expect(await logWorkoutSet(database.db, owner, {
        sessionExerciseId: entry, setNo: 1, reps: 8, weight: (index + 1) * 20,
        weightUnit: "lb", clientKey: crypto.randomUUID(), equipmentSnapshotId: snapshot,
        loadEntryMeaning: "added_plates",
      })).toMatchObject({ outcome: "saved" });
    }
    await database.client.exec(`UPDATE workout_sessions SET status = 'completed', finished_at = '2026-01-10T13:00:00Z' WHERE id = '${past.session}';`);
    const current = await workout("2026-01-12");
    for (const entry of current.entries) await select(entry);
    const previous = await getPreviousComparableSets(database.db, owner, current.entries.map((sessionExerciseId) => ({
      sessionExerciseId, loadEntryMeaning: "added_plates" as const,
    })));
    for (const [index, entry] of current.entries.entries()) {
      expect(previous[entry]).toMatchObject({ status: "available", sets: [{ weight: (index + 1) * 20 }] });
    }
    const capture = await captureUserSnapshot(database.db, owner, new Date("2026-01-12T14:00:00Z"), "test");
    expect(capture.schemaVersion).toBe("37");
    expect(() => validateSnapshotPayload(capture, owner)).not.toThrow();
    expect(capture.tables.session_equipment_snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ geometry_version: 2, geometry_snapshot: expect.objectContaining({
        targetEntryMeaning: "added_plates", startingResistance: null,
      }) }),
    ]));
    expect(() => upgradeSnapshotPayload({ ...capture, schemaVersion: "36" })).toThrow(/schema 37/);
    const wrongMeaning = await getPreviousComparableSets(database.db, owner, [{
      sessionExerciseId: current.entries[0], loadEntryMeaning: "total_system",
    }]);
    expect(wrongMeaning[current.entries[0]].status).not.toBe("available");
    // Reapplying the additive migration preserves saved meanings and immutable snapshots.
    const migration = await readFile("src/db/migrations/0086_added_plate_weight.sql", "utf8");
    await database.client.exec(migration);
    await database.client.exec(migration);
    expect((await captureUserSnapshot(database.db, owner, new Date("2026-01-12T14:00:00Z"), "test")).tables.completed_sets)
      .toEqual(capture.tables.completed_sets);
    const store = new MemorySnapshotObjectStore();
    const keyring = { currentVersion: "test", resolve: () => Buffer.alloc(32, 21) };
    const options = { store, keyring, appVersion: "shared-pulley-test" };
    const backup = await createDataSnapshot(database.db, owner, { name: "Synthetic pulley", reason: "manual" }, options);
    if (!backup.ok) throw new Error(backup.reason);
    const preview = await getSnapshotRestorePreview(database.db, owner, backup.snapshotId, "full", options);
    expect(await restoreDataSnapshot(database.db, owner, {
      snapshotId: backup.snapshotId, scope: "full", previewFingerprint: preview.fingerprint, confirmation: "RESTORE",
    }, options)).toMatchObject({ ok: true });
    const restored = await captureUserSnapshot(database.db, owner, new Date("2026-01-12T14:00:00Z"), "test");
    expect(restored.tables.completed_sets).toEqual(capture.tables.completed_sets);
    expect(restored.tables.session_equipment_snapshots).toEqual(capture.tables.session_equipment_snapshots);
    // Removing the physical capability affects future selection, never the performed evidence.
    await database.db.execute(sql`UPDATE equipment_items SET attrs = '{}'::jsonb WHERE id = ${machine}::uuid`);
    expect(await resolveSessionEquipmentAvailability(database.db, owner, current.entries[0]))
      .toMatchObject({ decisionState: "unavailable" });
    expect((await captureUserSnapshot(database.db, owner, new Date("2026-01-12T14:00:00Z"), "test")).tables.completed_sets)
      .toEqual(capture.tables.completed_sets);
  });
  it("keeps capability checks identical in availability and atomic SQL, including missing or malformed attributes", async () => {
    database = await createMigratedTestDatabase();
    for (const type of ["machine", "smith_machine", "cable", "barbell"]) {
      for (const attrs of [{}, { cablePulley: true }, { cablePulley: false }, { cablePulley: "true" }]) {
        for (const required of ["cable", "machine", "barbell"]) {
          const expected = equipmentItemProvidesType({ type, attrs }, required);
          const rows = resultRows<{ allowed: boolean }>(await database.db.execute(sql`
            SELECT ${equipmentItemProvidesTypeSql(sql`${type}`, sql`${JSON.stringify(attrs)}::jsonb`, sql`${required}`)} AS allowed
          `));
          expect(rows[0].allowed).toBe(expected);
        }
      }
    }
  });

});
