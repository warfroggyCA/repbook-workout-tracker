import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  adaptationEvents,
  analysisPackageManifests,
  coachingInsights,
  completedSets,
  exercisePrescriptions,
  exercises,
  fatigueLogs,
  healthActivities,
  painLogs,
  programDrafts,
  programs,
  programVersions,
  recommendations,
  sessionExerciseGroups,
  sessionExercises,
  sessionOccurrences,
  supersetGroups,
  userDecisions,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import { buildExternalAnalysisInstructions } from "@/lib/external-analysis-instructions";
import {
  externalAnalysisResponseSchema,
  parseExternalAnalysisRawInput,
  validateExternalAnalysisResponse,
} from "@/lib/external-analysis-response";
import { activateProgramAtomically } from "@/services/program-activation";
import { createAnalysisPackage } from "@/services/analysis-package";
import { importExternalAnalysisSelection } from "@/services/external-analysis-import";
import { getExternalAnalysisResponseBinding } from "@/services/external-analysis-validation";
import { approveRecommendationDecision } from "@/services/recommendation-decisions";
import { resolveReviewEvidence } from "@/services/review-evidence";
import adversarialCorpus from "../fixtures/v2/a06-adversarial-corpus.json";
import workflowFixture from "../fixtures/v2/gauntlet-c-external-workflows.json";

const uuidState = vi.hoisted(() => ({ counter: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () =>
      `90000000-0000-4000-8000-${String(++uuidState.counter).padStart(12, "0")}`,
  };
});

const IDS = {
  owner: "00000000-0000-4000-8000-000000000901",
  exercise: "00000000-0000-4000-8000-000000000902",
  completedSession: "00000000-0000-4000-8000-000000000903",
  sessionExercise: "00000000-0000-4000-8000-000000000904",
  supportedSet: "00000000-0000-4000-8000-000000000905",
  unknownSet: "00000000-0000-4000-8000-000000000906",
  supportedOccurrence: "00000000-0000-4000-8000-000000000907",
  unknownOccurrence: "00000000-0000-4000-8000-000000000908",
  activeSession: "00000000-0000-4000-8000-000000000909",
  consistencySessionOne: "00000000-0000-4000-8000-000000000910",
  consistencySessionTwo: "00000000-0000-4000-8000-000000000911",
  independentActivity: "00000000-0000-4000-8000-000000000912",
  packages: [
    "00000000-0000-4000-8000-000000000921",
    "00000000-0000-4000-8000-000000000922",
  ],
} as const;

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Workflow = (typeof workflowFixture.workflows)[number];

async function protectedState(db: Db) {
  const [
    programRows,
    versionRows,
    draftRows,
    templateRows,
    templateExerciseRows,
    prescriptionRows,
    supersetRows,
    sessionRows,
    groupRows,
    exerciseRows,
    setRows,
    occurrenceRows,
    painRows,
    fatigueRows,
    activityRows,
  ] = await Promise.all([
    db.select().from(programs),
    db.select().from(programVersions),
    db.select().from(programDrafts),
    db.select().from(workoutTemplates),
    db.select().from(workoutTemplateExercises),
    db.select().from(exercisePrescriptions),
    db.select().from(supersetGroups),
    db.select().from(workoutSessions),
    db.select().from(sessionExerciseGroups),
    db.select().from(sessionExercises),
    db.select().from(completedSets),
    db.select().from(sessionOccurrences),
    db.select().from(painLogs),
    db.select().from(fatigueLogs),
    db.select().from(healthActivities),
  ]);
  return {
    programs: programRows.map((row) => ({
      id: row.id,
      userId: row.userId,
      name: row.name,
      status: row.status,
      currentVersionId: row.currentVersionId,
      archivedAt: row.archivedAt,
      archiveOperationId: row.archiveOperationId,
    })),
    recommendationRevisions: programRows.map((row) => ({
      id: row.id,
      recommendationRevision: row.recommendationRevision,
    })),
    versions: versionRows,
    drafts: draftRows,
    templates: templateRows,
    templateExercises: templateExerciseRows,
    prescriptions: prescriptionRows,
    supersetGroups: supersetRows,
    sessions: sessionRows,
    sessionGroups: groupRows,
    exercises: exerciseRows,
    sets: setRows,
    occurrences: occurrenceRows,
    pain: painRows,
    fatigue: fatigueRows,
    independentActivities: activityRows,
  };
}

