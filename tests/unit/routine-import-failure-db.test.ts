import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { aiParsingEvents, importEvents, users } from "@/db/schema";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

import { discardFailedRoutineImport } from "@/services/routine-import-failure";

describe("failed routine import privacy", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  async function createUser(label: string) {
    const [user] = await database.db
      .insert(users)
      .values({ email: `${label}-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    return user.id;
  }

  it("discards the failed paste and redacts every unconfirmed parsing event", async () => {
    const userId = await createUser("routine-failure");
    const [event] = await database.db
      .insert(importEvents)
      .values({
        userId,
        source: "paste",
        rawPayload: "private synthetic routine",
        parsedPayload: { temporary: true },
      })
      .returning({ id: importEvents.id });
    const parsingEvents = await database.db
      .insert(aiParsingEvents)
      .values([
        {
          userId,
          scope: "import",
          task: "routine_parse",
          rawInput: "private synthetic routine",
          rawOutput: "private model output",
          parsedJson: { temporary: true },
        },
        {
          userId,
          scope: "import",
          task: "exercise_map",
          rawInput: "private exercise names",
          rawOutput: "private mapping output",
          parsedJson: { temporary: true },
        },
      ])
      .returning({ id: aiParsingEvents.id });

    await discardFailedRoutineImport(
      database.db,
      userId,
      event.id,
      parsingEvents.map((parsingEvent) => parsingEvent.id),
    );

    expect(
      await database.db.query.importEvents.findFirst({
        where: eq(importEvents.id, event.id),
      }),
    ).toMatchObject({
      status: "discarded",
      rawPayload: "",
      parsedPayload: null,
      rawRedactedAt: expect.any(Date),
      retentionExpiresAt: null,
    });
    expect(await database.db.query.aiParsingEvents.findMany()).toEqual([
      expect.objectContaining({
        rawInput: "",
        rawOutput: null,
        parsedJson: null,
        ambiguities: [],
        rawRedactedAt: expect.any(Date),
        retentionExpiresAt: null,
      }),
      expect.objectContaining({
        rawInput: "",
        rawOutput: null,
        parsedJson: null,
        ambiguities: [],
        rawRedactedAt: expect.any(Date),
        retentionExpiresAt: null,
      }),
    ]);
  });

  it("cannot discard another user's staged routine", async () => {
    const ownerId = await createUser("routine-owner");
    const otherUserId = await createUser("routine-other");
    const [event] = await database.db
      .insert(importEvents)
      .values({
        userId: ownerId,
        source: "paste",
        rawPayload: "owner-only routine",
      })
      .returning({ id: importEvents.id });

    await expect(
      discardFailedRoutineImport(database.db, otherUserId, event.id),
    ).rejects.toThrow("not available to discard");
    expect(
      await database.db.query.importEvents.findFirst({
        where: eq(importEvents.id, event.id),
      }),
    ).toMatchObject({ status: "raw", rawPayload: "owner-only routine" });
  });
});
