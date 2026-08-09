import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  categorizeDiagnosticError,
  logDiagnosticEvent,
} from "@/lib/server-log";
import {
  getSnapshotObjectStore,
  type SnapshotObjectStore,
} from "@/services/snapshot-store";

export const AUTOMATIC_SNAPSHOT_RECENT_LIMIT = 50;
export const AUTOMATIC_SNAPSHOT_DAILY_DAYS = 30;
export const AUTOMATIC_SNAPSHOT_WEEKLY_DAYS = 90;
export const AUTOMATIC_SNAPSHOT_FAILED_DAYS = 7;
export const SNAPSHOT_CREATING_STALE_HOURS = 2;
export const SNAPSHOT_DELETION_LEASE_MINUTES = 10;
export const SNAPSHOT_ORPHAN_GRACE_DAYS = 7;
export const SNAPSHOT_MAINTENANCE_BATCH = 100;

type ClaimedSnapshot = {
  id: string;
  userId: string;
  objectPath: string;
  objectEtag: string | null;
  leaseId: string;
};

export type SnapshotLifecycleResult = {
  staleCreatingMarkedFailed: number;
  claimedForDeletion: number;
  deletedSnapshots: number;
  deletionFailures: number;
  orphanObjectsFound: number;
  orphanObjectsDeleted: number;
  orphanObjectsPendingDeletion: number;
  orphanDeletionFailures: number;
  recentOrphanObjects: number;
  storeScanFailure: string | null;
};

export type SnapshotLifecycleDependencies = {
  store?: SnapshotObjectStore;
  now?: Date;
  failAfterObjectDelete?: boolean;
};

function countFrom(result: unknown) {
  return Number(resultRows(result)[0]?.count ?? 0);
}

function errorMessage(error: unknown) {
  const message =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : "Snapshot maintenance failed.";
  return message.slice(0, 500);
}

async function markStaleCreatingSnapshots(db: Db, now: Date) {
  const result = await db.execute(sql`
    WITH stale AS (
      UPDATE data_snapshots snapshot
      SET status = 'failed',
          failure_reason = 'Snapshot creation did not finish before the maintenance deadline.',
          updated_at = ${now.toISOString()}::timestamptz
      WHERE snapshot.status = 'creating'
        AND snapshot.updated_at <= ${now.toISOString()}::timestamptz - interval '2 hours'
      RETURNING snapshot.id, snapshot.user_id, snapshot.name
    ), audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        stale.user_id,
        'system',
        'snapshot.creation_stale',
        'data_snapshot',
        stale.id::text,
        'Marked an incomplete snapshot as failed: ' || stale.name,
        jsonb_build_object('staleHours', ${SNAPSHOT_CREATING_STALE_HOURS}::integer)
      FROM stale
    )
    SELECT count(*)::integer AS count FROM stale
  `);
  return countFrom(result);
}

