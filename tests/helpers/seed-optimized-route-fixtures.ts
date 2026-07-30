import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  healthActivities,
  users,
  workoutTemplates,
} from "@/db/schema";
import { normalizeActivityInput } from "@/services/activities";
import { archiveActivityRecord } from "@/services/archive";
import { acquireExpensiveOperation } from "@/services/expensive-operations";
import { startWorkoutSession } from "@/services/session-lifecycle";
import { createDataSnapshot } from "@/services/snapshots";
import { OPTIMIZED_ROUTE_ACTIVITY_ID } from "./optimized-route-fixture-values";

const ownerEmail = "owner@example.com";

async function insertActivity(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  title: string,
  minutesAgo: number,
  id?: string
) {
  const startedAt = new Date(Date.now() - minutesAgo * 60_000);
  const values = normalizeActivityInput({
    activityType: "walk",
    title,
    startedAtISO: startedAt.toISOString(),
    timezone: "America/Toronto",
    durationMinutes: 30,
    distanceValue: 2.5,
    distanceUnit: "km",
    intensity: "moderate",
    elevationValue: null,
    elevationUnit: "m",
    averageHeartRateBpm: null,
    energyKcal: null,
    notes: "Optimized route verification fixture.",
  });
  const [activity] = await db
    .insert(healthActivities)
    .values({ ...(id ? { id } : {}), userId, ...values })
    .returning({ id: healthActivities.id });
  return activity.id;
}

async function main() {
  if (
    process.env.NODE_ENV === "production" ||
    !process.env.PGLITE_DIR ||
    process.env.DATABASE_URL
  ) {
    throw new Error(
      "Optimized route fixtures require the disposable local PGlite harness."
    );
  }

  const db = await getDb();
  const [owner] = await db.select().from(users).where(eq(users.email, ownerEmail));
  if (!owner) throw new Error("The optimized route fixture owner was not seeded.");

  const [template] = await db.select().from(workoutTemplates).limit(1);
  if (!template) throw new Error("The optimized route fixture template was not seeded.");
  await startWorkoutSession(db, owner.id, template.id, 45);

  await insertActivity(
    db,
    owner.id,
    "CSP route activity",
    60,
    OPTIMIZED_ROUTE_ACTIVITY_ID
  );
  const archivedActivityId = await insertActivity(
    db,
    owner.id,
    "CSP archived route activity",
    120
  );
  const archived = await archiveActivityRecord(db, owner.id, archivedActivityId);
  if (!archived.ok) throw new Error(archived.reason);

  const snapshot = await createDataSnapshot(db, owner.id, {
    name: "CSP optimized route snapshot",
    reason: "verification",
  });
  if (!snapshot.ok) throw new Error(snapshot.reason);

  // The optimized server runs with production safeguards, so it must not read
  // the fixture's local snapshot object. A real bounded snapshot-operation
  // lease exercises the restore page's normal busy-state branch before that
  // read while still proving the concrete dynamic route's nonce and CSP.
  const snapshotLease = await acquireExpensiveOperation(
    db,
    owner.id,
    "snapshot"
  );
  if (!snapshotLease.ok) {
    throw new Error("The optimized restore route lease could not be seeded.");
  }

  const client = (db as { $client?: { close?: () => Promise<void> } }).$client;
  await client?.close?.();
  console.log(
    JSON.stringify({
      archivedOperationId: archived.operationId,
      snapshotId: snapshot.snapshotId,
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
