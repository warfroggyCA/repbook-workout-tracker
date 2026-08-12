import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  archiveActivityRecord,
  archiveCompletedSetRecord,
  archiveImportBatchRecord,
  archiveWorkoutRecord,
  restoreArchiveOperation,
} from "@/services/archive";
import {
  authenticatePermanentDeleteGrant,
  createPermanentDeleteGrant,
  getPermanentDeletePreview,
  getValidPermanentDeleteGrant,
  permanentlyDeleteArchiveOperation,
  PERMANENT_DELETE_CONFIRMATION,
} from "@/services/permanent-delete";
import { createContextualNote } from "@/services/contextual-notes";

describe("Archive-only permanent deletion", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let exerciseId: string;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    [{ id: userId }] = await db
      .insert(schema.users)
      .values({ email: `permanent-delete-${crypto.randomUUID()}@example.com` })
      .returning({ id: schema.users.id });
    [{ id: exerciseId }] = await db
      .insert(schema.exercises)
      .values({
        userId,
        name: `Permanent delete exercise ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
      })
      .returning({ id: schema.exercises.id });
  });

  afterEach(async () => {
    await client.close();
  });

  async function verifiedSafetySnapshot(operationId: string) {
    const snapshotId = crypto.randomUUID();
    await db.insert(schema.dataSnapshots).values({
      id: snapshotId,
      userId,
      name: "Verified permanent-delete safety snapshot",
      reason: "pre_permanent_delete",
      sourceOperationId: operationId,
      status: "verified",
      objectPath: `snapshots/${userId}/${snapshotId}.wtbk`,
      appVersion: "test",
      schemaVersion: "7",
      sizeBytes: 1,
      recordCounts: {},
      plaintextChecksum: "test-plaintext",
      ciphertextChecksum: "test-ciphertext",
      encryptionAlgorithm: "aes-256-gcm",
      encryptionKeyVersion: "v1",
      snapshotKind: "automatic",
      verifiedAt: new Date(),
    });
    return snapshotId;
  }

  async function archivedActivity() {
    const [{ id }] = await db
      .insert(schema.healthActivities)
      .values({
        userId,
        activityType: "walk",
        title: "Archived walk",
        startedAt: new Date("2026-07-01T12:00:00.000Z"),
        timezone: "America/Toronto",
        durationSeconds: 1800,
        source: "manual",
        fingerprint: `permanent-delete-${crypto.randomUUID()}`,
      })
      .returning({ id: schema.healthActivities.id });
    const archived = await archiveActivityRecord(db, userId, id);
    if (!archived.ok) throw new Error(archived.reason);
    return { activityId: id, operationId: archived.operationId };
  }

  async function archivedWorkout(withCompilerProposal = false) {
    const compilerProposalId = withCompilerProposal ? crypto.randomUUID() : null;
    const compilerAcceptanceKey = withCompilerProposal ? crypto.randomUUID() : null;
    const compilerHash = withCompilerProposal ? "a".repeat(64) : null;
    let compilerSource: { programId: string; versionId: string; templateId: string } | null = null;
    if (withCompilerProposal) {
      compilerSource = await db.transaction(async (tx) => {
        const [{ id: programId }] = await tx.insert(schema.programs).values({ userId, name: "Compiler deletion source", status: "archived", archivedAt: new Date() }).returning({ id: schema.programs.id });
        const [{ id: versionId }] = await tx.insert(schema.programVersions).values({ programId, versionNo: 1, name: "Compiler deletion source", documentSchemaVersion: 2 }).returning({ id: schema.programVersions.id });
        const [{ id: templateId }] = await tx.insert(schema.workoutTemplates).values({ programVersionId: versionId, name: "Compiler deletion day" }).returning({ id: schema.workoutTemplates.id });
        return { programId, versionId, templateId };
      });
    }
    const [{ id: sessionId }] = await db
      .insert(schema.workoutSessions)
      .values({
        userId,
        templateName: "Permanent delete workout",
        status: "completed",
        startedAt: new Date("2026-07-02T12:00:00.000Z"),
        finishedAt: new Date("2026-07-02T13:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-02",
        source: withCompilerProposal ? "compiler" : "manual",
        compilationAcceptanceKey: compilerAcceptanceKey,
        compilationSnapshot: withCompilerProposal
          ? ({ proposalId: compilerProposalId, proposalHash: compilerHash } as unknown as NonNullable<typeof schema.workoutSessions.$inferInsert["compilationSnapshot"]>)
          : null,
      })
      .returning({ id: schema.workoutSessions.id });
    if (compilerSource && compilerProposalId && compilerAcceptanceKey && compilerHash) {
      await db.insert(schema.sessionCompilerProposals).values({
        id: compilerProposalId,
        userId,
        programId: compilerSource.programId,
        programVersionId: compilerSource.versionId,
        workoutTemplateId: compilerSource.templateId,
        algorithmVersion: "phase3-deterministic-v1",
        status: "accepted",
        inputSnapshot: {} as typeof schema.sessionCompilerProposals.$inferInsert["inputSnapshot"],
        outputSnapshot: {} as typeof schema.sessionCompilerProposals.$inferInsert["outputSnapshot"],
        preflightSnapshot: {} as typeof schema.sessionCompilerProposals.$inferInsert["preflightSnapshot"],
        contentHash: compilerHash,
        clientMutationId: crypto.randomUUID(),
        reviewedAt: new Date(),
        reviewHash: compilerHash,
        acceptedSessionId: sessionId,
        acceptanceKey: compilerAcceptanceKey,
        acceptedAt: new Date(),
      });
    }
    const sourceSlotLineageId = crypto.randomUUID();
    const [{ id: sessionExerciseId }] = await db
      .insert(schema.sessionExercises)
      .values({ sessionId, exerciseId, sourceSlotLineageId })
      .returning({ id: schema.sessionExercises.id });
    const [{ id: setId }] = await db
      .insert(schema.completedSets)
      .values({
        sessionExerciseId,
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 0,
      })
      .returning({ id: schema.completedSets.id });
    const [{ id: groupId }] = await db
      .insert(schema.sessionExerciseGroups)
      .values({
        sessionId,
        provenance: "legacy",
        name: "Permanent delete group",
        orderIdx: 0,
      })
      .returning({ id: schema.sessionExerciseGroups.id });
    const [{ id: occurrenceId }] = await db
      .insert(schema.sessionOccurrences)
      .values({
        sessionId,
        sessionExerciseId,
        kind: "working_set",
        origin: "legacy",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exerciseId,
        outcome: "completed",
        revision: 1,
        resolvedAt: new Date("2026-07-02T12:15:00.000Z"),
        completedSetId: setId,
      })
      .returning({ id: schema.sessionOccurrences.id });
    const [{ id: mutationId }] = await db
      .insert(schema.sessionOccurrenceMutations)
      .values({
        occurrenceId,
        clientKey: crypto.randomUUID(),
        operation: "complete",
        canonicalPayloadHash: "b".repeat(64),
        expectedRevision: 0,
        resultingRevision: 1,
        resultCode: "applied",
      })
      .returning({ id: schema.sessionOccurrenceMutations.id });
    const [{ id: equipmentSnapshotId }] = await db
      .insert(schema.sessionEquipmentSnapshots)
      .values({
        userId,
        sessionId,
        sessionExerciseId,
        equipmentLabel: "Permanent delete bodyweight setup",
        profileKind: "bodyweight",
        geometryCertainty: "known",
        selectionProvenance: "user_selected",
        configurationRevision: 1,
        configurationHash: "c".repeat(64),
        geometryVersion: 1,
        geometrySnapshot: { version: 1, kind: "bodyweight" },
      })
      .returning({ id: schema.sessionEquipmentSnapshots.id });
    const [{ id: equipmentSelectionReceiptId }] = await db
      .insert(schema.sessionEquipmentSelectionReceipts)
      .values({
        userId,
        sessionId,
        sessionExerciseId,
        clientKey: crypto.randomUUID(),
        operation: "select",
        canonicalPayloadHash: "d".repeat(64),
        resultingSnapshotId: equipmentSnapshotId,
        resultCode: "applied",
      })
      .returning({ id: schema.sessionEquipmentSelectionReceipts.id });
    const [{ id: painId }] = await db
      .insert(schema.painLogs)
      .values({
        userId,
        sessionId,
        exerciseId,
        completedSetId: setId,
        bodyPart: "knee",
        severity: 2,
      })
      .returning({ id: schema.painLogs.id });
    await db.insert(schema.fatigueLogs).values({ userId, sessionId, severity: 2 });
    await db.insert(schema.sessionNotes).values({ sessionId, text: "Linked note" });
    const [{ id: progressionJobId }] = await db
      .insert(schema.progressionJobs)
      .values({
        userId,
        sessionId,
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
        status: "completed",
        attempts: 1,
        completedAt: new Date("2026-07-02T13:00:05.000Z"),
      })
      .returning({ id: schema.progressionJobs.id });
    await db.insert(schema.progressionJobInputSessions).values({
      jobId: progressionJobId,
      userId,
      sourceSlotLineageId,
      sessionId,
      historyRevision: 0,
    });
    const [{ id: recommendationId }] = await db
      .insert(schema.recommendations)
      .values({
        userId,
        status: "rejected",
        source: "rule",
        progressionJobId,
        payload: { kind: "hold", templateExerciseId: crypto.randomUUID(), reason: "test" },
        reason: "Linked recommendation",
        evidence: { signals: {}, sessionIds: [sessionId], setIds: [setId], painLogIds: [painId] },
        decidedAt: new Date("2026-07-02T13:00:06.000Z"),
      })
      .returning({ id: schema.recommendations.id });
    await db.insert(schema.userDecisions).values({
      recommendationId,
      decision: "reject",
    });
    await db.insert(schema.coachingInsights).values({
      userId,
      kind: "qa",
      contentMd: "Saved answer",
      dataDigest: { sessionId },
    });
    await db.insert(schema.recordVersions).values({
      userId,
      entityType: "session_exercise",
      entityId: sessionExerciseId,
      action: "session_exercise.edit",
      beforeData: { notes: null },
      afterData: { notes: "changed" },
      changedFields: ["notes"],
    });
    const archived = await archiveWorkoutRecord(db, userId, sessionId);
    if (!archived.ok) throw new Error(archived.reason);
    return {
      sessionId,
      sessionExerciseId,
      setId,
      groupId,
      occurrenceId,
      mutationId,
      equipmentSnapshotId,
      equipmentSelectionReceiptId,
      progressionJobId,
      compilerProposalId,
      operationId: archived.operationId,
    };
  }

  it("blocks direct deletion from protected tables", async () => {
    const { activityId } = await archivedActivity();
    await expect(
      db.delete(schema.healthActivities).where(eq(schema.healthActivities.id, activityId))
    ).rejects.toThrow();
    expect(
      await db.query.healthActivities.findFirst({
        where: eq(schema.healthActivities.id, activityId),
      })
    ).toBeDefined();
  });

  it("requires a new provider check and binds the grant to one exact Archive action", async () => {
    const first = await archivedActivity();
    const second = await archivedActivity();
    const requestedAt = new Date();
    const grant = await createPermanentDeleteGrant(
      db,
      userId,
      first.operationId,
      "github",
      null,
      requestedAt
    );
    expect(grant.ok).toBe(true);
    if (!grant.ok) throw new Error(grant.reason);
    expect(
      await getValidPermanentDeleteGrant(db, userId, first.operationId, grant.token)
    ).toBeUndefined();
    expect(
      await authenticatePermanentDeleteGrant(
        db,
        userId,
        grant.token,
        "github",
        new Date(requestedAt.getTime() - 1000)
      )
    ).toMatchObject({ ok: false });
    expect(
      await authenticatePermanentDeleteGrant(
        db,
        userId,
        grant.token,
        "github",
        new Date(requestedAt.getTime() + 1000)
      )
    ).toMatchObject({ ok: true, operationId: first.operationId });
    expect(
      await getValidPermanentDeleteGrant(db, userId, first.operationId, grant.token)
    ).toBeDefined();
    expect(
      await getValidPermanentDeleteGrant(db, userId, second.operationId, grant.token)
    ).toBeUndefined();
    expect(
      await authenticatePermanentDeleteGrant(
        db,
        userId,
        grant.token,
        "github",
        new Date(requestedAt.getTime() + 2000)
      )
    ).toMatchObject({ ok: false });
  });

  it("permanently deletes an activity and its versions while preserving audit evidence", async () => {
    const { activityId, operationId } = await archivedActivity();
    await db.insert(schema.recordVersions).values({
      userId,
      entityType: "health_activity",
      entityId: activityId,
      action: "activity.edit",
      beforeData: { title: "Earlier" },
      afterData: { title: "Archived walk" },
      changedFields: ["title"],
    });
    const now = new Date();
    const grant = await createPermanentDeleteGrant(
      db,
      userId,
      operationId,
      "dev-login",
      now,
      now
    );
    if (!grant.ok) throw new Error(grant.reason);
    expect(grant.preview.deleteCounts).toMatchObject({
      healthActivities: 1,
      recordVersions: 1,
    });
    const snapshotId = await verifiedSafetySnapshot(operationId);
    const deleted = await permanentlyDeleteArchiveOperation(
      db,
      userId,
      operationId,
      grant.token,
      PERMANENT_DELETE_CONFIRMATION,
      snapshotId
    );
    expect(deleted).toMatchObject({ ok: true });
    expect(
      await db.query.healthActivities.findFirst({
        where: eq(schema.healthActivities.id, activityId),
      })
    ).toBeUndefined();
    expect(await db.query.recordVersions.findMany()).toHaveLength(0);
    expect(
      await db.query.archiveOperations.findFirst({
        where: eq(schema.archiveOperations.id, operationId),
      })
    ).toMatchObject({ status: "deleted", deletedAt: expect.any(Date) });
    expect(
      await db.query.permanentDeleteGrants.findFirst({
        where: eq(schema.permanentDeleteGrants.operationId, operationId),
      })
    ).toMatchObject({ consumedAt: expect.any(Date) });
    expect(
      await db.query.auditLogs.findFirst({
        where: eq(schema.auditLogs.action, "archive.permanent_delete"),
      })
    ).toBeDefined();
    expect(await restoreArchiveOperation(db, userId, operationId)).toMatchObject({
      ok: false,
    });
  });

  it("reports and deletes an accepted Session Compiler proposal with its archived workout", async () => {
    const { sessionId, compilerProposalId, operationId } = await archivedWorkout(true);
    const now = new Date();
    const grant = await createPermanentDeleteGrant(db, userId, operationId, "dev-login", now, now);
    if (!grant.ok) throw new Error(grant.reason);
    expect(grant.preview.deleteCounts).toMatchObject({
      workoutSessions: 1,
      sessionCompilerProposals: 1,
    });
    const snapshotId = await verifiedSafetySnapshot(operationId);
    const deleted = await permanentlyDeleteArchiveOperation(
      db,
      userId,
      operationId,
      grant.token,
      PERMANENT_DELETE_CONFIRMATION,
      snapshotId
    );
    if (!deleted.ok) throw new Error(deleted.reason);
    expect(await db.query.workoutSessions.findFirst({ where: eq(schema.workoutSessions.id, sessionId) })).toBeUndefined();
    expect(await db.query.sessionCompilerProposals.findFirst({ where: eq(schema.sessionCompilerProposals.id, compilerProposalId!) })).toBeUndefined();
  });

  it("rolls back every deletion and grant consumption after an injected failure", async () => {
    const {
      sessionId,
      groupId,
      occurrenceId,
      mutationId,
      equipmentSnapshotId,
      equipmentSelectionReceiptId,
      progressionJobId,
      operationId,
    } = await archivedWorkout();
    const preview = await getPermanentDeletePreview(db, userId, operationId);
    expect(preview?.deleteCounts).toMatchObject({
      workoutSessions: 1,
      sessionExercises: 1,
      completedSets: 1,
      sessionExerciseGroups: 1,
      sessionOccurrences: 1,
      sessionOccurrenceMutations: 1,
      sessionEquipmentSnapshots: 1,
      sessionEquipmentSelectionReceipts: 1,
      progressionJobs: 1,
      progressionJobInputSessions: 1,
      sessionNotes: 1,
      painLogs: 1,
      fatigueLogs: 1,
      recommendations: 1,
      userDecisions: 1,
      coachingInsights: 1,
      recordVersions: 1,
    });
    expect(preview?.blockers).toEqual([]);
    await expect(
      db
        .delete(schema.progressionJobs)
        .where(eq(schema.progressionJobs.id, progressionJobId))
    ).rejects.toThrow();
    const now = new Date();
    const grant = await createPermanentDeleteGrant(
      db,
      userId,
      operationId,
      "dev-login",
      now,
      now
    );
    if (!grant.ok) throw new Error(grant.reason);
    const snapshotId = await verifiedSafetySnapshot(operationId);
    const failed = await permanentlyDeleteArchiveOperation(
      db,
      userId,
      operationId,
      grant.token,
      PERMANENT_DELETE_CONFIRMATION,
      snapshotId,
      "workout_sessions"
    );
    expect(failed).toMatchObject({ ok: false });
    expect(
      await db.query.workoutSessions.findFirst({
        where: eq(schema.workoutSessions.id, sessionId),
      })
    ).toBeDefined();
    expect(
      await db.query.progressionJobs.findFirst({
        where: eq(schema.progressionJobs.id, progressionJobId),
      })
    ).toBeDefined();
    expect(
      await db.query.sessionExerciseGroups.findFirst({
        where: eq(schema.sessionExerciseGroups.id, groupId),
      })
    ).toBeDefined();
    expect(
      await db.query.sessionOccurrences.findFirst({
        where: eq(schema.sessionOccurrences.id, occurrenceId),
      })
    ).toBeDefined();
    expect(
      await db.query.sessionOccurrenceMutations.findFirst({
        where: eq(schema.sessionOccurrenceMutations.id, mutationId),
      })
    ).toBeDefined();
    expect(
      await db.query.sessionEquipmentSnapshots.findFirst({
        where: eq(schema.sessionEquipmentSnapshots.id, equipmentSnapshotId),
      })
    ).toBeDefined();
    expect(
      await db.query.sessionEquipmentSelectionReceipts.findFirst({
        where: eq(
          schema.sessionEquipmentSelectionReceipts.id,
          equipmentSelectionReceiptId
        ),
      })
    ).toBeDefined();
    expect(
      await db.query.archiveOperations.findFirst({
        where: eq(schema.archiveOperations.id, operationId),
      })
    ).toMatchObject({ status: "active", deletedAt: null });
    expect(
      await db.query.permanentDeleteGrants.findFirst({
        where: eq(schema.permanentDeleteGrants.operationId, operationId),
      })
    ).toMatchObject({ consumedAt: null });

    const completed = await permanentlyDeleteArchiveOperation(
      db,
      userId,
      operationId,
      grant.token,
      PERMANENT_DELETE_CONFIRMATION,
      snapshotId
    );
    if (!completed.ok) throw new Error(completed.reason);
    expect(
      await db.query.workoutSessions.findFirst({
        where: eq(schema.workoutSessions.id, sessionId),
      })
    ).toBeUndefined();
    expect(await db.query.completedSets.findMany()).toHaveLength(0);
    expect(await db.query.painLogs.findMany()).toHaveLength(0);
    expect(await db.query.fatigueLogs.findMany()).toHaveLength(0);
    expect(await db.query.recommendations.findMany()).toHaveLength(0);
    expect(await db.query.progressionJobs.findMany()).toHaveLength(0);
    expect(await db.query.progressionJobInputSessions.findMany()).toHaveLength(0);
    expect(await db.query.coachingInsights.findMany()).toHaveLength(0);
    expect(await db.query.sessionExerciseGroups.findMany()).toHaveLength(0);
    expect(await db.query.sessionOccurrences.findMany()).toHaveLength(0);
    expect(await db.query.sessionOccurrenceMutations.findMany()).toHaveLength(0);
    expect(await db.query.sessionEquipmentSnapshots.findMany()).toHaveLength(0);
    expect(await db.query.sessionEquipmentSelectionReceipts.findMany()).toHaveLength(0);
  });

  it("permanently deletes a linked zero-rep set occurrence without deleting its workout", async () => {
    const {
      sessionId,
      sessionExerciseId,
      setId,
      occurrenceId,
      mutationId,
      operationId: workoutOperationId,
    } = await archivedWorkout();
    expect(await restoreArchiveOperation(db, userId, workoutOperationId)).toMatchObject({
      ok: true,
    });
    for (const note of [
      { attachmentKind: "set" as const, body: "Direct set note", completedSetId: setId },
      { attachmentKind: "set" as const, body: "Pre-completion set note", completedSetId: null },
      { attachmentKind: "occurrence" as const, body: "Occurrence-linked note" },
    ]) {
      const saved = await createContextualNote(db, userId, {
        clientKey: crypto.randomUUID(),
        body: note.body,
        coachVisible: true,
        inputMode: "typed",
        ...(note.attachmentKind === "set"
          ? {
              attachmentKind: "set" as const,
              sessionId,
              sessionExerciseId,
              occurrenceId,
              completedSetId: note.completedSetId,
            }
          : { attachmentKind: "occurrence" as const, sessionId, occurrenceId }),
        capturedContext: {
          schemaVersion: 1,
          destination: "history",
          workflow: "permanent delete set dependency fixture",
          workoutPhase: "review",
          originatedFromSimulation: false,
          programDay: null,
          plannedExercise: null,
          performedExercise: null,
          occurrence: null,
          loadRepetitions: null,
          restContext: null,
          reviewContext: null,
        },
        recordedAt: "2026-07-02T13:01:00.000Z",
      });
      expect(saved.outcome).toBe("saved");
    }
    const archived = await archiveCompletedSetRecord(db, userId, setId);
    if (!archived.ok) throw new Error(archived.reason);
    expect(archived.counts.contextualNotes).toBe(3);

    const now = new Date();
    const grant = await createPermanentDeleteGrant(
      db,
      userId,
      archived.operationId,
      "dev-login",
      now,
      now
    );
    if (!grant.ok) throw new Error(grant.reason);
    expect(grant.preview.deleteCounts).toMatchObject({
      workoutSessions: 0,
      completedSets: 1,
      sessionExerciseGroups: 0,
      sessionOccurrences: 1,
      sessionOccurrenceMutations: 1,
      contextualNotes: 3,
      contextualNoteRevisions: 3,
    });

    const snapshotId = await verifiedSafetySnapshot(archived.operationId);
    expect(
      await permanentlyDeleteArchiveOperation(
        db,
        userId,
        archived.operationId,
        grant.token,
        PERMANENT_DELETE_CONFIRMATION,
        snapshotId
      )
    ).toMatchObject({ ok: true });
    expect(
      await db.query.workoutSessions.findFirst({
        where: eq(schema.workoutSessions.id, sessionId),
      })
    ).toBeDefined();
    expect(
      await db.query.completedSets.findFirst({
        where: eq(schema.completedSets.id, setId),
      })
    ).toBeUndefined();
    expect(
      await db.query.sessionOccurrences.findFirst({
        where: eq(schema.sessionOccurrences.id, occurrenceId),
      })
    ).toBeUndefined();
    expect(
      await db.query.sessionOccurrenceMutations.findFirst({
        where: eq(schema.sessionOccurrenceMutations.id, mutationId),
      })
    ).toBeUndefined();
    expect(await db.query.contextualNotes.findMany()).toHaveLength(0);
    expect(await db.query.contextualNoteRevisions.findMany()).toHaveLength(0);
  });

  it("blocks a workout when a set belongs to a separate Archive action", async () => {
    const workout = await archivedWorkout();
    // Restore, archive the set first, then archive the parent workout.
    expect(await restoreArchiveOperation(db, userId, workout.operationId)).toMatchObject({
      ok: true,
    });
    const setArchive = await archiveCompletedSetRecord(db, userId, workout.setId);
    const workoutArchive = await archiveWorkoutRecord(db, userId, workout.sessionId);
    if (!setArchive.ok || !workoutArchive.ok) {
      throw new Error("Nested Archive setup failed.");
    }
    const preview = await getPermanentDeletePreview(
      db,
      userId,
      workoutArchive.operationId
    );
    expect(preview?.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "nested_archive", count: 1 }),
      ])
    );
    expect(
      await createPermanentDeleteGrant(
        db,
        userId,
        workoutArchive.operationId,
        "dev-login",
        new Date()
      )
    ).toMatchObject({ ok: false });
  });

  it("deletes an archived import only when its file, mappings, exercises, and workouts are exclusive", async () => {
    const [{ id: importEventId }] = await db
      .insert(schema.importEvents)
      .values({
        userId,
        source: "csv",
        rawPayload: "permanent-delete-import",
        parsedPayload: { exercises: [{ key: "exclusive-import" }] },
        confirmedPayload: { schemaVersion: "1", resolutions: [{}] },
        status: "confirmed",
      })
      .returning({ id: schema.importEvents.id });
    const [{ id: customExerciseId }] = await db
      .insert(schema.exercises)
      .values({
        userId,
        name: `Exclusive imported exercise ${crypto.randomUUID()}`,
        movementPattern: "hinge",
        primaryMuscles: ["hamstrings"],
        createdFromImportEventId: importEventId,
      })
      .returning({ id: schema.exercises.id });
    await db.insert(schema.exerciseEquipmentRequirements).values({
      exerciseId: customExerciseId,
      equipmentType: "cable",
    });
    const [{ id: equipmentItemId }] = await db
      .insert(schema.equipmentItems)
      .values({
        userId,
        type: "cable",
        label: "Synthetic exclusive cable station",
        attrs: {},
        available: true,
      })
      .returning({ id: schema.equipmentItems.id });
    const [{ id: fitAssertionId }] = await db
      .insert(schema.exerciseEquipmentFitAssertions)
      .values({
        userId,
        exerciseId: customExerciseId,
        equipmentItemId,
        verdict: "incompatible",
        reasonCode: "missing_capability",
        reasonNote: "Synthetic exclusive custom-exercise relation",
        evidenceRevision: "a".repeat(32),
      })
      .returning({ id: schema.exerciseEquipmentFitAssertions.id });
    const sourceName = `Exclusive source ${crypto.randomUUID()}`;
    const [{ id: mappingId }] = await db
      .insert(schema.externalExerciseMappings)
      .values({
        userId,
        source: "hevy",
        sourceName,
        normalizedKey: sourceName.toLowerCase(),
        exerciseId: customExerciseId,
      })
      .returning({ id: schema.externalExerciseMappings.id });
    const [{ id: batchId }] = await db
      .insert(schema.historyImportBatches)
      .values({
        userId,
        importEventId,
        source: "hevy",
        originalFilename: "exclusive.csv",
        fileHash: crypto.randomUUID(),
        timezone: "America/Toronto",
        status: "confirmed",
        summary: {
          workouts: 1,
          exerciseOccurrences: 1,
          sets: 1,
          warmupSets: 0,
          supersetGroups: 0,
          excludedExercises: 0,
          warnings: 0,
        },
      })
      .returning({ id: schema.historyImportBatches.id });
    const [{ id: sessionId }] = await db
      .insert(schema.workoutSessions)
      .values({
        userId,
        importBatchId: batchId,
        source: "hevy",
        sourceWorkoutKey: crypto.randomUUID(),
        templateName: "Exclusive import workout",
        status: "completed",
        startedAt: new Date("2026-07-03T12:00:00.000Z"),
        finishedAt: new Date("2026-07-03T13:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-03",
      })
      .returning({ id: schema.workoutSessions.id });
    const [{ id: occurrenceId }] = await db
      .insert(schema.sessionExercises)
      .values({
        sessionId,
        exerciseId: customExerciseId,
        sourceExerciseKey: sourceName.toLowerCase(),
        sourceExerciseName: sourceName,
      })
      .returning({ id: schema.sessionExercises.id });
    await db.insert(schema.completedSets).values({
      sessionExerciseId: occurrenceId,
      setNo: 1,
      weight: 80,
      weightUnit: "lb",
      reps: 8,
    });
    const archived = await archiveImportBatchRecord(db, userId, batchId);
    if (!archived.ok) throw new Error(archived.reason);
    const preview = await getPermanentDeletePreview(
      db,
      userId,
      archived.operationId
    );
    expect(preview?.blockers).toEqual([]);
    expect(preview?.deleteCounts).toMatchObject({
      historyImportBatches: 1,
      importEvents: 1,
      externalExerciseMappings: 1,
      customExercises: 1,
      exerciseEquipmentFitAssertions: 1,
      workoutSessions: 1,
      sessionExercises: 1,
      completedSets: 1,
    });
    const now = new Date();
    const grant = await createPermanentDeleteGrant(
      db,
      userId,
      archived.operationId,
      "dev-login",
      now,
      now
    );
    if (!grant.ok) throw new Error(grant.reason);
    const snapshotId = await verifiedSafetySnapshot(archived.operationId);
    expect(
      await permanentlyDeleteArchiveOperation(
        db,
        userId,
        archived.operationId,
        grant.token,
        PERMANENT_DELETE_CONFIRMATION,
        snapshotId,
        "exercise_equipment_fit_assertions"
      )
    ).toMatchObject({ ok: false });
    expect(
      await db.query.exerciseEquipmentFitAssertions.findFirst({
        where: eq(schema.exerciseEquipmentFitAssertions.id, fitAssertionId),
      })
    ).toBeDefined();
    expect(
      await permanentlyDeleteArchiveOperation(
        db,
        userId,
        archived.operationId,
        grant.token,
        PERMANENT_DELETE_CONFIRMATION,
        snapshotId
      )
    ).toMatchObject({ ok: true });
    expect(
      await db.query.historyImportBatches.findFirst({
        where: eq(schema.historyImportBatches.id, batchId),
      })
    ).toBeUndefined();
    expect(
      await db.query.importEvents.findFirst({
        where: eq(schema.importEvents.id, importEventId),
      })
    ).toBeUndefined();
    expect(
      await db.query.workoutSessions.findFirst({
        where: eq(schema.workoutSessions.id, sessionId),
      })
    ).toBeUndefined();
    expect(
      await db.query.exercises.findFirst({
        where: eq(schema.exercises.id, customExerciseId),
      })
    ).toBeUndefined();
    expect(
      await db.query.externalExerciseMappings.findFirst({
        where: eq(schema.externalExerciseMappings.id, mappingId),
      })
    ).toBeUndefined();
    expect(
      await db.query.exerciseEquipmentFitAssertions.findFirst({
        where: eq(schema.exerciseEquipmentFitAssertions.id, fitAssertionId),
      })
    ).toBeUndefined();
  });
});
