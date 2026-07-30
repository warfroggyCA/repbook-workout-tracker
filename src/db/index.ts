import * as schema from "./schema";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { isProductionRuntime, optionalEnv } from "@/lib/env";

// Both drivers share the PgDatabase query API for our schema. Interactive
// transactions are avoided app-wide because neon-http does not support them.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

async function createDb(): Promise<Db> {
  const url = optionalEnv("DATABASE_URL");
  if (url) {
    const { drizzle } = await import("drizzle-orm/neon-http");
    return drizzle(url, { schema });
  }
  if (isProductionRuntime()) {
    throw new Error("DATABASE_URL must be configured in production.");
  }
  // Local dev / tests: embedded Postgres (PGlite), persisted to .pglite/
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite(optionalEnv("PGLITE_DIR") ?? "./.pglite");
  return drizzle(client, { schema });
}

const globalDb = globalThis as typeof globalThis & {
  workoutTrackerDbState?: { value?: Promise<Db> };
};

export function getRetryableSingleton<T>(
  state: { value?: Promise<T> },
  create: () => Promise<T>
): Promise<T> {
  const existing = state.value;
  if (existing) return existing;
  const pending = create();
  state.value = pending;
  void pending.catch(() => {
    if (state.value === pending) delete state.value;
  });
  return pending;
}

export function getDb(): Promise<Db> {
  // Route handlers, Server Components, and Server Actions are compiled into
  // separate development bundles. A process-global promise keeps them on the
  // same PGlite connection so writes are immediately visible across bundles.
  const state = (globalDb.workoutTrackerDbState ??= {});
  return getRetryableSingleton(state, createDb);
}