async function claimDeletionCandidates(db: Db, now: Date) {
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(
    now.getTime() + SNAPSHOT_DELETION_LEASE_MINUTES * 60_000
  );
  const result = await db.execute(sql`
    WITH ranked_verified AS MATERIALIZED (
      SELECT
        snapshot.id,
        snapshot.user_id,
        snapshot.created_at,
        row_number() OVER (
          PARTITION BY snapshot.user_id
          ORDER BY snapshot.created_at DESC, snapshot.id DESC
        ) AS recent_rank,
        row_number() OVER (
          PARTITION BY snapshot.user_id,
            date_trunc('day', snapshot.created_at AT TIME ZONE 'UTC')
          ORDER BY snapshot.created_at DESC, snapshot.id DESC
        ) AS daily_rank,
        row_number() OVER (
          PARTITION BY snapshot.user_id,
            date_trunc('week', snapshot.created_at AT TIME ZONE 'UTC')
          ORDER BY snapshot.created_at DESC, snapshot.id DESC
        ) AS weekly_rank
      FROM data_snapshots snapshot
      WHERE snapshot.snapshot_kind = 'automatic'
        AND NOT snapshot.pinned
        AND snapshot.status = 'verified'
        AND snapshot.deletion_status IS NULL
    ), retention_candidates AS (
      SELECT ranked.id
      FROM ranked_verified ranked
      WHERE ranked.recent_rank > ${AUTOMATIC_SNAPSHOT_RECENT_LIMIT}
        AND NOT (
          ranked.created_at >= ${now.toISOString()}::timestamptz - interval '30 days'
          AND ranked.daily_rank = 1
        )
        AND NOT (
          ranked.created_at >= ${now.toISOString()}::timestamptz - interval '90 days'
          AND ranked.weekly_rank = 1
        )
    ), candidates AS MATERIALIZED (
      SELECT candidate.id
      FROM (
        SELECT id FROM retention_candidates
        UNION
        SELECT snapshot.id
        FROM data_snapshots snapshot
        WHERE snapshot.snapshot_kind = 'automatic'
          AND NOT snapshot.pinned
          AND snapshot.status = 'failed'
          AND snapshot.deletion_status IS NULL
          AND snapshot.created_at <= ${now.toISOString()}::timestamptz - interval '7 days'
        UNION
        SELECT snapshot.id
        FROM data_snapshots snapshot
        WHERE snapshot.snapshot_kind = 'automatic'
          AND NOT snapshot.pinned
          AND (
            snapshot.deletion_status = 'delete_failed'
            OR (
              snapshot.deletion_status = 'deleting'
              AND snapshot.deletion_lease_expires_at <= ${now.toISOString()}::timestamptz
            )
          )
      ) candidate
      ORDER BY candidate.id
      LIMIT ${SNAPSHOT_MAINTENANCE_BATCH}
    ), claimed AS (
      UPDATE data_snapshots snapshot
      SET deletion_status = 'deleting',
          deletion_requested_at = coalesce(
            snapshot.deletion_requested_at,
            ${now.toISOString()}::timestamptz
          ),
          deletion_attempts = snapshot.deletion_attempts + 1,
          deletion_failure_reason = NULL,
          deletion_lease_id = ${leaseId}::uuid,
          deletion_lease_expires_at = ${leaseExpiresAt.toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
      FROM candidates
      WHERE snapshot.id = candidates.id
        AND snapshot.snapshot_kind = 'automatic'
        AND NOT snapshot.pinned
        AND (
          snapshot.deletion_status IS NULL
          OR snapshot.deletion_status = 'delete_failed'
          OR (
            snapshot.deletion_status = 'deleting'
            AND snapshot.deletion_lease_expires_at <= ${now.toISOString()}::timestamptz
          )
        )
      RETURNING
        snapshot.id,
        snapshot.user_id,
        snapshot.object_path,
        snapshot.object_etag,
        snapshot.deletion_lease_id
    )
    SELECT
      id::text,
      user_id::text,
      object_path,
      object_etag,
      deletion_lease_id::text
    FROM claimed
    ORDER BY id
  `);
  return resultRows(result).map(
    (row): ClaimedSnapshot => ({
      id: String(row.id),
      userId: String(row.user_id),
      objectPath: String(row.object_path),
      objectEtag: row.object_etag == null ? null : String(row.object_etag),
      leaseId: String(row.deletion_lease_id),
    })
  );
}

async function recordDeletionFailure(
  db: Db,
  claimed: ClaimedSnapshot,
  now: Date,
  reason: string
) {
  await db.execute(sql`
    WITH failed AS (
      UPDATE data_snapshots snapshot
      SET deletion_status = 'delete_failed',
          deletion_failure_reason = ${reason},
          deletion_lease_id = NULL,
          deletion_lease_expires_at = NULL,
          updated_at = ${now.toISOString()}::timestamptz
      WHERE snapshot.id = ${claimed.id}::uuid
        AND snapshot.user_id = ${claimed.userId}::uuid
        AND snapshot.deletion_status = 'deleting'
        AND snapshot.deletion_lease_id = ${claimed.leaseId}::uuid
      RETURNING snapshot.id, snapshot.user_id, snapshot.name
    ), audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        failed.user_id,
        'system',
        'snapshot.retention_failed',
        'data_snapshot',
        failed.id::text,
        'Automatic snapshot retention could not remove ' || failed.name,
        jsonb_build_object('reason', ${reason}::text)
      FROM failed
    )
    SELECT id FROM failed
  `);
}

