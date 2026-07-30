import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  adaptationEvents,
  completedSets,
  exercisePrescriptions,
  exercises,
  programDrafts,
  programs,
  programVersions,
  recommendations,
  sessionExercises,
  sessionOccurrences,
  userDecisions,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  createRestoreProgramDraft,
  getOpenProgramDraft,
  getOrCreateProgramDraft,
  reviewProgramDraft,
  saveProgramDraft,
} from "@/services/program-drafts";
import {
  publishProgramDraft,
  publishRecommendationProgramVersion,
} from "@/services/program-publication";
import {
  hashLegacyProgramDocument,
  hashProgramDocument,
} from "@/services/program-document-hash";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import { evaluateApplicationIntegrity } from "@/services/recovery-health";
import {
  upgradeSnapshotPayload,
  validateSnapshotPayload,
} from "@/services/snapshot-restore";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";

describe("versioned Program editor persistence", () => {
  let database: TestDatabase;
  let userId: string;
  let exerciseId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    userId = crypto.randomUUID();
    await database.db.insert(users).values({
      id: userId,
      email: `program-editor-${userId}@example.com`,
      name: "Program editor fixture",
    });
    await database.db.insert(userProfiles).values({ userId, unit: "lb" });
    const [exercise] = await database.db.insert(exercises).values({
      name: `Program editor press ${crypto.randomUUID()}`,
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "bodyweight",
    }).returning({ id: exercises.id });
    exerciseId = exercise.id;
    const activated = await activateProgramAtomically(database.db, {
      userId,
      loadUnit: "lb",
      programName: "Original Program",
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
          warmupNotes: "Band pull-aparts",
          warmupSets: [{ label: "Empty bar", reps: 10, load: null, loadUnit: null, loadPercent: null, loadText: "empty bar", notes: null }],
          setNotes: ["Pause", null, "Leave one rep"],
        }],
      }],
      changeSummary: "Initial fixture",
      auditAction: "program.activate",
      auditSummary: "Initial Program activated",
    });
    if (!activated.ok) throw new Error(activated.reason);
  });

  afterEach(async () => database.close());

  async function reviewedEditedDraft(targetLoad: number, name = "Edited Program") {
    const state = await getOrCreateProgramDraft(database.db, userId);
    if (!state) throw new Error("Draft missing");
    const document = structuredClone(state.draft.document);
    document.name = name;
    document.days[0].name = "Renamed Day";
    document.days[0].exercises[0].targetLoad = targetLoad;
    document.days[0].exercises[0].targetLoadUnit = "lb";
    const mutationId = crypto.randomUUID();
    const saved = await saveProgramDraft(database.db, userId, {
      draftId: state.draft.id,
      expectedRevision: state.draft.revision,
      mutationId,
      document,
    });
    expect(saved).toMatchObject({ status: "saved", revision: state.draft.revision + 1 });
    const replay = await saveProgramDraft(database.db, userId, {
      draftId: state.draft.id,
      expectedRevision: state.draft.revision,
      mutationId,
      document,
    });
    expect(replay).toEqual(saved);
    if (saved.status !== "saved") throw new Error("Draft did not save");
    const review = await reviewProgramDraft(
      database.db,
      userId,
      state.draft.id,
      saved.revision
    );
    expect(review?.blockingErrors).toEqual([]);
    expect(review?.changes.map((change) => change.kind)).toEqual(
      expect.arrayContaining(["rename", "targets"])
    );
    if (!review || review.status !== "publishable") {
      throw new Error("Review missing");
    }
    return { draftId: state.draft.id, revision: saved.revision, review, document };
  }

  async function reviewedLoadDraft(targetLoad: number | null, name: string) {
    const state = await getOrCreateProgramDraft(database.db, userId);
    if (!state) throw new Error("Draft missing");
    const document = structuredClone(state.draft.document);
    document.name = name;
    document.days[0].exercises[0].targetLoad = targetLoad;
    document.days[0].exercises[0].targetLoadUnit = targetLoad == null ? null : "lb";
    const saved = await saveProgramDraft(database.db, userId, {
      draftId: state.draft.id,
      expectedRevision: state.draft.revision,
      mutationId: crypto.randomUUID(),
      document,
    });
    if (saved.status !== "saved") throw new Error("Draft did not save");
    const review = await reviewProgramDraft(
      database.db,
      userId,
      state.draft.id,
      saved.revision
    );
    expect(review?.blockingErrors).toEqual([]);
    if (!review || review.status !== "publishable") {
      throw new Error("Review missing");
    }
    return { draftId: state.draft.id, revision: saved.revision, review };
  }

  async function currentSlot() {
    const program = await database.db.query.programs.findFirst({
      where: eq(programs.userId, userId),
    });
    if (!program?.currentVersionId) throw new Error("Current Program missing");
    const day = await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, program.currentVersionId),
    });
    if (!day) throw new Error("Current Program day missing");
    const slot = await database.db.query.workoutTemplateExercises.findFirst({
      where: eq(workoutTemplateExercises.workoutTemplateId, day.id),
    });
    if (!slot) throw new Error("Current Program slot missing");
    return slot;
  }

  async function insertLoadRecommendation(
    slot: Awaited<ReturnType<typeof currentSlot>>,
    fromLoad: number | null,
    toLoad: number
  ) {
    const payload = {
      kind: "load_change" as const,
      templateExerciseId: slot.id,
      fromLoad,
      toLoad,
      loadUnit: "lb" as const,
    };
    await database.db
      .update(exercises)
      .set({
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
      })
      .where(eq(exercises.id, exerciseId));
    const [evidenceSession] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Recommendation fixture evidence",
        status: "completed",
        startedAt: new Date("2026-07-01T12:00:00.000Z"),
        finishedAt: new Date("2026-07-01T13:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-01",
      })
      .returning({ id: workoutSessions.id });
    const [evidenceExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: evidenceSession.id,
        exerciseId,
        plannedFromTemplateExerciseId: slot.id,
        sourceSlotLineageId: slot.lineageId,
        modificationType: "as_planned",
        targetSets: 1,
        targetRepsMin: 8,
        targetRepsMax: 12,
        targetLoad: fromLoad,
        targetLoadUnit: fromLoad == null ? null : "lb",
      })
      .returning({ id: sessionExercises.id });
    const equipmentSnapshotId = await createTotalSystemTestSnapshot(
      database.db,
      {
        userId,
        sessionId: evidenceSession.id,
        sessionExerciseId: evidenceExercise.id,
        unit: "lb",
      },
    );
    const [evidenceSet] = await database.db
      .insert(completedSets)
      .values({
        sessionExerciseId: evidenceExercise.id,
        setNo: 1,
        weight: fromLoad ?? toLoad,
        weightUnit: "lb",
        reps: 12,
        metricType: "weight_reps",
        loadEntryMeaning: "total_system",
        equipmentSnapshotId,
      })
      .returning({ id: completedSets.id });
    await database.db.insert(sessionOccurrences).values({
      sessionId: evidenceSession.id,
      sessionExerciseId: evidenceExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exerciseId,
      outcome: "completed",
      resolvedAt: new Date("2026-07-01T12:30:00.000Z"),
      completedSetId: evidenceSet.id,
      equipmentSnapshotId,
    });
    const [recommendation] = await database.db.insert(recommendations).values({
      userId,
      source: "rule",
      status: "pending",
      sourceTemplateExerciseId: slot.id,
      sourceSlotLineageId: slot.lineageId,
      exerciseId,
      payload,
      reason: "Load comparison regression fixture",
      evidence: { signals: {}, setIds: [evidenceSet.id] },
    }).returning();
    return recommendation;
  }

  it("loads a durable draft with an obsolete review without rewriting source data", async () => {
    const state = await getOrCreateProgramDraft(database.db, userId);
    if (!state) throw new Error("Draft missing");
    const document = structuredClone(state.draft.document);
    document.name = "Preserved owner draft";
    document.days[0].notes = "Keep this exact authored note.";
    const saved = await saveProgramDraft(database.db, userId, {
      draftId: state.draft.id,
      expectedRevision: state.draft.revision,
      mutationId: crypto.randomUUID(),
      document,
    });
    if (saved.status !== "saved") throw new Error("Draft did not save");
    const obsoleteHash = "e".repeat(64);
    const obsoleteReview = {
      hash: obsoleteHash,
      reviewedRevision: saved.revision,
      changes: [],
      blockingErrors: [],
      cautions: [],
      recommendationRevision: 0,
      recommendationConsequences: [],
      summary: {
        weeklySetsBefore: 3,
        weeklySetsAfter: 3,
        estimatedMinutesBefore: 30,
        estimatedMinutesAfter: 30,
        muscleSetsBefore: { chest: 3 },
        muscleSetsAfter: { chest: 3 },
      },
    };
    await database.db.update(programDrafts).set({
      reviewedRevision: saved.revision,
      reviewHash: obsoleteHash,
      reviewSummary: obsoleteReview,
    }).where(eq(programDrafts.id, state.draft.id));
    const before = await database.db.query.programDrafts.findFirst({
      where: eq(programDrafts.id, state.draft.id),
    });

    const loaded = await getOpenProgramDraft(database.db, userId);
    expect(loaded?.draft).toMatchObject({
      id: state.draft.id,
      revision: saved.revision,
      document: {
        name: "Preserved owner draft",
        days: [expect.objectContaining({
          notes: "Keep this exact authored note.",
        })],
      },
      reviewedRevision: null,
      reviewHash: null,
      reviewSummary: null,
      reviewState: { status: "expired" },
    });
    expect(loaded?.history).toHaveLength(1);
    expect(await database.db.query.programDrafts.findFirst({
      where: eq(programDrafts.id, state.draft.id),
    })).toEqual(before);
    expect(await publishProgramDraft(database.db, userId, {
      draftId: state.draft.id,
      expectedRevision: saved.revision,
      reviewHash: obsoleteHash,
    })).toMatchObject({ ok: false, reason: "invalid" });

    const freshReview = await reviewProgramDraft(
      database.db,
      userId,
      state.draft.id,
      saved.revision,
    );
    expect(freshReview).toMatchObject({
      status: "publishable",
      reviewedRevision: saved.revision,
    });
    const after = await database.db.query.programDrafts.findFirst({
      where: eq(programDrafts.id, state.draft.id),
    });
    expect(after?.document).toEqual(before?.document);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.contentHash).toBe(before?.contentHash);
  });

  it("does not disguise a malformed source draft as an expired review", async () => {
    const state = await getOrCreateProgramDraft(database.db, userId);
    if (!state) throw new Error("Draft missing");
    await database.db.update(programDrafts).set({
      document: { malformed: true } as never,
      contentHash: "f".repeat(64),
      reviewedRevision: state.draft.revision,
      reviewHash: "a".repeat(64),
      reviewSummary: { malformed: true },
    }).where(eq(programDrafts.id, state.draft.id));

    await expect(getOpenProgramDraft(database.db, userId)).rejects.toThrow();
  });

  async function publishReviewedLoadDraft(
    draft: Awaited<ReturnType<typeof reviewedLoadDraft>>
  ) {
    const published = await publishProgramDraft(database.db, userId, {
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      reviewHash: draft.review.hash,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(published.reason);
    return published;
  }

  it("autosaves idempotently and publishes vN+1 without changing the prior version", async () => {
    const originalProgram = await database.db.query.programs.findFirst({
      where: eq(programs.userId, userId),
    });
    if (!originalProgram?.currentVersionId) throw new Error("Program missing");
    const originalVersionId = originalProgram.currentVersionId;
    const originalSlot = await database.db.query.workoutTemplateExercises.findFirst({
      with: { template: true },
    });
    if (!originalSlot) throw new Error("Slot missing");

    const edited = await reviewedEditedDraft(25);
    const stale = await saveProgramDraft(database.db, userId, {
      draftId: edited.draftId,
      expectedRevision: 1,
      mutationId: crypto.randomUUID(),
      document: edited.document,
    });
    expect(stale.status).toBe("conflict");

    const published = await publishProgramDraft(database.db, userId, {
      draftId: edited.draftId,
      expectedRevision: edited.revision,
      reviewHash: edited.review.hash,
    });
    expect(published).toMatchObject({ ok: true, versionNo: 2 });
    if (!published.ok) throw new Error(published.reason);
    expect(await publishProgramDraft(database.db, userId, {
      draftId: edited.draftId,
      expectedRevision: edited.revision,
      reviewHash: edited.review.hash,
    })).toEqual(published);

    const current = await database.db.query.programs.findFirst({
      where: eq(programs.userId, userId),
    });
    expect(current).toMatchObject({
      id: originalProgram.id,
      name: "Edited Program",
      currentVersionId: published.programVersionId,
    });
    expect(await database.db.query.programVersions.findMany({
      where: eq(programVersions.programId, originalProgram.id),
    })).toHaveLength(2);
    expect(await database.db.query.programVersions.findFirst({
      where: eq(programVersions.id, originalVersionId),
    })).toMatchObject({
      documentSchemaVersion: 1,
      publicationPreflight: null,
    });
    expect(await database.db.query.programVersions.findFirst({
      where: eq(programVersions.id, published.programVersionId),
    })).toMatchObject({
      documentSchemaVersion: 3,
      publicationPreflight: expect.objectContaining({
        algorithmVersion: "phase2-rule-range-v1",
        durations: expect.arrayContaining([
          expect.objectContaining({
            evidenceCount: 0,
            basis: "planned_fallback",
          }),
        ]),
      }),
    });
    expect(await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, originalVersionId),
    })).toMatchObject({ name: "Day A" });
    const publishedDay = await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, published.programVersionId),
    });
    expect(publishedDay).toMatchObject({
      name: "Renamed Day",
      intent: expect.objectContaining({
        primaryOutcome: "strength",
        targetDuration: expect.objectContaining({ minMinutes: expect.any(Number) }),
      }),
    });
    if (!publishedDay) throw new Error("Published day missing");
    expect(await database.db.query.workoutTemplateExercises.findFirst({
      where: eq(workoutTemplateExercises.workoutTemplateId, publishedDay.id),
    })).toMatchObject({
      intent: expect.objectContaining({
        role: "anchor",
        minimumDose: { unit: "sets", value: 2 },
        idealDose: { unit: "sets", value: 3 },
      }),
    });
    expect(await database.db.query.exercisePrescriptions.findFirst({
      where: eq(exercisePrescriptions.templateExerciseId, originalSlot.id),
    })).toMatchObject({ targetLoad: 20 });
    expect(await database.db.query.programDrafts.findFirst({
      where: eq(programDrafts.id, edited.draftId),
    })).toMatchObject({ status: "published", publishedVersionId: published.programVersionId });

    const reopened = await getOrCreateProgramDraft(database.db, userId);
    expect(reopened?.draft.document.schemaVersion).toBe("3");
    expect(reopened?.draft.document.days[0].warmupItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: expect.any(String) })]),
    );

    await expect(database.db.update(workoutTemplates).set({ name: "Mutated" }).where(
      eq(workoutTemplates.programVersionId, originalVersionId)
    )).rejects.toThrow();
    expect(await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, originalVersionId),
    })).toMatchObject({ name: "Day A" });
  });

  it("reconnects a stale-base open draft after the active Program advanced", async () => {
    const originalProgram = await database.db.query.programs.findFirst({
      where: eq(programs.userId, userId),
    });
    if (!originalProgram?.currentVersionId) throw new Error("Program missing");
    const originalVersionId = originalProgram.currentVersionId;

    const originalDay = await database.db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, originalVersionId),
    });
    const originalSlot = await database.db.query.workoutTemplateExercises.findFirst({
      where: originalDay
        ? eq(workoutTemplateExercises.workoutTemplateId, originalDay.id)
        : undefined,
    });
    if (!originalDay || !originalSlot) throw new Error("Program lineage missing");
    const [completedWorkout] = await database.db.insert(workoutSessions).values({
      userId,
      templateId: originalDay.id,
      templateName: originalDay.name,
      sourceProgramId: originalProgram.id,
      sourceProgramVersionId: originalVersionId,
      sourceDayLineageId: originalDay.lineageId,
      status: "completed",
      startedAt: new Date("2026-07-01T12:00:00.000Z"),
      finishedAt: new Date("2026-07-01T13:00:00.000Z"),
      timezone: "America/Toronto",
      localDate: "2026-07-01",
    }).returning();
    await database.db.insert(sessionExercises).values({
      sessionId: completedWorkout.id,
      exerciseId,
      plannedFromTemplateExerciseId: originalSlot.id,
      sourceSlotLineageId: originalSlot.lineageId,
      targetSets: 3,
      targetRepsMin: 8,
      targetRepsMax: 12,
      targetLoad: 20,
      targetLoadUnit: "lb",
    });

    // Create a coherent A-based draft and preserve a current review hash that
    // must become unusable when another publication advances the Program to B.
    const openDraft = await getOrCreateProgramDraft(database.db, userId);
    if (!openDraft) throw new Error("Draft missing");
    expect(openDraft.baseAdvanced).toBe(false);
    const editedDocument = structuredClone(openDraft.draft.document);
    editedDocument.name = "Work in progress";
    editedDocument.days[0].notes = "Owner-authored note that must survive exactly.";
    const saved = await saveProgramDraft(database.db, userId, {
      draftId: openDraft.draft.id,
      expectedRevision: openDraft.draft.revision,
      mutationId: crypto.randomUUID(),
      document: editedDocument,
    });
    if (saved.status !== "saved") throw new Error("Draft did not save");
    const oldReview = await reviewProgramDraft(
      database.db,
      userId,
      openDraft.draft.id,
      saved.revision,
    );
    if (!oldReview || oldReview.status !== "publishable") {
      throw new Error("Draft review missing");
    }

    // A recommendation publication is an independent current-Program writer.
    // It advances the active Program to B while the coherent draft remains on A.
    const recommendation = await insertLoadRecommendation(originalSlot, 20, 22);
    const advanced = await publishRecommendationProgramVersion(database.db, userId, {
      recommendationId: recommendation.id,
      expectedPayload: recommendation.payload,
      appliedPayload: recommendation.payload,
      decision: "approve",
    });
    if (!advanced.ok) throw new Error(advanced.reason);
    expect(advanced.programVersionId).not.toBe(originalVersionId);
    // Current publication code discards sibling drafts. Production evidence
    // includes an older durable open row from before that behavior converged,
    // so restore only this synthetic fixture's status to reproduce that
    // coherent A-row/A-document state without changing either Program version.
    await database.db.update(programDrafts).set({
      status: "open",
      discardedAt: null,
    }).where(eq(programDrafts.id, openDraft.draft.id));

    const historicalBefore = JSON.stringify({
      versions: await database.db.query.programVersions.findMany(),
      days: await database.db.query.workoutTemplates.findMany(),
      slots: await database.db.query.workoutTemplateExercises.findMany(),
      prescriptions: await database.db.query.exercisePrescriptions.findMany(),
      workouts: await database.db.query.workoutSessions.findMany(),
      sessionExercises: await database.db.query.sessionExercises.findMany(),
    });
    const versionCountBefore = (await database.db.query.programVersions.findMany()).length;

    const reconnected = await getOpenProgramDraft(database.db, userId);
    expect(reconnected).not.toBeNull();
    expect(reconnected?.baseAdvanced).toBe(true);
    expect(reconnected?.draft.id).toBe(openDraft.draft.id);
    expect(reconnected?.draft.document.name).toBe("Work in progress");
    expect(reconnected?.draft.document.days[0].notes).toBe(
      "Owner-authored note that must survive exactly.",
    );
    expect({
      ...reconnected?.draft.document,
      baseVersionId: originalVersionId,
    }).toEqual(editedDocument);
    expect(reconnected?.draft.revision).toBe(saved.revision + 1);
    expect(reconnected?.draft.reviewState.status).toBe("expired");

    const draftRow = await database.db.query.programDrafts.findFirst({
      where: eq(programDrafts.id, openDraft.draft.id),
    });
    expect(draftRow?.baseVersionId).toBe(advanced.programVersionId);
    expect(
      (draftRow?.document as { baseVersionId?: string }).baseVersionId,
    ).toBe(advanced.programVersionId);
    expect(draftRow?.contentHash).toBe(hashProgramDocument(draftRow?.document));
    expect(draftRow?.revision).toBe(saved.revision + 1);
    expect(draftRow?.reviewedRevision).toBeNull();
    expect(draftRow?.reviewHash).toBeNull();
    expect(draftRow?.reviewSummary).toBeNull();

    const staleSave = await saveProgramDraft(database.db, userId, {
      draftId: openDraft.draft.id,
      expectedRevision: saved.revision,
      mutationId: crypto.randomUUID(),
      document: editedDocument,
    });
    expect(staleSave).toMatchObject({
      status: "conflict",
      serverDraft: {
        revision: saved.revision + 1,
        document: { baseVersionId: advanced.programVersionId },
      },
    });
    expect(await publishProgramDraft(database.db, userId, {
      draftId: openDraft.draft.id,
      expectedRevision: saved.revision,
      reviewHash: oldReview.hash,
    })).toMatchObject({ ok: false });

    const reconciledLocal = {
      ...editedDocument,
      baseVersionId: advanced.programVersionId,
    };
    const resaved = await saveProgramDraft(database.db, userId, {
      draftId: openDraft.draft.id,
      expectedRevision: saved.revision + 1,
      mutationId: crypto.randomUUID(),
      document: reconciledLocal,
    });
    expect(resaved).toMatchObject({ status: "saved", revision: saved.revision + 2 });
    if (resaved.status !== "saved") throw new Error("Reconciled draft did not save");
    const freshReview = await reviewProgramDraft(
      database.db,
      userId,
      openDraft.draft.id,
      resaved.revision,
    );
    expect(freshReview).toMatchObject({
      status: "publishable",
      reviewedRevision: resaved.revision,
    });

    const stable = await getOrCreateProgramDraft(database.db, userId);
    expect(stable?.baseAdvanced).toBe(false);
    expect(stable?.draft.id).toBe(openDraft.draft.id);
    expect((await database.db.query.programVersions.findMany())).toHaveLength(
      versionCountBefore,
    );
    expect(JSON.stringify({
      versions: await database.db.query.programVersions.findMany(),
      days: await database.db.query.workoutTemplates.findMany(),
      slots: await database.db.query.workoutTemplateExercises.findMany(),
      prescriptions: await database.db.query.exercisePrescriptions.findMany(),
      workouts: await database.db.query.workoutSessions.findMany(),
      sessionExercises: await database.db.query.sessionExercises.findMany(),
    })).toBe(historicalBefore);
  });

  it("repairs a row whose old reconciler advanced only the base pointer", async () => {
    const original = await database.db.query.programs.findFirst({
      where: eq(programs.userId, userId),
    });
    if (!original?.currentVersionId) throw new Error("Program missing");
    const originalVersionId = original.currentVersionId;
    const edited = await reviewedEditedDraft(30, "Current B");
    const published = await publishProgramDraft(database.db, userId, {
      draftId: edited.draftId,
      expectedRevision: edited.revision,
      reviewHash: edited.review.hash,
    });
    if (!published.ok) throw new Error(published.reason);
    const state = await getOrCreateProgramDraft(database.db, userId);
    if (!state) throw new Error("Draft missing");
    const partiallyReconciledDocument = {
      ...structuredClone(state.draft.document),
      baseVersionId: originalVersionId,
      name: "Preserve partial-repair edits",
    };
    await database.db.update(programDrafts).set({
      document: partiallyReconciledDocument,
      contentHash: hashProgramDocument(partiallyReconciledDocument),
    }).where(eq(programDrafts.id, state.draft.id));

    const repaired = await getOpenProgramDraft(database.db, userId);
    expect(repaired).toMatchObject({
      baseAdvanced: true,
      draft: {
        revision: state.draft.revision + 1,
        document: {
          baseVersionId: published.programVersionId,
          name: "Preserve partial-repair edits",
        },
        reviewState: { status: "expired" },
      },
    });
  });

  it("converts legacy exercise guidance only in a new editable version", async () => {
    const originalSlot = await database.db.query.workoutTemplateExercises.findFirst();
    if (!originalSlot) throw new Error("Slot missing");
    const state = await getOrCreateProgramDraft(database.db, userId);
    if (!state) throw new Error("Draft missing");
    expect(state.draft.document.days[0].warmupNotes).toContain("Band pull-aparts");
    expect(state.draft.document).toMatchObject({ schemaVersion: "3" });
    expect(state.draft.document.days[0].warmupItems).toEqual([
      expect.objectContaining({
        key: state.draft.document.days[0].lineageId,
        label: expect.stringContaining("Band pull-aparts"),
      }),
    ]);
    expect(state.draft.document.days[0].exercises[0]).toMatchObject({ warmupNotes: null, warmupSets: [], setNotes: [null, null, null] });
    expect(state.draft.document.days[0].exercises[0].notes).toContain("Set 1: Pause");

    const preserved = await database.db.query.workoutTemplateExercises.findFirst({ where: eq(workoutTemplateExercises.id, originalSlot.id) });
    expect(preserved).toMatchObject({ warmupNotes: "Band pull-aparts", setNotes: ["Pause", null, "Leave one rep"] });
    expect(preserved?.warmupSets).toHaveLength(1);
  });

  it("normalizes a pre-migration draft before review and preserves its revision", async () => {
    const state = await getOrCreateProgramDraft(database.db, userId);
    if (!state) throw new Error("Draft missing");
    const legacyDocument = structuredClone(state.draft.document);
    legacyDocument.name = "Legacy decimal draft";
    legacyDocument.days[0].exercises[0].targetLoad = 10.075;
    legacyDocument.days[0].exercises[0].targetLoadUnit = "lb";
    await database.db
      .update(programDrafts)
      .set({
        document: legacyDocument,
        contentHash: hashLegacyProgramDocument(legacyDocument),
      })
      .where(eq(programDrafts.id, state.draft.id));

    expect(await evaluateApplicationIntegrity(database.db, userId)).toEqual([]);

    const legacySnapshot = await captureUserSnapshot(
      database.db,
      userId,
      new Date("2026-07-14T12:00:00.000Z"),
      "legacy-draft-compatibility"
    );
    const upgradedSnapshot = upgradeSnapshotPayload(legacySnapshot);
    expect(() => validateSnapshotPayload(upgradedSnapshot, userId)).not.toThrow();
    const upgradedDraft = (
      upgradedSnapshot.tables.program_drafts as Array<Record<string, unknown>>
    ).find((row) => row.id === state.draft.id);
    expect(upgradedDraft).toMatchObject({
      reviewed_revision: null,
      review_hash: null,
      review_summary: null,
    });
    expect(
      (upgradedDraft?.document as typeof legacyDocument).days[0].exercises[0]
        .targetLoad
    ).toBe(10.08);
    expect(upgradedDraft?.content_hash).toBe(
      hashProgramDocument(upgradedDraft?.document)
    );

    const corruptedSnapshot = structuredClone(legacySnapshot);
    const corruptedDraft = (
      corruptedSnapshot.tables.program_drafts as Array<Record<string, unknown>>
    ).find((row) => row.id === state.draft.id);
    if (!corruptedDraft) throw new Error("Captured draft missing");
    corruptedDraft.content_hash = "0".repeat(64);
    expect(() => upgradeSnapshotPayload(corruptedSnapshot)).toThrow(/checksum/i);

    const review = await reviewProgramDraft(
      database.db,
      userId,
      state.draft.id,
      state.draft.revision
    );
    expect(review?.blockingErrors).toEqual([]);
    if (!review || review.status !== "publishable") {
      throw new Error("Review missing");
    }

    const normalized = await database.db.query.programDrafts.findFirst({
      where: eq(programDrafts.id, state.draft.id),
    });
    expect(normalized).toMatchObject({
      revision: state.draft.revision,
      reviewedRevision: state.draft.revision,
      contentHash: hashProgramDocument(normalized?.document),
      document: expect.objectContaining({ name: "Legacy decimal draft" }),
    });
    expect(
      (normalized?.document as typeof legacyDocument).days[0].exercises[0]
        .targetLoad
    ).toBe(10.08);

    const published = await publishProgramDraft(database.db, userId, {
      draftId: state.draft.id,
      expectedRevision: state.draft.revision,
      reviewHash: review.hash,
    });
    expect(published.ok).toBe(true);
    const slot = await currentSlot();
    expect(
      await database.db.query.exercisePrescriptions.findFirst({
        where: and(
          eq(exercisePrescriptions.templateExerciseId, slot.id),
          isNull(exercisePrescriptions.supersededById)
        ),
      })
    ).toMatchObject({ targetLoad: 10.08 });
  });

  it("rolls back injected publication failure and restores history only as a new reviewed version", async () => {
    const failedDraft = await reviewedEditedDraft(24, "Should not publish");
    const beforeFailure = await database.db.query.programs.findFirst({
      where: eq(programs.userId, userId),
    });
    const failed = await publishProgramDraft(database.db, userId, {
      draftId: failedDraft.draftId,
      expectedRevision: failedDraft.revision,
      reviewHash: failedDraft.review.hash,
      failureAt: "before-version",
    });
    expect(failed.ok).toBe(false);
    expect((await database.db.query.programs.findFirst({ where: eq(programs.userId, userId) }))?.currentVersionId)
      .toBe(beforeFailure?.currentVersionId);
    expect(await database.db.query.programVersions.findMany()).toHaveLength(1);
    expect(await database.db.query.programDrafts.findFirst({ where: eq(programDrafts.id, failedDraft.draftId) }))
      .toMatchObject({ status: "open" });

    const successful = await publishProgramDraft(database.db, userId, {
      draftId: failedDraft.draftId,
      expectedRevision: failedDraft.revision,
      reviewHash: failedDraft.review.hash,
    });
    expect(successful).toMatchObject({ ok: true, versionNo: 2 });
    const currentDraft = await getOrCreateProgramDraft(database.db, userId);
    if (!currentDraft) throw new Error("Current draft missing");

    const originalVersion = await database.db.query.programVersions.findFirst({
      where: eq(programVersions.versionNo, 1),
    });
    if (!originalVersion) throw new Error("Original version missing");
    const restoreMutationId = crypto.randomUUID();
    const restored = await createRestoreProgramDraft(database.db, userId, originalVersion.id, {
      currentDraftId: currentDraft.draft.id,
      expectedRevision: currentDraft.draft.revision,
      mutationId: restoreMutationId,
    });
    expect(restored.status).toBe("created");
    if (restored.status !== "created") throw new Error("Restore draft missing");
    const replayedRestore = await createRestoreProgramDraft(database.db, userId, originalVersion.id, {
      currentDraftId: currentDraft.draft.id,
      expectedRevision: currentDraft.draft.revision,
      mutationId: restoreMutationId,
    });
    expect(replayedRestore).toMatchObject({ status: "created", draft: { id: restored.draft.id } });
    const restoredReview = await reviewProgramDraft(
      database.db,
      userId,
      restored.draft.id,
      restored.draft.revision
    );
    if (!restoredReview || restoredReview.status !== "publishable") {
      throw new Error("Restore review missing");
    }
    const publication = await publishProgramDraft(database.db, userId, {
      draftId: restored.draft.id,
      expectedRevision: restored.draft.revision,
      reviewHash: restoredReview.hash,
    });
    expect(publication).toMatchObject({ ok: true, versionNo: 3 });
    if (!publication.ok) throw new Error(publication.reason);
    expect(await database.db.query.programVersions.findFirst({
      where: eq(programVersions.id, publication.programVersionId),
    })).toMatchObject({ restoredFromVersionId: originalVersion.id, publicationSource: "restore" });
  });

  it("applies recommendations by publishing a new version and preserves decision evidence", async () => {
    const program = await database.db.query.programs.findFirst({ where: eq(programs.userId, userId) });
    const slot = await database.db.query.workoutTemplateExercises.findFirst({
      with: { template: true },
    });
    if (!program?.currentVersionId || !slot) throw new Error("Program fixture missing");
    const payload = {
      kind: "load_change" as const,
      templateExerciseId: slot.id,
      fromLoad: 20,
      toLoad: 22,
      loadUnit: "lb" as const,
    };
    await database.db
      .update(exercises)
      .set({
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
      })
      .where(eq(exercises.id, exerciseId));
    const [evidenceSession] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Recommendation evidence",
        status: "completed",
        startedAt: new Date("2026-07-01T12:00:00.000Z"),
        finishedAt: new Date("2026-07-01T13:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-01",
      })
      .returning({ id: workoutSessions.id });
    const [evidenceExercise] = await database.db
      .insert(sessionExercises)
      .values({
        sessionId: evidenceSession.id,
        exerciseId,
        plannedFromTemplateExerciseId: slot.id,
        sourceSlotLineageId: slot.lineageId,
        modificationType: "as_planned",
        targetSets: 1,
        targetRepsMin: 8,
        targetRepsMax: 12,
        targetLoad: 20,
        targetLoadUnit: "lb",
      })
      .returning({ id: sessionExercises.id });
    const equipmentSnapshotId = await createTotalSystemTestSnapshot(
      database.db,
      {
        userId,
        sessionId: evidenceSession.id,
        sessionExerciseId: evidenceExercise.id,
        unit: "lb",
      }
    );
    const [evidenceSet] = await database.db
      .insert(completedSets)
      .values({
        sessionExerciseId: evidenceExercise.id,
        setNo: 1,
        weight: 20,
        weightUnit: "lb",
        reps: 12,
        metricType: "weight_reps",
        loadEntryMeaning: "total_system",
        equipmentSnapshotId,
      })
      .returning({ id: completedSets.id });
    await database.db.insert(sessionOccurrences).values({
      sessionId: evidenceSession.id,
      sessionExerciseId: evidenceExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exerciseId,
      outcome: "completed",
      resolvedAt: new Date("2026-07-01T12:30:00.000Z"),
      completedSetId: evidenceSet.id,
      equipmentSnapshotId,
    });
    const [recommendation] = await database.db.insert(recommendations).values({
      userId,
      source: "rule",
      status: "pending",
      sourceTemplateExerciseId: slot.id,
      sourceSlotLineageId: slot.lineageId,
      exerciseId,
      payload,
      reason: "Completed the target range",
      evidence: { signals: {}, setIds: [evidenceSet.id] },
    }).returning();
    const result = await publishRecommendationProgramVersion(database.db, userId, {
      recommendationId: recommendation.id,
      expectedPayload: payload,
      appliedPayload: payload,
      decision: "approve",
    });
    expect(result).toMatchObject({ ok: true, versionNo: 2 });
    if (!result.ok) throw new Error(result.reason);
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, recommendation.id),
    })).toMatchObject({
      status: "approved",
      reconciledByProgramVersionId: result.programVersionId,
    });
    expect(await database.db.select().from(userDecisions)).toHaveLength(1);
    expect(await database.db.select().from(adaptationEvents)).toHaveLength(1);
    const newSlots = await database.db.query.workoutTemplateExercises.findMany({
      where: eq(workoutTemplateExercises.lineageId, slot.lineageId),
    });
    const newSlot = newSlots.find((candidate) => candidate.id !== slot.id);
    expect(newSlot).toBeDefined();
    expect(await database.db.query.exercisePrescriptions.findFirst({
      where: and(
        eq(exercisePrescriptions.templateExerciseId, newSlot!.id),
        isNull(exercisePrescriptions.supersededById)
      ),
    })).toMatchObject({ targetLoad: 22, targetLoadUnit: "lb" });
    expect(await database.db.query.exercisePrescriptions.findFirst({
      where: eq(exercisePrescriptions.templateExerciseId, slot.id),
    })).toMatchObject({ targetLoad: 20 });
  });

  it("reconciles a Program-wide deload suggestion when a reviewed version is published", async () => {
    const [recommendation] = await database.db.insert(recommendations).values({
      userId,
      source: "rule",
      status: "pending",
      payload: {
        kind: "deload",
        scope: "program",
        volumeFactor: 0.6,
        loadFactor: 0.9,
        durationSessionsPerTemplate: 1,
      },
      reason: "Fatigue across the Program",
      evidence: { signals: { fatigue: true } },
    }).returning();
    expect(await database.db.query.programs.findFirst({
      where: eq(programs.userId, userId),
    })).toMatchObject({ recommendationRevision: 1 });

    const edited = await reviewedEditedDraft(25, "Post-deload review");
    expect(edited.review.recommendationConsequences).toContainEqual({
      recommendationId: recommendation.id,
      outcome: "superseded",
      explanation: "Publishing a newly reviewed Program version supersedes this Program-wide deload suggestion.",
    });
    const published = await publishProgramDraft(database.db, userId, {
      draftId: edited.draftId,
      expectedRevision: edited.revision,
      reviewHash: edited.review.hash,
    });
    expect(published).toMatchObject({ ok: true, versionNo: 2 });
    if (!published.ok) throw new Error(published.reason);
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, recommendation.id),
    })).toMatchObject({
      status: "expired",
      reconciledByProgramVersionId: published.programVersionId,
      reconciliationReason: "The edited Program changed the same target, so the older recommendation expired.",
    });
  });

  it("omits an unsupported legacy load suggestion from Program review", async () => {
    const slot = await currentSlot();
    const [recommendation] = await database.db.insert(recommendations).values({
      userId,
      source: "rule",
      status: "pending",
      sourceTemplateExerciseId: slot.id,
      sourceSlotLineageId: slot.lineageId,
      exerciseId,
      payload: {
        kind: "load_change",
        templateExerciseId: slot.id,
        fromLoad: 20,
        toLoad: 25,
        loadUnit: "lb",
      },
      reason: "Legacy suggestion without comparable set evidence",
      evidence: { signals: {}, setIds: [] },
    }).returning();

    const reviewed = await reviewedLoadDraft(20, "Unsupported suggestion hidden");

    expect(reviewed.review.recommendationConsequences).not.toContainEqual(
      expect.objectContaining({ recommendationId: recommendation.id }),
    );
  });

  it("reconciles float32 load targets with epsilon semantics", async () => {
    const initialSlot = await currentSlot();
    const alreadySatisfied = await insertLoadRecommendation(initialSlot, 20, 32.3);
    const satisfiedDraft = await reviewedLoadDraft(32.3, "32.3 satisfied");
    expect(satisfiedDraft.review.recommendationConsequences).toContainEqual({
      recommendationId: alreadySatisfied.id,
      outcome: "satisfied",
      explanation: "The edited target already matches this load suggestion.",
    });
    const satisfiedPublication = await publishReviewedLoadDraft(satisfiedDraft);
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, alreadySatisfied.id),
    })).toMatchObject({
      status: "expired",
      sourceTemplateExerciseId: initialSlot.id,
      reconciledByProgramVersionId: satisfiedPublication.programVersionId,
      reconciliationReason: "The new Program version already includes this recommendation.",
    });

    const storedFloatSlot = await currentSlot();
    expect(storedFloatSlot.id).not.toBe(initialSlot.id);
    const carry = await insertLoadRecommendation(storedFloatSlot, 32.3, 35);
    const carryDraft = await reviewedLoadDraft(32.3, "32.3 carried");
    expect(carryDraft.review.recommendationConsequences).toContainEqual({
      recommendationId: carry.id,
      outcome: "carry",
      explanation: "The same exercise and target remain, so this suggestion stays available.",
    });
    const carryPublication = await publishReviewedLoadDraft(carryDraft);
    const carriedSlot = await currentSlot();
    expect(carriedSlot.id).not.toBe(storedFloatSlot.id);
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, carry.id),
    })).toMatchObject({
      status: "pending",
      sourceTemplateExerciseId: carriedSlot.id,
      sourceSlotLineageId: storedFloatSlot.lineageId,
      payload: expect.objectContaining({ templateExerciseId: carriedSlot.id }),
      reconciledByProgramVersionId: carryPublication.programVersionId,
      reconciliationReason: "Carried forward to the matching exercise in the new Program version.",
    });

    const superseded = await insertLoadRecommendation(carriedSlot, 32.3, 40);
    const supersededDraft = await reviewedLoadDraft(32.31, "Outside load epsilon");
    expect(supersededDraft.review.recommendationConsequences).toContainEqual({
      recommendationId: superseded.id,
      outcome: "superseded",
      explanation: "The edited Program changes the target this suggestion expected.",
    });
    const supersededPublication = await publishReviewedLoadDraft(supersededDraft);
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, superseded.id),
    })).toMatchObject({
      status: "expired",
      sourceTemplateExerciseId: carriedSlot.id,
      reconciledByProgramVersionId: supersededPublication.programVersionId,
      reconciliationReason: "The edited Program changed the same target, so the older recommendation expired.",
    });

    const nullBaselineDraft = await reviewedLoadDraft(null, "Null load baseline");
    await publishReviewedLoadDraft(nullBaselineDraft);
    const nullSlot = await currentSlot();
    const nullCarry = await insertLoadRecommendation(nullSlot, null, 10);
    const nullCarryDraft = await reviewedLoadDraft(null, "Null load carried");
    expect(nullCarryDraft.review.recommendationConsequences).toContainEqual({
      recommendationId: nullCarry.id,
      outcome: "carry",
      explanation: "The same exercise and target remain, so this suggestion stays available.",
    });
    const nullCarryPublication = await publishReviewedLoadDraft(nullCarryDraft);
    const nextNullSlot = await currentSlot();
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, nullCarry.id),
    })).toMatchObject({
      status: "pending",
      sourceTemplateExerciseId: nextNullSlot.id,
      payload: expect.objectContaining({ templateExerciseId: nextNullSlot.id }),
      reconciledByProgramVersionId: nullCarryPublication.programVersionId,
      reconciliationReason: "Carried forward to the matching exercise in the new Program version.",
    });
  });
});
