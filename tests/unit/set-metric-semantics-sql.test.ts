import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { resultRows } from "@/db/result";
import { classifySetMetricContainment } from "@/lib/set-metric-semantics";
import { setMetricExclusionReasonSql } from "@/lib/set-metric-semantics-sql";
import { eligibleRepetitionClaimSql } from "@/lib/set-metric-semantics-sql";

describe("SQL and pure set-semantic containment", () => {
  const clients: PGlite[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it("keeps reps plus assistance ineligible in both pure and SQL claims", async () => {
    const entry = {
      recordedMetricType: "reps" as const,
      currentExerciseMetricType: "reps" as const,
      loadType: "external",
      loadSemantics: "assistance",
      loadEntryMeaning: "legacy_unknown",
      weight: null,
      reps: 8,
    };
    expect(classifySetMetricContainment(entry)).toMatchObject({
      personalRecordEligible: false,
      prescriptionOutcomeEligible: false,
      exclusionReason: "assistance_not_comparable",
    });
    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client);
    const [row] = resultRows<{ eligible: boolean }>(
      await db.execute(sql`
        SELECT ${eligibleRepetitionClaimSql({
          recordedMetricType: sql`${entry.recordedMetricType}`,
          exerciseMetricType: sql`${entry.currentExerciseMetricType}`,
          loadType: sql`${entry.loadType}`,
          loadSemantics: sql`${entry.loadSemantics}`,
          loadEntryMeaning: sql`${entry.loadEntryMeaning}`,
          weight: sql`${entry.weight}::numeric`,
          reps: sql`${entry.reps}::integer`,
          excludeFromAnalytics: sql`false`,
        })} AS eligible
      `),
    );
    expect(row?.eligible).toBe(false);
  });

  it.each([
    {
      recordedMetricType: "assisted_reps" as const,
      currentExerciseMetricType: "assisted_reps" as const,
      loadType: "external",
      loadSemantics: "assistance",
      loadEntryMeaning: "displayed_stack",
      weight: 100,
      reps: 8,
    },
    {
      recordedMetricType: "reps" as const,
      currentExerciseMetricType: "reps" as const,
      loadType: "bodyweight",
      loadSemantics: "bodyweight",
      loadEntryMeaning: "legacy_unknown",
      weight: 10,
      reps: 8,
    },
    {
      recordedMetricType: "weight_reps" as const,
      currentExerciseMetricType: "weight_reps" as const,
      loadType: "external",
      loadSemantics: "total",
      loadEntryMeaning: "total_system",
      weight: 100,
      reps: 8,
    },
    {
      recordedMetricType: "weight_reps" as const,
      currentExerciseMetricType: "weight_reps" as const,
      loadType: "barbell",
      loadSemantics: "total",
      loadEntryMeaning: "total_system",
      weight: 100,
      reps: 8,
    },
  ])(
    "returns the same stable exclusion reason for $recordedMetricType/$loadType",
    async (entry) => {
      const client = new PGlite();
      clients.push(client);
      const db = drizzle(client);
      const pure = classifySetMetricContainment(entry).exclusionReason;
      const [row] = resultRows<{ reason: string | null }>(
        await db.execute(sql`
          SELECT ${setMetricExclusionReasonSql({
            recordedMetricType: sql`${entry.recordedMetricType}`,
            exerciseMetricType: sql`${entry.currentExerciseMetricType}`,
            loadType: sql`${entry.loadType}`,
            loadSemantics: sql`${entry.loadSemantics}`,
            loadEntryMeaning: sql`${entry.loadEntryMeaning}`,
            weight: sql`${entry.weight}::numeric`,
            reps: sql`${entry.reps}::integer`,
            excludeFromAnalytics: sql`false`,
          })} AS reason
        `),
      );
      expect(row?.reason ?? null).toBe(pure);
    },
  );

  it("matches pure classification when performed evidence bridges a catalog change", async () => {
    const entry = {
      recordedMetricType: "weight_reps" as const,
      performedSemanticsVersion: 1,
      performedLoadType: "barbell",
      performedLoadSemantics: "total",
      currentExerciseMetricType: "assisted_reps" as const,
      loadType: "external",
      loadSemantics: "assistance",
      loadEntryMeaning: "total_system",
      weight: 100,
      reps: 8,
    };
    expect(classifySetMetricContainment(entry).exclusionReason).toBeNull();
    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client);
    const [row] = resultRows<{ reason: string | null }>(
      await db.execute(sql`
        SELECT ${setMetricExclusionReasonSql({
          recordedMetricType: sql`${entry.recordedMetricType}`,
          performedSemanticsVersion: sql`${entry.performedSemanticsVersion}`,
          performedLoadType: sql`${entry.performedLoadType}`,
          performedLoadSemantics: sql`${entry.performedLoadSemantics}`,
          exerciseMetricType: sql`${entry.currentExerciseMetricType}`,
          loadType: sql`${entry.loadType}`,
          loadSemantics: sql`${entry.loadSemantics}`,
          loadEntryMeaning: sql`${entry.loadEntryMeaning}`,
          weight: sql`${entry.weight}::numeric`,
          reps: sql`${entry.reps}::integer`,
          excludeFromAnalytics: sql`false`,
        })} AS reason
      `),
    );
    expect(row?.reason ?? null).toBeNull();
  });

  it("keeps versioned band repetitions ineligible in pure and SQL consumers", async () => {
    const entry = {
      recordedMetricType: "reps" as const,
      performedSemanticsVersion: 1,
      performedLoadType: "external",
      performedLoadSemantics: "resistance_band",
      currentExerciseMetricType: "weight_reps" as const,
      loadType: "external",
      loadSemantics: "resistance_band",
      loadEntryMeaning: "legacy_unknown",
      weight: null,
      reps: 12,
    };
    expect(classifySetMetricContainment(entry)).toMatchObject({
      prescriptionOutcomeEligible: false,
      longitudinalComparable: false,
      personalRecordEligible: false,
      exclusionReason: "band_resistance_not_numeric",
    });
    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client);
    const [row] = resultRows<{ eligible: boolean; reason: string | null }>(
      await db.execute(sql`
        SELECT
          ${eligibleRepetitionClaimSql({
            recordedMetricType: sql`${entry.recordedMetricType}`,
            performedSemanticsVersion: sql`${entry.performedSemanticsVersion}`,
            performedLoadType: sql`${entry.performedLoadType}`,
            performedLoadSemantics: sql`${entry.performedLoadSemantics}`,
            exerciseMetricType: sql`${entry.currentExerciseMetricType}`,
            loadType: sql`${entry.loadType}`,
            loadSemantics: sql`${entry.loadSemantics}`,
            loadEntryMeaning: sql`${entry.loadEntryMeaning}`,
            weight: sql`${entry.weight}::numeric`,
            reps: sql`${entry.reps}::integer`,
          })} AS eligible,
          ${setMetricExclusionReasonSql({
            recordedMetricType: sql`${entry.recordedMetricType}`,
            performedSemanticsVersion: sql`${entry.performedSemanticsVersion}`,
            performedLoadType: sql`${entry.performedLoadType}`,
            performedLoadSemantics: sql`${entry.performedLoadSemantics}`,
            exerciseMetricType: sql`${entry.currentExerciseMetricType}`,
            loadType: sql`${entry.loadType}`,
            loadSemantics: sql`${entry.loadSemantics}`,
            loadEntryMeaning: sql`${entry.loadEntryMeaning}`,
            weight: sql`${entry.weight}::numeric`,
            reps: sql`${entry.reps}::integer`,
          })} AS reason
      `),
    );
    expect(row).toEqual({
      eligible: false,
      reason: "band_resistance_not_numeric",
    });
  });
});
