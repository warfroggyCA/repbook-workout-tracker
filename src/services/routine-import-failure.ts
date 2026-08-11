import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { aiParsingEvents, importEvents } from "@/db/schema";

export async function discardFailedRoutineImport(
  db: Db,
  userId: string,
  importEventId: string,
  parsingEventIds: readonly string[] = [],
) {
  const discardedImports = await db
    .update(importEvents)
    .set({
      status: "discarded",
      rawPayload: "",
      parsedPayload: null,
      rawRedactedAt: new Date(),
      retentionExpiresAt: null,
    })
    .where(
      and(
        eq(importEvents.id, importEventId),
        eq(importEvents.userId, userId),
        eq(importEvents.status, "raw"),
      ),
    )
    .returning({ id: importEvents.id });
  if (discardedImports.length !== 1) {
    throw new Error("Routine import was not available to discard");
  }

  for (const parsingEventId of new Set(parsingEventIds)) {
    const redactedParsingEvents = await db
      .update(aiParsingEvents)
      .set({
        rawInput: "",
        rawOutput: null,
        parsedJson: null,
        ambiguities: [],
        rawRedactedAt: new Date(),
        retentionExpiresAt: null,
      })
      .where(
        and(
          eq(aiParsingEvents.id, parsingEventId),
          eq(aiParsingEvents.userId, userId),
          eq(aiParsingEvents.confirmed, false),
        ),
      )
      .returning({ id: aiParsingEvents.id });
    if (redactedParsingEvents.length !== 1) {
      throw new Error("Routine parsing event was not available to redact");
    }
  }
}
