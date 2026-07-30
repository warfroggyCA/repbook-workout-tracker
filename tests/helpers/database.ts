import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq, sql } from "drizzle-orm";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import * as schema from "@/db/schema";
import {
  completedSets,
  sessionExercises,
  workoutSessions,
} from "@/db/schema";
import { workoutLocalDate } from "@/lib/workout-calendar";

export type TestDatabase = {
  client: PGlite;
  db: PgliteDatabase<typeof schema>;
  close: () => Promise<void>;
};

async function createMigrationFolderThrough(lastTag: string) {
  const source = "./src/db/migrations";
  const journal = JSON.parse(
    await readFile(`${source}/meta/_journal.json`, "utf8")
  ) as { entries: Array<{ tag: string }> };
  const lastIndex = journal.entries.findIndex(({ tag }) => tag === lastTag);
  if (lastIndex < 0) {
    throw new Error(`Unknown migration tag: ${lastTag}`);
  }
  const root = await mkdtemp(join(tmpdir(), "workout-migrations-"));
  await mkdir(join(root, "meta"));
  const previousEntries = journal.entries.slice(0, lastIndex + 1);
  await writeFile(
    join(root, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: previousEntries })
  );
  await Promise.all(
    previousEntries.map(({ tag }) =>
      copyFile(`${source}/${tag}.sql`, join(root, `${tag}.sql`))
    )
  );
  return root;
}

async function migrateThrough(
  db: PgliteDatabase<typeof schema>,
  lastTag: string
) {
  const folder = await createMigrationFolderThrough(lastTag);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export async function createTestDatabaseAtMigration(
  lastTag: string
): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrateThrough(db, lastTag);
  return { client, db, close: () => client.close() };
}

export async function migrateTestDatabaseThrough(
  database: TestDatabase,
  lastTag: string
) {
  await migrateThrough(database.db, lastTag);
}

export async function getPublicSchemaFingerprint(database: TestDatabase) {
  const [objects, columns, constraints, indexes, triggers, functions, enums] =
    await Promise.all([
      database.client.query<{
        kind: string;
        name: string;
      }>(`
        SELECT class.relkind::text AS kind, class.relname AS name
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = current_schema()
          AND class.relkind IN ('r', 'p', 'v', 'm', 'S')
        ORDER BY class.relkind, class.relname
      `),
      database.client.query<{
        table_name: string;
        column_name: string;
        position: number;
        type: string;
        not_null: boolean;
        default_expression: string | null;
        identity: string;
        generated: string;
      }>(`
        SELECT
          class.relname AS table_name,
          attribute.attname AS column_name,
          attribute.attnum::int AS position,
          format_type(attribute.atttypid, attribute.atttypmod) AS type,
          attribute.attnotnull AS not_null,
          pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression,
          attribute.attidentity::text AS identity,
          attribute.attgenerated::text AS generated
        FROM pg_attribute attribute
        JOIN pg_class class ON class.oid = attribute.attrelid
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        LEFT JOIN pg_attrdef default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE namespace.nspname = current_schema()
          AND class.relkind IN ('r', 'p', 'v', 'm')
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY class.relname, attribute.attnum
      `),
      database.client.query<{
        table_name: string;
        constraint_name: string;
        constraint_type: string;
        definition: string;
      }>(`
        SELECT
          class.relname AS table_name,
          constraint_record.conname AS constraint_name,
          constraint_record.contype::text AS constraint_type,
          pg_get_constraintdef(constraint_record.oid, true) AS definition
        FROM pg_constraint constraint_record
        JOIN pg_class class ON class.oid = constraint_record.conrelid
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = current_schema()
        ORDER BY class.relname, constraint_record.conname
      `),
      database.client.query<{
        table_name: string;
        index_name: string;
        definition: string;
      }>(`
        SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
        FROM pg_indexes
        WHERE schemaname = current_schema()
        ORDER BY tablename, indexname
      `),
      database.client.query<{
        table_name: string;
        trigger_name: string;
        definition: string;
      }>(`
        SELECT
          class.relname AS table_name,
          trigger_record.tgname AS trigger_name,
          pg_get_triggerdef(trigger_record.oid, true) AS definition
        FROM pg_trigger trigger_record
        JOIN pg_class class ON class.oid = trigger_record.tgrelid
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = current_schema()
          AND NOT trigger_record.tgisinternal
        ORDER BY class.relname, trigger_record.tgname
      `),
      database.client.query<{
        function_name: string;
        arguments: string;
        result: string;
        language: string;
        volatility: string;
        security_definer: boolean;
        source: string;
      }>(`
        SELECT
          procedure.proname AS function_name,
          pg_get_function_identity_arguments(procedure.oid) AS arguments,
          pg_get_function_result(procedure.oid) AS result,
          language.lanname AS language,
          procedure.provolatile::text AS volatility,
          procedure.prosecdef AS security_definer,
          procedure.prosrc AS source
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE namespace.nspname = current_schema()
        ORDER BY procedure.proname, pg_get_function_identity_arguments(procedure.oid)
      `),
      database.client.query<{
        enum_name: string;
        label: string;
        position: number;
      }>(`
        SELECT
          type_record.typname AS enum_name,
          enum_record.enumlabel AS label,
          enum_record.enumsortorder::real AS position
        FROM pg_type type_record
        JOIN pg_namespace namespace ON namespace.oid = type_record.typnamespace
        JOIN pg_enum enum_record ON enum_record.enumtypid = type_record.oid
        WHERE namespace.nspname = current_schema()
        ORDER BY type_record.typname, enum_record.enumsortorder
      `),
    ]);

  return {
    objects: objects.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
    functions: functions.rows,
    enums: enums.rows,
  };
}

