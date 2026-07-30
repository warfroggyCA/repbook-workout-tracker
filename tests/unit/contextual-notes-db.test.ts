import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  contextualNoteCreateInputSchema,
  type ContextualNoteCreateInput,
} from "@/lib/contextual-note-contract";
import {
  archiveContextualNote,
  createContextualNote,
  editContextualNote,
  listContextualNotes,
} from "@/services/contextual-notes";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

const ids = {
  user: "10000000-0000-4000-8000-000000000090",
  other: "10000000-0000-4000-8000-000000000091",
  exercise: "20000000-0000-4000-8000-000000000090",
  session: "30000000-0000-4000-8000-000000000090",
  sessionExercise: "40000000-0000-4000-8000-000000000090",
  occurrence: "50000000-0000-4000-8000-000000000090",
  completedSet: "55000000-0000-4000-8000-000000000090",
  otherCompletedSet: "55000000-0000-4000-8000-000000000091",
  createKey: "60000000-0000-4000-8000-000000000090",
  editKey: "60000000-0000-4000-8000-000000000091",
  staleKey: "60000000-0000-4000-8000-000000000092",
};

async function seed(database: TestDatabase) {
  await database.client.exec(`
    INSERT INTO users (id, email) VALUES
      ('${ids.user}', 'context-owner@example.test'),
      ('${ids.other}', 'context-other@example.test');
    INSERT INTO user_profiles (user_id, unit) VALUES
      ('${ids.user}', 'lb'), ('${ids.other}', 'lb');
    INSERT INTO exercises (id, name, movement_pattern, primary_muscles, load_type)
    VALUES ('${ids.exercise}', 'Context Squat', 'squat', '["quadriceps"]'::jsonb, 'barbell');
    INSERT INTO workout_sessions (id, user_id, timezone, local_date, started_at, status)
    VALUES ('${ids.session}', '${ids.user}', 'America/Toronto', '2026-07-22', '2026-07-22T16:00:00Z', 'in_progress');
    INSERT INTO session_exercises (id, session_id, exercise_id, order_idx)
    VALUES ('${ids.sessionExercise}', '${ids.session}', '${ids.exercise}', 0);
    INSERT INTO completed_sets (id, session_exercise_id, set_no, reps, client_key)
    VALUES
      ('${ids.completedSet}', '${ids.sessionExercise}', 1, 8, 'context-set-one'),
      ('${ids.otherCompletedSet}', '${ids.sessionExercise}', 2, 8, 'context-set-two');
    INSERT INTO session_occurrences (
      id, session_id, session_exercise_id, kind, origin, sequence_idx,
      kind_ordinal, planned_exercise_id, planned_reps_min, planned_reps_max,
      planned_load, planned_load_unit, planned_rest_sec, outcome, revision,
      resolved_at, completed_set_id
    ) VALUES (
      '${ids.occurrence}', '${ids.session}', '${ids.sessionExercise}',
      'working_set', 'planned', 0, 1, '${ids.exercise}', 8, 10, 100, 'lb', 90,
      'completed', 1, '2026-07-22T16:09:00Z', '${ids.completedSet}'
    );
  `);
}

function createInput(
  overrides: Partial<ContextualNoteCreateInput> = {},
): ContextualNoteCreateInput {
  return {
    clientKey: ids.createKey,
    body: "My knee felt better after widening my stance.",
    coachVisible: true,
    inputMode: "typed",
    recordedAt: "2026-07-22T16:10:00.000Z",
    attachmentKind: "set",
    sessionId: ids.session,
    sessionExerciseId: ids.sessionExercise,
    occurrenceId: ids.occurrence,
    completedSetId: null,
    capturedContext: {
      schemaVersion: 1,
      destination: "workout",
      workflow: "active_set",
      workoutPhase: "working",
      originatedFromSimulation: false,
      programDay: null,
      plannedExercise: { id: ids.exercise, name: "Context Squat" },
      performedExercise: { id: ids.exercise, name: "Context Squat" },
      occurrence: {
        id: ids.occurrence,
        kind: "working_set",
        ordinal: 1,
        outcome: "pending",
      },
      loadRepetitions: {
        plannedLoad: 100,
        plannedLoadUnit: "lb",
        plannedRepsMin: 8,
        plannedRepsMax: 10,
      },
      restContext: {
        plannedSeconds: 90,
        remainingSeconds: 90,
        state: "resting",
      },
      reviewContext: null,
    },
    ...overrides,
  } as ContextualNoteCreateInput;
}

