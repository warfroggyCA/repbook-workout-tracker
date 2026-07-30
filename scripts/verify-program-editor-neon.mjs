import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL?.trim();
const expectedTag = process.env.EXPECTED_CURRENT_MIGRATION?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!expectedTag) throw new Error("EXPECTED_CURRENT_MIGRATION is required.");

const journal = JSON.parse(
  await readFile(new URL("../src/db/migrations/meta/_journal.json", import.meta.url), "utf8")
);
const expectedEntry = journal.entries.find((entry) => entry.tag === expectedTag);
if (!expectedEntry) throw new Error(`Unknown expected migration tag ${expectedTag}.`);

const sql = neon(databaseUrl);
const [migrationState] = await sql`
  SELECT count(*)::int AS rows, max(created_at)::bigint::text AS newest
  FROM drizzle.__drizzle_migrations
`;
if (Number(migrationState.newest) !== Number(expectedEntry.when)) {
  const actual = journal.entries.find(
    (entry) => Number(entry.when) === Number(migrationState.newest)
  )?.tag ?? migrationState.newest ?? "empty journal";
  throw new Error(`Expected ${expectedTag}, found ${actual}.`);
}

const [counts] = await sql`
  SELECT
    (SELECT count(*)::int FROM programs) AS programs,
    (SELECT count(*)::int FROM program_versions) AS program_versions,
    (SELECT count(*)::int FROM workout_templates) AS workout_templates,
    (SELECT count(*)::int FROM workout_template_exercises) AS template_exercises,
    (SELECT count(*)::int FROM workout_sessions) AS workout_sessions,
    (SELECT count(*)::int FROM completed_sets) AS completed_sets,
    (SELECT count(*)::int FROM recommendations
      WHERE status = 'pending' AND archived_at IS NULL) AS pending_recommendations
`;
const [objects] = await sql`
  SELECT
    to_regclass('public.program_editor_repair_preview'::text) IS NOT NULL AS has_preview,
    to_regclass('public.program_drafts'::text) IS NOT NULL AS has_drafts
`;

let repairPreviewRows = null;
if (objects.has_preview) {
  const [preview] = await sql`
    SELECT count(*)::int AS rows FROM program_editor_repair_preview
  `;
  repairPreviewRows = Number(preview.rows);
  if (repairPreviewRows !== 0) {
    throw new Error(
      `Program editor compatibility preview has ${repairPreviewRows} unresolved row(s).`
    );
  }
}

if (Number(expectedEntry.idx) >= 45) {
  const [integrity] = await sql`
    SELECT
      count(*) FILTER (
        WHERE program.status = 'active'
          AND (program.archived_at IS NOT NULL OR program.current_version_id IS NULL)
      )::int AS invalid_active_programs,
      count(*) FILTER (
        WHERE program.current_version_id IS NOT NULL
          AND current_version.program_id IS DISTINCT FROM program.id
      )::int AS wrong_current_programs,
      count(*) FILTER (
        WHERE program.status = 'active'
          AND EXISTS (
            SELECT 1 FROM program_versions newer
            WHERE newer.program_id = program.id
              AND newer.version_no > current_version.version_no
          )
      )::int AS stale_current_programs
    FROM programs program
    LEFT JOIN program_versions current_version
      ON current_version.id = program.current_version_id
  `;
  if (Object.values(integrity).some((value) => Number(value) !== 0)) {
    throw new Error("Program editor post-contract relationship checks failed.");
  }
}

process.stdout.write(`${JSON.stringify({
  migrationRows: migrationState.rows,
  newestTag: expectedTag,
  repairPreviewRows,
  hasDraftTable: objects.has_drafts,
  counts,
})}\n`);
