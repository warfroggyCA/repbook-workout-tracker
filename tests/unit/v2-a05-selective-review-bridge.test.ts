import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  adaptationEvents,
  analysisPackageManifests,
  auditLogs,
  coachingInsights,
  exercises,
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
import type { ExternalAnalysisImportRequest } from "@/lib/external-analysis-import";
import { externalAnalysisResponseSchema } from "@/lib/external-analysis-response";
import {
  approveRecommendationDecision,
  deferRecommendationDecision,
  rejectRecommendationDecision,
  resumeRecommendationDecision,
} from "@/services/recommendation-decisions";
import { resolveReviewEvidence } from "@/services/review-evidence";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import { upgradeSnapshotPayload, validateSnapshotPayload } from "@/services/snapshot-restore";
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

  async function createImportRequest(): Promise<ExternalAnalysisImportRequest> {
    packageNo += 1;
    const packageId = `55555555-5555-4555-8555-${String(packageNo).padStart(12, "0")}`;
    const responseId = `66666666-6666-4666-8666-${String(packageNo).padStart(12, "0")}`;
    const created = await createAnalysisPackage(
      db,
      ownerId,
      { questionId: "program_progress", windowDays: 84 },
      {
        now: new Date(`2026-08-08T1${packageNo}:00:00.000Z`),
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

  it("stale-fences evidence correction and Program drift while preserving the allowlisted receipt through snapshot validation", async () => {
    const request = await createImportRequest();
    const imported = await importExternalAnalysisSelection(db, ownerId, request);
    if (!imported.ok) throw new Error(imported.message);
    const recommendation = (await db.select().from(recommendations))[0]!;

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

    await db
      .update(workoutSessions)
      .set({ historyRevision: 1 })
      .where(eq(workoutSessions.id, completedSessionId));
    await expect(resolveReviewEvidence(db, ownerId, recommendation)).resolves.toMatchObject({
      state: "stale",
      actionable: false,
    });
    await db
      .update(workoutSessions)
      .set({ historyRevision: 0 })
      .where(eq(workoutSessions.id, completedSessionId));
    await expect(resolveReviewEvidence(db, ownerId, recommendation)).resolves.toMatchObject({
      state: "external",
      actionable: true,
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
