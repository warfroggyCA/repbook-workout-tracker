import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  analysisPackageManifests,
  adaptationEvents,
  exercises,
  programs,
  programVersions,
  recommendations,
  userProfiles,
  users,
  userDecisions,
} from "@/db/schema";
import {
  EXTERNAL_ANALYSIS_RESPONSE_MAX_DEPTH,
  parseExternalAnalysisRawInput,
  validateExternalAnalysisResponse,
} from "@/lib/external-analysis-response";
import { activateProgramAtomically } from "@/services/program-activation";
import { createAnalysisPackage } from "@/services/analysis-package";
import { getExternalAnalysisResponseBinding } from "@/services/external-analysis-validation";
import { captureUserSnapshot } from "@/services/snapshot-capture";
import validFixture from "../fixtures/v2/a03-typed-response.json";

describe("A04 raw external-response boundary", () => {
  it("accepts bounded JSON media and refuses malformed, deep, or wrong-type input before schema validation", () => {
    const valid = parseExternalAnalysisRawInput(
      new TextEncoder().encode('{"value":"plain data"}'),
      "application/json; charset=utf-8",
    );
    expect(valid).toMatchObject({ ok: true, value: { value: "plain data" } });

    expect(
      parseExternalAnalysisRawInput(
        new TextEncoder().encode("not json"),
        "application/json",
      ),
    ).toMatchObject({ ok: false, code: "malformed_json" });
    expect(
      parseExternalAnalysisRawInput(
        new TextEncoder().encode("{}"),
        "text/html",
      ),
    ).toMatchObject({ ok: false, code: "invalid_media_type" });

    let nested = "null";
    for (let depth = 0; depth <= EXTERNAL_ANALYSIS_RESPONSE_MAX_DEPTH; depth += 1) {
      nested = `[${nested}]`;
    }
    expect(
      parseExternalAnalysisRawInput(
        new TextEncoder().encode(nested),
        "application/json",
      ),
    ).toMatchObject({ ok: false, code: "too_deep" });
    expect(
      parseExternalAnalysisRawInput(
        new Uint8Array([0xc3, 0x28]),
        "application/json",
      ),
    ).toMatchObject({ ok: false, code: "invalid_encoding" });
  });
});

