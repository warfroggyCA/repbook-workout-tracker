import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { resultRows } from "@/db/result";
import { updateProgramDayWarmupOverview } from "@/lib/program-editor-client";
import {
  completedSets,
  coachingInsights,
  exerciseEquipmentRequirements,
  exercises,
  painLogs,
  programDrafts,
  programs,
  programVersions,
  progressionJobInputSessions,
  progressionJobs,
  recommendations,
  sessionExercises,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
  workoutTemplateExercises,
  workoutTemplates,
} from "@/db/schema";
import { bootstrapUserAccount } from "@/services/account-bootstrap";
import { acquireExpensiveOperation } from "@/services/expensive-operations";
import {
  activateProgramAtomically,
  REVIEWED_EQUIPMENT_FIT_STALE_REASON,
} from "@/services/program-activation";
import {
  createRestoreProgramDraft,
  getOpenProgramDraft,
  getOrCreateProgramDraft,
  reviewProgramDraft,
  saveProgramDraft,
} from "@/services/program-drafts";
import { hashProgramDocument } from "@/services/program-document-hash";
import {
  publishProgramDraft,
  publishRecommendationProgramVersion,
} from "@/services/program-publication";
import { evaluateSessionProgression } from "@/services/progression";
import {
  claimProgressionJob,
  processProgressionJob,
} from "@/services/progression-jobs";
import {
  updateSessionExerciseWithVersion,
  updateSetWithVersion,
} from "@/services/record-versions";
import {
  createLiveCoachRetry,
  markLiveCoachResponseFailed,
  startLiveCoachTurn,
} from "@/services/live-coaching";
import {
  addWorkoutExercise,
  appendWorkoutSetOccurrence,
  completeWorkoutSession,
  startWorkoutSession,
  StaleWorkoutTemplateError,
} from "@/services/session-lifecycle";
import { createAnalysisPackage } from "@/services/analysis-package";
import { importExternalAnalysisSelection } from "@/services/external-analysis-import";
import {
  approveRecommendationDecision,
  deferRecommendationDecision,
  rejectRecommendationDecision,
} from "@/services/recommendation-decisions";
import { resolveReviewEvidence } from "@/services/review-evidence";
import {
  removeExerciseEquipmentFitAssertion,
  saveExerciseEquipmentFitAssertion,
} from "@/services/exercise-equipment-fit-management";
import { loadEquipmentInventoryDocument } from "@/services/equipment-inventory";
import { loadOwnerEquipmentFitReviewRevision } from "@/services/equipment-fit-review-revision";
import { saveInventoryDocumentForManagement } from "@/services/setup-persistence";
import { externalAnalysisResponseSchema } from "@/lib/external-analysis-response";
import { logWorkoutSet } from "../helpers/log-workout-set";
import { createRetrospectiveWorkout } from "@/services/retrospective-workouts";
import { getHistoryReport } from "@/services/history-report";
import { getCurrentProgramDocument } from "@/services/program-documents";
import { createStartBarrier } from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";
import {
  acceptSessionCompilerProposal,
  createSessionCompilerProposal,
} from "@/services/session-compiler";
import { mutateSessionEquipmentSelection } from "@/services/session-equipment-selection";
import validExternalAnalysisFixture from "../fixtures/v2/a03-typed-response.json";
import {
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
} from "@/lib/program-document";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests.");
const parsedUrl = new URL(url);
const localHost = ["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname);
const approvedEphemeralNeon =
  process.env.ALLOW_EPHEMERAL_NEON_TEST_DATABASE === "true" &&
  parsedUrl.hostname.endsWith(".neon.tech") &&
  process.env.TEST_DATABASE_BRANCH_NAME?.startsWith("codex-concurrency-test-");
if (
  (!localHost && !approvedEphemeralNeon) ||
  !parsedUrl.pathname.endsWith("_test")
) {
  throw new Error(
    "PostgreSQL integration tests only run against the local CI database or an explicitly approved ephemeral Neon branch, and the database name must end in _test."
  );
}

const pool = new Pool({ connectionString: url, max: 24 });
const db = drizzle(pool, { schema });

type ProgramFixture = {
  userId: string;
  programId: string;
  versionId: string;
  exerciseId: string;
  templateId: string;
  slotId: string;
  slotLineageId: string;
  comparableBarbell: boolean;
};

type ReviewedDraft = {
  draftId: string;
  revision: number;
  reviewHash: string;
};

type HeldProgramLock = {
  client: PoolClient;
  backendPid: number;
};

const coachingPrefs = {
  aggressiveness: "aggressive" as const,
  deloadSuggestions: true,
  substitutionSuggestions: true,
  weeklyReview: true,
};

async function createProgramFixture(
  label: string,
  options: { comparableBarbell?: boolean; sets?: number } = {},
): Promise<ProgramFixture> {
  const emailLabel = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  const account = await bootstrapUserAccount(db, {
    email: `${emailLabel}-${crypto.randomUUID()}@example.com`,
    name: label,
  });
  const [exercise] = await db
    .insert(exercises)
    .values({
      name: `${label} squat ${crypto.randomUUID()}`,
      movementPattern: "squat",
      primaryMuscles: ["quadriceps"],
      // Most lifecycle races remain independent of exact equipment setup.
      // Tests that make load claims opt into immutable barbell evidence.
      loadType: options.comparableBarbell ? "barbell" : "external",
      metricType: "weight_reps",
      loadSemantics: "total",
      variantAttributes: { assistance: "none" },
    })
    .returning({ id: exercises.id });
  if (options.comparableBarbell) {
    await db.insert(exerciseEquipmentRequirements).values({
      exerciseId: exercise.id,
      equipmentType: "barbell",
    });
    const [barbell] = await db.insert(schema.equipmentItems).values({
      userId: account.id,
      type: "barbell",
      label: `${label} synthetic barbell`,
      attrs: {},
      available: true,
    }).returning({ id: schema.equipmentItems.id });
    const reviewedFit = await saveExerciseEquipmentFitAssertion(db, account.id, {
      mutationId: crypto.randomUUID(),
      assertionId: null,
      exerciseId: exercise.id,
      equipmentItemId: barbell.id,
      verdict: "compatible",
      reasonCode: "owner_verified",
      reasonNote: "Synthetic owner verified this exact barbell pairing",
      expectedRevision: null,
    });
    if (!reviewedFit.ok) {
      throw new Error(`Comparable barbell fit fixture failed: ${reviewedFit.code}`);
    }
  }
  const activated = await activateProgramAtomically(db, {
    userId: account.id,
    loadUnit: "lb",
    programName: `${label} Program`,
    days: [
      {
        name: `${label} Day`,
        exercises: [
          {
            exerciseId: exercise.id,
            sets: options.sets ?? 1,
            repMin: 6,
            repMax: 8,
            targetLoad: 100,
            restSec: 90,
            supersetKey: null,
            notes: null,
          },
        ],
      },
    ],
    changeSummary: "PostgreSQL concurrency fixture",
    auditAction: "program.activate",
    auditSummary: "Activated PostgreSQL concurrency fixture",
  });
  if (!activated.ok) throw new Error(activated.reason);
  const [template] = await db
    .select({ id: workoutTemplates.id })
    .from(workoutTemplates)
    .where(eq(workoutTemplates.programVersionId, activated.programVersionId));
  const [slot] = await db
    .select({
      id: workoutTemplateExercises.id,
      lineageId: workoutTemplateExercises.lineageId,
    })
    .from(workoutTemplateExercises)
    .where(eq(workoutTemplateExercises.workoutTemplateId, template.id));
  return {
    userId: account.id,
    programId: activated.programId,
    versionId: activated.programVersionId,
    exerciseId: exercise.id,
    templateId: template.id,
    slotId: slot.id,
    slotLineageId: slot.lineageId,
    comparableBarbell: options.comparableBarbell === true,
  };
}

async function createExternalReviewFixture(label: string) {
  const fixture = await createProgramFixture(label);
  const created = await createAnalysisPackage(
    db,
    fixture.userId,
    { questionId: "program_progress", windowDays: 84 },
    {
      now: new Date("2026-08-10T12:00:00.000Z"),
      packageId: crypto.randomUUID(),
      appVersion: "postgres-concurrency-test",
    },
  );
  const response = structuredClone(validExternalAnalysisFixture);
  response.responseId = crypto.randomUUID();
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
  if (!evidenceId) throw new Error("External Review Program evidence missing.");
  for (const observation of response.observations) {
    observation.evidenceIds = [evidenceId];
  }
  for (const proposal of response.proposedActions) {
    proposal.evidenceIds = [evidenceId];
    proposal.effect.target.evidenceIds = [evidenceId];
  }
  for (const unknown of response.unknowns) unknown.evidenceIds = [evidenceId];
  const secondProposal = structuredClone(response.proposedActions[0]);
  secondProposal.id = `proposal-${crypto.randomUUID()}`;
  secondProposal.summary = "Review an independent sibling direction.";
  response.proposedActions.push(secondProposal);
  const parsedResponse = externalAnalysisResponseSchema.parse(response);
  const imported = await importExternalAnalysisSelection(db, fixture.userId, {
    response: parsedResponse,
    selections: {
      observationIds: [parsedResponse.observations[0]!.id],
      proposalIds: parsedResponse.proposedActions.map((proposal) => proposal.id),
    },
  });
  if (!imported.ok) throw new Error(imported.message);
  const importedRecommendations = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.insightId, imported.importId));
  if (importedRecommendations.length !== 2) {
    throw new Error("External Review sibling fixture is incomplete.");
  }
  return {
    userId: fixture.userId,
    receiptId: imported.importId,
    recommendations: importedRecommendations,
  };
}

async function externalReviewCursor(userId: string, receiptId: string) {
  const row = resultRows(await db.execute(sql`
    SELECT owner.analysis_evidence_revision::text AS owner_revision,
           insight.data_digest #>> '{package,sourceEvidenceRevision}' AS receipt_revision
    FROM users owner
    JOIN coaching_insights insight ON insight.user_id = owner.id
    WHERE owner.id = ${userId}::uuid
      AND insight.id = ${receiptId}::uuid
  `))[0];
  return {
    ownerRevision: String(row?.owner_revision ?? ""),
    receiptRevision: String(row?.receipt_revision ?? ""),
  };
}

async function prepareReviewedDraft(
  fixture: ProgramFixture,
  suffix: string
): Promise<ReviewedDraft> {
  const state = await getOrCreateProgramDraft(db, fixture.userId);
  if (!state) throw new Error("Program draft fixture missing.");
  const document = structuredClone(state.draft.document);
  document.name = `${document.name} ${suffix}`;
  const saved = await saveProgramDraft(db, fixture.userId, {
    draftId: state.draft.id,
    expectedRevision: state.draft.revision,
    mutationId: crypto.randomUUID(),
    document,
  });
  if (saved.status !== "saved") {
    throw new Error(`Program draft fixture did not save: ${saved.status}`);
  }
  const review = await reviewProgramDraft(
    db,
    fixture.userId,
    state.draft.id,
    saved.revision
  );
  if (!review || review.status !== "publishable") {
    throw new Error("Program draft fixture did not review.");
  }
  return {
    draftId: state.draft.id,
    revision: saved.revision,
    reviewHash: review.hash,
  };
}

async function prepareReviewedLoadDraft(
  fixture: ProgramFixture,
  targetLoad: number,
  suffix: string
): Promise<ReviewedDraft> {
  const state = await getOrCreateProgramDraft(db, fixture.userId);
  if (!state) throw new Error("Program draft fixture missing.");
  const document = structuredClone(state.draft.document);
  document.name = `${document.name} ${suffix}`;
  document.days[0].exercises[0].targetLoad = targetLoad;
  document.days[0].exercises[0].targetLoadUnit = "lb";
  const saved = await saveProgramDraft(db, fixture.userId, {
    draftId: state.draft.id,
    expectedRevision: state.draft.revision,
    mutationId: crypto.randomUUID(),
    document,
  });
  if (saved.status !== "saved") {
    throw new Error(`Program draft fixture did not save: ${saved.status}`);
  }
  const review = await reviewProgramDraft(
    db,
    fixture.userId,
    state.draft.id,
    saved.revision
  );
  if (!review || review.status !== "publishable") {
    throw new Error("Program draft fixture did not review.");
  }
  return {
    draftId: state.draft.id,
    revision: saved.revision,
    reviewHash: review.hash,
  };
}

async function currentProgramSlot(fixture: ProgramFixture) {
  const [slot] = await db
    .select({
      id: workoutTemplateExercises.id,
      lineageId: workoutTemplateExercises.lineageId,
    })
    .from(programs)
    .innerJoin(
      workoutTemplates,
      eq(workoutTemplates.programVersionId, programs.currentVersionId)
    )
    .innerJoin(
      workoutTemplateExercises,
      eq(workoutTemplateExercises.workoutTemplateId, workoutTemplates.id)
    )
    .where(eq(programs.id, fixture.programId));
  if (!slot) throw new Error("Current Program slot missing.");
  return slot;
}

async function insertLoadRecommendation(
  fixture: ProgramFixture,
  slot: Awaited<ReturnType<typeof currentProgramSlot>>,
  fromLoad: number,
  toLoad: number
) {
  const [recommendation] = await db
    .insert(recommendations)
    .values({
      userId: fixture.userId,
      source: "rule",
      status: "pending",
      sourceTemplateExerciseId: slot.id,
      sourceSlotLineageId: slot.lineageId,
      exerciseId: fixture.exerciseId,
      payload: {
        kind: "load_change",
        templateExerciseId: slot.id,
        fromLoad,
        toLoad,
        loadUnit: "lb",
      },
      reason: "Real PostgreSQL load comparison regression fixture",
      evidence: { signals: {} },
    })
    .returning();
  return recommendation;
}

function reviewSnapshotFor(recommendation: typeof recommendations.$inferSelect) {
  return {
    schemaVersion: "review-decision-v1" as const,
    recommendationId: recommendation.id,
    reviewRevision: recommendation.reviewRevision,
    deferRevision: recommendation.deferRevision,
    recordedAt: new Date().toISOString(),
    evidenceState: "supported" as const,
    source: recommendation.source,
    ruleId: recommendation.ruleId,
    payload: recommendation.payload,
    reason: recommendation.reason,
    evidence: recommendation.evidence,
  };
}

async function publishReviewedDraft(draft: ReviewedDraft, userId: string) {
  return publishProgramDraft(db, userId, {
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    reviewHash: draft.reviewHash,
  });
}

