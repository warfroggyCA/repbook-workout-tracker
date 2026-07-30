import { sql, type SQL } from "drizzle-orm";
import { KG_TO_LB } from "@/lib/units";

type MetricSqlColumns = {
  recordedMetricType: SQL;
  performedSemanticsVersion?: SQL;
  performedLoadType?: SQL;
  performedLoadSemantics?: SQL;
  exerciseMetricType: SQL;
  loadType: SQL;
  loadSemantics: SQL;
  loadEntryMeaning: SQL;
  weight: SQL;
  reps: SQL;
  excludeFromAnalytics?: SQL;
};

function effectiveLoadTypeSql(columns: MetricSqlColumns): SQL {
  return columns.performedSemanticsVersion && columns.performedLoadType
    ? sql`CASE WHEN ${columns.performedSemanticsVersion}::integer = 1
        THEN ${columns.performedLoadType}::text ELSE ${columns.loadType}::text END`
    : columns.loadType;
}

function effectiveLoadSemanticsSql(columns: MetricSqlColumns): SQL {
  return columns.performedSemanticsVersion && columns.performedLoadSemantics
    ? sql`CASE WHEN ${columns.performedSemanticsVersion}::integer = 1
        THEN ${columns.performedLoadSemantics}::text ELSE ${columns.loadSemantics}::text END`
    : columns.loadSemantics;
}

function recordedMetricAgreesSql(columns: MetricSqlColumns): SQL {
  return columns.performedSemanticsVersion
    ? sql`(
        ${columns.performedSemanticsVersion}::integer = 1
        OR (
          ${columns.performedSemanticsVersion}::integer IS NULL
          AND ${columns.recordedMetricType}::text = ${columns.exerciseMetricType}::text
        )
      )`
    : sql`${columns.recordedMetricType}::text = ${columns.exerciseMetricType}::text`;
}

function repetitionSemanticsCoherentSql(columns: MetricSqlColumns): SQL {
  return columns.performedSemanticsVersion
    ? sql`(
        ${columns.performedSemanticsVersion}::integer IS NULL
        OR (
          ${columns.performedSemanticsVersion}::integer = 1
          AND ${effectiveLoadSemanticsSql(columns)}::text IN ('bodyweight', 'none')
        )
      )`
    : sql`true`;
}

function eligibleTotalSystemPrescriptionSql(columns: MetricSqlColumns): SQL {
  return sql`(
    ${columns.recordedMetricType}::text = 'weight_reps'
    AND ${recordedMetricAgreesSql(columns)}
    AND ${effectiveLoadSemanticsSql(columns)}::text = 'total'
    AND ${columns.loadEntryMeaning}::text = 'total_system'
    AND ${columns.weight} IS NOT NULL
    AND ${columns.reps} IS NOT NULL
    ${columns.excludeFromAnalytics
      ? sql`AND NOT ${columns.excludeFromAnalytics}`
      : sql``}
  )`;
}

export function eligibleTotalSystemLoadSql(columns: MetricSqlColumns): SQL {
  return sql`(
    ${eligibleTotalSystemPrescriptionSql(columns)}
    AND ${effectiveLoadTypeSql(columns)}::text = 'barbell'
  )`;
}

export function eligibleRepetitionClaimSql(columns: MetricSqlColumns): SQL {
  return sql`(
    ${columns.recordedMetricType}::text = 'reps'
    AND ${recordedMetricAgreesSql(columns)}
    AND ${repetitionSemanticsCoherentSql(columns)}
    AND ${effectiveLoadSemanticsSql(columns)}::text <> 'assistance'
    AND ${columns.weight} IS NULL
    AND ${columns.reps} IS NOT NULL
    ${columns.excludeFromAnalytics
      ? sql`AND NOT ${columns.excludeFromAnalytics}`
      : sql``}
  )`;
}

export function eligiblePrescriptionOutcomeSql(columns: MetricSqlColumns): SQL {
  return sql`(
    ${eligibleTotalSystemPrescriptionSql(columns)}
    OR ${eligibleRepetitionClaimSql(columns)}
  )`;
}

/**
 * Restore-only projection of the derived prescription outcome. It requires
 * retained version-1 meaning and never treats current catalog metadata or an
 * older stored boolean as historical proof.
 */
