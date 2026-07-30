// Intent suite: proves staging exposes one truthful review and duplicate source
// uploads cannot retain another raw copy.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  historyImportBatches,
  importEvents,
  users,
} from "@/db/schema";
import { HEVY_HEADERS, parseHevyCsv } from "@/services/hevy-import";
import { stageHevyImport } from "@/services/hevy-staging";
import {
  createMigratedTestDatabase,
  createStartBarrier,
  runSimultaneously,
  type TestDatabase,
} from "../helpers/database";

function csvRow(values: Array<string | number>) {
  return values
    .map((value) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    })
    .join(",");
}

function hevyCsv(workout: string, date: string) {
  return [
    HEVY_HEADERS.join(","),
    csvRow([
      workout,
      `${date}, 6:00 PM`,
      `${date}, 7:00 PM`,
      "Stage fixture",
      "Bench Press (Barbell)",
      "",
      "",
      0,
      "normal",
      135,
      8,
      "",
      "",
      8,
    ]),
  ].join("\n");
}

describe("Hevy staging production findings", () => {
  let database: TestDatabase;
  let userId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `hevy-stage-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
  }, 30_000);

  afterEach(async () => database.close());

  it("keeps exactly one truthful current review when uploads race", async () => {
    const ready = createStartBarrier(2);
    const inputs = [
      {
        csv: hevyCsv("Stage A", "Jun 1, 2026"),
        timezone: "America/Toronto",
        originalFilename: "stage-a.csv",
      },
      {
        csv: hevyCsv("Stage B", "Jun 2, 2026"),
        timezone: "America/Toronto",
        originalFilename: "stage-b.csv",
      },
    ];
    const results = await runSimultaneously(2, (index) =>
      stageHevyImport(database.db, userId, inputs[index], async (boundary) => {
        if (boundary === "hevy-stage-parsed") await ready();
      })
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ status: 409 }),
    ]);
    const events = await database.db.select().from(importEvents);
    expect(events).toHaveLength(1);
    expect(events.filter(({ status }) => status === "parsed")).toHaveLength(1);
  });

  it("rejects a duplicate confirmed upload without storing another raw copy", async () => {
    const csv = hevyCsv("Duplicate", "Jun 3, 2026");
    const parsed = parseHevyCsv(csv, "America/Toronto");
    const [sourceEvent] = await database.db
      .insert(importEvents)
      .values({ userId, source: "csv", rawPayload: "", status: "confirmed" })
      .returning({ id: importEvents.id });
    await database.db.insert(historyImportBatches).values({
      userId,
      importEventId: sourceEvent.id,
      source: "hevy",
      originalFilename: "original.csv",
      fileHash: parsed.fileHash,
      timezone: "America/Toronto",
      summary: {
        workouts: 1,
        exerciseOccurrences: 1,
        sets: 1,
        warmupSets: 0,
        supersetGroups: 0,
        excludedExercises: 0,
        warnings: 0,
      },
    });

    const result = await stageHevyImport(database.db, userId, {
      csv,
      timezone: "America/Toronto",
      originalFilename: "duplicate.csv",
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    const events = await database.db.select().from(importEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "confirmed", rawPayload: "" });
  });
});
