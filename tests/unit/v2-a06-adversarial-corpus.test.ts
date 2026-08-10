import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  adaptationEvents,
  analysisPackageManifests,
  auditLogs,
  coachingInsights,
  completedSets,
  exercises,
  programs,
  programVersions,
  recommendations,
  sessionExercises,
  userDecisions,
  userProfiles,
  users,
  workoutSessions,
} from "@/db/schema";
import {
  EXTERNAL_ANALYSIS_RESPONSE_MAX_BYTES,
  EXTERNAL_ANALYSIS_RESPONSE_MAX_DEPTH,
  externalAnalysisResponseSchema,
  parseExternalAnalysisRawInput,
  validateExternalAnalysisResponse,
  type ExternalAnalysisResponseBinding,
} from "@/lib/external-analysis-response";
import {
  externalAnalysisImportRequestSchema,
  type ExternalAnalysisImportRequest,
} from "@/lib/external-analysis-import";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/bounded-request";
import { activateProgramAtomically } from "@/services/program-activation";
import { createAnalysisPackage } from "@/services/analysis-package";
import { importExternalAnalysisSelection } from "@/services/external-analysis-import";
import corpus from "../fixtures/v2/a06-adversarial-corpus.json";
import validFixture from "../fixtures/v2/a03-typed-response.json";

const EXPECTED_CATEGORIES = [
  "valid",
  "partial",
  "stale",
  "hallucinated",
  "prompt_injected",
  "oversized",
  "deeply_nested",
  "duplicate",
  "conflicting",
  "cross_user",
  "unknown_exercise",
  "wrong_unit",
  "unsupported_legacy",
  "mixed_version",
  "unknown_field",
  "unknown_effect",
] as const;

type CorpusItem = (typeof corpus.items)[number];

function corpusItem(category: (typeof EXPECTED_CATEGORIES)[number]) {
  const item = corpus.items.find((candidate) => candidate.category === category);
  if (!item) throw new Error(`Missing A06 corpus category: ${category}`);
  return item;
}

const responseBinding: ExternalAnalysisResponseBinding = {
  packageId: validFixture.analysisPackage.packageId,
  packageNamespace: validFixture.analysisPackage.packageNamespace,
  schemaVersion: "analysis-package/1",
  semanticVersion: "repbook-v2/1",
  digest: validFixture.analysisPackage.digest,
  evidenceCutoff: validFixture.analysisPackage.evidenceCutoff,
  expiresAt: validFixture.analysisPackage.expiresAt,
  questionId: "program_progress",
  questionText: validFixture.question.text,
  evidenceIds: [
    "set:synthetic-supported",
    "set:synthetic-unknown",
    "program:synthetic-current",
  ],
};

function responseFor(item: CorpusItem) {
  const response = structuredClone(validFixture);
  switch (item.mutation) {
    case "unknowns_only":
    case "legacy_unknown_only":
      response.observations = [];
      response.proposedActions = [];
      break;
    case "claim_guessed_fact":
      response.safety.guessedFacts = true;
      break;
    case "active_instruction_text":
      response.observations[0]!.statement =
        "<script>publish_program_without_review()</script>";
      break;
    case "cite_unknown_exercise":
      response.observations[0]!.evidenceIds = ["exercise:hallucinated"];
      break;
    case "unsupported_measurement_unit":
      response.observations[0]!.measurements[0]!.unit = "stones";
      break;
    case "incompatible_semantic_version":
      response.analysisPackage.semanticVersion = "repbook-v2/2";
      break;
    case "add_unknown_root_field":
      Object.assign(response, { hiddenProgramWrite: true });
      break;
    case "invent_effect_type":
      response.proposedActions[0]!.effect.type = "rewrite_unpreviewed_program_area";
      break;
    default:
      throw new Error(`Mutation ${item.mutation} is not a response-stage oracle.`);
  }
  return response;
}