describe("contextual note durable service", () => {
  let database: TestDatabase | undefined;
  afterEach(async () => database?.close());

  it("saves an owned attachment once, replays it, and rejects changed payload reuse", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);

    const first = await createContextualNote(database.db, ids.user, createInput());
    expect(first).toMatchObject({
      outcome: "saved",
      note: {
        attachmentKind: "set",
        sessionId: ids.session,
        occurrenceId: ids.occurrence,
        revision: 1,
        coachVisible: true,
      },
    });
    await expect(
      createContextualNote(database.db, ids.user, createInput()),
    ).resolves.toMatchObject({ outcome: "replayed", note: { id: first.outcome === "saved" ? first.note.id : "" } });
    await expect(
      createContextualNote(database.db, ids.user, createInput({ body: "Changed payload" })),
    ).resolves.toEqual({ outcome: "conflict" });

    const counts = await database.client.query<{ notes: number; revisions: number }>(`
      SELECT (SELECT count(*)::int FROM contextual_notes) AS notes,
             (SELECT count(*)::int FROM contextual_note_revisions) AS revisions
    `);
    expect(counts.rows[0]).toEqual({ notes: 1, revisions: 1 });
  });

  it("does not reveal or accept foreign and mismatched attachments", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);

    await expect(
      createContextualNote(database.db, ids.other, createInput()),
    ).resolves.toEqual({ outcome: "not_found" });
    await expect(
      createContextualNote(
        database.db,
        ids.user,
        createInput({
          clientKey: "60000000-0000-4000-8000-000000000093",
          sessionId: "30000000-0000-4000-8000-000000000099",
        }),
      ),
    ).resolves.toEqual({ outcome: "not_found" });
    expect(await listContextualNotes(database.db, ids.user)).toEqual([]);
  });

  it("paginates beyond one hundred notes without hiding older records", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    await database.client.exec(`
      WITH inserted AS (
        INSERT INTO contextual_notes (
          user_id, client_key, creation_payload_hash, body, coach_visible,
          input_mode, attachment_kind, captured_context, recorded_at
        )
        SELECT
          '${ids.user}', gen_random_uuid(), repeat('a', 64),
          'Paged note ' || source.idx, true, 'typed', 'general',
          '{"schemaVersion":1}'::jsonb,
          '2026-07-22T12:00:00Z'::timestamptz + source.idx * interval '1 second'
        FROM generate_series(1, 101) AS source(idx)
        RETURNING id, user_id, body, coach_visible, input_mode, client_key,
          recorded_at
      )
      INSERT INTO contextual_note_revisions (
        note_id, user_id, revision, client_key, canonical_payload_hash,
        body, coach_visible, input_mode, created_at
      )
      SELECT id, user_id, 1, client_key, repeat('b', 64), body,
        coach_visible, input_mode, recorded_at
      FROM inserted;
    `);

    const first = await listContextualNotes(database.db, ids.user, { limit: 50 });
    const second = await listContextualNotes(database.db, ids.user, {
      limit: 50,
      before: { recordedAt: first.at(-1)!.recordedAt, id: first.at(-1)!.id },
    });
    const third = await listContextualNotes(database.db, ids.user, {
      limit: 50,
      before: { recordedAt: second.at(-1)!.recordedAt, id: second.at(-1)!.id },
    });
    const all = [...first, ...second, ...third];

    expect([first.length, second.length, third.length]).toEqual([50, 50, 1]);
    expect(new Set(all.map((note) => note.id)).size).toBe(101);
    expect(all.map((note) => note.body)).toContain("Paged note 1");
  });

  it("binds rest to the acknowledged occurrence result and rejects another same-exercise set", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);

    await expect(createContextualNote(database.db, ids.user, createInput({
      clientKey: "60000000-0000-4000-8000-000000000097",
      attachmentKind: "rest",
      completedSetId: ids.otherCompletedSet,
    }))).resolves.toEqual({ outcome: "not_found" });

    await expect(createContextualNote(database.db, ids.user, createInput({
      clientKey: "60000000-0000-4000-8000-000000000099",
      attachmentKind: "rest",
      completedSetId: ids.completedSet,
    }))).resolves.toMatchObject({
      outcome: "saved",
      note: {
        attachmentKind: "rest",
        occurrenceId: ids.occurrence,
        completedSetId: ids.completedSet,
      },
    });

    const context = JSON.stringify(contextualNoteCreateInputSchema.parse(createInput()).capturedContext);
    await expect(database.db.execute(sql`
      INSERT INTO contextual_notes (
        user_id, client_key, creation_payload_hash, body, coach_visible,
        input_mode, attachment_kind, session_id, session_exercise_id,
        occurrence_id, completed_set_id, captured_context, recorded_at
      ) VALUES (
        ${ids.user}::uuid, ${"60000000-0000-4000-8000-000000000098"}::uuid,
        ${"a".repeat(64)}, 'Invalid cross-link', true, 'typed', 'rest',
        ${ids.session}::uuid, ${ids.sessionExercise}::uuid,
        ${ids.occurrence}::uuid, ${ids.otherCompletedSet}::uuid,
        ${context}::jsonb, now()
      )
    `)).rejects.toThrow();
    expect(await listContextualNotes(database.db, ids.user)).toHaveLength(1);
  });

  it("edits with a revision receipt, replays safely, and rejects stale or conflicting edits", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    const created = await createContextualNote(database.db, ids.user, createInput());
    if (created.outcome !== "saved") throw new Error("Fixture note was not saved.");

    const edit = {
      noteId: created.note.id,
      clientKey: ids.editKey,
      expectedRevision: 1,
      body: "Reviewed wording after dictation.",
      coachVisible: false,
      inputMode: "reviewed_dictation" as const,
    };
    await expect(editContextualNote(database.db, ids.user, edit)).resolves.toMatchObject({
      outcome: "saved",
      note: { revision: 2, body: edit.body, coachVisible: false, inputMode: "reviewed_dictation" },
    });
    await expect(editContextualNote(database.db, ids.user, edit)).resolves.toMatchObject({
      outcome: "replayed",
      note: { revision: 2 },
    });
    await expect(
      editContextualNote(database.db, ids.user, { ...edit, body: "Conflicting reuse" }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      editContextualNote(database.db, ids.user, {
        ...edit,
        clientKey: ids.staleKey,
        body: "A stale browser must not overwrite revision two.",
      }),
    ).resolves.toEqual({ outcome: "stale" });
    await expect(editContextualNote(database.db, ids.other, {
      ...edit,
      clientKey: "60000000-0000-4000-8000-000000000094",
      expectedRevision: 2,
    })).resolves.toEqual({ outcome: "not_found" });
  });

  it("keeps private observations out of Coach queries and makes captured context immutable", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    const created = await createContextualNote(
      database.db,
      ids.user,
      createInput({ coachVisible: false }),
    );
    if (created.outcome !== "saved") throw new Error("Fixture note was not saved.");

    expect(await listContextualNotes(database.db, ids.user, { coachVisibleOnly: true })).toEqual([]);
    expect(await listContextualNotes(database.db, ids.user)).toHaveLength(1);
    await expect(database.db.execute(sql`
      UPDATE contextual_notes SET captured_context = captured_context || '{"workflow":"forged"}'::jsonb
      WHERE id = ${created.note.id}::uuid
    `)).rejects.toThrow();
    const unchanged = await listContextualNotes(database.db, ids.user);
    expect(unchanged[0]?.capturedContext.workflow).toBe("active_set");
  });

  it("archives an independently attached note with a CAS operation and keeps every revision", async () => {
    database = await createMigratedTestDatabase();
    await seed(database);
    const source = createInput();
    const created = await createContextualNote(database.db, ids.user, {
      clientKey: "60000000-0000-4000-8000-000000000096",
      body: source.body,
      coachVisible: source.coachVisible,
      inputMode: source.inputMode,
      recordedAt: source.recordedAt,
      capturedContext: source.capturedContext,
      attachmentKind: "general",
    });
    if (created.outcome !== "saved") throw new Error("Fixture note was not saved.");

    await expect(archiveContextualNote(database.db, ids.user, {
      noteId: created.note.id,
      expectedRevision: 2,
    })).resolves.toEqual({ outcome: "stale" });
    const archived = await archiveContextualNote(database.db, ids.user, {
      noteId: created.note.id,
      expectedRevision: 1,
    });
    expect(archived).toMatchObject({ outcome: "archived" });
    await expect(archiveContextualNote(database.db, ids.user, {
      noteId: created.note.id,
      expectedRevision: 1,
    })).resolves.toEqual({ outcome: "not_found" });
    expect(await listContextualNotes(database.db, ids.user)).toEqual([]);
    expect(await listContextualNotes(database.db, ids.user, { includeArchived: true })).toHaveLength(1);

    const durable = await database.client.query<{ notes: number; revisions: number; members: number }>(`
      SELECT (SELECT count(*)::int FROM contextual_notes) AS notes,
             (SELECT count(*)::int FROM contextual_note_revisions) AS revisions,
             (SELECT count(*)::int FROM archive_operation_records WHERE entity_type = 'contextual_note') AS members
    `);
    expect(durable.rows[0]).toEqual({ notes: 1, revisions: 1, members: 1 });
  });
});