async function importState(db: Db) {
  const [manifests, insights, proposalRows, decisions, adaptations] =
    await Promise.all([
      db.select().from(analysisPackageManifests),
      db.select().from(coachingInsights),
      db.select().from(recommendations),
      db.select().from(userDecisions),
      db.select().from(adaptationEvents),
    ]);
  return { manifests, insights, proposals: proposalRows, decisions, adaptations };
}

describe("Repbook v2 bounded Gauntlet C external round trip", () => {
  let client: PGlite;
  let db: Db;

  beforeEach(async () => {
    uuidState.counter = 0;
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    await db.insert(users).values({
      id: IDS.owner,
      email: "gauntlet-c-owner@example.com",
      name: "Synthetic Gauntlet C owner",
    });
    await db.insert(userProfiles).values({
      id: "00000000-0000-4000-8000-000000000913",
      userId: IDS.owner,
      goals: ["synthetic strength review"],
      unit: "lb",
      timezone: "America/Toronto",
    });
    await db.insert(exercises).values({
      id: IDS.exercise,
      userId: IDS.owner,
      name: "Gauntlet C synthetic press",
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "barbell",
      metricType: "weight_reps",
      loadSemantics: "total",
    });
    const activation = await activateProgramAtomically(db, {
      userId: IDS.owner,
      loadUnit: "lb",
      programName: "Gauntlet C synthetic Program",
      days: [
        {
          name: "Day A",
          exercises: [
            {
              exerciseId: IDS.exercise,
              sets: 2,
              repMin: 6,
              repMax: 10,
              targetLoad: 95,
              restSec: 120,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Synthetic Gauntlet C fixture",
      auditAction: "program.activate",
      auditSummary: "Synthetic Gauntlet C fixture",
      structuredIntentReviewed: true,
    });
    if (!activation.ok) throw new Error(activation.reason);
    const publishedAt = new Date("2026-08-01T12:00:00.000Z");
    await client.exec(
      "select set_config('workout_tracker.program_publish', 'authorized', false)",
    );
    try {
      await Promise.all([
        db
          .update(programs)
          .set({ createdAt: publishedAt })
          .where(eq(programs.id, activation.programId)),
        db
          .update(programVersions)
          .set({ activatedAt: publishedAt, createdAt: publishedAt })
          .where(eq(programVersions.id, activation.programVersionId)),
        db
          .update(exercisePrescriptions)
          .set({ effectiveFrom: publishedAt, createdAt: publishedAt }),
      ]);
    } finally {
      await client.exec(
        "select set_config('workout_tracker.program_publish', '', false)",
      );
    }
    const day = await db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, activation.programVersionId),
    });
    if (!day) throw new Error("Gauntlet C Program day missing.");

    await db.insert(workoutSessions).values([
      {
        id: IDS.completedSession,
        userId: IDS.owner,
        templateName: "Gauntlet C completed evidence",
        status: "completed",
        source: "tracker",
        startedAt: new Date("2026-08-01T14:00:00.000Z"),
        finishedAt: new Date("2026-08-01T14:40:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-08-01",
        sourceProgramId: activation.programId,
        sourceProgramVersionId: activation.programVersionId,
        sourceDayLineageId: day.lineageId,
      },
      {
        id: IDS.activeSession,
        userId: IDS.owner,
        templateName: "Gauntlet C active work remains untouched",
        status: "in_progress",
        source: "tracker",
        startedAt: new Date("2026-08-08T15:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-08-08",
      },
      {
        id: IDS.consistencySessionOne,
        userId: IDS.owner,
        templateName: "Gauntlet C consistency evidence one",
        status: "completed",
        source: "tracker",
        startedAt: new Date("2026-08-03T14:00:00.000Z"),
        finishedAt: new Date("2026-08-03T14:35:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-08-03",
        sourceProgramId: activation.programId,
        sourceProgramVersionId: activation.programVersionId,
        sourceDayLineageId: day.lineageId,
      },
      {
        id: IDS.consistencySessionTwo,
        userId: IDS.owner,
        templateName: "Gauntlet C consistency evidence two",
        status: "completed",
        source: "tracker",
        startedAt: new Date("2026-08-06T14:00:00.000Z"),
        finishedAt: new Date("2026-08-06T14:45:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-08-06",
        sourceProgramId: activation.programId,
        sourceProgramVersionId: activation.programVersionId,
        sourceDayLineageId: day.lineageId,
      },
    ]);
    await db.insert(healthActivities).values({
      id: IDS.independentActivity,
      userId: IDS.owner,
      activityType: "walk",
      title: "Gauntlet C synthetic recovery walk",
      startedAt: new Date("2026-08-05T13:00:00.000Z"),
      timezone: "America/Toronto",
      durationSeconds: 2_400,
      source: "manual",
      fingerprint: "gauntlet-c-synthetic-recovery-walk",
    });
    await db.insert(sessionExercises).values({
      id: IDS.sessionExercise,
      sessionId: IDS.completedSession,
      exerciseId: IDS.exercise,
      orderIdx: 0,
      prescribedSemanticsVersion: 1,
      prescribedExerciseName: "Gauntlet C synthetic press",
      prescribedMetricType: "weight_reps",
      prescribedLoadType: "barbell",
      prescribedLoadSemantics: "total",
      targetSets: 2,
      targetRepsMin: 6,
      targetRepsMax: 10,
      targetLoad: 95,
      targetLoadUnit: "lb",
    });
    await db.insert(completedSets).values([
      {
        id: IDS.supportedSet,
        sessionExerciseId: IDS.sessionExercise,
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
        observedCompletedAt: new Date("2026-08-01T14:15:00.000Z"),
        observedCompletionProvenance: "live_client",
        observedCompletionQuality: "trustworthy",
        loggedAt: new Date("2026-08-01T14:15:00.000Z"),
      },
      {
        id: IDS.unknownSet,
        sessionExerciseId: IDS.sessionExercise,
        setNo: 2,
        weight: 105,
        weightUnit: "lb",
        reps: 6,
        loggedAt: new Date("2026-08-01T14:20:00.000Z"),
      },
    ]);
    await db.insert(sessionOccurrences).values([
      {
        id: IDS.supportedOccurrence,
        sessionId: IDS.completedSession,
        sessionExerciseId: IDS.sessionExercise,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: IDS.exercise,
        plannedRepsMin: 6,
        plannedRepsMax: 10,
        plannedLoad: 95,
        plannedLoadUnit: "lb",
        outcome: "completed",
        resolvedAt: new Date("2026-08-01T14:15:00.000Z"),
        completedSetId: IDS.supportedSet,
      },
      {
        id: IDS.unknownOccurrence,
        sessionId: IDS.completedSession,
        sessionExerciseId: IDS.sessionExercise,
        kind: "working_set",
        origin: "planned",
        sequenceIdx: 1,
        kindOrdinal: 1,
        plannedExerciseId: IDS.exercise,
        plannedRepsMin: 6,
        plannedRepsMax: 10,
        plannedLoad: 95,
        plannedLoadUnit: "lb",
        outcome: "completed",
        resolvedAt: new Date("2026-08-01T14:20:00.000Z"),
        completedSetId: IDS.unknownSet,
      },
    ]);
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  async function createBoundResponse(workflow: Workflow, index: number) {
    const now = new Date(`2026-08-08T16:0${index}:00.000Z`);
    const request = index === 1
      ? { questionId: "training_consistency" as const, windowDays: 28 as const }
      : { questionId: "program_progress" as const, windowDays: 84 as const };
    const created = await createAnalysisPackage(
      db,
      IDS.owner,
      request,
      {
        now,
        packageId: IDS.packages[index],
        appVersion: "gauntlet-c-test",
      },
    );
    const instructions = buildExternalAnalysisInstructions(created.package);
    const response = externalAnalysisResponseSchema.parse(
      structuredClone(workflow.response),
    );
    expect(response.analysisPackage).toEqual({
      packageId: created.package.packageId,
      packageNamespace: created.package.packageNamespace,
      schemaVersion: created.package.schemaVersion,
      semanticVersion: created.package.semanticVersion,
      digest: created.package.integrity.digest,
      evidenceCutoff: created.package.evidenceCutoff,
      expiresAt: created.package.expiresAt,
    });
    expect(response.question).toEqual({
      id: created.package.request.questionId,
      text: created.package.request.question,
    });
    const raw =
      workflow.workflow === "chat-paste"
        ? JSON.stringify(response)
        : `${JSON.stringify(response, null, 2)}\n`;
    const parsed = parseExternalAnalysisRawInput(
      new TextEncoder().encode(raw),
      workflow.workflow === "chat-paste"
        ? "application/vnd.repbook.analysis-response+json; charset=utf-8"
        : "application/json",
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const manifest = await getExternalAnalysisResponseBinding(
      db,
      IDS.owner,
      created.package.packageId,
      now,
    );
    if (!manifest.ok) throw new Error(manifest.reason);
    return { created, instructions, response, parsed, manifest };
  }

  it("validates, exactly previews, imports, and explicitly accepts useful proposals from two independent workflows without hidden mutation", async () => {
    expect(workflowFixture).toMatchObject({
      format: "repbook-gauntlet-c-external-workflows",
      schemaVersion: "gauntlet-c-workflows/1",
      syntheticOnly: true,
    });
    expect(workflowFixture.workflows.map((item) => item.workflow)).toEqual([
      "chat-paste",
      "file-upload",
    ]);
    expect(new Set(workflowFixture.workflows.map((item) => item.response.responseId)).size).toBe(2);
    expect(new Set(adversarialCorpus.items.map((item) => item.category)).size).toBe(16);

    const before = await protectedState(db);
    const proposalShapes: Array<{
      questionId: string;
      targetKind: string;
      requestedOutcome: string;
    }> = [];
    for (const [index, workflow] of workflowFixture.workflows.entries()) {
      const bound = await createBoundResponse(workflow, index);
      expect(bound.instructions).toContain(bound.created.package.packageId);
      expect(bound.instructions).toContain(bound.created.package.integrity.digest);
      expect(bound.instructions).toContain("explicitly select each item to import into Review");
      expect(bound.instructions).not.toContain(
        "does not yet expose the later paste/upload import flow",
      );

      const validation = validateExternalAnalysisResponse(
        bound.parsed.value,
        bound.manifest.binding,
      );
      if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
      expect(validation.response).toEqual(bound.response);
      const exactPreview = JSON.stringify(validation.response, null, 2);
      expect(exactPreview).toContain(workflow.response.observations[0]!.evidenceQuality);
      const measurement = workflow.response.observations
        .flatMap((observation) => observation.measurements)[0];
      expect(measurement).toBeDefined();
      expect(exactPreview).toContain(measurement!.meaning);
      expect(exactPreview).toContain(
        workflow.response.proposedActions[0]!.effect.requestedOutcome,
      );

      const proposal = validation.response.proposedActions[0]!;
      expect(proposal.summary.length).toBeGreaterThan(50);
      expect(proposal.rationale.length).toBeGreaterThan(50);
      if (workflow.workflow === "chat-paste") {
        expect(proposal.evidenceIds).toEqual(
          expect.arrayContaining([
            "00000000-0000-4000-8000-000000000913",
            IDS.supportedSet,
            IDS.unknownSet,
            "90000000-0000-4000-8000-000000000007",
          ]),
        );
        expect(proposal.effect.target.kind).toBe("program");
        expect(proposal.effect.requestedOutcome).toMatch(
          /95 lb.*supported working set|supported working set.*95 lb/i,
        );
      } else {
        expect(proposal.evidenceIds).toEqual(
          expect.arrayContaining([
            "00000000-0000-4000-8000-000000000913",
            IDS.completedSession,
            IDS.consistencySessionOne,
            IDS.consistencySessionTwo,
          ]),
        );
        expect(proposal.evidenceIds).not.toContain(IDS.independentActivity);
        expect(proposal.effect.target.kind).toBe("schedule");
        expect(proposal.effect.requestedOutcome).toMatch(
          /explicit local dates.*two-to-three-day spacing/i,
        );
      }
      expect(proposal.limitations.join(" ")).toMatch(/not an accepted|not.*Program change/i);
      proposalShapes.push({
        questionId: validation.response.question.id,
        targetKind: proposal.effect.target.kind,
        requestedOutcome: proposal.effect.requestedOutcome,
      });

      const imported = await importExternalAnalysisSelection(
        db,
        IDS.owner,
        {
          response: validation.response,
          selections: {
            observationIds: [validation.response.observations[0]!.id],
            proposalIds: [proposal.id],
          },
        },
        { now: new Date(`2026-08-08T17:0${index}:00.000Z`) },
      );
      if (!imported.ok) throw new Error(imported.message);
      expect(imported).toMatchObject({
        replay: "new",
        observationCount: 1,
        proposalCount: 1,
      });
      const recommendation = await db.query.recommendations.findFirst({
        where: eq(recommendations.insightId, imported.importId),
      });
      if (!recommendation) throw new Error("Imported Review proposal missing.");
      await expect(
        resolveReviewEvidence(db, IDS.owner, recommendation),
      ).resolves.toMatchObject({ state: "external", actionable: true });
      await expect(
        approveRecommendationDecision(db, IDS.owner, {
          recommendationId: recommendation.id,
          expectedReviewRevision: 1,
          expectedDeferRevision: 0,
        }),
      ).resolves.toEqual({ ok: true });
    }

    expect(proposalShapes).toEqual([
      {
        questionId: "program_progress",
        targetKind: "program",
        requestedOutcome:
          workflowFixture.workflows[0]!.response.proposedActions[0]!.effect
            .requestedOutcome,
      },
      {
        questionId: "training_consistency",
        targetKind: "schedule",
        requestedOutcome:
          workflowFixture.workflows[1]!.response.proposedActions[0]!.effect
            .requestedOutcome,
      },
    ]);
    expect(proposalShapes[0]!.requestedOutcome).not.toBe(
      proposalShapes[1]!.requestedOutcome,
    );

    const after = await protectedState(db);
    expect(after).toEqual({
      ...before,
      recommendationRevisions: before.recommendationRevisions.map((row) => ({
        ...row,
        recommendationRevision: row.recommendationRevision + 4,
      })),
    });
    expect(await db.select().from(analysisPackageManifests)).toHaveLength(0);
    expect(await db.select().from(coachingInsights)).toHaveLength(2);
    expect(await db.select().from(recommendations)).toHaveLength(2);
    expect((await db.select().from(recommendations)).every((row) => row.status === "approved")).toBe(true);
    expect(await db.select().from(userDecisions)).toHaveLength(2);
    const adaptations = await db.select().from(adaptationEvents);
    expect(adaptations).toHaveLength(2);
    expect(adaptations.every((row) => {
      const snapshot = row.afterSnapshot as { programChanged?: unknown };
      return snapshot.programChanged === false;
    })).toBe(true);
    const retainedImports = JSON.stringify(await db.select().from(coachingInsights));
    for (const workflow of workflowFixture.workflows) {
      expect(retainedImports).not.toContain(workflow.response.unknowns[0]!.detail);
    }
  }, 45_000);

  it("rejects an A06 unknown effect before import and preserves a recoverable manifest and all protected or Review state", async () => {
    const bound = await createBoundResponse(workflowFixture.workflows[0]!, 0);
    const attacked = structuredClone(bound.parsed.value) as {
      proposedActions: Array<{ effect: { type: string } }>;
    };
    attacked.proposedActions[0]!.effect.type =
      "rewrite_unpreviewed_program_area";
    const beforeProtected = await protectedState(db);
    const beforeImport = await importState(db);
    const rejected = validateExternalAnalysisResponse(
      attacked,
      bound.manifest.binding,
    );
    expect(rejected).toMatchObject({
      ok: false,
      issues: [{ code: "unknown_effect" }],
    });
    expect(adversarialCorpus.items).toContainEqual(
      expect.objectContaining({
        category: "unknown_effect",
        oracle: "reject",
        expectedCode: "unknown_effect",
      }),
    );
    expect(await protectedState(db)).toEqual(beforeProtected);
    expect(await importState(db)).toEqual(beforeImport);
    expect((await db.select().from(analysisPackageManifests)).map((row) => row.id)).toEqual([
      bound.created.package.packageId,
    ]);

    const recovered = validateExternalAnalysisResponse(
      bound.response,
      bound.manifest.binding,
    );
    expect(recovered).toMatchObject({ ok: true });
    expect(await protectedState(db)).toEqual(beforeProtected);
    expect(await importState(db)).toEqual(beforeImport);
  }, 30_000);
});
