import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";

export type ExpensiveOperationKind =
  | "import"
  | "export"
  | "backup"
  | "snapshot";

export type ExpensiveOperationLease = {
  token: string;
  kind: ExpensiveOperationKind;
};

const POLICY: Record<
  ExpensiveOperationKind,
  { cooldownSeconds: number; leaseSeconds: number }
> = {
  // Staging and confirmation are separate user steps. The lease prevents
  // overlap; confirmation checks staged state before doing expensive work.
  import: { cooldownSeconds: 0, leaseSeconds: 180 },
  export: { cooldownSeconds: 5, leaseSeconds: 120 },
  backup: { cooldownSeconds: 30, leaseSeconds: 180 },
  // Preview and restore are consecutive user steps, so snapshot work uses the
  // lease as its admission boundary without delaying the next step.
  snapshot: { cooldownSeconds: 0, leaseSeconds: 300 },
};

export async function acquireExpensiveOperation(
  db: Db,
  userId: string,
  kind: ExpensiveOperationKind,
  now = new Date()
): Promise<
  | { ok: true; lease: ExpensiveOperationLease }
  | { ok: false; retryAfterSeconds: number }
> {
  const policy = POLICY[kind];
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + policy.leaseSeconds * 1000);
  const [row] = resultRows(await db.execute(sql`
    INSERT INTO expensive_operation_leases (
      user_id, kind, lease_token, lease_expires_at, last_started_at, updated_at
    )
    VALUES (
      ${userId}::uuid,
      ${kind},
      ${token}::uuid,
      ${expiresAt.toISOString()}::timestamptz,
      ${now.toISOString()}::timestamptz,
      ${now.toISOString()}::timestamptz
    )
    ON CONFLICT (user_id, kind) DO UPDATE
    SET lease_token = EXCLUDED.lease_token,
        lease_expires_at = EXCLUDED.lease_expires_at,
        last_started_at = EXCLUDED.last_started_at,
        updated_at = EXCLUDED.updated_at
    WHERE (
        expensive_operation_leases.lease_token IS NULL
        OR expensive_operation_leases.lease_expires_at < ${now.toISOString()}::timestamptz
      )
      AND expensive_operation_leases.last_started_at
        <= ${now.toISOString()}::timestamptz - (${policy.cooldownSeconds} * interval '1 second')
    RETURNING lease_token
  `));
  return row
    ? { ok: true, lease: { token, kind } }
    : { ok: false, retryAfterSeconds: Math.max(policy.cooldownSeconds, 1) };
}

export async function releaseExpensiveOperation(
  db: Db,
  userId: string,
  lease: ExpensiveOperationLease,
  now = new Date()
) {
  await db.execute(sql`
    UPDATE expensive_operation_leases
    SET lease_token = NULL,
        lease_expires_at = NULL,
        last_completed_at = ${now.toISOString()}::timestamptz,
        updated_at = ${now.toISOString()}::timestamptz
    WHERE user_id = ${userId}::uuid
      AND kind = ${lease.kind}
      AND lease_token = ${lease.token}::uuid
  `);
}

export function expensiveOperationMessage(kind: ExpensiveOperationKind) {
  return kind === "import"
    ? "An import was just started for this account. Wait briefly and try again."
    : kind === "snapshot"
      ? "A snapshot operation was just started for this account. Wait briefly and try again."
      : "A download was just prepared for this account. Wait briefly and try again.";
}

export async function runExpensiveOperation<T>(
  db: Db,
  userId: string,
  kind: ExpensiveOperationKind,
  work: () => Promise<T>
): Promise<
  | { ok: true; value: T }
  | { ok: false; reason: string; retryAfterSeconds: number }
> {
  const acquired = await acquireExpensiveOperation(db, userId, kind);
  if (!acquired.ok) {
    return {
      ok: false,
      reason: expensiveOperationMessage(kind),
      retryAfterSeconds: acquired.retryAfterSeconds,
    };
  }
  try {
    return { ok: true, value: await work() };
  } finally {
    await releaseExpensiveOperation(db, userId, acquired.lease);
  }
}