async function createProgressionJob(fixture: ProgramFixture) {
  const started = await startWorkoutSession(
    db,
    fixture.userId,
    fixture.templateId
  );
  const [sessionExercise] = await db
    .select({ id: sessionExercises.id })
    .from(sessionExercises)
    .where(eq(sessionExercises.sessionId, started.sessionId));
  const equipmentSnapshotId = fixture.comparableBarbell
    ? await createTotalSystemTestSnapshot(db, {
        userId: fixture.userId,
        sessionId: started.sessionId,
        sessionExerciseId: sessionExercise.id,
        unit: "lb",
        selectAsCurrent: true,
      })
    : null;
  const saved = await logWorkoutSet(db, fixture.userId, {
    sessionExerciseId: sessionExercise.id,
    setNo: 1,
    weight: 100,
    weightUnit: "lb",
    reps: 8,
    clientKey: crypto.randomUUID(),
    equipmentSnapshotId,
    loadEntryMeaning: equipmentSnapshotId ? "total_system" : "legacy_unknown",
  });
  if (saved.outcome !== "saved") {
    throw new Error(
      `Progression concurrency fixture could not save its set: ${saved.outcome}.`
    );
  }
  const completed = await completeWorkoutSession(
    db,
    { id: fixture.userId, coachingPrefs },
    { sessionId: started.sessionId }
  );
  if (!completed.progressionJobId) throw new Error("Progression job fixture missing.");
  return completed.progressionJobId;
}

async function lockProgram(programId: string): Promise<HeldProgramLock> {
  const client = await pool.connect();
  await client.query("BEGIN");
  const [{ backend_pid: backendPid }] = resultRows<{ backend_pid: number }>(
    await client.query("SELECT pg_backend_pid()::int AS backend_pid")
  );
  await client.query("SELECT id FROM programs WHERE id = $1 FOR UPDATE", [programId]);
  return { client, backendPid: Number(backendPid) };
}

async function lockUserProfile(userId: string): Promise<HeldProgramLock> {
  const client = await pool.connect();
  await client.query("BEGIN");
  const [{ backend_pid: backendPid }] = resultRows<{ backend_pid: number }>(
    await client.query("SELECT pg_backend_pid()::int AS backend_pid"),
  );
  await client.query(
    "SELECT id FROM user_profiles WHERE user_id = $1 FOR UPDATE",
    [userId],
  );
  return { client, backendPid: Number(backendPid) };
}

