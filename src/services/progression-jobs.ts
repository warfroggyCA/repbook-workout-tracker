import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { camelRows, resultRows } from "@/db/result";
import * as schema from "@/db/schema";
import type { CoachingPrefs } from "@/db/schema";
import { optionalEnv } from "@/lib/env";
import { PROGRESSION_JOB_MAX_ATTEMPTS } from "@/lib/progression-job-contract";
import { logServerEvent } from "@/lib/server-log";
import { evaluateSessionProgression } from "@/services/progression";
import { acquireHistoryRevisionLock } from "@/services/history-revision-lock";

class ProgressionLeaseLostError extends Error {}

type TransactionalDb = Db & {
  transaction<T>(callback: (tx: Db) => Promise<T>): Promise<T>;
};

type PgliteBridgeGlobal = typeof globalThis & {
  workoutTrackerPgliteBridgeClient?: PGlite;
};

type ProgressionJobRow = {
  id: string;
  userId: string;
  sessionId: string;
  sourceSessionRevision: number;
  coachingPrefs: CoachingPrefs;
  leaseToken: string;
  attempts: number;
};

type ProgressionJobDependencies = {
  now?: () => Date;
  leaseSeconds?: number;
  userId?: string;
  evaluate?: typeof evaluateSessionProgression;
  afterClaim?: (job: ProgressionJobRow) => void | Promise<void>;
  checkpoint?: (boundary: string) => void | Promise<void>;
};

export const PROGRESSION_DRAIN_MAX_JOBS = 25;
export const PROGRESSION_DRAIN_MAX_DURATION_MS = 45_000;

function parsePrefs(value: unknown): CoachingPrefs {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("The progression job has invalid coaching preferences.");
  }
  return parsed as CoachingPrefs;
}

async function withProgressionTransaction<T>(
  db: Db,
  callback: (tx: Db) => Promise<T>,
): Promise<T> {
  const bridgeClient = (globalThis as PgliteBridgeGlobal)
    .workoutTrackerPgliteBridgeClient;
  if (bridgeClient) {
    const { drizzle } = await import("drizzle-orm/pglite");
    const transactionalDb = drizzle(bridgeClient, { schema }) as unknown as
      TransactionalDb;
    return transactionalDb.transaction(callback);
  }

  const databaseUrl = optionalEnv("DATABASE_URL");
  if (databaseUrl) {
    const [{ Pool }, { drizzle }] = await Promise.all([
      import("@neondatabase/serverless"),
      import("drizzle-orm/neon-serverless"),
    ]);
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const transactionalDb = drizzle(pool, { schema }) as unknown as TransactionalDb;
      return await transactionalDb.transaction(callback);
    } finally {
      await pool.end();
    }
  }

  return (db as TransactionalDb).transaction(callback);
}