export async function createMigratedTestDatabase(
  mode: "fresh" | "previous-version" = "fresh"
): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  if (mode === "previous-version") {
    const journal = JSON.parse(
      await readFile("./src/db/migrations/meta/_journal.json", "utf8")
    ) as { entries: Array<{ tag: string }> };
    const previousTag = journal.entries.at(-2)?.tag;
    if (!previousTag) throw new Error("Previous migration is missing.");
    await migrateThrough(db, previousTag);
  }
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  return { client, db, close: () => client.close() };
}

export function createStartBarrier(participants: number) {
  if (!Number.isInteger(participants) || participants < 1) {
    throw new Error("A start barrier needs at least one participant.");
  }
  let arrivals = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async function waitAtBarrier() {
    arrivals += 1;
    if (arrivals === participants) release?.();
    await released;
  };
}

export async function runSimultaneously<T>(
  participants: number,
  operation: (index: number) => Promise<T>
): Promise<T[]> {
  const start = createStartBarrier(participants);
  return Promise.all(
    Array.from({ length: participants }, (_, index) =>
      (async () => {
        await start();
        return operation(index);
      })()
    )
  );
}

export class InjectedBoundaryFailure extends Error {
  constructor(readonly boundary: string) {
    super(`Injected failure after ${boundary}`);
    this.name = "InjectedBoundaryFailure";
  }
}

export type WriteCheckpoint = (boundary: string) => void | Promise<void>;

export function failAfterBoundary(targetBoundary: string): WriteCheckpoint {
  return async (boundary) => {
    if (boundary === targetBoundary) throw new InjectedBoundaryFailure(boundary);
  };
}

export async function seedLargeWorkoutHistory(
  db: Db,
  input: {
    userId: string;
    exerciseId: string;
    sessionCount: number;
    setsPerSession?: number;
    startAt?: Date;
  }
) {
  const setsPerSession = input.setsPerSession ?? 3;
  const startAt = input.startAt ?? new Date("2025-01-01T12:00:00.000Z");
  const sessions = Array.from({ length: input.sessionCount }, (_, index) => {
    const startedAt = new Date(startAt.getTime() + index * 86_400_000);
    return {
      id: crypto.randomUUID(),
      userId: input.userId,
      templateName: `History fixture ${index + 1}`,
      status: "completed" as const,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 45 * 60_000),
      timezone: "America/Toronto",
      localDate: workoutLocalDate(startedAt, "America/Toronto"),
    };
  });
  const exercises = sessions.map((session, index) => ({
    id: crypto.randomUUID(),
    sessionId: session.id,
    exerciseId: input.exerciseId,
    orderIdx: 0,
    targetSets: setsPerSession,
    targetRepsMin: 8,
    targetRepsMax: 10,
    targetLoad: 100 + (index % 10) * 5,
    targetLoadUnit: "lb" as const,
  }));
  const sets = exercises.flatMap((exercise, sessionIndex) =>
    Array.from({ length: setsPerSession }, (_, setIndex) => ({
      sessionExerciseId: exercise.id,
      setNo: setIndex + 1,
      weight: 100 + (sessionIndex % 10) * 5,
      weightUnit: "lb" as const,
      reps: 8 + (setIndex % 3),
      clientKey: `fixture-${sessionIndex}-${setIndex}`,
    }))
  );

  const chunkSize = 500;
  for (let index = 0; index < sessions.length; index += chunkSize) {
    await db.insert(workoutSessions).values(sessions.slice(index, index + chunkSize));
  }
  for (let index = 0; index < exercises.length; index += chunkSize) {
    await db.insert(sessionExercises).values(exercises.slice(index, index + chunkSize));
  }
  for (let index = 0; index < sets.length; index += chunkSize) {
    await db.insert(completedSets).values(sets.slice(index, index + chunkSize));
  }

  return {
    sessionIds: sessions.map(({ id }) => id),
    sessionExerciseIds: exercises.map(({ id }) => id),
    sessionCount: sessions.length,
    setCount: sets.length,
  };
}

export async function getWorkoutIntegrity(db: Db, userId: string) {
  const result = await db.execute<{
    sessions: number;
    session_exercises: number;
    completed_sets: number;
    orphan_exercises: number;
    orphan_sets: number;
  }>(sql`
    select
      (select count(*)::int from workout_sessions where user_id = ${userId}) as sessions,
      (select count(*)::int
         from session_exercises se
         join workout_sessions ws on ws.id = se.session_id
        where ws.user_id = ${userId}) as session_exercises,
      (select count(*)::int
         from completed_sets cs
         join session_exercises se on se.id = cs.session_exercise_id
         join workout_sessions ws on ws.id = se.session_id
        where ws.user_id = ${userId}) as completed_sets,
      (select count(*)::int
         from session_exercises se
         left join workout_sessions ws on ws.id = se.session_id
        where ws.id is null) as orphan_exercises,
      (select count(*)::int
         from completed_sets cs
         left join session_exercises se on se.id = cs.session_exercise_id
        where se.id is null) as orphan_sets
  `);
  return resultRows(result)[0];
}

export async function countActiveSessions(db: Db, userId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workoutSessions)
    .where(
      and(
        eq(workoutSessions.userId, userId),
        eq(workoutSessions.status, "in_progress")
      )
    );
  return row.count;
}
