import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  archiveOperationRecords,
  archiveOperations,
  completedSets,
  dataSnapshots,
  exercisePrescriptions,
  exercises,
  programDrafts,
  programVersions,
  programs,
  recommendations,
  sessionExercises,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import {
  buildJsonBackup,
  validateUserHeldJsonBackup,
} from "@/services/export";
import { archiveWorkoutRecord } from "@/services/archive";
import {
  canonicalJson,
  encryptSnapshotBytes,
  sha256Hex,
  SNAPSHOT_ENCRYPTION_ALGORITHM,
} from "@/services/snapshot-crypto";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import {
  captureUserSnapshot,
  snapshotRecordCounts,
} from "@/services/snapshot-capture";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
} from "@/services/snapshot-restore";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import {
  getOrCreateProgramDraft,
  reviewProgramDraft,
  saveProgramDraft,
} from "@/services/program-drafts";
import { publishProgramDraft } from "@/services/program-publication";
import {
  hashProgramDocument,
} from "@/services/program-document-hash";
import {
  legacyProgramDocumentSchema,
  storedProgramDocumentSchema,
  suggestProgramIntentDraft,
  upgradeStoredProgramDocumentToV3,
} from "@/lib/program-document";
import {
  createDataSnapshot,
  type SnapshotKeyring,
} from "@/services/snapshots";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("canonical user-held JSON backup", () => {
  let database: TestDatabase;
  let userId: string;
  let exerciseId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({
        email: `json-backup-${crypto.randomUUID()}@example.com`,
        name: "Before backup",
      })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({
      userId,
      unit: "kg",
      timezone: "America/Vancouver",
    });
    [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        userId,
        name: `Backup squat ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: {},
      })
      .returning({ id: exercises.id });
  }, 30_000);

  afterEach(async () => database.close());

  async function createWorkout(localDate: string, label: string) {
    const sessionId = crypto.randomUUID();
    const sessionExerciseId = crypto.randomUUID();
    const setId = crypto.randomUUID();
    const startedAt = new Date(`${localDate}T18:00:00.000Z`);
    await database.db.insert(workoutSessions).values({
      id: sessionId,
      userId,
      templateName: label,
      status: "completed",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 45 * 60_000),
      timezone: "America/Vancouver",
      localDate,
    });
    await database.db.insert(sessionExercises).values({
      id: sessionExerciseId,
      sessionId,
      exerciseId,
      orderIdx: 0,
      targetLoad: 100,
      targetLoadUnit: "kg",
      targetSets: 1,
      targetRepsMin: 8,
      targetRepsMax: 8,
    });
    await database.db.insert(completedSets).values({
      id: setId,
      sessionExerciseId,
      setNo: 1,
      weight: 100,
      weightUnit: "kg",
      reps: 8,
    });
    return { sessionId, sessionExerciseId, setId };
  }

  async function createDraftFixture() {
    const programId = crypto.randomUUID();
    const sourceVersionId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const sourceTemplateId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const sourceSlotId = crypto.randomUUID();
    const slotId = crypto.randomUUID();
    const dayLineageId = crypto.randomUUID();
    const slotLineageId = crypto.randomUUID();
    const recommendationId = crypto.randomUUID();
    const document = suggestProgramIntentDraft(legacyProgramDocumentSchema.parse({
      schemaVersion: "1",
      programId,
      baseVersionId: versionId,
      name: "Backup Program",
      days: [
        {
          lineageId: dayLineageId,
          name: "Day A",
          notes: null,
          supersets: [],
          exercises: [
            {
              lineageId: slotLineageId,
              exerciseId,
              sets: 3,
              repMin: 6,
              repMax: 8,
              targetLoad: 80,
              targetLoadUnit: "kg",
              progressionRuleId: "double_progression",
              restSec: 120,
              supersetKey: null,
              notes: null,
              warmupNotes: null,
              warmupSets: [],
              setNotes: [null, null, null],
            },
          ],
        },
      ],
    }));
    await database.db.transaction(async (tx) => {
      await tx.insert(programs).values({
        id: programId,
        userId,
        name: document.name,
        status: "active",
        currentVersionId: versionId,
      });
      await tx.insert(programVersions).values([
        {
          id: sourceVersionId,
          programId,
          versionNo: 1,
          name: "Original Program",
          publicationSource: "setup",
        },
        {
          id: versionId,
          programId,
          versionNo: 2,
          name: document.name,
          parentVersionId: sourceVersionId,
          publicationSource: "editor",
        },
      ]);
      await tx.insert(workoutTemplates).values([
        {
          id: sourceTemplateId,
          programVersionId: sourceVersionId,
          lineageId: dayLineageId,
          name: "Day A",
          orderIdx: 0,
        },
        {
          id: templateId,
          programVersionId: versionId,
          lineageId: dayLineageId,
          name: "Day A",
          orderIdx: 0,
        },
      ]);
      await tx.insert(workoutTemplateExercises).values([
        {
          id: sourceSlotId,
          workoutTemplateId: sourceTemplateId,
          exerciseId,
          lineageId: slotLineageId,
          orderIdx: 0,
          restSec: 120,
          warmupSets: [],
          setNotes: [null, null, null],
        },
        {
          id: slotId,
          workoutTemplateId: templateId,
          exerciseId,
          lineageId: slotLineageId,
          orderIdx: 0,
          restSec: 120,
          warmupSets: [],
          setNotes: [null, null, null],
        },
      ]);
      await tx.insert(exercisePrescriptions).values([
        {
          templateExerciseId: sourceSlotId,
          sets: 3,
          repRangeMin: 6,
          repRangeMax: 8,
          targetLoad: 75,
          targetLoadUnit: "kg",
        },
        {
          templateExerciseId: slotId,
          sets: 3,
          repRangeMin: 6,
          repRangeMax: 8,
          targetLoad: 80,
          targetLoadUnit: "kg",
        },
      ]);
      await tx.insert(programDrafts).values({
        userId,
        programId,
        baseVersionId: versionId,
        restoredFromVersionId: sourceVersionId,
        revision: 1,
        document,
        contentHash: hashProgramDocument(document),
        lastMutationId: crypto.randomUUID(),
      });
      await tx.insert(recommendations).values({
        id: recommendationId,
        userId,
        source: "rule",
        status: "expired",
        sourceTemplateExerciseId: sourceSlotId,
        sourceSlotLineageId: slotLineageId,
        payload: {
          kind: "load_change",
          templateExerciseId: sourceSlotId,
          fromLoad: 75,
          toLoad: 80,
          loadUnit: "kg",
        },
        reason: "Historical progression suggestion",
        evidence: { signals: {} },
        reconciledAt: new Date("2026-07-13T15:00:00.000Z"),
        reconciliationReason: "Superseded by Program version 2.",
        reconciledByProgramVersionId: versionId,
      });
    });
    return {
      programId,
      sourceVersionId,
      versionId,
      sourceTemplateId,
      templateId,
      sourceSlotId,
      slotId,
      dayLineageId,
      slotLineageId,
      recommendationId,
      document,
    };
  }

  it("uses one canonical capture statement and validates its outer metadata", async () => {
    await createWorkout("2026-07-10", "One capture");
    const draft = await createDraftFixture();
    const execute = vi.spyOn(database.db, "execute");
    const backup = await buildJsonBackup(
      database.db,
      userId,
      undefined,
      {
        now: new Date("2026-07-13T16:00:00.000Z"),
        appVersion: "phase-6-test",
      }
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(validateUserHeldJsonBackup(JSON.parse(JSON.stringify(backup)), userId))
      .toMatchObject({
        schemaVersion: "27",
        exportedAt: "2026-07-13T16:00:00.000Z",
        appVersion: "phase-6-test",
      });
    expect(backup.canonical.tables.program_drafts).toEqual([
      expect.objectContaining({
        program_id: draft.programId,
        base_version_id: draft.versionId,
        restored_from_version_id: draft.sourceVersionId,
        document: draft.document,
        content_hash: hashProgramDocument(draft.document),
      }),
    ]);
    expect(backup.canonical.tables.program_versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: draft.sourceVersionId,
          version_no: 1,
          document_schema_version: 1,
          publication_preflight: null,
        }),
        expect.objectContaining({
          id: draft.versionId,
          version_no: 2,
          parent_version_id: draft.sourceVersionId,
          document_schema_version: 1,
          publication_preflight: null,
        }),
      ])
    );
    expect(backup.canonical.tables.workout_templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: draft.sourceTemplateId,
          lineage_id: draft.dayLineageId,
        }),
        expect.objectContaining({
          id: draft.templateId,
          lineage_id: draft.dayLineageId,
        }),
      ])
    );
    expect(backup.canonical.tables.recommendations).toEqual([
      expect.objectContaining({
        id: draft.recommendationId,
        status: "expired",
        source_slot_lineage_id: draft.slotLineageId,
        reconciled_by_program_version_id: draft.versionId,
        reconciliation_reason: "Superseded by Program version 2.",
      }),
    ]);

    const programWideDeload = structuredClone(backup);
    const [deloadRecommendation] = programWideDeload.canonical.tables
      .recommendations as Array<Record<string, unknown>>;
    deloadRecommendation.status = "pending";
    deloadRecommendation.source_template_exercise_id = null;
    deloadRecommendation.source_slot_lineage_id = null;
    deloadRecommendation.payload = {
      kind: "deload",
      scope: "program",
      volumeFactor: 0.6,
      loadFactor: 0.85,
      durationSessionsPerTemplate: 1,
    };
    deloadRecommendation.reconciled_at = null;
    deloadRecommendation.reconciliation_reason = null;
    deloadRecommendation.reconciled_by_program_version_id = null;
    expect(() =>
      validateUserHeldJsonBackup(programWideDeload, userId)
    ).not.toThrow();

    const wrongCount = structuredClone(backup);
    wrongCount.recordCounts.workout_sessions += 1;
    expect(() => validateUserHeldJsonBackup(wrongCount, userId)).toThrow(
      /record counts/
    );

    const missingRelationshipTable = structuredClone(backup);
    delete missingRelationshipTable.canonical.tables.session_exercises;
    expect(() =>
      validateUserHeldJsonBackup(missingRelationshipTable, userId)
    ).toThrow(/session_exercises/);

    const alteredDraft = structuredClone(backup);
    const [capturedDraft] = alteredDraft.canonical.tables.program_drafts as Array<
      Record<string, unknown>
    >;
    capturedDraft.content_hash = "tampered";
    expect(() => validateUserHeldJsonBackup(alteredDraft, userId)).toThrow(
      /draft document is invalid or mismatched/
    );

    const malformedNestedDraft = structuredClone(backup);
    const [nestedDraft] = malformedNestedDraft.canonical.tables.program_drafts as Array<{
      document: { days: Array<{ exercises: Array<{ sets: number }> }> };
    }>;
    nestedDraft.document.days[0].exercises[0].sets = 0;
    expect(() =>
      validateUserHeldJsonBackup(malformedNestedDraft, userId)
    ).toThrow(/draft document is invalid or mismatched/);

    const versionOnlyReconciliation = structuredClone(backup);
    const [reconciliation] = versionOnlyReconciliation.canonical.tables
      .recommendations as Array<Record<string, unknown>>;
    reconciliation.status = "approved";
    reconciliation.reconciled_at = null;
    reconciliation.reconciliation_reason = null;
    expect(() =>
      validateUserHeldJsonBackup(versionOnlyReconciliation, userId)
    ).toThrow(/reconciliation state is inconsistent/);

    const staleCurrentVersion = structuredClone(backup);
    const [capturedProgram] = staleCurrentVersion.canonical.tables.programs as Array<
      Record<string, unknown>
    >;
    capturedProgram.current_version_id = draft.sourceVersionId;
    expect(() => validateUserHeldJsonBackup(staleCurrentVersion, userId)).toThrow(
      /Program current version is not its newest version/
    );
  });

  it("cannot mix a later parent, child, or set into the already captured view", async () => {
    const sessionId = crypto.randomUUID();
    const sessionExerciseId = crypto.randomUUID();
    const setId = crypto.randomUUID();
    const backup = await buildJsonBackup(database.db, userId, async (boundary) => {
      if (boundary !== "backup-captured") return;
      await database.db.execute(sql`
        WITH changed_owner AS (
          UPDATE users
          SET name = 'After backup'
          WHERE id = ${userId}::uuid
          RETURNING id
        ), inserted_session AS (
          INSERT INTO workout_sessions (
            id, user_id, template_name, status, started_at, finished_at,
            timezone, local_date
          )
          SELECT
            ${sessionId}::uuid, changed_owner.id, 'Competing writer',
            'completed', '2026-07-13T18:00:00.000Z'::timestamptz,
            '2026-07-13T19:00:00.000Z'::timestamptz,
            'America/Vancouver', '2026-07-13'::date
          FROM changed_owner
          RETURNING id
        ), inserted_exercise AS (
          INSERT INTO session_exercises (
            id, session_id, exercise_id, order_idx,
            target_load, target_load_unit
          )
          SELECT
            ${sessionExerciseId}::uuid, inserted_session.id,
            ${exerciseId}::uuid, 0, 105, 'kg'
          FROM inserted_session
          RETURNING id
        )
        INSERT INTO completed_sets (
          id, session_exercise_id, set_no, weight, weight_unit, reps
        )
        SELECT ${setId}::uuid, inserted_exercise.id, 1, 105, 'kg', 8
        FROM inserted_exercise
      `);
    });

    expect(backup.canonical.tables.users[0]).toMatchObject({ name: "Before backup" });
    expect(backup.canonical.tables.workout_sessions).toHaveLength(0);
    expect(backup.canonical.tables.session_exercises).toHaveLength(0);
    expect(backup.canonical.tables.completed_sets).toHaveLength(0);
    expect(
      await database.db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
      })
    ).toBeDefined();
    expect(
      await database.db.query.completedSets.findFirst({
        where: eq(completedSets.id, setId),
      })
    ).toBeDefined();
  });

  it("restores the downloaded canonical data in an isolated database", async () => {
    const archivedWorkout = await createWorkout("2026-07-10", "Archived workout");
    const currentWorkout = await createWorkout("2026-07-11", "Current workout");
    const programFixture = await createDraftFixture();
    const archived = await archiveWorkoutRecord(
      database.db,
      userId,
      archivedWorkout.sessionId
    );
    if (!archived.ok) throw new Error(archived.reason);
    const backup = await buildJsonBackup(
      database.db,
      userId,
      undefined,
      {
        now: new Date("2026-07-13T16:30:00.000Z"),
        appVersion: "phase-6-restore-test",
      }
    );

    const target = await createMigratedTestDatabase();
    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 23);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown test key.");
        return key;
      },
    };
    try {
      await target.db.insert(users).values({
        id: userId,
        email: `restore-target-${crypto.randomUUID()}@example.com`,
      });
      const snapshotId = crypto.randomUUID();
      const objectPath = `snapshots/${userId}/${snapshotId}.wtbk`;
      const plaintext = Buffer.from(canonicalJson(backup.canonical), "utf8");
      const encrypted = encryptSnapshotBytes(
        plaintext,
        key,
        "v1",
        Buffer.alloc(12, 9)
      );
      const stored = await store.put(objectPath, encrypted);
      await target.db.insert(dataSnapshots).values({
        id: snapshotId,
        userId,
        name: "Downloaded JSON backup",
        reason: "restore_drill",
        status: "verified",
        objectPath,
        objectEtag: stored.etag,
        appVersion: backup.appVersion,
        schemaVersion: backup.schemaVersion,
        sizeBytes: encrypted.length,
        recordCounts: backup.recordCounts,
        plaintextChecksum: sha256Hex(plaintext),
        ciphertextChecksum: sha256Hex(encrypted),
        encryptionAlgorithm: SNAPSHOT_ENCRYPTION_ALGORITHM,
        encryptionKeyVersion: "v1",
        snapshotKind: "user",
        pinned: true,
        verifiedAt: new Date("2026-07-13T16:31:00.000Z"),
      });

      const preview = await getSnapshotRestorePreview(
        target.db,
        userId,
        snapshotId,
        "full",
        { store, keyring }
      );
      const restored = await restoreDataSnapshot(
        target.db,
        userId,
        {
          snapshotId,
          scope: "full",
          previewFingerprint: preview.fingerprint,
          confirmation: "RESTORE",
        },
        { store, keyring, appVersion: "phase-6-restore-target" }
      );
      expect(restored, restored.ok ? undefined : restored.reason).toMatchObject({
        ok: true,
        scope: "full",
      });

      expect(await target.db.select().from(workoutSessions)).toHaveLength(2);
      expect(await target.db.select().from(sessionExercises)).toHaveLength(2);
      expect(await target.db.select().from(completedSets)).toHaveLength(2);
      expect(
        await target.db.query.workoutSessions.findFirst({
          where: eq(workoutSessions.id, archivedWorkout.sessionId),
        })
      ).toMatchObject({
        archivedAt: expect.any(Date),
        archiveOperationId: archived.operationId,
        timezone: "America/Vancouver",
        localDate: "2026-07-10",
      });
      expect(
        await target.db.query.completedSets.findFirst({
          where: eq(completedSets.id, currentWorkout.setId),
        })
      ).toMatchObject({ weight: 100, weightUnit: "kg", reps: 8 });
      expect(await target.db.select().from(archiveOperations)).toHaveLength(1);
      expect(await target.db.select().from(archiveOperationRecords)).not.toHaveLength(0);
      expect(
        await target.db.query.programs.findFirst({
          where: eq(programs.id, programFixture.programId),
        })
      ).toMatchObject({
        status: "active",
        currentVersionId: programFixture.versionId,
      });
      expect(
        await target.db.query.programVersions.findMany({
          where: eq(programVersions.programId, programFixture.programId),
        })
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: programFixture.sourceVersionId,
            versionNo: 1,
          }),
          expect.objectContaining({
            id: programFixture.versionId,
            versionNo: 2,
            parentVersionId: programFixture.sourceVersionId,
          }),
        ])
      );
      const restoredDays = await target.db.query.workoutTemplates.findMany({
        where: (table, { inArray }) =>
          inArray(table.id, [
            programFixture.sourceTemplateId,
            programFixture.templateId,
          ]),
      });
      expect(restoredDays).toHaveLength(2);
      expect(new Set(restoredDays.map((day) => day.lineageId))).toEqual(
        new Set([programFixture.dayLineageId])
      );
      const restoredSlots = await target.db.query.workoutTemplateExercises.findMany({
        where: (table, { inArray }) =>
          inArray(table.id, [programFixture.sourceSlotId, programFixture.slotId]),
      });
      expect(restoredSlots).toHaveLength(2);
      expect(new Set(restoredSlots.map((slot) => slot.lineageId))).toEqual(
        new Set([programFixture.slotLineageId])
      );
      expect(
        await target.db.query.programDrafts.findFirst({
          where: eq(programDrafts.programId, programFixture.programId),
        })
      ).toMatchObject({
        status: "open",
        revision: 1,
        baseVersionId: programFixture.versionId,
        restoredFromVersionId: programFixture.sourceVersionId,
        document: programFixture.document,
        contentHash: hashProgramDocument(programFixture.document),
      });
      expect(
        await target.db.query.recommendations.findFirst({
          where: eq(recommendations.id, programFixture.recommendationId),
        })
      ).toMatchObject({
        status: "expired",
        sourceTemplateExerciseId: programFixture.sourceSlotId,
        sourceSlotLineageId: programFixture.slotLineageId,
        reconciliationReason: "Superseded by Program version 2.",
        reconciledByProgramVersionId: programFixture.versionId,
        reconciledAt: new Date("2026-07-13T15:00:00.000Z"),
      });
      expect(await evaluateApplicationIntegrity(target.db, userId)).toEqual([]);

      const restoredSnapshot = await captureUserSnapshot(
        target.db,
        userId,
        new Date("2026-07-13T17:00:00.000Z"),
        "phase-6-restored"
      );
      const restoredCounts = snapshotRecordCounts(restoredSnapshot);
      for (const table of [
        "user_profiles",
        "workout_sessions",
        "session_exercises",
        "completed_sets",
        "archive_operations",
        "archive_operation_records",
        "programs",
        "program_versions",
        "program_drafts",
        "workout_templates",
        "workout_template_exercises",
        "exercise_prescriptions",
        "recommendations",
      ]) {
        expect(restoredCounts[table]).toBe(backup.recordCounts[table]);
      }
    } finally {
      await target.close();
    }
  }, 30_000);

  it("restores history while preserving a newer Program version and its unsaved draft", async () => {
    const fixture = await createDraftFixture();
    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 29);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown test key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      userId,
      { name: "Program history restore source", reason: "test" },
      { store, keyring, appVersion: "program-history-test" }
    );
    if (!created.ok) throw new Error(created.reason);

    const sourceDraft = await database.db.query.programDrafts.findFirst({
      where: eq(programDrafts.programId, fixture.programId),
    });
    if (!sourceDraft) throw new Error("Program draft fixture is missing.");
    const publishedDocument = structuredClone(upgradeStoredProgramDocumentToV3(
      storedProgramDocumentSchema.parse(sourceDraft.document),
    ));
    publishedDocument.name = "Future Program version";
    publishedDocument.days[0].exercises[0].targetLoad = 90;
    const savedForPublication = await saveProgramDraft(database.db, userId, {
      draftId: sourceDraft.id,
      expectedRevision: sourceDraft.revision,
      mutationId: crypto.randomUUID(),
      document: publishedDocument,
    });
    if (savedForPublication.status !== "saved") {
      throw new Error("Program draft was not saved for publication.");
    }
    const review = await reviewProgramDraft(
      database.db,
      userId,
      sourceDraft.id,
      savedForPublication.revision
    );
    if (!review || review.status !== "publishable") {
      throw new Error("Program review did not complete.");
    }
    const published = await publishProgramDraft(database.db, userId, {
      draftId: sourceDraft.id,
      expectedRevision: savedForPublication.revision,
      reviewHash: review.hash,
    });
    if (!published.ok) throw new Error(published.reason);
    expect(published.versionNo).toBe(3);

    const futureDraftState = await getOrCreateProgramDraft(database.db, userId);
    if (!futureDraftState) throw new Error("Future Program draft was not created.");
    const futureDraftDocument = structuredClone(futureDraftState.draft.document);
    futureDraftDocument.name = "Unsaved future draft";
    futureDraftDocument.days[0].exercises[0].notes = "Keep this unsaved note";
    const savedFutureDraft = await saveProgramDraft(database.db, userId, {
      draftId: futureDraftState.draft.id,
      expectedRevision: futureDraftState.draft.revision,
      mutationId: crypto.randomUUID(),
      document: futureDraftDocument,
    });
    if (savedFutureDraft.status !== "saved") {
      throw new Error("Future Program draft was not saved.");
    }
    await database.db
      .update(recommendations)
      .set({ reconciliationReason: "Changed after the recovery point." })
      .where(eq(recommendations.id, fixture.recommendationId));

    const preview = await getSnapshotRestorePreview(
      database.db,
      userId,
      created.snapshotId,
      "history",
      { store, keyring }
    );
    expect(
      preview.tables.some(({ table }) =>
        ["programs", "program_versions", "program_drafts"].includes(table)
      )
    ).toBe(false);
    expect(
      preview.tables.find(({ table }) => table === "recommendations")
    ).toMatchObject({ updated: 1 });

    const restored = await restoreDataSnapshot(
      database.db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "program-history-test" }
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });

    expect(
      await database.db.query.programs.findFirst({
        where: eq(programs.id, fixture.programId),
      })
    ).toMatchObject({
      currentVersionId: published.programVersionId,
      name: "Future Program version",
    });
    expect(
      await database.db.query.programVersions.findMany({
        where: eq(programVersions.programId, fixture.programId),
      })
    ).toHaveLength(3);
    const publishedDay = await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, published.programVersionId),
    });
    expect(publishedDay).toMatchObject({ lineageId: fixture.dayLineageId });
    const publishedSlot = publishedDay
      ? await database.db.query.workoutTemplateExercises.findFirst({
          where: eq(workoutTemplateExercises.workoutTemplateId, publishedDay.id),
        })
      : null;
    expect(publishedSlot).toMatchObject({ lineageId: fixture.slotLineageId });
    expect(
      await database.db.query.programDrafts.findFirst({
        where: eq(programDrafts.id, futureDraftState.draft.id),
      })
    ).toMatchObject({
      status: "open",
      revision: savedFutureDraft.revision,
      baseVersionId: published.programVersionId,
      document: futureDraftDocument,
      contentHash: hashProgramDocument(futureDraftDocument),
    });
    expect(
      await database.db.query.recommendations.findFirst({
        where: eq(recommendations.id, fixture.recommendationId),
      })
    ).toMatchObject({
      status: "expired",
      sourceSlotLineageId: fixture.slotLineageId,
      reconciliationReason: "Superseded by Program version 2.",
      reconciledByProgramVersionId: fixture.versionId,
      reconciledAt: new Date("2026-07-13T15:00:00.000Z"),
    });
    expect(await evaluateApplicationIntegrity(database.db, userId)).toEqual([]);
  }, 30_000);
});
