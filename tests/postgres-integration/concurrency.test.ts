import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { resultRows } from "@/db/result";
import { updateProgramDayWarmupOverview } from "@/lib/program-editor-client";
import {
  barbellConfigs,
  completedSets,
  coachingInsights,
  equipmentItems,
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
import { activateProgramAtomically } from "@/services/program-activation";
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
import { updateSetWithVersion } from "@/services/record-versions";
import {
  createLiveCoachRetry,
  markLiveCoachResponseFailed,
  startLiveCoachTurn,
} from "@/services/live-coaching";
import {
  addWorkoutExercise,
  appendWorkoutSetOccurrence,
  completeWorkoutSession,
  mutateWorkoutOccurrence,
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
import { externalAnalysisResponseSchema } from "@/lib/external-analysis-response";
import { logWorkoutSet } from "../helpers/log-workout-set";
import { createRetrospectiveWorkout } from "@/services/retrospective-workouts";
import { getHistoryReport } from "@/services/history-report";
import { getCurrentProgramDocument } from "@/services/program-documents";
import { createStartBarrier } from "../helpers/database";
import { createTotalSystemTestSnapshot } from "../helpers/set-semantics";
import { mutateSessionEquipmentSelection } from "@/services/session-equipment-selection";
import validExternalAnalysisFixture from "../fixtures/v2/a03-typed-response.json";
import {
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
} from "@/lib/program-document";
import {
  adjustScheduledProgramEvent,
  publishProgramSchedule,
} from "@/services/program-schedules";
import { switchActiveProgram } from "@/services/program-library";

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

type EquipmentRaceFixture = ProgramFixture & {
  sessionId: string;
  sessionExerciseId: string;
  occurrenceId: string;
  occurrenceRevision: number;
  primarySnapshotId: string;
  replacementItemId: string;
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

async function createEquipmentRaceFixture(
  label: string,
): Promise<EquipmentRaceFixture> {
  const fixture = await createProgramFixture(label, { comparableBarbell: true });
  const [primaryItem, replacementItem] = await db
    .insert(equipmentItems)
    .values([
      {
        userId: fixture.userId,
        type: "barbell",
        label: `${label} primary bar`,
      },
      {
        userId: fixture.userId,
        type: "barbell",
        label: `${label} replacement bar`,
      },
    ])
    .returning({ id: equipmentItems.id });
  if (!primaryItem || !replacementItem) {
    throw new Error("Equipment race fixture inventory missing.");
  }
  await db.insert(barbellConfigs).values([
    {
      userId: fixture.userId,
      equipmentItemId: primaryItem.id,
      barType: "olympic",
      unit: "lb",
      loadingKind: "olympic",
      sharedPlatePoolCompatible: true,
      barWeight: 45,
      collarWeight: 0,
      label: `${label} primary bar`,
    },
    {
      userId: fixture.userId,
      equipmentItemId: replacementItem.id,
      barType: "olympic",
      unit: "lb",
      loadingKind: "olympic",
      sharedPlatePoolCompatible: true,
      barWeight: 35,
      collarWeight: 0,
      label: `${label} replacement bar`,
    },
  ]);

  const started = await startWorkoutSession(
    db,
    fixture.userId,
    fixture.templateId,
  );
  const [sessionExercise] = await db
    .select({ id: sessionExercises.id })
    .from(sessionExercises)
    .where(eq(sessionExercises.sessionId, started.sessionId));
  if (!sessionExercise) throw new Error("Equipment race session exercise missing.");
  const [occurrence] = await db
    .select({
      id: sessionOccurrences.id,
      revision: sessionOccurrences.revision,
    })
    .from(sessionOccurrences)
    .where(eq(sessionOccurrences.sessionExerciseId, sessionExercise.id));
  if (!occurrence) throw new Error("Equipment race occurrence missing.");

  const selected = await mutateSessionEquipmentSelection(db, fixture.userId, {
    operation: "select",
    sessionExerciseId: sessionExercise.id,
    equipmentItemId: primaryItem.id,
    attachmentItemId: null,
    expectedCurrentSnapshotId: null,
    clientKey: crypto.randomUUID(),
    provenance: "user_selected",
  });
  if (
    selected.outcome !== "applied" ||
    selected.snapshotId == null ||
    selected.occurrenceStates.length !== 1
  ) {
    throw new Error(`Initial equipment selection failed: ${selected.outcome}.`);
  }

  return {
    ...fixture,
    sessionId: started.sessionId,
    sessionExerciseId: sessionExercise.id,
    occurrenceId: occurrence.id,
    occurrenceRevision: selected.occurrenceStates[0]!.revision,
    primarySnapshotId: selected.snapshotId,
    replacementItemId: replacementItem.id,
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
    rpe: fixture.comparableBarbell ? 8 : null,
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

async function lockProgramSchedule(scheduleId: string): Promise<HeldProgramLock> {
  const client = await pool.connect();
  await client.query("BEGIN");
  const [{ backend_pid: backendPid }] = resultRows<{ backend_pid: number }>(
    await client.query("SELECT pg_backend_pid()::int AS backend_pid"),
  );
  await client.query(
    "SELECT id FROM program_schedules WHERE id = $1 FOR UPDATE",
    [scheduleId],
  );
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

function scheduleRaceDocument(routineLineageId: string, phaseName: string) {
  return {
    schemaVersion: "program-schedule/1" as const,
    startsOn: "2026-08-10",
    targetEndsOn: "2026-08-16",
    phases: [{
      id: crypto.randomUUID(),
      name: phaseName,
      order: 1,
      boundary: {
        kind: "program_week_range" as const,
        startWeek: 1,
        endWeek: 1,
      },
      schedule: {
        kind: "fixed_7_day" as const,
        days: Array.from({ length: 7 }, (_, index) => ({
          isoWeekday: index + 1,
          event: index === 0
            ? {
                id: crypto.randomUUID(),
                kind: "resistance" as const,
                routineLineageId,
              }
            : {
                id: crypto.randomUUID(),
                kind: "rest" as const,
              },
        })),
      },
    }],
  };
}

async function createScheduleRaceFixture(label: string) {
  const fixture = await createProgramFixture(label);
  const [template] = await db
    .select({
      id: workoutTemplates.id,
      lineageId: workoutTemplates.lineageId,
    })
    .from(workoutTemplates)
    .where(eq(workoutTemplates.id, fixture.templateId));
  if (!template) throw new Error("Schedule race routine missing.");
  const document = scheduleRaceDocument(template.lineageId, "Original");
  const published = await publishProgramSchedule(db, fixture.userId, {
    programId: fixture.programId,
    sourceProgramVersionId: fixture.versionId,
    expectedCurrentScheduleVersionId: null,
    requestId: crypto.randomUUID(),
    timezone: "America/Toronto",
    document,
  });
  if (published.outcome !== "published") {
    throw new Error("Schedule race publication failed.");
  }
  const [event] = await db
    .select()
    .from(schema.scheduledProgramEvents)
    .where(and(
      eq(
        schema.scheduledProgramEvents.scheduleVersionId,
        published.scheduleVersionId,
      ),
      eq(schema.scheduledProgramEvents.kind, "resistance"),
    ));
  if (!event) throw new Error("Schedule race occurrence missing.");
  return {
    ...fixture,
    routineLineageId: template.lineageId,
    scheduleId: published.scheduleId,
    scheduleVersionId: published.scheduleVersionId,
    scheduleVersionHash: published.contentHash,
    event,
  };
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

function expectRetryablePostgresRace(error: unknown) {
  let current = error;
  let code: string | null = null;
  const visited = new Set<unknown>();
  while (
    current != null &&
    typeof current === "object" &&
    !visited.has(current)
  ) {
    visited.add(current);
    if ("code" in current && current.code != null) {
      code = String(current.code);
      break;
    }
    current = "cause" in current ? current.cause : null;
  }
  expect(["40001", "40P01"]).toContain(code);
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

  it("reconciles concurrent Finish retries against the durable full payload", async () => {
    const sameFixture = await createProgramFixture("finish exact retry race");
    const sameStarted = await startWorkoutSession(
      db,
      sameFixture.userId,
      sameFixture.templateId,
    );
    const sameInput = {
      sessionId: sameStarted.sessionId,
      note: "One retained finish note",
      fatigue: 3,
      completionReason: "time_limit_reached" as const,
    };
    const sameLock = await lockWorkoutSession(sameStarted.sessionId);
    const sameReady = createStartBarrier(2);
    const sameOperations = Array.from({ length: 2 }, async () => {
      await sameReady();
      return completeWorkoutSession(
        db,
        { id: sameFixture.userId, coachingPrefs },
        sameInput,
      );
    });
    await releaseWhenContended(sameLock, sameOperations, 2);
    const sameResults = await Promise.all(sameOperations);
    expect(sameResults.map((result) => result.outcome).sort()).toEqual([
      "already_finished",
      "completed",
    ]);
    const [sameClosure] = resultRows<{
      notes: number;
      fatigue: number;
      audits: number;
      progression_jobs: number;
    }>(await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM session_notes
          WHERE session_id = ${sameStarted.sessionId}::uuid) AS notes,
        (SELECT count(*)::int FROM fatigue_logs
          WHERE session_id = ${sameStarted.sessionId}::uuid) AS fatigue,
        (SELECT count(*)::int FROM audit_logs
          WHERE action = 'session.complete'
            AND entity_id = ${sameStarted.sessionId}::text) AS audits,
        (SELECT count(*)::int FROM progression_jobs
          WHERE session_id = ${sameStarted.sessionId}::uuid) AS progression_jobs
    `));
    expect(sameClosure).toEqual({
      notes: 1,
      fatigue: 1,
      audits: 1,
      progression_jobs: 1,
    });

    const changedFixture = await createProgramFixture("finish changed retry race");
    const changedStarted = await startWorkoutSession(
      db,
      changedFixture.userId,
      changedFixture.templateId,
    );
    const changedLock = await lockWorkoutSession(changedStarted.sessionId);
    const changedReady = createStartBarrier(2);
    const changedOperations = [
      (async () => {
        await changedReady();
        return completeWorkoutSession(
          db,
          { id: changedFixture.userId, coachingPrefs },
          {
            sessionId: changedStarted.sessionId,
            note: "First device payload",
            fatigue: 2,
            completionReason: "time_limit_reached",
          },
        );
      })(),
      (async () => {
        await changedReady();
        return completeWorkoutSession(
          db,
          { id: changedFixture.userId, coachingPrefs },
          {
            sessionId: changedStarted.sessionId,
            note: "Second device payload",
            fatigue: 4,
            completionReason: "fatigue",
          },
        );
      })(),
    ];
    await releaseWhenContended(changedLock, changedOperations, 2);
    const changedResults = await Promise.all(changedOperations);
    expect(changedResults.map((result) => result.outcome).sort()).toEqual([
      "completed",
      "finish_payload_conflict",
    ]);
    expect(changedResults.find(
      (result) => result.outcome === "finish_payload_conflict",
    )).toMatchObject({
      alreadyFinished: true,
      reason: expect.stringContaining("different retained finish details"),
    });
    const [changedClosure] = resultRows<{
      notes: number;
      fatigue: number;
      audits: number;
      progression_jobs: number;
    }>(await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM session_notes
          WHERE session_id = ${changedStarted.sessionId}::uuid) AS notes,
        (SELECT count(*)::int FROM fatigue_logs
          WHERE session_id = ${changedStarted.sessionId}::uuid) AS fatigue,
        (SELECT count(*)::int FROM audit_logs
          WHERE action = 'session.complete'
            AND entity_id = ${changedStarted.sessionId}::text) AS audits,
        (SELECT count(*)::int FROM progression_jobs
          WHERE session_id = ${changedStarted.sessionId}::uuid) AS progression_jobs
    `));
    expect(changedClosure).toEqual({
      notes: 1,
      fatigue: 1,
      audits: 1,
      progression_jobs: 1,
    });
  });

  it("reconciles concurrent structured occurrence retries by client identity", async () => {
    const runRace = async (
      label: string,
      reasons: readonly ["time_limit_reached", "time_limit_reached" | "fatigue"],
    ) => {
      const fixture = await createProgramFixture(label);
      const started = await startWorkoutSession(
        db,
        fixture.userId,
        fixture.templateId,
      );
      const [occurrence] = await db
        .select({ id: sessionOccurrences.id })
        .from(sessionOccurrences)
        .where(eq(sessionOccurrences.sessionId, started.sessionId));
      if (!occurrence) throw new Error("Occurrence race fixture missing.");
      const clientKey = crypto.randomUUID();
      const lock = await lockWorkoutSession(started.sessionId);
      const ready = createStartBarrier(2);
      const operations = reasons.map(async (reasonCode) => {
        await ready();
        return mutateWorkoutOccurrence(db, fixture.userId, {
          occurrenceId: occurrence.id,
          clientKey,
          expectedRevision: 0,
          operation: "skip",
          reasonCode,
        });
      });
      await releaseWhenContended(lock, operations, 2);
      const results = await Promise.all(operations);
      const [receiptCount] = resultRows<{ count: number }>(await db.execute(sql`
        SELECT count(*)::int AS count
        FROM session_occurrence_mutations
        WHERE occurrence_id = ${occurrence.id}::uuid
          AND client_key = ${clientKey}::text
      `));
      expect(receiptCount?.count).toBe(1);
      return results;
    };

    const exactResults = await runRace(
      "occurrence exact retry race",
      ["time_limit_reached", "time_limit_reached"],
    );
    expect(exactResults.map((result) => result.outcome).sort()).toEqual([
      "replayed",
      "saved",
    ]);

    const changedResults = await runRace(
      "occurrence changed retry race",
      ["time_limit_reached", "fatigue"],
    );
    expect(changedResults.map((result) => result.outcome).sort()).toEqual([
      "retry_identity_conflict",
      "saved",
    ]);
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
      familyKey: "reporting-family:Squat",
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
      expect.objectContaining({ sequenceIdx: 2, kind: "exercise_warmup", label: "Ramp 2" }),
      expect.objectContaining({ sequenceIdx: 3, kind: "working_set", label: null }),
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

  it("serializes an equipment change with an exact-fenced set save", async () => {
    const fixture = await createEquipmentRaceFixture("equipment set race");
    const selectionInput = {
      operation: "select" as const,
      sessionExerciseId: fixture.sessionExerciseId,
      equipmentItemId: fixture.replacementItemId,
      attachmentItemId: null,
      expectedCurrentSnapshotId: fixture.primarySnapshotId,
      clientKey: crypto.randomUUID(),
      provenance: "user_selected" as const,
    };
    const setClientKey = crypto.randomUUID();
    const originalSetInput = {
      sessionExerciseId: fixture.sessionExerciseId,
      occurrenceId: fixture.occurrenceId,
      expectedOccurrenceRevision: fixture.occurrenceRevision,
      setNo: 1,
      weight: 100,
      weightUnit: "lb" as const,
      reps: 8,
      clientKey: setClientKey,
      equipmentSnapshotId: fixture.primarySnapshotId,
      loadEntryMeaning: "total_system" as const,
    };
    const lock = await lockWorkoutSession(fixture.sessionId);
    const ready = createStartBarrier(2);
    const selecting = (async () => {
      await ready();
      return mutateSessionEquipmentSelection(db, fixture.userId, selectionInput);
    })();
    const logging = (async () => {
      await ready();
      return logWorkoutSet(db, fixture.userId, originalSetInput);
    })();

    await releaseWhenContended(lock, [selecting, logging], 2);
    const [selectionSettled, logSettled] = await Promise.allSettled([
      selecting,
      logging,
    ]);
    let selection = selectionSettled.status === "fulfilled"
      ? selectionSettled.value
      : null;
    if (selectionSettled.status === "rejected") {
      expectRetryablePostgresRace(selectionSettled.reason);
      selection = await mutateSessionEquipmentSelection(
        db,
        fixture.userId,
        selectionInput,
      );
    }
    expect(selection).toMatchObject({ outcome: "applied" });
    if (
      selection == null ||
      !("snapshotId" in selection) ||
      selection.snapshotId == null
    ) {
      throw new Error("Replacement equipment snapshot missing.");
    }

    let saved = logSettled.status === "fulfilled" ? logSettled.value : null;
    if (logSettled.status === "rejected") {
      expectRetryablePostgresRace(logSettled.reason);
      saved = await logWorkoutSet(db, fixture.userId, originalSetInput);
    }
    if (saved?.outcome !== "saved") {
      expect(saved?.outcome).toMatch(
        /^(equipment_selection_conflict|stale_occurrence)$/,
      );
      const [currentOccurrence] = await db
        .select({ revision: sessionOccurrences.revision })
        .from(sessionOccurrences)
        .where(eq(sessionOccurrences.id, fixture.occurrenceId));
      if (!currentOccurrence) throw new Error("Current occurrence missing.");
      saved = await logWorkoutSet(db, fixture.userId, {
        ...originalSetInput,
        expectedOccurrenceRevision: currentOccurrence.revision,
        equipmentSnapshotId: selection.snapshotId,
      });
    }
    expect(saved).toMatchObject({
      outcome: "saved",
      occurrenceId: fixture.occurrenceId,
    });

    const [storedOccurrence] = await db
      .select({
        outcome: sessionOccurrences.outcome,
        revision: sessionOccurrences.revision,
        equipmentSnapshotId: sessionOccurrences.equipmentSnapshotId,
        completedSetId: sessionOccurrences.completedSetId,
      })
      .from(sessionOccurrences)
      .where(eq(sessionOccurrences.id, fixture.occurrenceId));
    const storedSets = await db
      .select({
        id: completedSets.id,
        equipmentSnapshotId: completedSets.equipmentSnapshotId,
      })
      .from(completedSets)
      .where(eq(completedSets.sessionExerciseId, fixture.sessionExerciseId));
    const [storedExercise] = await db
      .select({ snapshotId: sessionExercises.currentEquipmentSnapshotId })
      .from(sessionExercises)
      .where(eq(sessionExercises.id, fixture.sessionExerciseId));
    expect(storedSets).toHaveLength(1);
    expect(storedOccurrence).toMatchObject({
      outcome: "completed",
      completedSetId: storedSets[0]!.id,
      equipmentSnapshotId: storedSets[0]!.equipmentSnapshotId,
    });
    expect(storedOccurrence!.revision).toBeGreaterThanOrEqual(2);
    expect(storedExercise?.snapshotId).toBe(selection.snapshotId);

    await expect(
      mutateSessionEquipmentSelection(db, fixture.userId, selectionInput),
    ).resolves.toEqual({
      outcome: "replayed",
      snapshotId: selection.snapshotId,
      occurrenceStates: [expect.objectContaining({
        id: fixture.occurrenceId,
        outcome: "completed",
        revision: storedOccurrence!.revision,
        completedSetId: storedSets[0]!.id,
      })],
    });
  });

  it("rejects an equipment Finish whose source changes while the completion statement waits", async () => {
    const fixture = await createEquipmentRaceFixture("equipment cause finish race");
    await db.update(equipmentItems).set({ available: false })
      .where(eq(equipmentItems.userId, fixture.userId));
    const pendingBefore = await db.select().from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, fixture.sessionId));
    const sessionBefore = await db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, fixture.sessionId),
    });
    const input = {
      sessionId: fixture.sessionId,
      completionReason: "equipment_unavailable_incompatible" as const,
    };
    const lock = await lockWorkoutSession(fixture.sessionId);
    const finishing = completeWorkoutSession(
      db, { id: fixture.userId, coachingPrefs }, input,
      {
        checkpoint: async (boundary) => {
          if (boundary !== "before-completion-statement") return;
          // A second connection changes the inventory but holds its commit
          // until Finish is waiting with an older statement snapshot.
          await lock.client.query(
            "UPDATE equipment_items SET available = true WHERE user_id = $1",
            [fixture.userId],
          );
        },
      },
    );
    await releaseWhenContended(lock, [finishing], 1);
    await expect(finishing).resolves.toMatchObject({
      outcome: "equipment_reason_unverified",
    });
    expect(await db.select().from(sessionOccurrences)
      .where(eq(sessionOccurrences.sessionId, fixture.sessionId)))
      .toEqual(pendingBefore);
    expect(await db.query.workoutSessions.findFirst({
      where: eq(workoutSessions.id, fixture.sessionId),
    })).toEqual(sessionBefore);
    expect(await db.select().from(progressionJobs)
      .where(eq(progressionJobs.sessionId, fixture.sessionId))).toHaveLength(0);

    await db.update(equipmentItems).set({ available: false })
      .where(eq(equipmentItems.userId, fixture.userId));
    await expect(completeWorkoutSession(
      db, { id: fixture.userId, coachingPrefs }, input,
    )).resolves.toMatchObject({ outcome: "completed" });
    await db.update(equipmentItems).set({ available: true })
      .where(eq(equipmentItems.userId, fixture.userId));
    await expect(completeWorkoutSession(
      db, { id: fixture.userId, coachingPrefs }, input,
    )).resolves.toMatchObject({ outcome: "already_finished" });
  });

  it("does not rewrite pending occurrence evidence after Finish wins an equipment race", async () => {
    const fixture = await createEquipmentRaceFixture("equipment finish race");
    const selectionInput = {
      operation: "select" as const,
      sessionExerciseId: fixture.sessionExerciseId,
      equipmentItemId: fixture.replacementItemId,
      attachmentItemId: null,
      expectedCurrentSnapshotId: fixture.primarySnapshotId,
      clientKey: crypto.randomUUID(),
      provenance: "user_selected" as const,
    };
    const lock = await lockWorkoutSession(fixture.sessionId);
    const ready = createStartBarrier(2);
    const selecting = (async () => {
      await ready();
      return mutateSessionEquipmentSelection(db, fixture.userId, selectionInput);
    })();
    const finishing = (async () => {
      await ready();
      return completeWorkoutSession(
        db,
        { id: fixture.userId, coachingPrefs },
        {
          sessionId: fixture.sessionId,
          completionReason: "user_choice",
        },
      );
    })();

    await releaseWhenContended(lock, [selecting, finishing], 2);
    const [selectionSettled, finishSettled] = await Promise.allSettled([
      selecting,
      finishing,
    ]);
    let finished = finishSettled.status === "fulfilled"
      ? finishSettled.value
      : null;
    if (finishSettled.status === "rejected") {
      expectRetryablePostgresRace(finishSettled.reason);
      finished = await completeWorkoutSession(
        db,
        { id: fixture.userId, coachingPrefs },
        {
          sessionId: fixture.sessionId,
          completionReason: "user_choice",
        },
      );
    }
    expect(finished).toMatchObject({ outcome: "completed" });

    let selection = selectionSettled.status === "fulfilled"
      ? selectionSettled.value
      : null;
    if (selectionSettled.status === "rejected") {
      expectRetryablePostgresRace(selectionSettled.reason);
      selection = await mutateSessionEquipmentSelection(
        db,
        fixture.userId,
        selectionInput,
      );
    }
    expect(["applied", "not_active"]).toContain(selection?.outcome);

    const readState = async () => {
      const [row] = await db
        .select({
          sessionStatus: workoutSessions.status,
          currentSnapshotId: sessionExercises.currentEquipmentSnapshotId,
          occurrenceOutcome: sessionOccurrences.outcome,
          occurrenceRevision: sessionOccurrences.revision,
          occurrenceSnapshotId: sessionOccurrences.equipmentSnapshotId,
          completedSetId: sessionOccurrences.completedSetId,
        })
        .from(workoutSessions)
        .innerJoin(
          sessionExercises,
          eq(sessionExercises.sessionId, workoutSessions.id),
        )
        .innerJoin(
          sessionOccurrences,
          eq(sessionOccurrences.sessionExerciseId, sessionExercises.id),
        )
        .where(eq(workoutSessions.id, fixture.sessionId));
      return row;
    };
    const completedState = await readState();
    expect(completedState).toMatchObject({
      sessionStatus: "completed",
      occurrenceOutcome: "abandoned",
      completedSetId: null,
    });

    if (selection?.outcome === "applied" && "snapshotId" in selection) {
      await expect(
        mutateSessionEquipmentSelection(db, fixture.userId, selectionInput),
      ).resolves.toEqual({
        outcome: "replayed",
        snapshotId: selection.snapshotId,
        occurrenceStates: [expect.objectContaining({
          id: fixture.occurrenceId,
          outcome: "abandoned",
          revision: completedState!.occurrenceRevision,
          completedSetId: null,
        })],
      });
    }

    await expect(mutateSessionEquipmentSelection(db, fixture.userId, {
      ...selectionInput,
      expectedCurrentSnapshotId: completedState!.currentSnapshotId,
      clientKey: crypto.randomUUID(),
    })).resolves.toEqual({ outcome: "not_active" });
    expect(await readState()).toEqual(completedState);
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
    })).resolves.toMatchObject({ outcome: "set_order_conflict" });
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

  it("serializes Program switching against workout Start", async () => {
    const first = await createProgramFixture("Program switch Start race");
    const second = await activateProgramAtomically(db, {
      userId: first.userId,
      loadUnit: "lb",
      programName: "Program switch Start race second Program",
      days: [{
        name: "Program switch Start race second Day",
        exercises: [{
          exerciseId: first.exerciseId,
          sets: 1,
          repMin: 6,
          repMax: 8,
          targetLoad: 100,
          restSec: 90,
          supersetKey: null,
          notes: null,
        }],
      }],
      changeSummary: "Create switch-race target",
      auditAction: "program.activate",
      auditSummary: "Create switch-race target",
      expectedCurrentProgramVersionId: first.versionId,
      destination: "create_new_active",
    });
    if (!second.ok) throw new Error(second.reason);
    const [secondTemplate] = await db
      .select({ id: workoutTemplates.id })
      .from(workoutTemplates)
      .where(eq(
        workoutTemplates.programVersionId,
        second.programVersionId,
      ));
    if (!secondTemplate) throw new Error("Second Program routine missing.");

    const held = await lockUserProfile(first.userId);
    const started = startWorkoutSession(
      db,
      first.userId,
      secondTemplate.id,
      undefined,
      {
        startRequestKey: crypto.randomUUID(),
        timezone: "America/Toronto",
      },
    );
    const switched = switchActiveProgram(db, first.userId, {
      targetProgramId: first.programId,
      expectedActiveProgramId: second.programId,
      requestId: crypto.randomUUID(),
    });
    await releaseWhenContended(held, [started, switched], 2);
    const [startResult, switchResult] = await Promise.allSettled([
      started,
      switched,
    ]);
    const startWon =
      startResult.status === "fulfilled" &&
      startResult.value.outcome === "created";
    const switchWon =
      switchResult.status === "fulfilled" &&
      switchResult.value.outcome === "switched";
    expect(Number(startWon) + Number(switchWon)).toBe(1);

    const currentPrograms = await db
      .select({ id: programs.id, status: programs.status })
      .from(programs)
      .where(eq(programs.userId, first.userId));
    const sessions = await db
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.userId, first.userId));
    if (startWon) {
      expect(switchResult).toMatchObject({
        status: "fulfilled",
        value: { outcome: expect.stringMatching(/active_workout|conflict/) },
      });
      expect(currentPrograms).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: second.programId, status: "active" }),
        expect.objectContaining({ id: first.programId, status: "inactive" }),
      ]));
      expect(sessions).toEqual([
        expect.objectContaining({ sourceProgramId: second.programId }),
      ]);
    } else {
      expect(startResult.status).toBe("rejected");
      if (startResult.status === "rejected") {
        expect(startResult.reason).toBeInstanceOf(StaleWorkoutTemplateError);
      }
      expect(currentPrograms).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first.programId, status: "active" }),
        expect.objectContaining({ id: second.programId, status: "inactive" }),
      ]));
      expect(sessions).toHaveLength(0);
    }
  }, 60_000);

  it("serializes schedule replacement against scheduled workout Start", async () => {
    const fixture = await createScheduleRaceFixture("schedule Start race");
    const held = await lockProgramSchedule(fixture.scheduleId);
    const replacement = publishProgramSchedule(db, fixture.userId, {
      programId: fixture.programId,
      sourceProgramVersionId: fixture.versionId,
      expectedCurrentScheduleVersionId: fixture.scheduleVersionId,
      requestId: crypto.randomUUID(),
      timezone: "America/Toronto",
      document: scheduleRaceDocument(
        fixture.routineLineageId,
        "Replacement",
      ),
    });
    const started = startWorkoutSession(
      db,
      fixture.userId,
      fixture.templateId,
      undefined,
      {
        startRequestKey: crypto.randomUUID(),
        timezone: "America/Toronto",
        scheduledStart: {
          scheduledProgramEventId: fixture.event.id,
          expectedEventRevision: fixture.event.revision,
          programScheduleVersionId: fixture.scheduleVersionId,
          programScheduleVersionHash: fixture.scheduleVersionHash,
        },
      },
    );
    await releaseWhenContended(held, [replacement, started], 2);
    const [replacementResult, startResult] = await Promise.allSettled([
      replacement,
      started,
    ]);
    const replacementWon =
      replacementResult.status === "fulfilled" &&
      replacementResult.value.outcome === "published";
    const startWon =
      startResult.status === "fulfilled" &&
      startResult.value.outcome === "created";
    expect(Number(replacementWon) + Number(startWon)).toBe(1);

    const [root] = await db
      .select()
      .from(schema.programSchedules)
      .where(eq(schema.programSchedules.id, fixture.scheduleId));
    const versions = await db
      .select()
      .from(schema.programScheduleVersions)
      .where(eq(
        schema.programScheduleVersions.scheduleId,
        fixture.scheduleId,
      ));
    const events = await db
      .select()
      .from(schema.scheduledProgramEvents)
      .where(eq(
        schema.scheduledProgramEvents.scheduleId,
        fixture.scheduleId,
      ));
    const sessions = await db
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.userId, fixture.userId));

    if (startWon) {
      expect(replacementResult).toMatchObject({
        status: "fulfilled",
        value: { outcome: "conflict" },
      });
      expect(root.currentVersionId).toBe(fixture.scheduleVersionId);
      expect(versions).toHaveLength(1);
      expect(sessions).toHaveLength(1);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: fixture.event.id,
          scheduleVersionId: fixture.scheduleVersionId,
          status: "started",
          revision: 1,
        }),
      ]));
    } else {
      expect(startResult.status).toBe("rejected");
      if (startResult.status === "rejected") {
        expect(startResult.reason).toBeInstanceOf(StaleWorkoutTemplateError);
      }
      expect(versions).toHaveLength(2);
      expect(sessions).toHaveLength(0);
      expect(root.currentVersionId).not.toBe(fixture.scheduleVersionId);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: fixture.event.id,
          status: "superseded",
        }),
        expect.objectContaining({
          scheduleVersionId: root.currentVersionId,
          kind: "resistance",
          status: "scheduled",
        }),
      ]));
    }
  }, 60_000);

  it("serializes schedule replacement against missed-day adjustment", async () => {
    const fixture = await createScheduleRaceFixture("schedule adjustment race");
    const held = await lockProgramSchedule(fixture.scheduleId);
    const replacement = publishProgramSchedule(db, fixture.userId, {
      programId: fixture.programId,
      sourceProgramVersionId: fixture.versionId,
      expectedCurrentScheduleVersionId: fixture.scheduleVersionId,
      requestId: crypto.randomUUID(),
      timezone: "America/Toronto",
      document: scheduleRaceDocument(
        fixture.routineLineageId,
        "Replacement",
      ),
    });
    const adjustment = adjustScheduledProgramEvent(db, fixture.userId, {
      eventId: fixture.event.id,
      expectedRevision: fixture.event.revision,
      requestId: crypto.randomUUID(),
      adjustment: {
        kind: "manual_reschedule",
        toLocalDate: "2026-08-12",
      },
    });
    await releaseWhenContended(held, [replacement, adjustment], 2);
    const [replacementResult, adjustmentResult] = await Promise.all([
      replacement,
      adjustment,
    ]);
    const replacementWon = replacementResult.outcome === "published";
    const adjustmentWon = adjustmentResult.outcome === "applied";
    expect(Number(replacementWon) + Number(adjustmentWon)).toBe(1);

    const [root] = await db
      .select()
      .from(schema.programSchedules)
      .where(eq(schema.programSchedules.id, fixture.scheduleId));
    const versions = await db
      .select()
      .from(schema.programScheduleVersions)
      .where(eq(
        schema.programScheduleVersions.scheduleId,
        fixture.scheduleId,
      ));
    const events = await db
      .select()
      .from(schema.scheduledProgramEvents)
      .where(eq(
        schema.scheduledProgramEvents.scheduleId,
        fixture.scheduleId,
      ));

    if (adjustmentWon) {
      expect(replacementResult).toEqual({ outcome: "conflict" });
      expect(root.currentVersionId).toBe(fixture.scheduleVersionId);
      expect(versions).toHaveLength(1);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: fixture.event.id,
          status: "scheduled",
          revision: 1,
          adjustmentKind: "manual",
          currentLocalDate: "2026-08-12",
        }),
      ]));
    } else {
      expect(adjustmentResult).toEqual({ outcome: "conflict" });
      expect(versions).toHaveLength(2);
      expect(root.currentVersionId).not.toBe(fixture.scheduleVersionId);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: fixture.event.id,
          status: "superseded",
          revision: 1,
        }),
        expect.objectContaining({
          scheduleVersionId: root.currentVersionId,
          kind: "resistance",
          status: "scheduled",
          revision: 0,
        }),
      ]));
    }
  }, 60_000);
});