export async function claimProgressionJob(
  db: Db,
  jobId?: string,
  dependencies: Pick<
    ProgressionJobDependencies,
    "now" | "leaseSeconds" | "userId"
  > = {}
): Promise<ProgressionJobRow | null> {
  const now = (dependencies.now ?? (() => new Date()))();
  const leasedUntil = new Date(
    now.getTime() + (dependencies.leaseSeconds ?? 120) * 1000
  );
  const leaseToken = randomUUID();
  const query = sql`
    WITH candidate AS MATERIALIZED (
      SELECT job.id
      FROM progression_jobs job
      WHERE (${jobId ?? null}::uuid IS NULL OR job.id = ${jobId ?? null}::uuid)
        AND (${dependencies.userId ?? null}::uuid IS NULL OR job.user_id = ${dependencies.userId ?? null}::uuid)
        AND job.attempts < ${PROGRESSION_JOB_MAX_ATTEMPTS}
        AND (
          (
            job.status = 'pending'
            AND job.next_attempt_at <= ${now.toISOString()}::timestamptz
          )
          OR (
            job.status = 'processing'
            AND job.leased_until < ${now.toISOString()}::timestamptz
          )
        )
      ORDER BY job.created_at, job.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    ), claimed AS (
      UPDATE progression_jobs job
      SET status = 'processing',
          attempts = attempts + 1,
          lease_token = ${leaseToken}::uuid,
          leased_until = ${leasedUntil.toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.*
    ), source_lineages AS MATERIALIZED (
      SELECT DISTINCT
        claimed.id AS job_id,
        claimed.user_id,
        exercise.source_slot_lineage_id
      FROM claimed
      JOIN session_exercises exercise
        ON exercise.session_id = claimed.session_id
      WHERE NOT EXISTS (
          SELECT 1
          FROM progression_job_input_sessions existing_input
          WHERE existing_input.job_id = claimed.id
        )
        AND exercise.source_slot_lineage_id IS NOT NULL
        AND exercise.modification_type = 'as_planned'
    ), ranked_inputs AS MATERIALIZED (
      SELECT
        lineage.job_id,
        lineage.user_id,
        lineage.source_slot_lineage_id,
        session.id AS session_id,
        session.history_revision,
        dense_rank() OVER (
          PARTITION BY lineage.job_id, lineage.source_slot_lineage_id
          ORDER BY session.started_at DESC, session.id DESC
        ) AS exposure_rank
      FROM source_lineages lineage
      JOIN session_exercises exercise
        ON exercise.source_slot_lineage_id = lineage.source_slot_lineage_id
       AND exercise.modification_type = 'as_planned'
      JOIN workout_sessions session
        ON session.id = exercise.session_id
       AND session.user_id = lineage.user_id
       AND session.status = 'completed'
       AND session.archived_at IS NULL
      WHERE EXISTS (
        SELECT 1
        FROM completed_sets completed_set
        JOIN session_occurrences occurrence
          ON occurrence.completed_set_id = completed_set.id
         AND occurrence.session_exercise_id = exercise.id
         AND occurrence.kind = 'working_set'
         AND occurrence.outcome = 'completed'
        WHERE completed_set.session_exercise_id = exercise.id
          AND completed_set.archived_at IS NULL
          AND NOT completed_set.is_warmup
          AND completed_set.reps IS NOT NULL
      )
    ), captured_inputs AS (
      INSERT INTO progression_job_input_sessions (
        job_id, user_id, source_slot_lineage_id, session_id, history_revision
      )
      SELECT
        ranked.job_id,
        ranked.user_id,
        ranked.source_slot_lineage_id,
        ranked.session_id,
        ranked.history_revision
      FROM ranked_inputs ranked
      WHERE ranked.exposure_rank <= 4
      ON CONFLICT (job_id, source_slot_lineage_id, session_id) DO NOTHING
      RETURNING job_id
    )
    SELECT * FROM claimed
  `;
  const row = camelRows(await db.execute(query))[0];
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.userId),
    sessionId: String(row.sessionId),
    sourceSessionRevision: Number(row.sourceSessionRevision),
    coachingPrefs: parsePrefs(row.coachingPrefs),
    leaseToken: String(row.leaseToken),
    attempts: Number(row.attempts),
  };
}

