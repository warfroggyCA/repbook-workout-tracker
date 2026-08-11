import "server-only";

import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";

/**
 * Complete current semantics shown by one-publication equipment-fit reviews.
 * The database function is VOLATILE so atomic callers that depend on the
 * already-locked owner profile observe changes committed while they waited.
 */
export function ownerEquipmentFitReviewRevisionExpression(userId: string | SQL) {
  return sql`owner_equipment_fit_review_revision(${userId}::uuid)`;
}

export async function loadOwnerEquipmentFitReviewRevision(
  db: Db,
  userId: string,
): Promise<string | null> {
  const [row] = resultRows<{ revision: string }>(await db.execute(sql`
    SELECT ${ownerEquipmentFitReviewRevisionExpression(userId)} AS revision
  `));
  return row?.revision ?? null;
}
