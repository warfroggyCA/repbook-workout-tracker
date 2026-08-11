import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  adaptationEvents,
  aiParsingEvents,
  auditLogs,
  coachingInsights,
  completedSets,
  dataSnapshots,
  exerciseExecutionRequirements,
  exercises,
  healthActivities,
  importEvents,
  painLogs,
  programs,
  programDrafts,
  progressionJobInputSessions,
  progressionJobs,
  recommendations,
  recordVersions,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrenceMutations,
  sessionOccurrences,
  userDecisions,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { getOrCreateProgramDraft } from "@/services/program-drafts";
import { hashLegacyProgramDocument } from "@/services/program-document-hash";
import { normalizeActivityInput } from "@/services/activities";
import {
  buildSessionEquipmentConfigurationIdentity,
  type SessionEquipmentGeometrySnapshot,
} from "@/lib/session-equipment-snapshot-contract";
import {
  canonicalJson,
  encryptSnapshotBytes,
  sha256Hex,
  SNAPSHOT_ENCRYPTION_ALGORITHM,
} from "@/services/snapshot-crypto";
import {
  captureUserSnapshot,
  snapshotRecordCounts,
} from "@/services/snapshot-capture";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import {
  createDataSnapshot,
  readVerifiedDataSnapshot,
  resolveSnapshotAppVersion,
  SNAPSHOT_SERIALIZED_SIZE_LIMIT_BYTES,
  updateDataSnapshotMetadata,
  type SnapshotKeyring,
} from "@/services/snapshots";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
  upgradeSnapshotPayload,
  validateSnapshotPayload,
} from "@/services/snapshot-restore";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import { createContextualNote, editContextualNote } from "@/services/contextual-notes";
import { updateSetWithVersion } from "@/services/record-versions";
import {
  correctCompletedWorkoutActiveDuration,
  correctCompletedWorkoutTiming,
} from "@/services/workout-timing-corrections";
import { completeWorkoutSession } from "@/services/session-lifecycle";
import {
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
} from "@/lib/program-document";

