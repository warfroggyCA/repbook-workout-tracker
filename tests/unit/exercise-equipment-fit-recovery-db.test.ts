import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  equipmentItems,
  exerciseEquipmentFitAssertions,
  exercises,
  userProfiles,
  users,
} from "@/db/schema";
import { buildJsonBackup } from "@/services/export";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import {
  captureUserSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
} from "@/services/snapshot-capture";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
  upgradeSnapshotPayload,
  validateSnapshotPayload,
} from "@/services/snapshot-restore";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import {
  createDataSnapshot,
  type SnapshotKeyring,
} from "@/services/snapshots";
import {
  createMigratedTestDatabase,
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

describe("exercise-equipment fit recovery lifecycle", () => {
  let database: TestDatabase;
  let userId: string;
  let exerciseId: string;
  let equipmentItemId: string;
  let assertionId: string;
  let store: MemorySnapshotObjectStore;
  const key = Buffer.alloc(32, 41);
  const keyring: SnapshotKeyring = {
    currentVersion: "v1",
    resolve(version) {
      if (version !== "v1") throw new Error("Unknown test key.");
      return key;
    },
  };

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    store = new MemorySnapshotObjectStore();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `fit-recovery-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId });
    [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: `Recovery face pull ${crypto.randomUUID()}`,
        movementPattern: "horizontal_pull",
        primaryMuscles: ["rear deltoids"],
        loadType: "external",
      })
      .returning({ id: exercises.id });
    [{ id: equipmentItemId }] = await database.db
      .insert(equipmentItems)
      .values({ userId, type: "cable", label: "Synthetic cable station" })
      .returning({ id: equipmentItems.id });
    [{ id: assertionId }] = await database.db
      .insert(exerciseEquipmentFitAssertions)
      .values({
        userId,
        exerciseId,
        equipmentItemId,
        verdict: "incompatible",
        reasonCode: "geometry_limit",
        reasonNote: "No usable pulley position",
        evidenceRevision: "a".repeat(32),
        reviewedAt: new Date("2026-08-11T14:00:00.000Z"),
        updatedAt: new Date("2026-08-11T14:00:00.000Z"),
        createdAt: new Date("2026-08-11T14:00:00.000Z"),
      })
      .returning({ id: exerciseEquipmentFitAssertions.id });
  }, 60_000);

  afterEach(async () => database.close());

  it("adds an empty relation without inferring a backfill from existing names or categories", async () => {
    const previous = await createTestDatabaseAtMigration(
      "0080_session_equipment_requirements_snapshot",
    );
    try {
      const legacyUserId = crypto.randomUUID();
      const legacyExerciseId = crypto.randomUUID();
      const legacyItemId = crypto.randomUUID();
      await previous.client.query(
        `INSERT INTO users (id, email) VALUES ($1, $2)`,
        [legacyUserId, `legacy-fit-${crypto.randomUUID()}@example.com`],
      );
      await previous.client.query(
        `INSERT INTO exercises (
           id, name, movement_pattern, primary_muscles, load_type,
           metric_type, load_semantics, variant_attributes
         ) VALUES ($1, 'Face pull', 'horizontal_pull', '["rear deltoids"]',
           'external', 'weight_reps', 'total', '{}')`,
        [legacyExerciseId],
      );
      await previous.client.query(
        `INSERT INTO equipment_items (id, user_id, type, label)
         VALUES ($1, $2, 'cable', 'Cable station')`,
        [legacyItemId, legacyUserId],
      );

      await migrateTestDatabaseThrough(
        previous,
        "0081_exercise_equipment_fit_assertions",
      );
      const result = await previous.client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM exercise_equipment_fit_assertions`,
      );
      expect(result.rows).toEqual([{ count: 0 }]);
    } finally {
      await previous.close();
    }
  }, 60_000);

  it("enforces exact owner identities, closed meaning, unique pairs, and immutable identity", async () => {
    const [otherUser] = await database.db
      .insert(users)
      .values({ email: `fit-other-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId: otherUser.id });
    const [otherItem] = await database.db
      .insert(equipmentItems)
      .values({
        userId: otherUser.id,
        type: "cable",
        label: "Other owner's cable station",
      })
      .returning({ id: equipmentItems.id });
    const [foreignCustomExercise, ownedCustomExercise] = await database.db
      .insert(exercises)
      .values([
        {
          userId: otherUser.id,
          name: `Other custom pull ${crypto.randomUUID()}`,
          movementPattern: "horizontal_pull",
          primaryMuscles: ["back"],
          loadType: "external",
        },
        {
          userId,
          name: `Owned custom pull ${crypto.randomUUID()}`,
          movementPattern: "horizontal_pull",
          primaryMuscles: ["back"],
          loadType: "external",
        },
      ])
      .returning({ id: exercises.id, userId: exercises.userId });

    await expect(database.db.insert(exerciseEquipmentFitAssertions).values({
      userId,
      exerciseId,
      equipmentItemId: otherItem.id,
      verdict: "incompatible",
      reasonCode: "geometry_limit",
      reasonNote: null,
      evidenceRevision: "b".repeat(32),
    })).rejects.toThrow();
    await expect(database.db.insert(exerciseEquipmentFitAssertions).values({
      userId,
      exerciseId: foreignCustomExercise.id,
      equipmentItemId,
      verdict: "incompatible",
      reasonCode: "geometry_limit",
      reasonNote: null,
      evidenceRevision: "b".repeat(32),
    })).rejects.toThrow();
    await expect(database.db.insert(exerciseEquipmentFitAssertions).values({
      userId,
      exerciseId: ownedCustomExercise.id,
      equipmentItemId,
      verdict: "compatible",
      reasonCode: "owner_verified",
      reasonNote: null,
      evidenceRevision: "not-a-revision",
    })).rejects.toThrow();
    await expect(database.db.insert(exerciseEquipmentFitAssertions).values({
      userId,
      exerciseId: ownedCustomExercise.id,
      equipmentItemId,
      verdict: "incompatible",
      reasonCode: "owner_verified",
      reasonNote: null,
      evidenceRevision: "b".repeat(32),
    })).rejects.toThrow();
    await expect(database.db.insert(exerciseEquipmentFitAssertions).values({
      userId,
      exerciseId: ownedCustomExercise.id,
      equipmentItemId,
      verdict: "incompatible",
      reasonCode: "other",
      reasonNote: null,
      evidenceRevision: "b".repeat(32),
    })).rejects.toThrow();

    const [ownedCustomAssertion] = await database.db
      .insert(exerciseEquipmentFitAssertions)
      .values({
        userId,
        exerciseId: ownedCustomExercise.id,
        equipmentItemId,
        verdict: "compatible",
        reasonCode: "owner_verified",
        reasonNote: null,
        evidenceRevision: "b".repeat(32),
      })
      .returning({ id: exerciseEquipmentFitAssertions.id });
    await expect(database.db.insert(exerciseEquipmentFitAssertions).values({
      userId,
      exerciseId: ownedCustomExercise.id,
      equipmentItemId,
      verdict: "compatible",
      reasonCode: "owner_verified",
      reasonNote: null,
      evidenceRevision: "b".repeat(32),
    })).rejects.toThrow();
    await expect(database.db
      .update(exerciseEquipmentFitAssertions)
      .set({ exerciseId })
      .where(eq(exerciseEquipmentFitAssertions.id, ownedCustomAssertion.id)))
      .rejects.toThrow();
  });

  it("captures, validates, exports, upgrades, and atomically restores exact owner truth", async () => {
    const captured = await captureUserSnapshot(
      database.db,
      userId,
      new Date("2026-08-11T15:00:00.000Z"),
      "fit-recovery",
    );
    expect(captured.schemaVersion).toBe("33");
    expect(captured.tables.exercise_equipment_fit_assertions).toEqual([
      expect.objectContaining({
        id: assertionId,
        exercise_id: exerciseId,
        equipment_item_id: equipmentItemId,
        verdict: "incompatible",
        reason_code: "geometry_limit",
        evidence_revision: "a".repeat(32),
        revision: 1,
      }),
    ]);
    expect(() => validateSnapshotPayload(captured, userId)).not.toThrow();

    const backup = await buildJsonBackup(database.db, userId, undefined, {
      now: new Date("2026-08-11T15:01:00.000Z"),
      appVersion: "fit-recovery",
    });
    expect(backup.schemaVersion).toBe("33");
    expect(backup.canonical.tables.exercise_equipment_fit_assertions)
      .toHaveLength(1);

    const schema32 = structuredClone(captured);
    schema32.schemaVersion = "32";
    delete schema32.tables.exercise_equipment_fit_assertions;
    const upgraded = upgradeSnapshotPayload(schema32);
    expect(upgraded.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(upgraded.tables.exercise_equipment_fit_assertions).toEqual([]);

    const crossedOwner = structuredClone(captured);
    const row = crossedOwner.tables.exercise_equipment_fit_assertions[0] as
      Record<string, unknown>;
    row.user_id = crypto.randomUUID();
    expect(() => validateSnapshotPayload(crossedOwner, userId)).toThrow(
      /another user's record|fit assertion is invalid/i,
    );

    const created = await createDataSnapshot(
      database.db,
      userId,
      { name: "Fit source", reason: "manual", pinned: true },
      { store, keyring, appVersion: "fit-recovery" },
    );
    if (!created.ok) throw new Error(created.reason);

    await database.db
      .update(exerciseEquipmentFitAssertions)
      .set({
        verdict: "compatible",
        reasonCode: "owner_verified",
        reasonNote: "Temporary changed state",
        revision: 2,
        reviewedAt: new Date("2026-08-11T16:00:00.000Z"),
        updatedAt: new Date("2026-08-11T16:00:00.000Z"),
      })
      .where(eq(exerciseEquipmentFitAssertions.id, assertionId));

    const preview = await getSnapshotRestorePreview(
      database.db,
      userId,
      created.snapshotId,
      "full",
      { store, keyring },
    );
    expect(preview.tables.find(
      (table) => table.table === "exercise_equipment_fit_assertions",
    )).toMatchObject({ updated: 1 });

    const failed = await restoreDataSnapshot(
      database.db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      {
        store,
        keyring,
        appVersion: "fit-recovery",
        failAfterTable: "exercise_equipment_fit_assertions",
      },
    );
    expect(failed).toMatchObject({ ok: false });
    expect(await database.db.query.exerciseEquipmentFitAssertions.findFirst())
      .toMatchObject({ verdict: "compatible", revision: 2 });

    const currentPreview = await getSnapshotRestorePreview(
      database.db,
      userId,
      created.snapshotId,
      "full",
      { store, keyring },
    );
    const restored = await restoreDataSnapshot(
      database.db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: currentPreview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "fit-recovery" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "full" });
    expect(await database.db.query.exerciseEquipmentFitAssertions.findFirst())
      .toMatchObject({
        id: assertionId,
        verdict: "incompatible",
        reasonCode: "geometry_limit",
        revision: 1,
      });
  }, 90_000);

  it("restores an empty target by deleting prospective assertions and preserves history scope", async () => {
    await database.db.delete(exerciseEquipmentFitAssertions);
    const empty = await createDataSnapshot(
      database.db,
      userId,
      { name: "No retained fit assertions", reason: "manual" },
      { store, keyring, appVersion: "fit-empty" },
    );
    if (!empty.ok) throw new Error(empty.reason);

    await database.db.insert(exerciseEquipmentFitAssertions).values({
      id: assertionId,
      userId,
      exerciseId,
      equipmentItemId,
      verdict: "compatible",
      reasonCode: "owner_verified",
      reasonNote: null,
      evidenceRevision: "b".repeat(32),
    });

    const historyPreview = await getSnapshotRestorePreview(
      database.db,
      userId,
      empty.snapshotId,
      "history",
      { store, keyring },
    );
    const history = await restoreDataSnapshot(
      database.db,
      userId,
      {
        snapshotId: empty.snapshotId,
        scope: "history",
        previewFingerprint: historyPreview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "fit-empty" },
    );
    expect(history).toMatchObject({ ok: true, scope: "history" });
    expect(await database.db.query.exerciseEquipmentFitAssertions.findMany())
      .toHaveLength(1);

    const fullPreview = await getSnapshotRestorePreview(
      database.db,
      userId,
      empty.snapshotId,
      "full",
      { store, keyring },
    );
    const full = await restoreDataSnapshot(
      database.db,
      userId,
      {
        snapshotId: empty.snapshotId,
        scope: "full",
        previewFingerprint: fullPreview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "fit-empty" },
    );
    expect(full).toMatchObject({ ok: true, scope: "full" });
    expect(await database.db.query.exerciseEquipmentFitAssertions.findMany())
      .toEqual([]);
  }, 90_000);

  it("keeps recovery diagnostics bounded while surfacing invalid retained meaning", async () => {
    expect(await evaluateApplicationIntegrity(database.db, userId)).toEqual([]);
    await database.client.exec(`
      ALTER TABLE exercise_equipment_fit_assertions
        DROP CONSTRAINT exercise_equipment_fit_assertions_state_check;
    `);
    await database.client.query(
      `UPDATE exercise_equipment_fit_assertions
       SET reason_code = 'owner_verified'
       WHERE id = $1`,
      [assertionId],
    );
    expect(await evaluateApplicationIntegrity(database.db, userId)).toEqual([
      expect.objectContaining({
        checkKey: "exercise_equipment_fit_assertion.integrity",
        severity: "error",
        entityId: assertionId,
        details: {
          verdict: "incompatible",
          reasonCode: "owner_verified",
          provenance: "owner_review",
          semanticsVersion: 1,
          evidenceRevisionValid: true,
          revision: 1,
        },
      }),
    ]);
  });
});