async function finalizeDeletion(db: Db, claimed: ClaimedSnapshot) {
  const result = await db.execute(sql`
    WITH deleted AS (
      DELETE FROM data_snapshots snapshot
      WHERE snapshot.id = ${claimed.id}::uuid
        AND snapshot.user_id = ${claimed.userId}::uuid
        AND snapshot.snapshot_kind = 'automatic'
        AND NOT snapshot.pinned
        AND snapshot.deletion_status = 'deleting'
        AND snapshot.deletion_lease_id = ${claimed.leaseId}::uuid
      RETURNING snapshot.id, snapshot.user_id, snapshot.name,
        snapshot.reason, snapshot.deletion_attempts
    ), audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        deleted.user_id,
        'system',
        'snapshot.retention_delete',
        'data_snapshot',
        deleted.id::text,
        'Expired automatic safety snapshot ' || deleted.name,
        jsonb_build_object(
          'reason', deleted.reason,
          'deletionAttempts', deleted.deletion_attempts
        )
      FROM deleted
    )
    SELECT id FROM deleted
  `);
  if (!resultRows(result)[0]) {
    throw new Error("Snapshot deletion tombstone could not be finalized.");
  }
}

const snapshotObjectPattern =
  /^snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.wtbk$/i;

export async function runSnapshotLifecycle(
  db: Db,
  dependencies: SnapshotLifecycleDependencies = {}
): Promise<SnapshotLifecycleResult> {
  const now = dependencies.now ?? new Date();
  const store = dependencies.store ?? getSnapshotObjectStore();
  const result: SnapshotLifecycleResult = {
    staleCreatingMarkedFailed: 0,
    claimedForDeletion: 0,
    deletedSnapshots: 0,
    deletionFailures: 0,
    orphanObjectsFound: 0,
    orphanObjectsDeleted: 0,
    orphanObjectsPendingDeletion: 0,
    orphanDeletionFailures: 0,
    recentOrphanObjects: 0,
    storeScanFailure: null,
  };

  result.staleCreatingMarkedFailed = await markStaleCreatingSnapshots(db, now);
  const claimed = await claimDeletionCandidates(db, now);
  result.claimedForDeletion = claimed.length;
  for (const snapshot of claimed) {
    let objectDeleted = false;
    try {
      await store.delete(snapshot.objectPath, snapshot.objectEtag);
      objectDeleted = true;
      if (dependencies.failAfterObjectDelete) {
        throw new Error("Injected failure after snapshot object deletion.");
      }
      await finalizeDeletion(db, snapshot);
      result.deletedSnapshots += 1;
    } catch (error) {
      result.deletionFailures += 1;
      logDiagnosticEvent("snapshot.lifecycle_deletion_failed", {
        objectDeleted,
        errorCategory: categorizeDiagnosticError(error, "storage"),
      });
      if (!objectDeleted) {
        await recordDeletionFailure(db, snapshot, now, errorMessage(error));
      }
    }
  }

  try {
    const metadata = await db.execute(sql`
      SELECT object_path FROM data_snapshots ORDER BY object_path
    `);
    const knownPaths = new Set(
      resultRows(metadata).map((row) => String(row.object_path))
    );
    const objects = await store.list("snapshots/");
    const unmatched = objects.filter(
      (object) =>
        snapshotObjectPattern.test(object.pathname) &&
        !knownPaths.has(object.pathname)
    );
    result.orphanObjectsFound = unmatched.length;
    const cutoff = new Date(
      now.getTime() - SNAPSHOT_ORPHAN_GRACE_DAYS * 24 * 60 * 60_000
    );
    const eligibleOrphans = unmatched.filter((object) => object.uploadedAt <= cutoff);
    const expired = eligibleOrphans.slice(0, SNAPSHOT_MAINTENANCE_BATCH);
    result.orphanObjectsPendingDeletion = eligibleOrphans.length - expired.length;
    result.recentOrphanObjects = unmatched.length - eligibleOrphans.length;
    for (const object of expired) {
      try {
        await store.delete(object.pathname, object.etag);
        result.orphanObjectsDeleted += 1;
      } catch (error) {
        result.orphanDeletionFailures += 1;
        logDiagnosticEvent("snapshot.lifecycle_orphan_delete_failed", {
          errorCategory: categorizeDiagnosticError(error, "storage"),
        });
      }
    }
  } catch (error) {
    result.storeScanFailure = errorMessage(error);
    logDiagnosticEvent("snapshot.lifecycle_store_scan_failed", {
      errorCategory: categorizeDiagnosticError(error, "storage"),
    });
  }

  return result;
}

export function snapshotLifecycleNeedsAttention(result: SnapshotLifecycleResult) {
  return (
    result.deletionFailures > 0 ||
    result.orphanDeletionFailures > 0 ||
    result.storeScanFailure !== null
  );
}
