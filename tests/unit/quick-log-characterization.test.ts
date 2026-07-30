// Intent suite: proves reviewed quick logs apply atomically, replay by durable
// identity, retain parse provenance, and respect visibility and ordering.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  aiParsingEvents,
  auditLogs,
  completedSets,
  exercises,
  painLogs,
  sessionExercises,
  sessionNotes,
  sessionOccurrences,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import type { LogEntry } from "@/ai/tasks/log-parse/schema";
import { applyQuickLogToDatabase } from "@/services/quick-log-apply";
import {
  createMigratedTestDatabase,
  createStartBarrier,
  runSimultaneously,
  type TestDatabase,
} from "../helpers/database";

describe("quick-log all-or-nothing application", () => {
  let database: TestDatabase;
  let userId: string;
  let exerciseId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db
      .insert(users)
      .values({ email: `quick-log-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId });
    [{ id: exerciseId }] = await database.db
      .insert(exercises)
      .values({
        name: `Quick Log Squat ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: { assistance: "none" },
      })
      .returning({ id: exercises.id });
  }, 30_000);

  afterEach(async () => database.close());

  async function createParsingEvent(
    entries: LogEntry[] = [
      {
        kind: "sets",
        rawExercise: "Squat",
        sets: [
          { weight: 100, weightUnit: "kg", reps: 8, rpeHint: "ok" },
        ],
      },
    ]
  ) {
    const parsedJson = {
      data: { entries },
      confidence: 1,
      ambiguities: [],
      clarifyingQuestions: [],
      unparsed: [],
    };
    const [event] = await database.db
      .insert(aiParsingEvents)
      .values({
        userId,
        scope: "log",
        task: "log_parse",
        rawInput: "reviewed quick log",
        parsedJson,
        confidence: 1,
      })
      .returning({ id: aiParsingEvents.id });
    return {
      parsingEventId: event.id,
      exerciseByEntry: Object.fromEntries(
        entries.flatMap((entry, index) =>
          entry.kind === "sets" || entry.kind === "skip"
            ? [[String(index), exerciseId]]
            : []
        )
      ),
      discardedEntries: [],
      painSeverityByEntry: {},
    };
  }

  async function durableCounts() {
    const [sessions, sessionExerciseRows, sets, occurrences, pain, notes, audits] =
      await Promise.all([
        database.db.select().from(workoutSessions),
        database.db.select().from(sessionExercises),
        database.db.select().from(completedSets),
        database.db.select().from(sessionOccurrences),
        database.db.select().from(painLogs),
        database.db.select().from(sessionNotes),
        database.db.select().from(auditLogs),
      ]);
    return {
      sessions: sessions.length,
      exercises: sessionExerciseRows.length,
      sets: sets.length,
      occurrences: occurrences.length,
      pain: pain.length,
      notes: notes.length,
      audits: audits.length,
    };
  }

  it("converges simultaneous confirmation on one complete result", async () => {
    const input = await createParsingEvent([
      {
        kind: "sets",
        rawExercise: "Squat",
        sets: [
          { weight: 100, weightUnit: "kg", reps: 8, rpeHint: "ok" },
          { weight: 102.5, weightUnit: "kg", reps: 6, rpeHint: "hard" },
        ],
      },
      { kind: "skip", rawExercise: "Squat", reason: "time" },
      { kind: "pain", bodyPart: "knee", severity: 2, rawExercise: null },
      { kind: "note", text: "Felt controlled" },
    ]);
    const ready = createStartBarrier(8);
    const results = await runSimultaneously(8, () =>
      applyQuickLogToDatabase(database.db, userId, input, {
        checkpoint: async (boundary) => {
          if (boundary === "quick-log-ready") await ready();
        },
      })
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const sessionIds = new Set(
      results.flatMap((result) => (result.ok ? [result.sessionId] : []))
    );
    expect(sessionIds.size).toBe(1);
    expect(await durableCounts()).toEqual({
      sessions: 1,
      exercises: 2,
      sets: 2,
      occurrences: 3,
      pain: 1,
      notes: 1,
      audits: 1,
    });
    const savedSets = await database.db.query.completedSets.findMany({
      orderBy: completedSets.setNo,
    });
    expect(savedSets).toEqual([
      expect.objectContaining({
        weight: 100,
        weightUnit: "kg",
        reps: 8,
        metricType: "weight_reps",
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
        observedCompletedAt: null,
        observedCompletionProvenance: "unknown",
        observedCompletionQuality: "unknown",
      }),
      expect.objectContaining({
        weight: 102.5,
        weightUnit: "kg",
        reps: 6,
        metricType: "weight_reps",
        performedSemanticsVersion: 1,
        performedLoadType: "barbell",
        performedLoadSemantics: "total",
        observedCompletedAt: null,
        observedCompletionProvenance: "unknown",
        observedCompletionQuality: "unknown",
      }),
    ]);
    const occurrences = await database.db.query.sessionOccurrences.findMany({
      orderBy: sessionOccurrences.sequenceIdx,
    });
    expect(occurrences).toEqual([
      expect.objectContaining({
        origin: "ad_hoc",
        kind: "working_set",
        sequenceIdx: 0,
        kindOrdinal: 0,
        plannedExerciseId: exerciseId,
        outcome: "completed",
        completedSetId: savedSets[0].id,
      }),
      expect.objectContaining({
        origin: "ad_hoc",
        kind: "working_set",
        sequenceIdx: 1,
        kindOrdinal: 1,
        plannedExerciseId: exerciseId,
        outcome: "completed",
        completedSetId: savedSets[1].id,
      }),
      expect.objectContaining({
        origin: "ad_hoc",
        kind: "working_set",
        sequenceIdx: 2,
        kindOrdinal: 0,
        plannedExerciseId: exerciseId,
        outcome: "skipped",
        outcomeReason: "time",
        completedSetId: null,
      }),
    ]);
    expect(
      await database.db.query.aiParsingEvents.findFirst({
        where: eq(aiParsingEvents.id, input.parsingEventId),
      })
    ).toMatchObject({
      confirmed: true,
      resultSessionId: [...sessionIds][0],
    });
  });

  it("persists the supported repetition and numeric assistance meanings explicitly", async () => {
    const [repetitionExercise, assistedExercise, bandExercise] = await database.db
      .insert(exercises)
      .values([
        {
          name: `Quick Log Push-Up ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
          variantAttributes: {},
        },
        {
          name: `Quick Log Assisted Pull-Up ${crypto.randomUUID()}`,
          movementPattern: "vertical_pull",
          primaryMuscles: ["back"],
          loadType: "external",
          metricType: "assisted_reps",
          loadSemantics: "assistance",
          variantAttributes: { assistance: "assisted" },
        },
        {
          name: `Quick Log Band Row ${crypto.randomUUID()}`,
          movementPattern: "horizontal_pull",
          primaryMuscles: ["back"],
          loadType: "band",
          metricType: "weight_reps",
          loadSemantics: "resistance_band",
          variantAttributes: {},
        },
      ])
      .returning({ id: exercises.id });
    const input = await createParsingEvent([
      {
        kind: "sets",
        rawExercise: "Push-Up",
        sets: [{ weight: null, weightUnit: null, reps: 12, rpeHint: "ok" }],
      },
      {
        kind: "sets",
        rawExercise: "Assisted Pull-Up",
        sets: [{ weight: 35, weightUnit: "lb", reps: 7, rpeHint: "hard" }],
      },
      {
        kind: "sets",
        rawExercise: "Band Row",
        sets: [{ weight: null, weightUnit: null, reps: 15, rpeHint: "ok" }],
      },
    ]);
    input.exerciseByEntry = {
      "0": repetitionExercise.id,
      "1": assistedExercise.id,
      "2": bandExercise.id,
    };

    await expect(
      applyQuickLogToDatabase(database.db, userId, input)
    ).resolves.toEqual({ ok: true, sessionId: expect.any(String) });
    expect(
      await database.db.query.completedSets.findMany({
        orderBy: completedSets.loggedAt,
      })
    ).toEqual([
      expect.objectContaining({
        weight: null,
        weightUnit: null,
        reps: 12,
        metricType: "reps",
        performedSemanticsVersion: 1,
        performedLoadType: "bodyweight",
        performedLoadSemantics: "bodyweight",
        targetMet: null,
      }),
      expect.objectContaining({
        weight: 35,
        weightUnit: "lb",
        reps: 7,
        metricType: "assisted_reps",
        performedSemanticsVersion: 1,
        performedLoadType: "external",
        performedLoadSemantics: "assistance",
        targetMet: null,
      }),
      expect.objectContaining({
        weight: null,
        weightUnit: null,
        reps: 15,
        metricType: "reps",
        performedSemanticsVersion: 1,
        performedLoadType: "band",
        performedLoadSemantics: "resistance_band",
        targetMet: null,
      }),
    ]);
  });

  it("refuses a contradictory reps plus assistance definition before mutation", async () => {
    const [exercise] = await database.db
      .insert(exercises)
      .values({
        name: `Quick Log malformed assistance ${crypto.randomUUID()}`,
        movementPattern: "vertical_pull",
        primaryMuscles: ["back"],
        loadType: "external",
        metricType: "reps",
        loadSemantics: "assistance",
        variantAttributes: { assistance: "assisted" },
      })
      .returning({ id: exercises.id });
    const input = await createParsingEvent([
      {
        kind: "sets",
        rawExercise: "Malformed assistance",
        sets: [{ weight: null, weightUnit: null, reps: 8, rpeHint: "ok" }],
      },
    ]);
    input.exerciseByEntry["0"] = exercise.id;

    await expect(
      applyQuickLogToDatabase(database.db, userId, input),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining(
        "inconsistent assistance measurement definition",
      ),
    });
    expect(await durableCounts()).toEqual({
      sessions: 0,
      exercises: 0,
      sets: 0,
      occurrences: 0,
      pain: 0,
      notes: 0,
      audits: 0,
    });
  });

  it("keeps staged input intact and writes nothing for unsupported or mismatched shapes", async () => {
    const unsafeExercises = await database.db
      .insert(exercises)
      .values([
        {
          name: `Quick Log Duration ${crypto.randomUUID()}`,
          movementPattern: "core",
          primaryMuscles: ["core"],
          loadType: "bodyweight",
          metricType: "duration",
          loadSemantics: "none",
          variantAttributes: {},
        },
        {
          name: `Quick Log Distance ${crypto.randomUUID()}`,
          movementPattern: "carry",
          primaryMuscles: ["core"],
          loadType: "external",
          metricType: "distance_duration",
          loadSemantics: "total",
          variantAttributes: {},
        },
        {
          name: `Quick Log Activity ${crypto.randomUUID()}`,
          movementPattern: "conditioning",
          primaryMuscles: ["full body"],
          loadType: "bodyweight",
          metricType: "activity",
          loadSemantics: "none",
          variantAttributes: {},
        },
        {
          name: `Quick Log Reps ${crypto.randomUUID()}`,
          movementPattern: "horizontal_push",
          primaryMuscles: ["chest"],
          loadType: "bodyweight",
          metricType: "reps",
          loadSemantics: "bodyweight",
          variantAttributes: {},
        },
        {
          name: `Quick Log Assistance ${crypto.randomUUID()}`,
          movementPattern: "vertical_pull",
          primaryMuscles: ["back"],
          loadType: "external",
          metricType: "assisted_reps",
          loadSemantics: "assistance",
          variantAttributes: { assistance: "assisted" },
        },
      ])
      .returning({ id: exercises.id, metricType: exercises.metricType });
    const byMetric = new Map(
      unsafeExercises.map((exercise) => [exercise.metricType, exercise.id])
    );
    const cases: Array<{
      metric: "duration" | "distance_duration" | "activity" | "reps" | "assisted_reps";
      set: Extract<LogEntry, { kind: "sets" }>["sets"][number];
      expected: string;
    }> = [
      {
        metric: "duration",
        set: { weight: null, weightUnit: null, reps: 30, rpeHint: null },
        expected: "activity or compatible duration flow",
      },
      {
        metric: "distance_duration",
        set: { weight: 50, weightUnit: "lb", reps: 20, rpeHint: null },
        expected: "activity or compatible duration flow",
      },
      {
        metric: "activity",
        set: { weight: null, weightUnit: null, reps: 1, rpeHint: null },
        expected: "activity or compatible duration flow",
      },
      {
        metric: "reps",
        set: { weight: 10, weightUnit: "lb", reps: 10, rpeHint: null },
        expected: "records repetitions without a load",
      },
      {
        metric: "assisted_reps",
        set: { weight: null, weightUnit: null, reps: 8, rpeHint: null },
        expected: "numeric assistance",
      },
    ];

    for (const unsafe of cases) {
      const input = await createParsingEvent([
        {
          kind: "sets",
          rawExercise: `Unsafe ${unsafe.metric}`,
          sets: [unsafe.set],
        },
      ]);
      input.exerciseByEntry["0"] = byMetric.get(unsafe.metric)!;
      const eventBefore = await database.db.query.aiParsingEvents.findFirst({
        where: eq(aiParsingEvents.id, input.parsingEventId),
      });

      await expect(
        applyQuickLogToDatabase(database.db, userId, input)
      ).resolves.toEqual({
        ok: false,
        reason: expect.stringContaining(unsafe.expected),
      });
      expect(await durableCounts()).toEqual({
        sessions: 0,
        exercises: 0,
        sets: 0,
        occurrences: 0,
        pain: 0,
        notes: 0,
        audits: 0,
      });
      expect(
        await database.db.query.aiParsingEvents.findFirst({
          where: eq(aiParsingEvents.id, input.parsingEventId),
        })
      ).toMatchObject({
        confirmed: false,
        rawInput: eventBefore?.rawInput,
        parsedJson: eventBefore?.parsedJson,
      });
    }
  });

  it("rolls back every durable row when the statement is forced to fail", async () => {
    for (const failureAt of [
      "after-claim",
      "after-session",
      "after-exercises",
      "after-sets-pain-notes",
      "before-audit",
    ]) {
      const input = await createParsingEvent();
      const before = await durableCounts();
      await expect(
        applyQuickLogToDatabase(database.db, userId, input, { failureAt })
      ).rejects.toThrow();
      expect(await durableCounts()).toEqual(before);
      expect(
        await database.db.query.aiParsingEvents.findFirst({
          where: eq(aiParsingEvents.id, input.parsingEventId),
        })
      ).toMatchObject({ confirmed: false });

      await expect(
        applyQuickLogToDatabase(database.db, userId, input)
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it("returns the applied result after a lost acknowledgement without duplicating it", async () => {
    const input = await createParsingEvent();
    await expect(
      applyQuickLogToDatabase(database.db, userId, input, {
        checkpoint: (boundary) => {
          if (boundary === "quick-log-applied") {
            throw new Error("lost quick-log acknowledgement");
          }
        },
      })
    ).rejects.toThrow("lost quick-log acknowledgement");
    const beforeRetry = await durableCounts();

    const retried = await applyQuickLogToDatabase(database.db, userId, input);
    expect(retried).toMatchObject({ ok: true });
    expect(await durableCounts()).toEqual(beforeRetry);
  });

  it("keeps parse provenance but stops returning a workout after permanent removal", async () => {
    const input = await createParsingEvent();
    const applied = await applyQuickLogToDatabase(database.db, userId, input);
    if (!applied.ok) throw new Error(applied.reason);

    await database.client.query(
      `SELECT set_config('workout_tracker.authorized_delete', 'permanent', false)`
    );
    try {
      await database.db
        .delete(workoutSessions)
        .where(eq(workoutSessions.id, applied.sessionId));
    } finally {
      await database.client.query(
        `SELECT set_config('workout_tracker.authorized_delete', '', false)`
      );
    }

    expect(
      await database.db.query.aiParsingEvents.findFirst({
        where: eq(aiParsingEvents.id, input.parsingEventId),
      })
    ).toMatchObject({ confirmed: true, resultSessionId: null });
    await expect(
      applyQuickLogToDatabase(database.db, userId, input)
    ).resolves.toEqual({
      ok: false,
      reason: "This older quick log was already saved.",
    });
  });

  it("rejects a browser-supplied exercise that is not visible to the user", async () => {
    const [otherUser] = await database.db
      .insert(users)
      .values({ email: `other-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    const [privateExercise] = await database.db
      .insert(exercises)
      .values({
        userId: otherUser.id,
        name: `Private exercise ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
        variantAttributes: {},
      })
      .returning({ id: exercises.id });
    const input = await createParsingEvent();
    input.exerciseByEntry["0"] = privateExercise.id;

    await expect(
      applyQuickLogToDatabase(database.db, userId, input)
    ).resolves.toMatchObject({ ok: false });
    expect(await durableCounts()).toEqual({
      sessions: 0,
      exercises: 0,
      sets: 0,
      occurrences: 0,
      pain: 0,
      notes: 0,
      audits: 0,
    });
  });

  it("revalidates the stored parse at the claim boundary", async () => {
    const input = await createParsingEvent();
    const result = await applyQuickLogToDatabase(database.db, userId, input, {
      checkpoint: async (boundary) => {
        if (boundary !== "quick-log-ready") return;
        await database.db
          .update(aiParsingEvents)
          .set({
            parsedJson: {
              data: { entries: [{ kind: "note", text: "changed" }] },
              confidence: 1,
              ambiguities: [],
              clarifyingQuestions: [],
              unparsed: [],
            },
          })
          .where(eq(aiParsingEvents.id, input.parsingEventId));
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(await durableCounts()).toEqual({
      sessions: 0,
      exercises: 0,
      sets: 0,
      occurrences: 0,
      pain: 0,
      notes: 0,
      audits: 0,
    });
  });

  it("appends after the real current exercise order in an active workout", async () => {
    const startedAt = new Date("2026-07-13T12:00:00.000Z");
    const [session] = await database.db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Active workout",
        status: "in_progress",
        source: "tracker",
        startedAt,
        timezone: "UTC",
        localDate: "2026-07-13",
      })
      .returning({ id: workoutSessions.id });
    const existingExercises = await database.db
      .insert(sessionExercises)
      .values([
        { sessionId: session.id, exerciseId, orderIdx: 2 },
        { sessionId: session.id, exerciseId, orderIdx: 7 },
      ])
      .returning({ id: sessionExercises.id });
    await database.db.insert(sessionOccurrences).values({
      sessionId: session.id,
      sessionExerciseId: existingExercises[0].id,
      kind: "working_set",
      origin: "planned",
      sequenceIdx: 5,
      kindOrdinal: 0,
      plannedExerciseId: exerciseId,
      outcome: "pending",
    });
    const input = await createParsingEvent();

    await expect(
      applyQuickLogToDatabase(database.db, userId, input)
    ).resolves.toEqual({ ok: true, sessionId: session.id });
    const rows = await database.db.query.sessionExercises.findMany({
      where: eq(sessionExercises.sessionId, session.id),
      orderBy: sessionExercises.orderIdx,
    });
    expect(rows.map(({ orderIdx }) => orderIdx)).toEqual([2, 7, 8]);
    expect(
      await database.db.query.sessionOccurrences.findMany({
        where: eq(sessionOccurrences.sessionId, session.id),
        orderBy: sessionOccurrences.sequenceIdx,
      })
    ).toEqual([
      expect.objectContaining({ origin: "planned", sequenceIdx: 5, outcome: "pending" }),
      expect.objectContaining({
        origin: "ad_hoc",
        sequenceIdx: 6,
        outcome: "completed",
        completedSetId: expect.any(String),
      }),
    ]);
    expect(await database.db.select().from(workoutSessions)).toHaveLength(1);
  });
});