async function lockWorkoutSession(sessionId: string): Promise<HeldProgramLock> {
  const client = await pool.connect();
  await client.query("BEGIN");
  const [{ backend_pid: backendPid }] = resultRows<{ backend_pid: number }>(
    await client.query("SELECT pg_backend_pid()::int AS backend_pid"),
  );
  await client.query(
    "SELECT id FROM workout_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  return { client, backendPid: Number(backendPid) };
}

async function releaseProgramLock(lock: HeldProgramLock) {
  try {
    await lock.client.query("COMMIT");
  } finally {
    lock.client.release();
  }
}

function isBlockedBy(
  waiterPid: number,
  blockerPid: number,
  blockingByWaiter: Map<number, number[]>,
  visited = new Set<number>()
): boolean {
  if (visited.has(waiterPid)) return false;
  visited.add(waiterPid);
  const blockers = blockingByWaiter.get(waiterPid) ?? [];
  return blockers.some(
    (candidate) =>
      candidate === blockerPid ||
      isBlockedBy(candidate, blockerPid, blockingByWaiter, visited)
  );
}

async function waitForLockWaiters(blockerPid: number, minimum: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiters = resultRows<{ pid: number; blocking_pids: number[] }>(
      await db.execute(sql`
      SELECT pid, pg_blocking_pids(pid) AS blocking_pids
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `)
    );
    const blockingByWaiter = new Map(
      waiters.map((waiter) => [
        Number(waiter.pid),
        waiter.blocking_pids.map(Number),
      ])
    );
    const matching = waiters.filter((waiter) =>
      isBlockedBy(Number(waiter.pid), blockerPid, blockingByWaiter)
    );
    if (matching.length >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Expected ${minimum} PostgreSQL lock waiters blocked by the held row.`
  );
}

async function releaseWhenContended(
  lock: HeldProgramLock,
  operations: Array<Promise<unknown>>,
  minimumWaiters: number
) {
  let waitError: unknown = null;
  try {
    await waitForLockWaiters(lock.backendPid, minimumWaiters);
  } catch (error) {
    waitError = error;
  } finally {
    await releaseProgramLock(lock);
  }
  if (waitError) {
    await Promise.allSettled(operations);
    throw waitError;
  }
}

function expectDefaultAccount(
  account: Awaited<ReturnType<typeof bootstrapUserAccount>>,
  identity: { id: string; email: string; name: string | null; profileId: string }
) {
  expect(account).toEqual({
    id: identity.id,
    email: identity.email,
    name: identity.name,
    profile: {
      id: identity.profileId,
      userId: identity.id,
      ageRange: null,
      experience: "intermediate",
      goals: [],
      sessionLengthMin: 45,
      weeklyFrequency: 3,
      unit: "lb",
      timezone: "America/Toronto",
      fontSize: "default",
      coachingPrefs: {
        aggressiveness: "conservative",
        deloadSuggestions: true,
        substitutionSuggestions: true,
        weeklyReview: true,
      },
      setupCompletedAt: null,
      setupState: { completedSteps: [], routineDraft: null },
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    },
  });
}

async function accountTupleMetadata(userId: string) {
  const [row] = resultRows<{
    user_xmin: string;
    user_ctid: string;
    profile_xmin: string;
    profile_ctid: string;
  }>(await db.execute(sql`
    SELECT
      u.xmin::text AS user_xmin,
      u.ctid::text AS user_ctid,
      p.xmin::text AS profile_xmin,
      p.ctid::text AS profile_ctid
    FROM users u
    INNER JOIN user_profiles p ON p.user_id = u.id
    WHERE u.id = ${userId}
  `));
  if (!row) throw new Error("Account tuple metadata was missing.");
  return row;
}

describe.sequential("real PostgreSQL parallel invariants", () => {
  beforeAll(async () => {
    const [{ serverVersionNum }] = resultRows<{ serverVersionNum: number }>(
      await db.execute(sql`
        SELECT current_setting('server_version_num')::int AS "serverVersionNum"
      `)
    );
    const serverMajorVersion = Math.trunc(Number(serverVersionNum) / 10_000);
    if (serverMajorVersion !== 18) {
      throw new Error(
        `The PostgreSQL concurrency gate requires PostgreSQL 18, but connected to major version ${serverMajorVersion}.`
      );
    }

    const [{ count }] = resultRows<{ count: number }>(await db.execute(sql`
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `));
    if (Number(count) !== 0) {
      throw new Error("The PostgreSQL integration database was not empty.");
    }
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
  });

  afterAll(async () => pool.end());

  it("serializes durable equipment-fit reviews, retries, removal, and audit failure", async () => {
    const owner = await bootstrapUserAccount(db, {
      email: `pii01b-owner-${crypto.randomUUID()}@example.com`,
      name: "PII-01B concurrency owner",
    });
    const [exercise] = await db.insert(exercises).values({
      name: `Cable Face Pull ${crypto.randomUUID()}`,
      movementPattern: "isolation_shoulders",
      primaryMuscles: ["rear delts", "upper back"],
      loadType: "external",
      metricType: "weight_reps",
      loadSemantics: "machine_stack",
      variantAttributes: { assistance: "none" },
    }).returning({ id: exercises.id });
    await db.insert(exerciseEquipmentRequirements).values({
      exerciseId: exercise.id,
      equipmentType: "cable",
    });
    const [station, collidingStation] = await db
      .insert(schema.equipmentItems)
      .values([
        {
          userId: owner.id,
          type: "cable",
          label: "Cable station",
          attrs: { notes: "No usable pulley position" },
          available: true,
        },
        {
          userId: owner.id,
          type: "cable",
          label: "Cable station",
          attrs: { notes: "Independent item with the same display name" },
          available: true,
        },
      ])
      .returning({ id: schema.equipmentItems.id });

    const createInput = {
      mutationId: crypto.randomUUID(),
      assertionId: null,
      exerciseId: exercise.id,
      equipmentItemId: station.id,
      verdict: "compatible" as const,
      reasonCode: "owner_verified" as const,
      reasonNote: null,
      expectedRevision: null,
    };
    const created = await saveExerciseEquipmentFitAssertion(db, owner.id, createInput);
    expect(created).toMatchObject({ ok: true, changed: true, revision: 1 });
    if (!created.ok) throw new Error(created.reason);

    const raceInputs = [
      {
        mutationId: crypto.randomUUID(),
        assertionId: created.assertionId,
        exerciseId: exercise.id,
        equipmentItemId: station.id,
        verdict: "incompatible" as const,
        reasonCode: "missing_capability" as const,
        reasonNote: "No usable pulley position",
        expectedRevision: 1,
      },
      {
        mutationId: crypto.randomUUID(),
        assertionId: created.assertionId,
        exerciseId: exercise.id,
        equipmentItemId: station.id,
        verdict: "incompatible" as const,
        reasonCode: "geometry_limit" as const,
        reasonNote: "Pulley geometry is unsuitable",
        expectedRevision: 1,
      },
    ];
    const race = await Promise.all(
      raceInputs.map((input) => saveExerciseEquipmentFitAssertion(db, owner.id, input)),
    );
    expect(race.filter((result) => result.ok && result.changed)).toHaveLength(1);
    expect(race.filter((result) => !result.ok && result.code === "stale")).toHaveLength(1);
    const winnerIndex = race.findIndex((result) => result.ok && result.changed);
    const winnerInput = raceInputs[winnerIndex]!;
    const replayed = await saveExerciseEquipmentFitAssertion(db, owner.id, winnerInput);
    expect(replayed).toMatchObject({ ok: true, changed: false, revision: 2 });
    await expect(saveExerciseEquipmentFitAssertion(db, owner.id, {
      ...winnerInput,
      reasonNote: `${winnerInput.reasonNote} changed`,
    })).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    await db.execute(sql`
      CREATE FUNCTION pii01b_delay_fit_audit() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.action LIKE 'exercise_equipment_fit.%' THEN
          PERFORM pg_sleep(0.25);
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await db.execute(sql`
      CREATE TRIGGER pii01b_delay_fit_audit
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION pii01b_delay_fit_audit()
    `);
    const exactUpdateRetry = {
      mutationId: crypto.randomUUID(),
      assertionId: created.assertionId,
      exerciseId: exercise.id,
      equipmentItemId: station.id,
      verdict: "compatible" as const,
      reasonCode: "owner_verified" as const,
      reasonNote: "Owner verified the exact synthetic station",
      expectedRevision: 2,
    };
    try {
      const overlappingExactUpdates = await Promise.all([
        saveExerciseEquipmentFitAssertion(db, owner.id, exactUpdateRetry),
        saveExerciseEquipmentFitAssertion(db, owner.id, exactUpdateRetry),
      ]);
      expect(overlappingExactUpdates.filter((result) => result.ok && result.changed))
        .toHaveLength(1);
      expect(overlappingExactUpdates.filter((result) => result.ok && !result.changed))
        .toHaveLength(1);
      expect(overlappingExactUpdates).toEqual(expect.arrayContaining([
        expect.objectContaining({ ok: true, revision: 3 }),
      ]));
    } finally {
      await db.execute(sql`DROP TRIGGER pii01b_delay_fit_audit ON audit_logs`);
      await db.execute(sql`DROP FUNCTION pii01b_delay_fit_audit()`);
    }

    const [{ currentCount, collisionCount }] = resultRows<{
      currentCount: number;
      collisionCount: number;
    }>(await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE equipment_item_id = ${station.id}::uuid)::int AS "currentCount",
        count(*) FILTER (WHERE equipment_item_id = ${collidingStation.id}::uuid)::int AS "collisionCount"
      FROM exercise_equipment_fit_assertions
      WHERE user_id = ${owner.id}::uuid
        AND exercise_id = ${exercise.id}::uuid
    `));
    expect({ currentCount, collisionCount }).toEqual({ currentCount: 1, collisionCount: 0 });

    await db.execute(sql`
      CREATE FUNCTION pii01b_reject_fit_audit() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.action LIKE 'exercise_equipment_fit.%' THEN
          RAISE EXCEPTION 'synthetic PII-01B audit failure';
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await db.execute(sql`
      CREATE TRIGGER pii01b_reject_fit_audit
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION pii01b_reject_fit_audit()
    `);
    try {
      let injectedFailure: unknown;
      try {
        await saveExerciseEquipmentFitAssertion(db, owner.id, {
          mutationId: crypto.randomUUID(),
          assertionId: null,
          exerciseId: exercise.id,
          equipmentItemId: collidingStation.id,
          verdict: "incompatible",
          reasonCode: "missing_capability",
          reasonNote: "Synthetic failure must roll everything back",
          expectedRevision: null,
        });
      } catch (error) {
        injectedFailure = error;
      }
      const failureMessages: string[] = [];
      let currentFailure: unknown = injectedFailure;
      for (let depth = 0; currentFailure !== undefined && currentFailure !== null && depth < 5; depth += 1) {
        failureMessages.push(
          currentFailure instanceof Error ? currentFailure.message : String(currentFailure),
        );
        currentFailure =
          typeof currentFailure === "object" && "cause" in currentFailure
            ? (currentFailure as { cause?: unknown }).cause
            : undefined;
      }
      expect(failureMessages.join("\n")).toMatch(/synthetic PII-01B audit failure/u);
    } finally {
      await db.execute(sql`DROP TRIGGER pii01b_reject_fit_audit ON audit_logs`);
      await db.execute(sql`DROP FUNCTION pii01b_reject_fit_audit()`);
    }
    const [{ failedAssertions, failedVersions }] = resultRows<{
      failedAssertions: number;
      failedVersions: number;
    }>(await db.execute(sql`
      SELECT
        (SELECT count(*)::int
           FROM exercise_equipment_fit_assertions assertion
          WHERE assertion.user_id = ${owner.id}::uuid
            AND assertion.exercise_id = ${exercise.id}::uuid
            AND assertion.equipment_item_id = ${collidingStation.id}::uuid) AS "failedAssertions",
        (SELECT count(*)::int
           FROM record_versions version
          WHERE version.user_id = ${owner.id}::uuid
            AND version.entity_type = 'exercise_equipment_fit_assertion'
            AND version.after_data->>'equipment_item_id' = ${collidingStation.id}::text) AS "failedVersions"
    `));
    expect({ failedAssertions, failedVersions }).toEqual({
      failedAssertions: 0,
      failedVersions: 0,
    });

    await db.execute(sql`
      CREATE FUNCTION pii01b_delay_fit_remove_audit() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.action = 'exercise_equipment_fit.remove' THEN
          PERFORM pg_sleep(0.25);
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await db.execute(sql`
      CREATE TRIGGER pii01b_delay_fit_remove_audit
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION pii01b_delay_fit_remove_audit()
    `);
    const removeInput = {
      mutationId: crypto.randomUUID(),
      assertionId: created.assertionId,
      expectedRevision: 3,
    };
    try {
      const removals = await Promise.all([
        removeExerciseEquipmentFitAssertion(db, owner.id, removeInput),
        removeExerciseEquipmentFitAssertion(db, owner.id, removeInput),
      ]);
      expect(removals.filter((result) => result.ok && result.changed)).toHaveLength(1);
      expect(removals.filter((result) => result.ok && !result.changed)).toHaveLength(1);
    } finally {
      await db.execute(sql`DROP TRIGGER pii01b_delay_fit_remove_audit ON audit_logs`);
      await db.execute(sql`DROP FUNCTION pii01b_delay_fit_remove_audit()`);
    }

    const [{ assertions, audits, versions }] = resultRows<{
      assertions: number;
      audits: number;
      versions: number;
    }>(await db.execute(sql`
      SELECT
        (SELECT count(*)::int
           FROM exercise_equipment_fit_assertions assertion
          WHERE assertion.user_id = ${owner.id}::uuid
            AND assertion.exercise_id = ${exercise.id}::uuid) AS assertions,
        (SELECT count(*)::int
           FROM audit_logs audit
          WHERE audit.user_id = ${owner.id}::uuid
            AND audit.action LIKE 'exercise_equipment_fit.%') AS audits,
        (SELECT count(*)::int
           FROM record_versions version
          WHERE version.user_id = ${owner.id}::uuid
            AND version.entity_type = 'exercise_equipment_fit_assertion') AS versions
    `));
    expect({ assertions, audits, versions }).toEqual({
      assertions: 0,
      audits: 4,
      versions: 4,
    });
  }, 60_000);

  it("rechecks imported-program equipment semantics after an overlapping owner-lock wait", async () => {
    const owner = await bootstrapUserAccount(db, {
      email: `pii01b-inventory-race-${crypto.randomUUID()}@example.com`,
      name: "PII-01B inventory race owner",
    });
    const [exercise] = await db.insert(exercises).values({
      name: `Cable inventory race ${crypto.randomUUID()}`,
      movementPattern: "isolation_shoulders",
      primaryMuscles: ["rear delts"],
      loadType: "external",
      metricType: "weight_reps",
      loadSemantics: "machine_stack",
      variantAttributes: { assistance: "none" },
    }).returning({ id: exercises.id });
    await db.insert(exerciseEquipmentRequirements).values({
      exerciseId: exercise.id,
      equipmentType: "cable",
    });
    await db.insert(schema.equipmentItems).values({
      userId: owner.id,
      type: "cable",
      label: "Reviewed cable station",
      attrs: { maxWeight: 100 },
      available: true,
    });

    const reviewedFitRevision = await loadOwnerEquipmentFitReviewRevision(db, owner.id);
    if (!reviewedFitRevision) throw new Error("PII-01B reviewed fit evidence was missing.");
    const [importEvent] = await db.insert(schema.importEvents).values({
      userId: owner.id,
      source: "paste",
      rawPayload: "Synthetic private routine paste",
      parsedPayload: { schemaVersion: "synthetic-import-race/1" },
      status: "parsed",
    }).returning({ id: schema.importEvents.id });
    const activationInput: Parameters<typeof activateProgramAtomically>[1] = {
      userId: owner.id,
      loadUnit: "lb",
      programName: "Stale equipment review must not publish",
      days: [{
        name: "Cable day",
        exercises: [{
          exerciseId: exercise.id,
          sets: 3,
          repMin: 12,
          repMax: 15,
          targetLoad: 30,
          restSec: 60,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Synthetic stale inventory activation",
      auditAction: "import.confirm",
      auditSummary: "Synthetic stale inventory activation",
      importEventId: importEvent.id,
      confirmedPayload: { schemaVersion: "synthetic-import-race/1" },
      structuredIntentReviewed: true,
      allowReviewedUnknownEquipmentFit: true,
      expectedEquipmentFitReviewRevision: reviewedFitRevision,
    };

    const activationLock = await lockUserProfile(owner.id);
    await activationLock.client.query(
      "UPDATE exercise_equipment_requirements SET min_weight = $1 WHERE exercise_id = $2",
      [25, exercise.id],
    );
    const activation = activateProgramAtomically(db, activationInput);
    await releaseWhenContended(activationLock, [activation], 1);
    await expect(activation).resolves.toEqual({
      ok: false,
      reason: REVIEWED_EQUIPMENT_FIT_STALE_REASON,
    });
    const [{ count: programCount }] = resultRows<{ count: number }>(await db.execute(sql`
      SELECT count(*)::int AS count
      FROM programs
      WHERE user_id = ${owner.id}::uuid
    `));
    expect(programCount).toBe(0);
    await expect(db.query.importEvents.findFirst({
      where: eq(schema.importEvents.id, importEvent.id),
    })).resolves.toMatchObject({ status: "parsed" });

    const current = await loadEquipmentInventoryDocument(db, owner.id);
    if (!current) throw new Error("PII-01B current inventory was missing.");
    const left = structuredClone(current.document);
    const right = structuredClone(current.document);
    left.items[0]!.label = "Concurrent inventory writer A";
    right.items[0]!.label = "Concurrent inventory writer B";

    const saveLock = await lockUserProfile(owner.id);
    const saves = [
      saveInventoryDocumentForManagement(db, owner.id, left),
      saveInventoryDocumentForManagement(db, owner.id, right),
    ];
    await releaseWhenContended(saveLock, saves, 2);
    const results = await Promise.all(saves);
    expect(results.filter((result) => result.ok && result.changed)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "stale")).toHaveLength(1);
  }, 60_000);

  it("rechecks reviewed Program publication after an overlapping fit removal", async () => {
    const fixture = await createProgramFixture(
      "reviewed publication equipment race",
      { comparableBarbell: true },
    );
    const draft = await prepareReviewedDraft(
      fixture,
      "must not publish stale equipment truth",
    );
    const fitLock = await lockUserProfile(fixture.userId);
    await fitLock.client.query(
      `DELETE FROM exercise_equipment_fit_assertions
       WHERE user_id = $1 AND exercise_id = $2`,
      [fixture.userId, fixture.exerciseId],
    );

    const publication = publishReviewedDraft(draft, fixture.userId);
    await releaseWhenContended(fitLock, [publication], 1);
    await expect(publication).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(db.query.programs.findFirst({
      where: eq(programs.id, fixture.programId),
    })).resolves.toMatchObject({ currentVersionId: fixture.versionId });
    await expect(db.query.programDrafts.findFirst({
      where: eq(programDrafts.id, draft.draftId),
    })).resolves.toMatchObject({ status: "open", publishedVersionId: null });
  }, 60_000);

  it("persists a new exact bar profile after its same-save equipment parent", async () => {
    const owner = await bootstrapUserAccount(db, {
      email: `pii01b-new-bar-${crypto.randomUUID()}@example.com`,
      name: "PII-01B new bar owner",
    });
    const loaded = await loadEquipmentInventoryDocument(db, owner.id);
    if (!loaded) throw new Error("PII-01B new-bar inventory was missing.");
    const barItemId = crypto.randomUUID();
    const saved = await saveInventoryDocumentForManagement(db, owner.id, {
      ...loaded.document,
      items: [
        ...loaded.document.items,
        {
          id: null,
          draftId: barItemId,
          type: "barbell",
          label: "Native PostgreSQL exact bar",
          quantity: 1,
          attrs: {},
        },
      ],
      bars: [
        ...loaded.document.bars,
        {
          id: null,
          barType: "olympic",
          barWeight: 45,
          collarWeight: 5,
          quantity: 1,
          label: "Native PostgreSQL exact bar",
        },
      ],
      loadProfiles: [
        ...(loaded.document.loadProfiles ?? []),
        {
          equipmentItemId: barItemId,
          profile: {
            kind: "plate_loaded_implement",
            id: null,
            loadingKind: "olympic",
            emptyWeight: 45,
            collarWeight: 5,
            unit: "lb",
            sharedPlatePoolCompatible: true,
          },
        },
      ],
    });
    expect(saved).toMatchObject({ ok: true, changed: true });
    await expect(db.query.barbellConfigs.findFirst({
      where: and(
        eq(schema.barbellConfigs.userId, owner.id),
        eq(schema.barbellConfigs.equipmentItemId, barItemId),
      ),
    })).resolves.toMatchObject({
      loadingKind: "olympic",
      barWeight: 45,
      collarWeight: 5,
      unit: "lb",
      sharedPlatePoolCompatible: true,
    });
  }, 60_000);

  it("rejects Session Compiler acceptance after an overlapping Program publication", async () => {
    const priorEditor = process.env.PROGRAM_EDITOR_ENABLED;
    const priorCompiler = process.env.SESSION_COMPILER_ENABLED;
    process.env.PROGRAM_EDITOR_ENABLED = "true";
    process.env.SESSION_COMPILER_ENABLED = "true";
    try {
      const owner = await bootstrapUserAccount(db, {
        email: `compiler-program-race-${crypto.randomUUID()}@example.com`,
        name: "Compiler Program race owner",
      });
      const [exercise] = await db.insert(exercises).values({
        name: `Compiler bodyweight movement ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "bodyweight",
        metricType: "reps",
        loadSemantics: "none",
        variantAttributes: { assistance: "none" },
      }).returning({ id: exercises.id });
      const dayLineageId = crypto.randomUUID();
      const slotLineageId = crypto.randomUUID();
      const slotIntent = createSuggestedSlotIntent(3, 0);
      const dayIntent = createSuggestedDayIntent([
        { lineageId: slotLineageId, sets: 3, restSec: 90 },
      ]);
      const activated = await activateProgramAtomically(db, {
        userId: owner.id,
        loadUnit: "lb",
        programName: "Compiler race Program",
        days: [{
          lineageId: dayLineageId,
          name: "Compiler race day",
          warmupItems: [],
          intent: dayIntent,
          exercises: [{
            lineageId: slotLineageId,
            exerciseId: exercise.id,
            sets: 3,
            repMin: 8,
            repMax: 12,
            targetLoad: null,
            restSec: 90,
            supersetKey: null,
            notes: null,
            warmupSets: [],
            intent: slotIntent,
          }],
        }],
        changeSummary: "Create compiler publication race fixture",
        auditAction: "program.activate",
        auditSummary: "Created compiler publication race fixture",
        structuredIntentReviewed: true,
      });
      if (!activated.ok) throw new Error(activated.reason);
      const [template] = await db.select({ id: workoutTemplates.id })
        .from(workoutTemplates)
        .where(eq(workoutTemplates.programVersionId, activated.programVersionId));
      const [slot] = await db.select({
        id: workoutTemplateExercises.id,
        lineageId: workoutTemplateExercises.lineageId,
      }).from(workoutTemplateExercises)
        .where(eq(workoutTemplateExercises.workoutTemplateId, template.id));
      const fixture: ProgramFixture = {
        userId: owner.id,
        programId: activated.programId,
        versionId: activated.programVersionId,
        exerciseId: exercise.id,
        templateId: template.id,
        slotId: slot.id,
        slotLineageId: slot.lineageId,
        comparableBarbell: false,
      };
      const proposal = await createSessionCompilerProposal(db, owner.id, {
        dayLineageId,
        requestedMinutes: 30,
        energy: "usual",
        clientMutationId: crypto.randomUUID(),
      });
      expect(proposal.status).toBe("ready");
      const draft = await prepareReviewedDraft(
        fixture,
        "published before compiler acceptance",
      );

      const profileLock = await lockUserProfile(owner.id);
      const publication = publishReviewedDraft(draft, owner.id);
      await waitForLockWaiters(profileLock.backendPid, 1);
      const acceptance = acceptSessionCompilerProposal(
        db,
        owner.id,
        proposal.id,
        crypto.randomUUID(),
        "America/Toronto",
      );
      await releaseWhenContended(profileLock, [publication, acceptance], 2);
      const [published, accepted] = await Promise.all([publication, acceptance]);
      expect(published).toMatchObject({ ok: true });
      expect(accepted).toEqual({ outcome: "stale" });
      expect(await db.select().from(workoutSessions)
        .where(eq(workoutSessions.userId, owner.id))).toHaveLength(0);
    } finally {
      if (priorEditor === undefined) delete process.env.PROGRAM_EDITOR_ENABLED;
      else process.env.PROGRAM_EDITOR_ENABLED = priorEditor;
      if (priorCompiler === undefined) delete process.env.SESSION_COMPILER_ENABLED;
      else process.env.SESSION_COMPILER_ENABLED = priorCompiler;
    }
  }, 60_000);

  it("replays overlapping identical exact setup selections after the owner lock", async () => {
    const owner = await bootstrapUserAccount(db, {
      email: `equipment-selection-retry-${crypto.randomUUID()}@example.com`,
      name: "Equipment selection retry owner",
    });
    const [exercise] = await db.insert(exercises).values({
      name: `Equipment selection retry bench ${crypto.randomUUID()}`,
      movementPattern: "horizontal_push",
      primaryMuscles: ["chest"],
      loadType: "barbell",
      metricType: "weight_reps",
      loadSemantics: "total",
      variantAttributes: { assistance: "none" },
    }).returning({ id: exercises.id });
    const requirements = await db.insert(exerciseEquipmentRequirements).values([
      { exerciseId: exercise.id, equipmentType: "barbell" },
      { exerciseId: exercise.id, equipmentType: "plates" },
    ]).returning({
      id: exerciseEquipmentRequirements.id,
      equipmentType: exerciseEquipmentRequirements.equipmentType,
    });
    const [barbell] = await db.insert(schema.equipmentItems).values({
      userId: owner.id,
      type: "barbell",
      label: "Retry-safe owner barbell",
      attrs: {},
      available: true,
    }).returning({ id: schema.equipmentItems.id });
    await db.insert(schema.plateInventory).values({
      userId: owner.id,
      denomination: 2.5,
      unit: "lb",
      quantity: 4,
    });
    await db.insert(schema.barbellConfigs).values({
      userId: owner.id,
      equipmentItemId: barbell.id,
      barType: "olympic",
      unit: "lb",
      loadingKind: "olympic",
      sharedPlatePoolCompatible: true,
      barWeight: 45,
      collarWeight: 1,
      label: "Retry-safe owner barbell",
    });
    const fit = await saveExerciseEquipmentFitAssertion(db, owner.id, {
      mutationId: crypto.randomUUID(),
      assertionId: null,
      exerciseId: exercise.id,
      equipmentItemId: barbell.id,
      verdict: "compatible",
      reasonCode: "owner_verified",
      reasonNote: "Synthetic exact setup review",
      expectedRevision: null,
    });
    if (!fit.ok) throw new Error(fit.reason);

    const [session] = await db.insert(workoutSessions).values({
      userId: owner.id,
      status: "in_progress",
      timezone: "America/Toronto",
      localDate: "2026-08-11",
      startedAt: new Date("2026-08-11T16:00:00.000Z"),
    }).returning({ id: workoutSessions.id });
    const [sessionExercise] = await db.insert(sessionExercises).values({
      sessionId: session.id,
      exerciseId: exercise.id,
      orderIdx: 0,
      equipmentRequirementsSemanticsVersion: 1,
      equipmentRequirementsSnapshot: {
        sourceExerciseId: exercise.id,
        broad: requirements
          .toSorted((left, right) => left.id.localeCompare(right.id))
          .map((requirement) => ({
            sourceRequirementId: requirement.id,
            equipmentType: requirement.equipmentType,
            equipmentDefinition: null,
            minWeight: null,
          })),
        exact: null,
      },
    }).returning({ id: sessionExercises.id });
    await db.insert(sessionOccurrences).values({
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: exercise.id,
      outcome: "pending",
    });

    const input = {
      operation: "select" as const,
      sessionExerciseId: sessionExercise.id,
      equipmentItemId: barbell.id,
      attachmentItemId: null,
      expectedCurrentSnapshotId: null,
      clientKey: crypto.randomUUID(),
      provenance: "user_selected" as const,
    };
    const ready = createStartBarrier(2);
    const results = await Promise.all([
      mutateSessionEquipmentSelection(db, owner.id, input, {
        checkpoint: async () => ready(),
      }),
      mutateSessionEquipmentSelection(db, owner.id, input, {
        checkpoint: async () => ready(),
      }),
    ]);

    expect(results.map((result) => result.outcome).sort())
      .toEqual(["applied", "replayed"]);
    const receipts = await db.select()
      .from(schema.sessionEquipmentSelectionReceipts)
      .where(eq(
        schema.sessionEquipmentSelectionReceipts.sessionExerciseId,
        sessionExercise.id,
      ));
    expect(receipts).toHaveLength(1);
    expect(await db.select()
      .from(schema.sessionEquipmentSnapshots)
      .where(eq(
        schema.sessionEquipmentSnapshots.sessionExerciseId,
        sessionExercise.id,
      ))).toHaveLength(1);
  }, 60_000);

  it("replays overlapping identical active replacements after the owner lock", async () => {
    const owner = await bootstrapUserAccount(db, {
      email: `replacement-retry-${crypto.randomUUID()}@example.com`,
      name: "Replacement retry owner",
    });
    const insertedExercises = await db.insert(exercises).values([
      {
        name: `Replacement retry original ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "bodyweight",
        metricType: "reps",
        loadSemantics: "none",
        variantAttributes: { assistance: "none" },
      },
      {
        name: `Replacement retry target ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "bodyweight",
        metricType: "reps",
        loadSemantics: "none",
        variantAttributes: { assistance: "none" },
      },
    ]).returning({ id: exercises.id });
    const [original, target] = insertedExercises;
    const [session] = await db.insert(workoutSessions).values({
      userId: owner.id,
      status: "in_progress",
      timezone: "America/Toronto",
      localDate: "2026-08-11",
      startedAt: new Date("2026-08-11T16:00:00.000Z"),
    }).returning({ id: workoutSessions.id });
    const [sessionExercise] = await db.insert(sessionExercises).values({
      sessionId: session.id,
      exerciseId: original.id,
      orderIdx: 0,
    }).returning({ id: sessionExercises.id });
    await db.insert(sessionOccurrences).values({
      sessionId: session.id,
      sessionExerciseId: sessionExercise.id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 0,
      kindOrdinal: 0,
      plannedExerciseId: original.id,
      outcome: "pending",
    });

    const versionId = crypto.randomUUID();
    const substitutedAt = new Date("2026-08-11T16:05:00.000Z");
    const replace = () => updateSessionExerciseWithVersion(
      db,
      owner.id,
      sessionExercise.id,
      {
        exerciseId: target.id,
        modificationType: "substituted",
        skipReason: null,
        substitutedForExerciseId: original.id,
        substitutionReason: "other",
        substitutedAt,
        targetLoad: null,
        targetLoadUnit: null,
        notes: null,
        warmupNotes: null,
        warmupSets: [],
        setNotes: [],
      },
      "session_exercise.substitute",
      {
        activeOnly: true,
        expectedExerciseId: original.id,
        versionId,
      },
    );
    const profileLock = await lockUserProfile(owner.id);
    const replacements = [replace(), replace()];
    await releaseWhenContended(profileLock, replacements, 2);
    const results = await Promise.all(replacements);

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: true, changed: true, versionId }),
      expect.objectContaining({ ok: true, changed: false, versionId }),
    ]));
    expect(await db.select().from(schema.recordVersions)
      .where(eq(schema.recordVersions.id, versionId))).toHaveLength(1);
    expect(await db.select({ exerciseId: sessionExercises.exerciseId })
      .from(sessionExercises)
      .where(eq(sessionExercises.id, sessionExercise.id)))
      .toEqual([{ exerciseId: target.id }]);
  }, 60_000);

  it("enforces the History timing, revision, uniqueness, and owner constraints", async () => {
    const owner = await createProgramFixture("history constraint owner");
    const other = await createProgramFixture("history constraint other");
    const progressionJobId = await createProgressionJob(owner);
    const otherProgressionJobId = await createProgressionJob(other);
    const [job] = await db
      .select()
      .from(progressionJobs)
      .where(eq(progressionJobs.id, progressionJobId));
    const [otherJob] = await db
      .select()
      .from(progressionJobs)
      .where(eq(progressionJobs.id, otherProgressionJobId));
    const [set] = await db
      .select({ id: completedSets.id })
      .from(completedSets)
      .innerJoin(
        sessionExercises,
        eq(sessionExercises.id, completedSets.sessionExerciseId),
      )
      .where(eq(sessionExercises.sessionId, job.sessionId));

    await db
      .update(completedSets)
      .set({
        observedCompletedAt: new Date("2026-07-25T12:00:00.000Z"),
        observedCompletionProvenance: "live_client",
        observedCompletionQuality: "trustworthy",
      })
      .where(eq(completedSets.id, set.id));
    await expect(db.execute(sql`
      UPDATE completed_sets
      SET logged_at = logged_at + interval '1 second'
      WHERE id = ${set.id}::uuid
    `)).rejects.toMatchObject({
      cause: {
        message: expect.stringMatching(/recording time is immutable/i),
      },
    });
    await expect(db.execute(sql`
      UPDATE completed_sets
      SET observed_completion_quality = 'owner_reported'
      WHERE id = ${set.id}::uuid
    `)).rejects.toThrow();
    await expect(
      db.insert(progressionJobs).values({
        userId: owner.userId,
        sessionId: job.sessionId,
        sourceSessionRevision: job.sourceSessionRevision,
        coachingPrefs,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(progressionJobs).values({
        userId: other.userId,
        sessionId: job.sessionId,
        sourceSessionRevision: 1,
        coachingPrefs,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(progressionJobInputSessions).values({
        jobId: progressionJobId,
        userId: owner.userId,
        sourceSlotLineageId: owner.slotLineageId,
        sessionId: otherJob.sessionId,
        historyRevision: 0,
      }),
    ).rejects.toThrow();
  });

  it("keeps stable exercise and source-workout identities in the History report", async () => {
    const fixture = await createProgramFixture(
      "history workspace identities",
      { comparableBarbell: true },
    );
    const jobId = await createProgressionJob(fixture);
    const [job] = await db
      .select({ sessionId: progressionJobs.sessionId })
      .from(progressionJobs)
      .where(eq(progressionJobs.id, jobId));

    const report = await getHistoryReport(
      db,
      fixture.userId,
      "all",
      3,
      new Date(),
      { timezone: "America/Toronto", unit: "lb" },
    );

    expect(report.exerciseProgress[0]).toMatchObject({
      exerciseId: fixture.exerciseId,
      first: { sourceSessionId: job.sessionId },
      latest: { sourceSessionId: job.sessionId },
    });
    expect(report.records[0]).toMatchObject({
      exerciseId: fixture.exerciseId,
      sourceSessionId: job.sessionId,
    });
    expect(report.families[0]).toMatchObject({
      familyKey: `exercise:${fixture.exerciseId}`,
    });
  });

  it("converges 16 first-login requests after every caller observes the account missing", async () => {
    const missing = createStartBarrier(16);
    const accounts = await Promise.all(
      Array.from({ length: 16 }, () =>
        bootstrapUserAccount(
          db,
          {
            email: "  PARALLEL-ACCOUNT@example.com ",
            name: "Parallel Account",
          },
          async (boundary) => {
            if (boundary === "account-missing") await missing();
          }
        )
      )
    );
    const [storedUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "parallel-account@example.com"));
    const [storedProfile] = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, storedUser.id));

    expect(await db.select().from(users).where(eq(users.email, storedUser.email))).toHaveLength(1);
    expect(await db.select().from(userProfiles).where(eq(userProfiles.userId, storedUser.id))).toHaveLength(1);
    for (const account of accounts) {
      expectDefaultAccount(account, {
        id: storedUser.id,
        email: "parallel-account@example.com",
        name: "Parallel Account",
        profileId: storedProfile.id,
      });
    }
  });

  it("converges 16 missing-profile repairs on the original user and one profile", async () => {
    const [storedUser] = await db
      .insert(users)
      .values({
        email: "parallel-profile-repair@example.com",
        name: "Original Account",
      })
      .returning();
    const missing = createStartBarrier(16);
    const accounts = await Promise.all(
      Array.from({ length: 16 }, () =>
        bootstrapUserAccount(
          db,
          {
            email: "parallel-profile-repair@example.com",
            name: "Replacement Account",
          },
          async (boundary) => {
            if (boundary === "account-missing") await missing();
          }
        )
      )
    );
    const storedUsers = await db
      .select()
      .from(users)
      .where(eq(users.email, storedUser.email));
    const storedProfiles = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, storedUser.id));

    expect(storedUsers).toHaveLength(1);
    expect(storedUsers[0].id).toBe(storedUser.id);
    expect(storedUsers[0].name).toBe("Original Account");
    expect(storedProfiles).toHaveLength(1);
    for (const account of accounts) {
      expectDefaultAccount(account, {
        id: storedUser.id,
        email: storedUser.email,
        name: "Original Account",
        profileId: storedProfiles[0].id,
      });
    }
  });

  it("keeps user and profile tuples unchanged during parallel steady-state reads", async () => {
    const initial = await bootstrapUserAccount(db, {
      email: "parallel-steady-state@example.com",
      name: "Steady State",
    });
    const before = await accountTupleMetadata(initial.id);
    const accounts = await Promise.all(
      Array.from({ length: 16 }, () =>
        bootstrapUserAccount(db, {
          email: "parallel-steady-state@example.com",
          name: "Ignored Replacement",
        })
      )
    );
    const after = await accountTupleMetadata(initial.id);

    expect(after).toEqual(before);
    for (const account of accounts) {
      expectDefaultAccount(account, {
        id: initial.id,
        email: "parallel-steady-state@example.com",
        name: "Steady State",
        profileId: initial.profile.id,
      });
    }
  });

  it("materializes general and lift-anchored warm-ups in exact PostgreSQL workout order", async () => {
    const account = await bootstrapUserAccount(db, {
      email: `pii01-warmups-${crypto.randomUUID()}@example.com`,
      name: "PII-01 PostgreSQL",
    });
    const createdExercises = await db
      .insert(exercises)
      .values(["first", "second"].map((suffix) => ({
        name: `PII-01 ${suffix} lift ${crypto.randomUUID()}`,
        movementPattern: "squat" as const,
        primaryMuscles: ["other"],
        loadType: "external" as const,
      })))
      .returning({ id: exercises.id });
    const dayLineageId = crypto.randomUUID();
    const slotLineages = [crypto.randomUUID(), crypto.randomUUID()];
    const slotIntents = slotLineages.map((_, index) => ({
      ...createSuggestedSlotIntent(1, index),
      idealDose: { unit: "sets" as const, value: 1 },
      substitutionPolicy: "no_substitution" as const,
      omissionPolicy: "never" as const,
      calibrationEligible: false,
    }));
    const dayIntent = createSuggestedDayIntent(slotLineages.map((lineageId) => ({
      lineageId,
      sets: 1,
      restSec: 60,
    })));
    const activated = await activateProgramAtomically(db, {
      userId: account.id,
      loadUnit: "lb",
      programName: "PII-01 PostgreSQL order",
      days: [{
        lineageId: dayLineageId,
        name: "Ordered warm-ups",
        warmupItems: [
          {
            key: crypto.randomUUID(),
            beforeSlotLineageId: null,
            label: "General preparation",
            reps: null,
            load: null,
            loadUnit: null,
            loadPercent: null,
            loadText: null,
            notes: null,
          },
          ...slotLineages.map((beforeSlotLineageId, index) => ({
            key: crypto.randomUUID(),
            beforeSlotLineageId,
            label: `Ramp ${index + 1}`,
            reps: 5,
            load: null,
            loadUnit: null,
            loadPercent: null,
            loadText: null,
            notes: null,
          })),
        ],
        intent: dayIntent,
        exercises: createdExercises.map((exercise, index) => ({
          lineageId: slotLineages[index],
          exerciseId: exercise.id,
          sets: 1,
          repMin: 5,
          repMax: 5,
          targetLoad: 10,
          targetLoadUnit: "lb" as const,
          restSec: 60,
          supersetKey: null,
          notes: null,
          intent: slotIntents[index],
        })),
      }],
      changeSummary: "PII-01 native PostgreSQL fixture",
      auditAction: "program.activate",
      auditSummary: "PII-01 native PostgreSQL fixture",
      expectedCurrentProgramVersionId: null,
      structuredIntentReviewed: true,
    });
    if (!activated.ok) throw new Error(activated.reason);
    const [template] = await db
      .select({ id: workoutTemplates.id })
      .from(workoutTemplates)
      .where(eq(workoutTemplates.programVersionId, activated.programVersionId));
    const started = await startWorkoutSession(db, account.id, template.id);
    const occurrences = await db
      .select({
        kind: sessionOccurrences.kind,
        label: sessionOccurrences.label,
        sequenceIdx: sessionOccurrences.sequenceIdx,
      })
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId))
      .orderBy(sessionOccurrences.sequenceIdx);
    expect(occurrences).toEqual([
      expect.objectContaining({ sequenceIdx: 0, kind: "day_warmup", label: "General preparation" }),
      expect.objectContaining({ sequenceIdx: 1, kind: "exercise_warmup", label: "Ramp 1" }),
      expect.objectContaining({ sequenceIdx: 2, kind: "working_set", label: null }),
      expect.objectContaining({ sequenceIdx: 3, kind: "exercise_warmup", label: "Ramp 2" }),
      expect.objectContaining({ sequenceIdx: 4, kind: "working_set", label: null }),
    ]);
  });

  it("keeps one active session and one idempotent set under parallel requests", async () => {
    const fixture = await createProgramFixture("parallel session");
    const starts = await Promise.all(
      Array.from({ length: 16 }, () =>
        startWorkoutSession(db, fixture.userId, fixture.templateId, 45)
      )
    );
    expect(new Set(starts.map((result) => result.sessionId))).toHaveLength(1);
    const sessionId = starts[0].sessionId;
    const [sessionExercise] = await db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, sessionId));
    const clientKey = crypto.randomUUID();
    const sets = await Promise.all(
      Array.from({ length: 16 }, () =>
        logWorkoutSet(db, fixture.userId, {
          sessionExerciseId: sessionExercise.id,
          setNo: 1,
          weight: 100,
          weightUnit: "lb",
          reps: 8,
          clientKey,
        })
      )
    );
    expect(sets.every((result) => result.outcome === "saved")).toBe(true);
    expect(
      new Set(
        sets.map((result) =>
          result.outcome === "saved" ? result.setId : null
        )
      )
    ).toHaveLength(1);
    expect(
      new Set(
        sets.map((result) =>
          result.outcome === "saved" ? result.occurrenceId : null
        )
      )
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(completedSets)
        .where(eq(completedSets.sessionExerciseId, sessionExercise.id))
    ).toHaveLength(1);

    const completed = await completeWorkoutSession(
      db,
      { id: fixture.userId, coachingPrefs },
      { sessionId }
    );
    if (!completed.progressionJobId) throw new Error("Progression job missing.");

    let evaluations = 0;
    const workers = await Promise.all(
      Array.from({ length: 12 }, () =>
        processProgressionJob(db, completed.progressionJobId!, {
          evaluate: async () => {
            evaluations += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
          },
        })
      )
    );
    expect(workers.filter((result) => result.status === "completed")).toHaveLength(
      1
    );
    expect(evaluations).toBe(1);
    expect(
      await db
        .select()
        .from(progressionJobs)
        .where(eq(progressionJobs.id, completed.progressionJobId))
    ).toEqual([expect.objectContaining({ status: "completed", attempts: 1 })]);
  });

  it("converges same-key Start delivery on one created and replayed session", async () => {
    const fixture = await createProgramFixture("keyed same Start");
    const startRequestKey = crypto.randomUUID();
    const starts = await Promise.all(
      Array.from({ length: 12 }, () =>
        startWorkoutSession(db, fixture.userId, fixture.templateId, 45, {
          startRequestKey,
          timezone: "America/Toronto",
        }),
      ),
    );

    expect(starts.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(starts.filter((result) => result.outcome === "replayed")).toHaveLength(11);
    expect(new Set(starts.map((result) => result.sessionId))).toHaveLength(1);
    expect(await db.select().from(workoutSessions).where(
      eq(workoutSessions.userId, fixture.userId),
    )).toHaveLength(1);
  });

  it("returns conflict for concurrent same-key Start payloads without a second session", async () => {
    const fixture = await createProgramFixture("keyed conflicting Start");
    const startRequestKey = crypto.randomUUID();
    const starts = await Promise.all([
      startWorkoutSession(db, fixture.userId, fixture.templateId, 30, {
        startRequestKey,
        timezone: "America/Toronto",
      }),
      startWorkoutSession(db, fixture.userId, fixture.templateId, 45, {
        startRequestKey,
        timezone: "America/Toronto",
      }),
    ]);

    expect(starts.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(starts.filter((result) => result.outcome === "request_conflict"))
      .toHaveLength(1);
    expect(new Set(starts.map((result) => result.sessionId))).toHaveLength(1);
    expect(await db.select().from(workoutSessions).where(
      eq(workoutSessions.userId, fixture.userId),
    )).toHaveLength(1);
  });

  it("admits one different-key Start and reports the remaining active collision", async () => {
    const fixture = await createProgramFixture("keyed active Start");
    const starts = await Promise.all(
      Array.from({ length: 12 }, () =>
        startWorkoutSession(db, fixture.userId, fixture.templateId, 45, {
          startRequestKey: crypto.randomUUID(),
          timezone: "America/Toronto",
        }),
      ),
    );

    expect(starts.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(
      starts.filter((result) => result.outcome === "active_workout_exists"),
    ).toHaveLength(11);
    expect(new Set(starts.map((result) => result.sessionId))).toHaveLength(1);
    expect(await db.select().from(workoutSessions).where(
      and(
        eq(workoutSessions.userId, fixture.userId),
        eq(workoutSessions.status, "in_progress"),
      ),
    )).toHaveLength(1);
  });

  it("refuses out-of-order planned work while preserving an extra before the plan", async () => {
    const fixture = await createProgramFixture("ordered set writer", { sets: 2 });
    const started = await startWorkoutSession(
      db,
      fixture.userId,
      fixture.templateId,
      45,
    );
    const [sessionExercise] = await db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));

    await expect(logWorkoutSet(db, fixture.userId, {
      sessionExerciseId: sessionExercise.id,
      setNo: 2,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: "native-out-of-order-set-2",
    })).resolves.toEqual({ outcome: "set_order_conflict" });
    const extraOccurrenceId = crypto.randomUUID();
    await expect(appendWorkoutSetOccurrence(db, fixture.userId, {
      sessionExerciseId: sessionExercise.id,
      occurrenceId: extraOccurrenceId,
      expectedSetNo: 3,
    })).resolves.toMatchObject({
      outcome: "appended",
      occurrence: { id: extraOccurrenceId, kindOrdinal: 2 },
    });
    const extra = await logWorkoutSet(db, fixture.userId, {
      sessionExerciseId: sessionExercise.id,
      setNo: 3,
      weight: 105,
      weightUnit: "lb",
      reps: 8,
      clientKey: "native-extra-before-plan",
    });
    expect(extra).toMatchObject({
      outcome: "saved",
      occurrenceId: extraOccurrenceId,
    });

    for (const setNo of [1, 2]) {
      await expect(logWorkoutSet(db, fixture.userId, {
        sessionExerciseId: sessionExercise.id,
        setNo,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        clientKey: `native-ordered-set-${setNo}`,
      })).resolves.toMatchObject({ outcome: "saved" });
    }
    const retry = await logWorkoutSet(db, fixture.userId, {
      sessionExerciseId: sessionExercise.id,
      setNo: 2,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: "native-ordered-set-2",
    });
    expect(retry).toMatchObject({ outcome: "saved" });
    expect(
      await db
        .select()
        .from(completedSets)
        .where(eq(completedSets.sessionExerciseId, sessionExercise.id)),
    ).toHaveLength(3);
    if (extra.outcome !== "saved") throw new Error(extra.outcome);
    await expect(
      db
        .select({ targetMet: completedSets.targetMet })
        .from(completedSets)
        .where(eq(completedSets.id, extra.setId)),
    ).resolves.toEqual([{ targetMet: null }]);
  });

  it("serializes a planned completion with an overlapping extra append", async () => {
    const fixture = await createProgramFixture("parallel plan and extra");
    const started = await startWorkoutSession(
      db,
      fixture.userId,
      fixture.templateId,
      45,
    );
    const [sessionExercise] = await db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const extraOccurrenceId = crypto.randomUUID();
    const [planned, appended] = await Promise.all([
      logWorkoutSet(db, fixture.userId, {
        sessionExerciseId: sessionExercise.id,
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        clientKey: "parallel-planned-set",
      }),
      appendWorkoutSetOccurrence(db, fixture.userId, {
        sessionExerciseId: sessionExercise.id,
        occurrenceId: extraOccurrenceId,
        expectedSetNo: 2,
      }),
    ]);

    expect(planned).toMatchObject({ outcome: "saved" });
    expect(appended).toMatchObject({
      outcome: "appended",
      occurrence: { id: extraOccurrenceId, kindOrdinal: 1 },
    });
    expect(
      await db
        .select({
          origin: sessionOccurrences.origin,
          outcome: sessionOccurrences.outcome,
          kindOrdinal: sessionOccurrences.kindOrdinal,
        })
        .from(sessionOccurrences)
        .where(eq(sessionOccurrences.sessionExerciseId, sessionExercise.id))
        .orderBy(sessionOccurrences.kindOrdinal),
    ).toEqual([
      { origin: "planned", outcome: "completed", kindOrdinal: 0 },
      { origin: "ad_hoc", outcome: "pending", kindOrdinal: 1 },
    ]);
  });

  it("appends at most one next set under parallel distinct requests", async () => {
    const fixture = await createProgramFixture("parallel append set");
    const started = await startWorkoutSession(
      db,
      fixture.userId,
      fixture.templateId,
      45,
    );
    const [sessionExercise] = await db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const before = await db
      .select()
      .from(sessionOccurrences)
      .where(
        and(
          eq(sessionOccurrences.sessionExerciseId, sessionExercise.id),
          eq(sessionOccurrences.kind, "working_set"),
        ),
      );
    const expectedSetNo =
      Math.max(...before.map((occurrence) => occurrence.kindOrdinal)) + 2;
    const occurrenceIds = Array.from({ length: 16 }, () => crypto.randomUUID());
    const results = await Promise.all(
      occurrenceIds.map((occurrenceId) =>
        appendWorkoutSetOccurrence(db, fixture.userId, {
          sessionExerciseId: sessionExercise.id,
          occurrenceId,
          expectedSetNo,
        }),
      ),
    );

    expect(results.filter((result) => result.outcome === "appended")).toHaveLength(1);
    expect(
      results.every(
        (result) => result.outcome === "appended" || result.outcome === "stale",
      ),
    ).toBe(true);
    const after = await db
      .select()
      .from(sessionOccurrences)
      .where(
        and(
          eq(sessionOccurrences.sessionExerciseId, sessionExercise.id),
          eq(sessionOccurrences.kind, "working_set"),
        ),
      );
    expect(after).toHaveLength(before.length + 1);
    expect(
      after.filter(
        (occurrence) =>
          occurrence.kindOrdinal === expectedSetNo - 1 &&
          occurrence.origin === "ad_hoc" &&
          occurrence.outcome === "pending" &&
          occurrence.completedSetId == null,
      ),
    ).toHaveLength(1);
  });

  it("replays one canonical added set under parallel same-identity delivery", async () => {
    const fixture = await createProgramFixture("parallel append replay");
    const started = await startWorkoutSession(
      db,
      fixture.userId,
      fixture.templateId,
      45,
    );
    const [sessionExercise] = await db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const before = await db
      .select()
      .from(sessionOccurrences)
      .where(
        and(
          eq(sessionOccurrences.sessionExerciseId, sessionExercise.id),
          eq(sessionOccurrences.kind, "working_set"),
        ),
      );
    const expectedSetNo =
      Math.max(...before.map((occurrence) => occurrence.kindOrdinal)) + 2;
    await expect(logWorkoutSet(db, fixture.userId, {
      sessionExerciseId: sessionExercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: crypto.randomUUID(),
    })).resolves.toMatchObject({ outcome: "saved" });
    const occurrenceId = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        appendWorkoutSetOccurrence(db, fixture.userId, {
          sessionExerciseId: sessionExercise.id,
          occurrenceId,
          expectedSetNo,
        }),
      ),
    );

    expect(results.filter((result) => result.outcome === "appended")).toHaveLength(1);
    expect(results.every((result) =>
      result.outcome === "appended" || result.outcome === "replayed"
    )).toBe(true);
    expect(new Set(results.map((result) =>
      result.outcome === "appended" || result.outcome === "replayed"
        ? result.occurrence.id
        : null
    ))).toEqual(new Set([occurrenceId]));
  });

  it("replays one canonical workout-only exercise under parallel same-identity delivery", async () => {
    const fixture = await createProgramFixture("parallel add exercise replay");
    const started = await startWorkoutSession(
      db,
      fixture.userId,
      fixture.templateId,
      45,
    );
    const [adHocExercise] = await db
      .insert(exercises)
      .values({
        name: `Parallel Push-Up ${crypto.randomUUID()}`,
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest", "triceps"],
        loadType: "bodyweight",
        metricType: "reps",
        loadSemantics: "bodyweight",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    const mutationId = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        addWorkoutExercise(db, fixture.userId, {
          sessionId: started.sessionId,
          exerciseId: adHocExercise.id,
          mutationId,
          expectedSessionRevision: 0,
          initialSetCount: 2,
          insertion: "end",
        }),
      ),
    );

    expect(results.filter((result) => result.outcome === "added")).toHaveLength(1);
    expect(
      results.every(
        (result) => result.outcome === "added" || result.outcome === "replayed",
      ),
    ).toBe(true);
    const successful = results.filter(
      (
        result,
      ): result is Extract<
        (typeof results)[number],
        { outcome: "added" | "replayed" }
      > => result.outcome === "added" || result.outcome === "replayed",
    );
    expect(
      new Set(successful.map((result) => result.sessionExerciseId)).size,
    ).toBe(1);
    expect(
      new Set(successful.map((result) => result.occurrenceIds.join(","))).size,
    ).toBe(1);
    expect(
      await db
        .select({ id: sessionExercises.id })
        .from(sessionExercises)
        .where(
          and(
            eq(sessionExercises.sessionId, started.sessionId),
            eq(sessionExercises.modificationType, "added"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: sessionOccurrences.id })
        .from(sessionOccurrences)
        .innerJoin(
          sessionExercises,
          eq(sessionExercises.id, sessionOccurrences.sessionExerciseId),
        )
        .where(
          and(
            eq(sessionExercises.sessionId, started.sessionId),
            eq(sessionOccurrences.origin, "ad_hoc"),
          ),
        ),
    ).toHaveLength(2);
  });

  it("keeps session sequence unique when exercise and set additions overlap", async () => {
    const fixture = await createProgramFixture("parallel exercise and set add");
    const started = await startWorkoutSession(
      db,
      fixture.userId,
      fixture.templateId,
      45,
    );
    const [plannedExercise] = await db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, started.sessionId));
    const [adHocExercise] = await db
      .insert(exercises)
      .values({
        name: `Overlapping Push-Up ${crypto.randomUUID()}`,
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest", "triceps"],
        loadType: "bodyweight",
        metricType: "reps",
        loadSemantics: "bodyweight",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
    await expect(logWorkoutSet(db, fixture.userId, {
      sessionExerciseId: plannedExercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: crypto.randomUUID(),
    })).resolves.toMatchObject({ outcome: "saved" });
    const heldSession = await lockWorkoutSession(started.sessionId);
    const append = appendWorkoutSetOccurrence(db, fixture.userId, {
      sessionExerciseId: plannedExercise.id,
      occurrenceId: crypto.randomUUID(),
      expectedSetNo: 2,
    });
    const add = addWorkoutExercise(db, fixture.userId, {
      sessionId: started.sessionId,
      exerciseId: adHocExercise.id,
      mutationId: crypto.randomUUID(),
      expectedSessionRevision: 0,
      initialSetCount: 2,
      insertion: "end",
    });
    await releaseWhenContended(heldSession, [append, add], 2);
    const [appendResult, addResult] = await Promise.all([append, add]);

    expect(["appended", "stale"]).toContain(appendResult.outcome);
    expect(addResult.outcome).toBe("added");
    const occurrences = await db
      .select({
        id: sessionOccurrences.id,
        sequenceIdx: sessionOccurrences.sequenceIdx,
      })
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, started.sessionId));
    expect(new Set(occurrences.map((item) => item.sequenceIdx)).size).toBe(
      occurrences.length,
    );
    expect(occurrences).toHaveLength(
      appendResult.outcome === "appended" ? 4 : 3,
    );
  });

  it("allows one expensive-operation lease under parallel requests", async () => {
    const account = await bootstrapUserAccount(db, {
      email: `parallel-lease-${crypto.randomUUID()}@example.com`,
      name: "Parallel Lease",
    });
    const leases = await Promise.all(
      Array.from({ length: 16 }, () =>
        acquireExpensiveOperation(db, account.id, "backup")
      )
    );
    expect(leases.filter((result) => result.ok)).toHaveLength(1);
  });

  it("serializes parallel autosaves and rejects every stale revision", async () => {
    const fixture = await createProgramFixture("autosave race");
    const state = await getOrCreateProgramDraft(db, fixture.userId);
    if (!state) throw new Error("Program draft fixture missing.");
    const firstDocument = structuredClone(state.draft.document);
    firstDocument.name = "Autosave race first";
    const secondDocument = structuredClone(state.draft.document);
    secondDocument.name = "Autosave race second";

    const [first, second] = await Promise.all([
      saveProgramDraft(db, fixture.userId, {
        draftId: state.draft.id,
        expectedRevision: state.draft.revision,
        mutationId: crypto.randomUUID(),
        document: firstDocument,
      }),
      saveProgramDraft(db, fixture.userId, {
        draftId: state.draft.id,
        expectedRevision: state.draft.revision,
        mutationId: crypto.randomUUID(),
        document: secondDocument,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual(["conflict", "saved"]);
    const stale = await saveProgramDraft(db, fixture.userId, {
      draftId: state.draft.id,
      expectedRevision: state.draft.revision,
      mutationId: crypto.randomUUID(),
      document: firstDocument,
    });
    expect(stale.status).toBe("conflict");
    const [stored] = await db
      .select()
      .from(programDrafts)
      .where(eq(programDrafts.id, state.draft.id));
    expect(stored.revision).toBe(state.draft.revision + 1);
    expect([firstDocument.name, secondDocument.name]).toContain(
      (stored.document as { name: string }).name
    );
  });

  it("publishes and snapshots exactly the plain-text warm-up disclosed by the review", async () => {
    const fixture = await createProgramFixture("warm-up review contract");
    const state = await getOrCreateProgramDraft(db, fixture.userId);
    if (!state) throw new Error("Program draft fixture missing.");
    const document = structuredClone(state.draft.document);
    document.days[0] = updateProgramDayWarmupOverview(
      document.days[0],
      "Two minutes easy\nShoulder circles\nTwo ramp-up sets",
    );

    const saved = await saveProgramDraft(db, fixture.userId, {
      draftId: state.draft.id,
      expectedRevision: state.draft.revision,
      mutationId: crypto.randomUUID(),
      document,
    });
    if (saved.status !== "saved") {
      throw new Error(`Warm-up draft did not save: ${saved.status}`);
    }
    const review = await reviewProgramDraft(
      db,
      fixture.userId,
      state.draft.id,
      saved.revision,
    );
    expect(review).toMatchObject({
      status: "publishable",
      changes: [expect.objectContaining({ kind: "warmup" })],
      summary: {
        weeklySetsBefore: 1,
        weeklySetsAfter: 1,
      },
    });
    if (!review || review.status !== "publishable") {
      throw new Error("Warm-up review missing.");
    }

    const published = await publishProgramDraft(db, fixture.userId, {
      draftId: state.draft.id,
      expectedRevision: saved.revision,
      reviewHash: review.hash,
    });
    if (!published.ok) throw new Error(published.reason);
    const [publishedDay] = await db
      .select({
        id: workoutTemplates.id,
        warmupNotes: workoutTemplates.warmupNotes,
        warmupItems: workoutTemplates.warmupItems,
      })
      .from(workoutTemplates)
      .where(eq(workoutTemplates.programVersionId, published.programVersionId));
    expect(publishedDay).toMatchObject({
      warmupNotes: "Two minutes easy\nShoulder circles\nTwo ramp-up sets",
      warmupItems: [],
    });
    const started = await startWorkoutSession(
      db,
      fixture.userId,
      publishedDay.id,
      45,
    );
    const [startedWorkout] = await db
      .select({
        warmupNotes: workoutSessions.dayWarmupNotes,
        warmupItems: workoutSessions.dayWarmupItems,
      })
      .from(workoutSessions)
      .where(eq(workoutSessions.id, started.sessionId));
    expect(startedWorkout).toMatchObject({
      warmupNotes: "Two minutes easy\nShoulder circles\nTwo ramp-up sets",
      warmupItems: [],
    });
    expect(await db
      .select({ id: sessionOccurrences.id })
      .from(sessionOccurrences)
      .where(and(
        eq(sessionOccurrences.sessionId, started.sessionId),
        eq(sessionOccurrences.kind, "day_warmup"),
      )))
      .toEqual([]);
    const [originalDay] = await db
      .select({
        warmupNotes: workoutTemplates.warmupNotes,
        warmupItems: workoutTemplates.warmupItems,
      })
      .from(workoutTemplates)
      .where(eq(workoutTemplates.programVersionId, fixture.versionId));
    expect(originalDay).toMatchObject({
      warmupNotes: null,
      warmupItems: [],
    });
  });

  it("publishes a reviewed cross-version draft with harmless legacy JSON fields", async () => {
    const fixture = await createProgramFixture("cross-version publication");
    const draft = await prepareReviewedDraft(fixture, "prepared");
    const [stored] = await db
      .select({
        document: programDrafts.document,
        contentHash: programDrafts.contentHash,
      })
      .from(programDrafts)
      .where(eq(programDrafts.id, draft.draftId));

    await db
      .update(programDrafts)
      .set({
        document: {
          ...(stored.document as Record<string, unknown>),
          legacyPreparedDetails: {
            sourceSchemaVersion: 1,
            preparedForEditor: true,
          },
        } as never,
      })
      .where(eq(programDrafts.id, draft.draftId));

    const published = await publishReviewedDraft(draft, fixture.userId);
    expect(published).toMatchObject({
      ok: true,
      versionNo: 2,
    });
    expect(
      await db
        .select({
          status: programDrafts.status,
          contentHash: programDrafts.contentHash,
        })
        .from(programDrafts)
        .where(eq(programDrafts.id, draft.draftId)),
    ).toEqual([
      {
        status: "published",
        contentHash: stored.contentHash,
      },
    ]);
    const currentDocument = await getCurrentProgramDocument(db, fixture.userId);
    expect(currentDocument).toMatchObject({
      schemaVersion: "3",
      name: expect.stringContaining("prepared"),
    });
    expect(currentDocument).not.toHaveProperty("legacyPreparedDetails");
  });

  it("publishes an older unequal group without changing its saved member sets", async () => {
    const fixture = await createProgramFixture("unequal group publication");
    const state = await getOrCreateProgramDraft(db, fixture.userId);
    if (!state) throw new Error("Program draft fixture missing.");
    const document = structuredClone(state.draft.document);
    const day = document.days[0];
    const first = day.exercises[0];
    const groupKey = crypto.randomUUID();
    const secondLineageId = crypto.randomUUID();
    document.name = "Preserved unequal group";
    day.supersets = [{
      key: groupKey,
      name: "Older unequal pair",
      structureStatus: "legacy_unequal",
      plannedRounds: null,
      restBetweenMembersSec: 15,
      restBetweenRoundsSec: 90,
      restAfterRoundSec: 90,
    }];
    day.exercises = [
      {
        ...first,
        supersetKey: groupKey,
        groupMemberOrderIdx: 0,
      },
      {
        ...structuredClone(first),
        lineageId: secondLineageId,
        sets: 4,
        supersetKey: groupKey,
        groupMemberOrderIdx: 1,
        setNotes: [null, null, null, null],
        intent: {
          ...structuredClone(first.intent),
          idealDose: { unit: "sets", value: 4 },
        },
      },
    ];
    const saved = await saveProgramDraft(db, fixture.userId, {
      draftId: state.draft.id,
      expectedRevision: state.draft.revision,
      mutationId: crypto.randomUUID(),
      document,
    });
    if (saved.status !== "saved") {
      throw new Error(`Program draft fixture did not save: ${saved.status}`);
    }
    const review = await reviewProgramDraft(
      db,
      fixture.userId,
      state.draft.id,
      saved.revision,
    );
    expect(review).toMatchObject({
      status: "publishable",
      blockingErrors: [],
    });
    if (!review || review.status !== "publishable") {
      throw new Error("Program draft fixture did not review.");
    }

    expect(await publishProgramDraft(db, fixture.userId, {
      draftId: state.draft.id,
      expectedRevision: saved.revision,
      reviewHash: review.hash,
    })).toMatchObject({
      ok: true,
      versionNo: 2,
    });
    expect(await getCurrentProgramDocument(db, fixture.userId)).toMatchObject({
      schemaVersion: "3",
      name: "Preserved unequal group",
      days: [{
        supersets: [{
          key: groupKey,
          structureStatus: "legacy_unequal",
          plannedRounds: null,
          restBetweenMembersSec: 15,
          restBetweenRoundsSec: 90,
          restAfterRoundSec: 90,
        }],
        exercises: [
          {
            lineageId: first.lineageId,
            sets: first.sets,
            supersetKey: groupKey,
            groupMemberOrderIdx: 0,
          },
          {
            lineageId: secondLineageId,
            sets: 4,
            supersetKey: groupKey,
            groupMemberOrderIdx: 1,
          },
        ],
      }],
    });
  });

  it("converges concurrent stale-base draft opens on one fenced revision", async () => {
    const fixture = await createProgramFixture("stale base reconciliation");
    const versionTwoDraft = await prepareReviewedDraft(fixture, "version two");
    const versionTwo = await publishReviewedDraft(
      versionTwoDraft,
      fixture.userId,
    );
    if (!versionTwo.ok) throw new Error(versionTwo.reason);
    const currentDraft = await getOrCreateProgramDraft(db, fixture.userId);
    if (!currentDraft) throw new Error("Current draft missing");
    const staleDocument = {
      ...structuredClone(currentDraft.draft.document),
      baseVersionId: fixture.versionId,
      name: "Owner edits preserved through reconciliation",
    };
    await db.update(programDrafts).set({
      baseVersionId: fixture.versionId,
      document: staleDocument,
      contentHash: hashProgramDocument(staleDocument),
      reviewedRevision: null,
      reviewHash: null,
      reviewSummary: null,
    }).where(eq(programDrafts.id, currentDraft.draft.id));
    const staleRevision = currentDraft.draft.revision;

    const [first, second] = await Promise.all([
      getOpenProgramDraft(db, fixture.userId),
      getOpenProgramDraft(db, fixture.userId),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.draft.revision).toBe(staleRevision + 1);
    expect(second?.draft.revision).toBe(staleRevision + 1);
    expect(first?.draft.document).toEqual(second?.draft.document);
    expect(first?.draft.document).toMatchObject({
      baseVersionId: versionTwo.programVersionId,
      name: "Owner edits preserved through reconciliation",
    });
    const [stored] = await db
      .select()
      .from(programDrafts)
      .where(eq(programDrafts.id, currentDraft.draft.id));
    expect(stored).toMatchObject({
      baseVersionId: versionTwo.programVersionId,
      revision: staleRevision + 1,
      reviewedRevision: null,
      reviewHash: null,
      reviewSummary: null,
    });
    expect(
      (stored.document as { baseVersionId: string }).baseVersionId,
    ).toBe(versionTwo.programVersionId);
    expect(stored.contentHash).toBe(hashProgramDocument(stored.document));

    expect(await saveProgramDraft(db, fixture.userId, {
      draftId: currentDraft.draft.id,
      expectedRevision: staleRevision,
      mutationId: crypto.randomUUID(),
      document: staleDocument,
    })).toMatchObject({
      status: "conflict",
      serverDraft: { revision: staleRevision + 1 },
    });
  });

  it("publishes one immutable next version under a double publication", async () => {
    const fixture = await createProgramFixture("double publication");
    const draft = await prepareReviewedDraft(fixture, "edited");
    const [first, second] = await Promise.all([
      publishReviewedDraft(draft, fixture.userId),
      publishReviewedDraft(draft, fixture.userId),
    ]);
    const successful = [first, second].filter((result) => result.ok);
    expect(successful.length).toBeGreaterThanOrEqual(1);
    expect(new Set(successful.map((result) => result.ok && result.programVersionId))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(programVersions)
        .where(eq(programVersions.programId, fixture.programId))
    ).toHaveLength(2);
    expect(
      await db.select().from(programDrafts).where(eq(programDrafts.id, draft.draftId))
    ).toEqual([
      expect.objectContaining({
        status: "published",
        publishedVersionId: successful[0].ok
          ? successful[0].programVersionId
          : null,
      }),
    ]);
  });

  it("atomically blocks repeated mild pain across distinct completed workouts", async () => {
    const fixture = await createProgramFixture("pain publication gate");
    const slot = await currentProgramSlot(fixture);
    const recommendation = await insertLoadRecommendation(
      fixture,
      slot,
      100,
      105
    );
    for (const daysAgo of [5, 3, 1]) {
      const startedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      const [session] = await db
        .insert(workoutSessions)
        .values({
          userId: fixture.userId,
          status: "completed",
          startedAt,
          finishedAt: new Date(startedAt.getTime() + 45 * 60_000),
          timezone: "UTC",
          localDate: startedAt.toISOString().slice(0, 10),
        })
        .returning({ id: workoutSessions.id });
      await db.insert(painLogs).values({
        userId: fixture.userId,
        sessionId: session.id,
        exerciseId: fixture.exerciseId,
        bodyPart: "knee",
        severity: daysAgo === 3 ? 2 : 1,
        source: "set_flag",
      });
    }

    await expect(
      publishRecommendationProgramVersion(db, fixture.userId, {
        recommendationId: recommendation.id,
        expectedPayload: recommendation.payload,
        appliedPayload: recommendation.payload,
        decision: "approve",
        expectedReviewRevision: recommendation.reviewRevision,
        expectedDeferRevision: recommendation.deferRevision,
        reviewSnapshot: reviewSnapshotFor(recommendation),
      })
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(
      await db
        .select({ currentVersionId: programs.currentVersionId })
        .from(programs)
        .where(eq(programs.id, fixture.programId))
    ).toEqual([{ currentVersionId: fixture.versionId }]);
  });

  it("reconciles float32 load targets with exact durable outcomes", async () => {
    const fixture = await createProgramFixture("float32 reconciliation");
    const initialSlot = await currentProgramSlot(fixture);
    const satisfied = await insertLoadRecommendation(
      fixture,
      initialSlot,
      100,
      32.3
    );
    const satisfiedDraft = await prepareReviewedLoadDraft(
      fixture,
      32.3,
      "already satisfied"
    );
    const satisfiedPublication = await publishReviewedDraft(
      satisfiedDraft,
      fixture.userId
    );
    if (!satisfiedPublication.ok) throw new Error(satisfiedPublication.reason);
    expect(
      await db
        .select()
        .from(recommendations)
        .where(eq(recommendations.id, satisfied.id))
    ).toEqual([
      expect.objectContaining({
        status: "expired",
        sourceTemplateExerciseId: initialSlot.id,
        reconciledByProgramVersionId: satisfiedPublication.programVersionId,
        reconciliationReason:
          "The new Program version already includes this recommendation.",
      }),
    ]);

    const storedFloatSlot = await currentProgramSlot(fixture);
    expect(storedFloatSlot.id).not.toBe(initialSlot.id);
    expect(
      resultRows<{ targetLoad: string }>(
        await db.execute(sql`SELECT target_load::text AS "targetLoad"
          FROM exercise_prescriptions
          WHERE template_exercise_id = ${storedFloatSlot.id}::uuid
            AND superseded_by_id IS NULL`)
      )
    ).toEqual([{ targetLoad: "32.30" }]);
    expect(
      resultRows<{ count: number }>(
        await db.execute(sql`SELECT count(*)::int AS count
          FROM information_schema.columns column_info
          JOIN (VALUES
            ('barbell_configs', 'bar_weight'),
            ('barbell_configs', 'collar_weight'),
            ('plate_inventory', 'denomination'),
            ('exercise_equipment_requirements', 'min_weight'),
            ('exercise_prescriptions', 'target_load'),
            ('session_exercises', 'target_load')
          ) expected(table_name, column_name)
            ON expected.table_name = column_info.table_name
           AND expected.column_name = column_info.column_name
          WHERE column_info.table_schema = current_schema()
            AND column_info.data_type = 'numeric'
            AND column_info.numeric_precision = 7
            AND column_info.numeric_scale = 2`)
      )
    ).toEqual([{ count: 6 }]);
    const carry = await insertLoadRecommendation(
      fixture,
      storedFloatSlot,
      32.3,
      35
    );
    const carryDraft = await prepareReviewedLoadDraft(
      fixture,
      32.3,
      "carry stored float"
    );
    const carryPublication = await publishReviewedDraft(
      carryDraft,
      fixture.userId
    );
    if (!carryPublication.ok) throw new Error(carryPublication.reason);
    const carriedSlot = await currentProgramSlot(fixture);
    expect(carriedSlot.id).not.toBe(storedFloatSlot.id);
    expect(
      await db
        .select()
        .from(recommendations)
        .where(eq(recommendations.id, carry.id))
    ).toEqual([
      expect.objectContaining({
        status: "pending",
        sourceTemplateExerciseId: carriedSlot.id,
        sourceSlotLineageId: storedFloatSlot.lineageId,
        payload: expect.objectContaining({ templateExerciseId: carriedSlot.id }),
        reconciledByProgramVersionId: carryPublication.programVersionId,
        reconciliationReason:
          "Carried forward to the matching exercise in the new Program version.",
      }),
    ]);

    const superseded = await insertLoadRecommendation(
      fixture,
      carriedSlot,
      32.3,
      40
    );
    const supersededDraft = await prepareReviewedLoadDraft(
      fixture,
      32.31,
      "outside epsilon"
    );
    const supersededPublication = await publishReviewedDraft(
      supersededDraft,
      fixture.userId
    );
    if (!supersededPublication.ok) throw new Error(supersededPublication.reason);
    expect(
      await db
        .select()
        .from(recommendations)
        .where(eq(recommendations.id, superseded.id))
    ).toEqual([
      expect.objectContaining({
        status: "expired",
        sourceTemplateExerciseId: carriedSlot.id,
        reconciledByProgramVersionId: supersededPublication.programVersionId,
        reconciliationReason:
          "The edited Program changed the same target, so the older recommendation expired.",
      }),
    ]);
  });

  it("serializes publication against pending recommendation insertion", async () => {
    const fixture = await createProgramFixture("recommendation publication race");
    const draft = await prepareReviewedDraft(fixture, "edited");
    const programLock = await lockProgram(fixture.programId);
    const publication = publishReviewedDraft(draft, fixture.userId);
    const payload = {
      kind: "load_change" as const,
      templateExerciseId: fixture.slotId,
      fromLoad: 100,
      toLoad: 105,
      loadUnit: "lb" as const,
    };
    const insertion = db
      .insert(recommendations)
      .values({
        userId: fixture.userId,
        source: "rule",
        status: "pending",
        sourceTemplateExerciseId: fixture.slotId,
        sourceSlotLineageId: fixture.slotLineageId,
        exerciseId: fixture.exerciseId,
        payload,
        reason: "Parallel recommendation",
        evidence: { signals: {} },
      })
      .returning({ id: recommendations.id })
      .execute();
    await releaseWhenContended(programLock, [publication, insertion], 2);
    const [published, inserted] = await Promise.allSettled([publication, insertion]);

    const current = await db.query.programs.findFirst({
      where: eq(programs.id, fixture.programId),
    });
    if (!current?.currentVersionId) throw new Error("Current Program missing.");
    const pending = await db
      .select({
        id: recommendations.id,
        programVersionId: workoutTemplates.programVersionId,
      })
      .from(recommendations)
      .leftJoin(
        workoutTemplateExercises,
        eq(
          workoutTemplateExercises.id,
          recommendations.sourceTemplateExerciseId
        )
      )
      .leftJoin(
        workoutTemplates,
        eq(workoutTemplates.id, workoutTemplateExercises.workoutTemplateId)
      )
      .where(
        and(
          eq(recommendations.userId, fixture.userId),
          eq(recommendations.status, "pending")
        )
      );
    expect(pending.every((recommendation) =>
      recommendation.programVersionId === current.currentVersionId
    )).toBe(true);
    if (published.status === "fulfilled" && published.value.ok) {
      expect(current.currentVersionId).toBe(published.value.programVersionId);
      expect(inserted.status).toBe("rejected");
      expect(pending).toHaveLength(0);
    } else {
      expect(current.currentVersionId).toBe(fixture.versionId);
      expect(inserted.status).toBe("fulfilled");
      expect(pending).toHaveLength(1);
      expect(current.recommendationRevision).toBe(1);
    }
  });

  it("allows either restore or publication to win, but never both", async () => {
    const fixture = await createProgramFixture("restore publication race");
    const firstDraft = await prepareReviewedDraft(fixture, "version two");
    const versionTwo = await publishReviewedDraft(firstDraft, fixture.userId);
    if (!versionTwo.ok) throw new Error(versionTwo.reason);
    const current = await db.query.programs.findFirst({
      where: eq(programs.id, fixture.programId),
    });
    if (!current) throw new Error("Current Program missing.");
    const competingDraft = await prepareReviewedDraft(
      { ...fixture, versionId: versionTwo.programVersionId },
      "version three"
    );
    const programLock = await lockProgram(fixture.programId);
    const publication = publishReviewedDraft(competingDraft, fixture.userId);
    const restore = createRestoreProgramDraft(db, fixture.userId, fixture.versionId, {
      currentDraftId: competingDraft.draftId,
      expectedRevision: competingDraft.revision,
      mutationId: crypto.randomUUID(),
    });
    await releaseWhenContended(programLock, [publication, restore], 2);
    const [published, restored] = await Promise.all([publication, restore]);
    const versions = await db
      .select()
      .from(programVersions)
      .where(eq(programVersions.programId, fixture.programId));
    if (published.ok) {
      expect(restored.status).toBe("conflict");
      expect(versions).toHaveLength(3);
    } else {
      expect(restored.status).toBe("created");
      expect(versions).toHaveLength(2);
      const [openDraft] = await db
        .select()
        .from(programDrafts)
        .where(and(
          eq(programDrafts.programId, fixture.programId),
          eq(programDrafts.status, "open")
        ));
      expect(openDraft).toMatchObject({
        restoredFromVersionId: fixture.versionId,
        baseVersionId: versionTwo.programVersionId,
      });
    }
  });

  it("rejects a template that becomes stale while its start request is paused", async () => {
    const fixture = await createProgramFixture("stale template race");
    const draft = await prepareReviewedDraft(fixture, "new current version");
    let releaseStart!: () => void;
    let startReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      startReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const starting = startWorkoutSession(
      db,
      fixture.userId,
      fixture.templateId,
      undefined,
      {
        checkpoint: async (boundary) => {
          if (boundary !== "before-start-statement") return;
          startReached();
          await release;
        },
      }
    );
    await reached;
    const published = await publishReviewedDraft(draft, fixture.userId);
    expect(published.ok).toBe(true);
    releaseStart();
    await expect(starting).rejects.toBeInstanceOf(StaleWorkoutTemplateError);
    expect(
      await db
        .select()
        .from(workoutSessions)
        .where(eq(workoutSessions.userId, fixture.userId))
    ).toHaveLength(0);
  });

  it("converges two concurrent Live Coach retries on one response", async () => {
    const fixture = await createProgramFixture("live coach retry race");
    const { sessionId } = await startWorkoutSession(
      db,
      fixture.userId,
      fixture.templateId
    );
    const started = await startLiveCoachTurn(db, fixture.userId, {
      sessionId,
      sessionExerciseId: null,
      completedSetId: null,
      messageKind: "question",
      inputMode: "text",
      content: "Should I adjust the next set?",
      clientKey: crypto.randomUUID(),
    });
    if (!started.pendingResponse) throw new Error("Pending response missing.");
    await markLiveCoachResponseFailed(
      db,
      fixture.userId,
      started.pendingResponse.id,
      "Injected failure for retry convergence."
    );
    const before = await db
      .select({ id: coachingInsights.id })
      .from(coachingInsights)
      .where(eq(coachingInsights.replyToId, started.userMessage.id));
    const ready = createStartBarrier(2);
    const results = await Promise.all(
      Array.from({ length: 2 }, async () => {
        await ready();
        return createLiveCoachRetry(
          db,
          fixture.userId,
          started.userMessage.id
        );
      })
    );
    const after = await db
      .select({ id: coachingInsights.id })
      .from(coachingInsights)
      .where(eq(coachingInsights.replyToId, started.userMessage.id));

    expect(new Set(results.map((response) => response.id))).toHaveLength(1);
    expect(results.every((response) => response.responseStatus === "pending")).toBe(
      true
    );
    expect(after).toHaveLength(before.length + 1);
  });

  it("serializes progression recommendation insertion against publication", async () => {
    const fixture = await createProgramFixture(
      "progression publication race",
      { comparableBarbell: true },
    );
    const progressionJobId = await createProgressionJob(fixture);
    const draft = await prepareReviewedDraft(fixture, "edited during progression");
    const programLock = await lockProgram(fixture.programId);
    let releaseEvaluation!: () => void;
    let evaluationReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      evaluationReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseEvaluation = resolve;
    });
    const progression = processProgressionJob(db, progressionJobId, {
      evaluate: async (...args) => {
        evaluationReached();
        await release;
        return evaluateSessionProgression(...args);
      },
    });
    await reached;
    const publication = publishReviewedDraft(draft, fixture.userId);
    releaseEvaluation();
    await releaseWhenContended(programLock, [progression, publication], 2);
    const [progressed, published] = await Promise.all([progression, publication]);
    let finalProgressionStatus = progressed.status;
    if (progressed.status === "failed") {
      const [retryableJob] = await db
        .select()
        .from(progressionJobs)
        .where(eq(progressionJobs.id, progressionJobId));
      if (!retryableJob) throw new Error("Retryable progression job missing.");
      expect(retryableJob).toMatchObject({
        status: "pending",
        attempts: 1,
        leaseToken: null,
        leasedUntil: null,
        completedAt: null,
      });
      const retry = await processProgressionJob(db, progressionJobId, {
        now: () => new Date(retryableJob.nextAttemptAt.getTime() + 1),
      });
      finalProgressionStatus = retry.status;
    }

    const current = await db.query.programs.findFirst({
      where: eq(programs.id, fixture.programId),
    });
    if (!current?.currentVersionId) throw new Error("Current Program missing.");
    const pending = await db
      .select({
        id: recommendations.id,
        programVersionId: workoutTemplates.programVersionId,
      })
      .from(recommendations)
      .leftJoin(
        workoutTemplateExercises,
        eq(
          workoutTemplateExercises.id,
          recommendations.sourceTemplateExerciseId
        )
      )
      .leftJoin(
        workoutTemplates,
        eq(workoutTemplates.id, workoutTemplateExercises.workoutTemplateId)
      )
      .where(
        and(
          eq(recommendations.userId, fixture.userId),
          eq(recommendations.status, "pending")
        )
      );
    expect(pending.every((recommendation) =>
      recommendation.programVersionId === current.currentVersionId
    )).toBe(true);
    expect(pending).toHaveLength(1);
    expect(current.recommendationRevision).toBe(1);
    if (published.ok) {
      expect(current.currentVersionId).toBe(published.programVersionId);
    } else {
      expect(current.currentVersionId).toBe(fixture.versionId);
    }
    expect(finalProgressionStatus).toBe("completed");
  });

  it("rolls back evaluated recommendations when another worker takes an expired lease", async () => {
    const fixture = await createProgramFixture(
      "progression lease loss race",
      { comparableBarbell: true },
    );
    const progressionJobId = await createProgressionJob(fixture);
    const firstNow = new Date("2030-01-01T00:00:00.000Z");
    let releaseEvaluation!: () => void;
    let evaluationReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      evaluationReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseEvaluation = resolve;
    });
    const firstWorker = processProgressionJob(db, progressionJobId, {
      now: () => firstNow,
      leaseSeconds: 1,
      evaluate: async (...args) => {
        evaluationReached();
        await release;
        return evaluateSessionProgression(...args);
      },
    });
    await reached;

    const replacementLease = await claimProgressionJob(
      db,
      progressionJobId,
      {
        now: () => new Date("2030-01-01T00:00:02.000Z"),
        leaseSeconds: 1,
      },
    );
    expect(replacementLease).not.toBeNull();
    releaseEvaluation();

    await expect(firstWorker).resolves.toMatchObject({ status: "lease_lost" });
    expect(
      await db
        .select()
        .from(recommendations)
        .where(eq(recommendations.progressionJobId, progressionJobId)),
    ).toHaveLength(0);
    expect(
      await db.query.progressionJobs.findFirst({
        where: eq(progressionJobs.id, progressionJobId),
      }),
    ).toMatchObject({
      status: "processing",
      leaseToken: replacementLease?.leaseToken,
      completedAt: null,
    });

    await expect(
      processProgressionJob(db, progressionJobId, {
        now: () => new Date("2030-01-01T00:00:04.000Z"),
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(
      await db
        .select()
        .from(recommendations)
        .where(eq(recommendations.progressionJobId, progressionJobId)),
    ).toHaveLength(1);
  });

  it("refuses a captured job after a non-source input session is corrected", async () => {
    const fixture = await createProgramFixture("progression correction race");
    const inputJobId = await createProgressionJob(fixture);
    const [inputJob] = await db
      .select()
      .from(progressionJobs)
      .where(eq(progressionJobs.id, inputJobId));
    const progressionJobId = await createProgressionJob(fixture);
    const [set] = await db
      .select({
        id: completedSets.id,
        weight: completedSets.weight,
        weightUnit: completedSets.weightUnit,
        reps: completedSets.reps,
        rpe: completedSets.rpe,
        note: completedSets.note,
      })
      .from(completedSets)
      .innerJoin(
        sessionExercises,
        eq(sessionExercises.id, completedSets.sessionExerciseId),
      )
      .where(eq(sessionExercises.sessionId, inputJob.sessionId));
    let releaseClaim!: () => void;
    let claimReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      claimReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const progression = processProgressionJob(db, progressionJobId, {
      afterClaim: async () => {
        claimReached();
        await release;
      },
    });
    await reached;
    const correction = await updateSetWithVersion(
      db,
      fixture.userId,
      set.id,
      {
        weight: set.weight,
        weightUnit: set.weightUnit,
        reps: (set.reps ?? 0) + 1,
        distanceKm: null,
        durationSeconds: null,
        rpe: set.rpe,
        note: set.note,
      },
      "set.completed_correction",
      {
        expected: {
          weight: set.weight,
          weightUnit: set.weightUnit,
          reps: set.reps,
          distanceKm: null,
          durationSeconds: null,
          rpe: set.rpe,
          note: set.note,
        },
        expectedHistoryRevision: 0,
        clientMutationId: crypto.randomUUID(),
        correctionEvidence: {
          category: "measurement_entry",
          reasonNote: null,
          source: "workout_history",
        },
      },
    );
    releaseClaim();

    expect(correction).toMatchObject({ ok: true, changed: true });
    await expect(progression).resolves.toMatchObject({ status: "stale" });
    expect(
      await db.query.workoutSessions.findFirst({
        where: eq(workoutSessions.id, inputJob.sessionId),
      }),
    ).toMatchObject({ historyRevision: 1 });
    expect(
      await db
        .select()
        .from(progressionJobs)
        .where(eq(progressionJobs.userId, fixture.userId)),
    ).toHaveLength(3);
    expect(
      await db
        .select()
        .from(recommendations)
        .where(and(
          eq(recommendations.userId, fixture.userId),
          eq(recommendations.status, "pending"),
        )),
    ).toHaveLength(0);
  });

  it("refuses a captured job after a new workout joins its input membership", async () => {
    const fixture = await createProgramFixture("progression membership race");
    const progressionJobId = await createProgressionJob(fixture);
    const next = await startWorkoutSession(
      db,
      fixture.userId,
      fixture.templateId,
    );
    const [exercise] = await db
      .select({ id: sessionExercises.id })
      .from(sessionExercises)
      .where(eq(sessionExercises.sessionId, next.sessionId));
    const saved = await logWorkoutSet(db, fixture.userId, {
      sessionExerciseId: exercise.id,
      setNo: 1,
      weight: 100,
      weightUnit: "lb",
      reps: 8,
      clientKey: crypto.randomUUID(),
    });
    expect(saved.outcome).toBe("saved");

    let releaseClaim!: () => void;
    let claimReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      claimReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const progression = processProgressionJob(db, progressionJobId, {
      afterClaim: async () => {
        claimReached();
        await release;
      },
    });
    await reached;
    const completion = await completeWorkoutSession(
      db,
      { id: fixture.userId, coachingPrefs },
      { sessionId: next.sessionId },
    );
    releaseClaim();

    await expect(progression).resolves.toMatchObject({ status: "stale" });
    expect(completion).toMatchObject({
      alreadyFinished: false,
      sessionId: next.sessionId,
    });
    expect(
      await db
        .select()
        .from(progressionJobs)
        .where(eq(progressionJobs.userId, fixture.userId)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(recommendations)
        .where(and(
          eq(recommendations.userId, fixture.userId),
          eq(recommendations.status, "pending"),
        )),
    ).toHaveLength(0);
  });

  it("converges concurrent retrospective retries on one complete workout graph", async () => {
    const fixture = await createProgramFixture("retrospective retry race");
    const [day] = await db
      .select({ lineageId: workoutTemplates.lineageId })
      .from(workoutTemplates)
      .where(eq(workoutTemplates.id, fixture.templateId));
    const [{ id: performedExerciseId }] = await db
      .insert(exercises)
      .values({
        name: `retrospective performed substitution ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "external",
        metricType: "weight_reps",
        loadSemantics: "total",
      })
      .returning({ id: exercises.id });
    const identity = {
      requestId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      progressionJobId: crypto.randomUUID(),
      sessionExerciseId: crypto.randomUUID(),
      occurrenceId: crypto.randomUUID(),
      setId: crypto.randomUUID(),
      clientKey: crypto.randomUUID(),
    };
    const reviewed = {
      requestId: identity.requestId,
      sessionId: identity.sessionId,
      progressionJobId: identity.progressionJobId,
      localDate: "2026-07-20",
      timezone: "America/Toronto",
      timing: {
        precision: "instant" as const,
        startedAtISO: "2026-07-20T13:00:00.000Z",
        finishedAtISO: "2026-07-20T14:00:00.000Z",
      },
      link: {
        kind: "program_day" as const,
        programId: fixture.programId,
        programVersionId: fixture.versionId,
        templateId: fixture.templateId,
        dayLineageId: day.lineageId,
      },
      exercises: [{
        id: identity.sessionExerciseId,
        exerciseId: performedExerciseId,
        sourceTemplateExerciseId: fixture.slotId,
        substitutionReason: "other" as const,
        outcomes: [
          {
            occurrenceId: identity.occurrenceId,
            ordinal: 0,
            outcome: "completed" as const,
            completedSet: {
              id: identity.setId,
              clientKey: identity.clientKey,
              setNo: 1,
              weight: 100,
              weightUnit: "lb" as const,
              reps: 8,
            },
          },
          {
            occurrenceId: crypto.randomUUID(),
            ordinal: 1,
            outcome: "completed" as const,
            completedSet: {
              id: crypto.randomUUID(),
              clientKey: crypto.randomUUID(),
              setNo: 2,
              weight: 100,
              weightUnit: "lb" as const,
              reps: 7,
            },
          },
        ],
      }],
    };

    const results = await Promise.all([
      createRetrospectiveWorkout(db, fixture.userId, reviewed, {
        now: () => new Date("2026-07-26T16:00:00.000Z"),
      }),
      createRetrospectiveWorkout(db, fixture.userId, reviewed, {
        now: () => new Date("2026-07-26T16:00:00.000Z"),
      }),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        {
          ok: true,
          outcome: "created",
          sessionId: identity.sessionId,
        },
        {
          ok: true,
          outcome: "replayed",
          sessionId: identity.sessionId,
        },
      ]),
    );
    expect(
      await db
        .select()
        .from(workoutSessions)
        .where(eq(workoutSessions.id, identity.sessionId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(sessionExercises)
        .where(eq(sessionExercises.sessionId, identity.sessionId)),
    ).toEqual([
      expect.objectContaining({
        exerciseId: performedExerciseId,
        modificationType: "substituted",
        substitutedForExerciseId: fixture.exerciseId,
        substitutionReason: "other",
      }),
    ]);
    const occurrences = await db
        .select()
        .from(sessionOccurrences)
        .where(eq(sessionOccurrences.sessionId, identity.sessionId))
        .orderBy(sessionOccurrences.kindOrdinal);
    expect(occurrences).toEqual([
      expect.objectContaining({
        origin: "planned",
        plannedExerciseId: fixture.exerciseId,
      }),
      expect.objectContaining({
        origin: "ad_hoc",
        plannedExerciseId: performedExerciseId,
        plannedNote: "Added during this workout",
      }),
    ]);
    expect(
      await db
        .select()
        .from(completedSets)
        .innerJoin(
          sessionExercises,
          eq(completedSets.sessionExerciseId, sessionExercises.id),
        )
        .where(eq(sessionExercises.sessionId, identity.sessionId)),
    ).toHaveLength(2);
  });

  it("admits only one concurrent unconfirmed same-day retrospective workout", async () => {
    const fixture = await createProgramFixture("retrospective duplicate race");
    const reviewed = () => {
      const requestId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      return {
        requestId,
        sessionId,
        progressionJobId: crypto.randomUUID(),
        localDate: "2026-07-19",
        timezone: "America/Toronto",
        timing: {
          precision: "instant" as const,
          startedAtISO: "2026-07-19T13:00:00.000Z",
          finishedAtISO: "2026-07-19T14:00:00.000Z",
        },
        link: { kind: "unlinked" as const },
        exercises: [{
          id: crypto.randomUUID(),
          exerciseId: fixture.exerciseId,
          sourceTemplateExerciseId: null,
          outcomes: [{
            occurrenceId: crypto.randomUUID(),
            ordinal: 0,
            outcome: "completed" as const,
            completedSet: {
              id: crypto.randomUUID(),
              clientKey: crypto.randomUUID(),
              setNo: 1,
              weight: 100,
              weightUnit: "lb" as const,
              reps: 8,
            },
          }],
        }],
      };
    };
    const first = reviewed();
    const second = reviewed();
    const results = await Promise.all([
      createRetrospectiveWorkout(db, fixture.userId, first, {
        now: () => new Date("2026-07-26T16:00:00.000Z"),
      }),
      createRetrospectiveWorkout(db, fixture.userId, second, {
        now: () => new Date("2026-07-26T16:00:00.000Z"),
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true, outcome: "created" }),
        expect.objectContaining({
          ok: false,
          code: "duplicate_warning_required",
        }),
      ]),
    );
    expect(
      await db
        .select()
        .from(workoutSessions)
        .where(and(
          eq(workoutSessions.userId, fixture.userId),
          eq(workoutSessions.source, "history_manual"),
          eq(workoutSessions.localDate, "2026-07-19"),
        )),
    ).toHaveLength(1);
  });

  it("refuses Program linkage that becomes stale while creation waits", async () => {
    const fixture = await createProgramFixture("retrospective stale Program race");
    const [day] = await db
      .select({ lineageId: workoutTemplates.lineageId })
      .from(workoutTemplates)
      .where(eq(workoutTemplates.id, fixture.templateId));
    const requestId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const reviewed = {
      requestId,
      sessionId,
      progressionJobId: crypto.randomUUID(),
      localDate: "2026-07-18",
      timezone: "America/Toronto",
      timing: {
        precision: "instant" as const,
        startedAtISO: "2026-07-18T13:00:00.000Z",
        finishedAtISO: "2026-07-18T14:00:00.000Z",
      },
      link: {
        kind: "program_day" as const,
        programId: fixture.programId,
        programVersionId: fixture.versionId,
        templateId: fixture.templateId,
        dayLineageId: day.lineageId,
      },
      exercises: [{
        id: crypto.randomUUID(),
        exerciseId: fixture.exerciseId,
        sourceTemplateExerciseId: fixture.slotId,
        outcomes: [{
          occurrenceId: crypto.randomUUID(),
          ordinal: 0,
          outcome: "completed" as const,
          completedSet: {
            id: crypto.randomUUID(),
            clientKey: crypto.randomUUID(),
            setNo: 1,
            weight: 100,
            weightUnit: "lb" as const,
            reps: 8,
          },
        }],
      }],
      recordAnotherWorkout: true,
    };

    const programLock = await lockProgram(fixture.programId);
    await programLock.client.query(
      `UPDATE programs
       SET status = 'archived', archived_at = statement_timestamp(),
           current_version_id = NULL
       WHERE id = $1`,
      [fixture.programId],
    );
    const creation = createRetrospectiveWorkout(
      db,
      fixture.userId,
      reviewed,
      { now: () => new Date("2026-07-26T16:00:00.000Z") },
    );
    await releaseWhenContended(programLock, [creation], 1);
    expect(await creation).toMatchObject({
      ok: false,
      code: "stale_program",
    });
    expect(
      await db
        .select()
        .from(workoutSessions)
        .where(eq(workoutSessions.id, sessionId)),
    ).toHaveLength(0);
  });

  it("serializes external Review defer and sibling rejection without self-staling", async () => {
    const fixture = await createExternalReviewFixture("external Review lifecycle race");
    const ready = createStartBarrier(2);
    const [deferred, rejected] = await Promise.all([
      deferRecommendationDecision(
        db,
        fixture.userId,
        {
          recommendationId: fixture.recommendations[0]!.id,
          expectedReviewRevision: 1,
          expectedDeferRevision: 0,
          reason: "Concurrent defer",
        },
        {
          checkpoint: async (boundary) => {
            if (boundary === "recommendation-defer-ready") await ready();
          },
        },
      ),
      rejectRecommendationDecision(
        db,
        fixture.userId,
        {
          recommendationId: fixture.recommendations[1]!.id,
          expectedReviewRevision: 1,
          expectedDeferRevision: 0,
          reason: "Concurrent rejection",
        },
        {
          checkpoint: async (boundary) => {
            if (boundary === "recommendation-ready") await ready();
          },
        },
      ),
    ]);
    expect(deferred).toEqual({ ok: true });
    expect(rejected).toEqual({ ok: true });
    const cursor = await externalReviewCursor(fixture.userId, fixture.receiptId);
    expect(cursor.receiptRevision).toBe(cursor.ownerRevision);
    const currentDeferred = await db.query.recommendations.findFirst({
      where: eq(recommendations.id, fixture.recommendations[0]!.id),
    });
    expect(await resolveReviewEvidence(
      db,
      fixture.userId,
      currentDeferred!,
    )).toMatchObject({ state: "external", actionable: true });
  }, 60_000);

  it("serializes concurrent sibling external approvals on the receipt cursor", async () => {
    const fixture = await createExternalReviewFixture("external Review approval race");
    const ready = createStartBarrier(2);
    const results = await Promise.all(
      fixture.recommendations.map((recommendation) =>
        approveRecommendationDecision(
          db,
          fixture.userId,
          {
            recommendationId: recommendation.id,
            expectedReviewRevision: 1,
            expectedDeferRevision: 0,
          },
          {
            checkpoint: async (boundary) => {
              if (boundary === "recommendation-ready") await ready();
            },
          },
        ),
      ),
    );
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    const cursor = await externalReviewCursor(fixture.userId, fixture.receiptId);
    expect(cursor.receiptRevision).toBe(cursor.ownerRevision);
    expect(
      await db
        .select()
        .from(recommendations)
        .where(eq(recommendations.insightId, fixture.receiptId)),
    ).toEqual([
      expect.objectContaining({ status: "approved" }),
      expect.objectContaining({ status: "approved" }),
    ]);
  }, 60_000);

  it("never rebases unrelated evidence racing an external approval", async () => {
    const fixture = await createExternalReviewFixture("external Review unrelated evidence race");
    const ready = createStartBarrier(2);
    const [approval] = await Promise.all([
      approveRecommendationDecision(
        db,
        fixture.userId,
        {
          recommendationId: fixture.recommendations[0]!.id,
          expectedReviewRevision: 1,
          expectedDeferRevision: 0,
        },
        {
          checkpoint: async (boundary) => {
            if (boundary === "recommendation-ready") await ready();
          },
        },
      ),
      (async () => {
        await ready();
        await db.insert(schema.constraints).values({
          userId: fixture.userId,
          bodyPart: "synthetic shoulder",
          affectedPatterns: ["horizontal_push"],
          note: "Concurrent unrelated safety evidence",
        });
      })(),
    ]);

    const cursor = await externalReviewCursor(fixture.userId, fixture.receiptId);
    expect(cursor.receiptRevision).not.toBe(cursor.ownerRevision);
    const currentRecommendations = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.insightId, fixture.receiptId));
    for (const recommendation of currentRecommendations) {
      expect(await resolveReviewEvidence(
        db,
        fixture.userId,
        recommendation,
      )).toMatchObject({ state: "stale", actionable: false });
    }
    if (!approval.ok) {
      expect(currentRecommendations[0]).toMatchObject({ status: "pending" });
      const [{ decisions, adaptations }] = resultRows<{
        decisions: number;
        adaptations: number;
      }>(await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM user_decisions decision
           JOIN recommendations recommendation ON recommendation.id = decision.recommendation_id
           WHERE recommendation.insight_id = ${fixture.receiptId}::uuid) AS decisions,
          (SELECT count(*)::int FROM adaptation_events adaptation
           JOIN recommendations recommendation ON recommendation.id = adaptation.recommendation_id
           WHERE recommendation.insight_id = ${fixture.receiptId}::uuid) AS adaptations
      `));
      expect(decisions).toBe(0);
      expect(adaptations).toBe(0);
    }
  }, 60_000);
});