function currentInputMembershipSql(job: ProgressionJobRow) {
  return sql`
    WITH source_lineages AS MATERIALIZED (
      SELECT DISTINCT exercise.source_slot_lineage_id
      FROM session_exercises exercise
      WHERE exercise.session_id = ${job.sessionId}::uuid
        AND exercise.source_slot_lineage_id IS NOT NULL
        AND exercise.modification_type = 'as_planned'
    ), ranked_inputs AS MATERIALIZED (
      SELECT
        lineage.source_slot_lineage_id,
        session.id AS session_id,
        session.history_revision,
        dense_rank() OVER (
          PARTITION BY lineage.source_slot_lineage_id
          ORDER BY session.started_at DESC, session.id DESC
        ) AS exposure_rank
      FROM source_lineages lineage
      JOIN session_exercises exercise
        ON exercise.source_slot_lineage_id = lineage.source_slot_lineage_id
       AND exercise.modification_type = 'as_planned'
      JOIN workout_sessions session
        ON session.id = exercise.session_id
       AND session.user_id = ${job.userId}::uuid
       AND session.status = 'completed'
       AND session.archived_at IS NULL
      WHERE EXISTS (
        SELECT 1
        FROM completed_sets completed_set
        JOIN session_occurrences occurrence
          ON occurrence.completed_set_id = completed_set.id
         AND occurrence.session_exercise_id = exercise.id
         AND occurrence.kind = 'working_set'
         AND occurrence.outcome = 'completed'
        WHERE completed_set.session_exercise_id = exercise.id
          AND completed_set.archived_at IS NULL
          AND NOT completed_set.is_warmup
          AND completed_set.reps IS NOT NULL
      )
    ), current_inputs AS MATERIALIZED (
      SELECT source_slot_lineage_id, session_id, history_revision
      FROM ranked_inputs
      WHERE exposure_rank <= 4
    ), expected_inputs AS MATERIALIZED (
      SELECT source_slot_lineage_id, session_id, history_revision
      FROM progression_job_input_sessions
      WHERE job_id = ${job.id}::uuid
        AND user_id = ${job.userId}::uuid
    )
  `;
}

async function progressionJobFenceIsCurrent(db: Db, job: ProgressionJobRow) {
  const [row] = resultRows(await db.execute(sql`
    ${currentInputMembershipSql(job)}
    SELECT
      EXISTS (
        SELECT 1
        FROM workout_sessions session
        WHERE session.id = ${job.sessionId}::uuid
          AND session.user_id = ${job.userId}::uuid
          AND session.status = 'completed'
          AND session.archived_at IS NULL
          AND session.history_revision = ${job.sourceSessionRevision}
      )
      AND NOT EXISTS (
        (SELECT * FROM current_inputs EXCEPT SELECT * FROM expected_inputs)
        UNION ALL
        (SELECT * FROM expected_inputs EXCEPT SELECT * FROM current_inputs)
      ) AS current
  `));
  return Boolean(row?.current);
}

async function finalizeClaimedJob(db: Db, job: ProgressionJobRow, now: Date) {
  const [row] = resultRows(await db.execute(sql`
    ${currentInputMembershipSql(job)}
    , fence AS MATERIALIZED (
      SELECT
        EXISTS (
          SELECT 1
          FROM workout_sessions session
          WHERE session.id = ${job.sessionId}::uuid
            AND session.user_id = ${job.userId}::uuid
            AND session.status = 'completed'
            AND session.archived_at IS NULL
            AND session.history_revision = ${job.sourceSessionRevision}
        )
        AND NOT EXISTS (
          (SELECT * FROM current_inputs EXCEPT SELECT * FROM expected_inputs)
          UNION ALL
          (SELECT * FROM expected_inputs EXCEPT SELECT * FROM current_inputs)
        ) AS current
    ), lease_owner AS MATERIALIZED (
      SELECT job.id
      FROM progression_jobs job
      WHERE job.id = ${job.id}::uuid
        AND job.status = 'processing'
        AND job.lease_token = ${job.leaseToken}::uuid
    ), reconciled_stale_recommendations AS (
      UPDATE recommendations recommendation
      SET status = 'expired',
          reconciliation_reason =
            'Superseded progression input changed before finalization.',
          reconciled_at = statement_timestamp()
      FROM fence, lease_owner
      WHERE NOT fence.current
        AND recommendation.progression_job_id = ${job.id}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
      RETURNING recommendation.id
    ), finalized AS (
      UPDATE progression_jobs job
      SET status = 'completed',
          lease_token = NULL,
          leased_until = NULL,
          last_error = CASE WHEN fence.current THEN NULL
            ELSE 'Superseded progression input: workout history changed before finalization.'
          END,
          completed_at = ${now.toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
      FROM fence
      WHERE job.id = ${job.id}::uuid
        AND job.status = 'processing'
        AND job.lease_token = ${job.leaseToken}::uuid
      RETURNING job.id, fence.current
    )
    SELECT * FROM finalized
  `));
  if (!row) return "lease_lost" as const;
  return row.current ? ("completed" as const) : ("stale" as const);
}