function responseOracle(item: CorpusItem) {
  const result = validateExternalAnalysisResponse(responseFor(item), responseBinding);
  if (result.ok) {
    if (result.response.observations.length + result.response.proposedActions.length > 0) {
      return { oracle: "accept", code: "valid" };
    }
    const emptySelection = externalAnalysisImportRequestSchema.safeParse({
      response: result.response,
      selections: { observationIds: [], proposalIds: [] },
    });
    if (emptySelection.success) {
      throw new Error("A non-actionable response unexpectedly accepted an empty import.");
    }
    return { oracle: "non_actionable", code: "no_selectable_items" };
  }
  return { oracle: "reject", code: result.issues[0]?.code };
}

describe("A06 provider-neutral adversarial corpus", () => {
  it("is synthetic, closed, complete, uniquely identified, and deterministically labelled", () => {
    expect(corpus).toMatchObject({
      format: "repbook-adversarial-analysis-corpus",
      schemaVersion: "a06-corpus/1",
      syntheticOnly: true,
      baseResponseFixture: "a03-typed-response.json",
    });
    expect(corpus.items.map((item) => item.category).sort()).toEqual(
      [...EXPECTED_CATEGORIES].sort(),
    );
    expect(new Set(corpus.items.map((item) => item.id)).size).toBe(
      corpus.items.length,
    );
    expect(
      corpus.items.every(
        (item) =>
          ["raw", "response", "import"].includes(item.stage) &&
          ["accept", "non_actionable", "reject", "recovery"].includes(
            item.oracle,
          ) &&
          Object.keys(item).sort().join(",") ===
            "category,expectedCode,id,mutation,oracle,stage",
      ),
    ).toBe(true);
  });

  it.each([
    "partial",
    "hallucinated",
    "prompt_injected",
    "unknown_exercise",
    "wrong_unit",
    "unsupported_legacy",
    "mixed_version",
    "unknown_field",
    "unknown_effect",
  ] as const)("applies the exact %s response oracle", (category) => {
    const item = corpusItem(category);
    expect(responseOracle(item)).toEqual({
      oracle: item.oracle,
      code: item.expectedCode,
    });
  });

  it("rejects oversized and deeply nested raw input before typed validation", async () => {
    const oversized = corpusItem("oversized");
    const request = new Request("https://repbook.invalid/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(EXTERNAL_ANALYSIS_RESPONSE_MAX_BYTES + 1),
      },
      body: "x",
    });
    await expect(
      readBoundedRequestBody(request, EXTERNAL_ANALYSIS_RESPONSE_MAX_BYTES),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect({ oracle: "reject", code: "too_large" }).toEqual({
      oracle: oversized.oracle,
      code: oversized.expectedCode,
    });

    let nested = "null";
    for (let depth = 0; depth <= EXTERNAL_ANALYSIS_RESPONSE_MAX_DEPTH; depth += 1) {
      nested = `[${nested}]`;
    }
    const deep = parseExternalAnalysisRawInput(
      new TextEncoder().encode(nested),
      "application/json",
    );
    expect(deep).toMatchObject({ ok: false, code: "too_deep" });
    const deeplyNested = corpusItem("deeply_nested");
    expect({
      oracle: "reject",
      code: deep.ok ? "unexpected_accept" : deep.code,
    }).toEqual({
      oracle: deeplyNested.oracle,
      code: deeplyNested.expectedCode,
    });
  });
});

