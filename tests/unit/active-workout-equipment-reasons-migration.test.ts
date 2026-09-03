import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const migrationSql = readFileSync(
  "src/db/migrations/0085_active_workout_equipment_reasons.sql",
  "utf8",
);

describe("active-workout equipment reason migration", () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`
      CREATE TYPE substitution_reason AS ENUM (
        'variety',
        'equipment_busy',
        'discomfort',
        'other'
      )
    `);
  });

  afterEach(async () => {
    await client.close();
  });

  it("adds only the bounded unavailable-or-incompatible value and is idempotent", async () => {
    await client.exec(migrationSql);
    await client.exec(migrationSql);

    const result = await client.query<{ enumlabel: string }>(`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE pg_type.typname = 'substitution_reason'
      ORDER BY enumsortorder
    `);

    expect(result.rows.map((row) => row.enumlabel)).toEqual([
      "variety",
      "equipment_busy",
      "equipment_unavailable_incompatible",
      "discomfort",
      "other",
    ]);
  });
});