describe("A04 owner-scoped manifest response validation", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ownerId: string;
  let otherOwnerId: string;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./src/db/migrations" });

    const [owner, otherOwner] = await db
      .insert(users)
      .values([
        { email: `a04-owner-${crypto.randomUUID()}@example.com` },
        { email: `a04-other-${crypto.randomUUID()}@example.com` },
      ])
      .returning({ id: users.id });
    ownerId = owner.id;
    otherOwnerId = otherOwner.id;
    await db.insert(userProfiles).values({
      userId: ownerId,
      goals: ["synthetic A04 validation"],
      unit: "kg",
      timezone: "America/Toronto",
    });
    const [exercise] = await db
      .insert(exercises)
      .values({
        userId: ownerId,
        name: "A04 synthetic squat",
        movementPattern: "squat",
        primaryMuscles: ["quadriceps"],
        loadType: "barbell",
        metricType: "weight_reps",
        loadSemantics: "total",
      })
      .returning({ id: exercises.id });
    const activation = await activateProgramAtomically(db, {
      userId: ownerId,
      loadUnit: "kg",
      programName: "A04 synthetic Program",
      days: [
        {
          name: "Day A",
          exercises: [
            {
              exerciseId: exercise.id,
              sets: 3,
              repMin: 5,
              repMax: 8,
              targetLoad: 80,
              restSec: 120,
              supersetKey: null,
              notes: null,
            },
          ],
        },
      ],
      changeSummary: "Synthetic A04 manifest fixture",
      auditAction: "program.activate",
      auditSummary: "Synthetic A04 manifest fixture",
      structuredIntentReviewed: true,
    });
    if (!activation.ok) throw new Error(activation.reason);
  }, 30_000);

  afterEach(async () => {
    await client.close();
  });

  async function createBoundResponse() {
    const created = await createAnalysisPackage(
      db,
      ownerId,
      { questionId: "program_progress", windowDays: 84 },
      {
        now: new Date("2026-08-08T16:00:00.000Z"),
        packageId: "44444444-4444-4444-8444-444444444444",
        appVersion: "a04-test",
      },
    );
    const response = structuredClone(validFixture);
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
    const evidenceId = created.package.currentProgramIntent.program?.id;
    if (!evidenceId) throw new Error("Synthetic package Program binding missing.");
    for (const observation of response.observations) {
      observation.evidenceIds = [evidenceId];
    }
    for (const proposal of response.proposedActions) {
      proposal.evidenceIds = [evidenceId];
      proposal.effect.target.evidenceIds = [evidenceId];
    }
    for (const unknown of response.unknowns) unknown.evidenceIds = [evidenceId];
    return { created, response };
  }

  it("validates against the minimal active owner manifest without retaining the response", async () => {
    const { created, response } = await createBoundResponse();
    const lookup = await getExternalAnalysisResponseBinding(
      db,
      ownerId,
      created.package.packageId,
      new Date("2026-08-08T17:00:00.000Z"),
    );
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) throw new Error(lookup.reason);
    expect(validateExternalAnalysisResponse(response, lookup.binding).ok).toBe(true);

    response.observations[0].statement = "<script>mutate()</script>";
    const unsafe = validateExternalAnalysisResponse(response, lookup.binding);
    expect(unsafe.ok).toBe(false);
    if (unsafe.ok) throw new Error("Expected active-content refusal.");
    expect(unsafe.issues).toContainEqual(
      expect.objectContaining({ code: "unsafe_text" }),
    );

    expect(await db.select().from(analysisPackageManifests)).toHaveLength(1);
    expect(await db.select().from(recommendations)).toHaveLength(0);
    expect(await db.select().from(userDecisions)).toHaveLength(0);
    expect(await db.select().from(adaptationEvents)).toHaveLength(0);
    const snapshot = await captureUserSnapshot(
      db,
      ownerId,
      new Date("2026-08-08T17:00:00.000Z"),
      "a04-test",
    );
    expect(snapshot.tables).not.toHaveProperty("analysis_package_manifests");
    expect(JSON.stringify(snapshot)).not.toContain(response.responseId);
  }, 30_000);

  it("fails closed for missing, expired, cross-owner, malformed, and stale Program receipts", async () => {
    const { created } = await createBoundResponse();
    const packageId = created.package.packageId;
    await expect(
      getExternalAnalysisResponseBinding(
        db,
        otherOwnerId,
        packageId,
        new Date("2026-08-08T17:00:00.000Z"),
      ),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      getExternalAnalysisResponseBinding(
        db,
        ownerId,
        packageId,
        new Date("2026-09-08T16:00:00.000Z"),
      ),
    ).resolves.toEqual({ ok: false, reason: "expired" });

    const activeProgram = await db.query.programs.findFirst({
      where: eq(programs.userId, ownerId),
    });
    if (!activeProgram) throw new Error("Synthetic active Program missing.");
    const [nextVersion] = await db
      .insert(programVersions)
      .values({
        programId: activeProgram.id,
        versionNo: 2,
        name: "A04 later Program version",
        publicationSource: "editor",
      })
      .returning({ id: programVersions.id });
    await db
      .update(programs)
      .set({ currentVersionId: nextVersion.id })
      .where(eq(programs.id, activeProgram.id));
    await expect(
      getExternalAnalysisResponseBinding(
        db,
        ownerId,
        packageId,
        new Date("2026-08-08T17:00:00.000Z"),
      ),
    ).resolves.toEqual({ ok: false, reason: "stale_program" });

    await db
      .update(analysisPackageManifests)
      .set({ scope: {} as never })
      .where(eq(analysisPackageManifests.id, packageId));
    await expect(
      getExternalAnalysisResponseBinding(
        db,
        ownerId,
        packageId,
        new Date("2026-08-08T17:00:00.000Z"),
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid_manifest" });
  }, 30_000);
});
