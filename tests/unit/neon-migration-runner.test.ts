import { describe, expect, it, vi } from "vitest";
import { migrateEmptyNeonDatabase } from "../../scripts/lib/neon-migration-runner.mjs";

describe("disposable Neon migration runner", () => {
  it("keeps every statement and its journal write in one transaction", async () => {
    const transactions: Array<Array<{ statement: string; params?: unknown[] }>> = [];
    const sql = {
      transaction: vi.fn(async (build: (tx: { query: (statement: string, params?: unknown[]) => object }) => object[]) => {
        const queries: Array<{ statement: string; params?: unknown[] }> = [];
        const tx = {
          query(statement: string, params?: unknown[]) {
            const query = { statement, params };
            queries.push(query);
            return query;
          },
        };
        build(tx);
        transactions.push(queries);
      }),
    };

    await migrateEmptyNeonDatabase(sql, [{
      sql: [
        "CREATE TEMP TABLE migration_state (id integer)",
        "INSERT INTO migration_state VALUES (1)",
        "SELECT id FROM migration_state",
      ],
      hash: "migration-hash",
      folderMillis: 123,
    }]);

    expect(transactions).toHaveLength(2);
    expect(transactions[1].map((query) => query.statement)).toEqual([
      "CREATE TEMP TABLE migration_state (id integer)",
      "INSERT INTO migration_state VALUES (1)",
      "SELECT id FROM migration_state",
      expect.stringContaining("INSERT INTO drizzle.__drizzle_migrations"),
    ]);
    expect(transactions[1].at(-1)?.params).toEqual(["migration-hash", 123]);
  });
});