describe("verified off-database snapshots", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let exerciseId: string;
  let sessionId: string;
  let sessionExerciseId: string;
  let setId: string;
  let activityId: string;
  let store: MemorySnapshotObjectStore;
  const key = Buffer.alloc(32, 11);
  const keyring: SnapshotKeyring = {
    currentVersion: "v1",
    resolve(version) {
      if (version !== "v1") throw new Error("Unknown test key.");
      return key;
    },
  };

  it("never records an empty snapshot release identifier", () => {
    expect(
      resolveSnapshotAppVersion(undefined, {
        VERCEL_GIT_COMMIT_SHA: "",
        npm_package_version: " 0.1.0 ",
      })
    ).toBe("0.1.0");
    expect(
      resolveSnapshotAppVersion(" release-ed1f47b ", {
        VERCEL_GIT_COMMIT_SHA: "",
      })
    ).toBe("release-ed1f47b");
  });

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    store = new MemorySnapshotObjectStore();

    const [user] = await db
      .insert(users)
      .values({ email: `snapshot-${crypto.randomUUID()}@example.com`, name: "Snapshot owner" })
      .returning({ id: users.id });
    userId = user.id;
    await db.insert(userProfiles).values({ userId, unit: "kg" });
    const [exercise] = await db
      .insert(exercises)
      .values({
        userId,
        name: `Snapshot Squat ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
    exerciseId = exercise.id;
    const [session] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Known-good workout",
        status: "completed",
        startedAt: new Date("2026-07-01T14:00:00.000Z"),
        finishedAt: new Date("2026-07-01T15:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-01",
      })
      .returning({ id: workoutSessions.id });
    sessionId = session.id;
    const [sessionExercise] = await db
      .insert(sessionExercises)
      .values({
        sessionId,
        exerciseId: exercise.id,
        orderIdx: 0,
        targetLoad: 32.3,
        targetLoadUnit: "kg",
      })
      .returning({ id: sessionExercises.id });
    sessionExerciseId = sessionExercise.id;
    const [set] = await db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        weight: 61.25,
        weightUnit: "kg",
        reps: 8,
      })
      .returning({ id: completedSets.id });
    setId = set.id;
    const normalized = normalizeActivityInput({
      activityType: "walk",
      title: "Known-good walk",
      startedAtISO: "2026-07-02T13:00:00.000Z",
      timezone: "America/Toronto",
      durationMinutes: 45,
      distanceValue: 4,
      distanceUnit: "km",
      intensity: "moderate",
      elevationValue: null,
      elevationUnit: "m",
      averageHeartRateBpm: null,
      energyKcal: null,
      notes: "Snapshot activity",
    });
    const [activity] = await db
      .insert(healthActivities)
      .values({ userId, ...normalized })
      .returning({ id: healthActivities.id });
    activityId = activity.id;
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  it("captures one deterministic complete view, encrypts it, and verifies the stored copy", async () => {
    const capturedAt = new Date("2026-07-11T12:00:00.000Z");
    const first = await captureUserSnapshot(db, userId, capturedAt, "test-commit");
    const second = await captureUserSnapshot(db, userId, capturedAt, "test-commit");
    expect(canonicalJson(first)).toBe(canonicalJson(second));

    const result = await createDataSnapshot(
      db,
      userId,
      {
        name: "Known good after reviewed import",
        note: "Pinned milestone",
        reason: "manual",
        pinned: true,
      },
      { store, keyring, now: capturedAt, appVersion: "test-commit" }
    );
    if (!result.ok) throw new Error(result.reason);

    const metadata = await db.query.dataSnapshots.findFirst({
      where: eq(dataSnapshots.id, result.snapshotId),
    });
    expect(metadata).toMatchObject({
      status: "verified",
      pinned: true,
      name: "Known good after reviewed import",
      encryptionAlgorithm: "aes-256-gcm",
      encryptionKeyVersion: "v1",
    });
    expect(metadata?.recordCounts).toMatchObject({
      workout_sessions: 1,
      completed_sets: 1,
      health_activities: 1,
    });
    const storedBytes = store.objects.get(metadata!.objectPath)!;
    expect(Buffer.from(storedBytes).toString("utf8")).not.toContain("Known-good workout");

    const verified = await readVerifiedDataSnapshot(db, userId, result.snapshotId, {
      store,
      keyring,
    });
    expect(verified.payload.tables.workout_sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sessionId })])
    );
    expect(verified.payload.tables.completed_sets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: setId, weight: 61.25, weight_unit: "kg" }),
      ])
    );
    expect(verified.payload.tables.session_exercises).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sessionExerciseId,
          target_load: 32.3,
          target_load_unit: "kg",
        }),
      ])
    );
    expect(verified.payload.tables.health_activities).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: activityId })])
    );
  }, 30_000);

  it("upgrades schema 25 without treating server recording time as observed completion", async () => {
    const legacy = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-11T12:00:00.000Z"),
      "schema-25-history-identity"
    );
    legacy.schemaVersion = "25";
    delete legacy.tables.progression_job_input_sessions;
    for (const workout of legacy.tables.workout_sessions as Array<
      Record<string, unknown>
    >) {
      delete workout.history_revision;
      delete workout.performed_time_precision;
      delete workout.source_program_id;
      delete workout.source_program_version_id;
      delete workout.source_day_lineage_id;
    }
    for (const exercise of legacy.tables.session_exercises as Array<
      Record<string, unknown>
    >) {
      delete exercise.source_slot_lineage_id;
    }
    const completed = (
      legacy.tables.completed_sets as Array<Record<string, unknown>>
    )[0];
    const recordedAt = completed.logged_at;
    delete completed.observed_completed_at;
    delete completed.observed_completion_provenance;
    delete completed.observed_completion_quality;
    for (const job of legacy.tables.progression_jobs as Array<
      Record<string, unknown>
    >) {
      delete job.source_session_revision;
    }

    const upgraded = upgradeSnapshotPayload(legacy);

    expect(upgraded.schemaVersion).toBe("33");
    expect(upgraded.tables.workout_sessions[0]).toMatchObject({
      history_revision: 0,
      performed_time_precision: "instant",
      active_duration_semantics_version: null,
      active_duration_seconds: null,
      active_duration_basis: null,
      source_program_id: null,
      source_program_version_id: null,
      source_day_lineage_id: null,
    });
    expect(upgraded.tables.session_exercises[0]).toMatchObject({
      source_slot_lineage_id: null,
    });
    expect(upgraded.tables.completed_sets[0]).toMatchObject({
      logged_at: recordedAt,
      observed_completed_at: null,
      observed_completion_provenance: "unknown",
      observed_completion_quality: "unknown",
      performed_semantics_version: null,
      performed_load_type: null,
      performed_load_semantics: null,
    });
    expect(upgraded.tables.progression_job_input_sessions).toEqual([]);
    expect(() => validateSnapshotPayload(upgraded, userId)).not.toThrow();

    const incoherent = structuredClone(upgraded);
    (
      incoherent.tables.completed_sets[0] as Record<string, unknown>
    ).observed_completion_provenance = "live_client";
    expect(() => validateSnapshotPayload(incoherent, userId)).toThrow(
      /incoherent observed-completion evidence/
    );
    const incoherentPerformedSemantics = structuredClone(upgraded);
    (
      incoherentPerformedSemantics.tables.completed_sets[0] as Record<
        string,
        unknown
      >
    ).performed_semantics_version = 1;
    expect(() =>
      validateSnapshotPayload(incoherentPerformedSemantics, userId),
    ).toThrow(/incoherent performed-semantics evidence/);
    const nullableRevision = structuredClone(upgraded);
    (
      nullableRevision.tables.workout_sessions[0] as Record<string, unknown>
    ).history_revision = null;
    expect(() => validateSnapshotPayload(nullableRevision, userId)).toThrow(
      /invalid History revision/
    );
  });

  it("resolves completion duration from the workout locked after a concurrent snapshot restore", async () => {
    const restoredStartedAt = new Date("2026-07-20T12:00:00.000Z");
    const recentStartedAt = new Date("2026-07-20T15:30:00.000Z");
    const finishedAt = new Date("2026-07-20T16:00:00.000Z");
    const [active] = await db.insert(workoutSessions).values({
      userId,
      templateName: "Restore-race active workout",
      status: "in_progress",
      startedAt: restoredStartedAt,
      timezone: "America/Toronto",
      localDate: "2026-07-20",
    }).returning({ id: workoutSessions.id });
    const source = await createDataSnapshot(
      db,
      userId,
      { name: "Before active workout start correction", reason: "manual" },
      {
        store,
        keyring,
        now: new Date("2026-07-20T15:00:00.000Z"),
        appVersion: "completion-restore-race",
      },
    );
    if (!source.ok) throw new Error(source.reason);
    await db.update(workoutSessions).set({
      startedAt: recentStartedAt,
    }).where(eq(workoutSessions.id, active.id));

    let releaseCompletion!: () => void;
    const completionRelease = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let completionReachedBoundary!: () => void;
    const atCompletionBoundary = new Promise<void>((resolve) => {
      completionReachedBoundary = resolve;
    });
    const completion = completeWorkoutSession(
      db,
      {
        id: userId,
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
      },
      { sessionId: active.id },
      {
        now: () => finishedAt,
        checkpoint: async (boundary) => {
          if (boundary !== "before-completion-statement") return;
          completionReachedBoundary();
          await completionRelease;
        },
      },
    );
    await atCompletionBoundary;
    try {
      const preview = await getSnapshotRestorePreview(
        db,
        userId,
        source.snapshotId,
        "history",
        { store, keyring },
      );
      await expect(restoreDataSnapshot(
        db,
        userId,
        {
          snapshotId: source.snapshotId,
          scope: "history",
          previewFingerprint: preview.fingerprint,
          confirmation: "RESTORE",
        },
        { store, keyring, appVersion: "completion-restore-race" },
      )).resolves.toMatchObject({ ok: true, scope: "history" });
    } finally {
      releaseCompletion();
    }

    await expect(completion).resolves.toMatchObject({
      outcome: "duration_review_required",
      wallClockElapsedSeconds: 14_400,
      reviewRequired: true,
    });
    await expect(db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, active.id),
    })).resolves.toMatchObject({
      status: "in_progress",
      startedAt: restoredStartedAt,
      finishedAt: null,
      activeDurationSemanticsVersion: null,
      activeDurationSeconds: null,
      activeDurationBasis: null,
    });
  });

  it("upgrades schema 30 active-duration evidence conservatively and validates versioned tuples", async () => {
    const current = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-08-10T16:00:00.000Z"),
      "schema-30-active-duration",
    );
    const legacy = structuredClone(current);
    legacy.schemaVersion = "30";
    for (const workout of legacy.tables.workout_sessions as Array<Record<string, unknown>>) {
      delete workout.active_duration_semantics_version;
      delete workout.active_duration_seconds;
      delete workout.active_duration_basis;
    }

    const upgraded = upgradeSnapshotPayload(legacy);
    expect(upgraded.schemaVersion).toBe("33");
    expect(upgraded.tables.workout_sessions[0]).toMatchObject({
      active_duration_semantics_version: null,
      active_duration_seconds: null,
      active_duration_basis: null,
    });
    expect(() => validateSnapshotPayload(upgraded, userId)).not.toThrow();

    await db.update(workoutSessions).set({
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 3_600,
      activeDurationBasis: "owner_reported",
    }).where(eq(workoutSessions.id, sessionId));
    const versioned = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-08-10T16:01:00.000Z"),
      "schema-31-active-duration",
    );
    expect(versioned.tables.workout_sessions[0]).toMatchObject({
      active_duration_semantics_version: 1,
      active_duration_seconds: 3_600,
      active_duration_basis: "owner_reported",
    });
    expect(() => validateSnapshotPayload(versioned, userId)).not.toThrow();

    const incoherent = structuredClone(versioned);
    (incoherent.tables.workout_sessions[0] as Record<string, unknown>)
      .active_duration_seconds = null;
    expect(() => validateSnapshotPayload(incoherent, userId)).toThrow(
      /incoherent active-duration evidence/,
    );
  });

  it("requires and restores the immutable audit chain for corrected active duration", async () => {
    const sourceStartedAt = new Date("2026-07-01T14:00:00.000Z");
    const sourceFinishedAt = new Date("2026-07-01T15:00:00.000Z");
    const mutationId = crypto.randomUUID();
    const corrected = await correctCompletedWorkoutActiveDuration(
      db,
      userId,
      {
        sessionId,
        clientMutationId: mutationId,
        expectedHistoryRevision: 0,
        expected: {
          activeDurationSemanticsVersion: null,
          activeDurationSeconds: null,
          activeDurationBasis: null,
        },
        decision: { basis: "owner_reported", activeDurationSeconds: 2_700 },
      },
      new Date("2026-08-10T16:00:00.000Z"),
    );
    expect(corrected).toMatchObject({
      ok: true,
      outcome: "corrected",
      versionId: mutationId,
      historyRevision: 1,
    });

    const captured = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-08-10T16:01:00.000Z"),
      "active-duration-audit-chain",
    );
    const capturedVersions = captured.tables.record_versions as Array<
      Record<string, unknown>
    >;
    const capturedAudits = captured.tables.audit_logs as Array<
      Record<string, unknown>
    >;
    const sourceVersion = capturedVersions.find(
      (row) => row.id === mutationId,
    );
    const sourceAudit = capturedAudits.find((row) => {
      const cause = row.cause_ref as Record<string, unknown> | null;
      return cause?.versionId === mutationId;
    }) as Record<string, unknown> | undefined;
    expect(sourceVersion).toMatchObject({
      entity_type: "workout_session",
      entity_id: sessionId,
      action: "workout_session.duration_correction",
    });
    expect(sourceAudit).toMatchObject({
      action: "workout_session.duration_correction",
      entity_id: sessionId,
    });
    expect(() => validateSnapshotPayload(captured, userId)).not.toThrow();

    const missingAudit = structuredClone(captured);
    missingAudit.tables.audit_logs = (
      missingAudit.tables.audit_logs as Array<Record<string, unknown>>
    ).filter((row) => row.id !== sourceAudit?.id);
    expect(() => validateSnapshotPayload(missingAudit, userId)).toThrow(
      /missing its exact immutable audit evidence/,
    );
    const missingVersion = structuredClone(captured);
    missingVersion.tables.record_versions = (
      missingVersion.tables.record_versions as Array<Record<string, unknown>>
    ).filter((row) => row.id !== mutationId);
    expect(() => validateSnapshotPayload(missingVersion, userId)).toThrow(
      /audit is missing its exact immutable version evidence/,
    );

    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Corrected active duration", reason: "manual" },
      {
        store,
        keyring,
        now: new Date("2026-08-10T16:02:00.000Z"),
        appVersion: "active-duration-audit-chain",
      },
    );
    if (!created.ok) throw new Error(created.reason);

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('workout_tracker.authorized_delete', 'snapshot_restore', true)`,
      );
      await tx.delete(auditLogs).where(eq(auditLogs.id, String(sourceAudit?.id)));
      await tx.delete(recordVersions).where(eq(recordVersions.id, mutationId));
    });
    await db.update(workoutSessions).set({
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: null,
      activeDurationBasis: "interruption_unknown",
    }).where(eq(workoutSessions.id, sessionId));

    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "history",
      { store, keyring },
    );
    expect(preview.tables.find((table) => table.table === "record_versions"))
      .toMatchObject({ added: 1 });
    expect(preview.tables.find((table) => table.table === "audit_logs"))
      .toMatchObject({ added: 1 });

    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "active-duration-audit-chain" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });
    expect(await db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    })).toMatchObject({
      startedAt: sourceStartedAt,
      finishedAt: sourceFinishedAt,
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 2_700,
      activeDurationBasis: "owner_reported",
      historyRevision: 2,
    });
    expect(await db.query.recordVersions.findFirst({
      where: eq(recordVersions.id, mutationId),
    })).toMatchObject({
      entityType: "workout_session",
      entityId: sessionId,
      action: "workout_session.duration_correction",
    });
    expect(await db.query.auditLogs.findFirst({
      where: eq(auditLogs.id, String(sourceAudit?.id)),
    })).toMatchObject({
      action: "workout_session.duration_correction",
      entityId: sessionId,
      causeRef: expect.objectContaining({ versionId: mutationId }),
    });
  }, 30_000);

  it.each(["history", "full"] as const)(
    "appends a monotonic snapshot transition when an earlier active duration becomes effective (%s)",
    async (scope) => {
    const sourceStartedAt = new Date("2026-07-01T14:00:00.000Z");
    const sourceFinishedAt = new Date("2026-07-01T15:00:00.000Z");
    const firstCorrectionId = crypto.randomUUID();
    const first = await correctCompletedWorkoutActiveDuration(
      db,
      userId,
      {
        sessionId,
        clientMutationId: firstCorrectionId,
        expectedHistoryRevision: 0,
        expected: {
          activeDurationSemanticsVersion: null,
          activeDurationSeconds: null,
          activeDurationBasis: null,
        },
        decision: { basis: "owner_reported", activeDurationSeconds: 2_700 },
      },
      new Date("2026-08-10T17:00:00.000Z"),
    );
    expect(first).toMatchObject({ ok: true, historyRevision: 1 });

    const source = await createDataSnapshot(
      db,
      userId,
      { name: "Earlier reviewed duration", reason: "manual" },
      {
        store,
        keyring,
        now: new Date("2026-08-10T17:01:00.000Z"),
        appVersion: "active-duration-monotonic-restore",
      },
    );
    if (!source.ok) throw new Error(source.reason);

    const secondCorrectionId = crypto.randomUUID();
    const second = await correctCompletedWorkoutActiveDuration(
      db,
      userId,
      {
        sessionId,
        clientMutationId: secondCorrectionId,
        expectedHistoryRevision: 1,
        expected: {
          activeDurationSemanticsVersion: 1,
          activeDurationSeconds: 2_700,
          activeDurationBasis: "owner_reported",
        },
        decision: { basis: "interruption_unknown" },
      },
      new Date("2026-08-10T17:02:00.000Z"),
    );
    expect(second).toMatchObject({ ok: true, historyRevision: 2 });

    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      source.snapshotId,
      scope,
      { store, keyring },
    );
    const confirmationPreview = await getSnapshotRestorePreview(
      db,
      userId,
      source.snapshotId,
      scope,
      { store, keyring },
    );
    expect(confirmationPreview.fingerprint).toBe(preview.fingerprint);
    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: source.snapshotId,
        scope,
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "active-duration-monotonic-restore" },
    );
    if (!restored.ok) throw new Error(restored.reason);
    expect(restored).toMatchObject({ ok: true, scope });

    expect(await db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    })).toMatchObject({
      startedAt: sourceStartedAt,
      finishedAt: sourceFinishedAt,
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 2_700,
      activeDurationBasis: "owner_reported",
      historyRevision: 3,
    });
    const timingVersions = (
      await db.query.recordVersions.findMany({
        where: eq(recordVersions.userId, userId),
      })
    ).filter((version) =>
      version.entityType === "workout_session" && version.entityId === sessionId
    );
    expect(timingVersions.map((version) => version.id)).toEqual(
      expect.arrayContaining([firstCorrectionId, secondCorrectionId]),
    );
    const restoreVersions = timingVersions.filter(
      (version) => version.action === "workout_session.snapshot_restore",
    );
    expect(restoreVersions).toHaveLength(1);
    expect(restoreVersions[0]).toMatchObject({
      sourceVersionId: firstCorrectionId,
      beforeData: expect.objectContaining({
        history_revision: 2,
        active_duration_basis: "interruption_unknown",
        active_duration_seconds: null,
      }),
      afterData: expect.objectContaining({
        history_revision: 3,
        active_duration_basis: "owner_reported",
        active_duration_seconds: 2_700,
      }),
      changedFields: expect.arrayContaining([
        "active_duration_basis",
        "active_duration_seconds",
        "history_revision",
      ]),
    });
    expect(new Date(String(restoreVersions[0].afterData.started_at))).toEqual(
      sourceStartedAt,
    );
    expect(new Date(String(restoreVersions[0].afterData.finished_at))).toEqual(
      sourceFinishedAt,
    );
    expect(
      (await db.query.auditLogs.findMany({
        where: eq(auditLogs.userId, userId),
      })).find((audit) =>
        (audit.causeRef as Record<string, unknown> | null)?.versionId ===
          restoreVersions[0].id
      ),
    ).toMatchObject({
      actorType: "user",
      action: "workout_session.snapshot_restore",
      entityId: sessionId,
      causeRef: expect.objectContaining({
        sourceVersionId: firstCorrectionId,
        sourceSnapshotId: source.snapshotId,
        sourceHistoryRevision: 2,
        resultHistoryRevision: 3,
      }),
    });
    expect(await db.query.progressionJobs.findFirst({
      where: (job, { and, eq }) => and(
        eq(job.sessionId, sessionId),
        eq(job.sourceSessionRevision, 3),
      ),
    })).toBeDefined();
    const recaptured = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-08-10T17:02:30.000Z"),
      "active-duration-monotonic-restore",
    );
    expect(() => validateSnapshotPayload(recaptured, userId)).not.toThrow();
    expect((recaptured.tables.record_versions as Array<Record<string, unknown>>)
      .find((version) => version.id === restoreVersions[0].id)).toMatchObject({
        action: "workout_session.snapshot_restore",
        source_version_id: firstCorrectionId,
      });
    expect((recaptured.tables.audit_logs as Array<Record<string, unknown>>)
      .find((audit) => {
        const cause = audit.cause_ref as Record<string, unknown> | null;
        return cause?.versionId === restoreVersions[0].id;
      })).toMatchObject({ action: "workout_session.snapshot_restore" });
    const transitionSnapshot = await createDataSnapshot(
      db,
      userId,
      { name: "Restored duration evidence", reason: "manual" },
      {
        store,
        keyring,
        now: new Date("2026-08-10T17:02:45.000Z"),
        appVersion: "active-duration-monotonic-restore",
      },
    );
    if (!transitionSnapshot.ok) throw new Error(transitionSnapshot.reason);

    const repeatedPreview = await getSnapshotRestorePreview(
      db,
      userId,
      source.snapshotId,
      scope,
      { store, keyring },
    );
    const repeated = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: source.snapshotId,
        scope,
        previewFingerprint: repeatedPreview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "active-duration-monotonic-restore" },
    );
    expect(repeated).toMatchObject({ ok: true, scope });
    expect(await db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    })).toMatchObject({ historyRevision: 3, activeDurationSeconds: 2_700 });
    expect((await db.query.recordVersions.findMany({
      where: eq(recordVersions.userId, userId),
    })).filter(
      (version) => version.action === "workout_session.snapshot_restore",
    )).toHaveLength(1);
    expect(await db.query.progressionJobs.findFirst({
      where: (job, { and, eq }) => and(
        eq(job.sessionId, sessionId),
        eq(job.sourceSessionRevision, 3),
      ),
    })).toBeDefined();

    const stalePreview = await getSnapshotRestorePreview(
      db,
      userId,
      source.snapshotId,
      scope,
      { store, keyring },
    );
    const third = await correctCompletedWorkoutActiveDuration(
      db,
      userId,
      {
        sessionId,
        clientMutationId: crypto.randomUUID(),
        expectedHistoryRevision: 3,
        expected: {
          activeDurationSemanticsVersion: 1,
          activeDurationSeconds: 2_700,
          activeDurationBasis: "owner_reported",
        },
        decision: { basis: "interruption_unknown" },
      },
      new Date("2026-08-10T17:03:00.000Z"),
    );
    expect(third).toMatchObject({ ok: true, historyRevision: 4 });
    const stale = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: source.snapshotId,
        scope,
        previewFingerprint: stalePreview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "active-duration-monotonic-restore" },
    );
    expect(stale).toMatchObject({ ok: false });
    expect(stale.ok ? "" : stale.reason).toContain("changed after this preview");
    expect(await db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    })).toMatchObject({
      historyRevision: 4,
      activeDurationBasis: "interruption_unknown",
      activeDurationSeconds: null,
    });

    const transitionPreview = await getSnapshotRestorePreview(
      db,
      userId,
      transitionSnapshot.snapshotId,
      scope,
      { store, keyring },
    );
    const transitionRestored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: transitionSnapshot.snapshotId,
        scope,
        previewFingerprint: transitionPreview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "active-duration-monotonic-restore" },
    );
    if (!transitionRestored.ok) throw new Error(transitionRestored.reason);
    expect(await db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, sessionId),
    })).toMatchObject({
      startedAt: sourceStartedAt,
      finishedAt: sourceFinishedAt,
      historyRevision: 5,
      activeDurationBasis: "owner_reported",
      activeDurationSeconds: 2_700,
    });
    const roundTrippedRestoreVersions = (
      await db.query.recordVersions.findMany({
        where: eq(recordVersions.userId, userId),
      })
    ).filter(
      (version) => version.action === "workout_session.snapshot_restore",
    );
    expect(roundTrippedRestoreVersions).toHaveLength(2);
    expect(roundTrippedRestoreVersions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: restoreVersions[0].id }),
      expect.objectContaining({
        sourceVersionId: restoreVersions[0].id,
        beforeData: expect.objectContaining({ history_revision: 4 }),
        afterData: expect.objectContaining({ history_revision: 5 }),
      }),
    ]));
    const roundTrippedRestoreVersion = roundTrippedRestoreVersions.find(
      (version) => version.id !== restoreVersions[0].id,
    );
    expect(roundTrippedRestoreVersion).toBeDefined();
    expect((await db.query.auditLogs.findMany({
      where: eq(auditLogs.userId, userId),
    })).find((audit) =>
      (audit.causeRef as Record<string, unknown> | null)?.versionId ===
        roundTrippedRestoreVersion?.id
    )).toMatchObject({
      actorType: "user",
      action: "workout_session.snapshot_restore",
      entityId: sessionId,
      causeRef: expect.objectContaining({
        sourceVersionId: restoreVersions[0].id,
        sourceSnapshotId: transitionSnapshot.snapshotId,
        sourceHistoryRevision: 4,
        resultHistoryRevision: 5,
      }),
    });
    },
    30_000,
  );

  it.each(["history", "full"] as const)(
    "appends a monotonic snapshot transition when earlier corrected timestamps become effective (%s)",
    async (scope) => {
      const firstCorrectionId = crypto.randomUUID();
      const first = await correctCompletedWorkoutTiming(
        db,
        userId,
        {
          sessionId,
          clientMutationId: firstCorrectionId,
          expectedHistoryRevision: 0,
          reviewed: true,
          expected: {
            startedAtISO: "2026-07-01T14:00:00.000Z",
            finishedAtISO: "2026-07-01T15:00:00.000Z",
            timezone: "America/Toronto",
            localDate: "2026-07-01",
            precision: "instant",
            excludeDurationFromAnalytics: false,
          },
          proposed: {
            timezone: "America/Toronto",
            localDate: "2026-07-01",
            timing: {
              precision: "instant",
              localStartTime: "09:30:00",
              ambiguityChoice: null,
              durationSeconds: 3_600,
            },
          },
        },
        new Date("2026-08-10T18:00:00.000Z"),
      );
      expect(first).toMatchObject({ ok: true, historyRevision: 1 });

      const source = await createDataSnapshot(
        db,
        userId,
        { name: "Earlier corrected source timestamps", reason: "manual" },
        {
          store,
          keyring,
          now: new Date("2026-08-10T18:01:00.000Z"),
          appVersion: "workout-timing-monotonic-restore",
        },
      );
      if (!source.ok) throw new Error(source.reason);

      const secondCorrectionId = crypto.randomUUID();
      const second = await correctCompletedWorkoutTiming(
        db,
        userId,
        {
          sessionId,
          clientMutationId: secondCorrectionId,
          expectedHistoryRevision: 1,
          reviewed: true,
          expected: {
            startedAtISO: "2026-07-01T13:30:00.000Z",
            finishedAtISO: "2026-07-01T14:30:00.000Z",
            timezone: "America/Toronto",
            localDate: "2026-07-01",
            precision: "instant",
            excludeDurationFromAnalytics: false,
          },
          proposed: {
            timezone: "America/Toronto",
            localDate: "2026-06-30",
            timing: {
              precision: "instant",
              localStartTime: "10:00:00",
              ambiguityChoice: null,
              durationSeconds: 3_600,
            },
          },
        },
        new Date("2026-08-10T18:02:00.000Z"),
      );
      expect(second).toMatchObject({ ok: true, historyRevision: 2 });

      const preview = await getSnapshotRestorePreview(
        db,
        userId,
        source.snapshotId,
        scope,
        { store, keyring },
      );
      const restored = await restoreDataSnapshot(
        db,
        userId,
        {
          snapshotId: source.snapshotId,
          scope,
          previewFingerprint: preview.fingerprint,
          confirmation: "RESTORE",
        },
        { store, keyring, appVersion: "workout-timing-monotonic-restore" },
      );
      if (!restored.ok) throw new Error(restored.reason);
      expect(await db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
      })).toMatchObject({
        startedAt: new Date("2026-07-01T13:30:00.000Z"),
        finishedAt: new Date("2026-07-01T14:30:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-01",
        performedTimePrecision: "instant",
        historyRevision: 3,
      });

      const timingVersions = (
        await db.query.recordVersions.findMany({
          where: eq(recordVersions.userId, userId),
        })
      ).filter((version) =>
        version.entityType === "workout_session" &&
        version.entityId === sessionId
      );
      expect(timingVersions.map((version) => version.id)).toEqual(
        expect.arrayContaining([firstCorrectionId, secondCorrectionId]),
      );
      const restoreVersions = timingVersions.filter(
        (version) => version.action === "workout_session.snapshot_restore",
      );
      expect(restoreVersions).toHaveLength(1);
      expect(restoreVersions[0]).toMatchObject({
        sourceVersionId: firstCorrectionId,
        beforeData: expect.objectContaining({
          local_date: "2026-06-30",
          history_revision: 2,
        }),
        afterData: expect.objectContaining({
          local_date: "2026-07-01",
          history_revision: 3,
        }),
        changedFields: expect.arrayContaining([
          "started_at",
          "finished_at",
          "local_date",
          "history_revision",
        ]),
      });
      expect(new Date(String(restoreVersions[0].beforeData.started_at))).toEqual(
        new Date("2026-06-30T14:00:00.000Z"),
      );
      expect(new Date(String(restoreVersions[0].beforeData.finished_at))).toEqual(
        new Date("2026-06-30T15:00:00.000Z"),
      );
      expect(new Date(String(restoreVersions[0].afterData.started_at))).toEqual(
        new Date("2026-07-01T13:30:00.000Z"),
      );
      expect(new Date(String(restoreVersions[0].afterData.finished_at))).toEqual(
        new Date("2026-07-01T14:30:00.000Z"),
      );
      expect(
        (await db.query.auditLogs.findMany({
          where: eq(auditLogs.userId, userId),
        })).find((audit) =>
          (audit.causeRef as Record<string, unknown> | null)?.versionId ===
            restoreVersions[0].id
        ),
      ).toMatchObject({
        actorType: "user",
        action: "workout_session.snapshot_restore",
        entityId: sessionId,
        causeRef: expect.objectContaining({
          sourceVersionId: firstCorrectionId,
          sourceSnapshotId: source.snapshotId,
          sourceHistoryRevision: 2,
          resultHistoryRevision: 3,
        }),
      });
      expect(await db.query.progressionJobs.findFirst({
        where: (job, { and, eq }) => and(
          eq(job.sessionId, sessionId),
          eq(job.sourceSessionRevision, 3),
        ),
      })).toBeDefined();

      const recursiveSnapshot = await createDataSnapshot(
        db,
        userId,
        { name: "Recaptured source timestamp transition", reason: "manual" },
        {
          store,
          keyring,
          now: new Date("2026-08-10T18:02:30.000Z"),
          appVersion: "workout-timing-monotonic-restore",
        },
      );
      if (!recursiveSnapshot.ok) throw new Error(recursiveSnapshot.reason);

      const repeatedPreview = await getSnapshotRestorePreview(
        db,
        userId,
        source.snapshotId,
        scope,
        { store, keyring },
      );
      const repeated = await restoreDataSnapshot(
        db,
        userId,
        {
          snapshotId: source.snapshotId,
          scope,
          previewFingerprint: repeatedPreview.fingerprint,
          confirmation: "RESTORE",
        },
        { store, keyring, appVersion: "workout-timing-monotonic-restore" },
      );
      expect(repeated).toMatchObject({ ok: true, scope });
      expect(await db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
      })).toMatchObject({
        startedAt: new Date("2026-07-01T13:30:00.000Z"),
        finishedAt: new Date("2026-07-01T14:30:00.000Z"),
        historyRevision: 3,
      });
      expect((await db.query.recordVersions.findMany({
        where: eq(recordVersions.userId, userId),
      })).filter(
        (version) => version.action === "workout_session.snapshot_restore",
      )).toHaveLength(1);

      const stalePreview = await getSnapshotRestorePreview(
        db,
        userId,
        recursiveSnapshot.snapshotId,
        scope,
        { store, keyring },
      );
      const thirdCorrectionId = crypto.randomUUID();
      const third = await correctCompletedWorkoutTiming(
        db,
        userId,
        {
          sessionId,
          clientMutationId: thirdCorrectionId,
          expectedHistoryRevision: 3,
          reviewed: true,
          expected: {
            startedAtISO: "2026-07-01T13:30:00.000Z",
            finishedAtISO: "2026-07-01T14:30:00.000Z",
            timezone: "America/Toronto",
            localDate: "2026-07-01",
            precision: "instant",
            excludeDurationFromAnalytics: false,
          },
          proposed: {
            timezone: "America/Toronto",
            localDate: "2026-06-29",
            timing: {
              precision: "instant",
              localStartTime: "10:00:00",
              ambiguityChoice: null,
              durationSeconds: 3_600,
            },
          },
        },
        new Date("2026-08-10T18:03:00.000Z"),
      );
      expect(third).toMatchObject({ ok: true, historyRevision: 4 });
      const stale = await restoreDataSnapshot(
        db,
        userId,
        {
          snapshotId: recursiveSnapshot.snapshotId,
          scope,
          previewFingerprint: stalePreview.fingerprint,
          confirmation: "RESTORE",
        },
        { store, keyring, appVersion: "workout-timing-monotonic-restore" },
      );
      expect(stale).toMatchObject({ ok: false });
      expect(stale.ok ? "" : stale.reason).toContain("changed after this preview");
      expect(await db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
      })).toMatchObject({
        startedAt: new Date("2026-06-29T14:00:00.000Z"),
        finishedAt: new Date("2026-06-29T15:00:00.000Z"),
        historyRevision: 4,
      });

      const recursivePreview = await getSnapshotRestorePreview(
        db,
        userId,
        recursiveSnapshot.snapshotId,
        scope,
        { store, keyring },
      );
      const recursiveRestored = await restoreDataSnapshot(
        db,
        userId,
        {
          snapshotId: recursiveSnapshot.snapshotId,
          scope,
          previewFingerprint: recursivePreview.fingerprint,
          confirmation: "RESTORE",
        },
        { store, keyring, appVersion: "workout-timing-monotonic-restore" },
      );
      if (!recursiveRestored.ok) throw new Error(recursiveRestored.reason);
      expect(await db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
      })).toMatchObject({
        startedAt: new Date("2026-07-01T13:30:00.000Z"),
        finishedAt: new Date("2026-07-01T14:30:00.000Z"),
        localDate: "2026-07-01",
        historyRevision: 5,
      });
      const recursiveRestoreVersions = (
        await db.query.recordVersions.findMany({
          where: eq(recordVersions.userId, userId),
        })
      ).filter(
        (version) => version.action === "workout_session.snapshot_restore",
      );
      expect(recursiveRestoreVersions).toHaveLength(2);
      expect(recursiveRestoreVersions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: restoreVersions[0].id }),
        expect.objectContaining({
          sourceVersionId: restoreVersions[0].id,
          beforeData: expect.objectContaining({ history_revision: 4 }),
          afterData: expect.objectContaining({ history_revision: 5 }),
        }),
      ]));
      expect((await db.query.recordVersions.findMany({
        where: eq(recordVersions.userId, userId),
      })).map((version) => version.id)).toEqual(
        expect.arrayContaining([
          firstCorrectionId,
          secondCorrectionId,
          thirdCorrectionId,
        ]),
      );

      const finalCapture = await captureUserSnapshot(
        db,
        userId,
        new Date("2026-08-10T18:04:00.000Z"),
        "workout-timing-monotonic-restore",
      );
      expect(() => validateSnapshotPayload(finalCapture, userId)).not.toThrow();
      expect((
        finalCapture.tables.record_versions as Array<Record<string, unknown>>
      ).filter(
        (version) => version.action === "workout_session.snapshot_restore",
      )).toHaveLength(2);
    },
    30_000,
  );

  it("refuses restored lineage when a retained source Program ID belongs to another account", async () => {
    const sourceProgramId = crypto.randomUUID();
    const sourceVersionId = crypto.randomUUID();
    const sourceDayLineageId = crypto.randomUUID();
    await db
      .update(workoutSessions)
      .set({
        sourceProgramId,
        sourceProgramVersionId: sourceVersionId,
        sourceDayLineageId,
      })
      .where(eq(workoutSessions.id, sessionId));
    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Retained source lineage", reason: "manual" },
      { store, keyring, appVersion: "test" },
    );
    if (!created.ok) throw new Error(created.reason);

    await db
      .update(workoutSessions)
      .set({
        sourceProgramId: null,
        sourceProgramVersionId: null,
        sourceDayLineageId: null,
      })
      .where(eq(workoutSessions.id, sessionId));
    const [otherOwner] = await db
      .insert(users)
      .values({ email: `snapshot-other-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(programs).values({
      id: sourceProgramId,
      userId: otherOwner.id,
      name: "Another account's Program",
      status: "archived",
      archivedAt: new Date(),
    });

    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "history",
      { store, keyring },
    );
    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "test" },
    );

    expect(restored).toMatchObject({ ok: false });
    expect(
      await db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
      }),
    ).toMatchObject({
      sourceProgramId: null,
      sourceProgramVersionId: null,
      sourceDayLineageId: null,
    });
  }, 30_000);

  it("restores custom exact rules without rolling back release-owned global rules", async () => {
    const [globalExercise] = await db
      .insert(exercises)
      .values({
        userId: null,
        name: `Released cable movement ${crypto.randomUUID()}`,
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "cable",
      })
      .returning({ id: exercises.id });
    await db.insert(exerciseExecutionRequirements).values([
      {
        exerciseId: globalExercise.id,
        requiredProfileKind: "cable_machine",
        requiresKnownGeometry: true,
        reviewNotes: "released rule at backup time",
        reviewedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      {
        exerciseId,
        requiredProfileKind: "plate_loaded_implement",
        reviewNotes: "owned rule at backup time",
        reviewedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);

    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Exact-rule ownership boundary", reason: "manual" },
      { store, keyring, appVersion: "exact-rule-ownership" },
    );
    if (!created.ok) throw new Error(created.reason);

    await db
      .update(exerciseExecutionRequirements)
      .set({
        requiredProfileKind: "cable_machine_v2",
        reviewNotes: "newer released global rule",
        updatedAt: new Date("2026-07-22T00:00:00.000Z"),
      })
      .where(eq(exerciseExecutionRequirements.exerciseId, globalExercise.id));
    await db
      .update(exerciseExecutionRequirements)
      .set({
        requiredProfileKind: "changed_owned_rule",
        reviewNotes: "changed after backup",
        updatedAt: new Date("2026-07-22T00:00:00.000Z"),
      })
      .where(eq(exerciseExecutionRequirements.exerciseId, exerciseId));

    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "full",
      { store, keyring },
    );
    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "exact-rule-ownership-restore" },
    );
    if (!restored.ok) throw new Error(restored.reason);

    const [globalRule, ownedRule] = await Promise.all([
      db.query.exerciseExecutionRequirements.findFirst({
        where: eq(exerciseExecutionRequirements.exerciseId, globalExercise.id),
      }),
      db.query.exerciseExecutionRequirements.findFirst({
        where: eq(exerciseExecutionRequirements.exerciseId, exerciseId),
      }),
    ]);
    expect(globalRule).toMatchObject({
      requiredProfileKind: "cable_machine_v2",
      reviewNotes: "newer released global rule",
    });
    expect(ownedRule).toMatchObject({
      requiredProfileKind: "plate_loaded_implement",
      reviewNotes: "owned rule at backup time",
    });
  }, 30_000);

  it("rejects malformed or checksum-tampered historical equipment evidence", async () => {
    const payload = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-22T01:00:00.000Z"),
      "equipment-integrity",
    );
    const geometry: SessionEquipmentGeometrySnapshot = {
      version: 1,
      kind: "plate_loaded_implement",
      loadingKind: "ez",
      emptyWeight: 18,
      collarWeight: 0,
      unit: "lb",
      sharedPlatePoolCompatible: true,
      compatiblePlates: [
        { denomination: 1.25, quantity: 2, unit: "lb" },
        { denomination: 2.5, quantity: 2, unit: "lb" },
      ],
    };
    const equipmentItemId = crypto.randomUUID();
    const identity = buildSessionEquipmentConfigurationIdentity({
      equipmentItemId,
      equipmentLabel: "18 lb EZ curl bar",
      equipmentDefinitionKey: "ez-curl-bar",
      attachmentItemId: null,
      attachmentLabel: null,
      attachmentDefinitionKey: null,
      attachmentKind: null,
      geometry,
    });
    payload.tables.session_equipment_snapshots = [{
      id: crypto.randomUUID(),
      user_id: userId,
      session_id: sessionId,
      session_exercise_id: sessionExerciseId,
      equipment_item_id: equipmentItemId,
      load_profile_id: crypto.randomUUID(),
      attachment_item_id: null,
      attachment_profile_id: null,
      equipment_label: "18 lb EZ curl bar",
      equipment_definition_key: "ez-curl-bar",
      attachment_label: null,
      attachment_definition_key: null,
      profile_kind: "plate_loaded_implement",
      geometry_certainty: "known",
      unit: "lb",
      selection_provenance: "user_selected",
      configuration_revision: 1,
      configuration_hash: sha256Hex(
        Buffer.from(canonicalJson(identity), "utf8"),
      ),
      geometry_version: 1,
      geometry_snapshot: geometry,
      created_at: "2026-07-22T01:00:00.000Z",
    }];
    expect(() => validateSnapshotPayload(payload, userId)).not.toThrow();

    const tamperedLabel = structuredClone(payload);
    (tamperedLabel.tables.session_equipment_snapshots[0] as Record<string, unknown>)
      .equipment_label = "Different bar";
    expect(() => validateSnapshotPayload(tamperedLabel, userId)).toThrow(
      /checksum/i,
    );

    const malformedGeometry = structuredClone(payload);
    const malformed = (
      malformedGeometry.tables.session_equipment_snapshots[0] as Record<string, unknown>
    ).geometry_snapshot as typeof geometry;
    malformed.compatiblePlates.push({ ...malformed.compatiblePlates[0] });
    expect(() => validateSnapshotPayload(malformedGeometry, userId)).toThrow(
      /malformed historical geometry/i,
    );
  }, 30_000);

  it("round-trips durable workout groups, occurrences, receipts, and performed links", async () => {
    const [group] = await db
      .insert(sessionExerciseGroups)
      .values({
        sessionId,
        provenance: "program",
        name: "Snapshot tri-set",
        orderIdx: 0,
        plannedRounds: 2,
        memberCount: 3,
        restBetweenMembersSec: 20,
        restBetweenRoundsSec: 90,
      })
      .returning({ id: sessionExerciseGroups.id });
    await db
      .update(sessionExercises)
      .set({ groupSnapshotId: group.id, groupMemberOrderIdx: 0 })
      .where(eq(sessionExercises.id, sessionExerciseId));
    await db.update(completedSets).set({ reps: 0 }).where(eq(completedSets.id, setId));
    const [occurrence] = await db
      .insert(sessionOccurrences)
      .values({
        sessionId,
        sessionExerciseId,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exerciseId,
        plannedRepsMin: 8,
        plannedRepsMax: 10,
        groupSnapshotId: group.id,
        groupRound: 1,
        groupMemberOrderIdx: 0,
        outcome: "completed",
        revision: 1,
        resolvedAt: new Date("2026-07-01T14:05:00.000Z"),
        completedSetId: setId,
      })
      .returning({ id: sessionOccurrences.id });
    const [receipt] = await db
      .insert(sessionOccurrenceMutations)
      .values({
        occurrenceId: occurrence.id,
        clientKey: "snapshot-occurrence-complete",
        operation: "complete",
        canonicalPayloadHash: "stage3-snapshot-payload-hash",
        expectedRevision: 0,
        resultingRevision: 1,
        resultCode: "applied",
      })
      .returning({ id: sessionOccurrenceMutations.id });
    const [equipmentSnapshot] = await db
      .insert(schema.sessionEquipmentSnapshots)
      .values({
        userId,
        sessionId,
        sessionExerciseId,
        equipmentLabel: "Snapshot bodyweight setup",
        profileKind: "bodyweight",
        geometryCertainty: "known",
        selectionProvenance: "user_selected",
        configurationRevision: 1,
        configurationHash: "e".repeat(64),
        geometryVersion: 1,
        geometrySnapshot: { version: 1, kind: "bodyweight" },
      })
      .returning({ id: schema.sessionEquipmentSnapshots.id });
    await client.exec(
      "SELECT set_config('workout_tracker.authorized_delete', 'snapshot_restore', false)"
    );
    await db
      .update(completedSets)
      .set({
        equipmentSnapshotId: equipmentSnapshot.id,
        loadEntryMeaning: "total_system",
      })
      .where(eq(completedSets.id, setId));
    await db
      .update(sessionOccurrences)
      .set({ equipmentSnapshotId: equipmentSnapshot.id })
      .where(eq(sessionOccurrences.id, occurrence.id));
    await client.exec(
      "SELECT set_config('workout_tracker.authorized_delete', '', false)"
    );
    const [equipmentReceipt] = await db
      .insert(schema.sessionEquipmentSelectionReceipts)
      .values({
        userId,
        sessionId,
        sessionExerciseId,
        clientKey: crypto.randomUUID(),
        operation: "select",
        canonicalPayloadHash: "f".repeat(64),
        resultingSnapshotId: equipmentSnapshot.id,
        resultCode: "applied",
      })
      .returning({ id: schema.sessionEquipmentSelectionReceipts.id });
    const [unlinkedSet] = await db
      .insert(completedSets)
      .values({
        sessionExerciseId,
        setNo: 2,
        weight: 61.25,
        weightUnit: "kg",
        reps: 8,
        clientKey: crypto.randomUUID(),
      })
      .returning({ id: completedSets.id });
    const painRecordedAt = new Date("2026-07-01T14:05:30.000Z");
    const [pain] = await db
      .insert(painLogs)
      .values({
        userId,
        sessionId,
        exerciseId,
        completedSetId: setId,
        bodyPart: "knee",
        severity: 4,
        source: "set_flag",
        createdAt: painRecordedAt,
      })
      .returning({ id: painLogs.id });
    const linkedNote = await createContextualNote(db, userId, {
      clientKey: crypto.randomUUID(),
      body: "Exact performed-result observation",
      coachVisible: true,
      inputMode: "typed",
      recordedAt: "2026-07-01T14:06:00.000Z",
      attachmentKind: "set",
      sessionId,
      sessionExerciseId,
      occurrenceId: occurrence.id,
      completedSetId: setId,
      capturedContext: {
        schemaVersion: 1,
        destination: "history",
        workflow: "completed_set_review",
        workoutPhase: "completed",
        originatedFromSimulation: false,
        programDay: null,
        plannedExercise: { id: exerciseId, name: "Snapshot Squat" },
        performedExercise: { id: exerciseId, name: "Snapshot Squat" },
        occurrence: {
          id: occurrence.id,
          kind: "working_set",
          ordinal: 0,
          outcome: "completed",
        },
        loadRepetitions: {
          performedLoad: 61.25,
          performedLoadUnit: "kg",
          performedReps: 8,
        },
        restContext: null,
        reviewContext: null,
      },
    });
    if (linkedNote.outcome !== "saved") {
      throw new Error("Exact-link contextual note fixture failed.");
    }
    await db.update(workoutSessions).set({
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 3_600,
      activeDurationBasis: "owner_reported",
    }).where(eq(workoutSessions.id, sessionId));

    const canonical = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-21T16:15:00.000Z"),
      "stage3-link-validation",
    );
    const crossedContextualLink = structuredClone(canonical);
    const crossedNote = (
      crossedContextualLink.tables.contextual_notes as Array<Record<string, unknown>>
    ).find((row) => row.id === linkedNote.note.id);
    if (!crossedNote) throw new Error("Snapshot contextual note fixture is missing.");
    crossedNote.completed_set_id = unlinkedSet.id;
    expect(() => validateSnapshotPayload(crossedContextualLink, userId)).toThrow(
      /crosses workout attachment boundaries/i,
    );
    const missingPainSet = structuredClone(canonical);
    const painRow = (
      missingPainSet.tables.pain_logs as Array<Record<string, unknown>>
    ).find((row) => row.id === pain.id);
    if (!painRow) throw new Error("Snapshot pain fixture is missing.");
    painRow.completed_set_id = crypto.randomUUID();
    expect(() => validateSnapshotPayload(missingPainSet, userId)).toThrow(
      /pain_logs has a broken completed_sets reference/i,
    );
    const missingPerformedLink = structuredClone(canonical);
    const missingLinkOccurrence = (
      missingPerformedLink.tables.session_occurrences as Array<Record<string, unknown>>
    ).find((row) => row.id === occurrence.id);
    if (!missingLinkOccurrence) throw new Error("Snapshot occurrence fixture is missing.");
    missingLinkOccurrence.completed_set_id = null;
    expect(() => validateSnapshotPayload(missingPerformedLink, userId)).toThrow(
      /performed-result link/i,
    );

    const forbiddenPerformedLink = structuredClone(canonical);
    const forbiddenLinkOccurrence = (
      forbiddenPerformedLink.tables.session_occurrences as Array<Record<string, unknown>>
    ).find((row) => row.id === occurrence.id);
    if (!forbiddenLinkOccurrence) throw new Error("Snapshot occurrence fixture is missing.");
    forbiddenLinkOccurrence.kind = "exercise_warmup";
    expect(() => validateSnapshotPayload(forbiddenPerformedLink, userId)).toThrow(
      /performed-result link/i,
    );

    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Stage 3 occurrence source", reason: "manual", pinned: true },
      { store, keyring, appVersion: "stage3-round-trip" }
    );
    if (!created.ok) throw new Error(created.reason);

    await db.update(completedSets).set({ reps: 4 }).where(eq(completedSets.id, setId));
    await db.update(workoutSessions).set({
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: null,
      activeDurationBasis: "interruption_unknown",
    }).where(eq(workoutSessions.id, sessionId));
    await db
      .update(painLogs)
      .set({
        severity: 1,
        createdAt: new Date("2026-07-20T14:05:30.000Z"),
      })
      .where(eq(painLogs.id, pain.id));

    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "full",
      { store, keyring }
    );
    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "stage3-round-trip" }
    );

    if (!restored.ok) throw new Error(restored.reason);
    expect(restored).toMatchObject({ ok: true, scope: "full" });
    expect(
      await db.query.sessionExerciseGroups.findFirst({
        where: eq(sessionExerciseGroups.id, group.id),
      })
    ).toMatchObject({ restBetweenRoundsSec: 90 });
    expect(
      await db.query.sessionOccurrences.findFirst({
        where: eq(sessionOccurrences.id, occurrence.id),
      })
    ).toMatchObject({
      outcome: "completed",
      outcomeNote: null,
      revision: 1,
      completedSetId: setId,
    });
    expect(
      await db.query.sessionOccurrenceMutations.findFirst({
        where: eq(sessionOccurrenceMutations.id, receipt.id),
      })
    ).toMatchObject({ canonicalPayloadHash: "stage3-snapshot-payload-hash" });
    expect(
      await db.query.completedSets.findFirst({ where: eq(completedSets.id, setId) })
    ).toMatchObject({
      reps: 0,
      equipmentSnapshotId: equipmentSnapshot.id,
      loadEntryMeaning: "total_system",
    });
    expect(
      await db.query.painLogs.findFirst({ where: eq(painLogs.id, pain.id) })
    ).toMatchObject({
      sessionId,
      exerciseId,
      completedSetId: setId,
      severity: 4,
      source: "set_flag",
      createdAt: painRecordedAt,
    });
    expect(
      await db.query.sessionEquipmentSnapshots.findFirst({
        where: eq(schema.sessionEquipmentSnapshots.id, equipmentSnapshot.id),
      })
    ).toMatchObject({ equipmentLabel: "Snapshot bodyweight setup" });
    expect(
      await db.query.sessionEquipmentSelectionReceipts.findFirst({
        where: eq(
          schema.sessionEquipmentSelectionReceipts.id,
          equipmentReceipt.id
        ),
      })
    ).toMatchObject({ resultingSnapshotId: equipmentSnapshot.id });
    expect(
      await db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
      })
    ).toMatchObject({
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 3_600,
      activeDurationBasis: "owner_reported",
    });
  }, 30_000);

  it("restores populated schema-22 warm-up text into structured items and captures it again", async () => {
    const activated = await activateProgramAtomically(db, {
      userId,
      loadUnit: "kg",
      programName: "Legacy warm-up compatibility",
      days: [{
        name: "Day A",
        warmupNotes: "Arm circles and band pull-aparts",
        exercises: [{
          exerciseId,
          sets: 2,
          repMin: 8,
          repMax: 10,
          targetLoad: 20,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Schema-22 warm-up restore fixture",
      auditAction: "program.activate",
      auditSummary: "Created schema-22 warm-up restore fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    const template = await db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, activated.programVersionId),
    });
    if (!template) throw new Error("Warm-up template fixture is missing.");
    await db
      .update(workoutSessions)
      .set({ dayWarmupNotes: "Five minutes easy movement" })
      .where(eq(workoutSessions.id, sessionId));

    const legacy = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-21T16:00:00.000Z"),
      "schema-22-warmup-source"
    );
    legacy.schemaVersion = "22";
    for (const row of legacy.tables.workout_templates as Array<Record<string, unknown>>) {
      delete row.warmup_items;
    }
    for (const row of legacy.tables.workout_sessions as Array<Record<string, unknown>>) {
      delete row.day_warmup_items;
    }
    delete legacy.tables.session_exercise_groups;
    delete legacy.tables.session_occurrences;
    delete legacy.tables.session_occurrence_mutations;

    const expectedTemplateItem = {
      key: template.id,
      label: "Arm circles and band pull-aparts",
      reps: null,
      load: null,
      loadUnit: null,
      loadPercent: null,
      loadText: null,
      notes: null,
    };
    const expectedSessionItem = {
      key: sessionId,
      label: "Five minutes easy movement",
      reps: null,
      load: null,
      loadUnit: null,
      loadPercent: null,
      loadText: null,
      notes: null,
    };
    const upgraded = upgradeSnapshotPayload(legacy);
    expect(upgraded.tables.workout_templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: template.id, warmup_items: [expectedTemplateItem] }),
      ])
    );
    expect(upgraded.tables.workout_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sessionId, day_warmup_items: [expectedSessionItem] }),
      ])
    );

    const plaintext = Buffer.from(canonicalJson(legacy), "utf8");
    const encrypted = encryptSnapshotBytes(
      plaintext,
      key,
      "v1",
      Buffer.alloc(12, 22)
    );
    const snapshotId = crypto.randomUUID();
    const objectPath = `snapshots/${userId}/${snapshotId}.wtbk`;
    const stored = await store.put(objectPath, encrypted);
    await db.insert(dataSnapshots).values({
      id: snapshotId,
      userId,
      name: "Populated schema-22 warm-ups",
      reason: "compatibility-test",
      status: "verified",
      objectPath,
      objectEtag: stored.etag,
      appVersion: "schema-22-warmup-source",
      schemaVersion: "22",
      sizeBytes: encrypted.length,
      recordCounts: snapshotRecordCounts(legacy),
      plaintextChecksum: sha256Hex(plaintext),
      ciphertextChecksum: sha256Hex(encrypted),
      encryptionAlgorithm: SNAPSHOT_ENCRYPTION_ALGORITHM,
      encryptionKeyVersion: "v1",
      snapshotKind: "user",
      verifiedAt: new Date("2026-07-21T16:01:00.000Z"),
    });

    await db
      .update(workoutSessions)
      .set({ dayWarmupNotes: "Changed later", dayWarmupItems: [] })
      .where(eq(workoutSessions.id, sessionId));

    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      snapshotId,
      "full",
      { store, keyring }
    );
    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "schema-22-warmup-round-trip" }
    );
    expect(restored).toMatchObject({ ok: true, scope: "full" });
    expect(
      await db.query.workoutTemplates.findFirst({
        where: eq(workoutTemplates.id, template.id),
      })
    ).toMatchObject({
      warmupNotes: "Arm circles and band pull-aparts",
      warmupItems: [expectedTemplateItem],
    });
    expect(
      await db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, sessionId),
      })
    ).toMatchObject({
      dayWarmupNotes: "Five minutes easy movement",
      dayWarmupItems: [expectedSessionItem],
    });

    const roundTrip = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-21T16:05:00.000Z"),
      "schema-22-warmup-round-trip"
    );
    expect(roundTrip.tables.workout_templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: template.id, warmup_items: [expectedTemplateItem] }),
      ])
    );
    expect(roundTrip.tables.workout_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sessionId, day_warmup_items: [expectedSessionItem] }),
      ])
    );
  }, 30_000);

  it("round-trips a current lift-anchored warm-up through snapshot restore", async () => {
    const dayLineageId = crypto.randomUUID();
    const slotLineageId = crypto.randomUUID();
    const warmupItems = [{
      key: crypto.randomUUID(),
      beforeSlotLineageId: slotLineageId,
      label: "Empty bar before squat",
      reps: 10,
      load: null,
      loadUnit: null,
      loadPercent: null,
      loadText: "Empty bar",
      notes: null,
    }];
    const slotIntent = {
      ...createSuggestedSlotIntent(3, 0),
      idealDose: { unit: "sets" as const, value: 3 },
      substitutionPolicy: "no_substitution" as const,
      omissionPolicy: "never" as const,
      calibrationEligible: false,
    };
    const dayIntent = createSuggestedDayIntent([{
      lineageId: slotLineageId,
      sets: 3,
      restSec: 120,
    }]);
    const activated = await activateProgramAtomically(db, {
      userId,
      loadUnit: "kg",
      programName: "Anchored snapshot Program",
      days: [{
        lineageId: dayLineageId,
        name: "Day A",
        warmupItems,
        intent: dayIntent,
        exercises: [{
          lineageId: slotLineageId,
          exerciseId,
          sets: 3,
          repMin: 5,
          repMax: 5,
          targetLoad: 60,
          targetLoadUnit: "kg",
          restSec: 120,
          supersetKey: null,
          notes: null,
          intent: slotIntent,
        }],
      }],
      changeSummary: "Snapshot anchored warm-up fixture",
      auditAction: "program.activate",
      auditSummary: "Snapshot anchored warm-up fixture",
      expectedCurrentProgramVersionId: null,
      structuredIntentReviewed: true,
    });
    if (!activated.ok) throw new Error(activated.reason);

    const payload = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-08-11T16:00:00.000Z"),
      "pii01-anchored-warmup-source",
    );
    expect(payload.tables.workout_templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ warmup_items: warmupItems }),
      ]),
    );
    const plaintext = Buffer.from(canonicalJson(payload), "utf8");
    const encrypted = encryptSnapshotBytes(
      plaintext,
      key,
      "v1",
      Buffer.alloc(12, 23),
    );
    const snapshotId = crypto.randomUUID();
    const objectPath = `snapshots/${userId}/${snapshotId}.wtbk`;
    const stored = await store.put(objectPath, encrypted);
    await db.insert(dataSnapshots).values({
      id: snapshotId,
      userId,
      name: "Anchored warm-up round trip",
      reason: "compatibility-test",
      status: "verified",
      objectPath,
      objectEtag: stored.etag,
      appVersion: payload.appVersion,
      schemaVersion: payload.schemaVersion,
      sizeBytes: encrypted.length,
      recordCounts: snapshotRecordCounts(payload),
      plaintextChecksum: sha256Hex(plaintext),
      ciphertextChecksum: sha256Hex(encrypted),
      encryptionAlgorithm: SNAPSHOT_ENCRYPTION_ALGORITHM,
      encryptionKeyVersion: "v1",
      snapshotKind: "user",
      verifiedAt: new Date("2026-08-11T16:01:00.000Z"),
    });

    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      snapshotId,
      "full",
      { store, keyring },
    );
    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "pii01-anchored-warmup-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "full" });
    expect(await db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, activated.programVersionId),
    })).toMatchObject({
      lineageId: dayLineageId,
      warmupItems,
    });
    const recaptured = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-08-11T16:05:00.000Z"),
      "pii01-anchored-warmup-round-trip",
    );
    expect(recaptured.tables.workout_templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ warmup_items: warmupItems }),
      ]),
    );
  }, 30_000);

  it("accepts a canonical payload exactly at the configured size limit", async () => {
    const capturedAt = new Date("2026-07-11T12:00:00.000Z");
    const appVersion = "exact-size-limit";
    const payload = await captureUserSnapshot(
      db,
      userId,
      capturedAt,
      appVersion
    );
    const exactSizeBytes = Buffer.byteLength(canonicalJson(payload), "utf8");

    const result = await createDataSnapshot(
      db,
      userId,
      { name: "Exactly within the safety budget", reason: "manual" },
      {
        store,
        keyring,
        now: capturedAt,
        appVersion,
        testSerializedSizeLimitBytes: exactSizeBytes,
      }
    );

    expect(result).toMatchObject({ ok: true });
    expect(await db.query.dataSnapshots.findMany()).toHaveLength(1);
    expect(store.objects.size).toBe(1);
  }, 30_000);

  it("refuses a canonical payload one byte over budget before metadata, object storage, or encryption", async () => {
    const capturedAt = new Date("2026-07-11T12:00:00.000Z");
    const appVersion = "over-size-limit";
    const payload = await captureUserSnapshot(
      db,
      userId,
      capturedAt,
      appVersion
    );
    const exactSizeBytes = Buffer.byteLength(canonicalJson(payload), "utf8");
    let keyResolveCalls = 0;
    const countingKeyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve() {
        keyResolveCalls += 1;
        return key;
      },
    };

    const result = await createDataSnapshot(
      db,
      userId,
      { name: "One byte over the safety budget", reason: "manual" },
      {
        store,
        keyring: countingKeyring,
        now: capturedAt,
        appVersion,
        testSerializedSizeLimitBytes: exactSizeBytes - 1,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      code: "snapshot_payload_too_large",
    });
    expect(result.ok ? "" : result.reason).toBe(
      "This snapshot is too large to create safely. Its saved data exceeds the 64 MiB limit."
    );
    expect(keyResolveCalls).toBe(0);
    expect(await db.query.dataSnapshots.findMany()).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  }, 30_000);

  it("does not let the injected test limit relax the production ceiling", async () => {
    const result = await createDataSnapshot(
      db,
      userId,
      { name: "Invalid relaxed limit", reason: "manual" },
      {
        store,
        keyring,
        testSerializedSizeLimitBytes:
          SNAPSHOT_SERIALIZED_SIZE_LIMIT_BYTES + 1,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      code: "snapshot_configuration_failed",
    });
    expect(await db.query.dataSnapshots.findMany()).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  }, 30_000);

  it("returns an encryption failure through the snapshot result path", async () => {
    const invalidKeyring: SnapshotKeyring = {
      currentVersion: "missing",
      resolve() {
        return Buffer.alloc(31);
      },
    };
    const result = await createDataSnapshot(
      db,
      userId,
      { name: "Encryption must fail safely", reason: "manual" },
      { store, keyring: invalidKeyring, appVersion: "encryption-failure" }
    );

    expect(result).toMatchObject({
      ok: false,
      code: "snapshot_encryption_failed",
      reason: "Snapshot encryption key must be 32 bytes.",
    });
    expect(await db.query.dataSnapshots.findMany()).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  }, 30_000);

  it("returns a depth refusal through the result path before metadata, storage, or encryption", async () => {
    let deepValue: Record<string, unknown> = { leaf: "private value" };
    for (let depth = 0; depth < 80; depth += 1) {
      deepValue = { nested: deepValue };
    }
    await db.insert(recordVersions).values({
      userId,
      entityType: "health_activity",
      entityId: activityId,
      action: "updated",
      beforeData: {},
      afterData: deepValue,
      changedFields: ["notes"],
    });
    let keyResolveCalls = 0;
    const countingKeyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve() {
        keyResolveCalls += 1;
        return key;
      },
    };

    const result = await createDataSnapshot(
      db,
      userId,
      { name: "Depth-limited snapshot", reason: "manual" },
      { store, keyring: countingKeyring, appVersion: "depth-limit" }
    );

    expect(result).toMatchObject({
      ok: false,
      code: "snapshot_serialization_failed",
      reason: "Snapshot exceeds the maximum supported nesting depth.",
    });
    expect(keyResolveCalls).toBe(0);
    expect(await db.query.dataSnapshots.findMany()).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  }, 30_000);

  it("reads a verified snapshot whose stored JSON uses the previous key order", async () => {
    const capturedAt = new Date("2026-07-11T12:00:00.000Z");
    const payload = await captureUserSnapshot(
      db,
      userId,
      capturedAt,
      "legacy-order"
    );
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    expect(plaintext.toString("utf8")).not.toBe(canonicalJson(payload));
    const encrypted = encryptSnapshotBytes(
      plaintext,
      key,
      "v1",
      Buffer.alloc(12, 19)
    );
    const snapshotId = crypto.randomUUID();
    const objectPath = `snapshots/${userId}/${snapshotId}.wtbk`;
    const stored = await store.put(objectPath, encrypted);
    await db.insert(dataSnapshots).values({
      id: snapshotId,
      userId,
      name: "Previous canonical ordering",
      reason: "compatibility-test",
      status: "verified",
      objectPath,
      objectEtag: stored.etag,
      appVersion: "legacy-order",
      schemaVersion: payload.schemaVersion,
      sizeBytes: encrypted.length,
      recordCounts: snapshotRecordCounts(payload),
      plaintextChecksum: sha256Hex(plaintext),
      ciphertextChecksum: sha256Hex(encrypted),
      encryptionAlgorithm: SNAPSHOT_ENCRYPTION_ALGORITHM,
      encryptionKeyVersion: "v1",
      snapshotKind: "user",
      verifiedAt: capturedAt,
    });

    const verified = await readVerifiedDataSnapshot(db, userId, snapshotId, {
      store,
      keyring,
    });
    expect(verified.payload.tables.completed_sets).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: setId })])
    );
    await expect(
      getSnapshotRestorePreview(db, userId, snapshotId, "full", {
        store,
        keyring,
      })
    ).resolves.toMatchObject({ snapshot: { id: snapshotId } });
  }, 30_000);

  it("keeps restore previews stable while raw AI and import material is scrubbed", async () => {
    const createdAt = new Date("2026-07-01T12:00:00.000Z");
    await db.insert(aiParsingEvents).values({
      userId,
      scope: "log",
      task: "log_parse",
      rawInput: "temporary private workout input",
      rawOutput: "temporary private model output",
      parsedJson: { kind: "temporary" },
      ambiguities: [{ field: "weight" }],
      createdAt,
    });
    await db.insert(importEvents).values({
      userId,
      source: "csv",
      rawPayload: "temporary private import payload",
      parsedPayload: { rows: [{ temporary: true }] },
      status: "confirmed",
      createdAt,
    });
    await db.insert(coachingInsights).values({
      userId,
      kind: "qa",
      contentMd: "Durable answer",
      dataDigest: {
        question: "Private question",
        fullModelContext: "temporary private coaching context",
        windowDays: 30,
      },
      createdAt,
    });

    const first = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-11T12:00:00.000Z"),
      "privacy-stability-a"
    );
    const second = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-11T12:05:00.000Z"),
      "privacy-stability-b"
    );
    expect(first.tables.ai_parsing_events).toEqual(
      second.tables.ai_parsing_events
    );
    expect(first.tables.import_events).toEqual(second.tables.import_events);
    expect(first.tables.coaching_insights).toEqual(
      second.tables.coaching_insights
    );
    const scrubbedAi = first.tables.ai_parsing_events[0] as Record<
      string,
      unknown
    >;
    const scrubbedImport = first.tables.import_events[0] as Record<
      string,
      unknown
    >;
    expect(scrubbedAi).toMatchObject({
      raw_input: "",
      raw_output: null,
      parsed_json: null,
      ambiguities: [],
    });
    expect(new Date(String(scrubbedAi.raw_redacted_at)).toISOString()).toBe(
      createdAt.toISOString()
    );
    expect(scrubbedImport).toMatchObject({
      raw_payload: "",
      parsed_payload: null,
    });
    expect(new Date(String(scrubbedImport.raw_redacted_at)).toISOString()).toBe(
      createdAt.toISOString()
    );
    expect(first.tables.coaching_insights[0]).toMatchObject({
      data_digest: {
        schemaVersion: "2",
        question: "Private question",
        generatedAt: expect.any(String),
        windowDays: 30,
        modelContextRetained: false,
      },
    });

    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Privacy-safe restore source", reason: "manual" },
      { store, keyring, appVersion: "privacy-stability" }
    );
    if (!created.ok) throw new Error(created.reason);
    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "full",
      { store, keyring }
    );
    const repeatedPreview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "full",
      { store, keyring }
    );
    expect(repeatedPreview.fingerprint).toBe(preview.fingerprint);
    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "privacy-stability" }
    );
    if (!restored.ok) throw new Error(restored.reason);
    expect(restored).toMatchObject({ ok: true, scope: "full" });
  }, 30_000);

  it("backs up and atomically restores durable progression work and its recommendation link", async () => {
    const [job] = await db
      .insert(progressionJobs)
      .values({
        userId,
        sessionId,
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
      })
      .returning({ id: progressionJobs.id });
    const inputLineageId = crypto.randomUUID();
    await db.insert(progressionJobInputSessions).values({
      jobId: job.id,
      userId,
      sourceSlotLineageId: inputLineageId,
      sessionId,
      historyRevision: 0,
    });
    const [recommendation] = await db
      .insert(recommendations)
      .values({
        userId,
        source: "rule",
        status: "approved",
        decidedAt: new Date(),
        ruleId: "snapshot-progression",
        progressionJobId: job.id,
        payload: {
          kind: "hold",
          templateExerciseId: crypto.randomUUID(),
          reason: "Snapshot fixture",
        },
        reason: "Keep the current target",
        evidence: { signals: {}, sessionIds: [sessionId] },
      })
      .returning({ id: recommendations.id });

    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Progression restore source", reason: "manual" },
      { store, keyring, appVersion: "test" }
    );
    if (!created.ok) throw new Error(created.reason);

    await db
      .update(recommendations)
      .set({ progressionJobId: null })
      .where(eq(recommendations.id, recommendation.id));
    await db
      .update(progressionJobs)
      .set({
        status: "completed",
        attempts: 1,
        completedAt: new Date("2026-07-13T14:00:00.000Z"),
      })
      .where(eq(progressionJobs.id, job.id));
    await db
      .update(progressionJobInputSessions)
      .set({ historyRevision: 1 })
      .where(eq(progressionJobInputSessions.jobId, job.id));

    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "history",
      { store, keyring }
    );
    expect(
      preview.tables.find(({ table }) => table === "progression_jobs")
    ).toMatchObject({ updated: 1 });
    expect(
      preview.tables.find(({ table }) => table === "recommendations")
    ).toMatchObject({ updated: 1 });
    expect(
      preview.tables.find(
        ({ table }) => table === "progression_job_input_sessions"
      )
    ).toMatchObject({ updated: 1 });

    const failed = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      {
        store,
        keyring,
        appVersion: "test",
        failAfterTable: "progression_job_input_sessions",
      }
    );
    expect(failed).toMatchObject({ ok: false });
    expect(
      await db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, job.id),
      })
    ).toMatchObject({ status: "completed", attempts: 1 });
    expect(
      await db.query.recommendations.findFirst({
        where: eq(recommendations.id, recommendation.id),
      })
    ).toMatchObject({ progressionJobId: null });
    expect(
      await db.query.progressionJobInputSessions.findFirst({
        where: eq(progressionJobInputSessions.jobId, job.id),
      })
    ).toMatchObject({ historyRevision: 1 });

    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "test" }
    );
    if (!restored.ok) throw new Error(restored.reason);
    expect(restored).toMatchObject({ ok: true, scope: "history" });
    expect(
      await db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, job.id),
      })
    ).toMatchObject({ status: "pending", attempts: 0, completedAt: null });
    expect(
      await db.query.recommendations.findFirst({
        where: eq(recommendations.id, recommendation.id),
      })
    ).toMatchObject({ progressionJobId: job.id });
    expect(
      await db.query.progressionJobInputSessions.findFirst({
        where: eq(progressionJobInputSessions.jobId, job.id),
      })
    ).toMatchObject({
      userId,
      sourceSlotLineageId: inputLineageId,
      sessionId,
      historyRevision: 0,
    });

    await db
      .update(progressionJobInputSessions)
      .set({ historyRevision: 2 })
      .where(eq(progressionJobInputSessions.jobId, job.id));
    const fullPreview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "full",
      { store, keyring }
    );
    const fullRestored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: fullPreview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "test" }
    );
    if (!fullRestored.ok) throw new Error(fullRestored.reason);
    expect(
      await db.query.progressionJobInputSessions.findFirst({
        where: eq(progressionJobInputSessions.jobId, job.id),
      })
    ).toMatchObject({ historyRevision: 0 });

    const crossOwner = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-13T14:10:00.000Z"),
      "cross-owner-progression-input"
    );
    (
      crossOwner.tables.progression_job_input_sessions[0] as Record<
        string,
        unknown
      >
    ).user_id = crypto.randomUUID();
    expect(() => validateSnapshotPayload(crossOwner, userId)).toThrow(
      /another user's record/
    );
  }, 30_000);

  it("preserves a later Program decision and adaptation during an older History restore", async () => {
    const firstProgram = await activateProgramAtomically(db, {
      userId,
      loadUnit: "kg",
      programName: "History restore P1",
      days: [{
        name: "Day A",
        exercises: [{
          exerciseId,
          sets: 3,
          repMin: 8,
          repMax: 12,
          targetLoad: 20,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Create restore decision fixture",
      auditAction: "program.activate",
      auditSummary: "Created restore decision fixture",
    });
    if (!firstProgram.ok) throw new Error(firstProgram.reason);
    const sourceTemplate = await db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, firstProgram.programVersionId),
    });
    if (!sourceTemplate) throw new Error("Source template missing.");
    const sourceSlot = await db.query.workoutTemplateExercises.findFirst({
      where: eq(workoutTemplateExercises.workoutTemplateId, sourceTemplate.id),
    });
    if (!sourceSlot) throw new Error("Source slot missing.");

    const [recommendation] = await db
      .insert(recommendations)
      .values({
        userId,
        source: "rule",
        status: "pending",
        ruleId: "history-restore-decision",
        sourceTemplateExerciseId: sourceSlot.id,
        sourceSlotLineageId: sourceSlot.lineageId,
        payload: {
          kind: "load_change",
          templateExerciseId: sourceSlot.id,
          fromLoad: 20,
          toLoad: 22.5,
          loadUnit: "kg",
        },
        reason: "Increase the next working load",
        evidence: { signals: {}, sessionIds: [sessionId] },
      })
      .returning({ id: recommendations.id });

    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Before accepted adaptation", reason: "manual" },
      { store, keyring, appVersion: "gauntlet-b-history-restore" }
    );
    if (!created.ok) throw new Error(created.reason);

    const secondProgram = await activateProgramAtomically(db, {
      userId,
      loadUnit: "kg",
      programName: "History restore P2",
      days: [{
        name: "Day A",
        exercises: [{
          exerciseId,
          sets: 3,
          repMin: 8,
          repMax: 12,
          targetLoad: 22.5,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Accept the proposed load",
      auditAction: "program.activate",
      auditSummary: "Activated accepted restore fixture",
    });
    if (!secondProgram.ok) throw new Error(secondProgram.reason);
    const decidedAt = new Date("2026-07-20T12:00:00.000Z");
    await db
      .update(recommendations)
      .set({ status: "approved", decidedAt })
      .where(eq(recommendations.id, recommendation.id));
    const [decision] = await db
      .insert(userDecisions)
      .values({
        recommendationId: recommendation.id,
        decision: "approve",
        reviewSnapshot: { schemaVersion: "legacy-unknown" },
        decidedAt,
      })
      .returning({ id: userDecisions.id });
    const [adaptation] = await db
      .insert(adaptationEvents)
      .values({
        userId,
        recommendationId: recommendation.id,
        beforeSnapshot: { programVersionId: firstProgram.programVersionId },
        afterSnapshot: { programVersionId: secondProgram.programVersionId },
        appliedAt: decidedAt,
      })
      .returning({ id: adaptationEvents.id });
    await db
      .update(completedSets)
      .set({ reps: 3 })
      .where(eq(completedSets.id, setId));

    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "history",
      { store, keyring }
    );
    expect(
      preview.tables.find(({ table }) => table === "recommendations")
    ).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(
      preview.tables.find(({ table }) => table === "user_decisions")
    ).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 1 });
    expect(
      preview.tables.find(({ table }) => table === "adaptation_events")
    ).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 1 });

    const failed = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      {
        store,
        keyring,
        appVersion: "gauntlet-b-history-restore",
        failAfterTable: "adaptation_events",
      }
    );
    expect(failed).toMatchObject({ ok: false });
    expect(
      await db.query.completedSets.findFirst({ where: eq(completedSets.id, setId) })
    ).toMatchObject({ reps: 3 });

    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "gauntlet-b-history-restore" }
    );
    expect(restored).toMatchObject({ ok: true, scope: "history" });
    expect(
      await db.query.programs.findFirst({
        where: eq(programs.id, secondProgram.programId),
      })
    ).toMatchObject({
      status: "active",
      currentVersionId: secondProgram.programVersionId,
    });
    expect(
      await db.query.recommendations.findFirst({
        where: eq(recommendations.id, recommendation.id),
      })
    ).toMatchObject({ status: "approved", decidedAt });
    expect(
      await db.query.userDecisions.findFirst({
        where: eq(userDecisions.id, decision.id),
      })
    ).toBeDefined();
    expect(
      await db.query.adaptationEvents.findFirst({
        where: eq(adaptationEvents.id, adaptation.id),
      })
    ).toBeDefined();
    expect(
      await db.query.completedSets.findFirst({ where: eq(completedSets.id, setId) })
    ).toMatchObject({ reps: 8 });
  }, 45_000);

  it("keeps schema-6 and schema-7 snapshots previewable after later safety ledgers are added", async () => {
    const capturedAt = new Date("2026-07-11T12:00:00.000Z");
    const current = await captureUserSnapshot(db, userId, capturedAt, "legacy-test");
    for (const [index, schemaVersion] of ["6", "7"].entries()) {
      const legacyTables = { ...current.tables };
      if (schemaVersion === "6") {
        delete legacyTables.recovery_runs;
        delete legacyTables.integrity_findings;
      }
      const legacy = { ...current, schemaVersion, tables: legacyTables };
      const plaintext = Buffer.from(canonicalJson(legacy), "utf8");
      const encrypted = encryptSnapshotBytes(
        plaintext,
        key,
        "v1",
        Buffer.alloc(12, 7 + index)
      );
      const snapshotId = crypto.randomUUID();
      const objectPath = `snapshots/${userId}/${snapshotId}.wtbk`;
      const stored = await store.put(objectPath, encrypted);
      await db.insert(dataSnapshots).values({
        id: snapshotId,
        userId,
        name: `Pinned production schema ${schemaVersion}`,
        reason: "legacy-test",
        status: "verified",
        objectPath,
        objectEtag: stored.etag,
        appVersion: "legacy-test",
        schemaVersion,
        sizeBytes: encrypted.length,
        recordCounts: snapshotRecordCounts(legacy),
        plaintextChecksum: sha256Hex(plaintext),
        ciphertextChecksum: sha256Hex(encrypted),
        encryptionAlgorithm: SNAPSHOT_ENCRYPTION_ALGORITHM,
        encryptionKeyVersion: "v1",
        snapshotKind: "user",
        pinned: true,
        verifiedAt: capturedAt,
      });

      const preview = await getSnapshotRestorePreview(
        db,
        userId,
        snapshotId,
        "full",
        { store, keyring }
      );
      expect(preview.snapshot.schemaVersion).toBe(schemaVersion);
      expect(preview.totals.unchanged).toBeGreaterThan(0);
    }
  }, 30_000);

  it("conservatively upgrades schema 16 Program history to stable per-row lineage", async () => {
    const legacy = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-14T12:00:00.000Z"),
      "schema-16-program"
    );
    legacy.schemaVersion = "16";
    delete legacy.tables.program_drafts;
    const programId = crypto.randomUUID();
    const versionIds = [crypto.randomUUID(), crypto.randomUUID()];
    const templateIds = [crypto.randomUUID(), crypto.randomUUID()];
    const groupId = crypto.randomUUID();
    const slotIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const exerciseId = String(
      (legacy.tables.exercises[0] as Record<string, unknown>).id
    );
    legacy.tables.programs = [
      {
        id: programId,
        user_id: userId,
        name: "Legacy Program",
        status: "active",
        archived_at: null,
        archive_operation_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    legacy.tables.program_versions = versionIds.map((id, index) => ({
      id,
      program_id: programId,
      version_no: index + 1,
      activated_at: null,
      source_import_event_id: null,
      change_summary: null,
      created_at: `2026-0${index + 1}-01T00:00:00.000Z`,
    }));
    legacy.tables.workout_templates = templateIds.map((id, index) => ({
      id,
      program_version_id: versionIds[index],
      name: `Day ${index + 1}`,
      order_idx: 0,
      notes: null,
    }));
    legacy.tables.superset_groups = [
      {
        id: groupId,
        workout_template_id: templateIds[1],
        order_idx: 0,
        rest_after_round_sec: 90,
      },
    ];
    legacy.tables.workout_template_exercises = slotIds.map((id, index) => ({
      id,
      workout_template_id: templateIds[index === 0 ? 0 : 1],
      exercise_id: exerciseId,
      order_idx: index === 2 ? 1 : 0,
      superset_group_id: index === 0 ? null : groupId,
      rest_sec: 90,
      notes: null,
      warmup_notes: null,
      warmup_sets: [],
      set_notes: [null],
    }));
    legacy.tables.exercise_prescriptions = slotIds.map((slotId, index) => ({
      id: crypto.randomUUID(),
      template_exercise_id: slotId,
      sets: 1,
      rep_range_min: 8,
      rep_range_max: 8,
      target_load: null,
      target_load_unit: null,
      progression_rule_id: "double_progression",
      effective_from: `2026-0${Math.min(index + 1, 2)}-01T00:00:00.000Z`,
      superseded_by_id: null,
      created_at: `2026-0${Math.min(index + 1, 2)}-01T00:00:00.000Z`,
    }));

    const upgraded = upgradeSnapshotPayload(legacy);
    expect(upgraded.schemaVersion).toBe("33");
    expect(upgraded.tables.program_drafts).toEqual([]);
    expect(upgraded.tables.programs[0]).toMatchObject({
      current_version_id: versionIds[1],
    });
    expect(upgraded.tables.program_versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: versionIds[0],
          name: "Legacy Program",
          publication_source: "setup",
          activated_at: "2026-01-01T00:00:00.000Z",
          document_schema_version: 1,
          publication_preflight: null,
        }),
      ])
    );
    expect(upgraded.tables.workout_templates).toEqual(
      templateIds.map((id) => expect.objectContaining({ id, lineage_id: id, intent: null }))
    );
    expect(upgraded.tables.superset_groups[0]).toMatchObject({
      id: groupId,
      lineage_id: groupId,
      name: "Superset 1",
    });
    expect(upgraded.tables.workout_template_exercises).toEqual(
      slotIds.map((id) => expect.objectContaining({ id, lineage_id: id, intent: null }))
    );
    expect(() => validateSnapshotPayload(upgraded, userId)).not.toThrow();
  });

  it("normalizes every schema 17 float load field to two decimals", async () => {
    const legacy = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-14T12:00:00.000Z"),
      "schema-17-loads"
    );
    const overflow = structuredClone(legacy);
    (overflow.tables.session_exercises[0] as Record<string, unknown>)
      .target_load = 100_000;
    expect(() => validateSnapshotPayload(overflow, userId)).toThrow(
      /supported load range/i
    );
    const noncanonical = structuredClone(legacy);
    (noncanonical.tables.session_exercises[0] as Record<string, unknown>)
      .target_load = 10.075;
    expect(() => validateSnapshotPayload(noncanonical, userId)).toThrow(
      /exact two-decimal load/i
    );

    legacy.schemaVersion = "17";
    legacy.tables.barbell_configs = [
      {
        bar_weight: Math.fround(20.3),
        collar_weight: Math.fround(2.3),
      },
    ];
    legacy.tables.plate_inventory = [
      { denomination: Math.fround(32.3), count_per_side: 3 },
    ];
    legacy.tables.exercise_equipment_requirements = [
      { min_weight: Math.fround(12.3) },
    ];
    legacy.tables.exercise_prescriptions = [
      { target_load: Math.fround(42.3), target_load_unit: "kg" },
    ];
    const exercise = legacy.tables.session_exercises[0] as Record<
      string,
      unknown
    >;
    exercise.target_load = Math.fround(52.3);

    const upgraded = upgradeSnapshotPayload(legacy);

    expect(upgraded.schemaVersion).toBe("33");
    expect(upgraded.tables.barbell_configs[0]).toMatchObject({
      bar_weight: 20.3,
      collar_weight: 2.3,
    });
    expect(upgraded.tables.plate_inventory[0]).toMatchObject({
      denomination: 32.3,
      quantity: 6,
    });
    expect(upgraded.tables.plate_inventory[0]).not.toHaveProperty(
      "count_per_side"
    );
    expect(upgraded.tables.exercise_equipment_requirements[0]).toMatchObject({
      min_weight: 12.3,
    });
    expect(upgraded.tables.exercise_prescriptions[0]).toMatchObject({
      target_load: 42.3,
    });
    expect(upgraded.tables.session_exercises[0]).toMatchObject({
      target_load: 52.3,
    });

  });

  it("upgrades schema 23 equipment evidence conservatively to schema 24", async () => {
    const legacy = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-14T12:00:00.000Z"),
      "schema-23-equipment"
    );
    legacy.schemaVersion = "23";
    legacy.tables.plate_inventory = [
      {
        id: crypto.randomUUID(),
        user_id: userId,
        denomination: 20,
        quantity: 2,
      },
    ];

    const legacyTables = legacy.tables as Record<
      string,
      Array<Record<string, unknown>>
    >;
    for (const table of [
      "plate_loaded_machine_profiles",
      "plate_loaded_machine_compatible_plates",
      "cable_machine_profiles",
      "cable_stack_steps",
      "cable_attachment_profiles",
      "cable_attachment_compatibilities",
      "exercise_execution_requirements",
      "session_equipment_snapshots",
      "session_equipment_selection_receipts",
    ]) {
      delete legacyTables[table];
    }
    for (const exercise of legacyTables.session_exercises) {
      delete exercise.current_equipment_snapshot_id;
    }
    for (const completed of legacyTables.completed_sets) {
      delete completed.equipment_snapshot_id;
      delete completed.load_entry_meaning;
    }
    for (const occurrence of legacyTables.session_occurrences) {
      delete occurrence.equipment_snapshot_id;
    }

    const upgraded = upgradeSnapshotPayload(legacy);

    expect(upgraded.schemaVersion).toBe("33");
    expect(upgraded.tables.plate_inventory[0]).toMatchObject({ unit: "kg" });
    expect(upgraded.tables.session_exercises).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ current_equipment_snapshot_id: null }),
      ])
    );
    expect(upgraded.tables.completed_sets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          equipment_snapshot_id: null,
          load_entry_meaning: "legacy_unknown",
        }),
      ])
    );
    for (const table of [
      "plate_loaded_machine_profiles",
      "plate_loaded_machine_compatible_plates",
      "cable_machine_profiles",
      "cable_stack_steps",
      "cable_attachment_profiles",
      "cable_attachment_compatibilities",
      "exercise_execution_requirements",
      "session_equipment_snapshots",
      "session_equipment_selection_receipts",
    ]) {
      expect(
        (upgraded.tables as Record<string, Array<Record<string, unknown>>>)[
          table
        ]
      ).toEqual([]);
    }
    expect(() => validateSnapshotPayload(upgraded, userId)).not.toThrow();
  });

  it("restores full and history scopes from both current and previous canonical formats", async () => {
    await db.insert(sessionOccurrences).values({
      sessionId,
      sessionExerciseId,
      kind: "working_set",
      origin: "imported",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exerciseId,
      outcome: "completed",
      completedSetId: setId,
      resolvedAt: new Date("2026-07-01T15:00:00.000Z"),
    });
    const source = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-13T12:00:00.000Z"),
      "cross-version-source"
    );
    let nonce = 20;
    for (const schemaVersion of ["26", "25", "18", "17", "16"] as const) {
      for (const scope of ["full", "history"] as const) {
        const payload = structuredClone(source);
        payload.schemaVersion = schemaVersion;
        if (schemaVersion === "26") {
          for (const completed of payload.tables.completed_sets as Array<
            Record<string, unknown>
          >) {
            delete completed.performed_semantics_version;
            delete completed.performed_load_type;
            delete completed.performed_load_semantics;
          }
        }
        if (schemaVersion === "25") {
          delete payload.tables.progression_job_input_sessions;
          for (const workout of payload.tables.workout_sessions as Array<
            Record<string, unknown>
          >) {
            delete workout.history_revision;
            delete workout.performed_time_precision;
            delete workout.source_program_id;
            delete workout.source_program_version_id;
            delete workout.source_day_lineage_id;
          }
          for (const sessionExercise of payload.tables
            .session_exercises as Array<Record<string, unknown>>) {
            delete sessionExercise.source_slot_lineage_id;
          }
          for (const completed of payload.tables.completed_sets as Array<
            Record<string, unknown>
          >) {
            delete completed.observed_completed_at;
            delete completed.observed_completion_provenance;
            delete completed.observed_completion_quality;
          }
          for (const job of payload.tables.progression_jobs as Array<
            Record<string, unknown>
          >) {
            delete job.source_session_revision;
          }
        }
        // Every version in this loop is now an older canonical format, so each
        // one exercises the upgrade path up to the current schema.
        const exercise = (
          payload.tables.session_exercises as Array<Record<string, unknown>>
        ).find((row) => row.id === sessionExerciseId);
        if (!exercise) throw new Error("Snapshot exercise fixture is missing.");
        exercise.target_load = Math.fround(32.3);
        const upgraded = upgradeSnapshotPayload(payload);
        expect(upgraded.schemaVersion).toBe("33");
        expect(upgraded.tables.session_exercises).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: sessionExerciseId,
              target_load: 32.3,
            }),
          ])
        );
        const plaintext = Buffer.from(canonicalJson(payload), "utf8");
        const encrypted = encryptSnapshotBytes(
          plaintext,
          key,
          "v1",
          Buffer.alloc(12, nonce)
        );
        nonce += 1;
        const snapshotId = crypto.randomUUID();
        const objectPath = `snapshots/${userId}/${snapshotId}.wtbk`;
        const stored = await store.put(objectPath, encrypted);
        await db.insert(dataSnapshots).values({
          id: snapshotId,
          userId,
          name: `${scope} schema ${schemaVersion}`,
          reason: "manual",
          status: "verified",
          objectPath,
          objectEtag: stored.etag,
          appVersion: "cross-version-test",
          schemaVersion,
          sizeBytes: encrypted.length,
          recordCounts: snapshotRecordCounts(payload),
          plaintextChecksum: sha256Hex(plaintext),
          ciphertextChecksum: sha256Hex(encrypted),
          encryptionAlgorithm: SNAPSHOT_ENCRYPTION_ALGORITHM,
          encryptionKeyVersion: "v1",
          snapshotKind: "user",
          verifiedAt: new Date("2026-07-13T12:01:00.000Z"),
        });

        const [currentSet, currentSession] = await Promise.all([
          db.query.completedSets.findFirst({
            where: eq(completedSets.id, setId),
          }),
          db.query.workoutSessions.findFirst({
            where: eq(workoutSessions.id, sessionId),
          }),
        ]);
        if (!currentSet || !currentSession) {
          throw new Error("Cross-version restore fixture disappeared.");
        }
        const correction = await updateSetWithVersion(
          db,
          userId,
          setId,
          {
            weight: 999,
            weightUnit: currentSet.weightUnit,
            reps: currentSet.reps,
            distanceKm: currentSet.distanceKm,
            durationSeconds: currentSet.durationSeconds,
            rpe: currentSet.rpe,
            note: currentSet.note,
          },
          "set.completed_correction",
          {
            expected: {
              weight: currentSet.weight,
              weightUnit: currentSet.weightUnit,
              reps: currentSet.reps,
              distanceKm: currentSet.distanceKm,
              durationSeconds: currentSet.durationSeconds,
              rpe: currentSet.rpe,
              note: currentSet.note,
            },
            expectedHistoryRevision: currentSession.historyRevision,
            clientMutationId: crypto.randomUUID(),
            correctionEvidence: {
              category: "measurement_entry",
              reasonNote: "Synthetic cross-version restore divergence",
              source: "workout_history",
            },
          },
        );
        if (!correction.ok) {
          throw new Error(`Could not prepare restore divergence: ${correction.reason}`);
        }
        await db
          .update(healthActivities)
          .set({ title: "Changed before cross-version restore" })
          .where(eq(healthActivities.id, activityId));
        if (scope === "full") {
          await db
            .update(userProfiles)
            .set({ fontSize: "large" })
            .where(eq(userProfiles.userId, userId));
        }

        const preview = await getSnapshotRestorePreview(
          db,
          userId,
          snapshotId,
          scope,
          { store, keyring }
        );
        const restored = await restoreDataSnapshot(
          db,
          userId,
          {
            snapshotId,
            scope,
            previewFingerprint: preview.fingerprint,
            confirmation: "RESTORE",
          },
          { store, keyring, appVersion: "cross-version-test" }
        );
        if (!restored.ok) {
          throw new Error(
            `Schema ${schemaVersion} ${scope} restore failed: ${restored.reason}`
          );
        }
        expect(restored).toMatchObject({ ok: true, scope });
        expect(
          await db.query.completedSets.findFirst({
            where: eq(completedSets.id, setId),
          })
        ).toMatchObject({ weight: 61.25, weightUnit: "kg" });
        expect(
          await db.query.sessionExercises.findFirst({
            where: eq(sessionExercises.id, sessionExerciseId),
          })
        ).toMatchObject({ targetLoad: 32.3, targetLoadUnit: "kg" });
        expect(
          await db.query.healthActivities.findFirst({
            where: eq(healthActivities.id, activityId),
          })
        ).toMatchObject({ title: "Known-good walk" });
        if (scope === "full") {
          expect(
            await db.query.userProfiles.findFirst({
              where: eq(userProfiles.userId, userId),
            })
          ).toMatchObject({ fontSize: "default" });
        }
        expect(await evaluateApplicationIntegrity(db, userId)).toEqual([]);
      }
    }
  }, 60_000);

  it("round-trips non-null performed semantics through current full and history restores", async () => {
    const [versionedSet] = await db
      .insert(completedSets)
      .values({
        sessionExerciseId,
        setNo: 2,
        weight: 70,
        weightUnit: "kg",
        reps: 6,
        metricType: "weight_reps",
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
      })
      .returning({ id: completedSets.id });
    await db.insert(sessionOccurrences).values({
      sessionId,
      sessionExerciseId,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 1,
      plannedExerciseId: exerciseId,
      outcome: "completed",
      resolvedAt: new Date("2026-07-01T15:00:00.000Z"),
      completedSetId: versionedSet.id,
    });
    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Versioned performed semantics", reason: "manual" },
      { store, keyring, appVersion: "schema-27-round-trip" },
    );
    if (!created.ok) throw new Error(created.reason);

    for (const scope of ["full", "history"] as const) {
      await db
        .update(completedSets)
        .set({ weight: 999 })
        .where(eq(completedSets.id, versionedSet.id));
      const preview = await getSnapshotRestorePreview(
        db,
        userId,
        created.snapshotId,
        scope,
        { store, keyring },
      );
      const restored = await restoreDataSnapshot(
        db,
        userId,
        {
          snapshotId: created.snapshotId,
          scope,
          previewFingerprint: preview.fingerprint,
          confirmation: "RESTORE",
        },
        { store, keyring, appVersion: "schema-27-round-trip" },
      );
      expect(restored).toMatchObject({ ok: true, scope });
      expect(
        await db.query.completedSets.findFirst({
          where: eq(completedSets.id, versionedSet.id),
        }),
      ).toMatchObject({
        weight: 70,
        metricType: "weight_reps",
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
      });
    }
  }, 30_000);

  it("rejects incoherent performed semantics before restore mutation", async () => {
    const payload = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-13T12:00:00.000Z"),
      "incoherent-performed-semantics",
    );
    const row = (
      payload.tables.completed_sets as Array<Record<string, unknown>>
    ).find((candidate) => candidate.id === setId);
    if (!row) throw new Error("Snapshot set fixture is missing.");
    row.performed_semantics_version = 1;
    row.performed_load_type = null;
    row.performed_load_semantics = "total";

    const plaintext = Buffer.from(canonicalJson(payload), "utf8");
    const encrypted = encryptSnapshotBytes(
      plaintext,
      key,
      "v1",
      Buffer.alloc(12, 99),
    );
    const snapshotId = crypto.randomUUID();
    const objectPath = `snapshots/${userId}/${snapshotId}.wtbk`;
    const stored = await store.put(objectPath, encrypted);
    await db.insert(dataSnapshots).values({
      id: snapshotId,
      userId,
      name: "Incoherent performed semantics",
      reason: "manual",
      status: "verified",
      objectPath,
      objectEtag: stored.etag,
      appVersion: "incoherent-performed-semantics",
      schemaVersion: "27",
      sizeBytes: encrypted.length,
      recordCounts: snapshotRecordCounts(payload),
      plaintextChecksum: sha256Hex(plaintext),
      ciphertextChecksum: sha256Hex(encrypted),
      encryptionAlgorithm: SNAPSHOT_ENCRYPTION_ALGORITHM,
      encryptionKeyVersion: "v1",
      snapshotKind: "user",
      verifiedAt: new Date("2026-07-13T12:01:00.000Z"),
    });
    await db
      .update(completedSets)
      .set({ weight: 777 })
      .where(eq(completedSets.id, setId));

    await expect(
      getSnapshotRestorePreview(db, userId, snapshotId, "history", {
        store,
        keyring,
      }),
    ).rejects.toThrow(/incoherent performed-semantics evidence/);
    expect(
      await db.query.completedSets.findFirst({
        where: eq(completedSets.id, setId),
      }),
    ).toMatchObject({ weight: 777, performedSemanticsVersion: null });
  }, 30_000);

  it("upgrades a schema-11 imported workout from its reviewed batch timezone", async () => {
    const legacy = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-11T12:00:00.000Z"),
      "legacy-test"
    );
    legacy.schemaVersion = "11";
    const profile = legacy.tables.user_profiles[0] as Record<string, unknown>;
    const workout = legacy.tables.workout_sessions[0] as Record<string, unknown>;
    const prescription = legacy.tables.exercise_prescriptions[0] as
      | Record<string, unknown>
      | undefined;
    const sessionExercise = legacy.tables.session_exercises[0] as Record<
      string,
      unknown
    >;
    delete profile.timezone;
    delete workout.timezone;
    delete workout.local_date;
    if (prescription) delete prescription.target_load_unit;
    sessionExercise.target_load = null;
    delete sessionExercise.target_load_unit;
    workout.import_batch_id = "reviewed-batch";
    legacy.tables.history_import_batches = [
      { id: "reviewed-batch", timezone: "America/Vancouver" },
    ];

    const upgraded = upgradeSnapshotPayload(legacy);
    expect(upgraded.schemaVersion).toBe("33");
    expect(upgraded.tables.user_profiles[0]).toMatchObject({
      timezone: "America/Toronto",
    });
    expect(upgraded.tables.workout_sessions[0]).toMatchObject({
      timezone: "America/Vancouver",
      local_date: "2026-07-01",
    });
    expect(upgraded.tables.completed_sets[0]).toMatchObject({
      weight: 61.25,
      weight_unit: "kg",
    });
    if (prescription) {
      expect(upgraded.tables.exercise_prescriptions[0]).toHaveProperty(
        "target_load_unit",
        null
      );
    }
    expect(upgraded.tables.session_exercises[0]).toHaveProperty(
      "target_load_unit",
      null
    );
  });

  it("refuses an older native snapshot whose workout timezone cannot be proven", async () => {
    const legacy = await captureUserSnapshot(
      db,
      userId,
      new Date("2026-07-11T12:00:00.000Z"),
      "legacy-test"
    );
    legacy.schemaVersion = "11";
    const workout = legacy.tables.workout_sessions[0] as Record<string, unknown>;
    delete workout.timezone;
    delete workout.local_date;

    expect(() => upgradeSnapshotPayload(legacy)).toThrow(
      /timezone cannot be proven/
    );
  });

  it("edits only searchable metadata and leaves protected verification fields unchanged", async () => {
    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Original", note: "Before", reason: "manual", pinned: false },
      { store, keyring, appVersion: "test" }
    );
    if (!created.ok) throw new Error(created.reason);
    const before = await db.query.dataSnapshots.findFirst({
      where: eq(dataSnapshots.id, created.snapshotId),
    });
    const updated = await updateDataSnapshotMetadata(db, userId, created.snapshotId, {
      name: "Renamed known good",
      note: "After",
      pinned: true,
    });
    expect(updated).toEqual({ ok: true });
    const after = await db.query.dataSnapshots.findFirst({
      where: eq(dataSnapshots.id, created.snapshotId),
    });
    expect(after).toMatchObject({ name: "Renamed known good", note: "After", pinned: true });
    expect(after?.objectPath).toBe(before?.objectPath);
    expect(after?.createdAt).toEqual(before?.createdAt);
    expect(after?.verifiedAt).toEqual(before?.verifiedAt);
    expect(after?.plaintextChecksum).toBe(before?.plaintextChecksum);
    expect(after?.ciphertextChecksum).toBe(before?.ciphertextChecksum);
    expect(after?.recordCounts).toEqual(before?.recordCounts);
  }, 30_000);

  it("never marks an unreadable stored copy as verified", async () => {
    store.corruptReads = true;
    const result = await createDataSnapshot(
      db,
      userId,
      { name: "Must fail", reason: "manual" },
      { store, keyring, appVersion: "test" }
    );
    expect(result.ok).toBe(false);
    const [metadata] = await db.query.dataSnapshots.findMany({
      where: eq(dataSnapshots.userId, userId),
    });
    expect(metadata.status).toBe("failed");
    expect(metadata.verifiedAt).toBeNull();
    expect(metadata.failureReason).toContain("checksum");
  }, 30_000);

  it("previews and fully restores the exact snapshot while preserving recovery records", async () => {
    const activated = await activateProgramAtomically(db, {
      userId,
      loadUnit: "kg",
      programName: "Restore compatibility",
      days: [{
        name: "Day A",
        exercises: [{
          exerciseId,
          sets: 3,
          repMin: 8,
          repMax: 12,
          targetLoad: 20,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Snapshot restore fixture",
      auditAction: "program.activate",
      auditSummary: "Created snapshot restore fixture",
    });
    if (!activated.ok) throw new Error(activated.reason);
    const draftState = await getOrCreateProgramDraft(db, userId);
    if (!draftState) throw new Error("Draft missing");

    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Full restore source", reason: "manual", pinned: true },
      { store, keyring, appVersion: "test" }
    );
    if (!created.ok) throw new Error(created.reason);

    const legacyDocument = structuredClone(draftState.draft.document);
    legacyDocument.days[0].exercises[0].targetLoad = 10.075;
    legacyDocument.days[0].exercises[0].targetLoadUnit = "kg";
    await db
      .update(programDrafts)
      .set({
        document: legacyDocument,
        contentHash: hashLegacyProgramDocument(legacyDocument),
      })
      .where(eq(programDrafts.id, draftState.draft.id));

    await db
      .update(userProfiles)
      .set({ fontSize: "large" })
      .where(eq(userProfiles.userId, userId));
    await db
      .update(completedSets)
      .set({ weight: 225, reps: 3 })
      .where(eq(completedSets.id, setId));
    await db
      .update(healthActivities)
      .set({ title: "Changed walk" })
      .where(eq(healthActivities.id, activityId));
    const [extraSession] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Remove me",
        status: "completed",
        startedAt: new Date("2026-07-03T14:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-03",
      })
      .returning({ id: workoutSessions.id });

    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "full",
      { store, keyring }
    );
    expect(preview.totals.updated).toBeGreaterThanOrEqual(3);
    expect(preview.totals.removed).toBeGreaterThanOrEqual(1);

    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "test" }
    );
    expect(restored).toMatchObject({ ok: true, scope: "full" });
    expect(
      await db.query.programDrafts.findFirst({
        where: eq(programDrafts.id, draftState.draft.id),
      })
    ).toMatchObject({ document: draftState.draft.document });
    expect(
      await db.query.userProfiles.findFirst({ where: eq(userProfiles.userId, userId) })
    ).toMatchObject({ fontSize: "default" });
    expect(
      await db.query.completedSets.findFirst({ where: eq(completedSets.id, setId) })
    ).toMatchObject({ weight: 61.25, weightUnit: "kg", reps: 8 });
    expect(
      await db.query.healthActivities.findFirst({ where: eq(healthActivities.id, activityId) })
    ).toMatchObject({ title: "Known-good walk" });
    expect(
      await db.query.workoutSessions.findFirst({ where: eq(workoutSessions.id, extraSession.id) })
    ).toBeUndefined();

    const snapshots = await db.query.dataSnapshots.findMany({
      where: eq(dataSnapshots.userId, userId),
    });
    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.snapshotId, status: "verified" }),
        expect.objectContaining({
          id: restored.ok ? restored.safetySnapshotId : "",
          status: "verified",
        }),
      ])
    );
  }, 30_000);

  it("restores history without rolling back current profile setup", async () => {
    const capturedContext = {
      schemaVersion: 1 as const,
      destination: "history" as const,
      workflow: "snapshot history fixture",
      workoutPhase: "review" as const,
      originatedFromSimulation: false,
      programDay: null,
      plannedExercise: null,
      performedExercise: null,
      occurrence: null,
      loadRepetitions: null,
      restContext: null,
      reviewContext: null,
    };
    const workoutNote = await createContextualNote(db, userId, {
      clientKey: crypto.randomUUID(),
      body: "Workout note from snapshot",
      coachVisible: true,
      inputMode: "typed",
      attachmentKind: "workout",
      sessionId,
      capturedContext,
      recordedAt: "2026-07-02T16:00:00.000Z",
    });
    const generalNote = await createContextualNote(db, userId, {
      clientKey: crypto.randomUUID(),
      body: "General note from snapshot",
      coachVisible: false,
      inputMode: "typed",
      attachmentKind: "general",
      capturedContext,
      recordedAt: "2026-07-02T16:01:00.000Z",
    });
    if (workoutNote.outcome !== "saved" || generalNote.outcome !== "saved") {
      throw new Error("Contextual note snapshot fixtures failed.");
    }
    const created = await createDataSnapshot(
      db,
      userId,
      { name: "History restore source", reason: "manual" },
      { store, keyring, appVersion: "test" }
    );
    if (!created.ok) throw new Error(created.reason);

    await editContextualNote(db, userId, {
      noteId: workoutNote.note.id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 1,
      body: "Changed workout note",
      coachVisible: true,
      inputMode: "typed",
    });
    await editContextualNote(db, userId, {
      noteId: generalNote.note.id,
      clientKey: crypto.randomUUID(),
      expectedRevision: 1,
      body: "Changed general note",
      coachVisible: false,
      inputMode: "typed",
    });

    await db
      .update(userProfiles)
      .set({ fontSize: "extra-large" })
      .where(eq(userProfiles.userId, userId));
    await db
      .update(completedSets)
      .set({ weight: 315, reps: 1 })
      .where(eq(completedSets.id, setId));
    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "history",
      { store, keyring }
    );
    expect(preview.tables.find((table) => table.table === "completed_sets")).toMatchObject({
      updated: 1,
    });
    expect(preview.tables.some((table) => table.table === "user_profiles")).toBe(false);
    expect(preview.tables.find((table) => table.table === "contextual_notes")).toMatchObject({
      updated: 1,
    });

    const restored = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "test" }
    );
    if (!restored.ok) throw new Error(restored.reason);
    expect(restored).toMatchObject({ ok: true, scope: "history" });
    expect(
      await db.query.completedSets.findFirst({ where: eq(completedSets.id, setId) })
    ).toMatchObject({ weight: 61.25, weightUnit: "kg", reps: 8 });
    expect(
      await db.query.userProfiles.findFirst({ where: eq(userProfiles.userId, userId) })
    ).toMatchObject({ fontSize: "extra-large" });
    expect(await db.query.contextualNotes.findFirst({
      where: eq(schema.contextualNotes.id, workoutNote.note.id),
    })).toMatchObject({ body: "Workout note from snapshot", revision: 1 });
    expect(await db.query.contextualNotes.findFirst({
      where: eq(schema.contextualNotes.id, generalNote.note.id),
    })).toMatchObject({ body: "Changed general note", revision: 2 });
  }, 30_000);

  it("rolls back every database change when a restore fails partway through", async () => {
    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Atomic failure source", reason: "manual" },
      { store, keyring, appVersion: "test" }
    );
    if (!created.ok) throw new Error(created.reason);
    await db
      .update(completedSets)
      .set({ weight: 405, reps: 1 })
      .where(eq(completedSets.id, setId));
    await db
      .update(healthActivities)
      .set({ title: "Keep this after failure" })
      .where(eq(healthActivities.id, activityId));
    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "history",
      { store, keyring }
    );

    const failed = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "test", failAfterTable: "completed_sets" }
    );
    expect(failed).toMatchObject({ ok: false });
    expect(failed.ok ? "" : failed.reason).toContain("Injected restore failure");
    expect(
      await db.query.completedSets.findFirst({ where: eq(completedSets.id, setId) })
    ).toMatchObject({ weight: 405, reps: 1 });
    expect(
      await db.query.healthActivities.findFirst({ where: eq(healthActivities.id, activityId) })
    ).toMatchObject({ title: "Keep this after failure" });
    expect(
      (await db.query.dataSnapshots.findMany({
        where: eq(dataSnapshots.userId, userId),
      })).filter((snapshot) => snapshot.status === "verified")
    ).toHaveLength(2);
  }, 30_000);

  it("rejects a stale preview before creating a safety copy", async () => {
    const created = await createDataSnapshot(
      db,
      userId,
      { name: "Stale preview source", reason: "manual" },
      { store, keyring, appVersion: "test" }
    );
    if (!created.ok) throw new Error(created.reason);
    const preview = await getSnapshotRestorePreview(
      db,
      userId,
      created.snapshotId,
      "history",
      { store, keyring }
    );
    await db
      .update(completedSets)
      .set({ weight: 500 })
      .where(eq(completedSets.id, setId));
    const result = await restoreDataSnapshot(
      db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "history",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "test" }
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.reason).toContain("changed after this preview");
    expect(await db.query.dataSnapshots.findMany()).toHaveLength(1);
  }, 30_000);
});
