import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import schema from "../src/db/schema/index.ts";
import {
  coreLoopNeonFlags,
  prepareCoreLoopNeonRuntime,
} from "./lib/core-loop-neon-guard.mjs";
import { migrateEmptyNeonDatabase } from "./lib/neon-migration-runner.mjs";

const flags = coreLoopNeonFlags(process.argv.slice(2));
const target = prepareCoreLoopNeonRuntime({
  disposableUrl: process.env.DISPOSABLE_NEON_DATABASE_URL,
  productionUrl: process.env.DATABASE_URL,
  allowWrites: flags.allowWrites,
  migrated: flags.migrated,
  runtimeEnvironment: process.env.VERCEL_ENV,
});

const [
  { bootstrapUserAccount },
  { activateProgramAtomically },
  sessionLifecycle,
  { processProgressionJob },
  { mutateSessionEquipmentSelection },
  { captureUserSnapshot },
  snapshotCrypto,
] = await Promise.all([
    import("../src/services/account-bootstrap.ts"),
    import("../src/services/program-activation.ts"),
    import("../src/services/session-lifecycle.ts"),
    import("../src/services/progression-jobs.ts"),
    import("../src/services/session-equipment-selection.ts"),
    import("../src/services/snapshot-capture.ts"),
    import("../src/services/snapshot-crypto.ts"),
  ]);
const { completeWorkoutSession, logWorkoutSet, startWorkoutSession } =
  sessionLifecycle;
const { canonicalJson, decryptSnapshotBytes, encryptSnapshotBytes } = snapshotCrypto;

const raw = neon(target.databaseUrl);
const [schemaState] = await raw`
  SELECT
    count(*) FILTER (WHERE table_schema = 'public')::int AS public_tables,
    count(*) FILTER (WHERE table_schema = 'drizzle')::int AS drizzle_tables
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE'
`;
const existingTables =
  Number(schemaState.public_tables) + Number(schemaState.drizzle_tables);
if (existingTables > 0 && !target.migrated) {
  throw new Error(
    "The target schema is not empty. Re-run with --migrated only after this script migrated the disposable target."
  );
}

const migrationsFolder = fileURLToPath(
  new URL("../src/db/migrations", import.meta.url)
);
const db = drizzle(target.databaseUrl, { schema });
if (existingTables === 0) {
  await migrateEmptyNeonDatabase(
    raw,
    readMigrationFiles({ migrationsFolder })
  );
}

const journal = JSON.parse(
  await readFile(
    new URL("../src/db/migrations/meta/_journal.json", import.meta.url),
    "utf8"
  )
);
const latestMigration = journal.entries.at(-1);
const [migrationState] = await raw`
  SELECT max(created_at)::bigint::text AS newest
  FROM drizzle.__drizzle_migrations
`;
if (Number(migrationState.newest) !== Number(latestMigration.when)) {
  throw new Error("The disposable Neon target is not migrated to the current journal.");
}

const runId = randomUUID();
const account = await bootstrapUserAccount(db, {
  email: `core-loop-${runId}@disposable.test`,
  name: "Disposable core-loop verification",
});
const [exercise] = await db
  .insert(schema.exercises)
  .values({
    userId: account.id,
    name: `Disposable Squat ${runId}`,
    movementPattern: "squat",
    primaryMuscles: ["quadriceps"],
    loadType: "barbell",
    metricType: "weight_reps",
    loadSemantics: "total",
    variantAttributes: { assistance: "none" },
  })
  .returning({ id: schema.exercises.id });
await db.insert(schema.exerciseEquipmentRequirements).values([
  { exerciseId: exercise.id, equipmentType: "barbell" },
  { exerciseId: exercise.id, equipmentType: "plates" },
]);
await db.insert(schema.exerciseExecutionRequirements).values({
  exerciseId: exercise.id,
  requiredProfileKind: "plate_loaded_implement",
  requiresKnownGeometry: true,
  reviewNotes: "Disposable real-proxy release verification",
  reviewedAt: new Date(),
});
const [equipmentItem] = await db
  .insert(schema.equipmentItems)
  .values({
    userId: account.id,
    type: "barbell",
    label: `Disposable Olympic bar ${runId}`,
  })
  .returning({ id: schema.equipmentItems.id });