export function restoredTargetMetSql(
  columns: MetricSqlColumns & {
    weightUnit: SQL;
    targetRepsMin: SQL;
    targetLoad: SQL;
    targetLoadUnit: SQL;
    isWarmup: SQL;
    modificationType: SQL;
  },
): SQL {
  return sql`
    CASE
      WHEN ${columns.isWarmup}
        OR ${columns.modificationType}::text IS DISTINCT FROM 'as_planned'
        OR ${columns.performedSemanticsVersion ?? sql`NULL`}::integer IS DISTINCT FROM 1
        OR ${columns.performedLoadType ?? sql`NULL`}::text IS NULL
        OR ${columns.performedLoadSemantics ?? sql`NULL`}::text IS NULL
        OR NOT ${eligiblePrescriptionOutcomeSql(columns)}
        OR ${columns.targetRepsMin} IS NULL
        OR ${columns.reps} IS NULL
      THEN NULL
      WHEN ${columns.recordedMetricType}::text = 'reps'
      THEN ${columns.reps} >= ${columns.targetRepsMin}
      ELSE ${columns.reps} >= ${columns.targetRepsMin}
        AND (
          ${columns.targetLoad} IS NULL
          OR (
            ${columns.weight} IS NOT NULL
            AND ${columns.weightUnit} IS NOT NULL
            AND ${columns.targetLoadUnit} IS NOT NULL
            AND CASE ${columns.weightUnit}::text
              WHEN 'kg' THEN ${columns.weight} * ${KG_TO_LB}
              ELSE ${columns.weight}
            END >= CASE ${columns.targetLoadUnit}::text
              WHEN 'kg' THEN ${columns.targetLoad} * ${KG_TO_LB}
              ELSE ${columns.targetLoad}
            END
          )
        )
    END
  `;
}

export function setMetricExclusionReasonSql(
  columns: MetricSqlColumns,
): SQL {
  return sql`
    CASE
      WHEN ${columns.excludeFromAnalytics ?? sql`false`} THEN 'source_excluded'
      ${columns.performedSemanticsVersion
        ? sql`WHEN ${columns.performedSemanticsVersion}::integer IS NOT NULL
              AND ${columns.performedSemanticsVersion}::integer <> 1
            THEN 'unsupported_performed_semantics_version'
          WHEN ${columns.performedSemanticsVersion}::integer = 1
              AND (${columns.performedLoadType ?? sql`NULL`}::text IS NULL
                OR ${columns.performedLoadSemantics ?? sql`NULL`}::text IS NULL)
            THEN 'incomplete_performed_semantics'`
        : sql``}
      ${columns.performedSemanticsVersion
        ? sql`WHEN ${columns.performedSemanticsVersion}::integer = 1
              AND ${columns.recordedMetricType}::text = 'reps'
              AND ${effectiveLoadSemanticsSql(columns)}::text = 'resistance_band'
            THEN 'band_resistance_not_numeric'
          WHEN ${columns.performedSemanticsVersion}::integer = 1
              AND ${columns.recordedMetricType}::text = 'reps'
              AND ${effectiveLoadSemanticsSql(columns)}::text NOT IN ('bodyweight', 'none', 'assistance')
            THEN 'metric_semantics_conflict'`
        : sql``}
      WHEN NOT ${recordedMetricAgreesSql(columns)}
        THEN 'metric_semantics_conflict'
      WHEN ${columns.recordedMetricType}::text IN ('duration', 'distance_duration', 'activity')
        THEN 'unsupported_metric'
      WHEN ${columns.recordedMetricType}::text = 'assisted_reps'
        OR ${effectiveLoadSemanticsSql(columns)}::text = 'assistance'
        THEN 'assistance_not_comparable'
      WHEN ${columns.recordedMetricType}::text = 'reps'
        AND ${columns.weight} IS NULL
        AND ${columns.reps} IS NOT NULL
        THEN 'repetitions_only'
      WHEN ${columns.recordedMetricType}::text = 'reps'
        THEN 'missing_load_or_repetitions'
      WHEN ${columns.weight} IS NULL OR ${columns.reps} IS NULL
        THEN 'missing_load_or_repetitions'
      WHEN ${effectiveLoadSemanticsSql(columns)}::text = 'per_implement'
        THEN 'per_implement_not_aggregatable'
      WHEN ${effectiveLoadSemanticsSql(columns)}::text = 'added_weight'
        THEN 'added_weight_missing_system_load'
      WHEN ${effectiveLoadSemanticsSql(columns)}::text = 'machine_stack'
        THEN 'machine_geometry_not_comparable'
      WHEN ${effectiveLoadSemanticsSql(columns)}::text = 'resistance_band'
        THEN 'band_resistance_not_numeric'
      WHEN ${effectiveLoadSemanticsSql(columns)}::text <> 'total'
        OR ${columns.loadEntryMeaning}::text <> 'total_system'
        THEN 'unproven_load_entry_meaning'
      WHEN ${effectiveLoadTypeSql(columns)}::text IS DISTINCT FROM 'barbell'
        THEN 'unvalidated_total_system_implement'
      ELSE NULL
    END
  `;
}
