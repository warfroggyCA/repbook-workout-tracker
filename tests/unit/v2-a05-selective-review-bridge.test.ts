import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { resultRows } from "@/db/result";
import {
  adaptationEvents,
  analysisPackageManifests,
  auditLogs,
  coachingInsights,
  constraints,
  exercises,
  healthActivities,
  programs,
  programVersions,
  recommendations,
  userDecisions,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { createAnalysisPackage } from "@/services/analysis-package";
import { importExternalAnalysisSelection } from "@/services/external-analysis-import";
import { getExternalAnalysisSourceBindingFreshness } from "@/services/external-analysis-validation";
import {
  externalAnalysisImportDigestSchema,
  type ExternalAnalysisImportRequest,
} from "@/lib/external-analysis-import";
import { externalAnalysisResponseSchema } from "@/lib/external-analysis-response";
import {
  approveRecommendationDecision,
  deferRecommendationDecision,
  rejectRecommendationDecision,
  resumeRecommendationDecision,
} from "@/services/recommendation-decisions";
import { resolveReviewEvidence } from "@/services/review-evidence";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
  upgradeSnapshotPayload,
  validateSnapshotPayload,
} from "@/services/snapshot-restore";
import { buildJsonBackup } from "@/services/export";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import { createDataSnapshot, type SnapshotKeyring } from "@/services/snapshots";
import { ANALYSIS_PACKAGE_SOURCE_BINDING_ENTITIES } from "@/lib/analysis-package";
import validFixture from "../fixtures/v2/a03-typed-response.json";