await Promise.all([
  db.insert(schema.barbellConfigs).values({
    userId: account.id,
    barType: "olympic",
    equipmentItemId: equipmentItem.id,
    unit: "lb",
    loadingKind: "olympic",
    sharedPlatePoolCompatible: true,
    barWeight: 45,
    collarWeight: 0,
    label: "Disposable Olympic bar",
  }),
  db.insert(schema.plateInventory).values({
    userId: account.id,
    denomination: 25,
    unit: "lb",
    quantity: 4,
  }),
]);
const activated = await activateProgramAtomically(db, {
  userId: account.id,
  loadUnit: "lb",
  programName: `Disposable Program ${runId}`,
  days: [{
    name: "Core day",
    exercises: [{
      exerciseId: exercise.id,
      sets: 1,
      repMin: 6,
      repMax: 8,
      targetLoad: 100,
      restSec: 90,
      supersetKey: null,
      notes: null,
    }],
  }],
  changeSummary: "Disposable Neon core-loop verification",
  auditAction: "program.activate",
  auditSummary: "Activated disposable Neon verification Program",
});
if (!activated.ok) throw new Error(`Program activation failed: ${activated.reason}`);
const [template] = await db
  .select({ id: schema.workoutTemplates.id })
  .from(schema.workoutTemplates)
  .where(eq(schema.workoutTemplates.programVersionId, activated.programVersionId));
const started = await startWorkoutSession(db, account.id, template.id, undefined, {
  timezone: "UTC",
});
if (started.existing) {
  throw new Error("The disposable workout unexpectedly replayed a prior start.");
}
const [sessionExercise] = await db
  .select({ id: schema.sessionExercises.id })
  .from(schema.sessionExercises)
  .where(eq(schema.sessionExercises.sessionId, started.sessionId));
if (!sessionExercise) {
  throw new Error("The disposable workout did not copy its planned exercise.");
}

const selectedEquipment = await mutateSessionEquipmentSelection(db, account.id, {
  operation: "select",
  sessionExerciseId: sessionExercise.id,
  equipmentItemId: equipmentItem.id,
  attachmentItemId: null,
  expectedCurrentSnapshotId: null,
  clientKey: randomUUID(),
  provenance: "user_selected",
});
if (
  !("snapshotId" in selectedEquipment) ||
  selectedEquipment.snapshotId == null
) {
  throw new Error(`Equipment selection returned ${selectedEquipment.outcome}.`);
}

const clientKey = randomUUID();
const setInput = {
  sessionExerciseId: sessionExercise.id,
  setNo: 1,
  weight: 100,
  weightUnit: "lb",
  reps: 8,
  rpe: 7,
  clientKey,
  equipmentSnapshotId: selectedEquipment.snapshotId,
  loadEntryMeaning: "total_system",
};
const saved = await logWorkoutSet(db, account.id, setInput);
if (saved.outcome !== "saved") {
  throw new Error(`Set save returned ${saved.outcome}.`);
}
const replay = await logWorkoutSet(db, account.id, setInput);
if (replay.outcome !== "saved") {
  throw new Error(`Set replay returned ${replay.outcome}.`);
}
const conflict = await logWorkoutSet(db, account.id, { ...setInput, reps: 7 });
if (conflict.outcome !== "retry_identity_conflict") {
  throw new Error(`Conflicting set replay returned ${conflict.outcome}.`);
}

const completed = await completeWorkoutSession(
  db,
  { id: account.id, coachingPrefs: account.profile.coachingPrefs },
  { sessionId: started.sessionId }
);
if (completed.alreadyFinished || !completed.progressionJobId) {
  throw new Error("Workout completion did not create its progression handoff.");
}
const progression = await processProgressionJob(db, completed.progressionJobId);
if (progression.status !== "completed") {
  throw new Error(`Progression processing returned ${progression.status}.`);
}

const payload = await captureUserSnapshot(
  db,
  account.id,
  new Date(),
  "core-loop-neon"
);
const plaintext = Buffer.from(canonicalJson(payload), "utf8");
const key = randomBytes(32);
const encrypted = encryptSnapshotBytes(plaintext, key, "core-loop");
const decrypted = decryptSnapshotBytes(encrypted, () => key).plaintext;
const roundTrip = JSON.parse(Buffer.from(decrypted).toString("utf8"));
if (roundTrip.schemaVersion !== payload.schemaVersion) {
  throw new Error("Snapshot capture/decrypt round trip changed the schema version.");
}
if (!roundTrip.tables.workout_sessions?.some((row) => row.id === started.sessionId)) {
  throw new Error("Snapshot round trip omitted the completed workout.");
}

process.stdout.write(
  `${JSON.stringify({
    check: "core-loop-neon",
    migration: latestMigration.tag,
    bootstrap: "ok",
    program: "ok",
    setReplay: replay.outcome,
    setConflict: conflict.outcome,
    equipment: "verified",
    completion: "ok",
    progression: progression.status,
    snapshot: "verified",
  })}\n`
);
