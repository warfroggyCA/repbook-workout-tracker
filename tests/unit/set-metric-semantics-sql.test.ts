import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { resultRows } from "@/db/result";
import {
  classifyPrescriptionDimensions,
  classifyPrescriptionOutcome,
  classifySetMetricContainment,
} from "@/lib/set-metric-semantics";
import {
  eligibleAutomaticProgressionSql,
  eligiblePrescriptionOutcomeSql,
  eligibleRepetitionClaimSql,
  eligibleTotalSystemLoadSql,
  prescriptionOutcomeSql,
  setMetricExclusionReasonSql,
} from "@/lib/set-metric-semantics-sql";

describe("SQL and pure set-semantic containment", () => {
  const clients: PGlite[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it("evaluates prescribed repetitions when load is not prescribed", async () => {
    const weightedMeaning = classifySetMetricContainment({
      recordedMetricType: "weight_reps",
      prescribedSemanticsVersion: 1,
      performedSemanticsVersion: 1,
      performedLoadType: "barbell",
      performedLoadSemantics: "total",
      currentExerciseMetricType: "weight_reps",
      loadType: "barbell",
      loadSemantics: "total",
      loadEntryMeaning: "total_system",
      weight: 100,
      reps: 7,
    });
    const repetitionsMeaning = classifySetMetricContainment({
      recordedMetricType: "reps",
      prescribedSemanticsVersion: 1,
      performedSemanticsVersion: 1,
      performedLoadType: "bodyweight",
      performedLoadSemantics: "bodyweight",
      currentExerciseMetricType: "reps",
      loadType: "bodyweight",
      loadSemantics: "bodyweight",
      loadEntryMeaning: "legacy_unknown",
      weight: null,
      reps: 11,
    });
    const weightedDimensions = classifyPrescriptionDimensions({
      semantics: weightedMeaning,
      reps: 7,
      weight: 100,
      weightUnit: "lb",
      targetRepsMin: 8,
      targetRepsMax: 10,
      targetLoad: null,
      targetLoadUnit: null,
    });
    expect(weightedDimensions).toMatchObject({
      evaluability: "fully_evaluable",
      repetitions: { prescribed: true, evaluable: true, outcome: "below" },
      load: {
        prescribed: false,
        evaluable: false,
        outcome: "not_prescribed",
      },
      overall: "below",
    });
    expect(weightedMeaning.automaticProgressionEligible).toBe(true);
    expect(classifyPrescriptionOutcome({
      semantics: weightedMeaning,
      reps: 8,
      weight: 100,
      weightUnit: "lb",
      targetRepsMin: 6,
      targetRepsMax: 8,
      targetLoad: null,
      targetLoadUnit: null,
    })).toBe("at");
    expect(classifyPrescriptionOutcome({
      semantics: weightedMeaning,
      reps: 10,
      weight: 100,
      weightUnit: "lb",
      targetRepsMin: 6,
      targetRepsMax: 8,
      targetLoad: null,
      targetLoadUnit: null,
    })).toBe("above");
    expect(classifyPrescriptionOutcome({
      semantics: repetitionsMeaning,
      reps: 11,
      weight: null,
      weightUnit: null,
      targetRepsMin: 8,
      targetRepsMax: 10,
      targetLoad: null,
      targetLoadUnit: null,
    })).toBe("above");

    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client);
    const weightedColumns = {
      recordedMetricType: sql`'weight_reps'`,
      prescribedSemanticsVersion: sql`1`,
      performedSemanticsVersion: sql`1`,
      performedLoadType: sql`'barbell'`,
      performedLoadSemantics: sql`'total'`,
      exerciseMetricType: sql`'weight_reps'`,
      loadType: sql`'barbell'`,
      loadSemantics: sql`'total'`,
      loadEntryMeaning: sql`'total_system'`,
      weight: sql`100::numeric`,
      weightUnit: sql`'lb'`,
      reps: sql`7::integer`,
      targetRepsMin: sql`8::integer`,
      targetRepsMax: sql`10::integer`,
      targetLoad: sql`NULL::numeric`,
      targetLoadUnit: sql`NULL::text`,
      excludeFromAnalytics: sql`false`,
    };
    const repetitionsColumns = {
      ...weightedColumns,
      recordedMetricType: sql`'reps'`,
      performedLoadType: sql`'bodyweight'`,
      performedLoadSemantics: sql`'bodyweight'`,
      exerciseMetricType: sql`'reps'`,
      loadType: sql`'bodyweight'`,
      loadSemantics: sql`'bodyweight'`,
      loadEntryMeaning: sql`'legacy_unknown'`,
      weight: sql`NULL::numeric`,
      weightUnit: sql`NULL::text`,
      reps: sql`11::integer`,
    };
    const atTargetColumns = {
      ...weightedColumns,
      reps: sql`8::integer`,
      targetRepsMin: sql`6::integer`,
      targetRepsMax: sql`8::integer`,
    };
    const aboveTargetColumns = {
      ...atTargetColumns,
      reps: sql`10::integer`,
    };
    const [row] = resultRows<{
      weighted: string;
      repetitions: string;
      at_target: string;
      above_target: string;
    }>(
      await db.execute(sql`
        SELECT
          ${prescriptionOutcomeSql(weightedColumns)} AS weighted,
          ${prescriptionOutcomeSql(repetitionsColumns)} AS repetitions,
          ${prescriptionOutcomeSql(atTargetColumns)} AS at_target,
          ${prescriptionOutcomeSql(aboveTargetColumns)} AS above_target
      `),
    );
    expect(row).toEqual({
      weighted: "below",
      repetitions: "above",
      at_target: "at",
      above_target: "above",
    });
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

  it("separates schema-27 historical calculations from prescription and progression", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client);
    const columns = {
      recordedMetricType: sql`'weight_reps'`,
      prescribedSemanticsVersion: sql`NULL::integer`,
      performedSemanticsVersion: sql`1`,
      performedLoadType: sql`'barbell'`,
      performedLoadSemantics: sql`'total'`,
      exerciseMetricType: sql`'assisted_reps'`,
      loadType: sql`'external'`,
      loadSemantics: sql`'assistance'`,
      loadEntryMeaning: sql`'total_system'`,
      weight: sql`100::numeric`,
      reps: sql`8::integer`,
      excludeFromAnalytics: sql`false`,
    };
    const [performed] = resultRows<{
      historical: boolean;
      prescription: boolean;
      progression: boolean;
      reason: string | null;
    }>(await db.execute(sql`
      SELECT
        ${eligibleTotalSystemLoadSql(columns)} AS historical,
        ${eligiblePrescriptionOutcomeSql(columns)} AS prescription,
        ${eligibleAutomaticProgressionSql(columns)} AS progression,
        ${setMetricExclusionReasonSql(columns)} AS reason
    `));
    expect(performed).toEqual({
      historical: true,
      prescription: false,
      progression: false,
      reason: null,
    });

    const missingColumns = {
      ...columns,
      performedSemanticsVersion: sql`NULL::integer`,
      performedLoadType: sql`NULL::text`,
      performedLoadSemantics: sql`NULL::text`,
      exerciseMetricType: sql`'weight_reps'`,
      loadType: sql`'barbell'`,
      loadSemantics: sql`'total'`,
    };
    const [missing] = resultRows<{
      historical: boolean;
      progression: boolean;
      reason: string | null;
    }>(await db.execute(sql`
      SELECT
        ${eligibleTotalSystemLoadSql(missingColumns)} AS historical,
        ${eligibleAutomaticProgressionSql(missingColumns)} AS progression,
        ${setMetricExclusionReasonSql(missingColumns)} AS reason
    `));
    expect(missing).toEqual({
      historical: false,
      progression: false,
      reason: "missing_prescribed_semantics",
    });
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
