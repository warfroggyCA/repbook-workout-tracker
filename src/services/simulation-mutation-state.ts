import "server-only";

import { createHash } from "node:crypto";
import type { Db } from "@/db";
import {
  captureUserSnapshot,
  snapshotRecordCounts,
} from "@/services/snapshot-capture";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalSimulationMutationTables(
  tables: Record<string, unknown[]>,
) {
  return Object.fromEntries(
    Object.entries(tables)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, rows]) => [
        table,
        rows
          .map((row) => canonicalValue(row))
          .sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
      ]),
  );
}

export async function captureSimulationMutationState(db: Db, userId: string) {
  const snapshot = await captureUserSnapshot(
    db,
    userId,
    new Date(0),
    "simulation-mutation-oracle",
  );
  const canonicalTables = canonicalSimulationMutationTables(snapshot.tables);
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalTables))
    .digest("hex");
  return {
    schemaVersion: snapshot.schemaVersion,
    counts: snapshotRecordCounts({ ...snapshot, tables: canonicalTables }),
    digest,
  };
}
