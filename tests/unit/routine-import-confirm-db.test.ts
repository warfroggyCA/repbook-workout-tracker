import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  exercises,
  exerciseEquipmentRequirements,
  aiParsingEvents,
  importEvents,
  programVersions,
  userProfiles,
  users,
  workoutTemplates,
} from "@/db/schema";
import { parseCanonicalRoutineText } from "@/ai/tasks/routine-parse/deterministic";
import type { RepSpec } from "@/ai/tasks/routine-parse/schema";
import {
  createSuggestedDayIntent,
  createSuggestedSlotIntent,
} from "@/lib/program-document";
import { buildRoutineImportStagePayload } from "@/services/routine-import";
import { activateProgramAtomically } from "@/services/program-activation";

const mocked = vi.hoisted(() => ({
  db: null as unknown,
  user: null as unknown,
  createSafetySnapshot: vi.fn(async () => ({
    ok: true as const,
    snapshotId: "10000000-0000-4000-8000-000000000099",
  })),
}));

vi.mock("@/db", () => ({ getDb: async () => mocked.db }));
vi.mock("@/lib/user", () => ({ getCurrentUser: async () => mocked.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/services/snapshots", () => ({
  createAutomaticSafetySnapshot: mocked.createSafetySnapshot,
}));

import {
  confirmImport,
  discardImport,
  parseRoutineText,
  type ConfirmImportInput,
} from "@/app/actions/import";