describe("A05 selective external-analysis Review bridge", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ownerId: string;
  let programId: string;
  let currentVersionId: string;
  let completedSessionId: string;
  let packageNo = 0;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    const [owner] = await db
      .insert(users)
      .values({ email: `a05-owner-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    ownerId = owner.id;
    await db.insert(userProfiles).values({
      userId: ownerId,
      goals: ["synthetic A05 Review"],
      unit: "kg",
      timezone: "America/Toronto",
    });
    const [exercise] = await db
      .insert(exercises)
      .values({
        userId: ownerId,
        name: "A05 synthetic press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
      })
      .returning({ id: exercises.id });
    const activation = await activateProgramAtomically(db, {
      userId: ownerId,
      loadUnit: "kg",
      programName: "A05 synthetic Program",
      days: [{
        name: "Day A",
        exercises: [{
          exerciseId: exercise.id,
          sets: 3,
          repMin: 5,
          repMax: 8,
          targetLoad: 60,
          restSec: 120,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Synthetic A05 fixture",
      auditAction: "program.activate",
      auditSummary: "Synthetic A05 fixture",
      structuredIntentReviewed: true,
    });
    if (!activation.ok) throw new Error(activation.reason);
    const program = await db.query.programs.findFirst({
      where: eq(programs.userId, ownerId),
    });
    if (!program?.currentVersionId) throw new Error("Program fixture missing.");
    programId = program.id;
    currentVersionId = program.currentVersionId;
    const [completedSession] = await db
      .insert(workoutSessions)
      .values({
        userId: ownerId,
        templateName: "A05 retained evidence",
        status: "completed",
        startedAt: new Date("2026-08-07T14:00:00.000Z"),
        finishedAt: new Date("2026-08-07T14:45:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-08-07",
      })
      .returning({ id: workoutSessions.id });
    completedSessionId = completedSession.id;
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  async function createImportRequest(
    questionId:
      | "program_progress"
      | "training_consistency"
      | "recovery_constraints" = "program_progress",
  ): Promise<ExternalAnalysisImportRequest> {
    packageNo += 1;
    const packageId = `55555555-5555-4555-8555-${String(packageNo).padStart(12, "0")}`;
    const responseId = `66666666-6666-4666-8666-${String(packageNo).padStart(12, "0")}`;
    const created = await createAnalysisPackage(
      db,
      ownerId,
      { questionId, windowDays: 84 },
      {
        now: new Date(Date.UTC(2026, 7, 8, 10, packageNo)),
        packageId,
        appVersion: "a05-test",
      },
    );
    const response = structuredClone(validFixture);
    response.responseId = responseId;
    response.analysisPackage = {
      packageId: created.package.packageId,
      packageNamespace: created.package.packageNamespace,
      schemaVersion: created.package.schemaVersion,
      semanticVersion: created.package.semanticVersion,
      digest: created.package.integrity.digest,
      evidenceCutoff: created.package.evidenceCutoff,
      expiresAt: created.package.expiresAt,
    };
    response.question = {
      id: created.package.request.questionId,
      text: created.package.request.question,
    };
    const evidenceId = created.package.currentProgramIntent.program?.id;
    if (!evidenceId) throw new Error("Program evidence missing.");
    for (const observation of response.observations) observation.evidenceIds = [evidenceId];
    for (const proposal of response.proposedActions) {
      proposal.evidenceIds = [evidenceId];
      proposal.effect.target.evidenceIds = [evidenceId];
    }
    for (const unknown of response.unknowns) unknown.evidenceIds = [evidenceId];
    return {
      response: externalAnalysisResponseSchema.parse(response),
      selections: {
        observationIds: [response.observations[0].id],
        proposalIds: [response.proposedActions[0].id],
      },
    };
  }

  async function createTwoProposalImportRequest(): Promise<ExternalAnalysisImportRequest> {
    const request = await createImportRequest();
    const secondProposal = structuredClone(request.response.proposedActions[0]);
    secondProposal.id = "proposal-second-independent-review";
    secondProposal.summary = "Review a second independent future direction.";
    request.response.proposedActions.push(secondProposal);
    request.selections.proposalIds.push(secondProposal.id);
    return request;
  }

  it("keeps the evidence-epoch trigger inventory closed over every source entity", async () => {
    const triggerRows = resultRows(await db.execute(sql`
      SELECT relation.relname AS entity
      FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid = trigger.tgrelid
      WHERE trigger.tgname = 'analysis_evidence_revision_guard'
        AND NOT trigger.tgisinternal
      ORDER BY relation.relname
    `));
    expect(triggerRows.map((row) => String(row.entity))).toEqual(
      [...ANALYSIS_PACKAGE_SOURCE_BINDING_ENTITIES].sort(),
    );
  });

  it("imports only selected allowlisted items, consumes the manifest, and replays idempotently", async () => {
    const request = await createImportRequest();
    const first = await importExternalAnalysisSelection(db, ownerId, request, {
      now: new Date("2026-08-08T18:00:00.000Z"),
    });
    expect(first).toMatchObject({
      ok: true,
      replay: "new",
      observationCount: 1,
      proposalCount: 1,
    });
    expect(await db.select().from(analysisPackageManifests)).toHaveLength(0);
    const imports = await db.select().from(coachingInsights);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      kind: "external_analysis_import",
      clientKey: request.response.responseId,
      model: null,
    });
    expect(JSON.stringify(imports[0]!.dataDigest)).not.toContain(
      request.response.unknowns[0].detail,
    );
    const importedRecommendations = await db.select().from(recommendations);
    expect(importedRecommendations).toHaveLength(1);
    expect(importedRecommendations[0]).toMatchObject({
      source: "ai",
      ruleId: "external_analysis",
      status: "pending",
      payload: expect.objectContaining({ kind: "external_review" }),
    });
    expect(await db.select().from(userDecisions)).toHaveLength(0);
    expect(await db.select().from(adaptationEvents)).toHaveLength(0);

    await expect(
      importExternalAnalysisSelection(db, ownerId, request),
    ).resolves.toMatchObject({ ok: true, replay: "idempotent_duplicate" });
    expect(await db.select().from(recommendations)).toHaveLength(1);

    const conflicting = structuredClone(request);
    conflicting.response.observations[0].statement = "Changed under the same response identity.";
    await expect(
      importExternalAnalysisSelection(db, ownerId, conflicting),
    ).resolves.toMatchObject({ ok: false, reason: "conflict" });
  }, 30_000);

  it("keeps ownership fail-closed and rolls every write back on an interrupted import", async () => {
    const request = await createImportRequest();
    const [otherOwner] = await db
      .insert(users)
      .values({ email: `a05-other-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });

    await expect(
      importExternalAnalysisSelection(db, otherOwner.id, request),
    ).resolves.toMatchObject({ ok: false, reason: "missing_manifest" });
    expect(await db.select().from(coachingInsights)).toHaveLength(0);
    expect(await db.select().from(recommendations)).toHaveLength(0);

    await expect(
      importExternalAnalysisSelection(db, ownerId, request, {
        now: new Date("2026-08-08T18:00:00.000Z"),
        failureAt: "after-selection",
      }),
    ).rejects.toThrow();
    expect(await db.select().from(analysisPackageManifests)).toHaveLength(1);
    expect(await db.select().from(coachingInsights)).toHaveLength(0);
    expect(await db.select().from(recommendations)).toHaveLength(0);
    expect(
      (await db.select().from(auditLogs)).filter(
        (row) => row.action === "external_analysis.import",
      ),
    ).toHaveLength(0);
  }, 30_000);

  it("rejects corrected evidence before import and at the atomic manifest claim", async () => {
    const correctedBeforeImport = await createImportRequest();
    await db
      .update(workoutSessions)
      .set({ historyRevision: 1 })
      .where(eq(workoutSessions.id, completedSessionId));
    await expect(
      importExternalAnalysisSelection(db, ownerId, correctedBeforeImport),
    ).resolves.toMatchObject({ ok: false, reason: "stale_evidence" });
    expect(await db.select().from(coachingInsights)).toHaveLength(0);
    expect(await db.select().from(recommendations)).toHaveLength(0);
    expect(await db.select().from(analysisPackageManifests)).toHaveLength(1);

    await db
      .update(workoutSessions)
      .set({ historyRevision: 0 })
      .where(eq(workoutSessions.id, completedSessionId));
    const correctedDuringImport = await createImportRequest();
    await expect(
      importExternalAnalysisSelection(db, ownerId, correctedDuringImport, {
        beforeClaim: async () => {
          await db
            .update(workoutSessions)
            .set({ historyRevision: 1 })
            .where(eq(workoutSessions.id, completedSessionId));
        },
      }),
    ).resolves.toMatchObject({ ok: false, reason: "stale_evidence" });
    expect(await db.select().from(coachingInsights)).toHaveLength(0);
    expect(await db.select().from(recommendations)).toHaveLength(0);
    expect(await db.select().from(analysisPackageManifests)).toHaveLength(2);
  }, 30_000);

  it("stale-fences mutable constraints and archived activities across import", async () => {
    const [constraint] = await db.insert(constraints).values({
      userId: ownerId,
      bodyPart: "synthetic shoulder",
      affectedPatterns: ["horizontal_push"],
      note: "Initial retained constraint",
    }).returning({ id: constraints.id });
    const beforeConstraintChange = await createImportRequest();
    await db.update(constraints).set({
      note: "Changed after package preview",
    }).where(eq(constraints.id, constraint.id));
    await expect(
      importExternalAnalysisSelection(db, ownerId, beforeConstraintChange),
    ).resolves.toMatchObject({ ok: false, reason: "stale_evidence" });

    const duringConstraintChange = await createImportRequest();
    await expect(
      importExternalAnalysisSelection(db, ownerId, duringConstraintChange, {
        beforeClaim: async () => {
          await db.update(constraints).set({
            note: "Changed during atomic import claim",
          }).where(eq(constraints.id, constraint.id));
        },
      }),
    ).resolves.toMatchObject({ ok: false, reason: "stale_evidence" });

    const afterConstraintChange = await createImportRequest();
    const constraintImport = await importExternalAnalysisSelection(
      db,
      ownerId,
      afterConstraintChange,
    );
    if (!constraintImport.ok) throw new Error(constraintImport.message);
    const constraintReceipt = await db.query.coachingInsights.findFirst({
      where: eq(coachingInsights.id, constraintImport.importId),
    });
    const constraintDigest = externalAnalysisImportDigestSchema.parse(
      constraintReceipt?.dataDigest,
    );
    await db.update(constraints).set({
      note: "Changed after import",
    }).where(eq(constraints.id, constraint.id));
    await expect(getExternalAnalysisSourceBindingFreshness(
      db,
      ownerId,
      constraintDigest.sourceBindings,
      constraintDigest.package.sourceEvidenceRevision,
    )).resolves.toEqual({ ok: false, reason: "stale_evidence" });

    const [activity] = await db.insert(healthActivities).values({
      userId: ownerId,
      activityType: "walk",
      title: "Synthetic context walk",
      startedAt: new Date("2026-08-07T12:00:00.000Z"),
      timezone: "America/Toronto",
      durationSeconds: 1800,
      fingerprint: `a05-${crypto.randomUUID()}`,
    }).returning({ id: healthActivities.id });
    const activityRequest = await createImportRequest("training_consistency");
    const activityImport = await importExternalAnalysisSelection(
      db,
      ownerId,
      activityRequest,
    );
    if (!activityImport.ok) throw new Error(activityImport.message);
    const activityReceipt = await db.query.coachingInsights.findFirst({
      where: eq(coachingInsights.id, activityImport.importId),
    });
    const activityDigest = externalAnalysisImportDigestSchema.parse(
      activityReceipt?.dataDigest,
    );
    await db.update(healthActivities).set({
      archivedAt: new Date("2026-08-08T20:00:00.000Z"),
    }).where(eq(healthActivities.id, activity.id));
    await expect(getExternalAnalysisSourceBindingFreshness(
      db,
      ownerId,
      activityDigest.sourceBindings,
      activityDigest.package.sourceEvidenceRevision,
    )).resolves.toEqual({ ok: false, reason: "stale_evidence" });
  }, 60_000);

  it("stale-fences newly inserted safety and activity evidence across the import boundary", async () => {
    const beforeFirstConstraint = await createImportRequest("recovery_constraints");
    await db.insert(constraints).values({
      userId: ownerId,
      bodyPart: "synthetic elbow",
      affectedPatterns: ["horizontal_push"],
      note: "First constraint added after package preparation",
    });
    await expect(importExternalAnalysisSelection(
      db,
      ownerId,
      beforeFirstConstraint,
    )).resolves.toMatchObject({ ok: false, reason: "stale_evidence" });

    const duringNewConstraint = await createImportRequest("recovery_constraints");
    await expect(importExternalAnalysisSelection(
      db,
      ownerId,
      duringNewConstraint,
      {
        beforeClaim: async () => {
          await db.insert(constraints).values({
            userId: ownerId,
            bodyPart: "synthetic wrist",
            affectedPatterns: ["horizontal_push"],
            note: "Second constraint added during atomic claim",
          });
        },
      },
    )).resolves.toMatchObject({ ok: false, reason: "stale_evidence" });

    const [archivedActivity] = await db.insert(healthActivities).values({
      userId: ownerId,
      activityType: "walk",
      title: "Initially archived in-window activity",
      startedAt: new Date("2026-08-07T15:00:00.000Z"),
      timezone: "America/Toronto",
      durationSeconds: 600,
      fingerprint: `a05-reactivate-${crypto.randomUUID()}`,
      archivedAt: new Date("2026-08-08T09:00:00.000Z"),
    }).returning({ id: healthActivities.id });
    const beforeReactivation = await createImportRequest("training_consistency");
    await db.update(healthActivities).set({
      archivedAt: null,
    }).where(eq(healthActivities.id, archivedActivity.id));
    await expect(importExternalAnalysisSelection(
      db,
      ownerId,
      beforeReactivation,
    )).resolves.toMatchObject({ ok: false, reason: "stale_evidence" });

    const beforeNewActivity = await createImportRequest("training_consistency");
    const imported = await importExternalAnalysisSelection(
      db,
      ownerId,
      beforeNewActivity,
    );
    if (!imported.ok) throw new Error(imported.message);
    const receipt = await db.query.coachingInsights.findFirst({
      where: eq(coachingInsights.id, imported.importId),
    });
    const digest = externalAnalysisImportDigestSchema.parse(receipt?.dataDigest);
    await expect(getExternalAnalysisSourceBindingFreshness(
      db,
      ownerId,
      digest.sourceBindings,
      digest.package.sourceEvidenceRevision,
    )).resolves.toEqual({ ok: true });

    await db.insert(healthActivities).values({
      userId: ownerId,
      activityType: "walk",
      title: "New in-window activity after import",
      startedAt: new Date("2026-08-07T16:00:00.000Z"),
      timezone: "America/Toronto",
      durationSeconds: 900,
      fingerprint: `a05-insert-${crypto.randomUUID()}`,
    });
    await expect(getExternalAnalysisSourceBindingFreshness(
      db,
      ownerId,
      digest.sourceBindings,
      digest.package.sourceEvidenceRevision,
    )).resolves.toEqual({ ok: false, reason: "stale_evidence" });
  }, 60_000);

  it("backs up and fully restores a legitimate stale external receipt", async () => {
    const request = await createImportRequest();
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    await db.update(workoutSessions).set({
      historyRevision: 1,
    }).where(eq(workoutSessions.id, completedSessionId));

    await expect(buildJsonBackup(db, ownerId, undefined, {
      now: new Date("2026-08-08T20:00:00.000Z"),
      appVersion: "a05-stale-restore",
    })).resolves.toMatchObject({ schemaVersion: "36" });

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 77);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown A05 snapshot key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      db,
      ownerId,
      { name: "A05 stale receipt", reason: "manual", pinned: true },
      { store, keyring, appVersion: "a05-stale-restore" },
    );
    if (!created.ok) throw new Error(created.reason);
    await db.update(userProfiles).set({
      goals: ["temporary post-snapshot goal"],
    }).where(eq(userProfiles.userId, ownerId));
    const preview = await getSnapshotRestorePreview(
      db,
      ownerId,
      created.snapshotId,
      "full",
      { store, keyring },
    );
    const repeatedPreview = await getSnapshotRestorePreview(
      db,
      ownerId,
      created.snapshotId,
      "full",
      { store, keyring },
    );
    expect(repeatedPreview.fingerprint).toBe(preview.fingerprint);
    const restored = await restoreDataSnapshot(
      db,
      ownerId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: repeatedPreview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "a05-stale-restore" },
    );
    if (!restored.ok) throw new Error(restored.reason);
    expect(restored).toMatchObject({ ok: true, scope: "full" });
    expect(await db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, completedSessionId),
    })).toMatchObject({ historyRevision: 1 });
    expect(await db.query.coachingInsights.findFirst({
      where: eq(coachingInsights.id, imported.importId),
    })).toMatchObject({ kind: "external_analysis_import" });
    expect(await db.query.userProfiles.findFirst({
      where: eq(userProfiles.userId, ownerId),
    })).toMatchObject({ goals: ["synthetic A05 Review"] });
  }, 60_000);

  it("keeps defer and reject durable without creating an adaptation", async () => {
    const request = await createImportRequest();
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    const recommendation = (await db.select().from(recommendations))[0]!;

    await expect(deferRecommendationDecision(db, ownerId, {
      recommendationId: recommendation.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 0,
      revisitOn: "2026-08-20",
      reason: "Review after another training week.",
    })).resolves.toEqual({ ok: true });
    await expect(resumeRecommendationDecision(db, ownerId, {
      recommendationId: recommendation.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 1,
    })).resolves.toEqual({ ok: true });
    await expect(rejectRecommendationDecision(db, ownerId, {
      recommendationId: recommendation.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 2,
      reason: "Not useful for this Program.",
    })).resolves.toEqual({ ok: true });
    expect(await db.select().from(adaptationEvents)).toHaveLength(0);
    expect((await db.select().from(recommendations))[0]?.status).toBe("rejected");
  }, 30_000);

  it("keeps a fresh external proposal actionable across its own defer and resume lifecycle", async () => {
    const request = await createImportRequest();
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    const recommendation = (await db.select().from(recommendations))[0]!;

    await expect(deferRecommendationDecision(db, ownerId, {
      recommendationId: recommendation.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 0,
      revisitOn: "2026-08-20",
      reason: "Review after another training week.",
    })).resolves.toEqual({ ok: true });
    await expect(resumeRecommendationDecision(db, ownerId, {
      recommendationId: recommendation.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 1,
    })).resolves.toEqual({ ok: true });

    const resumed = await db.query.recommendations.findFirst({
      where: eq(recommendations.id, recommendation.id),
    });
    expect(resumed).toMatchObject({
      status: "pending",
      reviewRevision: 1,
      deferRevision: 2,
      deferredAt: null,
    });
    expect(await resolveReviewEvidence(db, ownerId, resumed!)).toMatchObject({
      state: "external",
      actionable: true,
    });
    await expect(approveRecommendationDecision(db, ownerId, {
      recommendationId: recommendation.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 2,
    })).resolves.toEqual({ ok: true });
  }, 30_000);

  it("keeps sibling proposals actionable after a decision from the same import", async () => {
    const request = await createTwoProposalImportRequest();
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    const receiptBefore = await db.query.coachingInsights.findFirst({
      where: eq(coachingInsights.id, imported.importId),
    });
    const digestBefore = externalAnalysisImportDigestSchema.parse(receiptBefore?.dataDigest);
    const importedRecommendations = await db.select().from(recommendations);
    expect(importedRecommendations).toHaveLength(2);

    await expect(approveRecommendationDecision(db, ownerId, {
      recommendationId: importedRecommendations[0]!.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 0,
    })).resolves.toEqual({ ok: true });
    const sibling = await db.query.recommendations.findFirst({
      where: eq(recommendations.id, importedRecommendations[1]!.id),
    });
    expect(await resolveReviewEvidence(db, ownerId, sibling!)).toMatchObject({
      state: "external",
      actionable: true,
    });
    await expect(approveRecommendationDecision(db, ownerId, {
      recommendationId: sibling!.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 0,
    })).resolves.toEqual({ ok: true });
    expect(await db.select().from(userDecisions)).toHaveLength(2);
    expect(await db.select().from(adaptationEvents)).toHaveLength(2);
    const receiptAfter = await db.query.coachingInsights.findFirst({
      where: eq(coachingInsights.id, imported.importId),
    });
    const digestAfter = externalAnalysisImportDigestSchema.parse(receiptAfter?.dataDigest);
    const expectedDigest = structuredClone(digestBefore);
    expectedDigest.package.sourceEvidenceRevision = digestAfter.package.sourceEvidenceRevision;
    expect(digestAfter).toEqual(expectedDigest);
    const owner = await db.query.users.findFirst({ where: eq(users.id, ownerId) });
    expect(digestAfter.package.sourceEvidenceRevision).toBe(
      String(owner?.analysisEvidenceRevision),
    );
    await expect(buildJsonBackup(db, ownerId, undefined, {
      now: new Date("2026-08-08T22:00:00.000Z"),
      appVersion: "a05-sibling-decisions",
    })).resolves.toMatchObject({ schemaVersion: "36" });
  }, 30_000);

  it("rolls back the receipt cursor with a failed external decision", async () => {
    const request = await createImportRequest();
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    const recommendation = (await db.select().from(recommendations))[0]!;
    const receiptBefore = await db.query.coachingInsights.findFirst({
      where: eq(coachingInsights.id, imported.importId),
    });
    const ownerBefore = await db.query.users.findFirst({ where: eq(users.id, ownerId) });

    await expect(approveRecommendationDecision(
      db,
      ownerId,
      {
        recommendationId: recommendation.id,
        expectedReviewRevision: 1,
        expectedDeferRevision: 0,
      },
      { failureAt: "before-audit" },
    )).rejects.toThrow();

    expect(await db.query.coachingInsights.findFirst({
      where: eq(coachingInsights.id, imported.importId),
    })).toEqual(receiptBefore);
    expect(await db.query.users.findFirst({ where: eq(users.id, ownerId) })).toEqual(ownerBefore);
    expect((await db.select().from(recommendations))[0]).toMatchObject({ status: "pending" });
    expect(await db.select().from(userDecisions)).toHaveLength(0);
    expect(await db.select().from(adaptationEvents)).toHaveLength(0);
  }, 30_000);

  it("keeps a sibling actionable after rejecting another proposal from the same import", async () => {
    const request = await createTwoProposalImportRequest();
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    const importedRecommendations = await db.select().from(recommendations);

    await expect(rejectRecommendationDecision(db, ownerId, {
      recommendationId: importedRecommendations[0]!.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 0,
      reason: "Not useful for this Review.",
    })).resolves.toEqual({ ok: true });
    const sibling = await db.query.recommendations.findFirst({
      where: eq(recommendations.id, importedRecommendations[1]!.id),
    });
    expect(await resolveReviewEvidence(db, ownerId, sibling!)).toMatchObject({
      state: "external",
      actionable: true,
    });
    expect(await db.select().from(userDecisions)).toHaveLength(1);
    expect(await db.select().from(adaptationEvents)).toHaveLength(0);
  }, 30_000);

  it("does not revalidate a receipt after unrelated evidence changes during Review", async () => {
    const request = await createTwoProposalImportRequest();
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    const importedRecommendations = await db.select().from(recommendations);
    const deferred = importedRecommendations[0]!;
    const sibling = importedRecommendations[1]!;

    await expect(deferRecommendationDecision(db, ownerId, {
      recommendationId: deferred.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 0,
      reason: "Pause before new evidence arrives.",
    })).resolves.toEqual({ ok: true });
    await db.insert(constraints).values({
      userId: ownerId,
      bodyPart: "synthetic shoulder",
      affectedPatterns: ["horizontal_push"],
      note: "Unrelated safety evidence added after import",
    });
    await expect(resumeRecommendationDecision(db, ownerId, {
      recommendationId: deferred.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 1,
    })).resolves.toEqual({ ok: true });

    const resumed = await db.query.recommendations.findFirst({
      where: eq(recommendations.id, deferred.id),
    });
    const currentSibling = await db.query.recommendations.findFirst({
      where: eq(recommendations.id, sibling.id),
    });
    expect(await resolveReviewEvidence(db, ownerId, resumed!)).toMatchObject({
      state: "stale",
      actionable: false,
    });
    expect(await resolveReviewEvidence(db, ownerId, currentSibling!)).toMatchObject({
      state: "stale",
      actionable: false,
    });
    await expect(approveRecommendationDecision(db, ownerId, {
      recommendationId: sibling.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 0,
    })).resolves.toMatchObject({ ok: false });
    expect(await db.select().from(userDecisions)).toHaveLength(0);
    expect(await db.select().from(adaptationEvents)).toHaveLength(0);
  }, 30_000);

  it("edit-and-accept atomically records only a future Review direction", async () => {
    const request = await createImportRequest();
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    const recommendation = (await db.select().from(recommendations))[0]!;
    const assessment = await resolveReviewEvidence(db, ownerId, recommendation);
    expect(assessment).toMatchObject({ state: "external", actionable: true });

    await expect(approveRecommendationDecision(db, ownerId, {
      recommendationId: recommendation.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 0,
      editedRequestedOutcome: "Review a smaller future change after the next two sessions.",
    })).resolves.toEqual({ ok: true });

    expect((await db.select().from(recommendations))[0]?.status).toBe("edited");
    expect((await db.select().from(userDecisions))[0]).toMatchObject({
      decision: "edit",
      editedPayload: expect.objectContaining({ kind: "external_review" }),
    });
    expect((await db.select().from(adaptationEvents))[0]?.afterSnapshot).toMatchObject({
      schemaVersion: "external-review-intent-v1",
      state: "accepted",
      programChanged: false,
    });
    expect((await db.select().from(programs))[0]).toMatchObject({
      id: programId,
      currentVersionId,
    });
    expect(await db.select().from(programVersions)).toHaveLength(1);
  }, 30_000);

  it("atomically blocks new safety evidence after decision preflight", async () => {
    const request = await createImportRequest("recovery_constraints");
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    const recommendation = (await db.select().from(recommendations))[0]!;

    await expect(approveRecommendationDecision(
      db,
      ownerId,
      {
        recommendationId: recommendation.id,
        expectedReviewRevision: 1,
        expectedDeferRevision: 0,
      },
      {
        checkpoint: async (boundary) => {
          if (boundary !== "recommendation-ready") return;
          await db.insert(constraints).values({
            userId: ownerId,
            bodyPart: "synthetic shoulder",
            affectedPatterns: ["horizontal_push"],
            note: "New safety evidence after Review preflight",
          });
        },
      },
    )).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("became stale"),
    });
    expect((await db.select().from(recommendations))[0]).toMatchObject({
      status: "pending",
    });
    expect(await db.select().from(userDecisions)).toHaveLength(0);
    expect(await db.select().from(adaptationEvents)).toHaveLength(0);
  }, 30_000);

  it("stale-fences evidence correction and Program drift while preserving the allowlisted receipt through snapshot validation", async () => {
    const request = await createImportRequest();
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    const recommendation = (await db.select().from(recommendations))[0]!;
    const receipt = (await db.select().from(coachingInsights))[0]!;
    const receiptDigest = externalAnalysisImportDigestSchema.parse(receipt.dataDigest);
    await expect(
      getExternalAnalysisSourceBindingFreshness(
        db,
        ownerId,
        receiptDigest.sourceBindings,
        receiptDigest.package.sourceEvidenceRevision,
      ),
    ).resolves.toEqual({ ok: true });

    const snapshot = await captureUserSnapshot(
      db,
      ownerId,
      new Date("2026-08-08T19:00:00.000Z"),
      "a05-test",
    );
    expect(snapshot.tables.coaching_insights).toContainEqual(
      expect.objectContaining({ kind: "external_analysis_import" }),
    );
    expect(JSON.stringify(snapshot)).not.toContain(request.response.unknowns[0].detail);
    const upgraded = upgradeSnapshotPayload(snapshot);
    expect(() => validateSnapshotPayload(upgraded, ownerId)).not.toThrow();

    const missingSource = structuredClone(upgraded);
    const missingReceipt = missingSource.tables.coaching_insights.find(
      (row) => (row as Record<string, unknown>).kind === "external_analysis_import",
    ) as Record<string, unknown>;
    const missingDigest = missingReceipt.data_digest as {
      sourceBindings: Array<{
        entity: string;
        ids: string[];
        contentHashes: Array<{ id: string; hash: string }>;
        versionTokens?: Array<{ id: string; token: string }>;
      }>;
    };
    const profileBinding = missingDigest.sourceBindings.find(
      (binding) => binding.entity === "user_profiles",
    );
    if (!profileBinding) throw new Error("Profile source binding missing.");
    const substitutedSourceId = crypto.randomUUID();
    profileBinding.ids[0] = substitutedSourceId;
    profileBinding.contentHashes[0]!.id = substitutedSourceId;
    if (profileBinding.versionTokens?.[0]) {
      profileBinding.versionTokens[0].id = substitutedSourceId;
    }
    expect(() => validateSnapshotPayload(missingSource, ownerId)).toThrow(
      "source bindings do not match retained owner evidence",
    );

    const changedRevision = structuredClone(upgraded);
    const changedReceipt = changedRevision.tables.coaching_insights.find(
      (row) => (row as Record<string, unknown>).kind === "external_analysis_import",
    ) as Record<string, unknown>;
    const changedDigest = changedReceipt.data_digest as {
      sourceBindings: Array<{
        entity: string;
        revisions?: Array<{ id: string; revision: number }>;
      }>;
    };
    const workoutBinding = changedDigest.sourceBindings.find(
      (binding) => binding.entity === "workout_sessions",
    );
    if (!workoutBinding?.revisions?.[0]) {
      throw new Error("Workout revision source binding missing.");
    }
    workoutBinding.revisions[0].revision += 1;
    expect(() => validateSnapshotPayload(changedRevision, ownerId)).toThrow(
      "source bindings do not match retained owner evidence",
    );

    const foreignNamespace = structuredClone(upgraded);
    const foreignReceipt = foreignNamespace.tables.coaching_insights.find(
      (row) => (row as Record<string, unknown>).kind === "external_analysis_import",
    ) as Record<string, unknown>;
    const foreignDigest = foreignReceipt.data_digest as {
      package: { namespace: string };
    };
    foreignDigest.package.namespace = "repbook-owner/000000000000000000000000";
    expect(() => validateSnapshotPayload(foreignNamespace, ownerId)).toThrow(
      "import receipt is invalid",
    );

    const unknownBinding = structuredClone(upgraded);
    const unknownReceipt = unknownBinding.tables.coaching_insights.find(
      (row) => (row as Record<string, unknown>).kind === "external_analysis_import",
    ) as Record<string, unknown>;
    const unknownDigest = unknownReceipt.data_digest as {
      sourceBindings: Array<{ entity: string }>;
    };
    unknownDigest.sourceBindings[0]!.entity = "untrusted_rows";
    expect(() => validateSnapshotPayload(unknownBinding, ownerId)).toThrow(
      "import receipt is invalid",
    );

    const unboundCitation = structuredClone(upgraded);
    const citationReceipt = unboundCitation.tables.coaching_insights.find(
      (row) => (row as Record<string, unknown>).kind === "external_analysis_import",
    ) as Record<string, unknown>;
    const citationDigest = citationReceipt.data_digest as {
      observations: Array<{ evidenceIds: string[] }>;
    };
    citationDigest.observations[0]!.evidenceIds = [crypto.randomUUID()];
    expect(() => validateSnapshotPayload(unboundCitation, ownerId)).toThrow(
      "import receipt is invalid",
    );

    await db
      .update(workoutSessions)
      .set({ historyRevision: 1 })
      .where(eq(workoutSessions.id, completedSessionId));
    await expect(resolveReviewEvidence(db, ownerId, recommendation)).resolves.toMatchObject({
      state: "stale",
      actionable: false,
    });
    await expect(
      getExternalAnalysisSourceBindingFreshness(
        db,
        ownerId,
        receiptDigest.sourceBindings,
        receiptDigest.package.sourceEvidenceRevision,
      ),
    ).resolves.toEqual({ ok: false, reason: "stale_evidence" });
    await db
      .update(workoutSessions)
      .set({ historyRevision: 0 })
      .where(eq(workoutSessions.id, completedSessionId));
    await expect(resolveReviewEvidence(db, ownerId, recommendation)).resolves.toMatchObject({
      state: "stale",
      actionable: false,
    });

    const [nextVersion] = await db
      .insert(programVersions)
      .values({
        programId,
        versionNo: 2,
        name: "A05 later Program",
        publicationSource: "editor",
      })
      .returning({ id: programVersions.id });
    await db
      .update(programs)
      .set({ currentVersionId: nextVersion.id })
      .where(eq(programs.id, programId));
    await expect(resolveReviewEvidence(db, ownerId, recommendation)).resolves.toMatchObject({
      state: "stale",
      actionable: false,
    });
    await expect(approveRecommendationDecision(db, ownerId, {
      recommendationId: recommendation.id,
      expectedReviewRevision: 1,
      expectedDeferRevision: 0,
    })).resolves.toMatchObject({ ok: false });
    expect(await db.select().from(userDecisions)).toHaveLength(0);
    expect(await db.select().from(adaptationEvents)).toHaveLength(0);
  }, 30_000);
});
