import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLogs,
  completedSets,
  exercisePrescriptions,
  exercises,
  programs,
  programVersions,
  sessionCompilerProposals,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrences,
  supersetGroups,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import { createSuggestedDayIntent, createSuggestedSlotIntent } from "@/lib/program-document";
import { runProgramPreflight } from "@/lib/program-preflight";
import { acceptSessionCompilerProposal, createSessionCompilerProposal, discardSessionCompilerProposal } from "@/services/session-compiler";
import { getCurrentProgramDocument } from "@/services/program-documents";
import { loadProgramPreflightContext } from "@/services/program-preflight";
import { createMigratedTestDatabase, type TestDatabase } from "../helpers/database";
import { buildJsonBackup, buildSetsCsv } from "@/services/export";
import { archiveWorkoutRecord, restoreArchiveOperation } from "@/services/archive";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import {
  createDataSnapshot,
  readVerifiedDataSnapshot,
  type SnapshotKeyring,
} from "@/services/snapshots";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
} from "@/services/snapshot-restore";

describe("Session Compiler durable review and acceptance", () => {
  let database: TestDatabase;
  let userId: string;
  let programId: string;
  let versionId: string;
  let dayLineageId: string;
  let priorProgramEditor: string | undefined;
  let priorCompiler: string | undefined;

  beforeEach(async () => {
    priorProgramEditor = process.env.PROGRAM_EDITOR_ENABLED;
    priorCompiler = process.env.SESSION_COMPILER_ENABLED;
    process.env.PROGRAM_EDITOR_ENABLED = "true";
    process.env.SESSION_COMPILER_ENABLED = "true";
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db.insert(users).values({ email: `compiler-${crypto.randomUUID()}@example.com` }).returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId, timezone: "America/Toronto" });
    const exerciseRows: Array<{ id: string; name: string }> = [];
    for (const exercise of [
      { name: `Compiler anchor ${crypto.randomUUID()}`, movementPattern: "horizontal_push" as const, primaryMuscles: ["chest"], loadType: "barbell" as const, metricType: "weight_reps" as const, loadSemantics: "total" as const },
      { name: `Compiler accessory ${crypto.randomUUID()}`, movementPattern: "vertical_pull" as const, primaryMuscles: ["shoulders"], loadType: "dumbbell" as const, metricType: "weight_reps" as const, loadSemantics: "per_implement" as const },
    ]) {
      const [row] = await database.db.insert(exercises).values(exercise).returning({ id: exercises.id, name: exercises.name });
      exerciseRows.push(row);
    }
    dayLineageId = crypto.randomUUID();
    const slotLineages = [crypto.randomUUID(), crypto.randomUUID()];
    const slotIntents = [createSuggestedSlotIntent(3, 0), createSuggestedSlotIntent(4, 1)];
    slotIntents[0].priority = "must";
    slotIntents[0].protectedOrder = true;
    slotIntents[0].minimumDose.value = 3;
    slotIntents[0].idealDose.value = 3;
    slotIntents[1].priority = "could";
    slotIntents[1].minimumDose.value = 2;
    slotIntents[1].idealDose.value = 4;
    const dayIntent = createSuggestedDayIntent([
      { lineageId: slotLineages[0], sets: 3, restSec: 180 },
      { lineageId: slotLineages[1], sets: 4, restSec: 90 },
    ]);
    dayIntent.targetDuration = { minMinutes: 30, maxMinutes: 60 };
    dayIntent.minimumUsefulDurationMinutes = 20;
    await database.db.transaction(async (tx) => {
      const [program] = await tx.insert(programs).values({ userId, name: "Compiler Program", status: "archived", archivedAt: new Date() }).returning({ id: programs.id });
      programId = program.id;
      const [version] = await tx.insert(programVersions).values({ programId, versionNo: 1, name: "Compiler Program", documentSchemaVersion: 2, publicationSource: "editor", publicationPreflight: runProgramPreflight({ schemaVersion: "2", programId, baseVersionId: crypto.randomUUID(), name: "Compiler Program", days: [] }) }).returning({ id: programVersions.id });
      versionId = version.id;
      const [template] = await tx.insert(workoutTemplates).values({ programVersionId: versionId, lineageId: dayLineageId, name: "Compiler Day", intent: dayIntent }).returning({ id: workoutTemplates.id });
      for (const [index, exercise] of exerciseRows.entries()) {
        const [slot] = await tx.insert(workoutTemplateExercises).values({ workoutTemplateId: template.id, exerciseId: exercise.id, lineageId: slotLineages[index], orderIdx: index, restSec: index === 0 ? 180 : 90, intent: slotIntents[index], setNotes: Array(index === 0 ? 3 : 4).fill(null) }).returning({ id: workoutTemplateExercises.id });
        await tx.insert(exercisePrescriptions).values({ templateExerciseId: slot.id, sets: index === 0 ? 3 : 4, repRangeMin: index === 0 ? 5 : 8, repRangeMax: index === 0 ? 8 : 12, progressionRuleId: "hold" });
      }
      await tx.update(programs).set({ status: "active", archivedAt: null, currentVersionId: versionId }).where(eq(programs.id, programId));
    });
  }, 30_000);

  afterEach(async () => {
    process.env.PROGRAM_EDITOR_ENABLED = priorProgramEditor;
    process.env.SESSION_COMPILER_ENABLED = priorCompiler;
    await database.close();
  });

  it("stores a reviewable proposal and atomically accepts exactly one immutable workout without changing the Program", async () => {
    const before = await getCurrentProgramDocument(database.db, userId);
    const clientMutationId = crypto.randomUUID();
    const request = { dayLineageId, requestedMinutes: 60, energy: "usual" as const, clientMutationId };
    const proposal = await createSessionCompilerProposal(database.db, userId, request);
    expect((await createSessionCompilerProposal(database.db, userId, request)).id).toBe(proposal.id);
    expect(proposal.status).toBe("ready");
    const acceptanceKey = crypto.randomUUID();
    const first = await acceptSessionCompilerProposal(database.db, userId, proposal.id, acceptanceKey, "America/Toronto");
    expect(first.outcome).toBe("accepted");
    if (!("sessionId" in first)) throw new Error("Expected an accepted session.");
    const replay = await acceptSessionCompilerProposal(database.db, userId, proposal.id, acceptanceKey, "America/Toronto");
    expect(replay).toEqual({ outcome: "already_accepted", sessionId: first.sessionId });
    expect(await database.db.select().from(workoutSessions)).toHaveLength(1);
    const compilerExercises = await database.db.select().from(sessionExercises);
    expect(compilerExercises).toHaveLength(2);
    expect(compilerExercises).toEqual(expect.arrayContaining([
      expect.objectContaining({
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: expect.any(String),
        prescribedMetricType: expect.any(String),
        prescribedLoadType: expect.any(String),
        prescribedLoadSemantics: expect.any(String),
      }),
    ]));
    const session = await database.db.query.workoutSessions.findFirst({ where: eq(workoutSessions.id, first.sessionId) });
    expect(session).toMatchObject({ source: "compiler", compilationAcceptanceKey: acceptanceKey });
    expect(session?.compilationSnapshot).toMatchObject({ proposalId: proposal.id, proposalHash: proposal.contentHash });
    const decided = await database.db.query.sessionCompilerProposals.findFirst({ where: eq(sessionCompilerProposals.id, proposal.id) });
    expect(decided).toMatchObject({ status: "accepted", acceptedSessionId: first.sessionId, acceptanceKey });
    expect(await database.db.select().from(auditLogs)).toEqual([
      expect.objectContaining({
        action: "session_compiler.accept",
        entityType: "workout_session",
        entityId: first.sessionId,
        idempotencyKey: `session-compiler:${acceptanceKey}`,
      }),
    ]);
    expect(await getCurrentProgramDocument(database.db, userId)).toEqual(before);
    const competing = await createSessionCompilerProposal(database.db, userId, { dayLineageId, requestedMinutes: 60, energy: "usual", clientMutationId: crypto.randomUUID() });
    await expect(acceptSessionCompilerProposal(database.db, userId, competing.id, crypto.randomUUID(), "America/Toronto")).resolves.toEqual({ outcome: "active_workout_exists" });
    await database.db.update(workoutSessions).set({ status: "completed", finishedAt: new Date() }).where(eq(workoutSessions.id, first.sessionId));
    const [acceptedExercise] = await database.db.select().from(sessionExercises).where(eq(sessionExercises.sessionId, first.sessionId));
    await database.db.insert(completedSets).values({ sessionExerciseId: acceptedExercise.id, setNo: 1, weight: 95, weightUnit: "lb", reps: 5 });
    const csv = await buildSetsCsv(database.db, userId, null);
    expect(csv).toContain("compiler_proposal_id,compiler_proposal_hash,compiler_program_version_id,compiler_day_lineage_id");
    const [headers, legacySetRow] = csv.split("\n");
    const columns = headers.split(",");
    const values = legacySetRow.split(",");
    expect(values[columns.indexOf("performed_semantics_version")]).toBe("");
    expect(values[columns.indexOf("performed_load_type")]).toBe("");
    expect(values[columns.indexOf("performed_load_semantics")]).toBe("");
    expect(csv).toContain(proposal.id);
    expect(csv).toContain(proposal.contentHash);
    expect(csv).toContain(versionId);
    expect(csv).toContain(dayLineageId);
    const backup = await buildJsonBackup(database.db, userId);
    expect(backup.schemaVersion).toBe("31");
    expect(backup.canonical.tables.session_compiler_proposals).toContainEqual(
      expect.objectContaining({ id: proposal.id, accepted_session_id: first.sessionId, content_hash: proposal.contentHash }),
    );
    expect(backup.canonical.tables.workout_sessions).toEqual([
      expect.objectContaining({ id: first.sessionId, compilation_acceptance_key: acceptanceKey, compilation_snapshot: expect.objectContaining({ proposalId: proposal.id }) }),
    ]);
    await expect(database.db.update(workoutSessions).set({ compilationAcceptanceKey: crypto.randomUUID() }).where(eq(workoutSessions.id, first.sessionId))).rejects.toThrow();
    expect((await database.db.query.workoutSessions.findFirst({ where: eq(workoutSessions.id, first.sessionId) }))?.compilationAcceptanceKey).toBe(acceptanceKey);
    const archived = await archiveWorkoutRecord(database.db, userId, first.sessionId);
    expect(archived).toMatchObject({ ok: true });
    if (!archived.ok) throw new Error(archived.reason);
    expect(await database.db.query.sessionCompilerProposals.findFirst({ where: eq(sessionCompilerProposals.id, proposal.id) })).toMatchObject({ status: "accepted", acceptedSessionId: first.sessionId });
    expect((await restoreArchiveOperation(database.db, userId, archived.operationId)).ok).toBe(true);
    expect(await database.db.query.workoutSessions.findFirst({ where: eq(workoutSessions.id, first.sessionId) })).toMatchObject({ compilationAcceptanceKey: acceptanceKey, compilationSnapshot: expect.objectContaining({ proposalId: proposal.id }) });
  });

  it("accepts schema-3 structured warm-ups and a canonical group as one exact round-member occurrence sequence", async () => {
    const [sourceTemplate] = await database.db.select().from(workoutTemplates);
    const sourceSlots = await database.db.select().from(workoutTemplateExercises);
    const sourcePrescriptions = await database.db.select().from(exercisePrescriptions);
    const groupLineageId = crypto.randomUUID();
    await database.db.transaction(async (tx) => {
      const [version] = await tx.insert(programVersions).values({
        programId,
        versionNo: 2,
        name: "Compiler Program v3",
        parentVersionId: versionId,
        documentSchemaVersion: 3,
        publicationSource: "editor",
      }).returning({ id: programVersions.id });
      const [template] = await tx.insert(workoutTemplates).values({
        programVersionId: version.id,
        lineageId: dayLineageId,
        name: sourceTemplate.name,
        intent: sourceTemplate.intent,
        warmupNotes: "Compatibility warm-up",
        warmupItems: [
          { key: crypto.randomUUID(), label: "Raise temperature", reps: null, load: null, loadUnit: null, loadPercent: null, loadText: "Easy pace", notes: null },
          { key: crypto.randomUUID(), label: "Shoulder circles", reps: 10, load: null, loadUnit: null, loadPercent: null, loadText: null, notes: "Each direction" },
        ],
      }).returning({ id: workoutTemplates.id });
      const [group] = await tx.insert(supersetGroups).values({
        workoutTemplateId: template.id,
        lineageId: groupLineageId,
        name: "Compiler pair",
        orderIdx: 0,
        plannedRounds: 3,
        restBetweenMembersSec: 15,
        restAfterRoundSec: 75,
      }).returning({ id: supersetGroups.id });
      for (const [index, sourceSlot] of sourceSlots.entries()) {
        const sourcePrescription = sourcePrescriptions.find(
          (prescription) => prescription.templateExerciseId === sourceSlot.id,
        );
        if (!sourcePrescription) throw new Error("Missing source prescription.");
        const [slot] = await tx.insert(workoutTemplateExercises).values({
          workoutTemplateId: template.id,
          exerciseId: sourceSlot.exerciseId,
          lineageId: sourceSlot.lineageId,
          orderIdx: index,
          supersetGroupId: group.id,
          groupMemberOrderIdx: index,
          restSec: sourceSlot.restSec,
          intent: sourceSlot.intent,
          warmupNotes: index === 0 ? "Empty-bar rehearsal" : null,
          warmupSets: index === 0
            ? [{ label: "Primer", reps: 5, load: 45, loadUnit: "lb", loadPercent: null, loadText: null, notes: null }]
            : [],
          setNotes: [null, null, null],
        }).returning({ id: workoutTemplateExercises.id });
        await tx.insert(exercisePrescriptions).values({
          templateExerciseId: slot.id,
          sets: 3,
          repRangeMin: sourcePrescription.repRangeMin,
          repRangeMax: sourcePrescription.repRangeMax,
          progressionRuleId: sourcePrescription.progressionRuleId,
        });
      }
      await tx.update(programs).set({ currentVersionId: version.id })
        .where(eq(programs.id, programId));
    });

    const proposal = await createSessionCompilerProposal(database.db, userId, {
      dayLineageId,
      requestedMinutes: 60,
      energy: "usual",
      clientMutationId: crypto.randomUUID(),
    });
    expect(proposal.inputSnapshot).toMatchObject({
      documentSchemaVersion: 3,
      day: {
        warmupItems: [{ label: "Raise temperature" }, { label: "Shoulder circles" }],
        supersets: [{
          key: groupLineageId,
          structureStatus: "canonical",
          plannedRounds: 3,
          restBetweenMembersSec: 15,
          restBetweenRoundsSec: 75,
        }],
      },
    });
    const accepted = await acceptSessionCompilerProposal(
      database.db,
      userId,
      proposal.id,
      crypto.randomUUID(),
      "America/Toronto",
    );
    expect(accepted.outcome).toBe("accepted");
    if (!("sessionId" in accepted)) throw new Error("Expected accepted compiler workout.");

    const groups = await database.db.select().from(sessionExerciseGroups)
      .where(eq(sessionExerciseGroups.sessionId, accepted.sessionId));
    expect(groups).toEqual([expect.objectContaining({
      lineageId: groupLineageId,
      provenance: "compiler",
      plannedRounds: 3,
      memberCount: 2,
      restBetweenMembersSec: 15,
      restBetweenRoundsSec: 75,
    })]);
    const acceptedExercises = await database.db.select().from(sessionExercises)
      .where(eq(sessionExercises.sessionId, accepted.sessionId))
      .orderBy(sessionExercises.orderIdx);
    expect(acceptedExercises.map((exercise) => exercise.groupMemberOrderIdx)).toEqual([0, 1]);
    expect(acceptedExercises.every((exercise) => exercise.groupSnapshotId === groups[0].id)).toBe(true);

    const occurrences = await database.db.select().from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, accepted.sessionId))
      .orderBy(sessionOccurrences.sequenceIdx);
    expect(occurrences.map((occurrence) => occurrence.kind)).toEqual([
      "day_warmup",
      "day_warmup",
      "exercise_warmup",
      "working_set",
      "working_set",
      "working_set",
      "working_set",
      "working_set",
      "working_set",
    ]);
    expect(occurrences.slice(3).map((occurrence) => [
      occurrence.groupRound,
      occurrence.groupMemberOrderIdx,
    ])).toEqual([
      [1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [3, 1],
    ]);
    expect(occurrences.slice(3).map((occurrence) => occurrence.plannedRestSec))
      .toEqual([15, 75, 15, 75, 15, 0]);
  });

  it("keeps a long legacy schema-3 overview as guidance instead of a checkable action", async () => {
    const [sourceTemplate] = await database.db.select().from(workoutTemplates);
    const sourceSlots = await database.db.select().from(workoutTemplateExercises);
    const sourcePrescriptions = await database.db.select().from(exercisePrescriptions);
    const overview =
      "Five minutes easy, then rehearse the first movement with a controlled range. " +
      "This retained legacy overview is intentionally longer than one hundred and twenty characters.";
    const compatibilityTemplateId = crypto.randomUUID();
    await database.db.transaction(async (tx) => {
      const [version] = await tx.insert(programVersions).values({
        programId,
        versionNo: 2,
        name: "Compiler overview fallback",
        parentVersionId: versionId,
        documentSchemaVersion: 3,
        publicationSource: "editor",
      }).returning({ id: programVersions.id });
      const [template] = await tx.insert(workoutTemplates).values({
        id: compatibilityTemplateId,
        programVersionId: version.id,
        lineageId: dayLineageId,
        name: sourceTemplate.name,
        intent: sourceTemplate.intent,
        warmupNotes: overview,
        warmupItems: [{
          key: compatibilityTemplateId,
          label: overview.slice(0, 120),
          reps: null,
          load: null,
          loadUnit: null,
          loadPercent: null,
          loadText: null,
          notes: null,
        }],
      }).returning({ id: workoutTemplates.id });
      for (const sourceSlot of sourceSlots) {
        const prescription = sourcePrescriptions.find(
          (candidate) => candidate.templateExerciseId === sourceSlot.id,
        );
        if (!prescription) throw new Error("Missing source prescription.");
        const [slot] = await tx.insert(workoutTemplateExercises).values({
          workoutTemplateId: template.id,
          exerciseId: sourceSlot.exerciseId,
          lineageId: sourceSlot.lineageId,
          orderIdx: sourceSlot.orderIdx,
          restSec: sourceSlot.restSec,
          intent: sourceSlot.intent,
          setNotes: sourceSlot.setNotes,
        }).returning({ id: workoutTemplateExercises.id });
        await tx.insert(exercisePrescriptions).values({
          templateExerciseId: slot.id,
          sets: prescription.sets,
          repRangeMin: prescription.repRangeMin,
          repRangeMax: prescription.repRangeMax,
          progressionRuleId: prescription.progressionRuleId,
        });
      }
      await tx.update(programs).set({ currentVersionId: version.id })
        .where(eq(programs.id, programId));
    });

    const proposal = await createSessionCompilerProposal(database.db, userId, {
      dayLineageId,
      requestedMinutes: 60,
      energy: "usual",
      clientMutationId: crypto.randomUUID(),
    });
    const accepted = await acceptSessionCompilerProposal(
      database.db,
      userId,
      proposal.id,
      crypto.randomUUID(),
      "America/Toronto",
    );
    expect(accepted.outcome).toBe("accepted");
    if (!("sessionId" in accepted)) throw new Error("Expected accepted compiler workout.");

    const session = await database.db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, accepted.sessionId),
    });
    expect(session).toMatchObject({
      dayWarmupNotes: overview,
      dayWarmupItems: [],
    });
    const warmups = await database.db.select().from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, accepted.sessionId))
      .orderBy(sessionOccurrences.sequenceIdx);
    expect(warmups.some((occurrence) => occurrence.kind === "day_warmup"))
      .toBe(false);
    expect(warmups.some((occurrence) => occurrence.label === overview))
      .toBe(false);
  });

  it("marks proposals from an older compiler algorithm stale before rebuilding their evidence", async () => {
    const proposal = await createSessionCompilerProposal(database.db, userId, {
      dayLineageId,
      requestedMinutes: 60,
      energy: "usual",
      clientMutationId: crypto.randomUUID(),
    });
    const [oldProposal] = await database.db.insert(sessionCompilerProposals).values({
      userId: proposal.userId,
      programId: proposal.programId,
      programVersionId: proposal.programVersionId,
      workoutTemplateId: proposal.workoutTemplateId,
      algorithmVersion: "phase3-deterministic-v1",
      status: "ready",
      inputSnapshot: proposal.inputSnapshot,
      outputSnapshot: proposal.outputSnapshot,
      preflightSnapshot: proposal.preflightSnapshot,
      contentHash: proposal.contentHash,
      clientMutationId: crypto.randomUUID(),
    }).returning();
    await expect(acceptSessionCompilerProposal(
      database.db,
      userId,
      oldProposal.id,
      crypto.randomUUID(),
      "America/Toronto",
    )).resolves.toEqual({ outcome: "stale" });
    expect(await database.db.query.sessionCompilerProposals.findFirst({
      where: eq(sessionCompilerProposals.id, oldProposal.id),
    })).toMatchObject({ status: "stale" });
    expect(await database.db.select().from(workoutSessions)).toHaveLength(0);
  });

  it("restores accepted compiler evidence and workout provenance from a schema-22 snapshot", async () => {
    const proposal = await createSessionCompilerProposal(database.db, userId, {
      dayLineageId,
      requestedMinutes: 60,
      energy: "usual",
      clientMutationId: crypto.randomUUID(),
    });
    const acceptanceKey = crypto.randomUUID();
    const accepted = await acceptSessionCompilerProposal(
      database.db,
      userId,
      proposal.id,
      acceptanceKey,
      "America/Toronto"
    );
    expect(accepted.outcome).toBe("accepted");
    if (!("sessionId" in accepted)) throw new Error("Expected an accepted session.");

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 23);
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
      { name: "Accepted compiler recovery", reason: "manual", pinned: true },
      { store, keyring, appVersion: "session-compiler-recovery-test" }
    );
    if (!created.ok) throw new Error(created.reason);

    const captured = await readVerifiedDataSnapshot(
      database.db,
      userId,
      created.snapshotId,
      { store, keyring }
    );
    expect(captured.payload.schemaVersion).toBe("31");
    expect(captured.payload.tables.session_compiler_proposals).toContainEqual(
      expect.objectContaining({
        id: proposal.id,
        status: "accepted",
        accepted_session_id: accepted.sessionId,
        acceptance_key: acceptanceKey,
        content_hash: proposal.contentHash,
      })
    );
    expect(captured.payload.tables.workout_sessions).toContainEqual(
      expect.objectContaining({
        id: accepted.sessionId,
        source: "compiler",
        compilation_acceptance_key: acceptanceKey,
        compilation_snapshot: expect.objectContaining({
          proposalId: proposal.id,
          proposalHash: proposal.contentHash,
        }),
      })
    );

    for (const scope of ["full", "history"] as const) {
      await database.db
        .update(workoutSessions)
        .set({ status: "completed", finishedAt: new Date("2026-07-18T18:00:00.000Z") })
        .where(eq(workoutSessions.id, accepted.sessionId));

      const preview = await getSnapshotRestorePreview(
        database.db,
        userId,
        created.snapshotId,
        scope,
        { store, keyring }
      );
      const restored = await restoreDataSnapshot(
        database.db,
        userId,
        {
          snapshotId: created.snapshotId,
          scope,
          previewFingerprint: preview.fingerprint,
          confirmation: "RESTORE",
        },
        { store, keyring, appVersion: "session-compiler-recovery-test" }
      );
      expect(restored).toMatchObject({ ok: true, scope });

      expect(
        await database.db.query.sessionCompilerProposals.findFirst({
          where: eq(sessionCompilerProposals.id, proposal.id),
        })
      ).toMatchObject({
        status: "accepted",
        acceptedSessionId: accepted.sessionId,
        acceptanceKey,
        contentHash: proposal.contentHash,
      });
      expect(
        await database.db.query.workoutSessions.findFirst({
          where: eq(workoutSessions.id, accepted.sessionId),
        })
      ).toMatchObject({
        status: "in_progress",
        finishedAt: null,
        source: "compiler",
        compilationAcceptanceKey: acceptanceKey,
        compilationSnapshot: expect.objectContaining({
          proposalId: proposal.id,
          proposalHash: proposal.contentHash,
        }),
      });
    }
  }, 30_000);

  it("makes a newly published schema-1 Program ineligible without inventing intent", async () => {
    const evidenceProposal = await createSessionCompilerProposal(database.db, userId, { dayLineageId, requestedMinutes: 60, energy: "usual", clientMutationId: crypto.randomUUID() });
    await database.db.insert(workoutSessions).values({
      userId,
      templateName: "New evidence while reviewing",
      status: "completed",
      startedAt: new Date("2026-07-18T10:00:00.000Z"),
      finishedAt: new Date("2026-07-18T10:30:00.000Z"),
      timezone: "America/Toronto",
      localDate: "2026-07-18",
    });
    await expect(acceptSessionCompilerProposal(database.db, userId, evidenceProposal.id, crypto.randomUUID(), "America/Toronto")).resolves.toEqual({ outcome: "stale" });
    expect(await discardSessionCompilerProposal(database.db, userId, evidenceProposal.id)).toBe(true);
    const staleProposal = await createSessionCompilerProposal(database.db, userId, { dayLineageId, requestedMinutes: 60, energy: "usual", clientMutationId: crypto.randomUUID() });
    const existingSlots = await database.db.select().from(workoutTemplateExercises);
    const existingPrescriptions = await database.db.select().from(exercisePrescriptions);
    const legacyDayLineageId = crypto.randomUUID();
    await database.db.transaction(async (tx) => {
      const [version] = await tx.insert(programVersions).values({ programId, versionNo: 2, name: "Legacy Program", parentVersionId: versionId, documentSchemaVersion: 1, publicationSource: "restore" }).returning({ id: programVersions.id });
      const [template] = await tx.insert(workoutTemplates).values({ programVersionId: version.id, lineageId: legacyDayLineageId, name: "Legacy Day", intent: null }).returning({ id: workoutTemplates.id });
      for (const [index, source] of existingSlots.entries()) {
        const [slot] = await tx.insert(workoutTemplateExercises).values({ workoutTemplateId: template.id, exerciseId: source.exerciseId, lineageId: crypto.randomUUID(), orderIdx: index, restSec: source.restSec, intent: null, setNotes: source.setNotes }).returning({ id: workoutTemplateExercises.id });
        const prescription = existingPrescriptions.find((row) => row.templateExerciseId === source.id)!;
        await tx.insert(exercisePrescriptions).values({ templateExerciseId: slot.id, sets: prescription.sets, repRangeMin: prescription.repRangeMin, repRangeMax: prescription.repRangeMax, progressionRuleId: prescription.progressionRuleId });
      }
      await tx.update(programs).set({ currentVersionId: version.id }).where(eq(programs.id, programId));
    });
    await expect(acceptSessionCompilerProposal(database.db, userId, staleProposal.id, crypto.randomUUID(), "America/Toronto")).resolves.toEqual({ outcome: "stale" });
    expect(await database.db.query.sessionCompilerProposals.findFirst({ where: eq(sessionCompilerProposals.id, staleProposal.id) })).toMatchObject({ status: "stale" });
    expect(await discardSessionCompilerProposal(database.db, userId, staleProposal.id)).toBe(true);
    expect(await database.db.query.sessionCompilerProposals.findFirst({ where: eq(sessionCompilerProposals.id, staleProposal.id) })).toMatchObject({ status: "discarded" });
    await expect(createSessionCompilerProposal(database.db, userId, { dayLineageId: legacyDayLineageId, requestedMinutes: 60, energy: "usual", clientMutationId: crypto.randomUUID() })).rejects.toThrow(/schema-2/i);
  });

  it("uses active-duration evidence for preflight and invalidates proposals when it changes", async () => {
    const document = await getCurrentProgramDocument(database.db, userId);
    if (!document) throw new Error("Current Program fixture is missing.");
    if (document.schemaVersion !== "2") {
      throw new Error("Schema-2 compiler fixture is required.");
    }
    const template = await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.lineageId, dayLineageId),
    });
    if (!template) throw new Error("Compiler template fixture is missing.");
    const [evidenceSession] = await database.db.insert(workoutSessions).values({
      userId,
      templateId: template.id,
      templateName: template.name,
      status: "completed",
      startedAt: new Date("2026-07-18T10:00:00.000Z"),
      finishedAt: null,
      performedTimePrecision: "date_only",
      activeDurationSemanticsVersion: 1,
      activeDurationSeconds: 3_600,
      activeDurationBasis: "owner_reported",
      excludeDurationFromAnalytics: false,
      dataQualityFlags: ["unknown_time"],
      timezone: "America/Toronto",
      localDate: "2026-07-18",
    }).returning({ id: workoutSessions.id });
    await database.db.insert(workoutSessions).values([
      {
        userId,
        templateId: template.id,
        templateName: template.name,
        status: "completed",
        startedAt: new Date("2026-07-17T16:00:00.000Z"),
        finishedAt: null,
        performedTimePrecision: "date_only",
        activeDurationSemanticsVersion: 1,
        activeDurationSeconds: null,
        activeDurationBasis: "interruption_unknown",
        excludeDurationFromAnalytics: true,
        dataQualityFlags: ["unknown_time", "workout_active_duration_unknown"],
        timezone: "America/Toronto",
        localDate: "2026-07-17",
      },
      {
        userId,
        templateId: template.id,
        templateName: template.name,
        status: "completed",
        startedAt: new Date("2026-07-16T16:00:00.000Z"),
        finishedAt: null,
        performedTimePrecision: "date_only",
        excludeDurationFromAnalytics: true,
        dataQualityFlags: ["unknown_time"],
        timezone: "America/Toronto",
        localDate: "2026-07-16",
      },
    ]);

    const context = await loadProgramPreflightContext(
      database.db,
      userId,
      document,
    );
    expect(context.comparableDurationsByDay?.[dayLineageId]).toEqual([60]);

    const proposal = await createSessionCompilerProposal(database.db, userId, {
      dayLineageId,
      requestedMinutes: 60,
      energy: "usual",
      clientMutationId: crypto.randomUUID(),
    });
    await database.db.update(workoutSessions).set({
      activeDurationSeconds: 3_000,
    }).where(eq(workoutSessions.id, evidenceSession.id));
    await expect(acceptSessionCompilerProposal(
      database.db,
      userId,
      proposal.id,
      crypto.randomUUID(),
      "America/Toronto",
    )).resolves.toEqual({ outcome: "stale" });
  });
});
