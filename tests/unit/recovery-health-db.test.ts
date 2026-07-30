import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import {
  adaptationEvents,
  aiParsingEvents,
  completedSets,
  dataSnapshots,
  exercises,
  historyImportBatches,
  importEvents,
  integrityFindings,
  progressionJobInputSessions,
  progressionJobs,
  programDrafts,
  programVersions,
  programs,
  recordVersions,
  recommendations,
  recoveryRuns,
  sessionExercises,
  sessionOccurrenceMutations,
  sessionOccurrences,
  userDecisions,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import {
  createDataSnapshot,
  type SnapshotKeyring,
} from "@/services/snapshots";
import {
  evaluateApplicationIntegrity,
  getRecoveryHealth,
  runApplicationIntegrityCheck,
  runSnapshotIntegrityCheck,
} from "@/services/recovery-health";
import {
  hashProgramDocument,
} from "@/services/program-document-hash";
import {
  legacyProgramDocumentSchema,
  suggestProgramIntentDraft,
} from "@/lib/program-document";

describe("recovery health", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `recovery-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(userProfiles).values({ userId });
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  it("records a clean application integrity run and surfaces it as healthy", async () => {
    expect(await evaluateApplicationIntegrity(db, userId)).toEqual([]);

    const result = await runApplicationIntegrityCheck(db, userId);
    expect(result).toMatchObject({ status: "passed", findings: [] });

    const [stored] = await db.query.recoveryRuns.findMany();
    expect(stored).toMatchObject({
      userId,
      kind: "application_integrity",
      status: "passed",
    });
    expect(await db.query.integrityFindings.findMany()).toEqual([]);

    const health = await getRecoveryHealth(db, userId);
    expect(health.attentionCount).toBe(0);
    expect(health.latest.application_integrity?.id).toBe(stored.id);
  }, 30_000);

  it("validates a durable workout occurrence graph and detects an impossible receipt revision", async () => {
    const [exercise] = await db.insert(exercises).values({
      name: "Recovery squat",
      movementPattern: "squat",
      primaryMuscles: ["quadriceps"],
      loadType: "barbell",
      metricType: "weight_reps",
      loadSemantics: "total",
      variantAttributes: { assistance: "none" },
    }).returning({ id: exercises.id, name: exercises.name });
    const [session] = await db.insert(workoutSessions).values({
      userId,
      templateName: "Recovery workout",
      startedAt: new Date("2026-07-21T16:00:00.000Z"),
      timezone: "America/Toronto",
      localDate: "2026-07-21",
    }).returning({ id: workoutSessions.id });
    const [sessionExercise] = await db.insert(sessionExercises).values({
      sessionId: session.id,
      exerciseId: exercise.id,
      orderIdx: 0,
      targetSets: 1,
      targetRepsMin: 5,
      targetRepsMax: 5,
    }).returning({ id: sessionExercises.id });
    const [occurrence] = await db.insert(sessionOccurrences).values({
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exercise.id,
      plannedRepsMin: 5,
      plannedRepsMax: 5,
      outcome: "skipped",
      outcomeReason: "user_skipped",
      revision: 1,
      resolvedAt: new Date(),
    }).returning({ id: sessionOccurrences.id });
    await db.insert(sessionOccurrenceMutations).values({
      occurrenceId: occurrence.id,
      clientKey: crypto.randomUUID(),
      operation: "skip",
      canonicalPayloadHash: "a".repeat(64),
      expectedRevision: 0,
      resultingRevision: 1,
      resultCode: "applied",
    });

    expect(await evaluateApplicationIntegrity(db, userId)).toEqual([]);
    const [impossibleReceipt] = await db.insert(sessionOccurrenceMutations).values({
      occurrenceId: occurrence.id,
      clientKey: crypto.randomUUID(),
      operation: "note",
      canonicalPayloadHash: "b".repeat(64),
      expectedRevision: 1,
      resultingRevision: 2,
      resultCode: "applied",
    }).returning({ id: sessionOccurrenceMutations.id });
    expect(await evaluateApplicationIntegrity(db, userId)).toEqual([
      expect.objectContaining({
        checkKey: "session_occurrence.receipt",
        severity: "error",
        entityId: impossibleReceipt.id,
      }),
    ]);
  }, 30_000);

  it("retains a reviewable finding when an import summary disagrees with its rows", async () => {
    const [event] = await db
      .insert(importEvents)
      .values({
        userId,
        source: "csv",
        rawPayload: "test",
        status: "confirmed",
      })
      .returning({ id: importEvents.id });
    await db.insert(historyImportBatches).values({
      userId,
      importEventId: event.id,
      source: "hevy",
      originalFilename: "history.csv",
      fileHash: crypto.randomUUID().replaceAll("-", ""),
      timezone: "America/Toronto",
      summary: {
        workouts: 1,
        exerciseOccurrences: 1,
        sets: 1,
        warmupSets: 0,
        supersetGroups: 0,
        excludedExercises: 0,
        warnings: 0,
      },
    });

    const result = await runApplicationIntegrityCheck(db, userId);
    expect(result.status).toBe("warning");
    expect(result.findings).toEqual([
      expect.objectContaining({
        checkKey: "import_batch.summary",
        severity: "warning",
      }),
    ]);
    const [finding] = await db.select().from(integrityFindings);
    expect(finding).toMatchObject({
      userId,
      checkKey: "import_batch.summary",
      severity: "warning",
      resolvedAt: null,
    });
  }, 30_000);

  it("surfaces durable unit and workout-calendar repair findings", async () => {
    await client.query(
      "UPDATE user_profiles SET timezone = 'Mars/Olympus' WHERE user_id = $1",
      [userId]
    );

    const findings = await evaluateApplicationIntegrity(db, userId);
    expect(findings).toEqual([
      expect.objectContaining({
        checkKey: "durable_identity.profile_timezone_invalid",
        severity: "error",
        entityType: "user_profile",
        details: expect.objectContaining({ issue: "profile.timezone_invalid" }),
      }),
    ]);
  });

  it("surfaces a Program draft document assigned to the wrong Program", async () => {
    const programId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const document = suggestProgramIntentDraft(legacyProgramDocumentSchema.parse({
      schemaVersion: "1",
      programId: crypto.randomUUID(),
      baseVersionId: versionId,
      name: "Misassigned draft",
      days: [
        {
          lineageId: crypto.randomUUID(),
          name: "Day A",
          notes: null,
          supersets: [],
          exercises: [
            {
              lineageId: crypto.randomUUID(),
              exerciseId: crypto.randomUUID(),
              sets: 1,
              repMin: 5,
              repMax: 5,
              targetLoad: null,
              targetLoadUnit: null,
              progressionRuleId: "double_progression",
              restSec: 90,
              supersetKey: null,
              notes: null,
              warmupNotes: null,
              warmupSets: [],
              setNotes: [null],
            },
          ],
        },
      ],
    }));

    await db.transaction(async (tx) => {
      await tx.insert(programs).values({
        id: programId,
        userId,
        name: "Recovery Program",
        currentVersionId: versionId,
      });
      await tx.insert(programVersions).values({
        id: versionId,
        programId,
        versionNo: 1,
        name: "Recovery Program",
      });
      await tx.insert(programDrafts).values({
        userId,
        programId,
        baseVersionId: versionId,
        document,
        contentHash: hashProgramDocument(document),
        lastMutationId: crypto.randomUUID(),
      });
    });

    expect(await evaluateApplicationIntegrity(db, userId)).toEqual([
      expect.objectContaining({
        checkKey: "program_draft.document",
        severity: "error",
        entityType: "program_draft",
      }),
    ]);
  });

  it("surfaces a Program draft whose saved content identity was altered", async () => {
    const programId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const document = suggestProgramIntentDraft(legacyProgramDocumentSchema.parse({
      schemaVersion: "1",
      programId,
      baseVersionId: versionId,
      name: "Hash recovery",
      days: [
        {
          lineageId: crypto.randomUUID(),
          name: "Day A",
          notes: null,
          supersets: [],
          exercises: [
            {
              lineageId: crypto.randomUUID(),
              exerciseId: crypto.randomUUID(),
              sets: 1,
              repMin: 5,
              repMax: 5,
              targetLoad: null,
              targetLoadUnit: null,
              progressionRuleId: "double_progression",
              restSec: 90,
              supersetKey: null,
              notes: null,
              warmupNotes: null,
              warmupSets: [],
              setNotes: [null],
            },
          ],
        },
      ],
    }));

    await db.transaction(async (tx) => {
      await tx.insert(programs).values({
        id: programId,
        userId,
        name: document.name,
        currentVersionId: versionId,
      });
      await tx.insert(programVersions).values({
        id: versionId,
        programId,
        versionNo: 1,
        name: document.name,
      });
      await tx.insert(programDrafts).values({
        userId,
        programId,
        baseVersionId: versionId,
        document,
        contentHash: "altered",
        lastMutationId: crypto.randomUUID(),
      });
    });

    expect(await evaluateApplicationIntegrity(db, userId)).toEqual([
      expect.objectContaining({
        checkKey: "program_draft.content_hash",
        severity: "error",
        entityType: "program_draft",
      }),
    ]);
  });

  it("surfaces a malformed nested Program draft even when its top-level identity still matches", async () => {
    const programId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const document = suggestProgramIntentDraft(legacyProgramDocumentSchema.parse({
      schemaVersion: "1",
      programId,
      baseVersionId: versionId,
      name: "Nested recovery",
      days: [
        {
          lineageId: crypto.randomUUID(),
          name: "Day A",
          notes: null,
          supersets: [],
          exercises: [
            {
              lineageId: crypto.randomUUID(),
              exerciseId: crypto.randomUUID(),
              sets: 1,
              repMin: 5,
              repMax: 5,
              targetLoad: null,
              targetLoadUnit: null,
              progressionRuleId: "double_progression",
              restSec: 90,
              supersetKey: null,
              notes: null,
              warmupNotes: null,
              warmupSets: [],
              setNotes: [null],
            },
          ],
        },
      ],
    }));

    const [draft] = await db.transaction(async (tx) => {
      await tx.insert(programs).values({
        id: programId,
        userId,
        name: document.name,
        currentVersionId: versionId,
      });
      await tx.insert(programVersions).values({
        id: versionId,
        programId,
        versionNo: 1,
        name: document.name,
      });
      return tx
        .insert(programDrafts)
        .values({
          userId,
          programId,
          baseVersionId: versionId,
          document,
          contentHash: hashProgramDocument(document),
          lastMutationId: crypto.randomUUID(),
        })
        .returning({ id: programDrafts.id });
    });
    await client.query(
      `UPDATE program_drafts
       SET document = jsonb_set(
         document,
         '{days,0,exercises,0,sets}',
         '0'::jsonb
       )
       WHERE id = $1`,
      [draft.id]
    );

    expect(await evaluateApplicationIntegrity(db, userId)).toEqual([
      expect.objectContaining({
        checkKey: "program_draft.document",
        severity: "error",
        entityType: "program_draft",
        entityId: draft.id,
        message: "A Program draft document is malformed.",
      }),
    ]);
  });

  it("surfaces failed, overdue, and expired progression work for recovery", async () => {
    const sessions = await db
      .insert(schema.workoutSessions)
      .values(
        ["Failed progression", "Expired progression", "Overdue progression"].map(
          (templateName, index) => ({
            userId,
            templateName,
            status: "completed" as const,
            startedAt: new Date(`2026-07-0${index + 1}T12:00:00.000Z`),
            finishedAt: new Date(`2026-07-0${index + 1}T13:00:00.000Z`),
            timezone: "America/Toronto",
            localDate: `2026-07-0${index + 1}`,
          })
        )
      )
      .returning({ id: schema.workoutSessions.id });
    const coachingPrefs = {
      aggressiveness: "moderate" as const,
      deloadSuggestions: true,
      substitutionSuggestions: true,
      weeklyReview: true,
    };
    await db.insert(progressionJobs).values([
      {
        userId,
        sessionId: sessions[0].id,
        coachingPrefs,
        status: "failed",
        attempts: 5,
        lastError: "Injected exhausted retry",
      },
      {
        userId,
        sessionId: sessions[1].id,
        coachingPrefs,
        status: "processing",
        attempts: 1,
        leaseToken: crypto.randomUUID(),
        leasedUntil: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        userId,
        sessionId: sessions[2].id,
        coachingPrefs,
        status: "pending",
        nextAttemptAt: new Date("2020-01-01T00:00:00.000Z"),
      },
    ]);

    const findings = await evaluateApplicationIntegrity(db, userId);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkKey: "progression_job.failed",
          severity: "error",
        }),
        expect.objectContaining({
          checkKey: "progression_job.expired_lease",
          severity: "warning",
        }),
        expect.objectContaining({
          checkKey: "progression_job.overdue",
          severity: "warning",
        }),
      ])
    );
  });

  it("surfaces stale source and input revisions before progression can publish", async () => {
    const sessions = await db
      .insert(workoutSessions)
      .values([
        {
          userId,
          templateName: "Corrected source",
          status: "completed",
          startedAt: new Date("2026-07-08T12:00:00.000Z"),
          finishedAt: new Date("2026-07-08T13:00:00.000Z"),
          timezone: "America/Toronto",
          localDate: "2026-07-08",
          historyRevision: 1,
        },
        {
          userId,
          templateName: "Corrected input",
          status: "completed",
          startedAt: new Date("2026-07-01T12:00:00.000Z"),
          finishedAt: new Date("2026-07-01T13:00:00.000Z"),
          timezone: "America/Toronto",
          localDate: "2026-07-01",
          historyRevision: 1,
        },
      ])
      .returning({ id: workoutSessions.id });
    const [job] = await db
      .insert(progressionJobs)
      .values({
        userId,
        sessionId: sessions[0].id,
        sourceSessionRevision: 0,
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
      })
      .returning({ id: progressionJobs.id });
    await db.insert(progressionJobInputSessions).values({
      jobId: job.id,
      userId,
      sourceSlotLineageId: crypto.randomUUID(),
      sessionId: sessions[1].id,
      historyRevision: 0,
    });

    const findings = await evaluateApplicationIntegrity(db, userId);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkKey: "progression_job.stale_source_revision",
          entityId: job.id,
          severity: "warning",
        }),
        expect.objectContaining({
          checkKey: "progression_job.stale_input_revision",
          entityId: job.id,
          severity: "warning",
        }),
      ])
    );
  });

  it("surfaces duplicate manual retry identity and a broken immutable version chain", async () => {
    await client.query(
      'DROP INDEX "workout_sessions_history_manual_source_uq"'
    );
    const sourceWorkoutKey = `manual-${crypto.randomUUID()}`;
    await db.insert(workoutSessions).values([
      {
        userId,
        source: "history_manual",
        sourceWorkoutKey,
        templateName: "Manual History retry one",
        status: "completed",
        startedAt: new Date("2026-07-10T12:00:00.000Z"),
        finishedAt: new Date("2026-07-10T13:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-10",
      },
      {
        userId,
        source: "history_manual",
        sourceWorkoutKey,
        templateName: "Manual History retry two",
        status: "completed",
        startedAt: new Date("2026-07-10T12:00:00.000Z"),
        finishedAt: new Date("2026-07-10T13:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-10",
      },
    ]);

    const entityId = crypto.randomUUID();
    await db.insert(recordVersions).values([
      {
        userId,
        entityType: "completed_set",
        entityId,
        action: "history.correct",
        beforeData: { reps: 5 },
        afterData: { reps: 6 },
        changedFields: ["reps"],
        createdAt: new Date("2026-07-10T14:00:00.000Z"),
      },
      {
        userId,
        entityType: "completed_set",
        entityId,
        action: "history.correct",
        beforeData: { reps: 4 },
        afterData: { reps: 7 },
        changedFields: ["reps"],
        createdAt: new Date("2026-07-10T14:01:00.000Z"),
      },
    ]);

    const findings = await evaluateApplicationIntegrity(db, userId);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkKey: "workout.history_identity_duplicate",
          severity: "error",
        }),
        expect.objectContaining({
          checkKey: "record_version.history_chain",
          severity: "error",
        }),
      ])
    );
  });

  it("surfaces retained workout lineage that contradicts the physical Program chain", async () => {
    const sourceProgramId = crypto.randomUUID();
    const sourceVersionId = crypto.randomUUID();
    const otherProgramId = crypto.randomUUID();
    const otherVersionId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(programs).values({
        id: sourceProgramId,
        userId,
        name: "Recorded source Program",
        currentVersionId: sourceVersionId,
      });
      await tx.insert(programVersions).values({
        id: sourceVersionId,
        programId: sourceProgramId,
        versionNo: 1,
        name: "Recorded source Program",
      });
      await tx.insert(programs).values({
        id: otherProgramId,
        userId,
        name: "Different physical Program",
        status: "archived",
        archivedAt: new Date("2026-07-01T00:00:00.000Z"),
      });
      await tx.insert(programVersions).values({
        id: otherVersionId,
        programId: otherProgramId,
        versionNo: 1,
        name: "Different physical Program",
      });
    });
    const [session] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Contradictory source lineage",
        status: "completed",
        startedAt: new Date("2026-07-11T12:00:00.000Z"),
        finishedAt: new Date("2026-07-11T13:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-11",
        sourceProgramId,
        sourceProgramVersionId: otherVersionId,
        sourceDayLineageId: crypto.randomUUID(),
      })
      .returning({ id: workoutSessions.id });

    expect(await evaluateApplicationIntegrity(db, userId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkKey: "workout.source_lineage",
          entityId: session.id,
          severity: "error",
        }),
      ])
    );
  });

  it("surfaces a processing progression job whose captured membership is incomplete", async () => {
    const [exercise] = await db
      .insert(exercises)
      .values({
        name: "Membership recovery press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    const [session] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Membership recovery workout",
        status: "completed",
        startedAt: new Date("2026-07-12T12:00:00.000Z"),
        finishedAt: new Date("2026-07-12T13:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-12",
      })
      .returning({ id: workoutSessions.id });
    const sourceSlotLineageId = crypto.randomUUID();
    const [sessionExercise] = await db
      .insert(sessionExercises)
      .values({
        sessionId: session.id,
        exerciseId: exercise.id,
        sourceSlotLineageId,
        modificationType: "as_planned",
        orderIdx: 0,
        targetSets: 1,
        targetRepsMin: 5,
        targetRepsMax: 5,
      })
      .returning({ id: sessionExercises.id });
    const [completedSet] = await db
      .insert(completedSets)
      .values({
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        reps: 5,
      })
      .returning({ id: completedSets.id });
    await db.insert(sessionOccurrences).values({
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exercise.id,
      plannedRepsMin: 5,
      plannedRepsMax: 5,
      outcome: "completed",
      completedSetId: completedSet.id,
      revision: 1,
      resolvedAt: new Date("2026-07-12T12:30:00.000Z"),
    });
    const [job] = await db
      .insert(progressionJobs)
      .values({
        userId,
        sessionId: session.id,
        status: "processing",
        leaseToken: crypto.randomUUID(),
        leasedUntil: new Date("2099-01-01T00:00:00.000Z"),
        coachingPrefs: {
          aggressiveness: "moderate",
          deloadSuggestions: true,
          substitutionSuggestions: true,
          weeklyReview: true,
        },
      })
      .returning({ id: progressionJobs.id });

    const findings = await evaluateApplicationIntegrity(db, userId);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkKey: "progression_job.input_membership",
          entityId: job.id,
          severity: "warning",
        }),
      ])
    );
  });

  it("surfaces recommendation status, decision, and adaptation drift", async () => {
    const [recommendation] = await db
      .insert(recommendations)
      .values({
        userId,
        source: "rule",
        status: "rejected",
        decidedAt: new Date(),
        payload: {
          kind: "hold",
          templateExerciseId: crypto.randomUUID(),
          reason: "Recovery fixture",
        },
        reason: "Recovery fixture",
        evidence: { signals: {} },
      })
      .returning({ id: recommendations.id });
    await db.insert(userDecisions).values({
      recommendationId: recommendation.id,
      decision: "approve",
    });
    await db.insert(adaptationEvents).values({
      userId,
      recommendationId: recommendation.id,
      beforeSnapshot: {},
      afterSnapshot: {},
    });

    const findings = await evaluateApplicationIntegrity(db, userId);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkKey: "recommendation.decision_state",
          severity: "error",
          entityId: recommendation.id,
        }),
        expect.objectContaining({
          checkKey: "recommendation.adaptation_state",
          severity: "error",
          entityId: recommendation.id,
        }),
      ])
    );
  });

  it("surfaces a quick-log result linked to another account", async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ email: `recovery-other-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    const [otherSession] = await db
      .insert(workoutSessions)
      .values({
        userId: otherUser.id,
        templateName: "Other account workout",
        status: "completed",
        startedAt: new Date("2026-07-13T12:00:00.000Z"),
        finishedAt: new Date("2026-07-13T13:00:00.000Z"),
        timezone: "UTC",
        localDate: "2026-07-13",
      })
      .returning({ id: workoutSessions.id });
    const [event] = await db
      .insert(aiParsingEvents)
      .values({
        userId,
        scope: "log",
        task: "log_parse",
        rawInput: "cross-owner result",
        confirmed: true,
        confirmedPayload: { sessionId: otherSession.id },
        resultSessionId: otherSession.id,
      })
      .returning({ id: aiParsingEvents.id });

    expect(await evaluateApplicationIntegrity(db, userId)).toEqual([
      expect.objectContaining({
        checkKey: "quick_log.result_session",
        severity: "error",
        entityId: event.id,
      }),
    ]);
  });

  it("reads a protected snapshot back again and records snapshot health", async () => {
    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 17);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown test key.");
        return key;
      },
    };
    const snapshot = await createDataSnapshot(
      db,
      userId,
      { name: "Recovery test", reason: "test", pinned: true },
      { store, keyring, appVersion: "test" }
    );
    if (!snapshot.ok) throw new Error(snapshot.reason);

    const result = await runSnapshotIntegrityCheck(db, userId, {
      store,
      keyring,
    });
    expect(result).toMatchObject({
      status: "passed",
      findings: [],
      checkedSnapshots: 1,
    });
    expect(
      await db.query.recoveryRuns.findFirst({
        where: (table, { eq }) => eq(table.kind, "snapshot_integrity"),
      })
    ).toMatchObject({ status: "passed" });
    expect(await db.select().from(recoveryRuns)).toHaveLength(1);
  }, 30_000);

  it("surfaces stale creation and failed retention tombstones", async () => {
    const staleId = crypto.randomUUID();
    const failedId = crypto.randomUUID();
    const old = new Date("2026-01-01T00:00:00.000Z");
    await db.insert(dataSnapshots).values([
      {
        id: staleId,
        userId,
        name: "Stale named snapshot",
        reason: "manual",
        status: "creating",
        objectPath: `snapshots/${userId}/${staleId}.wtbk`,
        appVersion: "test",
        schemaVersion: "17",
        sizeBytes: 0,
        recordCounts: { total: 0 },
        plaintextChecksum: "stale",
        encryptionAlgorithm: "aes-256-gcm",
        encryptionKeyVersion: "v1",
        snapshotKind: "user",
        createdAt: old,
        updatedAt: old,
      },
      {
        id: failedId,
        userId,
        name: "Failed automatic cleanup",
        reason: "test",
        status: "failed",
        objectPath: `snapshots/${userId}/${failedId}.wtbk`,
        appVersion: "test",
        schemaVersion: "17",
        sizeBytes: 0,
        recordCounts: { total: 0 },
        plaintextChecksum: "failed",
        encryptionAlgorithm: "aes-256-gcm",
        encryptionKeyVersion: "v1",
        snapshotKind: "automatic",
        deletionStatus: "delete_failed",
        deletionRequestedAt: old,
        deletionAttempts: 1,
        deletionFailureReason: "Object store unavailable",
        createdAt: old,
        updatedAt: old,
      },
    ]);

    const findings = await evaluateApplicationIntegrity(db, userId);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkKey: "snapshot.creation_stale",
          severity: "warning",
          entityId: staleId,
        }),
        expect.objectContaining({
          checkKey: "snapshot.deletion_failed",
          severity: "error",
          entityId: failedId,
        }),
      ])
    );
  });
});
