import "server-only";

import { sql, type SQL } from "drizzle-orm";

type ProgramWarmupSqlInput = {
  lineageId: SQL;
  fallbackItemKey: SQL;
  additionalCompatibilityItemKey?: SQL;
  warmupNotes: SQL;
  warmupItems: SQL;
};

function projectedOverviewLabelsSql(input: ProgramWarmupSqlInput) {
  return sql`
    (
      SELECT coalesce(jsonb_agg(to_jsonb(chunk.label) ORDER BY chunk.line_no, chunk.chunk_no), '[]'::jsonb)
      FROM (
        SELECT
          line.line_no,
          part.chunk_no,
          substr(btrim(line.value), part.chunk_no * 120 + 1, 120) AS label
        FROM regexp_split_to_table(${input.warmupNotes}, E'\\r?\\n')
          WITH ORDINALITY AS line(value, line_no)
        CROSS JOIN LATERAL generate_series(
          0,
          greatest(ceil(length(btrim(line.value)) / 120.0)::integer - 1, 0)
        ) AS part(chunk_no)
        WHERE btrim(line.value) <> ''
      ) chunk
    )
  `;
}

/**
 * Returns only deliberately authored, checkable warm-up steps. Free-text
 * overview projections created by older schema upgrades remain available as
 * guidance but never become actionable workout occurrences.
 */
export function actionableProgramDayWarmupItemsSql(
  input: ProgramWarmupSqlInput,
) {
  return sql`
    CASE
      WHEN nullif(btrim(${input.warmupNotes}), '') IS NOT NULL
        AND jsonb_array_length(${input.warmupItems}) > 0
        AND ${input.warmupItems}->0->>'key' IN (
          ${input.lineageId}::text,
          ${input.fallbackItemKey}::text
          ${input.additionalCompatibilityItemKey
            ? sql`, ${input.additionalCompatibilityItemKey}::text`
            : sql``}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(${input.warmupItems}) item(value)
          WHERE item.value->>'reps' IS NOT NULL
             OR item.value->>'load' IS NOT NULL
             OR item.value->>'loadUnit' IS NOT NULL
             OR item.value->>'loadPercent' IS NOT NULL
             OR item.value->>'loadText' IS NOT NULL
             OR item.value->>'notes' IS NOT NULL
        )
        AND (
          (
            jsonb_array_length(${input.warmupItems}) = 1
            AND ${input.warmupItems}->0->>'label' IN (
              ${input.warmupNotes},
              left(${input.warmupNotes}, 120)
            )
          )
          OR (
            SELECT coalesce(
              jsonb_agg(to_jsonb(item.value->>'label') ORDER BY item.ordinality),
              '[]'::jsonb
            )
            FROM jsonb_array_elements(${input.warmupItems})
              WITH ORDINALITY AS item(value, ordinality)
          ) = ${projectedOverviewLabelsSql(input)}
        )
      THEN '[]'::jsonb
      WHEN jsonb_array_length(${input.warmupItems}) > 0
        THEN ${input.warmupItems}
      ELSE '[]'::jsonb
    END
  `;
}
