import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  analysisPackageManifests,
  completedSets,
  exercisePrescriptions,
  exercises,
  healthActivities,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplates,
  workoutTemplateExercises,
} from "@/db/schema";
import { activateProgramAtomically } from "@/services/program-activation";
import { getOrCreateProgramDraft, reviewProgramDraft, saveProgramDraft } from "@/services/program-drafts";
import { publishProgramDraft } from "@/services/program-publication";
import { addProgramExerciseToDay } from "@/lib/program-editor-client";
import {
  analysisSourceRowContentHash,
  createAnalysisPackage,
  deleteAnalysisPackageManifest,
  finalizeAnalysisPackage,
  listAnalysisPackageManifests,
  verifyAnalysisPackage,
} from "@/services/analysis-package";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import { analysisPackageCoreSchema } from "@/lib/analysis-package";
import { runPrivacyRetention } from "@/services/privacy-retention";
import { getExternalAnalysisSourceBindingFreshness } from "@/services/external-analysis-validation";

describe("versioned external-analysis package", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let userId: string;
  let setId: string;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });

    const [owner] = await db
      .insert(users)
      .values({
        email: `analysis-private-${crypto.randomUUID()}@example.com`,
        name: "Private owner identity",
      })
      .returning({ id: users.id });
    userId = owner.id;
    await db.insert(userProfiles).values({
      userId,
      goals: ["strength", "consistency"],
      unit: "kg",
      timezone: "America/Toronto",
    });

    const [exercise] = await db
      .insert(exercises)
      .values({
        userId,
        name: `Analysis squat ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
      })
      .returning({ id: exercises.id });

    const activation = await activateProgramAtomically(db, {
      userId,
      loadUnit: "kg",
      programName: "Analysis Program",
      days: [
        {
          name: "Day A",
          exercises: [
            {
              exerciseId: exercise.id,
              sets: 3,
              repMin: 5,
              repMax: 8,
              targetLoad: 80,
              restSec: 120,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Synthetic analysis package fixture",
      auditAction: "program.activate",
      auditSummary: "Synthetic analysis package fixture",
      structuredIntentReviewed: true,
    });
    if (!activation.ok) throw new Error(activation.reason);
    const day = await db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, activation.programVersionId),
    });
    if (!day) throw new Error("Synthetic Program day missing.");

    const [session] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Day A",
        status: "completed",
        source: "tracker",
        startedAt: new Date("2026-08-01T14:00:00.000Z"),
        finishedAt: new Date("2026-08-01T15:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-08-01",
        sourceProgramId: activation.programId,
        sourceProgramVersionId: activation.programVersionId,
        sourceDayLineageId: day.lineageId,
      })
      .returning({ id: workoutSessions.id });
    const [sessionExercise] = await db
      .insert(sessionExercises)
      .values({
        sessionId: session.id,
        exerciseId: exercise.id,
        orderIdx: 0,
        prescribedSemanticsVersion: 1,
        prescribedExerciseName: "Analysis squat",
        prescribedMetricType: "weight_reps",
        prescribedLoadType: "barbell",
        prescribedLoadSemantics: "total",
        targetSets: 1,
        targetRepsMin: 5,
        targetRepsMax: 8,
        targetLoad: 80,
        targetLoadUnit: "kg",
      })
      .returning({ id: sessionExercises.id });
    const [set] = await db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        weight: 80,
        weightUnit: "kg",
        reps: 7,
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
        observedCompletedAt: new Date("2026-08-01T14:15:00.000Z"),
        observedCompletionProvenance: "live_client",
        observedCompletionQuality: "trustworthy",
      })
      .returning({ id: completedSets.id });
    setId = set.id;
    await db.insert(sessionOccurrences).values({
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exercise.id,
      plannedRepsMin: 5,
      plannedRepsMax: 8,
      plannedLoad: 80,
      plannedLoadUnit: "kg",
      outcome: "completed",
      resolvedAt: new Date("2026-08-01T14:15:00.000Z"),
      completedSetId: set.id,
    });
    await db.insert(healthActivities).values({
      userId,
      activityType: "walk",
      title: "Recovery walk",
      startedAt: new Date("2026-08-02T13:00:00.000Z"),
      timezone: "America/Toronto",
      durationSeconds: 1800,
      source: "manual",
      fingerprint: crypto.randomUUID(),
    });
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  it("keeps analysis-package/1 source hashes stable across additive reporting columns", () => {
    const legacyWorkout = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      history_revision: 0,
    };
    const postMigrationWorkout = {
      ...legacyWorkout,
      planned_duration_semantics_version: null,
      planned_duration_min_minutes: null,
      planned_duration_max_minutes: null,
      planned_duration_source: null,
      completion_semantics_version: null,
      completion_state: null,
      completion_reason: null,
    };
    expect(
      analysisSourceRowContentHash("workout_sessions", postMigrationWorkout),
    ).toBe(analysisSourceRowContentHash("workout_sessions", legacyWorkout));

    const legacyOccurrence = {
      id: "22222222-2222-4222-8222-222222222222",
      outcome: "abandoned",
      outcome_reason: "finished_early",
      revision: 0,
    };
    expect(
      analysisSourceRowContentHash("session_occurrences", {
        ...legacyOccurrence,
        resolution_semantics_version: null,
        resolution_reason_code: null,
      }),
    ).toBe(
      analysisSourceRowContentHash("session_occurrences", legacyOccurrence),
    );

    const legacySessionExercise = {
      id: "33333333-3333-4333-8333-333333333333",
      target_sets: 4,
      prescribed_semantics_version: 1,
    };
    expect(
      analysisSourceRowContentHash("session_exercises", {
        ...legacySessionExercise,
        prescribed_counting_semantics_version: null,
        prescribed_counting_basis: null,
      }),
    ).toBe(
      analysisSourceRowContentHash("session_exercises", legacySessionExercise),
    );

    expect(
      analysisSourceRowContentHash("workout_sessions", {
        ...postMigrationWorkout,
        history_revision: 1,
      }),
    ).not.toBe(
      analysisSourceRowContentHash("workout_sessions", legacyWorkout),
    );
  });

  it("preserves legacy null timed-target hashes while binding populated targets", () => {
    const legacy = { id: "33333333-3333-4333-8333-333333333333" };
    const timed = { version: 1, metricType: "weight_duration_per_side", minSeconds: 20, maxSeconds: 30 };
    for (const entity of ["session_exercises", "exercise_prescriptions"] as const) {
      const legacyHash = analysisSourceRowContentHash(entity, legacy);
      expect(analysisSourceRowContentHash(entity, { ...legacy, timed_prescription: null })).toBe(legacyHash);
      const timedHash = analysisSourceRowContentHash(entity, { ...legacy, timed_prescription: timed });
      expect(timedHash).not.toBe(legacyHash);
      expect(analysisSourceRowContentHash(entity, { ...legacy, timed_prescription: { ...timed, maxSeconds: 45 } })).not.toBe(timedHash);
    }
  });

  it("exports current and frozen timed targets separately from recorded seconds", async () => {
    const session = await db.query.workoutSessions.findFirst({ where: eq(workoutSessions.userId, userId) });
    if (!session) throw new Error("Synthetic workout missing.");
    const [carry] = await db.insert(exercises).values({
      userId, name: "Synthetic kettlebell carry", movementPattern: "carry", primaryMuscles: ["core"],
      loadType: "kettlebell", metricType: "distance_duration", loadSemantics: "per_implement", isUnilateral: true,
    }).returning();
    const currentTarget = { version: 1, metricType: "weight_duration_per_side", minSeconds: 30, maxSeconds: 45 } as const;
    const frozenTarget = { ...currentTarget, minSeconds: 20, maxSeconds: 30 };
    const state = await getOrCreateProgramDraft(db, userId);
    if (!state) throw new Error("Synthetic Program draft missing.");
    const lineageId = crypto.randomUUID();
    const document = addProgramExerciseToDay(state.draft.document, 0, carry.id, lineageId);
    Object.assign(document.days[0].exercises.at(-1)!, {
      repMin: null, repMax: null, timedPrescription: currentTarget,
      targetLoad: 20, targetLoadUnit: "kg", progressionRuleId: "manual",
    });
    const saved = await saveProgramDraft(db, userId, { draftId: state.draft.id, expectedRevision: state.draft.revision, mutationId: crypto.randomUUID(), document });
    if (saved.status !== "saved") throw new Error("Synthetic timed draft did not save.");
    const review = await reviewProgramDraft(db, userId, state.draft.id, saved.revision);
    if (review?.status !== "publishable") throw new Error("Synthetic timed draft is not publishable.");
    expect(await publishProgramDraft(db, userId, { draftId: state.draft.id, expectedRevision: saved.revision, reviewHash: review.hash! })).toMatchObject({ ok: true });
    const slot = await db.query.workoutTemplateExercises.findFirst({ where: eq(workoutTemplateExercises.lineageId, lineageId) });
    if (!slot) throw new Error("Synthetic timed slot missing.");
    const prescription = await db.query.exercisePrescriptions.findFirst({ where: eq(exercisePrescriptions.templateExerciseId, slot.id) });
    if (!prescription) throw new Error("Synthetic timed prescription missing.");
    const [frozen] = await db.insert(sessionExercises).values({
      sessionId: session.id, exerciseId: carry.id, orderIdx: 1,
      prescribedSemanticsVersion: 1, prescribedExerciseName: carry.name,
      prescribedMetricType: "weight_duration_per_side", prescribedLoadType: "kettlebell", prescribedLoadSemantics: "per_implement",
      targetSets: 1, targetRepsMin: null, targetRepsMax: null, timedPrescription: frozenTarget,
      targetLoad: 16, targetLoadUnit: "kg",
    }).returning();
    const [performed] = await db.insert(completedSets).values({
      sessionExerciseId: frozen.id, setNo: 1, weight: 16, weightUnit: "kg", reps: null,
      metricType: "weight_duration_per_side", durationSeconds: 25,
      performedSemanticsVersion: 1, performedLoadType: "kettlebell", performedLoadSemantics: "per_implement",
    }).returning();

    const created = await createAnalysisPackage(db, userId,
      { questionId: "program_progress", windowDays: 84 },
      { now: new Date("2026-08-08T16:00:00.000Z"), appVersion: "timed-analysis-test" },
    );
    const exported = verifyAnalysisPackage(JSON.parse(created.serialized));
    expect(exported.currentProgramIntent.prescriptions.find((fact) => fact.id === prescription.id)?.values).toMatchObject({
      timed_prescription: currentTarget, rep_range_min: null, rep_range_max: null, target_load: 20, target_load_unit: "kg",
    });
    expect(exported.completedOrImportedEvidence.exercises.find((fact) => fact.id === frozen.id)?.values).toMatchObject({
      timed_prescription: frozenTarget, prescribed_metric_type: "weight_duration_per_side",
      target_reps_min: null, target_reps_max: null, target_load: 16, target_load_unit: "kg",
    });
    expect(exported.completedOrImportedEvidence.sets.find((fact) => fact.id === performed.id)?.values).toMatchObject({
      metric_type: "weight_duration_per_side", duration_seconds: 25, reps: null, weight: 16, weight_unit: "kg",
    });
    const repEvidence = exported.completedOrImportedEvidence.exercises.find((fact) => fact.id !== frozen.id)?.values;
    expect(repEvidence).toMatchObject({ prescribed_metric_type: "weight_reps", target_reps_min: 5, target_reps_max: 8 });
    expect(repEvidence).not.toHaveProperty("timed_prescription");
    const repPrescription = exported.currentProgramIntent.prescriptions.find((fact) => fact.id !== prescription.id)?.values;
    expect(repPrescription).toMatchObject({ rep_range_min: 5, rep_range_max: 8, target_load: 80 });
    expect(repPrescription).not.toHaveProperty("timed_prescription");
    const [manifest] = await db.select().from(analysisPackageManifests);
    const retainedScope = manifest.scope as { sourceEvidenceRevision: string };
    await expect(getExternalAnalysisSourceBindingFreshness(db, userId, manifest.sourceBindings, retainedScope.sourceEvidenceRevision)).resolves.toEqual({ ok: true });
  }, 30_000);

  it("creates one deterministic, purpose-bounded package and retains only its manifest", async () => {
    const now = new Date("2026-08-08T16:00:00.000Z");
    const packageId = "11111111-1111-4111-8111-111111111111";
    const created = await createAnalysisPackage(
      db,
      userId,
      { questionId: "program_progress", windowDays: 84 },
      { now, packageId, appVersion: "a01-test" },
    );

    expect(verifyAnalysisPackage(created.package)).toEqual(created.package);
    expect(created.package).toMatchObject({
      schemaVersion: "analysis-package/1",
      semanticVersion: "repbook-v2/1",
      packageId,
      request: { questionId: "program_progress", windowDays: 84 },
      currentProgramIntent: {
        program: { values: { name: "Analysis Program" } },
      },
      inventory: {
        included: {
          workouts: 1,
          completedSets: 1,
          independentActivities: 0,
          calculatedMetrics: 1,
        },
      },
    });
    expect(created.package.completedOrImportedEvidence.sets[0]).toMatchObject({
      id: setId,
      factClass: "recorded",
      evidenceQuality: "retained_trustworthy_completion",
      values: {
        weight: 80,
        weight_unit: "kg",
        reps: 7,
        performed_load_semantics: "total",
      },
    });
    expect(created.package.independentActivityContext).toEqual([]);
    expect(created.package.calculatedMetrics[0]).toMatchObject({
      id: setId,
      factClass: "unknown",
      evidenceQuality: "calculation_unknown",
      values: { target_met: null },
    });
    expect(created.package.inventory.omitted).toContainEqual(
      expect.objectContaining({ category: "independent_activity_context" }),
    );
    expect(created.serialized).not.toContain("analysis-private-");
    expect(created.serialized).not.toContain("Private owner identity");
    expect(created.serialized).toContain("raw_package_retention");
    expect(created.serialized).not.toContain("contentHashes");
    expect(created.serialized).not.toContain("versionTokens");

    const core = analysisPackageCoreSchema.strip().parse(created.package);
    expect(finalizeAnalysisPackage(core)).toEqual(created);

    const manifests = await db.select().from(analysisPackageManifests);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      id: packageId,
      userId,
      schemaVersion: "analysis-package/1",
      semanticVersion: "repbook-v2/1",
      digest: created.package.integrity.digest,
      inventory: expect.objectContaining({
        included: expect.objectContaining({ completedSets: 1 }),
        omitted: expect.arrayContaining([
          expect.objectContaining({ category: "account_identity" }),
        ]),
      }),
      sourceBindings: expect.arrayContaining([
        expect.objectContaining({ entity: "completed_sets", ids: [setId] }),
      ]),
    });
    expect(manifests[0]!.expiresAt.toISOString()).toBe(
      "2026-09-07T16:00:00.000Z",
    );
    expect(manifests[0]!.sourceBindings.every((binding) =>
      binding.contentHashes.length === binding.ids.length &&
      binding.versionTokens?.length === binding.ids.length,
    )).toBe(true);
    const retainedScope = manifests[0]!.scope as { sourceEvidenceRevision: string };
    await expect(
      getExternalAnalysisSourceBindingFreshness(
        db,
        userId,
        manifests[0]!.sourceBindings,
        retainedScope.sourceEvidenceRevision,
      ),
    ).resolves.toEqual({ ok: true });
    expect(JSON.stringify(manifests[0])).not.toContain("Recovery walk");
    expect(JSON.stringify(manifests[0])).not.toContain("Analysis Program");

    const snapshot = await captureUserSnapshot(db, userId, now, "a01-test");
    expect(snapshot.tables).not.toHaveProperty("analysis_package_manifests");

    await expect(
      runPrivacyRetention(db, new Date("2026-09-07T16:00:00.000Z")),
    ).resolves.toMatchObject({ expiredAnalysisPackageManifests: 1 });
    await expect(db.select().from(analysisPackageManifests)).resolves.toEqual([]);
  }, 30_000);

  it("omits detailed training and coaching domains from a consistency package", async () => {
    const now = new Date("2026-08-08T16:00:00.000Z");
    const created = await createAnalysisPackage(
      db,
      userId,
      { questionId: "training_consistency", windowDays: 28 },
      {
        now,
        packageId: "33333333-3333-4333-8333-333333333333",
        appVersion: "a01-test",
      },
    );

    expect(created.package.inventory.included).toMatchObject({
      workouts: 1,
      workoutExercises: 0,
      occurrences: 0,
      completedSets: 0,
      independentActivities: 1,
      calculatedMetrics: 0,
      recommendationProposals: 0,
      ownerDecisions: 0,
      acceptedAdaptations: 0,
    });
    expect(created.package.currentProgramIntent.days).toHaveLength(1);
    expect(created.package.currentProgramIntent.slots).toEqual([]);
    expect(created.package.currentProgramIntent.prescriptions).toEqual([]);
    expect(created.package.completedOrImportedEvidence.sets).toEqual([]);
    expect(created.package.independentActivityContext[0]).toMatchObject({
      evidenceQuality: "context_only_excluded_from_strength",
    });
    expect(created.package.inventory.omitted.map((item) => item.category)).toEqual(
      expect.arrayContaining([
        "owner_constraints",
        "equipment_context",
        "program_exercise_details",
        "detailed_workout_evidence",
        "recovery_health_context",
        "recommendation_decision_state",
      ]),
    );
  }, 30_000);

  it("enforces owner scope for listing and deletion and makes deletion final", async () => {
    const now = new Date("2026-08-08T16:00:00.000Z");
    const packageId = "22222222-2222-4222-8222-222222222222";
    await createAnalysisPackage(
      db,
      userId,
      { questionId: "training_consistency", windowDays: 28 },
      { now, packageId, appVersion: "a01-test" },
    );
    const [other] = await db
      .insert(users)
      .values({ email: `other-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });

    await expect(listAnalysisPackageManifests(db, other.id, now)).resolves.toEqual([]);
    await expect(
      deleteAnalysisPackageManifest(db, other.id, packageId),
    ).resolves.toBe(false);
    await expect(
      deleteAnalysisPackageManifest(db, userId, packageId),
    ).resolves.toBe(true);
    await expect(
      deleteAnalysisPackageManifest(db, userId, packageId),
    ).resolves.toBe(false);
    await expect(listAnalysisPackageManifests(db, userId, now)).resolves.toEqual([]);
  }, 30_000);
});
