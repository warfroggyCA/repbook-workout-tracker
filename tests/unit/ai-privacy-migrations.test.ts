import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resultRows } from "@/db/result";
import { coachingInsights, importEvents } from "@/db/schema";
import {
  createTestDatabaseAtMigration,
  migrateTestDatabaseThrough,
  type TestDatabase,
} from "../helpers/database";

const EXPAND = "0034_expand_ai_privacy_controls";
const PREVIEW = "0035_ai_privacy_repair_preview";
const CONTRACT = "0036_contract_ai_privacy_controls";

describe("AI and privacy expand/preview/contract migrations", () => {
  let database: TestDatabase | undefined;

  afterEach(async () => database?.close());

  it("previews ambiguous production rows and blocks the contract until explicitly repaired", async () => {
    database = await createTestDatabaseAtMigration(EXPAND);
    const user = { id: crypto.randomUUID() };
    await database.client.query(
      "INSERT INTO users (id, email) VALUES ($1, $2)",
      [user.id, `ai-repair-${crypto.randomUUID()}@example.com`],
    );
    const events = await database.db
      .insert(importEvents)
      .values([
        {
          userId: user.id,
          source: "csv",
          rawPayload: "first raw file",
          parsedPayload: { kind: "hevy_history", schemaVersion: "1" },
          status: "parsed",
        },
        {
          userId: user.id,
          source: "csv",
          rawPayload: "second raw file",
          parsedPayload: { kind: "hevy_history", schemaVersion: "1" },
          status: "parsed",
        },
      ])
      .returning({ id: importEvents.id });
    const [generating] = await database.db
      .insert(coachingInsights)
      .values({
        userId: user.id,
        kind: "live_assistant",
        contentMd: "",
        dataDigest: {},
        responseStatus: "generating",
      })
      .returning({ id: coachingInsights.id });

    await migrateTestDatabaseThrough(database, PREVIEW);
    const preview = resultRows(
      await database.db.execute(
        "SELECT issue, entity_type, entity_id FROM ai_privacy_repair_preview ORDER BY issue, entity_id"
      )
    );
    expect(preview).toEqual([
      expect.objectContaining({
        issue: "hevy.multiple_current_stages",
        entity_id: user.id,
      }),
      expect.objectContaining({
        issue: "live_coach.incomplete_generation_lease",
        entity_id: generating.id,
      }),
    ]);
    await expect(
      migrateTestDatabaseThrough(database, CONTRACT)
    ).rejects.toThrow("repair preview");

    await database.db
      .update(importEvents)
      .set({
        status: "discarded",
        rawPayload: "",
        parsedPayload: null,
        rawRedactedAt: new Date(),
      })
      .where(eq(importEvents.id, events[0].id));
    await database.db
      .update(coachingInsights)
      .set({ responseStatus: "failed", failureReason: "Recovered abandoned generation" })
      .where(eq(coachingInsights.id, generating.id));
    expect(
      resultRows(await database.db.execute("SELECT * FROM ai_privacy_repair_preview"))
    ).toEqual([]);
    await migrateTestDatabaseThrough(database, CONTRACT);

    await expect(
      database.db.insert(importEvents).values({
        userId: user.id,
        source: "csv",
        rawPayload: "third raw file",
        parsedPayload: { kind: "hevy_history", schemaVersion: "1" },
        status: "parsed",
      })
    ).rejects.toThrow();
  }, 30_000);
});
