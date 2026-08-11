import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  auditLogs,
  equipmentItems,
  exerciseEquipmentFitAssertions,
  exerciseEquipmentRequirements,
  exercises,
  recordVersions,
  userProfiles,
  users,
} from "@/db/schema";
import {
  loadExerciseEquipmentFitManagementDocument,
  removeExerciseEquipmentFitAssertion,
  saveExerciseEquipmentFitAssertion,
} from "@/services/exercise-equipment-fit-management";
import {
  loadEquipmentInventoryDocument,
  previewInventoryDocumentChanges,
} from "@/services/equipment-inventory";

describe("owner exercise-equipment fit management", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let otherUserId: string;
  let exerciseId: string;
  let customExerciseId: string;
  let firstCableId: string;
  let secondCableId: string;
  let otherCableId: string;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `fit-owner-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    [{ id: otherUserId }] = await db
      .insert(users)
      .values({ email: `fit-other-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(userProfiles).values([{ userId }, { userId: otherUserId }]);

    [{ id: exerciseId }] = await db
      .insert(exercises)
      .values({
        name: `Cable Face Pull ${crypto.randomUUID()}`,
        movementPattern: "horizontal_pull",
        primaryMuscles: ["rear deltoids"],
        loadType: "external",
      })
      .returning({ id: exercises.id });
    [{ id: customExerciseId }] = await db
      .insert(exercises)
      .values({
        userId: otherUserId,
        name: `Other owner cable pull ${crypto.randomUUID()}`,
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "external",
      })
      .returning({ id: exercises.id });
    await db.insert(exerciseEquipmentRequirements).values([
      { exerciseId, equipmentType: "cable" },
      { exerciseId: customExerciseId, equipmentType: "cable" },
    ]);
    const cableRows = await db
      .insert(equipmentItems)
      .values([
        {
          userId,
          type: "cable",
          label: "Cable station",
          attrs: { notes: "No usable high pulley position" },
        },
        {
          userId,
          type: "cable",
          label: "Cable station",
          attrs: { notes: "Usable adjustable pulley" },
        },
        {
          userId: otherUserId,
          type: "cable",
          label: "Cable station",
          attrs: {},
        },
      ])
      .returning({ id: equipmentItems.id, userId: equipmentItems.userId });
    [firstCableId, secondCableId] = cableRows
      .filter((row) => row.userId === userId)
      .map((row) => row.id);
    otherCableId = cableRows.find((row) => row.userId === otherUserId)!.id;
  }, 60_000);

  afterEach(async () => {
    await client.close();
  });

  async function evidenceCounts() {
    const [assertions, versions, audits] = await Promise.all([
      db.select().from(exerciseEquipmentFitAssertions).where(
        eq(exerciseEquipmentFitAssertions.userId, userId),
      ),
      db.select().from(recordVersions).where(eq(recordVersions.userId, userId)),
      db.select().from(auditLogs).where(eq(auditLogs.userId, userId)),
    ]);
    return {
      assertions: assertions.length,
      versions: versions.length,
      audits: audits.length,
    };
  }

  it("keeps colliding display names separate and refuses malformed or cross-owner identities", async () => {
    const document = await loadExerciseEquipmentFitManagementDocument(db, userId);
    expect(document.equipmentOptions.filter((item) => item.label === "Cable station"))
      .toHaveLength(2);
    expect(new Set(document.equipmentOptions.map((item) => item.id)).size).toBe(2);

    const malformed = await saveExerciseEquipmentFitAssertion(db, userId, {
      mutationId: "not-a-uuid",
      assertionId: null,
      exerciseId,
      equipmentItemId: firstCableId,
      verdict: "compatible",
      reasonCode: "missing_capability",
      reasonNote: null,
      expectedRevision: null,
    });
    expect(malformed).toMatchObject({ ok: false, code: "invalid" });

    const foreignItem = await saveExerciseEquipmentFitAssertion(db, userId, {
      mutationId: crypto.randomUUID(),
      assertionId: null,
      exerciseId,
      equipmentItemId: otherCableId,
      verdict: "incompatible",
      reasonCode: "missing_capability",
      reasonNote: "No usable pulley position",
      expectedRevision: null,
    });
    expect(foreignItem).toMatchObject({ ok: false, code: "stale" });

    const foreignExercise = await saveExerciseEquipmentFitAssertion(db, userId, {
      mutationId: crypto.randomUUID(),
      assertionId: null,
      exerciseId: customExerciseId,
      equipmentItemId: firstCableId,
      verdict: "incompatible",
      reasonCode: "missing_capability",
      reasonNote: "No usable pulley position",
      expectedRevision: null,
    });
    expect(foreignExercise).toMatchObject({ ok: false, code: "stale" });
    expect(await evidenceCounts()).toEqual({ assertions: 0, versions: 0, audits: 0 });
  }, 60_000);

  it("versions create, change, and remove while every successful mutation identity is retry-safe", async () => {
    const mutationId = crypto.randomUUID();
    const createInput = {
      mutationId,
      assertionId: null,
      exerciseId,
      equipmentItemId: firstCableId,
      verdict: "incompatible" as const,
      reasonCode: "missing_capability" as const,
      reasonNote: "No usable pulley position",
      expectedRevision: null,
    };
    const created = await saveExerciseEquipmentFitAssertion(db, userId, createInput);
    expect(created).toMatchObject({ ok: true, changed: true, revision: 1 });
    if (!created.ok) throw new Error(created.reason);
    expect(await evidenceCounts()).toEqual({ assertions: 1, versions: 1, audits: 1 });

    const replayed = await saveExerciseEquipmentFitAssertion(db, userId, createInput);
    expect(replayed).toEqual({ ...created, changed: false });
    expect(await evidenceCounts()).toEqual({ assertions: 1, versions: 1, audits: 1 });

    const reusedKey = await saveExerciseEquipmentFitAssertion(db, userId, {
      ...createInput,
      verdict: "compatible",
      reasonCode: "owner_verified",
    });
    expect(reusedKey).toMatchObject({ ok: false, code: "idempotency_conflict" });

    const noOpMutationId = crypto.randomUUID();
    const noOpInput = {
      ...createInput,
      mutationId: noOpMutationId,
      assertionId: created.assertionId,
      expectedRevision: 1,
    };
    const noOp = await saveExerciseEquipmentFitAssertion(db, userId, noOpInput);
    expect(noOp).toMatchObject({ ok: true, changed: false, revision: 1 });
    expect(await evidenceCounts()).toEqual({ assertions: 1, versions: 1, audits: 2 });

    const noOpReplay = await saveExerciseEquipmentFitAssertion(db, userId, noOpInput);
    expect(noOpReplay).toEqual(noOp);
    expect(await evidenceCounts()).toEqual({ assertions: 1, versions: 1, audits: 2 });

    const noOpKeyReusedForChange = await saveExerciseEquipmentFitAssertion(db, userId, {
      ...noOpInput,
      verdict: "compatible",
      reasonCode: "owner_verified",
      reasonNote: "Owner tested the adjustable setup",
    });
    expect(noOpKeyReusedForChange).toMatchObject({
      ok: false,
      code: "idempotency_conflict",
    });
    expect(await evidenceCounts()).toEqual({ assertions: 1, versions: 1, audits: 2 });

    const changed = await saveExerciseEquipmentFitAssertion(db, userId, {
      ...createInput,
      mutationId: crypto.randomUUID(),
      assertionId: created.assertionId,
      verdict: "compatible",
      reasonCode: "owner_verified",
      reasonNote: "Owner tested the adjustable setup",
      expectedRevision: 1,
    });
    expect(changed).toMatchObject({ ok: true, changed: true, revision: 2 });
    expect(await evidenceCounts()).toEqual({ assertions: 1, versions: 2, audits: 3 });

    const stale = await saveExerciseEquipmentFitAssertion(db, userId, {
      ...createInput,
      mutationId: crypto.randomUUID(),
      assertionId: created.assertionId,
      expectedRevision: 1,
    });
    expect(stale).toMatchObject({ ok: false, code: "stale" });
    expect(await evidenceCounts()).toEqual({ assertions: 1, versions: 2, audits: 3 });

    const removeMutationId = crypto.randomUUID();
    const removed = await removeExerciseEquipmentFitAssertion(db, userId, {
      mutationId: removeMutationId,
      assertionId: created.assertionId,
      expectedRevision: 2,
    });
    expect(removed).toMatchObject({ ok: true, changed: true, revision: null });
    expect(await evidenceCounts()).toEqual({ assertions: 0, versions: 3, audits: 4 });

    const removeReplay = await removeExerciseEquipmentFitAssertion(db, userId, {
      mutationId: removeMutationId,
      assertionId: created.assertionId,
      expectedRevision: 2,
    });
    expect(removeReplay).toEqual({ ...removed, changed: false });
    expect(await evidenceCounts()).toEqual({ assertions: 0, versions: 3, audits: 4 });
  }, 60_000);

  it("serializes competing changes and preserves the unrelated same-name item", async () => {
    const created = await saveExerciseEquipmentFitAssertion(db, userId, {
      mutationId: crypto.randomUUID(),
      assertionId: null,
      exerciseId,
      equipmentItemId: firstCableId,
      verdict: "incompatible",
      reasonCode: "missing_capability",
      reasonNote: "No usable pulley position",
      expectedRevision: null,
    });
    if (!created.ok) throw new Error(created.reason);

    const [left, right] = await Promise.all([
      saveExerciseEquipmentFitAssertion(db, userId, {
        mutationId: crypto.randomUUID(),
        assertionId: created.assertionId,
        exerciseId,
        equipmentItemId: firstCableId,
        verdict: "compatible",
        reasonCode: "owner_verified",
        reasonNote: "Configuration A works",
        expectedRevision: 1,
      }),
      saveExerciseEquipmentFitAssertion(db, userId, {
        mutationId: crypto.randomUUID(),
        assertionId: created.assertionId,
        exerciseId,
        equipmentItemId: firstCableId,
        verdict: "incompatible",
        reasonCode: "geometry_limit",
        reasonNote: "Configuration B does not work",
        expectedRevision: 1,
      }),
    ]);
    expect([left, right].filter((result) => result.ok && result.changed)).toHaveLength(1);
    expect([left, right].filter((result) => !result.ok && result.code === "stale"))
      .toHaveLength(1);

    const rows = await db.select().from(exerciseEquipmentFitAssertions);
    expect(rows).toHaveLength(1);
    expect(rows[0].equipmentItemId).toBe(firstCableId);
    expect(rows[0].equipmentItemId).not.toBe(secondCableId);
    expect(rows[0].revision).toBe(2);
    expect(await evidenceCounts()).toEqual({ assertions: 1, versions: 2, audits: 2 });
  }, 60_000);

  it("stales only the exact pair when its capability evidence changes and refreshes by review", async () => {
    const createInput = {
      mutationId: crypto.randomUUID(),
      assertionId: null,
      exerciseId,
      equipmentItemId: firstCableId,
      verdict: "incompatible" as const,
      reasonCode: "missing_capability" as const,
      reasonNote: "No usable pulley position",
      expectedRevision: null,
    };
    const created = await saveExerciseEquipmentFitAssertion(db, userId, createInput);
    if (!created.ok) throw new Error(created.reason);

    let document = await loadExerciseEquipmentFitManagementDocument(db, userId);
    expect(document.assertions[0].evidenceCurrent).toBe(true);

    await db
      .update(equipmentItems)
      .set({ attrs: { notes: "Unrelated station changed" } })
      .where(eq(equipmentItems.id, secondCableId));
    document = await loadExerciseEquipmentFitManagementDocument(db, userId);
    expect(document.assertions[0].evidenceCurrent).toBe(true);

    await db
      .update(equipmentItems)
      .set({ label: "Renamed cable station" })
      .where(eq(equipmentItems.id, firstCableId));
    document = await loadExerciseEquipmentFitManagementDocument(db, userId);
    expect(document.assertions[0].evidenceCurrent).toBe(true);

    await db
      .update(equipmentItems)
      .set({ attrs: { notes: "Pulley geometry was reconfigured" } })
      .where(eq(equipmentItems.id, firstCableId));
    document = await loadExerciseEquipmentFitManagementDocument(db, userId);
    expect(document.assertions[0].evidenceCurrent).toBe(false);

    const refreshed = await saveExerciseEquipmentFitAssertion(db, userId, {
      ...createInput,
      mutationId: crypto.randomUUID(),
      assertionId: created.assertionId,
      expectedRevision: 1,
    });
    expect(refreshed).toMatchObject({ ok: true, changed: true, revision: 2 });
    document = await loadExerciseEquipmentFitManagementDocument(db, userId);
    expect(document.assertions[0].evidenceCurrent).toBe(true);
    expect(await evidenceCounts()).toEqual({ assertions: 1, versions: 2, audits: 2 });
  }, 60_000);

  it("warns before an inventory save makes a retained exact-pair review stale", async () => {
    const created = await saveExerciseEquipmentFitAssertion(db, userId, {
      mutationId: crypto.randomUUID(),
      assertionId: null,
      exerciseId,
      equipmentItemId: firstCableId,
      verdict: "compatible",
      reasonCode: "owner_verified",
      reasonNote: "Owner verified the current pulley configuration.",
      expectedRevision: null,
    });
    if (!created.ok) throw new Error(created.reason);
    const loaded = await loadEquipmentInventoryDocument(db, userId);
    if (!loaded) throw new Error("Expected owner inventory.");

    const labelOnly = await previewInventoryDocumentChanges(db, userId, {
      ...loaded.document,
      items: loaded.document.items.map((item) =>
        item.id === firstCableId ? { ...item, label: "Renamed station" } : item,
      ),
    });
    expect(labelOnly.ok).toBe(true);
    if (!labelOnly.ok) return;
    expect(labelOnly.preview.impact.fitReviewsRequiringReview).toEqual([]);

    const capabilityChange = await previewInventoryDocumentChanges(db, userId, {
      ...loaded.document,
      items: loaded.document.items.map((item) =>
        item.id === firstCableId
          ? { ...item, attrs: { ...item.attrs, maxWeight: 175 } }
          : item,
      ),
    });
    expect(capabilityChange.ok).toBe(true);
    if (!capabilityChange.ok) return;
    expect(capabilityChange.preview.impact.fitReviewsRequiringReview).toEqual([
      {
        assertionId: created.assertionId,
        exerciseName: expect.stringContaining("Cable Face Pull"),
        equipmentLabel: "Cable station",
      },
    ]);
    expect(capabilityChange.preview.requiresConfirmation).toBe(true);
  }, 60_000);
});
