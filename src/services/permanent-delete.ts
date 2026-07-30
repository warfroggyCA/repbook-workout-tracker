import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  permanentDeleteGrants,
  type PermanentDeletePreviewData,
} from "@/db/schema";

export const PERMANENT_DELETE_CONFIRMATION = "DELETE PERMANENTLY";
export const PERMANENT_DELETE_GRANT_SECONDS = 10 * 60;
export const PERMANENT_DELETE_FRESH_SECONDS = 5 * 60;

const uuidSchema = z.string().uuid();

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function validPreview(value: unknown): value is PermanentDeletePreviewData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preview = value as Partial<PermanentDeletePreviewData>;
  return (
    typeof preview.operationId === "string" &&
    typeof preview.rootType === "string" &&
    typeof preview.summary === "string" &&
    !!preview.deleteCounts &&
    typeof preview.deleteCounts === "object" &&
    !!preview.preservedCounts &&
    typeof preview.preservedCounts === "object" &&
    Array.isArray(preview.blockers)
  );
}

export async function getPermanentDeletePreview(
  db: Db,
  userId: string,
  operationId: string
): Promise<PermanentDeletePreviewData | null> {
  if (!uuidSchema.safeParse(operationId).success) return null;
  const row = resultRows(
    await db.execute(sql`
      SELECT permanent_delete_archive_preview(
        ${userId}::uuid,
        ${operationId}::uuid
      ) AS preview
    `)
  )[0];
  if (!validPreview(row?.preview)) return null;
  const preview = row.preview;
  const reference = resultRows(await db.execute(sql`
    SELECT count(*)::int AS count
    FROM program_drafts draft
    WHERE draft.user_id = ${userId}::uuid
      AND draft.status = 'open'
      AND EXISTS (
        SELECT 1 FROM archive_operation_records member
        WHERE member.operation_id = ${operationId}::uuid
          AND member.user_id = ${userId}::uuid
          AND member.entity_type = 'exercise'
          AND draft.document::text LIKE '%' || member.entity_id || '%'
      )
  `))[0];
  const count = Number(reference?.count ?? 0);
  if (count > 0) {
    return {
      ...preview,
      blockers: [...preview.blockers, {
        key: "exercise_in_program_draft",
        message: "A custom exercise is still used in an open Program draft.",
        count,
      }],
    };
  }
  return preview;
}

export async function createPermanentDeleteGrant(
  db: Db,
  userId: string,
  operationId: string,
  provider: "github" | "dev-login",
  authenticatedAt: Date | null = null,
  now = new Date()
) {
  const preview = await getPermanentDeletePreview(db, userId, operationId);
  if (!preview) return { ok: false as const, reason: "Active Archive action not found." };
  if (preview.blockers.length > 0) {
    return {
      ok: false as const,
      reason: "Resolve the listed linked Archive records before deleting this scope.",
    };
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + PERMANENT_DELETE_GRANT_SECONDS * 1000);
  await db.insert(permanentDeleteGrants).values({
    userId,
    operationId,
    tokenHash: tokenHash(token),
    provider,
    preview,
    requestedAt: now,
    authenticatedAt,
    expiresAt,
  });
  return { ok: true as const, token, expiresAt, preview };
}

export async function authenticatePermanentDeleteGrant(
  db: Db,
  userId: string,
  token: string,
  provider: "github" | "dev-login",
  providerAuthenticatedAt: Date,
  now = new Date()
) {
  const result = await db.execute(sql`
    UPDATE permanent_delete_grants
    SET authenticated_at = ${providerAuthenticatedAt.toISOString()}::timestamptz
    WHERE user_id = ${userId}::uuid
      AND token_hash = ${tokenHash(token)}
      AND provider = ${provider}
      AND purpose = 'archive.permanent_delete'
      AND authenticated_at IS NULL
      AND consumed_at IS NULL
      AND requested_at <= ${providerAuthenticatedAt.toISOString()}::timestamptz
      AND expires_at > ${now.toISOString()}::timestamptz
      AND preview = permanent_delete_archive_preview(user_id, operation_id)
    RETURNING operation_id
  `);
  const row = resultRows(result)[0];
  return row ? { ok: true as const, operationId: String(row.operation_id) } : {
    ok: false as const,
    reason: "The identity check did not match a current permanent-delete request.",
  };
}

export async function getValidPermanentDeleteGrant(
  db: Db,
  userId: string,
  operationId: string,
  token: string | null,
  now = new Date()
) {
  if (!token || !uuidSchema.safeParse(operationId).success) return null;
  return db.query.permanentDeleteGrants.findFirst({
    where: and(
      eq(permanentDeleteGrants.userId, userId),
      eq(permanentDeleteGrants.operationId, operationId),
      eq(permanentDeleteGrants.tokenHash, tokenHash(token)),
      gt(permanentDeleteGrants.expiresAt, now),
      gt(
        permanentDeleteGrants.authenticatedAt,
        new Date(now.getTime() - PERMANENT_DELETE_FRESH_SECONDS * 1000)
      ),
      isNotNull(permanentDeleteGrants.authenticatedAt),
      sql`(${permanentDeleteGrants.preview} - 'preservedCounts') = (permanent_delete_archive_preview(${userId}::uuid, ${operationId}::uuid) - 'preservedCounts')`,
      isNull(permanentDeleteGrants.consumedAt)
    ),
  });
}

export async function permanentlyDeleteArchiveOperation(
  db: Db,
  userId: string,
  operationId: string,
  token: string,
  confirmation: string,
  safetySnapshotId: string,
  failAfterStep: string | null = null
) {
  try {
    const row = resultRows(
      await db.execute(sql`
        SELECT permanently_delete_archive_operation(
          ${userId}::uuid,
          ${operationId}::uuid,
          ${tokenHash(token)},
          ${confirmation},
          ${safetySnapshotId}::uuid,
          ${failAfterStep}
        ) AS preview
      `)
    )[0];
    if (!validPreview(row?.preview)) {
      return { ok: false as const, reason: "Permanent deletion did not complete." };
    }
    return { ok: true as const, preview: row.preview };
  } catch (error) {
    const cause = error instanceof Error
      ? (error.cause as { message?: unknown } | undefined)
      : undefined;
    const message =
      typeof cause?.message === "string"
        ? cause.message
        : error instanceof Error
          ? error.message
          : "Permanent deletion failed.";
    if (message.includes("identity grant")) {
      return { ok: false as const, reason: "Identity verification expired or was already used. Verify again." };
    }
    if (message.includes("dependencies")) {
      return { ok: false as const, reason: "Linked Archive records changed. Review the updated preview first." };
    }
    if (message.includes("confirmation phrase")) {
      return { ok: false as const, reason: `Type ${PERMANENT_DELETE_CONFIRMATION} exactly.` };
    }
    return { ok: false as const, reason: message.slice(0, 500) };
  }
}
