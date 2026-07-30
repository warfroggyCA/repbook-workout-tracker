import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { readMigrationFiles } from "drizzle-orm/migrator";

const CONFIRMATION = "production-hardening-123e1a0";
const databaseUrl = process.env.DATABASE_URL?.trim();
const expectedCurrentTag = process.env.EXPECTED_CURRENT_MIGRATION?.trim();
const targetTag = process.env.TARGET_MIGRATION?.trim();

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (process.env.CONFIRM_NEON_MIGRATION !== CONFIRMATION) {
  throw new Error("The exact Neon migration confirmation is required.");
}
if (!expectedCurrentTag) {
  throw new Error("EXPECTED_CURRENT_MIGRATION is required.");
}

const migrationsFolder = fileURLToPath(
  new URL("../src/db/migrations", import.meta.url)
);
const journalPath = new URL(
  "../src/db/migrations/meta/_journal.json",
  import.meta.url
);
const journalFile = JSON.parse(await readFile(journalPath, "utf8"));
const tagsByMillis = new Map(
  journalFile.entries.map((entry) => [Number(entry.when), entry.tag])
);
const millisByTag = new Map(
  journalFile.entries.map((entry) => [entry.tag, Number(entry.when)])
);
const migrations = readMigrationFiles({ migrationsFolder });
const expectedCurrentMillis = millisByTag.get(expectedCurrentTag);
if (!expectedCurrentMillis) {
  throw new Error(`Unknown expected migration tag ${expectedCurrentTag}.`);
}
if (migrations.some((migration) => !tagsByMillis.has(migration.folderMillis))) {
  throw new Error("Every migration file must have one journal tag.");
}
const latestMigrationMillis = Math.max(
  ...migrations.map((migration) => migration.folderMillis)
);
const targetMillis = targetTag
  ? millisByTag.get(targetTag)
  : latestMigrationMillis;
if (!targetMillis) {
  throw new Error(`Unknown target migration tag ${targetTag}.`);
}
if (targetMillis < expectedCurrentMillis) {
  throw new Error("TARGET_MIGRATION cannot be older than EXPECTED_CURRENT_MIGRATION.");
}

const sql = neon(databaseUrl);
await sql.transaction((tx) => [
  tx.query("CREATE SCHEMA IF NOT EXISTS drizzle"),
  tx.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `),
]);

const [starting] = await sql`
  SELECT count(*)::int AS rows, max(created_at)::bigint::text AS newest
  FROM drizzle.__drizzle_migrations
`;
const startingMillis = starting.newest == null ? null : Number(starting.newest);
if (startingMillis !== expectedCurrentMillis) {
  throw new Error(
    `Expected ${expectedCurrentTag}, found ${
      startingMillis == null
        ? "an empty migration journal"
        : tagsByMillis.get(startingMillis) ?? startingMillis
    }.`
  );
}

let previousMillis = startingMillis;
for (const migration of migrations) {
  if (migration.folderMillis <= startingMillis) continue;
  if (migration.folderMillis > targetMillis) break;
  const tag = tagsByMillis.get(migration.folderMillis);
  const expectedPrevious = previousMillis ?? -1;
  const guard = `
    DO $$
    DECLARE current_migration bigint;
    BEGIN
      SELECT max(created_at) INTO current_migration
      FROM drizzle.__drizzle_migrations;
      IF COALESCE(current_migration, -1) <> ${expectedPrevious} THEN
        RAISE EXCEPTION 'Migration journal changed while rollout was running.';
      END IF;
    END $$
  `;
  try {
    await sql.transaction(
      (tx) => [
        tx.query("LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE"),
        tx.query(guard),
        ...migration.sql
          .filter((statement) => statement.trim().length > 0)
          .map((statement) => tx.query(statement)),
        tx.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           VALUES ($1, $2)`,
          [migration.hash, migration.folderMillis]
        ),
      ],
      { isolationLevel: "Serializable" }
    );
  } catch (error) {
    process.stderr.write(
      `Migration ${tag} failed; that migration transaction was rolled back.\n`
    );
    throw error;
  }
  previousMillis = migration.folderMillis;
  process.stdout.write(`Applied ${tag}.\n`);
}

const [finished] = await sql`
  SELECT count(*)::int AS rows, max(created_at)::bigint::text AS newest
  FROM drizzle.__drizzle_migrations
`;
const newestMillis = finished.newest == null ? null : Number(finished.newest);
if (newestMillis !== targetMillis) {
  throw new Error(
    `Expected rollout to stop at ${tagsByMillis.get(targetMillis)}, found ${
      newestMillis == null ? "an empty migration journal" : tagsByMillis.get(newestMillis) ?? newestMillis
    }.`
  );
}
process.stdout.write(
  `${JSON.stringify({
    journalRows: finished.rows,
    newestTag: newestMillis == null ? null : tagsByMillis.get(newestMillis),
    targetTag: tagsByMillis.get(targetMillis),
  })}\n`
);
