import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import {
  completedSets,
  coachingInsights,
  exercises,
  programDrafts,
  programVersions,
  programs,
  sessionExercises,
  users,
  workoutSessions,
} from "@/db/schema";
import {
  legacyProgramDocumentSchema,
  suggestProgramIntentDraft,
} from "@/lib/program-document";
import {
  analyzeHistoricalSemanticsConsequences,
  HISTORICAL_SEMANTICS_GATE_VERSION,
} from "@/services/historical-semantics-gate";
import { assessHistoricalSemanticsRepair } from "@/services/historical-semantics-repair-assessment";
import { captureUserSnapshot } from "@/services/snapshot-capture";

describe("historical consequence dry run", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let userId: string;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    [{ id: userId }] = await db
      .insert(users)
      .values({ email: `semantic-gate-${crypto.randomUUID()}@example.com` })
      .returning({ id: users.id });
    const [exercise] = await db
      .insert(exercises)
      .values({
        name: `Legacy assisted pull-up ${crypto.randomUUID()}`,
        movementPattern: "squat",
        primaryMuscles: ["back"],
        metricType: "assisted_reps",
        loadType: "machine",
        loadSemantics: "assistance",
      })
      .returning({ id: exercises.id });
    const [session] = await db
      .insert(workoutSessions)
      .values({
        userId,
        templateName: "Legacy evidence",
        status: "completed",
        startedAt: new Date("2026-07-01T14:00:00.000Z"),
        finishedAt: new Date("2026-07-01T15:00:00.000Z"),
        timezone: "America/Toronto",
        localDate: "2026-07-01",
      })
      .returning({ id: workoutSessions.id });
    const [sessionExercise] = await db
      .insert(sessionExercises)
      .values({
        sessionId: session.id,
        exerciseId: exercise.id,
        targetRepsMin: 8,
      })
      .returning({ id: sessionExercises.id });
    await db.insert(completedSets).values({
      sessionExerciseId: sessionExercise.id,
      setNo: 1,
      metricType: "assisted_reps",
      weight: 50,
      weightUnit: "lb",
      reps: 8,
      targetMet: true,
      loadEntryMeaning: "legacy_unknown",
    });
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  it("returns exact counts while leaving every captured row unchanged", async () => {
    const at = new Date("2026-07-29T20:00:00.000Z");
    const before = await captureUserSnapshot(
      db,
      userId,
      at,
      HISTORICAL_SEMANTICS_GATE_VERSION,
    );
    const report = await analyzeHistoricalSemanticsConsequences(db, userId, at);
    const after = await captureUserSnapshot(
      db,
      userId,
      at,
      HISTORICAL_SEMANTICS_GATE_VERSION,
    );

    expect(report).toMatchObject({
      mutationAuthorized: false,
      counts: { completedSets: 1, workoutSessions: 1 },
    });
    expect(after).toEqual(before);
  });

  it("assesses every legacy row as ambiguous and proves zero database mutation", async () => {
    const [set] = await db.select({ id: completedSets.id }).from(completedSets);
    if (!set) throw new Error("Legacy completed-set fixture is missing.");
    await db.insert(coachingInsights).values({
      userId,
      kind: "manual_review",
      contentMd: "Persisted Coach text",
      dataDigest: {
        retainedEvidence: { completedSetId: set.id },
        privateContext: "must not enter the assessment report",
      },
    });
    const at = new Date("2026-07-29T20:00:00.000Z");
    const before = await captureUserSnapshot(
      db,
      userId,
      at,
      HISTORICAL_SEMANTICS_GATE_VERSION,
      { normalizeProgramDrafts: false },
    );
    const assessment = await assessHistoricalSemanticsRepair(db, userId, at);
    const after = await captureUserSnapshot(
      db,
      userId,
      at,
      HISTORICAL_SEMANTICS_GATE_VERSION,
      { normalizeProgramDrafts: false },
    );

    expect(assessment).toMatchObject({
      mutationAuthorized: false,
      contractActivationAuthorized: false,
      decision: "blocked_no_proven_rows",
      counts: {
        candidates: 1,
        provablyRepairable: 0,
        ambiguous: 1,
        unsupported: 0,
      },
      consequenceGraph: {
        counts: { coachingInsights: 1 },
      },
    });
    expect(
      assessment.consequenceGraph.nodes.find(
        (node) => node.kind === "coaching_insight",
      ),
    ).toMatchObject({
      provenance: ["persisted_text_references_affected_evidence"],
    });
    expect(JSON.stringify(assessment)).not.toContain(
      "must not enter the assessment report",
    );
    expect(after).toEqual(before);
  });

  it("reports consequences without normalizing or rejecting a checksum-mismatched Program draft", async () => {
    const programId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const document = suggestProgramIntentDraft(
      legacyProgramDocumentSchema.parse({
        schemaVersion: "1",
        programId,
        baseVersionId: versionId,
        name: "Retained integrity evidence",
        days: [
          {
            lineageId: crypto.randomUUID(),
            name: "Day A",
            notes: null,
            supersets: [],
            exercises: [
              {
                lineageId: crypto.randomUUID(),
                exerciseId: crypto.randomUUID(),
                sets: 1,
                repMin: 5,
                repMax: 5,
                targetLoad: null,
                targetLoadUnit: null,
                progressionRuleId: "double_progression",
                restSec: 90,
                supersetKey: null,
                notes: null,
                warmupNotes: null,
                warmupSets: [],
                setNotes: [null],
              },
            ],
          },
        ],
      }),
    );

    await db.transaction(async (tx) => {
      await tx.insert(programs).values({
        id: programId,
        userId,
        name: document.name,
        currentVersionId: versionId,
      });
      await tx.insert(programVersions).values({
        id: versionId,
        programId,
        versionNo: 1,
        name: document.name,
      });
      await tx.insert(programDrafts).values({
        userId,
        programId,
        baseVersionId: versionId,
        document,
        contentHash: "retained-mismatch",
        lastMutationId: crypto.randomUUID(),
      });
    });

    const at = new Date("2026-07-29T20:00:00.000Z");
    const before = await captureUserSnapshot(
      db,
      userId,
      at,
      HISTORICAL_SEMANTICS_GATE_VERSION,
      { normalizeProgramDrafts: false },
    );
    const report = await analyzeHistoricalSemanticsConsequences(db, userId, at);
    const after = await captureUserSnapshot(
      db,
      userId,
      at,
      HISTORICAL_SEMANTICS_GATE_VERSION,
      { normalizeProgramDrafts: false },
    );

    expect(report).toMatchObject({
      mutationAuthorized: false,
      counts: { completedSets: 1, workoutSessions: 1 },
    });
    expect(after).toEqual(before);
    expect(after.tables.program_drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content_hash: "retained-mismatch" }),
      ]),
    );
  });
});