describe("reviewed Program import confirmation", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;
  let exerciseId: string;

  beforeEach(async () => {
    delete process.env.PROGRAM_TEXT_IMPORT_ENABLED;
    client = new PGlite();
    db = drizzle(client, { schema });
    mocked.db = db;
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `routine-confirm-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    await db.insert(userProfiles).values({ userId, unit: "lb" });
    mocked.user = { id: userId, profile: { unit: "lb" } };
    mocked.createSafetySnapshot.mockClear();
    mocked.createSafetySnapshot.mockResolvedValue({
      ok: true,
      snapshotId: "10000000-0000-4000-8000-000000000099",
    });
    [{ id: exerciseId }] = await db
      .insert(exercises)
      .values({
        name: "Barbell Bench Press",
        movementPattern: "horizontal_push",
        primaryMuscles: ["chest"],
        loadType: "barbell",
      })
      .returning({ id: exercises.id });
  }, 30_000);

  afterEach(async () => {
    delete process.env.PROGRAM_TEXT_IMPORT_ENABLED;
    await client.close();
  });

  async function stageReview(
    baseProgramVersionId: string | null = null,
    aiEventIds: { routineParse: string | null; exerciseMap: string | null } = {
      routineParse: null,
      exerciseMap: null,
    },
    reps: RepSpec | null = null,
  ) {
    const envelope = parseCanonicalRoutineText(`Program: Reviewed import
Day 1 — Strength
Warm-up: Easy bike | load=5 minutes
Bench Press 3x8 @ 60 kg, rest 2 min
Ramp-up: Empty bar | reps=10`)!;
    if (reps) envelope.data.days[0]!.exercises[0]!.reps = reps;
    const stage = buildRoutineImportStagePayload({
      schemaVersion: "routine-import-stage/1",
      envelope,
      mappings: [{
        rawName: "Bench Press",
        exerciseId,
        exerciseName: "Barbell Bench Press",
        matchType: "alias",
        candidates: [{ id: exerciseId, name: "Barbell Bench Press" }],
      }],
      parserVersion: "canonical-routine-text/2",
      aiEventIds,
      baseProgramVersionId,
    });
    const [event] = await db
      .insert(importEvents)
      .values({
        userId,
        source: "paste",
        rawPayload: "synthetic private paste",
        parsedPayload: stage,
        status: "parsed",
      })
      .returning({ id: importEvents.id });
    const day = envelope.data.days[0]!;
    const row = day.exercises[0]!;
    const slotIntent = {
      ...createSuggestedSlotIntent(3, 0),
      idealDose: { unit: "sets" as const, value: 3 },
      substitutionPolicy: "no_substitution" as const,
      omissionPolicy: "never" as const,
      calibrationEligible: false,
    };
    const dayIntent = {
      ...createSuggestedDayIntent([{
        lineageId: row.lineageId,
        sets: 3,
        restSec: 120,
      }]),
      orderingPolicy: "preserve" as const,
      pairingPolicy: "preserve" as const,
    };
    const input: ConfirmImportInput = {
      schemaVersion: "program-input-review/1",
      importEventId: event.id,
      stageDigest: stage.stageDigest,
      baseProgramVersionId,
      equipmentFitReviewed: true,
      programName: "Reviewed import",
      days: [{
        lineageId: day.lineageId,
        name: day.name,
        warmupItems: day.warmupItems,
        intent: dayIntent,
        exercises: [{
          lineageId: row.lineageId,
          exerciseId,
          sets: 3,
          repMin: 8,
          repMax: 8,
          load: 60,
          loadUnit: "kg",
          restSec: 120,
          supersetKey: null,
          notes: null,
          intent: slotIntent,
        }],
      }],
    };
    return { input, eventId: event.id, day, row };
  }

  it("fails closed before staging or publication when Program text import is disabled", async () => {
    process.env.PROGRAM_TEXT_IMPORT_ENABLED = "false";
    await expect(
      parseRoutineText({
        text: "Program: Disabled import\nDay 1 — Strength\nBench Press 3x8",
        clientImportId: crypto.randomUUID(),
      }),
    ).resolves.toEqual({
      ok: false,
      reason:
        "Routine text imports are temporarily unavailable. Your existing Programs and workouts are unchanged.",
    });
    expect(await db.query.importEvents.findMany()).toHaveLength(0);

    const staged = await stageReview();
    await expect(confirmImport(staged.input)).resolves.toEqual({
      ok: false,
      reason:
        "Routine text imports are temporarily unavailable. Your staged review is preserved and no Program was changed.",
    });
    expect(await db.query.programVersions.findMany()).toHaveLength(0);
    expect(mocked.createSafetySnapshot).not.toHaveBeenCalled();
    await expect(
      db.query.importEvents.findFirst({
        where: eq(importEvents.id, staged.eventId),
      }),
    ).resolves.toMatchObject({ status: "parsed" });
  });

  it("returns an exact prior publication when the switch is disabled before retry", async () => {
    const staged = await stageReview();
    const published = await confirmImport(staged.input);
    expect(published.ok).toBe(true);

    process.env.PROGRAM_TEXT_IMPORT_ENABLED = "false";
    await expect(confirmImport(staged.input)).resolves.toEqual(published);
    expect(await db.query.programVersions.findMany()).toHaveLength(1);
    expect(mocked.createSafetySnapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and oversized paste input without durable staging", async () => {
    await expect(parseRoutineText({
      text: "x".repeat(20_001),
      clientImportId: crypto.randomUUID(),
    })).resolves.toEqual({
      ok: false,
      reason: "Routine text must be 20,000 characters or fewer.",
    });
    const malformed = await parseRoutineText({
      text: "Program: Malformed\nDay 1 — Test\nThis prescription cannot be placed",
      clientImportId: crypto.randomUUID(),
    });
    expect(malformed).toMatchObject({ ok: false });
    expect(await db.query.importEvents.findMany()).toHaveLength(0);
  });

  it("stages a deterministic paste once and resumes the same review on retry", async () => {
    const clientImportId = crypto.randomUUID();
    const text = `Program: Retry-safe import
Day 1 — Strength
Warm-up: Easy bike | load=5 minutes
Barbell Bench Press 3x8 @ 60 kg, rest 2 min
Ramp-up: Empty bar | reps=10`;

    const first = await parseRoutineText({ text, clientImportId });
    expect(first.ok).toBe(true);
    const retry = await parseRoutineText({ text, clientImportId });
    expect(retry).toEqual(first);
    expect(await db.query.importEvents.findMany()).toHaveLength(1);

    await expect(parseRoutineText({
      text: text.replace("Retry-safe import", "Changed retry"),
      clientImportId,
    })).resolves.toEqual({
      ok: false,
      reason:
        "Your current Program was not changed, and the paste was not retained. Repbook could not safely stage the routine for review. Retry later.",
    });
    expect(await db.query.importEvents.findMany()).toHaveLength(1);
  }, 30_000);

  it("publishes schema-3 warm-ups and exact reviewed intent once under retry", async () => {
    const staged = await stageReview();
    const first = await confirmImport(staged.input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const version = await db.query.programVersions.findFirst({
      where: eq(programVersions.id, first.programVersionId),
    });
    expect(version).toMatchObject({ documentSchemaVersion: 3, versionNo: 1 });
    expect(await db.query.workoutTemplates.findFirst({
      where: eq(workoutTemplates.programVersionId, first.programVersionId),
    })).toMatchObject({
      lineageId: staged.day.lineageId,
      warmupItems: staged.day.warmupItems,
      intent: staged.input.days[0]!.intent,
    });
    expect(await db.query.workoutTemplateExercises.findFirst()).toMatchObject({
      lineageId: staged.row.lineageId,
      warmupSets: [],
      intent: staged.input.days[0]!.exercises[0]!.intent,
    });
    expect(await db.query.exercisePrescriptions.findFirst()).toMatchObject({
      targetLoad: 60,
      targetLoadUnit: "kg",
    });
    expect(await db.query.importEvents.findFirst({
      where: eq(importEvents.id, staged.eventId),
    })).toMatchObject({
      status: "confirmed",
      rawPayload: "",
      parsedPayload: null,
      confirmedPayload: expect.objectContaining({ equipmentFitReviewed: true }),
      resultProgramVersionId: first.programVersionId,
    });

    await expect(confirmImport(staged.input)).resolves.toEqual(first);
    await expect(confirmImport({
      ...staged.input,
      programName: "Different replay",
    })).resolves.toEqual({
      ok: false,
      reason: "This import was already published with different reviewed choices.",
    });
    expect(await db.query.programVersions.findMany()).toHaveLength(1);
  }, 30_000);

  it("requires a durable exact-equipment-fit attestation", async () => {
    const staged = await stageReview();
    const result = await confirmImport({
      ...staged.input,
      equipmentFitReviewed: false,
    } as unknown as ConfirmImportInput);

    expect(result).toMatchObject({ ok: false });
    expect(await db.query.programVersions.findMany()).toHaveLength(0);
    expect(await db.query.importEvents.findFirst({
      where: eq(importEvents.id, staged.eventId),
    })).toMatchObject({ status: "parsed" });
  }, 30_000);

  it("rejects forged staged identities and one-member pairing groups", async () => {
    const forged = await stageReview();
    await expect(confirmImport({
      ...forged.input,
      days: [{
        ...forged.input.days[0]!,
        lineageId: crypto.randomUUID(),
      }],
    })).resolves.toEqual({
      ok: false,
      reason:
        "This review no longer matches the staged days and exercises. Nothing was published; discard it and parse again.",
    });
    const singleton = await stageReview();
    const result = await confirmImport({
      ...singleton.input,
      days: [{
        ...singleton.input.days[0]!,
        exercises: [{
          ...singleton.input.days[0]!.exercises[0]!,
          supersetKey: "A",
        }],
      }],
    });
    expect(result.ok).toBe(false);
    expect(await db.query.programVersions.findMany()).toHaveLength(0);
  }, 30_000);

  it("refuses a staged per-set rep sequence the Program cannot preserve", async () => {
    const staged = await stageReview(
      null,
      { routineParse: null, exerciseMap: null },
      { kind: "perSet", perSet: [8, 8, 6] },
    );

    await expect(confirmImport(staged.input)).resolves.toEqual({
      ok: false,
      reason:
        "This staged paste contains different rep targets for individual sets, which this importer cannot publish exactly. Nothing was published; discard it and rewrite each affected exercise as one exact target or range.",
    });
    expect(await db.query.programVersions.findMany()).toHaveLength(0);
  }, 30_000);

  it("leases confirmation so overlapping duplicates cannot create a false pre-import snapshot", async () => {
    const staged = await stageReview();
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    mocked.createSafetySnapshot.mockImplementationOnce(async () => {
      await snapshotGate;
      return {
        ok: true,
        snapshotId: "10000000-0000-4000-8000-000000000099",
      };
    });

    const winningRequest = confirmImport(staged.input);
    await vi.waitFor(() => {
      expect(mocked.createSafetySnapshot).toHaveBeenCalledTimes(1);
    });
    const overlappingRequest = await confirmImport(staged.input);
    expect(overlappingRequest).toEqual({
      ok: false,
      reason: "An import was just started for this account. Wait briefly and try again.",
    });
    expect(mocked.createSafetySnapshot).toHaveBeenCalledTimes(1);

    releaseSnapshot();
    const published = await winningRequest;
    expect(published.ok).toBe(true);
    await expect(confirmImport(staged.input)).resolves.toEqual(published);
    expect(mocked.createSafetySnapshot).toHaveBeenCalledTimes(1);
    expect(await db.query.programVersions.findMany()).toHaveLength(1);
  }, 30_000);

  it("rejects stale review and makes discard retry idempotent", async () => {
    const activate = (programName: string, expected: string | null) =>
      activateProgramAtomically(db, {
        userId,
        loadUnit: "lb",
        programName,
        days: [{
          name: "Current day",
          exercises: [{
            exerciseId,
            sets: 3,
            repMin: 8,
            repMax: 8,
            targetLoad: 60,
            restSec: 120,
            supersetKey: null,
            notes: null,
          }],
        }],
        changeSummary: "Synthetic stale-review setup",
        auditAction: "program.activate",
        auditSummary: "Synthetic stale-review setup",
        expectedCurrentProgramVersionId: expected,
      });

    const current = await activate("Current", null);
    if (!current.ok) throw new Error(current.reason);
    const staged = await stageReview(current.programVersionId);
    const changed = await activate("Changed", current.programVersionId);
    if (!changed.ok) throw new Error(changed.reason);

    await expect(confirmImport(staged.input)).resolves.toEqual({
      ok: false,
      reason:
        "Your active Program changed after this review began. Nothing was published; discard this review and parse again against the current Program.",
    });
    expect(await db.query.programVersions.findMany()).toHaveLength(2);
    expect(await discardImport(staged.eventId)).toEqual({ ok: true });
    expect(await discardImport(staged.eventId)).toEqual({ ok: true });
    expect(await db.query.importEvents.findFirst({
      where: eq(importEvents.id, staged.eventId),
    })).toMatchObject({
      status: "discarded",
      rawPayload: "",
      parsedPayload: null,
    });
  }, 30_000);

  it("redacts linked unconfirmed AI records when a staged review is discarded", async () => {
    const aiRows = await db
      .insert(aiParsingEvents)
      .values([
        {
          userId,
          scope: "import" as const,
          task: "routine_parse",
          rawInput: "sensitive routine paste",
          rawOutput: "provider output",
          parsedJson: { sensitive: true },
          ambiguities: [{ issue: "private ambiguity" }],
          retentionExpiresAt: new Date(Date.now() + 60_000),
        },
        {
          userId,
          scope: "import" as const,
          task: "exercise_map",
          rawInput: "sensitive exercise map",
          rawOutput: "provider map output",
          parsedJson: { sensitive: true },
          ambiguities: [{ issue: "private mapping ambiguity" }],
          retentionExpiresAt: new Date(Date.now() + 60_000),
        },
      ])
      .returning({ id: aiParsingEvents.id });
    const staged = await stageReview(null, {
      routineParse: aiRows[0]!.id,
      exerciseMap: aiRows[1]!.id,
    });

    await expect(discardImport(staged.eventId)).resolves.toEqual({ ok: true });
    const redacted = await db.query.aiParsingEvents.findMany();
    expect(redacted).toHaveLength(2);
    for (const event of redacted) {
      expect(event).toMatchObject({
        rawInput: "",
        rawOutput: null,
        parsedJson: null,
        ambiguities: [],
        rawRedactedAt: expect.any(Date),
        retentionExpiresAt: null,
        confirmed: false,
      });
    }
    await expect(discardImport(staged.eventId)).resolves.toEqual({ ok: true });
  }, 30_000);

  it("refuses a retained exercise whose catalog requirements do not fit inventory", async () => {
    await db.insert(exerciseEquipmentRequirements).values({
      exerciseId,
      equipmentType: "cable",
    });
    const staged = await stageReview();
    const result = await confirmImport(staged.input);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toMatch(/cable|equipment|available/iu);
    expect(await db.query.programVersions.findMany()).toHaveLength(0);
    expect(await db.query.importEvents.findFirst({
      where: eq(importEvents.id, staged.eventId),
    })).toMatchObject({ status: "parsed" });
  }, 30_000);
});
