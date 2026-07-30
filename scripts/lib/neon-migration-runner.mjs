export async function migrateEmptyNeonDatabase(sql, migrations) {
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

  for (const migration of migrations) {
    await sql.transaction((tx) => [
      ...migration.sql
        .filter((statement) => statement.trim().length > 0)
        .map((statement) => tx.query(statement)),
      tx.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis]
      ),
    ]);
  }
}
