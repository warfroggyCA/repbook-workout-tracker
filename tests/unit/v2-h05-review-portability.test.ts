import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  recommendations,
  userDecisions,
  userProfiles,
  users,
  type RecommendationPayload,
  type ReviewDecisionSnapshot,
} from "@/db/schema";
import {
  PROGRESSION_REVIEW_SOURCE_VERSION,
  withRecommendationReviewEvidence,
} from "@/lib/review-evidence";
import {
  captureUserSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
} from "@/services/snapshot-capture";
import {
  getSnapshotRestorePreview,
  restoreDataSnapshot,
  upgradeSnapshotPayload,
  validateSnapshotPayload,
} from "@/services/snapshot-restore";
import { buildJsonBackup } from "@/services/export";
import { MemorySnapshotObjectStore } from "@/services/snapshot-store";
import { createDataSnapshot, type SnapshotKeyring } from "@/services/snapshots";
import {
  deferRecommendationDecision,
  resumeRecommendationDecision,
} from "@/services/recommendation-decisions";
import { activateProgramAtomically } from "@/services/program-activation";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../helpers/database";

describe("Repbook v2 H05 Review portability", () => {
  let database: TestDatabase;
  let userId: string;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    [{ id: userId }] = await database.db.insert(users).values({
      email: `v2-h05-portability-${crypto.randomUUID()}@example.com`,
    }).returning({ id: users.id });
    await database.db.insert(userProfiles).values({ userId, timezone: "UTC" });
  }, 30_000);

  afterEach(async () => database.close());

  it("round-trips versioned Review evidence and safely upgrades schema 29", async () => {
    const payload: RecommendationPayload = {
      kind: "remove_exercise",
      templateExerciseId: crypto.randomUUID(),
    };
    const evidence = withRecommendationReviewEvidence({ signals: {} }, {
      payload,
      producer: "progression_rules",
      sourceVersion: PROGRESSION_REVIEW_SOURCE_VERSION,
      quality: "unsupported",
    });
    const [recommendation] = await database.db.insert(recommendations).values({
      userId,
      status: "rejected",
      source: "rule",
      ruleId: "legacy_review_fixture",
      payload,
      reason: "Retained proposal",
      evidence,
      decidedAt: new Date("2026-08-07T12:00:00.000Z"),
    }).returning();
    const reviewSnapshot: ReviewDecisionSnapshot = {
      schemaVersion: "review-decision-v1",
      recommendationId: recommendation.id,
      reviewRevision: recommendation.reviewRevision,
      deferRevision: recommendation.deferRevision,
      recordedAt: "2026-08-07T12:00:00.000Z",
      evidenceState: "unsupported",
      source: recommendation.source,
      ruleId: recommendation.ruleId,
      payload,
      reason: recommendation.reason,
      evidence,
    };
    await database.db.insert(userDecisions).values({
      recommendationId: recommendation.id,
      decision: "reject",
      reviewSnapshot,
    });

    const current = await captureUserSnapshot(
      database.db,
      userId,
      new Date("2026-08-07T13:00:00.000Z"),
      "v2-h05-test",
    );
    expect(SNAPSHOT_SCHEMA_VERSION).toBe("35");
    expect(current.tables.recommendations).toEqual([
      expect.objectContaining({
        review_revision: 1,
        defer_revision: 0,
        deferred_at: null,
        evidence: expect.objectContaining({
          review: expect.objectContaining({ schemaVersion: "review-evidence-v1" }),
        }),
      }),
    ]);
    expect(current.tables.user_decisions).toEqual([
      expect.objectContaining({ review_snapshot: reviewSnapshot }),
    ]);
    expect(() => validateSnapshotPayload(current, userId)).not.toThrow();

    const malformedDecision = structuredClone(current);
    const malformedDecisionRow = malformedDecision.tables.user_decisions[0] as
      | Record<string, unknown>
      | undefined;
    const malformedReview = malformedDecisionRow?.review_snapshot as
      | Record<string, unknown>
      | undefined;
    if (!malformedReview) throw new Error("Review snapshot fixture missing.");
    malformedReview.recordedAt = "not-an-instant";
    expect(() => validateSnapshotPayload(malformedDecision, userId)).toThrow(
      "invalid versioned Review evidence",
    );

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 75);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(version) {
        if (version !== "v1") throw new Error("Unknown H05 snapshot key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      userId,
      { name: "H05 evidence-linked Review", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-h05-restore" },
    );
    if (!created.ok) throw new Error(created.reason);
    await database.db.update(recommendations).set({
      reason: "Temporarily changed proposal",
      evidence: { signals: {} },
    }).where(eq(recommendations.id, recommendation.id));
    await database.db.update(userDecisions).set({
      reviewSnapshot: { schemaVersion: "legacy-unknown" },
    }).where(eq(userDecisions.recommendationId, recommendation.id));

    const preview = await getSnapshotRestorePreview(
      database.db,
      userId,
      created.snapshotId,
      "full",
      { store, keyring },
    );
    const restored = await restoreDataSnapshot(
      database.db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "v2-h05-restore" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "full" });
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, recommendation.id),
    })).toMatchObject({
      reason: "Retained proposal",
      reviewRevision: 1,
      deferRevision: 0,
      evidence,
    });
    expect(await database.db.query.userDecisions.findFirst({
      where: eq(userDecisions.recommendationId, recommendation.id),
    })).toMatchObject({ reviewSnapshot });

    const legacy = structuredClone(current);
    legacy.schemaVersion = "29";
    for (const value of legacy.tables.recommendations) {
      const row = value as Record<string, unknown>;
      delete row.review_revision;
      delete row.defer_revision;
      delete row.deferred_at;
      delete row.revisit_on;
      delete row.defer_reason;
    }
    for (const value of legacy.tables.user_decisions) {
      delete (value as Record<string, unknown>).review_snapshot;
    }
    const upgraded = upgradeSnapshotPayload(legacy);
    expect(upgraded.schemaVersion).toBe("35");
    expect(upgraded.tables.recommendations).toEqual([
      expect.objectContaining({
        review_revision: 0,
        defer_revision: 0,
        deferred_at: null,
        revisit_on: null,
        defer_reason: null,
      }),
    ]);
    expect(upgraded.tables.user_decisions).toEqual([
      expect.objectContaining({
        review_snapshot: { schemaVersion: "legacy-unknown" },
      }),
    ]);
    expect(() => validateSnapshotPayload(upgraded, userId)).not.toThrow();
  }, 60_000);

  it("round-trips a real deferred Review timestamp emitted with an offset", async () => {
    const activation = await activateProgramAtomically(database.db, {
      userId,
      loadUnit: "kg",
      programName: "H05 deferred Review Program",
      days: [],
      changeSummary: "Synthetic H05 defer fixture",
      auditAction: "program.activate",
      auditSummary: "Synthetic H05 defer fixture",
    });
    if (!activation.ok) throw new Error(activation.reason);

    const payload: RecommendationPayload = {
      kind: "deload",
      scope: "program",
      volumeFactor: 0.8,
      loadFactor: 0.9,
      durationSessionsPerTemplate: 1,
    };
    const evidence = withRecommendationReviewEvidence({ signals: {} }, {
      payload,
      producer: "progression_rules",
      sourceVersion: PROGRESSION_REVIEW_SOURCE_VERSION,
      quality: "unsupported",
    });
    const [recommendation] = await database.db.insert(recommendations).values({
      userId,
      status: "pending",
      source: "rule",
      ruleId: "h05_defer_offset",
      payload,
      reason: "Retained deferred proposal",
      evidence,
    }).returning();
    await database.db.execute(sql`SET TIME ZONE 'America/Toronto'`);
    await expect(deferRecommendationDecision(database.db, userId, {
      recommendationId: recommendation.id,
      expectedReviewRevision: recommendation.reviewRevision,
      expectedDeferRevision: recommendation.deferRevision,
      revisitOn: "2026-08-21",
      reason: "Revisit after another training week.",
    })).resolves.toEqual({ ok: true });

    const captured = await captureUserSnapshot(
      database.db,
      userId,
      new Date("2026-08-09T12:00:00.000Z"),
      "v2-h05-offset",
    );
    expect(captured.tables.recommendations).toContainEqual(
      expect.objectContaining({
        deferred_at: expect.stringMatching(/[+-]\d{2}:\d{2}$/),
        revisit_on: "2026-08-21",
        defer_reason: "Revisit after another training week.",
      }),
    );
    expect(() => validateSnapshotPayload(captured, userId)).not.toThrow();
    await expect(buildJsonBackup(database.db, userId, undefined, {
      now: new Date("2026-08-09T12:01:00.000Z"),
      appVersion: "v2-h05-offset",
    })).resolves.toMatchObject({ schemaVersion: SNAPSHOT_SCHEMA_VERSION });

    const store = new MemorySnapshotObjectStore();
    const key = Buffer.alloc(32, 76);
    const keyring: SnapshotKeyring = {
      currentVersion: "v1",
      resolve(versionName) {
        if (versionName !== "v1") throw new Error("Unknown H05 snapshot key.");
        return key;
      },
    };
    const created = await createDataSnapshot(
      database.db,
      userId,
      { name: "H05 deferred offset", reason: "manual", pinned: true },
      { store, keyring, appVersion: "v2-h05-offset" },
    );
    if (!created.ok) throw new Error(created.reason);
    await expect(resumeRecommendationDecision(database.db, userId, {
      recommendationId: recommendation.id,
      expectedReviewRevision: recommendation.reviewRevision,
      expectedDeferRevision: recommendation.deferRevision + 1,
    })).resolves.toEqual({ ok: true });

    const preview = await getSnapshotRestorePreview(
      database.db,
      userId,
      created.snapshotId,
      "full",
      { store, keyring },
    );
    const restored = await restoreDataSnapshot(
      database.db,
      userId,
      {
        snapshotId: created.snapshotId,
        scope: "full",
        previewFingerprint: preview.fingerprint,
        confirmation: "RESTORE",
      },
      { store, keyring, appVersion: "v2-h05-offset" },
    );
    expect(restored).toMatchObject({ ok: true, scope: "full" });
    expect(await database.db.query.recommendations.findFirst({
      where: eq(recommendations.id, recommendation.id),
    })).toMatchObject({
      deferredAt: expect.any(Date),
      revisitOn: "2026-08-21",
      deferReason: "Revisit after another training week.",
    });
  }, 60_000);

  it("rejects incoherent deferred Review state before restore", async () => {
    const current = await captureUserSnapshot(
      database.db,
      userId,
      new Date("2026-08-07T13:00:00.000Z"),
      "v2-h05-test",
    );
    current.tables.recommendations.push({
      id: crypto.randomUUID(),
      user_id: userId,
      status: "pending",
      source: "rule",
      rule_id: null,
      insight_id: null,
      exercise_id: null,
      progression_job_id: null,
      source_template_exercise_id: null,
      source_slot_lineage_id: null,
      payload: { kind: "deload", scope: "program", volumeFactor: 0.8, loadFactor: 0.9, durationSessionsPerTemplate: 1 },
      reason: "Malformed fixture",
      evidence: { signals: {} },
      review_revision: 1,
      defer_revision: 0,
      deferred_at: null,
      revisit_on: "2026-08-21",
      defer_reason: null,
      created_at: "2026-08-07T12:00:00.000Z",
      decided_at: null,
      reconciled_at: null,
      reconciliation_reason: null,
      reconciled_by_program_version_id: null,
      archived_at: null,
      archive_operation_id: null,
    });
    expect(() => validateSnapshotPayload(current, userId)).toThrow(
      "incoherent deferred Review state",
    );
  });
});
