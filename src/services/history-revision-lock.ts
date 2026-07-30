import { sql } from "drizzle-orm";
import type { Db } from "@/db";

// All completed-history membership/revision writers and progression
// finalizers share this stable per-owner transaction lock. PostgreSQL releases
// it automatically at transaction end.
const HISTORY_REVISION_LOCK_NAMESPACE = 847_221;

export async function acquireHistoryRevisionLock(db: Db, userId: string) {
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${userId}::text, ${HISTORY_REVISION_LOCK_NAMESPACE})
    )
  `);
}

export const historyRevisionLockSql = (userId: string) => sql`
  SELECT pg_advisory_xact_lock(
    hashtextextended(${userId}::text, ${HISTORY_REVISION_LOCK_NAMESPACE})
  )
`;
