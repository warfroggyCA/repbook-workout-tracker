import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const journal = JSON.parse(
  await readFile("./src/db/migrations/meta/_journal.json", "utf8")
);
const expectedCount = journal.entries.length;
const latest = journal.entries.at(-1);
if (!latest) throw new Error("The migration journal is empty.");

const client = new PGlite();
const db = drizzle(client);
const startedAt = performance.now();
await migrate(db, { migrationsFolder: "./src/db/migrations" });

const [applied, tables, sentinels] = await Promise.all([
  client.query(
    "select count(*)::int as count, max(created_at)::bigint as latest_created_at from drizzle.__drizzle_migrations"
  ),
  client.query(
    "select count(*)::int as count from information_schema.tables where table_schema = current_schema()"
  ),
  client.query(`
    select
      to_regclass('public.workout_sessions') is not null as workouts,
      to_regclass('public.data_snapshots') is not null as snapshots,
      to_regclass('public.recovery_runs') is not null as recovery,
      to_regclass('public.exercise_media_assets') is not null as media,
      to_regclass('public.program_drafts') is not null as program_drafts,
      to_regclass('public.analysis_package_manifests') is not null as analysis_packages,
      to_regclass('public.production_data_repair_preview') is not null as production_data_preview,
      to_regclass('public.program_editor_repair_preview') is not null as program_editor_preview,
      exists (
        select 1 from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'session_exercises'
          and column_name = 'substitution_reason'
      ) as alternatives,
      exists (
        select 1 from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'programs'
          and column_name = 'current_version_id'
      ) as program_current_version,
      exists (
        select 1 from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'programs'
          and column_name = 'recommendation_revision'
      ) as program_recommendation_revision,
      exists (
        select 1 from pg_trigger
        where tgname = 'published_program_versions_immutable'
          and not tgisinternal
      ) as program_tree_immutability,
      exists (
        select 1 from pg_trigger
        where tgname = 'pending_recommendation_revision_guard'
          and not tgisinternal
      ) as recommendation_revision_guard,
      (
        select count(*) = 6
        from information_schema.columns column_info
        join (values
          ('barbell_configs', 'bar_weight'),
          ('barbell_configs', 'collar_weight'),
          ('plate_inventory', 'denomination'),
          ('exercise_equipment_requirements', 'min_weight'),
          ('exercise_prescriptions', 'target_load'),
          ('session_exercises', 'target_load')
        ) expected(table_name, column_name)
          on expected.table_name = column_info.table_name
         and expected.column_name = column_info.column_name
        where column_info.table_schema = current_schema()
          and column_info.data_type = 'numeric'
          and column_info.numeric_precision = 7
          and column_info.numeric_scale = 2
      ) as numeric_loads
  `),
]);

const appliedRow = applied.rows[0];
if (appliedRow.count !== expectedCount) {
  throw new Error(
    `Expected ${expectedCount} migrations but found ${appliedRow.count}.`
  );
}
if (Number(appliedRow.latest_created_at) !== latest.when) {
  throw new Error(
    `Latest applied migration does not match ${latest.tag}.`
  );
}
if (Object.values(sentinels.rows[0]).some((present) => present !== true)) {
  throw new Error("One or more final-schema sentinels are missing.");
}

console.log(
  JSON.stringify({
    migrations: appliedRow.count,
    latest: latest.tag,
    tables: tables.rows[0].count,
    elapsedMs: Math.round(performance.now() - startedAt),
  })
);
await client.close();