async function releaseFailedJob(
  db: Db,
  job: ProgressionJobRow,
  error: unknown,
  now: Date
) {
  const failedPermanently = job.attempts >= PROGRESSION_JOB_MAX_ATTEMPTS;
  const nextAttemptAt = new Date(
    now.getTime() + Math.min(60, 2 ** job.attempts) * 1000
  );
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    1000
  );
  const result = await db.execute(sql`
    UPDATE progression_jobs
    SET status = ${failedPermanently ? "failed" : "pending"},
        lease_token = NULL,
        leased_until = NULL,
        last_error = ${message},
        next_attempt_at = ${nextAttemptAt.toISOString()}::timestamptz,
        updated_at = ${now.toISOString()}::timestamptz
    WHERE id = ${job.id}::uuid
      AND status = 'processing'
      AND lease_token = ${job.leaseToken}::uuid
    RETURNING id
  `);
  return {
    released: resultRows(result).length === 1,
    failedPermanently,
  };
}

export async function processProgressionJob(
  db: Db,
  jobId?: string,
  dependencies: ProgressionJobDependencies = {}
) {
  const now = dependencies.now ?? (() => new Date());
  const job = await claimProgressionJob(db, jobId, dependencies);
  if (!job) return { status: "unavailable" as const, jobId: jobId ?? null };
  try {
    await dependencies.afterClaim?.(job);
    const completed = await withProgressionTransaction(db, async (tx) => {
      await acquireHistoryRevisionLock(tx, job.userId);
      if (!(await progressionJobFenceIsCurrent(tx, job))) {
        return finalizeClaimedJob(tx, job, now());
      }
      await tx.execute(sql`
        UPDATE recommendations
        SET status = 'expired',
            reconciliation_reason =
              'Superseded by progression re-evaluation.',
            reconciled_at = statement_timestamp()
        WHERE progression_job_id = ${job.id}::uuid
          AND status = 'pending'
          AND archived_at IS NULL
      `);
      await (dependencies.evaluate ?? evaluateSessionProgression)(
        tx,
        job.userId,
        job.sessionId,
        job.coachingPrefs,
        job.id
      );
      await dependencies.checkpoint?.("progression-evaluated");
      const finalized = await finalizeClaimedJob(tx, job, now());
      if (finalized === "lease_lost") throw new ProgressionLeaseLostError();
      return finalized;
    });
    return {
      status: completed,
      jobId: job.id,
    };
  } catch (error) {
    if (error instanceof ProgressionLeaseLostError) {
      return { status: "lease_lost" as const, jobId: job.id };
    }
    const released = await releaseFailedJob(db, job, error, now());
    logServerEvent(
      released.failedPermanently ? "error" : "warn",
      "progression.job_failed",
      {
        jobId: job.id,
        userId: job.userId,
        sessionId: job.sessionId,
        attempts: job.attempts,
        retryScheduled: released.released && !released.failedPermanently,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }
    );
    return {
      status: "failed" as const,
      jobId: job.id,
      retryScheduled: released.released && !released.failedPermanently,
      error,
    };
  }
}

export type ProgressionJobHealth = {
  pending: number;
  ready: number;
  processing: number;
  expiredLeases: number;
  failed: number;
  exhausted: number;
  oldestReadyAt: string | null;
};