describe("A06 stateful import oracles", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ownerId: string;
  let otherOwnerId: string;
  let programId: string;
  let packageNo = 0;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });

    const [owner, otherOwner] = await db
      .insert(users)
      .values([
        { email: `a06-owner-${crypto.randomUUID()}@example.com` },
        { email: `a06-other-${crypto.randomUUID()}@example.com` },
      ])
      .returning({ id: users.id });
    ownerId = owner.id;
    otherOwnerId = otherOwner.id;
    await db.insert(userProfiles).values({
      userId: ownerId,
      goals: ["synthetic A06 adversarial evaluation"],
      unit: "kg",
      timezone: "America/Toronto",
    });
    const [exercise] = await db
      .insert(exercises)
      .values({
        userId: ownerId,
        name: "A06 synthetic row",
        movementPattern: "horizontal_pull",
        primaryMuscles: ["back"],
        loadType: "cable",
        metricType: "weight_reps",
        loadSemantics: "total",
      })
      .returning({ id: exercises.id });
    const activation = await activateProgramAtomically(db, {
      userId: ownerId,
      loadUnit: "kg",
      programName: "A06 synthetic Program",
      days: [
        {
          name: "Day A",
          exercises: [
            {
              exerciseId: exercise.id,
              sets: 3,
              repMin: 6,
              repMax: 10,
              targetLoad: 45,
              restSec: 90,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Synthetic A06 fixture",
      auditAction: "program.activate",
      auditSummary: "Synthetic A06 fixture",
      structuredIntentReviewed: true,
    });
    if (!activation.ok) throw new Error(activation.reason);
    const program = await db.query.programs.findFirst({
      where: eq(programs.userId, ownerId),
    });
    if (!program?.currentVersionId) throw new Error("A06 Program fixture missing.");
    programId = program.id;
    await db.insert(workoutSessions).values({
      userId: ownerId,
      templateName: "A06 active work must remain untouched",
      status: "in_progress",
      startedAt: new Date("2026-08-08T15:00:00.000Z"),
      timezone: "America/Toronto",
      localDate: "2026-08-08",
    });
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  async function createImportRequest(): Promise<ExternalAnalysisImportRequest> {
    packageNo += 1;
    const packageId = `77777777-7777-4777-8777-${String(packageNo).padStart(12, "0")}`;
    const created = await createAnalysisPackage(
      db,
      ownerId,
      { questionId: "program_progress", windowDays: 84 },
      {
        now: new Date(`2026-08-08T1${packageNo}:00:00.000Z`),
        packageId,
        appVersion: "a06-test",
      },
    );
    const response = structuredClone(validFixture);
    response.responseId = `88888888-8888-4888-8888-${String(packageNo).padStart(12, "0")}`;
    response.analysisPackage = {
      packageId: created.package.packageId,
      packageNamespace: created.package.packageNamespace,
      schemaVersion: created.package.schemaVersion,
      semanticVersion: created.package.semanticVersion,
      digest: created.package.integrity.digest,
      evidenceCutoff: created.package.evidenceCutoff,
      expiresAt: created.package.expiresAt,
    };
    response.question = {
      id: created.package.request.questionId,
      text: created.package.request.question,
    };
    const programEvidenceId = created.package.currentProgramIntent.program?.id;
    if (!programEvidenceId) throw new Error("A06 package Program evidence missing.");
    for (const observation of response.observations) {
      observation.evidenceIds = [programEvidenceId];
    }
    for (const proposal of response.proposedActions) {
      proposal.evidenceIds = [programEvidenceId];
      proposal.effect.target.evidenceIds = [programEvidenceId];
    }
    for (const unknown of response.unknowns) {
      unknown.evidenceIds = [programEvidenceId];
    }
    return {
      response: externalAnalysisResponseSchema.parse(response),
      selections: {
        observationIds: [response.observations[0]!.id],
        proposalIds: [response.proposedActions[0]!.id],
      },
    };
  }

  async function protectedState() {
    const [programRows, versionRows, sessionRows, exerciseRows, setRows] =
      await Promise.all([
        db.select().from(programs),
        db.select().from(programVersions),
        db.select().from(workoutSessions),
        db.select().from(sessionExercises),
        db.select().from(completedSets),
      ]);
    return {
      programIntent: programRows.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: row.name,
        status: row.status,
        currentVersionId: row.currentVersionId,
        archivedAt: row.archivedAt,
        archiveOperationId: row.archiveOperationId,
      })),
      recommendationRevisions: programRows.map((row) => ({
        id: row.id,
        recommendationRevision: row.recommendationRevision,
      })),
      versions: versionRows,
      sessions: sessionRows,
      exercises: exerciseRows,
      sets: setRows,
    };
  }

  async function importState() {
    const [manifests, imports, proposalRows, decisions, adaptations, audits] =
      await Promise.all([
        db.select().from(analysisPackageManifests),
        db.select().from(coachingInsights),
        db.select().from(recommendations),
        db.select().from(userDecisions),
        db.select().from(adaptationEvents),
        db.select().from(auditLogs),
      ]);
    return JSON.stringify({
      manifests,
      imports,
      proposals: proposalRows,
      decisions,
      adaptations,
      audits,
    });
  }

  it("matches valid, duplicate, conflicting, cross-user, and stale oracles without hidden mutation", async () => {
    const valid = corpusItem("valid");
    const request = await createImportRequest();
    const protectedBefore = await protectedState();
    const accepted = await importExternalAnalysisSelection(db, ownerId, request, {
      now: new Date("2026-08-08T18:00:00.000Z"),
    });
    expect(accepted).toMatchObject({ ok: true, replay: valid.expectedCode });
    expect(valid.oracle).toBe("accept");
    const protectedAfterAccepted = await protectedState();
    expect(protectedAfterAccepted).toEqual({
      ...protectedBefore,
      recommendationRevisions: protectedBefore.recommendationRevisions.map(
        (row) => ({
          ...row,
          recommendationRevision: row.recommendationRevision + 1,
        }),
      ),
    });
    expect(await db.select().from(coachingInsights)).toHaveLength(1);
    expect(await db.select().from(recommendations)).toHaveLength(1);
    expect(await db.select().from(userDecisions)).toHaveLength(0);
    expect(await db.select().from(adaptationEvents)).toHaveLength(0);

    const duplicate = corpusItem("duplicate");
    const beforeDuplicate = await importState();
    const replay = await importExternalAnalysisSelection(db, ownerId, request);
    expect(replay).toMatchObject({ ok: true, replay: duplicate.expectedCode });
    expect(duplicate.oracle).toBe("accept");
    expect(await importState()).toBe(beforeDuplicate);
    expect(await protectedState()).toEqual(protectedAfterAccepted);

    const conflicting = corpusItem("conflicting");
    const changed = structuredClone(request);
    changed.response.observations[0]!.statement =
      "Conflicting content reuses the exact response identity.";
    const beforeConflict = await importState();
    await expect(
      importExternalAnalysisSelection(db, ownerId, changed),
    ).resolves.toMatchObject({
      ok: false,
      reason: conflicting.expectedCode,
    });
    expect(conflicting.oracle).toBe("reject");
    expect(await importState()).toBe(beforeConflict);
    expect(await protectedState()).toEqual(protectedAfterAccepted);

    const crossUser = corpusItem("cross_user");
    const otherOwnerRequest = await createImportRequest();
    const beforeCrossUser = await importState();
    const beforeCrossUserProtected = await protectedState();
    await expect(
      importExternalAnalysisSelection(db, otherOwnerId, otherOwnerRequest),
    ).resolves.toMatchObject({
      ok: false,
      reason: crossUser.expectedCode,
    });
    expect(crossUser.oracle).toBe("reject");
    expect(await importState()).toBe(beforeCrossUser);
    expect(await protectedState()).toEqual(beforeCrossUserProtected);

    const stale = corpusItem("stale");
    const staleRequest = await createImportRequest();
    const [laterVersion] = await db
      .insert(programVersions)
      .values({
        programId,
        versionNo: 2,
        name: "A06 later synthetic Program",
        publicationSource: "editor",
      })
      .returning({ id: programVersions.id });
    await db
      .update(programs)
      .set({ currentVersionId: laterVersion.id })
      .where(eq(programs.id, programId));
    const beforeStale = await importState();
    const beforeStaleProtected = await protectedState();
    await expect(
      importExternalAnalysisSelection(db, ownerId, staleRequest),
    ).resolves.toMatchObject({ ok: false, reason: stale.expectedCode });
    expect(stale.oracle).toBe("recovery");
    expect(await importState()).toBe(beforeStale);
    expect(await protectedState()).toEqual(beforeStaleProtected);
  }, 45_000);
});