export async function getProgressionJobHealth(
  db: Db,
  now = new Date()
): Promise<ProgressionJobHealth> {
  const [row] = resultRows(await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (
        WHERE status = 'pending' AND next_attempt_at <= ${now.toISOString()}::timestamptz
      )::int AS ready,
      count(*) FILTER (WHERE status = 'processing')::int AS processing,
      count(*) FILTER (
        WHERE status = 'processing' AND leased_until < ${now.toISOString()}::timestamptz
      )::int AS expired_leases,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (
        WHERE status IN ('pending', 'processing')
          AND attempts >= ${PROGRESSION_JOB_MAX_ATTEMPTS}
      )::int AS exhausted,
      min(next_attempt_at) FILTER (
        WHERE status = 'pending' AND next_attempt_at <= ${now.toISOString()}::timestamptz
      ) AS oldest_ready_at
    FROM progression_jobs
  `));
  return {
    pending: Number(row?.pending ?? 0),
    ready: Number(row?.ready ?? 0),
    processing: Number(row?.processing ?? 0),
    expiredLeases: Number(row?.expired_leases ?? 0),
    failed: Number(row?.failed ?? 0),
    exhausted: Number(row?.exhausted ?? 0),
    oldestReadyAt: row?.oldest_ready_at
      ? new Date(String(row.oldest_ready_at)).toISOString()
      : null,
  };
}

async function recoverExhaustedProgressionJobs(db: Db, now: Date) {
  const result = await db.execute(sql`
    UPDATE progression_jobs
    SET status = 'failed',
        lease_token = NULL,
        leased_until = NULL,
        last_error = coalesce(last_error, 'Progression retry limit reached.'),
        updated_at = ${now.toISOString()}::timestamptz
    WHERE status IN ('pending', 'processing')
      AND attempts >= ${PROGRESSION_JOB_MAX_ATTEMPTS}
      AND (status = 'pending' OR leased_until < ${now.toISOString()}::timestamptz)
    RETURNING id
  `);
  return resultRows(result).length;
}

export async function drainProgressionJobs(
  db: Db,
  dependencies: {
    now?: () => Date;
    maxJobs?: number;
    maxDurationMs?: number;
    process?: typeof processProgressionJob;
  } = {}
) {
  const now = dependencies.now ?? (() => new Date());
  const maxJobs = Math.min(
    Math.max(dependencies.maxJobs ?? PROGRESSION_DRAIN_MAX_JOBS, 1),
    50
  );
  const maxDurationMs = Math.min(
    Math.max(
      dependencies.maxDurationMs ?? PROGRESSION_DRAIN_MAX_DURATION_MS,
      1_000
    ),
    50_000
  );
  const startedAt = now();
  const before = await getProgressionJobHealth(db, startedAt);
  const exhaustedRecovered = await recoverExhaustedProgressionJobs(db, startedAt);
  const counts = {
    completed: 0,
    retryScheduled: 0,
    permanentlyFailed: 0,
    leaseLost: 0,
    stale: 0,
  };
  const process = dependencies.process ?? processProgressionJob;
  let attempted = 0;
  while (
    attempted < maxJobs &&
    now().getTime() - startedAt.getTime() < maxDurationMs
  ) {
    const result = await process(db, undefined, { now });
    if (result.status === "unavailable") break;
    attempted += 1;
    if (result.status === "completed") counts.completed += 1;
    else if (result.status === "lease_lost") counts.leaseLost += 1;
    else if (result.status === "stale") counts.stale += 1;
    else if (result.retryScheduled) counts.retryScheduled += 1;
    else counts.permanentlyFailed += 1;
  }
  const finishedAt = now();
  const after = await getProgressionJobHealth(db, finishedAt);
  const oldestReadyAgeMs = after.oldestReadyAt
    ? finishedAt.getTime() - Date.parse(after.oldestReadyAt)
    : 0;
  const needsAttention =
    after.failed > 0 ||
    after.expiredLeases > 0 ||
    after.exhausted > 0 ||
    oldestReadyAgeMs > 2 * 60 * 60 * 1000;
  return {
    ok: !needsAttention,
    bounded: attempted >= maxJobs || finishedAt.getTime() - startedAt.getTime() >= maxDurationMs,
    attempted,
    exhaustedRecovered,
    ...counts,
    before,
    after,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}
